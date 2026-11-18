// Launch profiles: the file (defaults on first read, corrupt → backup + defaults, atomic writes), validation
// (args and env tether owns), ids, editing, and how a slot's profile resolves (current profile, else snapshot).
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { SlotMeta } from '../../src/core/event.ts'
import {
  findProfile,
  isUnsafe,
  launchOf,
  parseProfilesFile,
  ProfileError,
  ProfileStore,
  profilesPath,
  removeProfile,
  slotProfile,
  slugify,
  snapshotProfile,
  uniqueId,
  upsertProfile,
  validateProfile,
  type Profile,
} from '../../src/core/profile.ts'
import { defaultProfiles, readProfiles, writeProfiles } from '../../src/core/profile-sync.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { createSlot, readSlot, writeSlotMeta } from '../../src/core/store.ts'
import { tempDirs } from './tmp.helpers.ts'

const homes = tempDirs('tether-profiles-')
after(() => homes.cleanup())

const meta = (extra: Partial<SlotMeta> = {}): SlotMeta => ({
  v: 1, slotId: 'aa000001', agent: 'claude', cwd: 'D:\\x', args: [], createdAt: '2026-10-29T00:00:00.000Z', ...extra,
})

describe('defaults and the file', () => {
  test('defaults: Claude (default), Claude modo dev (unsafe), soul -g (default), a default shell; Git Bash only when bash.exe exists', () => {
    const d = defaultProfiles({ ProgramFiles: 'C:\\nowhere-at-all', PATH: '' }, 'win32')
    assert.deepEqual(d.map((p) => p.id), ['claude', 'claude-dev', 'soul', 'codex', 'codex-dev', 'powershell'])
    assert.deepEqual(d.find((p) => p.id === 'claude-dev')!.args, ['--dangerously-skip-permissions'])
    assert.deepEqual(d.find((p) => p.id === 'soul')!.args, ['-g'])
    for (const agent of ['claude', 'soul', 'shell'] as const) assert.equal(d.filter((p) => p.agent === agent && p.default).length, 1, `one default for ${agent}`)
    assert.ok(d.find((p) => p.id === 'powershell')!.shell?.command)
    const posix = defaultProfiles({ SHELL: '/bin/zsh', PATH: '' }, 'linux')
    assert.deepEqual(posix.filter((p) => p.agent === 'shell').map((p) => [p.id, p.default]), [['shell', true]])
  })

  test('first read creates profiles.json with the defaults; the second read gives the same list', () => {
    const home = homes.make()
    const first = readProfiles(home)
    assert.equal(first.problem, undefined)
    assert.ok(existsSync(profilesPath(home)))
    const onDisk = JSON.parse(readFileSync(profilesPath(home), 'utf8')) as { v: number; profiles: Profile[] }
    assert.equal(onDisk.v, 1)
    assert.deepEqual(readProfiles(home).profiles, first.profiles)
    assert.deepEqual(onDisk.profiles, first.profiles)
  })

  test('corrupt file: copied aside, defaults written, problem reported; nothing of the user is lost', () => {
    const home = homes.make()
    writeFileSync(profilesPath(home), '{"v":1,"profiles":[{"id":"x"', 'utf8')
    const r = readProfiles(home)
    assert.ok(r.problem && /inválido/.test(r.problem), r.problem)
    assert.ok(r.backup && existsSync(r.backup), 'backup kept')
    assert.equal(readFileSync(r.backup!, 'utf8'), '{"v":1,"profiles":[{"id":"x"')
    assert.deepEqual(r.profiles.map((p) => p.id), defaultProfiles().map((p) => p.id))
    assert.equal(readProfiles(home).problem, undefined, 'the rewritten file reads clean')
  })

  test('wrong shape (valid JSON) is corrupt too; a malformed entry is skipped and reported, the rest kept', () => {
    const home = homes.make()
    writeFileSync(profilesPath(home), '[]')
    assert.match(readProfiles(home).problem ?? '', /formato desconhecido/)
    const home2 = homes.make()
    writeFileSync(profilesPath(home2), JSON.stringify({ v: 1, profiles: [{ id: 'ok', name: 'Ok', agent: 'claude', args: [] }, { id: 'bad', name: 'Bad' }, 'junk'] }))
    const r = readProfiles(home2)
    assert.deepEqual(r.profiles.map((p) => p.id), ['ok'])
    assert.match(r.problem ?? '', /2 perfil/)
    assert.equal(readdirSync(home2).filter((f) => f.includes('corrompido')).length, 0, 'no backup for a readable file')
  })

  test('writeProfiles is atomic: no temp file left, content complete', () => {
    const home = homes.make()
    const profiles: Profile[] = [{ id: 'a', name: 'A', agent: 'claude', args: ['--model', 'haiku'] }]
    writeProfiles(home, profiles)
    assert.deepEqual(readdirSync(home), ['profiles.json'])
    assert.deepEqual(parseProfilesFile(readFileSync(profilesPath(home), 'utf8')), { ok: true, profiles, skipped: 0 })
  })

  test('ProfileStore reloads through the executor when the file changed on disk (another process edited it)', async () => {
    const home = homes.make()
    const ex = createExecutor({ mode: 'inline' })
    const store = new ProfileStore(home, ex)
    assert.ok((await store.fresh()).length > 0)
    const edited: Profile[] = [{ id: 'only', name: 'Only', agent: 'soul', args: [] }]
    // mtime resolution: make sure the signature differs (size does)
    writeProfiles(home, edited)
    assert.deepEqual(await store.fresh(), edited)
    const saved = store.save({ name: 'Novo', agent: 'claude', args: [] })
    assert.equal(saved.profile.id, 'novo')
    assert.deepEqual(store.profiles().map((p) => p.id), ['only', 'novo'])
    store.delete('only')
    assert.deepEqual(store.profiles().map((p) => p.id), ['novo'])
    await ex.close()
  })
})

