// The three adapters applying a launch profile: where its args land on a new session and on a resume, how its
// env is merged (claude: after the CLAUDE* strip; soul: under the recipe's; the slot identity always last), and
// the Claude lookups (sessionExists/title/watchTitle) honouring the slot's CLAUDE_CONFIG_DIR.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, test } from 'node:test'
import { claudeAdapter } from '../../src/agents/claude.ts'
import { defaultShell, shellAdapter } from '../../src/agents/shell.ts'
import { ENV_SOUL_CMD, ENV_SOUL_REPORT, soulAdapter } from '../../src/agents/soul.ts'
import { ENV_SLOT } from '../../src/agents/types.ts'
import type { Binding, SlotMeta } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { defaultProfiles, launchOf } from '../../src/core/profile.ts'
import { tempDirs } from './tmp.helpers.ts'

const dirs = tempDirs('tether-agents-profile-')
after(() => dirs.cleanup())

function withEnv(vars: Record<string, string | undefined>): void {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

describe('claude', () => {
  withEnv({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'D:\\inherited-config' })
  const slot: SlotMeta = { v: 1, slotId: 'slot-1', agent: 'claude', cwd: 'D:\\sources\\projeto', args: ['--model', 'haiku'], createdAt: '2026-10-29T00:00:00.000Z' }
  const binding: Binding = { slotId: 'slot-1', agent: 'claude', sessionId: '0b6f1111-2222-4333-8444-555555555555', cwd: 'D:\\outra\\pasta', since: '2026-10-29T00:00:00.000Z', confirmed: true, ended: false }
  const profile = { args: ['--dangerously-skip-permissions'], env: { CLAUDE_CONFIG_DIR: 'D:\\conta-2', FOO: 'bar' } }

  test('new session: profile args after --session-id, before the slot args and the extra args', () => {
    const home = dirs.make()
    const plan = claudeAdapter.plan({ slot, home, extraArgs: ['-p', 'oi'], profile })
    assert.deepEqual(plan.args.slice(0, 3), ['--settings', join(home, 'claude-settings.json'), '--session-id'])
    assert.deepEqual(plan.args.slice(4), ['--dangerously-skip-permissions', '--model', 'haiku', '-p', 'oi'])
  })

  test('resume: --resume <id>, then the profile args, then the slot args', () => {
    const home = dirs.make()
    const plan = claudeAdapter.plan({ slot, home, resume: binding, extraArgs: [], profile })
    assert.deepEqual(plan.args, ['--settings', join(home, 'claude-settings.json'), '--resume', binding.sessionId, '--dangerously-skip-permissions', '--model', 'haiku'])
  })

  test('env: inherited CLAUDE* stripped, the profile\'s CLAUDE_CONFIG_DIR applied after the strip, TETHER vars still ours', () => {
    const home = dirs.make()
    const plan = claudeAdapter.plan({ slot, home, extraArgs: [], profile })
    assert.equal(plan.env.CLAUDECODE, undefined)
    assert.equal(plan.env.CLAUDE_CONFIG_DIR, 'D:\\conta-2')
    assert.equal(plan.env.FOO, 'bar')
    assert.equal(plan.env.TETHER_SLOT_ID, 'slot-1')
    assert.equal(plan.env.TETHER_HOME, home)
    const without = claudeAdapter.plan({ slot, home, extraArgs: [], profile: { args: [] } })
    assert.equal(without.env.CLAUDE_CONFIG_DIR, undefined, 'no profile env: the inherited one stays stripped')
    const hostile = claudeAdapter.plan({ slot, home, extraArgs: [], profile: { args: [], env: { TETHER_SLOT_ID: 'other' } } })
    assert.equal(hostile.env.TETHER_SLOT_ID, 'slot-1', 'the slot identity is set after the profile env')
  })

  test('sessionExists / title / watchTitle look in the slot\'s CLAUDE_CONFIG_DIR, not the process one', async () => {
    const mine = dirs.make()
    const id = binding.sessionId
    const dir = join(mine, 'projects', 'D--p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), '{"type":"custom-title","customTitle":"na conta 2"}\n')
    const b: Binding = { ...binding, cwd: 'D:\\p' }
    assert.equal(await claudeAdapter.sessionExists(b), false, 'the process CLAUDE_CONFIG_DIR points nowhere')
    assert.equal(await claudeAdapter.sessionExists(b, { env: { CLAUDE_CONFIG_DIR: mine } }), true)
    assert.equal(await claudeAdapter.title(b, { env: { CLAUDE_CONFIG_DIR: mine } }), 'na conta 2')
    assert.equal(await claudeAdapter.title(b, { env: { FOO: '1' } }), undefined)
    const seen: string[] = []
    const stop = claudeAdapter.watchTitle!(b, (t) => seen.push(t), 20, { env: { CLAUDE_CONFIG_DIR: mine } })
    await new Promise((r) => setTimeout(r, 150))
    stop()
    assert.deepEqual(seen, ['na conta 2'])
  })
})

describe('soul', () => {
  // On macOS the real node runs through `/bin/sh -c 'exec -a tether-soul "$0" "$@"' <node>` (withRenamedNode): the
  // soul's own args come after that prefix; elsewhere they are the whole list.
  const soulArgs = (plan: { command: string; args: string[] }): string[] => {
    if (process.platform !== 'darwin') return plan.args
    assert.equal(plan.command, '/bin/sh')
    assert.deepEqual(plan.args.slice(0, 2), ['-c', 'exec -a tether-soul "$0" "$@"'])
    return plan.args.slice(3)
  }
  withEnv({ [ENV_SOUL_CMD]: 'node D:/fake/bin/soul', SOUL_X: undefined })
  const slot: SlotMeta = { v: 1, slotId: 'soul-1', agent: 'soul', cwd: 'D:\\agentes\\serpente', args: ['-P', 'guga@codr.studio'], createdAt: '2026-10-29T00:00:00.000Z' }
  const binding: Binding = {
    slotId: 'soul-1', agent: 'soul', sessionId: 'sess-1234', cwd: 'D:\\outra\\pasta', since: '2026-10-29T00:00:00.000Z', confirmed: true, ended: false,
    resume: { cwd: 'D:\\outra\\pasta', args: ['-r', 'sess-1234', '-g', '-P', 'guga@codr.studio'], env: { SOUL_X: '1' } },
  }
  const profile = { args: ['-g', '--model', 'cheap'], env: { SOUL_X: 'from-profile', SOUL_Y: 'y' } }

  test('new session: profile args, then the slot args, then the extra args; profile env applied; report var ours', () => {
    const home = dirs.make() // a real folder: the plan makes <home>/bin/tether-soul.exe
    const plan = soulAdapter.plan({ slot, home, extraArgs: ['-n', 'nova'], profile })
    assert.deepEqual(soulArgs(plan), ['D:/fake/bin/soul', '-g', '--model', 'cheap', '-P', 'guga@codr.studio', '-n', 'nova'])
    assert.equal(plan.env.SOUL_X, 'from-profile')
    assert.equal(plan.env.SOUL_Y, 'y')
    assert.equal(plan.env[ENV_SOUL_REPORT], slotEventsPath(home, slot.slotId))
  })

  test('resume: profile args BEFORE the recipe (the recipe finds the session and wins), slot args last; recipe env over profile env', () => {
    const plan = soulAdapter.plan({ slot, home: dirs.make(), resume: binding, extraArgs: [], profile })
    assert.deepEqual(soulArgs(plan), ['D:/fake/bin/soul', '-g', '--model', 'cheap', '-r', 'sess-1234', '-g', '-P', 'guga@codr.studio', '-P', 'guga@codr.studio'])
    assert.equal(plan.env.SOUL_X, '1', 'the recipe\'s env wins over the profile\'s')
    assert.equal(plan.env.SOUL_Y, 'y')
    assert.equal(plan.cwd, 'D:\\outra\\pasta')
  })

  test('resume without a recipe: profile args, -r <id>, slot args', () => {
    const { resume: _r, ...bare } = binding
    const plan = soulAdapter.plan({ slot, home: dirs.make(), resume: bare, extraArgs: [], profile })
    assert.deepEqual(soulArgs(plan), ['D:/fake/bin/soul', '-g', '--model', 'cheap', '-r', 'sess-1234', '-P', 'guga@codr.studio'])
  })

  test('a profile env cannot redirect the report nor rename the slot (the identity is set last)', () => {
    const home = dirs.make()
    const plan = soulAdapter.plan({ slot, home, extraArgs: [], profile: { args: [], env: { [ENV_SOUL_REPORT]: 'C:\\elsewhere', [ENV_SLOT]: 'other' } } })
    assert.equal(plan.env[ENV_SOUL_REPORT], slotEventsPath(home, slot.slotId))
    assert.equal(plan.env[ENV_SLOT], slot.slotId)
  })
})

describe('shell', () => {
  const slot: SlotMeta = { v: 1, slotId: 'sh-1', agent: 'shell', cwd: process.cwd(), args: [], createdAt: '2026-10-29T00:00:00.000Z' }

  test('no args, no profile: the default shell', () => {
    const plan = shellAdapter.plan({ slot })
    assert.deepEqual({ command: plan.command, args: plan.args }, defaultShell())
  })

  test('a shell profile names the shell (its args after the shell\'s own) and adds its env', () => {
    const profile = launchOf({ id: 'node', name: 'Node', agent: 'shell', args: ['-e', '1'], shell: { command: process.execPath, args: ['--no-warnings'] }, env: { SH_PROFILE: 'yes' } })
    const plan = shellAdapter.plan({ slot, profile })
    assert.equal(plan.command, process.execPath)
    assert.deepEqual(plan.args, ['--no-warnings', '-e', '1'])
    assert.equal(plan.env.SH_PROFILE, 'yes')
  })

  test('the slot\'s own args win over the profile; "resume" = the given cwd', () => {
    const profile = launchOf({ id: 'node', name: 'Node', agent: 'shell', args: [], shell: { command: process.execPath, args: ['--no-warnings'] } })
    const plan = shellAdapter.plan({ slot: { ...slot, args: [process.execPath, '-v'] }, profile, cwd: process.cwd() })
    assert.deepEqual(plan.args, ['-v'])
  })

  test('the default PowerShell profile launches exactly what the default shell would', { skip: process.platform !== 'win32' }, () => {
    const ps = defaultProfiles().find((p) => p.id === 'powershell')!
    const plan = shellAdapter.plan({ slot, profile: launchOf(ps) })
    assert.deepEqual({ command: plan.command, args: plan.args }, defaultShell())
  })

  test('a profile whose shell is neither on disk nor on PATH falls back to the default shell', () => {
    const plan = shellAdapter.plan({ slot, profile: { args: ['Z:\\nope\\shell.exe', '-x'] } })
    assert.deepEqual({ command: plan.command, args: plan.args }, defaultShell())
  })
})
