import { test, describe, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir as readdirP } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { claudeAdapter, cleanEnv, hookSettings, encodeProjectDir, watchTitleWith, withCommandDirOnPath } from '../../src/agents/claude.ts'
import { findTranscript, lastCustomTitle } from '../../src/agents/claude-sync.ts'
import { resolveClaudeCommand } from '../../src/exec/ops-agents.ts'
import type { Binding, SlotMeta } from '../../src/core/event.ts'
import { agentExecutor } from '../../src/agents/agent-exec.ts'
import { tempDirs } from './tmp.helpers.ts'

const HOOK = resolve(import.meta.dirname, '../../src/report/claude-hook.mjs')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const homes = tempDirs('tether-home-')
const configs = tempDirs('tether-claude-')
after(() => Promise.all([homes.cleanup(), configs.cleanup()]))

const slot: SlotMeta = {
  v: 1,
  slotId: 'slot-1',
  agent: 'claude',
  cwd: 'D:\\sources\\projeto',
  args: ['--model', 'haiku'],
  createdAt: '2026-10-29T00:00:00.000Z',
}

const binding: Binding = {
  slotId: 'slot-1',
  agent: 'claude',
  sessionId: '0b6f1111-2222-4333-8444-555555555555',
  cwd: 'D:\\outra\\pasta',
  since: '2026-10-29T00:00:00.000Z',
  confirmed: true,
  ended: false,
}