describe('validation', () => {
  const base = { name: 'X', agent: 'claude' as const, args: [] as string[] }

  test('claude: the args tether controls are refused, each with its reason; --flag=value forms too', () => {
    for (const arg of ['--resume', '-r', '--continue', '-c', '--session-id', '--settings', '--fork-session', '--resume=abc', '--settings=x.json']) {
      const v = validateProfile({ ...base, args: ['--model', 'haiku', arg] })
      assert.equal(v.errors.length, 1, arg)
      assert.ok(v.errors[0]!.startsWith(`o argumento ${arg} não pode ficar no perfil: `), v.errors[0])
    }
    assert.match(validateProfile({ ...base, args: ['--fork-session'] }).errors[0]!, /bifurcar é uma ação por retomada/)
    assert.deepEqual(validateProfile({ ...base, args: ['--dangerously-skip-permissions', '--model', 'opus', '--resume-x'] }).errors, [])
  })

  test('soul: -r/--resume, -c/--continue, --session-id, --fork-session refused; -g, -P, --strategy fine', () => {
    for (const arg of ['-r', '--resume', '-c', '--continue', '--session-id', '--fork-session']) {
      assert.equal(validateProfile({ ...base, agent: 'soul', args: [arg] }).errors.length, 1, arg)
    }
    assert.deepEqual(validateProfile({ ...base, agent: 'soul', args: ['-g', '-P', 'guga', '--strategy', 'anthropic'] }).errors, [])
  })

  test('shell profiles: args are free (the shell gets them), shell only for shell', () => {
    assert.deepEqual(validateProfile({ ...base, agent: 'shell', args: ['-c'], shell: { command: 'bash', args: ['--login'] } }).errors, [])
    assert.match(validateProfile({ ...base, shell: { command: 'bash', args: [] } }).errors[0]!, /shell só vale/)
    assert.match(validateProfile({ ...base, agent: 'shell', args: [], shell: { command: ' ', args: [] } }).errors[0]!, /executável/)
  })

  test('env: TETHER_* and SOUL_SESSION_REPORT refused; CLAUDE* warned except CLAUDE_CONFIG_DIR', () => {
    const v = validateProfile({ ...base, env: { TETHER_HOME: 'x', tether_slot_id: 'y', SOUL_SESSION_REPORT: 'z', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'D:\\outra-conta', NODE_ENV: 'dev' } })
    assert.equal(v.errors.length, 3, v.errors.join('\n'))
    assert.ok(v.errors.every((e) => /não pode ficar no perfil/.test(e)))
    assert.deepEqual(v.warnings.length, 1)
    assert.match(v.warnings[0]!, /CLAUDECODE/)
    assert.match(validateProfile({ ...base, env: { 'A B': '1' } }).errors[0]!, /nome de variável inválido/)
  })

  test('name required; bad id refused; bad agent refused', () => {
    assert.match(validateProfile({ ...base, name: '  ' }).errors[0]!, /precisa de um nome/)
    assert.match(validateProfile({ ...base, id: 'Não Slug' }).errors[0]!, /id inválido/)
    assert.match(validateProfile({ ...base, agent: 'vim' as 'claude' }).errors[0]!, /agente inválido/)
  })
})

