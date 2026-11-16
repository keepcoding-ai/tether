// The Codex context provider against a real-shaped rollout fixture (shapes copied from a Codex 0.169 rollout, content
// synthetic): the rollout reader, locating a rollout by session id, the AGENTS.md/skills/MCP inventory, and the board's
// snapshot through ContextService (no Codex, no Electron).
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRolloutReader, codexMcpServers, findCodexRollout, readCodexInventory } from '../../src/context/codex.ts'
import { cacheHitRatio } from '../../src/context/live.ts'
import { ContextService } from '../../extensions/context/service.ts'
import { codexProvider } from '../../extensions/context/providers.ts'

const SID = '01a1e585-0521-77f0-bf39-0dacc71fd48d'
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'codex', `rollout-2026-11-16T15-01-02-${SID}.jsonl`)

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-codex-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function codexHomeWithRollout(day = join('2026', '11', '16')): { home: string; rollout: string } {
  const home = join(dir, 'codex-home')
  mkdirSync(join(home, 'sessions', day), { recursive: true })
  const rollout = join(home, 'sessions', day, `rollout-2026-11-16T15-01-02-${SID}.jsonl`)
  copyFileSync(FIXTURE, rollout)
  return { home, rollout }
}

describe('CodexRolloutReader', () => {
  test('model, effort, window, last usage, one turn per request (repeated token_count ignored), totals', () => {
    const r = new CodexRolloutReader(FIXTURE)
    assert.equal(r.poll(), 2)
    const info = r.info()
    assert.equal(info.sessionId, SID)
    assert.equal(info.cwd, 'C:\\proj')
    assert.equal(info.cliVersion, '0.169.0')
    assert.equal(info.model, 'gpt-test')
    assert.equal(info.effort, 'high')
    assert.equal(info.windowSize, 258400)
    assert.equal(info.usedTokens, 25500)
    assert.equal(info.rateLimitPct, 5)
    const turns = r.turns()
    assert.deepEqual(turns.map(t => t.ctxTokens), [21170, 25000])
    assert.equal(turns[1]!.cacheRead, 21000)
    assert.equal(turns[1]!.input, 4000)
    assert.equal(cacheHitRatio(r.last()!), 21000 / 25000)
    assert.deepEqual(r.totals(), { turns: 2, input: 46170 - 33544, cacheRead: 33544, cacheCreate: 0, output: 510 })
  })

  test('reads only appended bytes', () => {
    const p = join(dir, 'r.jsonl')
    copyFileSync(FIXTURE, p)
    const r = new CodexRolloutReader(p)
    r.poll()
    const before = r.bytesRead
    assert.equal(r.poll(), 0)
    assert.equal(r.bytesRead, before)
    const extra = JSON.stringify({ timestamp: '2026-11-16T18:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 76170, cached_input_tokens: 33544, output_tokens: 610, total_tokens: 76780 },
      last_token_usage: { input_tokens: 30000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 30100 }, model_context_window: 258400 } } }) + '\n'
    appendFileSync(p, extra)
    assert.equal(r.poll(), 1)
    assert.equal(r.bytesRead - before, Buffer.byteLength(extra))
    assert.equal(r.turns().length, 3)
    assert.equal(r.info().usedTokens, 30100)
  })
})

describe('findCodexRollout', () => {
  test('finds the rollout by the uuid suffix, in the day the v7 id points at or by walking the folders', () => {
    const a = codexHomeWithRollout()
    assert.equal(findCodexRollout(SID, a.home), a.rollout)
    rmSync(a.home, { recursive: true, force: true })
    const b = codexHomeWithRollout(join('2025', '01', '02'))
    assert.equal(findCodexRollout(SID, b.home), b.rollout)
    assert.equal(findCodexRollout('not-a-uuid', b.home), undefined)
    assert.equal(findCodexRollout('01a1e585-0521-77f0-bf39-000000000000', b.home), undefined)
  })
})

