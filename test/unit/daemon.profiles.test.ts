// tetherd and the launch profiles: the protocol (profiles-list / profile-save / profile-delete, `profiles` event),
// a slot created with a profile (snapshot on disk, profileName + unsafe in its state, the profile applied to the
// real launch), an edit applying on the next start, and the snapshot carrying a slot whose profile was deleted.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { SlotMeta } from '../../src/core/event.ts'
import { slotMetaPath } from '../../src/core/paths.ts'
import { profilesPath, type Profile } from '../../src/core/profile.ts'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

/** A shell profile that runs node with a script printing its argv and an env var, then exits. */
const nodeProfile = (name: string, extra: Record<string, unknown> = {}): Omit<Profile, 'id'> => ({
  name,
  agent: 'shell',
  args: ['-e', 'console.log("ARGS=" + process.argv.slice(1).join(" ") + " ENV=" + (process.env.PROFILE_TEST_VAR ?? "-"))', '--', 'first'],
  shell: { command: process.execPath, args: ['--no-warnings'] },
  env: { PROFILE_TEST_VAR: 'v1' },
  ...extra,
})

describe('profiles over the protocol', () => {
  test('profiles-list: the defaults were created on disk at startup; a client gets the same list', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { profiles, problem } = await c.client.request({ t: 'profiles-list' })
    assert.equal(problem, undefined)
    assert.deepEqual(profiles!.filter((p) => p.agent !== 'shell').map((p) => p.id), ['claude', 'claude-dev', 'soul', 'codex', 'codex-dev'])
    assert.deepEqual(JSON.parse(readFileSync(profilesPath(home), 'utf8')).profiles, profiles)
    c.close()
  })

  test('profile-save: validation errors come back as invalid-profile with the reason; TETHER_* env refused', async () => {
    const c = await Recorder.connect(daemon.pipe)
    await assert.rejects(
      c.client.request({ t: 'profile-save', profile: { name: 'Ruim', agent: 'claude', args: ['--resume', 'x'] } }),
      (e: DaemonError) => e.code === 'invalid-profile' && /--resume/.test(e.message) && /tether escolhe a sessão/.test(e.message),
    )
    await assert.rejects(
      c.client.request({ t: 'profile-save', profile: { name: 'Ruim', agent: 'claude', args: [], env: { TETHER_HOME: 'x' } } }),
      (e: DaemonError) => e.code === 'invalid-profile' && /TETHER_HOME/.test(e.message),
    )
    await assert.rejects(c.client.request({ t: 'profile-save', profile: { name: 'Ruim', agent: 'vim' as 'claude', args: [] } }), (e: DaemonError) => e.code === 'invalid-profile')
    await assert.rejects(c.client.request({ t: 'profile-delete', profileId: 'nope' }), (e: DaemonError) => e.code === 'unknown-profile')
    c.close()
  })

  test('profile-save creates (id from the name), warns on CLAUDE* env, broadcasts `profiles`; edit keeps the id', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const got: Profile[][] = []
    c.client.on('profiles', (p) => got.push(p))
    const saved = await c.client.request({ t: 'profile-save', profile: { name: 'Conta 2', agent: 'claude', args: ['--model', 'haiku'], env: { CLAUDE_CONFIG_DIR: 'D:\\c2', CLAUDECODE: '1' } } })
    assert.equal(saved.profile!.id, 'conta-2')
    assert.equal(saved.warnings!.length, 1)
    await waitUntil(() => got.length >= 1, 5_000, 'profiles event')
    assert.ok(got[0]!.some((p) => p.id === 'conta-2'))
    const edited = await c.client.request({ t: 'profile-save', profile: { id: 'conta-2', name: 'Conta dois', agent: 'claude', args: ['--model', 'haiku'], default: true } })
    assert.equal(edited.profile!.name, 'Conta dois')
    const { profiles } = await c.client.request({ t: 'profiles-list' })
    assert.deepEqual(profiles!.filter((p) => p.agent === 'claude' && p.default).map((p) => p.id), ['conta-2'], 'the default moved')
    await c.client.request({ t: 'profile-delete', profileId: 'conta-2' })
    assert.ok(!(await c.client.request({ t: 'profiles-list' })).profiles!.some((p) => p.id === 'conta-2'))
    c.close()
  })

  test('create with a profile of another kind is refused; with an unknown profile too', async () => {
    const c = await Recorder.connect(daemon.pipe)
    await assert.rejects(c.client.request({ t: 'create', kind: 'shell', cwd, profileId: 'claude-dev' }), (e: DaemonError) => e.code === 'bad-request' && /é de claude/.test(e.message))
    await assert.rejects(c.client.request({ t: 'create', kind: 'claude', cwd, profileId: 'nada' }), (e: DaemonError) => e.code === 'unknown-profile')
    c.close()
  })

  test('a claude slot created with "Claude modo dev": state carries profileId, profileName and unsafe; the meta keeps the snapshot', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, profileId: 'claude-dev', args: ['--model', 'haiku'] })
    assert.equal(slot!.profileId, 'claude-dev')
    assert.equal(slot!.profileName, 'Claude modo dev')
    assert.equal(slot!.unsafe, true)
    const meta = JSON.parse(readFileSync(slotMetaPath(home, slot!.slotId), 'utf8')) as SlotMeta
    assert.deepEqual([meta.profileId, meta.profileArgs, meta.profileEnv], ['claude-dev', ['--dangerously-skip-permissions'], undefined])
    const plain = await c.client.request({ t: 'create', kind: 'claude', cwd, profileId: 'claude' })
    assert.equal(plain.slot!.profileName, 'Claude')
    assert.equal(plain.slot!.unsafe, undefined)
    const none = await c.client.request({ t: 'create', kind: 'claude', cwd })
    assert.equal(none.slot!.profileId, undefined)
    for (const s of [slot!, plain.slot!, none.slot!]) await c.client.request({ t: 'forget', slotId: s.slotId })
    c.close()
  })
})