describe('ids and editing', () => {
  test('slugify / uniqueId', () => {
    assert.equal(slugify('Claude modo dev'), 'claude-modo-dev')
    assert.equal(slugify('  Sessão à noite!  '), 'sessao-a-noite')
    assert.equal(slugify('***'), 'perfil')
    assert.equal(uniqueId('Claude', ['claude', 'claude-2']), 'claude-3')
  })

  test('upsert: new profile gets an id from its name; a new default clears the agent\'s previous default', () => {
    const start = defaultProfiles({ PATH: '' }, 'linux')
    const r = upsertProfile(start, { name: 'Claude opus', agent: 'claude', args: ['--model', 'opus'], default: true })
    assert.equal(r.profile.id, 'claude-opus')
    assert.deepEqual(r.profiles.filter((p) => p.agent === 'claude' && p.default).map((p) => p.id), ['claude-opus'])
    assert.ok(r.profiles.find((p) => p.id === 'soul')!.default, 'other agents untouched')
    assert.ok(!('default' in r.profiles.find((p) => p.id === 'claude')!), 'the old default lost the key, not set to false')
  })

  test('upsert: edit by id keeps the id and position; renaming to another profile\'s name is refused', () => {
    const start = defaultProfiles({ PATH: '' }, 'linux')
    const r = upsertProfile(start, { id: 'claude-dev', name: 'Claude dev', agent: 'claude', args: ['--dangerously-skip-permissions', '--model', 'haiku'] })
    assert.equal(r.profiles.findIndex((p) => p.id === 'claude-dev'), 1)
    assert.equal(r.profile.name, 'Claude dev')
    assert.throws(() => upsertProfile(start, { id: 'claude-dev', name: 'claude', agent: 'claude', args: [] }), (e: Error) => e instanceof ProfileError && /já existe um perfil chamado "Claude"/.test(e.message))
    assert.throws(() => upsertProfile(start, { name: 'Z', agent: 'claude', args: ['--resume'] }), (e: Error) => e instanceof ProfileError && /--resume/.test(e.message))
  })

  test('upsert returns warnings (CLAUDE* env) without blocking; remove unknown id throws; findProfile by id or unique name', () => {
    const start = defaultProfiles({ PATH: '' }, 'linux')
    const r = upsertProfile(start, { name: 'Conta 2', agent: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: 'D:\\c2', CLAUDE_X: '1' } })
    assert.equal(r.warnings.length, 1)
    assert.deepEqual(r.profile.env, { CLAUDE_CONFIG_DIR: 'D:\\c2', CLAUDE_X: '1' })
    assert.throws(() => removeProfile(start, 'nope'), ProfileError)
    assert.equal(removeProfile(start, 'soul').some((p) => p.id === 'soul'), false)
    assert.equal(findProfile(start, 'claude modo DEV')?.id, 'claude-dev')
    assert.equal(findProfile(start, 'claude')?.id, 'claude')
    assert.equal(findProfile(start, 'nada'), undefined)
  })
})

