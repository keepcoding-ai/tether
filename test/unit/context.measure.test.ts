import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseContextReport, parseTokenCount } from '../../src/context/context-report.ts'
import { ContextMeter, runClaudeContext, type ContextRunner } from '../../src/context/measure.ts'
import type { Inventory } from '../../src/context/inventory.ts'

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/context-report.md', import.meta.url)), 'utf8')

const inv = (n: number): Inventory => ({
  cwd: '/x', claudeVersion: '1', memory: [], skills: [], agents: [], commands: [], mcpServers: [], hooks: [],
  statusLine: undefined, plugins: [], files: [{ path: `/x/${n}`, bytes: n, mtimeMs: 1 }],
})
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('token counts', () => {
  assert.deepEqual(parseTokenCount('2.7k'), { tokens: 2700, approx: false })
  assert.deepEqual(parseTokenCount('1m'), { tokens: 1_000_000, approx: false })
  assert.deepEqual(parseTokenCount('~170'), { tokens: 170, approx: true })
  assert.deepEqual(parseTokenCount('< 20'), { tokens: 20, approx: true })
  assert.deepEqual(parseTokenCount('10k'), { tokens: 10_000, approx: false })
  assert.equal(parseTokenCount('abc'), undefined)
})

test('parser reads the fixture', () => {
  const r = parseContextReport(FIXTURE)
  assert.equal(r.model, 'claude-haiku-5-5')
  assert.equal(r.totalTokens, 21_200)
  assert.equal(r.maxTokens, 1_000_000)
  assert.equal(r.percent, 2)
  const sp = r.categories.find((c) => c.name === 'System prompt')!
  assert.deepEqual([sp.tokens, sp.percent], [2700, 0.3])
  assert.equal(r.categories.find((c) => c.name === 'Free space')!.tokens, 978_800)
  assert.ok(r.categories.some((c) => c.name === 'Brand new row'))
  assert.equal(r.categories.length, 13)
  assert.deepEqual(r.mcpTools.map((t) => [t.name, t.source, t.tokens, t.approx]), [['mcp__docs__search', 'docs', 1200, false], ['mcp__docs__read', 'docs', 170, true]])
  assert.deepEqual(r.agents.map((t) => [t.name, t.source, t.tokens, t.approx]), [['reviewer', 'Project', 450, false], ['general-purpose', 'Built-in', 20, true]])
  assert.equal(r.memoryFiles[1]!.path, 'D:\\proj\\CLAUDE.md')
  assert.equal(r.memoryFiles[1]!.source, 'Project')
  assert.equal(r.memoryFiles[1]!.tokens, 2200)
  assert.deepEqual(r.skills.map((t) => t.tokens), [170, 20, 10_000])
  assert.equal(r.unknownSections.length, 1)
  assert.equal(r.unknownSections[0]!.title, 'Something New')
  assert.deepEqual(r.unknownSections[0]!.rows, [['a', 'b']])
})

test('parser tolerates missing sections, garbage and empty input', () => {
  const r = parseContextReport('## Context Usage\n**Model:** m\n### Estimated usage by category\n| Category | Tokens |\n|--|--|\n| A | 5 |\n| B | nope |\n')
  assert.equal(r.model, 'm')
  assert.deepEqual(r.categories.map((c) => [c.name, c.tokens, c.percent]), [['A', 5, undefined]])
  assert.deepEqual([r.skills, r.agents, r.mcpTools, r.memoryFiles], [[], [], [], []])
  assert.equal(parseContextReport('').categories.length, 0)
  assert.equal(parseContextReport('### Skills\n| Foo |\n|--|\n| x |').unknownSections.length, 1)
})

const REPORT = '## Context Usage\n**Model:** m\n**Tokens:** 1k / 1m (0%)\n### Estimated usage by category\n| Category | Tokens | Percentage |\n|-|-|-|\n| System prompt | 2.7k | 0.3% |\n'