/** Waits for the slot to exit AFTER the run with `pid` (a `state` matcher alone would accept the slot's initial 'exited'). */
async function exitedAfter(c: Recorder, slotId: string, pid: number): Promise<void> {
  await waitUntil(() => {
    const i = c.states.findIndex((s) => s.slotId === slotId && s.pid === pid)
    return i >= 0 && c.states.slice(i + 1).some((s) => s.slotId === slotId && s.status === 'exited' && s.pid === undefined)
  }, 15_000, `exit of pid ${pid} in slot ${slotId}`)
}

describe('the profile applied to a real launch (shell kind: node as the "shell")', () => {
  let slotId = ''

  test('create + start with the profile: the process got the profile\'s shell, args and env', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const saved = await c.client.request({ t: 'profile-save', profile: nodeProfile('Node teste') })
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, profileId: saved.profile!.id, start: true })
    slotId = slot!.slotId
    assert.equal(slot!.profileName, 'Node teste')
    await c.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    await c.see(slotId, /ARGS=first ENV=v1/)
    await exitedAfter(c, slotId, slot!.pid!)
    c.close()
  })

  test('the profile edited → the next start uses the new args/env and refreshes the slot\'s snapshot', async () => {
    const c = await Recorder.connect(daemon.pipe)
    await c.client.request({ t: 'profile-save', profile: { ...nodeProfile('Node teste'), id: 'node-teste', args: [...nodeProfile('x').args.slice(0, -1), 'second'], env: { PROFILE_TEST_VAR: 'v2' } } })
    await c.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    const { slot } = await c.client.request({ t: 'start', slotId })
    await c.see(slotId, /ARGS=second ENV=v2/)
    await exitedAfter(c, slotId, slot!.pid!)
    const meta = JSON.parse(readFileSync(slotMetaPath(home, slotId), 'utf8')) as SlotMeta
    assert.ok(meta.profileArgs!.includes('second'), 'snapshot refreshed on launch')
    assert.deepEqual(meta.profileEnv, { PROFILE_TEST_VAR: 'v2' })
    c.close()
  })

  test('the profile deleted → the slot still starts from its snapshot; its state loses the name, keeps the id', async () => {
    const c = await Recorder.connect(daemon.pipe)
    await c.client.request({ t: 'profile-delete', profileId: 'node-teste' })
    const gone = await c.state(slotId, (s) => s.profileName === undefined && s.profileId === 'node-teste', 5_000, 'state without the profile name')
    assert.equal(gone.profileId, 'node-teste')
    await c.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    const { slot } = await c.client.request({ t: 'start', slotId })
    await c.see(slotId, /ARGS=second ENV=v2/)
    await exitedAfter(c, slotId, slot!.pid!)
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a slot from before profiles existed (old meta, no profile fields) is listed and starts as always', async () => {
    const old: SlotMeta = { v: 1, slotId: 'bb000001', agent: 'shell', cwd, args: [process.execPath, '-e', 'console.log("OLD-OK")'], createdAt: '2026-01-01T00:00:00.000Z' }
    writeFileSync(slotMetaPath(home, old.slotId), JSON.stringify(old))
    const c = await Recorder.connect(daemon.pipe)
    await c.state(old.slotId, (s) => s.status === 'exited', 5_000, 'adopted')
    const { slots } = await c.client.request({ t: 'list' })
    const mine = slots!.find((s) => s.slotId === old.slotId)!
    assert.equal(mine.profileId, undefined)
    assert.equal(mine.unsafe, undefined)
    await c.client.request({ t: 'attach', slotId: old.slotId, cols: 100, rows: 30 })
    const { slot } = await c.client.request({ t: 'start', slotId: old.slotId })
    await c.see(old.slotId, /OLD-OK/)
    await exitedAfter(c, old.slotId, slot!.pid!)
    await c.client.request({ t: 'forget', slotId: old.slotId })
    c.close()
  })

  test('the file edited behind the daemon\'s back (CLI with tetherd up) is picked up on the next list', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const file = JSON.parse(readFileSync(profilesPath(home), 'utf8')) as { v: 1; profiles: Profile[] }
    file.profiles.push({ id: 'externo', name: 'Externo', agent: 'soul', args: ['-g'] })
    await new Promise((r) => setTimeout(r, 20)) // a distinct mtime
    writeFileSync(profilesPath(home), JSON.stringify(file))
    const { profiles } = await c.client.request({ t: 'profiles-list' })
    assert.ok(profiles!.some((p) => p.id === 'externo'))
    c.close()
  })
})

// DaemonClient is imported for its type in the assertions above; keep the module graph honest.
void DaemonClient
