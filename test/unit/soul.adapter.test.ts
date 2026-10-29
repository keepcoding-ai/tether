// The soul adapter: how `soul` is found (TETHER_SOUL_CMD, the bash launcher on Windows), and the launch plan
// for a new session (slot args + extra args) and for a resume (the binding's recipe, verbatim).
import { test, describe, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  commandFromScript,
  ENV_SOUL_CMD,
  ENV_SOUL_REPORT,
  fromMsysPath,
  resolveSoulCommand,
  soulAdapter,
  splitCommandLine,
  withRenamedNode,
} from '../../src/agents/soul.ts'
import { ENV_HOME, ENV_SLOT } from '../../src/agents/types.ts'
import type { Binding, SlotMeta } from '../../src/core/event.ts'
import { exePath, readStamp } from '../../src/core/exe.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { tempDirs } from './tmp.helpers.ts'

const dirs = tempDirs('tether-soul-')
after(() => dirs.cleanup())

const slot: SlotMeta = {
  v: 1,
  slotId: 'soul-1',
  agent: 'soul',
  cwd: 'D:\\agentes\\serpente',
  args: ['-g', '-P', 'guga@codr.studio', '--strategy', 'anthropic', '--model', 'cheap'],
  createdAt: '2026-10-29T00:00:00.000Z',
}

const binding: Binding = {
  slotId: 'soul-1',
  agent: 'soul',
  sessionId: 'sess-1234',
  cwd: 'D:\\outra\\pasta',
  since: '2026-10-29T00:00:00.000Z',
  confirmed: true,
  ended: false,
  title: 'conversa da serpente',
  resume: { cwd: 'D:\\outra\\pasta', args: ['-r', 'sess-1234', '-g', '-P', 'guga@codr.studio'], env: { SOUL_X: '1' } },
}

describe('command line helpers', () => {
  test('splitCommandLine: whitespace splits, quotes keep a token whole', () => {
    assert.deepEqual(splitCommandLine('node D:/x/bin/soul'), ['node', 'D:/x/bin/soul'])
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" D:/x/bin/soul  --flag'), ['C:\\Program Files\\nodejs\\node.exe', 'D:/x/bin/soul', '--flag'])
    assert.deepEqual(splitCommandLine("  'a b' c "), ['a b', 'c'])
    assert.deepEqual(splitCommandLine(''), [])
  })

  test('fromMsysPath converts /c/... and leaves the rest alone', () => {
    assert.equal(fromMsysPath('/c/Users/gugac/.local/node/node.exe'), 'C:/Users/gugac/.local/node/node.exe')
    assert.equal(fromMsysPath('D:/x/bin/soul'), 'D:/x/bin/soul')
    assert.equal(fromMsysPath('/usr/bin/node'), '/usr/bin/node')
  })

  test('commandFromScript: NODE= and CLI= lines become `node <cli>`; a missing NODE falls back to this node', () => {
    const dir = dirs.make()
    const script = join(dir, 'soul')
    writeFileSync(script, [
      '#!/usr/bin/env bash',
      'NODE="/z/does/not/exist/node.exe"',
      'CLI="D:/atrium/workspace/soul-cli/bin/soul"',
      'exec "$NODE" "$CLI" "$@"',
      '',
    ].join('\n'))
    const cmd = commandFromScript(script, {})
    assert.equal(cmd.command, process.execPath)
    assert.deepEqual(cmd.args, ['D:/atrium/workspace/soul-cli/bin/soul'])

    writeFileSync(script, [
      '#!/usr/bin/env bash',
      `NODE="${process.execPath.replace(/\\/g, '/')}"`,
      "CLI='D:/x/bin/soul'",
      'exec "$NODE" "$CLI" "$@"',
    ].join('\n'))
    const cmd2 = commandFromScript(script, {})
    assert.equal(cmd2.command, process.execPath.replace(/\\/g, '/'))
    assert.deepEqual(cmd2.args, ['D:/x/bin/soul'])
  })

  test('commandFromScript: a script without CLI= runs through bash', () => {
    const dir = dirs.make()
    const script = join(dir, 'soul')
    writeFileSync(script, '#!/usr/bin/env bash\nexec something "$@"\n')
    const cmd = commandFromScript(script, { PATH: '' })
    assert.equal(cmd.command, 'bash')
    assert.deepEqual(cmd.args, [script])
  })

  test('resolveSoulCommand: TETHER_SOUL_CMD wins and is split into command + args', () => {
    const cmd = resolveSoulCommand({ [ENV_SOUL_CMD]: `"${process.execPath}" D:/atrium/workspace/soul-cli-tether/bin/soul`, PATH: '' })
    assert.equal(cmd.command, process.execPath)
    assert.deepEqual(cmd.args, ['D:/atrium/workspace/soul-cli-tether/bin/soul'])
  })

  test('resolveSoulCommand: nothing on PATH → bare `soul`', () => {
    assert.deepEqual(resolveSoulCommand({ PATH: '' }), { command: 'soul', args: [] })
  })
})