describe('a slot and its profile', () => {
  const profiles: Profile[] = [
    { id: 'dev', name: 'Dev', agent: 'claude', args: ['--dangerously-skip-permissions'], env: { CLAUDE_CONFIG_DIR: 'D:\\c2' } },
    { id: 'bash', name: 'Git Bash', agent: 'shell', args: ['-c', 'echo oi'], shell: { command: 'C:\\git\\bash.exe', args: ['--login'] } },
  ]

  test('launchOf: a shell profile puts the shell first (what the shell adapter reads), env only when non-empty', () => {
    assert.deepEqual(launchOf(profiles[0]!), { args: ['--dangerously-skip-permissions'], env: { CLAUDE_CONFIG_DIR: 'D:\\c2' } })
    assert.deepEqual(launchOf(profiles[1]!), { args: ['C:\\git\\bash.exe', '--login', '-c', 'echo oi'] })
  })

  test('slotProfile: no profile → nothing; current profile → its launch and name; deleted → the snapshot, flagged missing', () => {
    assert.deepEqual(slotProfile(meta(), profiles), { missing: false })
    const m = meta()
    assert.equal(snapshotProfile(m, profiles[0]!), true)
    assert.deepEqual([m.profileId, m.profileArgs, m.profileEnv], ['dev', ['--dangerously-skip-permissions'], { CLAUDE_CONFIG_DIR: 'D:\\c2' }])
    assert.equal(snapshotProfile(m, profiles[0]!), false, 'unchanged snapshot reports no change')
    const live = slotProfile(m, profiles)
    assert.deepEqual(live, { id: 'dev', name: 'Dev', launch: launchOf(profiles[0]!), missing: false })
    // edited profile: the launch follows the CURRENT profile, the snapshot is stale until the next launch refreshes it
    const edited: Profile[] = [{ ...profiles[0]!, args: ['--model', 'opus'], env: undefined }]
    assert.deepEqual(slotProfile(m, edited).launch, { args: ['--model', 'opus'] })
    assert.equal(snapshotProfile(m, edited[0]!), true)
    assert.equal(m.profileEnv, undefined, 'env dropped from the snapshot with the profile')
    // deleted: the snapshot carries on
    const gone = slotProfile(m, [])
    assert.deepEqual(gone, { id: 'dev', launch: { args: ['--model', 'opus'] }, missing: true })
  })

  test('store: a meta with profile fields round-trips; an old meta without them still reads; a malformed profileEnv does not', () => {
    const home = homes.make()
    const m = meta({ profileId: 'dev', profileArgs: ['--x'], profileEnv: { A: '1' } })
    createSlot(home, m)
    assert.deepEqual(readSlot(home, m.slotId), m)
    const old = meta({ slotId: 'aa000002' })
    writeSlotMeta(home, old)
    const back = readSlot(home, old.slotId)!
    assert.deepEqual(back, old)
    assert.deepEqual(slotProfile(back, profiles), { missing: false })
    writeFileSync(join(home, 'slots', 'aa000003.json'), JSON.stringify({ ...meta({ slotId: 'aa000003' }), profileEnv: { A: 1 } }))
    assert.equal(readSlot(home, 'aa000003'), undefined)
  })

  test('isUnsafe', () => {
    assert.equal(isUnsafe(['--model', 'haiku']), false)
    assert.equal(isUnsafe(['--dangerously-skip-permissions']), true)
    assert.equal(isUnsafe(['--dangerously-bypass-approvals-and-sandbox']), true)
    assert.equal(isUnsafe(['--model', 'o3', '--yolo']), true)
    assert.equal(isUnsafe(['--dangerously-bypass-hook-trust']), false)
  })
})
