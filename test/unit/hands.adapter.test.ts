// The hands adapter (src/agents/hands.ts, exec/ops-hands.ts): how `hands` is found (TETHER_HANDS_CMD, ~/bin/hands on
// Windows; never anything of the soul's), the launch plan with and without a resume (the report in HANDS_SESSION_EVENTS /
// HANDS_SLOT_ID, the node renamed tether-hands), the args and env a profile must not carry, the extension's contribution
// (no default, no -g, no MCP, skills through HANDS_SHARED_FOLDERS), its doctor checks and its context reader.
import { test, describe, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_HANDS_CMD, ENV_HANDS_REPORT, ENV_HANDS_SLOT, HANDS_SHARED_FOLDERS_ENV, handsAdapter, handsSkills, resolveHandsCommand as resolveViaExecutor } from '../../src/agents/hands.ts'
import { clearHandsResolveCache, handsCommandFromScript, handsFromGitBash, handsLaunch, handsOps, resolveHandsCommand, withHandsNode } from '../../src/exec/ops-hands.ts'
import { ENV_AGENT, ENV_HOME, ENV_SLOT } from '../../src/agents/types.ts'
import type { Binding, SlotMeta } from '../../src/core/event.ts'
import { exePath } from '../../src/core/exe.ts'
import { readStamp, type ExeStatus } from '../../src/core/exe-sync.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { validateProfile } from '../../src/core/profile.ts'
import { checkHands, checkHandsExe } from '../../src/doctor-hands.ts'
import { HandsEventsReader } from '../../src/context/hands.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import '../../extensions/index.daemon.ts'
import { handsAgent } from '../../extensions/hands/daemon.ts'
import { handsProvider } from '../../extensions/context/providers.ts'
import { CONTEXT_AGENTS, agentLabel, memoryTitle } from '../../extensions/context/rules.ts'
import { tempDirs } from './tmp.helpers.ts'

const dirs = tempDirs('tether-hands-')
after(() => dirs.cleanup())

const slot: SlotMeta = {
  v: 1,
  slotId: 'hands-1',
  agent: 'hands',
  cwd: 'D:\\clientes\\loja',
  args: ['-H', 'https://agentes.exemplo', '-a', 'atendente', '--model', 'cheap'],
  createdAt: '2026-11-21T00:00:00.000Z',
}

const binding: Binding = {
  slotId: 'hands-1',
  agent: 'hands',
  sessionId: 'sess-77',
  cwd: 'D:\\clientes\\outra',
  since: '2026-11-21T00:00:00.000Z',
  confirmed: true,
  ended: false,
  title: 'pedido da loja',
  resume: { cwd: 'D:\\clientes\\outra', args: ['-r', 'sess-77', '-H', 'https://agentes.exemplo', '-a', 'atendente'], env: { HANDS_X: '1' } },
}

