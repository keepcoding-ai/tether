// The Codex agent (extensions/codex, src/agents/codex.ts, src/report/codex-hook.mjs): launch plan, rollout lookup by
// UUIDv7 day, titles from session_index.jsonl, notify parsing and chaining, MCP as `-c` overrides, skills as
// developer_instructions, and the notify reporter writing the start event and the attention report.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
// The doctor first: it reaches the daemon index (and this extension) through the agent loader, as in every real host.
import '../../src/doctor.ts'
import { codexAgent } from '../../extensions/codex/daemon.ts'
import { codexAdapter, codexSkills, findRollout, indexTitle, mcpServerOverrides, parseTopLevelNotify, uuidV7Time, withCodexMcpOverrides } from '../../src/agents/codex.ts'
import { resolveCodexCommand } from '../../src/exec/ops-agents.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { McpNameCollisionError, httpMcpConfigOf } from '../../src/agents/mcp.ts'
import type { SlotMeta } from '../../src/core/event.ts'
// @ts-expect-error plain JS module without declarations
import { attentionOf, startEventOf } from '../../src/report/codex-hook.mjs'

const reporter = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src', 'report', 'codex-hook.mjs')
const ID = '01a1e5a8-c6b2-7d90-b956-90f082e0eba4'

let dir: string
before(() => { dir = mkdtempSync(join(tmpdir(), 'tether-codex-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })

const slot = (cwd: string): SlotMeta => ({ v: 1, slotId: 's1', agent: 'codex', cwd, args: ['-m', 'x'], createdAt: '2026-11-16T00:00:00Z' })

describe('codex launch plan', () => {
  test('new session: notify override, slot args, TETHER_* env, no CLAUDE* vars', async () => {
    process.env.CLAUDECODE_TEST_VAR = '1'
    try {
      const codexHome = join(dir, 'ch-plan')
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, 'config.toml'), 'notify = [ "C:\\\\x\\\\y.exe", \'turn-ended\' ]\n\n[tui]\nnotify = ["no"]\n')
      const p = await codexAdapter.plan({ slot: slot(dir), home: join(dir, 'th'), extraArgs: ['--foo'], profile: { args: ['--p'], env: { CODEX_HOME: codexHome } } })
      const i = p.args.indexOf('-c')
      assert.match(p.args[i + 1]!, /^notify=\["node",".*codex-hook\.mjs","notify"\]$/)
      assert.deepEqual(p.args.slice(i + 2), ['--p', '-m', 'x', '--foo'])
      assert.ok(!p.args.includes('resume'))
      assert.equal(p.env.TETHER_SLOT_ID, 's1')
      assert.equal(p.env.TETHER_AGENT, 'codex')
      assert.equal(p.env.TETHER_CODEX_NOTIFY, JSON.stringify(['C:\\x\\y.exe', 'turn-ended']))
      assert.equal(p.env.CLAUDECODE_TEST_VAR, undefined)
    } finally {
      delete process.env.CLAUDECODE_TEST_VAR
    }
  })

  test('resume: `resume <id>` first', async () => {
    const p = await codexAdapter.plan({ slot: slot(dir), home: dir, extraArgs: [], resume: { slotId: 's1', agent: 'codex', sessionId: ID, cwd: dir, since: '', confirmed: true, ended: false } })
    const at = p.args.indexOf('resume')
    assert.deepEqual(p.args.slice(at, at + 3), ['resume', ID, '-c'])
  })

  test('windows: the npm shim runs as node + codex.js (no cmd.exe in between)', () => {
    const bin = 'C:\\n'
    const files = new Set([join(bin, 'codex.cmd'), join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(bin, 'node.exe')])
    const r = resolveCodexCommand({ PATH: `C:\\a;${bin}` }, { platform: 'win32', exists: (p) => files.has(p) })
    assert.deepEqual(r, { command: join(bin, 'node.exe'), prefix: [join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] })
  })
})

describe('reading codex files', () => {
  test('notify parsing: top-level only, both string kinds, multi-line; none when absent', () => {
    assert.deepEqual(parseTopLevelNotify('a = 1\nnotify = [\n  "a\\"b", # c\n  \'d\\e\',\n]\n'), ['a"b', 'd\\e'])
    assert.equal(parseTopLevelNotify('[x]\nnotify = ["a"]\n'), undefined)
    assert.equal(parseTopLevelNotify(''), undefined)
  })

  test('uuidV7Time reads the ms timestamp; other versions give undefined', () => {
    assert.equal(new Date(uuidV7Time(ID)!).toISOString(), '2026-11-16T18:40:05.810Z')
    assert.equal(uuidV7Time('6f1c2a5e-1111-4222-8333-444455556666'), undefined)
  })

  test('rollout found in its day folder, and by a full scan for a non-v7 id; sessionExists and title', async () => {
    const ch = join(dir, 'ch-files')
    const t = new Date(uuidV7Time(ID)!)
    const day = join(ch, 'sessions', String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'))
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-x-${ID}.jsonl`), '{}\n')
    const v4 = '6f1c2a5e-1111-4222-8333-444455556666'
    mkdirSync(join(ch, 'sessions', '2025', '01', '02'), { recursive: true })
    writeFileSync(join(ch, 'sessions', '2025', '01', '02', `rollout-y-${v4}.jsonl`), '{}\n')
    const opts = { env: { CODEX_HOME: ch } }
    assert.ok(findRollout(ID, opts))
    assert.ok(findRollout(v4, opts))
    assert.equal(findRollout('../x', opts), undefined)
    const b = { slotId: 's', agent: 'codex', sessionId: ID, cwd: dir, since: '', confirmed: true, ended: false }
    assert.equal(await codexAdapter.sessionExists(b, opts), true)
    assert.equal(await codexAdapter.sessionExists({ ...b, sessionId: '01a1e5a8-c6b2-7d90-b956-000000000000' }, opts), false)
    const index = join(ch, 'session_index.jsonl')
    writeFileSync(index, `{"id":"${ID}","thread_name":"Primeiro","updated_at":"x"}\n{"id":"other","thread_name":"Z"}\n{"id":"${ID}","thread_name":"Renomeado","updated_at":"y"}\n{"id":"other","thread_name":"W"}\n`)
    assert.equal(indexTitle(index, ID), 'Renomeado')
    assert.equal(await codexAdapter.title(b, opts), 'Renomeado')
    const seen: string[] = []
    const stop = codexAdapter.watchTitle!(b, (x) => seen.push(x), 10, opts)
    appendFileSync(index, `{"id":"${ID}","thread_name":"Terceiro"}\n`)
    await new Promise((r) => setTimeout(r, 80))
    stop()
    assert.deepEqual(seen, ['Renomeado', 'Terceiro'])
  })
})

describe('codex MCP and skills', () => {
  test('an HTTP server of httpMcpConfigOf becomes url + bearer_token_env_var', () => {
    const s = httpMcpConfigOf('tether-bridge', 'http://localhost:1/mcp', 'TETHER_KEY').mcpServers['tether-bridge']!
    assert.deepEqual(mcpServerOverrides('tether-bridge', s), ['mcp_servers.tether-bridge.url="http://localhost:1/mcp"', 'mcp_servers.tether-bridge.bearer_token_env_var="TETHER_KEY"'])
  })

  test('stdio server: command, args, env; odd names quoted', () => {
    assert.deepEqual(mcpServerOverrides('a b', { command: 'node', args: ['x.js'], env: { K: 'v' } }), ['mcp_servers."a b".command="node"', 'mcp_servers."a b".args=["x.js"]', 'mcp_servers."a b".env={K="v"}'])
  })

  test('inject appends -c pairs and refuses a name another file took', () => {
    const files: Record<string, string> = { a: JSON.stringify({ mcpServers: { one: { command: 'x' } } }), b: JSON.stringify({ mcpServers: { one: { command: 'y' } } }) }
    const base = { command: 'c', args: ['z'], cwd: dir, env: {} }
    const p = withCodexMcpOverrides(base, 'a', undefined, (f) => files[f]!)
    assert.deepEqual(p.args, ['z', '-c', 'mcp_servers.one.command="x"'])
    assert.deepEqual(base.args, ['z'])
    assert.throws(() => withCodexMcpOverrides(p, 'b', undefined, (f) => files[f]!), McpNameCollisionError)
  })

  test('skills go in developer_instructions as one TOML string', async () => {
    const p = await codexSkills.inject({ command: 'c', args: [], cwd: dir, env: {} }, { home: dir, version: 'v', exec: createExecutor({ mode: 'inline' }), skills: [{ name: 'use-todo', description: 'd "q"', dir, text: '---\nname: use-todo\n---\nfaça\n' }] })
    assert.equal(p.args[0], '-c')
    const [key, ...rest] = p.args[1]!.split('=')
    assert.equal(key, 'developer_instructions')
    const text = JSON.parse(rest.join('=')) as string
    assert.match(text, /<skill name="use-todo">\nfaça\n<\/skill>/)
    assert.ok(!p.args[1]!.includes('\n'), 'no raw newline on the command line')
  })

  test('contribution: name, http MCP, no channel, dev profile', () => {
    assert.equal(codexAgent.name, 'codex')
    assert.equal(codexAgent.mcp?.http, true)
    assert.equal(codexAgent.channel, undefined)
    assert.deepEqual(codexAgent.defaultProfiles({}, 'linux').map((p) => [p.id, p.args]), [['codex', []], ['codex-dev', ['--dangerously-bypass-approvals-and-sandbox']]])
  })
})

describe('codex notify reporter', () => {
  test('mappers', () => {
    assert.equal(attentionOf({ type: 'agent-turn-complete' }), 'done')
    assert.equal(attentionOf({ type: 'approval-requested' }), 'waiting')
    assert.equal(attentionOf({ type: 'other' }), undefined)
    assert.equal(startEventOf({ 'thread-id': ID }, 's', 't', ID), undefined)
    assert.deepEqual(startEventOf({ 'thread-id': ID, cwd: 'C:\\w' }, 's', 't', undefined)?.resume, { cwd: 'C:\\w', args: ['resume', ID] })
  })

  test('real run: one start event per session, attention every turn, the user notify chained', () => {
    const home = join(dir, 'th-run')
    const chained = join(dir, 'chained.txt')
    const chainScript = join(dir, 'chain.mjs')
    writeFileSync(chainScript, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(chained)}, process.argv[2] + '\\n')`)
    const env = { ...process.env, TETHER_HOME: home, TETHER_SLOT_ID: 's9', TETHER_CODEX_NOTIFY: JSON.stringify([process.execPath, chainScript, 'extra']) }
    const fire = (payload: object): void => { assert.equal(spawnSync(process.execPath, [reporter, 'notify', JSON.stringify(payload)], { env }).status, 0) }
    fire({ type: 'agent-turn-complete', 'thread-id': ID, cwd: dir })
    fire({ type: 'agent-turn-complete', 'thread-id': ID, cwd: dir })
    const events = readFileSync(join(home, 'slots', 's9.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; agent: string; sessionId: string })
    assert.deepEqual(events.map((e) => [e.kind, e.agent, e.sessionId]), [['start', 'codex', ID]])
    assert.equal(JSON.parse(readFileSync(join(home, 'slots', 's9.attention'), 'utf8')).kind, 'done')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (!existsSync(chained) || readFileSync(chained, 'utf8').trim().split('\n').length < 2)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'])
    assert.ok(readFileSync(chained, 'utf8').includes('extra'), 'chained notify got its own args first')
  })
})