test('meter: cache hit, shared across slots, model splits the cache', async () => {
  let calls = 0
  const runner: ContextRunner = async () => { calls++; return { ok: true, stdout: REPORT } }
  const m = new ContextMeter({ runner, inventory: async () => inv(1) })
  const a = await m.measure({ cwd: '/x', model: 'haiku', slotKey: 's1' })
  const b = await m.measure({ cwd: '/x', model: 'haiku', slotKey: 's2' })
  assert.ok(a.ok && !a.fromCache)
  assert.ok(b.ok && b.fromCache)
  assert.equal(calls, 1)
  await m.measure({ cwd: '/x', model: 'opus' })
  assert.equal(calls, 2)
})

test('meter: coalesces simultaneous calls and runs one at a time', async () => {
  let active = 0, peak = 0, calls = 0
  const runner: ContextRunner = async () => { calls++; active++; peak = Math.max(peak, active); await delay(30); active--; return { ok: true, stdout: REPORT } }
  const same = new ContextMeter({ runner, inventory: async () => inv(7) })
  await Promise.all([1, 2, 3].map(() => same.measure({ cwd: '/x', model: 'h' })))
  assert.equal(calls, 1)
  calls = 0
  const cwdKey: Record<string, number> = { '/a': 1, '/b': 2, '/c': 3 }
  const many = new ContextMeter({ runner, inventory: async (cwd) => inv(cwdKey[cwd] ?? 0) })
  await Promise.all(['/a', '/b', '/c'].map((cwd) => many.measure({ cwd, model: 'h' })))
  assert.equal(calls, 3)
  assert.equal(peak, 1)
})

test('meter: LRU bound evicts the oldest', async () => {
  let calls = 0
  let n = 0
  const runner: ContextRunner = async () => { calls++; return { ok: true, stdout: REPORT } }
  const m = new ContextMeter({ runner, inventory: async () => inv(n), maxEntries: 2 })
  for (n = 1; n <= 3; n++) await m.measure({ cwd: '/x', model: 'h' })
  n = 1
  await m.measure({ cwd: '/x', model: 'h' }) // evicted -> runs again
  assert.equal(calls, 4)
})

test('meter: typed failures, never throws, failures are not cached', async () => {
  const mk = (runner: ContextRunner) => new ContextMeter({ runner, inventory: async () => inv(1) })
  const t = await mk(async () => ({ ok: false, reason: 'timeout' })).measure({ cwd: '/x', model: 'h' })
  assert.ok(!t.ok && t.reason === 'timeout' && t.message.length > 0)
  const thrown = await mk(async () => { throw new Error('boom /secret/path') }).measure({ cwd: '/x', model: 'h' })
  assert.ok(!thrown.ok && thrown.reason === 'failed' && !thrown.message.includes('boom'))
  const bad = await mk(async () => ({ ok: true, stdout: 'garbage' })).measure({ cwd: '/x', model: 'h' })
  assert.ok(!bad.ok && bad.reason === 'unparseable')
  let calls = 0
  const m = mk(async () => (calls++ === 0 ? { ok: false, reason: 'failed' } : { ok: true, stdout: REPORT }))
  assert.equal((await m.measure({ cwd: '/x', model: 'h' })).ok, false)
  assert.equal((await m.measure({ cwd: '/x', model: 'h' })).ok, true)
})

test('real runner: a tiny timeout kills the child and reports timeout', async () => {
  const r = await runClaudeContext({ cwd: process.cwd(), model: 'haiku', timeoutMs: 1 })
  assert.ok(!r.ok && (r.reason === 'timeout' || r.reason === 'not-found'))
})

test('smoke: real /context with haiku', { skip: process.env.TETHER_REAL_CLAUDE !== '1', timeout: 90_000 }, async () => {
  const r = await new ContextMeter().measure({ cwd: process.cwd(), model: 'haiku' })
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.ok && r.report.categories.some((c) => c.name === 'System prompt'))
  console.log('smoke:', JSON.stringify(r.ok && { model: r.report.model, total: r.report.totalTokens, max: r.report.maxTokens, cats: r.report.categories.length, ms: r.durationMs }))
})