describe('claudeAdapter.plan', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ['CLAUDE_FAKE_FROM_TEST', 'ClaudeCodeMixedCase', 'NOT_CLAUDE_KEEP', 'CLAUDE_CONFIG_DIR']) saved[k] = process.env[k]
    process.env.CLAUDE_CONFIG_DIR = configs.make() // the machine's own ~/.claude (maybe with a statusLine) stays out
    process.env.CLAUDE_FAKE_FROM_TEST = '1'
    process.env.ClaudeCodeMixedCase = '1'
    process.env.NOT_CLAUDE_KEEP = 'yes'
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('the pane knows its agent kind (TETHER_AGENT), over any profile env', async () => {
    const plan = await claudeAdapter.plan({ slot, home: homes.make(), extraArgs: [], profile: { env: { TETHER_AGENT: 'forged' } } as never })
    assert.equal(plan.env.TETHER_AGENT, 'claude')
  })

  test('new session: --settings file, --session-id uuid, then slot args, then extra args', async () => {
    const home = homes.make()
    const plan = await claudeAdapter.plan({ slot, home, extraArgs: ['-p', 'oi'] })
    const settings = join(home, 'claude-settings.json')
    assert.deepEqual(plan.args.slice(0, 3), ['--settings', settings, '--session-id'])
    assert.match(plan.args[3]!, UUID)
    assert.deepEqual(plan.args.slice(4), ['--model', 'haiku', '-p', 'oi'])
    assert.equal(plan.cwd, slot.cwd)
    assert.ok(!plan.args.includes('--resume'))
  })

  test('two new sessions get different ids', async () => {
    const home = homes.make()
    const a = (await claudeAdapter.plan({ slot, home, extraArgs: [] })).args[3]
    const b = (await claudeAdapter.plan({ slot, home, extraArgs: [] })).args[3]
    assert.notEqual(a, b)
  })

  test('new session with -c / --continue / -r / --resume in the slot args: no --session-id (Claude refuses the pair)', async () => {
    const home = homes.make()
    for (const flag of ['-c', '--continue', '-r', '--resume']) {
      const plan = await claudeAdapter.plan({ slot: { ...slot, args: ['--model', 'haiku', flag] }, home, extraArgs: [] })
      assert.deepEqual(plan.args, ['--settings', join(home, 'claude-settings.json'), '--model', 'haiku', flag], flag)
    }
    const viaExtra = await claudeAdapter.plan({ slot, home, extraArgs: ['-c'] })
    assert.ok(!viaExtra.args.includes('--session-id'))
  })

  test('resume: --resume <id> in the binding cwd, no --session-id', async () => {
    const home = homes.make()
    const plan = await claudeAdapter.plan({ slot, home, resume: binding, extraArgs: [] })
    assert.deepEqual(plan.args, ['--settings', join(home, 'claude-settings.json'), '--resume', binding.sessionId, '--model', 'haiku'])
    assert.equal(plan.cwd, binding.cwd)
  })

  test('env: every inherited CLAUDE* var removed (any case), everything else kept, TETHER vars set', async () => {
    const home = homes.make()
    const plan = await claudeAdapter.plan({ slot, home, extraArgs: [] })
    const claudeKeys = Object.keys(plan.env).filter(k => /^claude/i.test(k))
    // The only CLAUDE* var is tether's own: Bash starts back in the pane's folder (an agent's `cd` never sticks).
    assert.deepEqual(claudeKeys, ['CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR'])
    assert.equal(plan.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1')
    assert.equal(plan.env.NOT_CLAUDE_KEEP, 'yes')
    assert.equal(plan.env.TETHER_SLOT_ID, 'slot-1')
    assert.equal(plan.env.TETHER_HOME, home)
    assert.ok(plan.env.PATH ?? plan.env.Path, 'PATH survives')
    for (const v of Object.values(plan.env)) assert.equal(typeof v, 'string')
  })

  test('cleanEnv strips by prefix only', () => {
    const env = cleanEnv({ CLAUDECODE: '1', CLAUDE_PID: '2', claude_x: '3', XCLAUDE: 'keep', FOO: 'bar', UNDEF: undefined })
    assert.deepEqual(env, { XCLAUDE: 'keep', FOO: 'bar' })
  })

  test('settings file: valid JSON, every hook call the reporter by absolute forward-slash path', async () => {
    const home = homes.make()
    await claudeAdapter.plan({ slot, home, extraArgs: [] })
    const file = join(home, 'claude-settings.json')
    const settings = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>
    }
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'])
    for (const event of ['SessionStart', 'SessionEnd', 'Stop', 'Notification', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop'] as const) {
      const group = settings.hooks[event]
      assert.equal(group?.length, 1)
      const hook = group![0]!.hooks[0]!
      assert.equal(hook.type, 'command')
      const expectedScript = HOOK.replace(/\\/g, '/')
      assert.equal(hook.command, `node "${expectedScript}" ${event}`)
      assert.ok(!hook.command.includes('\\'))
      assert.ok(existsSync(expectedScript), 'the script the hook points at exists')
    }
  })

  test('settings file: PostToolUse is guarded by a shell test so Node only spawns when a pause request or a notice exists', async () => {
    const home = homes.make()
    await claudeAdapter.plan({ slot, home, extraArgs: [] })
    const settings = JSON.parse(readFileSync(join(home, 'claude-settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    const group = settings.hooks.PostToolUse![0]!
    assert.equal(group.matcher, '*')
    const command = group.hooks[0]!.command
    assert.match(command, /^\{ test -e "\$TETHER_HOME\/slots\/\$TETHER_SLOT_ID\.pause-request\.json" \|\| test -e "\$TETHER_HOME\/slots\/\$TETHER_SLOT_ID\.notices\.jsonl"; \} && node ".*claude-hook\.mjs" PostToolUse \|\| true$/)
    assert.ok(!command.includes('\\'))
  })

  test('settings file is written once and left alone afterwards', async () => {
    const home = homes.make()
    await claudeAdapter.plan({ slot, home, extraArgs: [] })
    const file = join(home, 'claude-settings.json')
    const before = statSync(file).mtimeMs
    await new Promise(r => setTimeout(r, 20))
    await claudeAdapter.plan({ slot, home, resume: binding, extraArgs: [] })
    assert.equal(statSync(file).mtimeMs, before)
    assert.ok(!existsSync(`${file}.${process.pid}.tmp`))
  })

  test('settings file is rewritten when its content drifted', async () => {
    const home = homes.make()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'claude-settings.json'), '{"hooks":{}}')
    await claudeAdapter.plan({ slot, home, extraArgs: [] })
    const settings = JSON.parse(readFileSync(join(home, 'claude-settings.json'), 'utf8')) as { hooks: object }
    assert.ok('SessionStart' in settings.hooks)
  })

  test('command: on Windows an absolute path to claude.exe that spawns without a shell', { skip: process.platform !== 'win32' }, async () => {
    const home = homes.make()
    const plan = await claudeAdapter.plan({ slot, home, extraArgs: [] })
    if (plan.command === 'claude') return // claude not installed here: the bare name is the fallback
    assert.match(plan.command, /[\\/]claude(\.exe|\.cmd)?$/i)
    assert.ok(existsSync(plan.command))
    if (/\.cmd$/i.test(plan.command)) return // a .cmd shim needs a shell; nothing to check here
    const r = spawnSync(plan.command, ['--version'], { encoding: 'utf8', shell: false, timeout: 30_000 })
    assert.equal(r.error, undefined)
    assert.match(r.stdout, /Claude Code/)
  })
})