describe('finding hands', () => {
  test('TETHER_HANDS_CMD wins and is split into command + args', () => {
    clearHandsResolveCache()
    assert.deepEqual(resolveHandsCommand({ [ENV_HANDS_CMD]: `"${process.execPath}" D:/x/bin/hands  --flag`, PATH: '' }), { command: process.execPath, args: ['D:/x/bin/hands', '--flag'] })
    assert.throws(() => resolveHandsCommand({ [ENV_HANDS_CMD]: '""', PATH: '' }), /TETHER_HANDS_CMD vazio/)
  })

  test('the soul\'s command variable means nothing to the hands', () => {
    clearHandsResolveCache()
    assert.notDeepEqual(resolveHandsCommand({ TETHER_SOUL_CMD: 'node D:/x/bin/soul', PATH: '', USERPROFILE: dirs.make() }).args, ['D:/x/bin/soul'])
  })

  test('nothing anywhere: the bare `hands`', { skip: process.platform === 'win32' }, () => {
    clearHandsResolveCache()
    assert.deepEqual(resolveHandsCommand({ PATH: '' }), { command: 'hands', args: [] })
  })

  test('the installed bash launcher: NODE= and CLI= become `node <cli>`; a missing NODE falls back to this node; no CLI= runs through bash', () => {
    const dir = dirs.make()
    const script = join(dir, 'hands')
    writeFileSync(script, ['#!/usr/bin/env bash', 'NODE="/z/does/not/exist/node.exe"', 'CLI="D:/atrium/workspace/soul-cli/bin/hands"', 'exec "$NODE" "$CLI" "$@"', ''].join('\n'))
    assert.deepEqual(handsCommandFromScript(script, {}), { command: process.execPath, args: ['D:/atrium/workspace/soul-cli/bin/hands'] })
    writeFileSync(script, '#!/usr/bin/env bash\nexec something "$@"\n')
    assert.deepEqual(handsCommandFromScript(script, { PATH: '' }), { command: 'bash', args: [script] })
  })

  test('Windows: ~/bin/hands (Git Bash\'s home bin) is found when hands is not on PATH', { skip: process.platform !== 'win32' }, () => {
    clearHandsResolveCache()
    const home = dirs.make()
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, 'bin', 'hands'), ['#!/usr/bin/env bash', `NODE="${process.execPath.replace(/\\/g, '/')}"`, 'CLI="D:/atrium/workspace/soul-cli/bin/hands"', 'exec "$NODE" "$CLI" "$@"', ''].join('\n'))
    assert.deepEqual(handsFromGitBash({ USERPROFILE: home, PATH: '' })?.args, ['D:/atrium/workspace/soul-cli/bin/hands'])
    assert.deepEqual(resolveHandsCommand({ USERPROFILE: home, PATH: '' }).args, ['D:/atrium/workspace/soul-cli/bin/hands'])
  })

  test('the launch runs the node as tether-hands (copied from the real node; TETHER_NODE when the daemon is itself a copy)', { skip: process.platform === 'darwin' }, () => {
    const home = dirs.make()
    const { command } = handsLaunch({ [ENV_HANDS_CMD]: `"${process.execPath}" D:/x/bin/hands`, PATH: '' }, home)
    assert.equal(command.command, exePath(home, 'tether-hands'))
    assert.deepEqual(command.args, ['D:/x/bin/hands'])
    assert.equal(readStamp(home, 'tether-hands')?.source, process.execPath)
    const home2 = dirs.make()
    assert.equal(withHandsNode({ command: 'C:\\h\\bin\\tetherd.exe', args: [] }, home2, { TETHER_NODE: process.execPath }).command, exePath(home2, 'tether-hands'))
    assert.deepEqual(withHandsNode({ command: 'C:\\x\\hands.exe', args: [] }, home), { command: 'C:\\x\\hands.exe', args: [] })
  })

  test('over the executor: resolveHands / handsLaunch', async () => {
    assert.deepEqual(Object.keys(handsOps).sort(), ['handsLaunch', 'resolveHands'])
    const exec = createExecutor({ mode: 'inline' })
    try {
      clearHandsResolveCache()
      assert.deepEqual((await resolveViaExecutor({ [ENV_HANDS_CMD]: 'node D:/y/bin/hands', PATH: '' }, exec)).args, ['D:/y/bin/hands'])
    } finally {
      await exec.close()
    }
  })
})

describe('handsAdapter.plan', () => {
  const ownArgs = (plan: { command: string; args: string[] }): string[] => {
    if (process.platform !== 'darwin') return plan.args
    assert.equal(plan.command, '/bin/sh')
    assert.deepEqual(plan.args.slice(0, 2), ['-c', 'exec -a tether-hands "$0" "$@"'])
    return plan.args.slice(3)
  }
  const keys = [ENV_HANDS_CMD, ENV_HANDS_REPORT, ENV_HANDS_SLOT, ENV_SLOT, ENV_HOME, 'HANDS_X']
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k]
    process.env[ENV_HANDS_CMD] = 'node D:/fake/bin/hands'
    // A hands that launched this tether: its variables must not redirect the slot's report.
    process.env[ENV_HANDS_REPORT] = 'C:\\stale\\events.jsonl'
    process.env[ENV_HANDS_SLOT] = 'stale-slot'
    delete process.env.HANDS_X
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('new session: TETHER_HANDS_CMD + slot args + extra args, in the slot cwd; the report and the slot id under the hands\' names', async () => {
    const home = dirs.make()
    const plan = await handsAdapter.plan({ slot, home, extraArgs: ['-n', 'nova'] })
    assert.deepEqual(ownArgs(plan), ['D:/fake/bin/hands', ...slot.args, '-n', 'nova'])
    if (process.platform !== 'darwin') {
      assert.equal(plan.command, exePath(home, 'tether-hands'))
      assert.ok(existsSync(plan.command), 'the renamed node is in place')
    }
    assert.equal(plan.cwd, slot.cwd)
    assert.equal(plan.env[ENV_HANDS_REPORT], slotEventsPath(home, slot.slotId))
    assert.equal(plan.env[ENV_HANDS_SLOT], slot.slotId)
    assert.equal(plan.env[ENV_SLOT], slot.slotId)
    assert.equal(plan.env[ENV_HOME], home)
    assert.equal(plan.env[ENV_AGENT], 'hands')
    assert.ok(!plan.args.includes('-r'))
  })

  test('resume: profile, then the recipe, then the slot args (minus -c/--continue); the recipe\'s cwd and env', async () => {
    const home = dirs.make()
    const own = { ...slot, args: ['-c', '--fork-session', '--continue', '--model', 'cheap'] }
    const profile = { id: 'hands', name: 'hands', agent: 'hands', args: ['-w', 'D:\\docs'], env: { HANDS_X: 'perfil' } }
    const plan = await handsAdapter.plan({ slot: own, home, resume: binding, extraArgs: ['ignored'], profile })
    assert.deepEqual(ownArgs(plan), ['D:/fake/bin/hands', '-w', 'D:\\docs', '-r', 'sess-77', '-H', 'https://agentes.exemplo', '-a', 'atendente', '--fork-session', '--model', 'cheap'])
    assert.equal(plan.cwd, 'D:\\clientes\\outra')
    assert.equal(plan.env.HANDS_X, '1', 'the recipe env over the profile\'s')
    assert.equal(plan.env[ENV_HANDS_REPORT], slotEventsPath(home, slot.slotId))
    assert.equal(plan.env[ENV_HANDS_SLOT], slot.slotId)
  })

  test('resume without a recipe: -r <id> plus the slot args, in the binding cwd', async () => {
    const { resume: _r, ...bare } = binding
    const plan = await handsAdapter.plan({ slot, home: dirs.make(), resume: bare, extraArgs: [] })
    assert.deepEqual(ownArgs(plan), ['D:/fake/bin/hands', '-r', 'sess-77', ...slot.args])
    assert.equal(plan.cwd, bare.cwd)
  })

  test('sessionExists is unknown (the sessions live on the server); title comes from the binding', async () => {
    assert.equal(await handsAdapter.sessionExists(binding), 'unknown')
    assert.equal(await handsAdapter.title(binding), 'pedido da loja')
    assert.equal(handsAdapter.name, 'hands')
    assert.equal(handsAdapter.resumes, true)
  })
})

