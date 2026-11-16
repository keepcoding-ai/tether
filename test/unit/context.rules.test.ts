// Pure rules of extensions/context/rules.ts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compositionSegments, curveGeometry, diffSections, fmtPct, fmtTokens, inventoryForWire, mcpByServer, nextSort, nextTarget, readersToDrop,
  sameTarget, sectionSigs, sortRows, topConsumers, usageLevel,
} from '../../extensions/context/rules.ts'
import type { InventoryView, SnapshotReply, TurnRow } from '../../extensions/context/ipc.ts'

const inv = (over: Partial<InventoryView> = {}): InventoryView => ({ key: 'k1', memory: [], skills: [], agents: [], commands: 0, mcpServers: [], hooks: [], plugins: 0, ...over })

describe('formatting', () => {
  test('tokens', () => {
    assert.equal(fmtTokens(950), '950')
    assert.equal(fmtTokens(12_345), '12,3k')
    assert.equal(fmtTokens(1_250_000), '1,3M')
    assert.equal(fmtTokens(Number.NaN), '–')
  })
  test('percent', () => {
    assert.equal(fmtPct(0.34), '0,3%')
    assert.equal(fmtPct(42.4), '42%')
  })
})

describe('usage colour point', () => {
  test('thresholds at 80 and 90', () => {
    assert.equal(usageLevel(undefined), 'ok')
    assert.equal(usageLevel(79.9), 'ok')
    assert.equal(usageLevel(80), 'warn')
    assert.equal(usageLevel(89.9), 'warn')
    assert.equal(usageLevel(90), 'crit')
  })
})

describe('ordering', () => {
  const rows = [{ name: 'b', n: 5 }, { name: 'a', n: 5 }, { name: 'c', n: 9 }]
  const get = (r: { name: string; n: number }, k: string): number | string => (k === 'n' ? r.n : r.name)
  test('numbers desc with name tiebreak, and flipping', () => {
    assert.deepEqual(sortRows(rows, { key: 'n', dir: 'desc' }, get).map(r => r.name), ['c', 'a', 'b'])
    assert.deepEqual(sortRows(rows, { key: 'n', dir: 'asc' }, get).map(r => r.name), ['a', 'b', 'c'])
    assert.deepEqual(sortRows(rows, { key: 'name', dir: 'asc' }, get).map(r => r.name), ['a', 'b', 'c'])
  })
  test('the input is not mutated', () => {
    const before = rows.map(r => r.name).join()
    sortRows(rows, { key: 'n', dir: 'desc' }, get)
    assert.equal(rows.map(r => r.name).join(), before)
  })
  test('header click: new column biggest first, same column flips', () => {
    assert.deepEqual(nextSort({ key: 'prompt', dir: 'desc' }, 'body'), { key: 'body', dir: 'desc' })
    assert.deepEqual(nextSort({ key: 'prompt', dir: 'desc' }, 'prompt'), { key: 'prompt', dir: 'asc' })
    assert.deepEqual(nextSort({ key: 'prompt', dir: 'desc' }, 'name'), { key: 'name', dir: 'asc' })
  })
  test('top consumers use the prompt weight, never the invoked body, and fold in measured MCP', () => {
    const top = topConsumers(inv({
      memory: [{ path: 'C:\\x\\CLAUDE.md', kind: 'project', tokens: 300 }],
      skills: [{ name: 'big', scope: 'user', promptTokens: 40, bodyTokens: 9000 }],
      agents: [{ name: 'ag', scope: 'user', promptTokens: 120, bodyTokens: 1 }],
    }), 3, new Map([['srv', 500]]))
    assert.deepEqual(top.map(c => c.label), ['srv', 'CLAUDE.md', 'ag'])
  })
  test('mcp tokens per server', () => {
    const m = mcpByServer([{ name: 'mcp__a__x', source: '', tokens: 10 }, { name: 'mcp__a__y', source: 'a', tokens: 5 }, { name: 't', source: 'b', tokens: 1 }])
    assert.equal(m.get('a'), 15)
    assert.equal(m.get('b'), 1)
  })
})

describe('composition', () => {
  test('shares of the window, free and buffer told apart, zeros dropped', () => {
    const segs = compositionSegments([
      { name: 'Messages', tokens: 100, percent: 10, approx: false },
      { name: 'Free space', tokens: 800, percent: 80, approx: false },
      { name: 'Autocompact buffer', tokens: 100, percent: 10, approx: false },
      { name: 'Skills', tokens: 0, percent: 0, approx: false },
    ], 1000)
    assert.deepEqual(segs.map(s => [s.name, s.kind, s.pct]), [['Messages', 'used', 10], ['Free space', 'free', 80], ['Autocompact buffer', 'buffer', 10]])
  })
  test('without a window the sum is the whole', () => {
    const segs = compositionSegments([{ name: 'A', tokens: 1, percent: undefined, approx: true }, { name: 'B', tokens: 3, percent: undefined, approx: true }], undefined)
    assert.deepEqual(segs.map(s => s.pct), [25, 75])
  })
})