describe('encodeProjectDir (rule derived from real ~/.claude/projects names)', () => {
  test('known examples', () => {
    assert.equal(encodeProjectDir('D:\\sources\\localhost\\tether'), 'D--sources-localhost-tether')
    assert.equal(encodeProjectDir('D:\\atrium\\.tmp\\anvil'), 'D--atrium--tmp-anvil')
    assert.equal(encodeProjectDir('D:\\.tmp'), 'D---tmp')
    assert.equal(encodeProjectDir('/mnt/d/atrium'), '-mnt-d-atrium')
    assert.equal(encodeProjectDir('/home/guga'), '-home-guga')
    assert.equal(
      encodeProjectDir('C:\\Users\\gugac\\AppData\\Local\\Temp\\claude\\D--sources-localhost-tether\\5be339a3-3e3a-4a19-8353-e1659f996ae6\\scratchpad\\e0\\work'),
      'C--Users-gugac-AppData-Local-Temp-claude-D--sources-localhost-tether-5be339a3-3e3a-4a19-8353-e1659f996ae6-scratchpad-e0-work',
    )
    assert.equal(encodeProjectDir('C:\\a b_c.d'), 'C--a-b-c-d')
  })
})

describe('sessionExists / title against a fake ~/.claude (CLAUDE_CONFIG_DIR)', () => {
  let configDir: string
  let savedConfigDir: string | undefined
  const id = '0b6f1111-2222-4333-8444-555555555555'
  const b = (cwd: string, sessionId = id): Binding => ({ ...binding, sessionId, cwd })

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = configs.make()
    process.env.CLAUDE_CONFIG_DIR = configDir
  })
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  })

  function transcript(encodedDir: string, sessionId: string, lines: string[]): string {
    const dir = join(configDir, 'projects', encodedDir)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, lines.map(l => l + '\n').join(''))
    return file
  }

  test('title() and sessionExists() stay off the sync lookups (they run on the daemon loop)', () => {
    const src = readFileSync(resolve('src/agents/claude.ts'), 'utf8')
    for (const name of ['sessionExists', 'title']) {
      const start = src.indexOf(`async function ${name}(`)
      assert.ok(start >= 0, name)
      const body = src.slice(start, src.indexOf('\n}', start))
      assert.doesNotMatch(body, /findTranscript\(|lastCustomTitle\(|Sync\(/, `${name} calls a sync lookup`)
      assert.match(body, /findTranscriptAsync\(/, name)
    }
  })

  test('false when there is no projects dir at all', async () => {
    assert.equal(await claudeAdapter.sessionExists(b('D:\\x')), false)
  })

  test('true when the transcript is under the encoded cwd dir', async () => {
    transcript('D--x-y', id, ['{"type":"summary"}'])
    assert.equal(await claudeAdapter.sessionExists(b('D:\\x\\y')), true)
    assert.equal(await claudeAdapter.sessionExists(b('D:\\x\\z')), true) // found by the fallback scan
    assert.equal(await claudeAdapter.sessionExists(b('D:\\x\\y', 'ffffffff-0000-4000-8000-000000000000')), false)
  })

  test('fallback scan finds the transcript when the encoding does not match', async () => {
    transcript('something-else', id, ['{}'])
    assert.equal(findTranscript(b('D:\\x\\y')), join(configDir, 'projects', 'something-else', `${id}.jsonl`))
  })

  test('a session id with path characters is never looked up', async () => {
    assert.equal(await claudeAdapter.sessionExists(b('D:\\x', '..\\..\\settings')), false)
  })

  test('title: the last custom-title line wins; none → undefined', async () => {
    transcript('D--x', id, [
      '{"type":"custom-title","customTitle":"primeiro","sessionId":"' + id + '"}',
      '{"type":"user","message":{"content":"custom-title"}}',
      '{"type":"custom-title","customTitle":"título final ✓","sessionId":"' + id + '"}',
      '{"type":"assistant","message":{"content":"ok"}}',
    ])
    assert.equal(await claudeAdapter.title(b('D:\\x')), 'título final ✓')
    transcript('D--y', 'ffffffff-0000-4000-8000-000000000000', ['{"type":"user"}', '{"type":"assistant"}'])
    assert.equal(await claudeAdapter.title(b('D:\\y', 'ffffffff-0000-4000-8000-000000000000')), undefined)
    assert.equal(await claudeAdapter.title(b('D:\\nowhere', 'eeeeeeee-0000-4000-8000-000000000000')), undefined)
  })

  test('title: found far from the tail of a multi-MB transcript with multi-byte text crossing chunk boundaries', async () => {
    const title = 'acentuação — ✓ 日本語'
    const filler = '{"type":"assistant","message":{"content":"' + 'çãé'.repeat(1000) + '"}}'
    const lines = [
      '{"type":"custom-title","customTitle":"velho"}',
      '{"type":"custom-title","customTitle":"' + title + '"}',
      ...Array.from({ length: 700 }, () => filler), // ~3.4 MB after the title line
    ]
    const file = transcript('D--big', id, lines)
    assert.ok(statSync(file).size > 3 * 1024 * 1024)
    assert.equal(lastCustomTitle(file), title)
    assert.equal(await claudeAdapter.title(b('D:\\big')), title)
  })

  test('title: a broken last line (interrupted write) is skipped', () => {
    const file = transcript('D--broken', id, [
      '{"type":"custom-title","customTitle":"ok"}',
      '{"type":"custom-title","customTitle":"trunc',
    ])
    assert.equal(lastCustomTitle(file), 'ok')
  })

  test('title: CRLF transcripts', () => {
    const dir = join(configDir, 'projects', 'D--crlf')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, '{"type":"custom-title","customTitle":"crlf"}\r\n{"type":"user"}\r\n')
    assert.equal(lastCustomTitle(file), 'crlf')
  })

  test('watchTitle: fires on each change of the last custom-title, tolerates a transcript that appears later, stops on demand', async () => {
    const seen: string[] = []
    const stop = claudeAdapter.watchTitle!(b('D:\\late'), (t) => seen.push(t), 30)
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(seen, []) // no transcript yet, no error
    const file = transcript('D--late', id, ['{"type":"user"}', '{"type":"custom-title","customTitle":"um"}'])
    await waitFor(() => seen.length === 1)
    assert.deepEqual(seen, ['um'])
    appendFileSync(file, '{"type":"assistant"}\n') // size changed, title did not: no new call
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(seen, ['um'])
    appendFileSync(file, '{"type":"custom-title","customTitle":"dois"}\n')
    await waitFor(() => seen.length === 2)
    assert.deepEqual(seen, ['um', 'dois'])
    stop()
    appendFileSync(file, '{"type":"custom-title","customTitle":"três"}\n')
    await new Promise((r) => setTimeout(r, 150))
    assert.deepEqual(seen, ['um', 'dois'])
  })

  test('watchTitleWith: caches the transcript path, throttles the full scan to 60 s, re-resolves when the file vanishes', async () => {
    let reads = 0
    let clock = 1_000_000
    const seen: string[] = []
    const readdirSpy = async (d: string): Promise<string[]> => { reads++; return readdirP(d) }
    const stop = watchTitleWith(b('D:\nowhere'), (t) => seen.push(t), 15, undefined, { now: () => clock, readdir: readdirSpy })
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(reads, 1) // first miss scans once; later misses within 60 s only check the direct path
    clock += 61_000
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(reads, 2) // 60 s later: one more scan
    const file = transcript('elsewhere', id, ['{"type":"custom-title","customTitle":"a"}'])
    clock += 61_000
    await waitFor(() => seen.length === 1)
    assert.deepEqual(seen, ['a'])
    const afterFound = reads
    appendFileSync(file, '{"type":"custom-title","customTitle":"b"}\n')
    await waitFor(() => seen.length === 2)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(reads, afterFound) // cached path: stat only, no readdir
    rmSync(file)
    await new Promise((r) => setTimeout(r, 80)) // vanished: cache dropped, resolves again (throttled)
    const moved = transcript('moved', id, ['{"type":"custom-title","customTitle":"c"}'])
    clock += 61_000
    await waitFor(() => seen.length === 3)
    assert.deepEqual(seen, ['a', 'b', 'c'])
    assert.ok(moved)
    stop()
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('resolveClaudeCommand', () => {
  const launchd = '/opt/homebrew/Cellar/node/25.9.0_1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  const fake = (...present: string[]) => (p: string) => present.includes(p)

  test('PATH hit returns the absolute path found there', () => {
    const r = resolveClaudeCommand({ PATH: '/x/bin:/y/bin' }, { platform: 'darwin', home: '/h', exists: fake('/y/bin/claude'), loginShell: () => assert.fail('no shell') })
    assert.equal(r, '/y/bin/claude')
  })

  test('launchd PATH without ~/.local/bin still finds the native install', () => {
    const r = resolveClaudeCommand({ PATH: launchd }, { platform: 'darwin', home: '/Users/u', exists: fake('/Users/u/.local/bin/claude'), loginShell: () => assert.fail('no shell') })
    assert.equal(r, '/Users/u/.local/bin/claude')
  })

  test('falls back to the login shell, then to the bare name', () => {
    const env = { PATH: launchd, SHELL: '/bin/zsh' }
    assert.equal(resolveClaudeCommand(env, { platform: 'darwin', home: '/h', exists: fake(), loginShell: () => '/z/claude' }), '/z/claude')
    assert.equal(resolveClaudeCommand(env, { platform: 'darwin', home: '/h', exists: fake(), loginShell: () => undefined }), 'claude')
  })

  test('Windows keeps searching PATH only, never the unix dirs', () => {
    const env = { PATH: 'C:\\a;C:\\b' }
    assert.equal(resolveClaudeCommand(env, { platform: 'win32', home: 'C:\\h', exists: (p) => p.endsWith('claude.cmd') && p.includes('b'), loginShell: () => assert.fail('no shell') }).endsWith('claude.cmd'), true)
    assert.equal(resolveClaudeCommand(env, { platform: 'win32', home: '/h', exists: fake('/h/.local/bin/claude'), loginShell: () => assert.fail('no shell') }), 'claude')
  })

  test('withCommandDirOnPath prepends the binary dir without dropping entries', () => {
    const env = { PATH: '/usr/bin:/bin' }
    withCommandDirOnPath(env, '/h/.local/bin/claude', 'darwin')
    assert.equal(env.PATH, '/h/.local/bin:/usr/bin:/bin')
    withCommandDirOnPath(env, '/h/.local/bin/claude', 'darwin')
    assert.equal(env.PATH, '/h/.local/bin:/usr/bin:/bin')
    withCommandDirOnPath(env, 'claude', 'darwin')
    assert.equal(env.PATH, '/h/.local/bin:/usr/bin:/bin')
  })
})

describe('status line', () => {
  const STATUSLINE = resolve(import.meta.dirname, '../../src/report/claude-statusline.mjs')
  const saved = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  test('injected settings run the status line script by absolute forward-slash path', () => {
    const settings = hookSettings('C:\\x\\hook.mjs', 'C:\\x\\claude-statusline.mjs') as { statusLine?: { type: string; command: string } }
    assert.deepEqual(settings.statusLine, { type: 'command', command: 'node "C:/x/claude-statusline.mjs"' })
    assert.equal('statusLine' in (hookSettings('C:\\x\\hook.mjs', null) as object), false)
  })

  test('PermissionRequest hook: present by default and when on, absent when off', () => {
    const hooks = (o: object) => (o as { hooks: Record<string, unknown> }).hooks
    assert.deepEqual(hooks(hookSettings('C:/x/hook.mjs', null)).PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: 'node "C:/x/hook.mjs" PermissionRequest' }] }])
    assert.ok(hooks(hookSettings('C:/x/hook.mjs', null, true)).PermissionRequest)
    assert.equal('PermissionRequest' in hooks(hookSettings('C:/x/hook.mjs', null, false)), false)
  })

  test('the settings file of a launch follows denyPermissionPrompts', async () => {
    process.env.CLAUDE_CONFIG_DIR = configs.make()
    const read = async (denyPermissionPrompts?: boolean) => {
      const home = homes.make()
      const plan = await claudeAdapter.plan({ slot: { ...slot, cwd: configs.make() }, home, extraArgs: [], ...(denyPermissionPrompts === undefined ? {} : { denyPermissionPrompts }) })
      return JSON.parse(readFileSync(plan.args[1]!, 'utf8')).hooks as Record<string, unknown>
    }
    assert.ok((await read()).PermissionRequest)
    assert.ok((await read(true)).PermissionRequest)
    assert.equal('PermissionRequest' in (await read(false)), false)
  })

  test('the hook script answers deny with the message on PermissionRequest', () => {
    const home = homes.make()
    const r = spawnSync(process.execPath, [HOOK, 'PermissionRequest'], {
      input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' }, agent_id: 'a1', agent_type: 'general-purpose' }),
      env: { ...process.env, TETHER_HOME: home, TETHER_SLOT_ID: 'slot-1' },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny')
    assert.equal('interrupt' in out.hookSpecificOutput.decision, false)
    assert.match(out.hookSpecificOutput.decision.message, /^Recusado pelo tether no lugar da pessoa: este pedido de permissão ficaria esperando alguém responder\. Não reescreva o mesmo comando de outro jeito\./)
    assert.match(readFileSync(join(home, 'tether.log'), 'utf8'), /denied permission prompt: tool=Bash agent=general-purpose\/a1 "rm -rf \/tmp\/x"/)
  })

  test('the default settings file points at the real script', async () => {
    const home = homes.make()
    process.env.CLAUDE_CONFIG_DIR = configs.make()
    const plan = await claudeAdapter.plan({ slot: { ...slot, cwd: configs.make() }, home, extraArgs: [] })
    assert.equal(plan.args[1], join(home, 'claude-settings.json'))
    const settings = JSON.parse(readFileSync(plan.args[1]!, 'utf8')) as { statusLine: { command: string } }
    assert.equal(settings.statusLine.command, `node "${STATUSLINE.replace(/\\/g, '/')}"`)
  })

  test('a statusLine of the user (user, project or local settings) never replaces ours: one settings file, always with our status line', async () => {
    for (const where of ['user', 'settings.json', 'settings.local.json']) {
      const config = configs.make()
      const cwd = configs.make()
      if (where === 'user') writeFileSync(join(config, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }))
      else {
        mkdirSync(join(cwd, '.claude'), { recursive: true })
        writeFileSync(join(cwd, '.claude', where), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }))
      }
      process.env.CLAUDE_CONFIG_DIR = config
      const home = homes.make()
      const plan = await claudeAdapter.plan({ slot: { ...slot, cwd }, home, extraArgs: [] })
      assert.equal(plan.args[1], join(home, 'claude-settings.json'), where)
      const settings = JSON.parse(readFileSync(plan.args[1]!, 'utf8')) as { hooks: object; statusLine?: unknown }
      assert.ok(settings.statusLine, where)
      assert.ok('SessionStart' in settings.hooks, where)
    }
  })

  test('launch no longer consults the user status line through the executor', async () => {
    const ops: string[] = []
    const real = agentExecutor()
    const exec = { ...real, run: ((op: string, args: never) => { ops.push(op); return real.run(op as never, args) }) as typeof real.run }
    const home = homes.make()
    await claudeAdapter.plan({ slot: { ...slot, cwd: configs.make() }, home, extraArgs: [], exec } as never)
    assert.ok(!ops.includes('hasStatusLine'))
  })
})