describe('Codex inventory', () => {
  test('config.toml MCP: names and transport only, sub-tables are not servers', () => {
    const toml = [
      '[mcp_servers.node_repl]', 'command = "x.exe"', 'env_vars = ["A"]', '[mcp_servers.node_repl.env]', 'API_KEY = "s3cret"',
      '[mcp_servers."docs-http"]', 'url = "https://example.test/mcp"', '[plugins."p@x"]', 'enabled = true',
    ].join('\n')
    assert.deepEqual(codexMcpServers(toml), [{ name: 'node_repl', transport: 'stdio' }, { name: 'docs-http', transport: 'http' }])
  })

  test('global AGENTS.md + project chain from the git root (override wins per folder), skills, MCP; no secret leaves', async () => {
    const ch = join(dir, 'codex-home')
    const repo = join(dir, 'repo')
    const sub = join(repo, 'pkg')
    mkdirSync(join(ch, 'skills', 'alpha'), { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.agents', 'skills', 'beta'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'outside the repo: not in the chain')
    writeFileSync(join(ch, 'AGENTS.md'), 'g'.repeat(400))
    writeFileSync(join(repo, 'AGENTS.md'), 'r'.repeat(800))
    writeFileSync(join(sub, 'AGENTS.md'), 'ignored: override wins')
    writeFileSync(join(sub, 'AGENTS.override.md'), 'o'.repeat(40))
    writeFileSync(join(ch, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: does alpha\n---\nbody body body')
    writeFileSync(join(repo, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: b\n---\nx')
    writeFileSync(join(ch, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "x"\n[mcp_servers.node_repl.env]\nTOKEN = "s3cret-value"\n')
    writeFileSync(join(ch, 'auth.json'), '{"never":"read"}')
    const inv = await readCodexInventory(sub, { codexHome: ch, home: join(dir, 'nohome') })
    assert.deepEqual(inv.memory.map(m => [m.path, m.kind, m.tokens]), [
      [join(ch, 'AGENTS.md'), 'user', 100], [join(repo, 'AGENTS.md'), 'project', 200], [join(sub, 'AGENTS.override.md'), 'local', 10],
    ])
    assert.deepEqual(inv.skills.map(s => [s.name, s.scope]).sort(), [['alpha', 'user'], ['beta', 'project']])
    assert.deepEqual(inv.mcpServers, [{ name: 'node_repl', transport: 'stdio', source: 'codex-config' }])
    assert.ok(!JSON.stringify(inv).includes('s3cret'))
    assert.ok(!inv.files.some(f => /auth\.json$/.test(f.path)))
  })
})

describe('the board for a Codex pane', () => {
  test('snapshot: header from the rollout (no cost), curve per request, cache of the last turn, AGENTS.md list; no Medir', async () => {
    const { home } = codexHomeWithRollout()
    const cwd = join(dir, 'proj')
    mkdirSync(join(cwd, '.git'), { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), 'a'.repeat(120))
    const svc = new ContextService({
      home: dir,
      agentKind: id => (id === 'c1' ? 'codex' : undefined),
      providers: { codex: codexProvider({ home: dir, codexHome: home, sessionOf: id => (id === 'c1' ? SID : undefined) }) },
      schedule: () => () => {},
    })
    const r = await svc.snapshot({ slotId: 'c1', cwd })
    assert.ok(r.supported)
    assert.equal(r.agent, 'codex')
    assert.equal(r.canMeasure, false)
    assert.equal(r.live?.model, 'gpt-test')
    assert.equal(r.live?.effort, 'high')
    assert.equal(r.live?.windowSize, 258400)
    assert.equal(r.live?.usedTokens, 25500)
    assert.ok(Math.abs((r.live?.usedPct ?? 0) - (25500 / 258400) * 100) < 1e-9)
    assert.equal(r.live?.costUsd, undefined)
    assert.ok(r.transcript && r.transcript !== 'same')
    assert.deepEqual(r.transcript.turns.map(t => t[1]), [21170, 25000])
    assert.equal(r.transcript.cacheHit, 21000 / 25000)
    assert.ok(r.inventory && r.inventory !== 'same')
    assert.deepEqual(r.inventory.memory.map(m => [m.path, m.tokens]), [[join(cwd, 'AGENTS.md'), 30]])
    const again = await svc.snapshot({ slotId: 'c1', cwd, rev: r.transcript.rev, invKey: r.inventory.key })
    assert.ok(again.supported && again.transcript === 'same' && again.inventory === 'same')
    const m = await svc.measure({ slotId: 'c1', cwd })
    assert.ok(m.supported && !m.ok)
    svc.dispose()
  })

  test('the session comes from the slot\'s last start event by default', async () => {
    const { home } = codexHomeWithRollout()
    mkdirSync(join(dir, 'slots'))
    const ev = (sessionId: string): string => JSON.stringify({ v: 1, ts: '2026-11-16T18:00:00.000Z', slotId: 'c1', agent: 'codex', kind: 'start', source: 'startup', sessionId }) + '\n'
    writeFileSync(join(dir, 'slots', 'c1.jsonl'), ev('00000000-0000-7000-8000-000000000000') + ev(SID))
    const p = codexProvider({ home: dir, codexHome: home })
    const s = p.session('c1')
    assert.ok(s.path?.endsWith(`${SID}.jsonl`), readFileSync(join(dir, 'slots', 'c1.jsonl'), 'utf8'))
    assert.equal(p.session('nope').path, undefined)
  })
})