describe('curve', () => {
  const t = (ctx: number, side = 0): TurnRow => [0, ctx, 0, 0, 0, 0, side]
  test('main lane only in the line; marks and hover index', () => {
    const turns = [t(10), t(20, 1), t(40)]
    const g = curveGeometry(turns, [{ index: 2, delta: 20 }, { index: 9, delta: 1 }], 100, 50)
    assert.equal(g.line.split(' ').length, 2)
    assert.equal(g.marks.length, 1)
    assert.equal(g.max, 40)
    assert.equal(g.indexAt(-5), 0)
    assert.equal(g.indexAt(500), 2)
  })
  test('a single turn does not divide by zero', () => {
    const g = curveGeometry([t(5)], [], 100, 50)
    assert.ok(!g.line.includes('NaN'))
    assert.equal(g.indexAt(10), 0)
  })
})

describe('snapshot diff', () => {
  const reply = (over: Partial<Extract<SnapshotReply, { supported: true }>> = {}): Extract<SnapshotReply, { supported: true }> => ({
    supported: true, agent: 'claude', canMeasure: true,
    live: { model: 'M', modelId: 'm', effort: 'high', usedPct: 10, windowSize: 1000, usedTokens: 100, costUsd: 1, exceeds200k: false, sessionId: 's', at: 1 },
    transcript: { rev: 'r1', turns: [], jumps: [], firstTurn: 1, totals: { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }, cacheHit: 0.5, cold: false },
    inventory: inv(),
    ...over,
  })
  const held = { inventoryKey: 'k1', transcriptRev: 'r1' }
  test('first snapshot paints everything', () => {
    assert.deepEqual(diffSections(undefined, sectionSigs(reply(), held)), ['head', 'compose', 'fixed', 'curve'])
  })
  test('an identical snapshot, even with "same" payloads, repaints nothing', () => {
    const a = sectionSigs(reply(), held)
    const b = sectionSigs(reply({ transcript: 'same', inventory: 'same', live: { ...reply().live!, at: 99 } }), held)
    assert.deepEqual(diffSections(a, b), [])
  })
  test('only the changed sections', () => {
    const a = sectionSigs(reply(), held)
    assert.deepEqual(diffSections(a, sectionSigs(reply({ live: { ...reply().live!, usedPct: 11 } }), held)), ['head'])
    assert.deepEqual(diffSections(a, sectionSigs(reply({ inventory: inv({ key: 'k2' }) }), held)), ['compose', 'fixed'])
    const t2 = { ...(reply().transcript as object), rev: 'r2' } as never
    assert.deepEqual(diffSections(a, sectionSigs(reply({ transcript: t2 }), held)), ['head', 'curve'])
  })
})

describe('reader pool policy', () => {
  test('drops idle ones past the ttl, keeps the requested one', () => {
    const e = [{ key: 'a', lastUsed: 0 }, { key: 'b', lastUsed: 50_000 }, { key: 'c', lastUsed: 100 }]
    assert.deepEqual(readersToDrop(e, 61_000, { ttl: 60_000, keep: 'c' }).sort(), ['a'])
    assert.deepEqual(readersToDrop(e, 61_000, { ttl: 60_000 }).sort(), ['a', 'c'])
  })
  test('LRU beyond the maximum, never the kept one', () => {
    const e = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, lastUsed: 1000 + i }))
    assert.deepEqual(readersToDrop(e, 1010, { ttl: 60_000, max: 3 }).sort(), ['k0', 'k1'])
    assert.deepEqual(readersToDrop(e, 1010, { ttl: 60_000, max: 3, keep: 'k0' }).sort(), ['k1', 'k2'])
  })
})

describe('inventory on the wire', () => {
  test('omitted when the held key equals the current one', () => {
    const cur = inv({ key: 'abc' })
    assert.equal(inventoryForWire('abc', cur), 'same')
    assert.equal(inventoryForWire('old', cur), cur)
    assert.equal(inventoryForWire(undefined, cur), cur)
  })
})

describe('which panel the pad follows', () => {
  const claude = { id: 's1', type: 'terminal', cwd: 'C:\\p', agent: 'claude' }
  test('claude pane becomes the target; notes keep it; shell and other agents say unsupported', () => {
    const t1 = nextTarget(undefined, claude)
    assert.deepEqual(t1, { kind: 'agent', slotId: 's1', cwd: 'C:\\p', agent: 'claude' })
    assert.deepEqual(nextTarget(t1, { id: 'c2', type: 'terminal', cwd: 'C:\\q', agent: 'codex' }), { kind: 'agent', slotId: 'c2', cwd: 'C:\\q', agent: 'codex' })
    assert.equal(nextTarget(t1, { id: 'n', type: 'note' }), t1)
    assert.equal(nextTarget(t1, undefined), t1)
    assert.deepEqual(nextTarget(t1, { id: 'x', type: 'terminal' }), { kind: 'unsupported', why: 'shell' })
    assert.deepEqual(nextTarget(t1, { id: 'x', type: 'terminal', agent: 'gemini' }), { kind: 'unsupported', why: 'agent', agent: 'gemini' })
  })
  test('sameTarget', () => {
    assert.ok(sameTarget(nextTarget(undefined, claude), nextTarget(undefined, claude)))
    assert.ok(!sameTarget(nextTarget(undefined, claude), undefined))
  })
})