describe('soulAdapter.plan', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of [ENV_SOUL_CMD, ENV_SOUL_REPORT, ENV_SLOT, ENV_HOME, 'SOUL_X']) saved[k] = process.env[k]
    process.env[ENV_SOUL_CMD] = 'node D:/fake/bin/soul'
    process.env[ENV_SOUL_REPORT] = 'C:\\stale\\report.jsonl'
    delete process.env.SOUL_X
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  // The plan makes <home>/bin/tether-soul.exe (core/exe.ts): the home must be a real temp folder, never a made-up path.
  test('new session: TETHER_SOUL_CMD + slot args + extra args, in the slot cwd, reporting to the slot jsonl; the node runs as tether-soul.exe', () => {
    const home = dirs.make()
    const plan = soulAdapter.plan({ slot, home, extraArgs: ['-n', 'nova'] })
    assert.deepEqual(plan.args, ['D:/fake/bin/soul', ...slot.args, '-n', 'nova'])
    assert.equal(plan.command, exePath(home, 'tether-soul'), plan.command)
    assert.ok(existsSync(plan.command), 'the renamed node is in place')
    assert.equal(plan.cwd, slot.cwd)
    assert.equal(plan.env[ENV_SOUL_REPORT], slotEventsPath(home, slot.slotId))
    assert.equal(plan.env[ENV_SLOT], slot.slotId)
    assert.equal(plan.env[ENV_HOME], home)
    assert.ok(!plan.args.includes('-r'))
  })

  test('resume: the recipe args first, then the slot args (minus -c), its cwd, its env added', () => {
    const home = dirs.make()
    const plan = soulAdapter.plan({ slot, home, resume: binding, extraArgs: [] })
    assert.deepEqual(plan.args, ['D:/fake/bin/soul', '-r', 'sess-1234', '-g', '-P', 'guga@codr.studio', ...slot.args])
    assert.equal(plan.cwd, 'D:\\outra\\pasta')
    assert.equal(plan.env.SOUL_X, '1')
    assert.equal(plan.env[ENV_SOUL_REPORT], slotEventsPath(home, slot.slotId))
    assert.equal(plan.env[ENV_SLOT], slot.slotId)
  })

  test('resume: a slot created with -c/--continue or --fork-session keeps the fork, drops the continue', () => {
    const forked = { ...slot, args: ['-c', '--fork-session', '--continue', '-g'] }
    const plan = soulAdapter.plan({ slot: forked, home: dirs.make(), resume: binding, extraArgs: [] })
    assert.deepEqual(plan.args, ['D:/fake/bin/soul', '-r', 'sess-1234', '-g', '-P', 'guga@codr.studio', '--fork-session', '-g'])
  })

  test('resume without a recipe: -r <id> plus the slot args, in the binding cwd', () => {
    const { resume: _r, ...bare } = binding
    const plan = soulAdapter.plan({ slot, home: dirs.make(), resume: bare, extraArgs: [] })
    assert.deepEqual(plan.args, ['D:/fake/bin/soul', '-r', 'sess-1234', ...slot.args])
    assert.equal(plan.cwd, bare.cwd)
  })

  test('withRenamedNode: a node (or a tether copy of one) becomes tether-soul.exe from the real node; anything else is left alone', () => {
    const home = dirs.make()
    const log: string[] = []
    const fromNode = withRenamedNode({ command: process.execPath, args: ['x'] }, home, {}, (m) => log.push(m))
    assert.equal(fromNode.command, exePath(home, 'tether-soul'))
    assert.deepEqual(fromNode.args, ['x'])
    assert.equal(readStamp(home, 'tether-soul')?.source, process.execPath)
    // The daemon running as tetherd.exe names its real node in TETHER_NODE: the copy comes from there, not from tetherd.exe.
    const home2 = dirs.make()
    const fromDaemon = withRenamedNode({ command: 'C:\\h\\bin\\tetherd.exe', args: [] }, home2, { TETHER_NODE: process.execPath })
    assert.equal(fromDaemon.command, exePath(home2, 'tether-soul'))
    assert.equal(readStamp(home2, 'tether-soul')?.source, process.execPath)
    assert.deepEqual(withRenamedNode({ command: 'C:\\x\\soul.exe', args: [] }, home), { command: 'C:\\x\\soul.exe', args: [] })
    assert.deepEqual(withRenamedNode({ command: 'bash', args: ['/c/soul'] }, home), { command: 'bash', args: ['/c/soul'] })
  })

  test('sessionExists is unknown (sessions live on the soul server); title comes from the binding', async () => {
    assert.equal(await soulAdapter.sessionExists(binding), 'unknown')
    assert.equal(await soulAdapter.title(binding), 'conversa da serpente')
  })
})