describe('the hands extension', () => {
  test('contribution: not a default profile, no args, TETHER_HANDS_ARGS, no MCP and no channel (the hands has no --mcp-config)', () => {
    assert.equal(handsAgent.adapter, handsAdapter)
    assert.deepEqual(handsAgent.defaultProfiles(process.env, process.platform), [{ id: 'hands', name: 'hands', agent: 'hands', args: [] }])
    assert.equal(handsAgent.envArgsVar, 'TETHER_HANDS_ARGS')
    assert.deepEqual(handsAgent.attention, { idle: true, bel: true })
    assert.equal(handsAgent.mcp, undefined)
    assert.equal(handsAgent.channel, undefined)
    assert.equal(handsAgent.skills, handsSkills)
  })

  test('skills: one shared folder in HANDS_SHARED_FOLDERS, appended to what the env holds', async () => {
    const exec = createExecutor({ mode: 'inline' })
    try {
      const home = dirs.make()
      const lib = dirs.make()
      mkdirSync(join(lib, 'use-todo'))
      writeFileSync(join(lib, 'use-todo', 'SKILL.md'), '---\nname: use-todo\ndescription: x\n---\nbody\n')
      const bundle = { skills: [{ name: 'use-todo', description: 'x', dir: join(lib, 'use-todo'), text: 'body' }], home, version: 'v1', exec }
      const out = await handsSkills.inject({ command: 'h', args: [], cwd: '.', env: {} }, bundle as never)
      const dir = out.env[HANDS_SHARED_FOLDERS_ENV]!
      assert.ok(dir.startsWith(join(home, 'skills', 'hands')), dir)
      assert.ok(existsSync(join(dir, 'skills', 'use-todo', 'SKILL.md')))
      const again = await handsSkills.inject({ command: 'h', args: [], cwd: '.', env: { [HANDS_SHARED_FOLDERS_ENV]: 'mine' } }, bundle as never)
      assert.ok(again.env[HANDS_SHARED_FOLDERS_ENV]!.startsWith('mine'))
      assert.deepEqual(Object.keys(out.env), [HANDS_SHARED_FOLDERS_ENV])
    } finally {
      await exec.close()
    }
  })

  test('profiles: -r/--resume, -c/--continue, --session-id, --fork-session refused; -H, -a, -w fine; the report variables refused', () => {
    const base = { name: 'X', agent: 'hands' as const, args: [] as string[] }
    for (const arg of ['-r', '--resume', '-c', '--continue', '--session-id', '--fork-session', '--resume=abc']) {
      assert.equal(validateProfile({ ...base, args: [arg] }).errors.length, 1, arg)
    }
    assert.deepEqual(validateProfile({ ...base, args: ['-H', 'https://x', '-a', 'y', '-w', 'D:\\docs'] }).errors, [])
    const env = validateProfile({ ...base, env: { HANDS_SESSION_EVENTS: 'x', HANDS_SLOT_ID: 'y', HANDS_CONFIG_DIR: 'ok' } })
    assert.equal(env.errors.length, 2, env.errors.join('\n'))
  })

  test('doctor: the program and its report variable', () => {
    assert.deepEqual(checkHands({ command: 'x', found: false, versionOutput: undefined, sourceText: undefined }),
      { level: 'AVISO', name: 'hands', detail: 'não encontrado no PATH', hint: 'só importa se você usa o hands: instale-o ou aponte TETHER_HANDS_CMD' })
    assert.equal(checkHands({ command: 'bin/hands', found: true, versionOutput: '', sourceText: undefined }).level, 'ERRO')
    assert.deepEqual(checkHands({ command: 'bin/hands', found: true, versionOutput: 'hands 0.1.188', sourceText: 'HANDS_SESSION_EVENTS' }),
      { level: 'OK', name: 'hands', detail: '0.1.188 (bin/hands), com HANDS_SESSION_EVENTS' })
    assert.equal(checkHands({ command: 'bin/hands', found: true, versionOutput: 'hands 0.1.1', sourceText: 'nothing' }).level, 'AVISO')
  })

  test('doctor: the tether-hands copy of node', () => {
    const st = (over: Partial<ExeStatus>): ExeStatus => ({ name: 'tether-hands', path: 'C:\\h\\bin\\tether-hands.exe', present: true, stamp: { source: 'C:\\n\\node.exe', size: 1, mtimeMs: 1, method: 'copy' }, outdated: false, residue: false, ...over })
    assert.equal(checkHandsExe(st({}), true, 'win32').detail, 'tether-hands: cópia de C:\\n\\node.exe')
    assert.equal(checkHandsExe(st({ stamp: { source: 'n', size: 0, mtimeMs: 0, method: 'fallback', reason: 'EACCES' } }), true, 'win32').level, 'AVISO')
    assert.match(checkHandsExe(st({ present: false }), true, 'win32').detail, /ainda não criado/)
    assert.equal(checkHandsExe(st({}), false, 'win32').level, 'OK')
    assert.equal(checkHandsExe(st({ present: true }), true, 'darwin').level, 'AVISO')
  })

  test('context: its own reader of the events file; only the session of the last start counts', () => {
    const file = join(dirs.make(), 'slot.jsonl')
    const line = (o: object) => appendFileSync(file, JSON.stringify(o) + '\n')
    line({ v: 1, kind: 'start', sessionId: 'a', ts: '2026-11-21T00:00:00.000Z' })
    line({ v: 1, kind: 'context', sessionId: 'a', ts: '2026-11-21T00:00:01.000Z', context: { model: 'general', totalTokens: 1200, maxTokens: 200000, percentage: 0.6, categories: [{ name: 'System', tokens: 1000 }], apiUsage: { input_tokens: 10, output_tokens: 5 } } })
    const reader = new HandsEventsReader(file)
    assert.equal(reader.poll(), 1)
    assert.equal(reader.context()?.totalTokens, 1200)
    assert.equal(reader.totals().output, 5)
    line({ v: 1, kind: 'start', sessionId: 'b', ts: '2026-11-21T00:00:02.000Z' })
    reader.poll()
    assert.equal(reader.context(), undefined, 'a new session clears the measure')
    const provider = handsProvider({ home: dirs.make() })
    assert.equal(provider.canMeasure, false)
    assert.ok(provider.makeReader(file) instanceof HandsEventsReader)
    assert.ok(CONTEXT_AGENTS.includes('hands'))
    assert.equal(agentLabel('hands'), 'hands')
    assert.equal(memoryTitle('hands'), 'Memória medida')
  })

  test('context: an open-source line measures the context but is not a turn', () => {
    const file = join(dirs.make(), 'slot.jsonl')
    const line = (o: object) => appendFileSync(file, JSON.stringify(o) + '\n')
    const ctx = (total: number) => ({ model: 'general', totalTokens: total, maxTokens: 200000, percentage: 0.5, categories: [{ name: 'System', tokens: 1000 }], apiUsage: null })
    line({ v: 1, kind: 'start', sessionId: 'a', ts: '2026-11-21T00:00:00.000Z' })
    line({ v: 1, kind: 'context', source: 'open', sessionId: 'a', ts: '2026-11-21T00:00:01.000Z', context: ctx(3000) })
    const reader = new HandsEventsReader(file)
    reader.poll()
    assert.equal(reader.context()?.totalTokens, 3000)
    assert.equal(reader.totals().turns, 0)
    assert.deepEqual(reader.turns(), [])
    line({ v: 1, kind: 'context', source: 'turn', sessionId: 'a', ts: '2026-11-21T00:00:02.000Z', context: { ...ctx(4000), apiUsage: { input_tokens: 7, output_tokens: 2 } } })
    assert.equal(reader.poll(), 1)
    assert.equal(reader.totals().turns, 1)
    assert.equal(reader.context()?.totalTokens, 4000)
  })
})
