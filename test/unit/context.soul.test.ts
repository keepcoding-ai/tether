// The soul context provider against a real-shaped slot events fixture (the `kind:"context"` line the soul client writes
// per finished turn; content synthetic): the incremental reader, session switches, malformed lines, and the board's
// snapshot through ContextService (no soul, no Electron).
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SoulEventsReader } from '../../src/context/soul.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { ContextService } from '../../extensions/context/service.ts'
import { soulProvider } from '../../extensions/context/providers.ts'
import { measuredInventory, sectionSigs } from '../../extensions/context/rules.ts'

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'soul', 'slot.events.jsonl')
const line = (o: object): string => JSON.stringify({ v: 1, slotId: 's1', agent: 'soul', cwd: '/proj', ...o }) + '\n'
const ctxLine = (sessionId: string, total: number): string =>
  line({
    ts: '2026-11-16T16:00:00.000Z', kind: 'context', source: 'turn', sessionId,
    context: { model: 'm', totalTokens: total, maxTokens: 100000, percentage: total / 1000, categories: [{ name: 'Messages', tokens: total }], memoryFiles: [], skills: [], agents: [], mcpTools: [], apiUsage: null },
  })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-soul-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SoulEventsReader', () => {
  test('only the current session counts; malformed lines skipped; turns from apiUsage; latest context kept', () => {
    const r = new SoulEventsReader(FIXTURE)
    // Three context lines were applied; the old session's one was dropped by the next `start`.
    assert.equal(r.poll(), 3)
    assert.equal(r.sessionId(), 'sess-a')
    assert.deepEqual(r.turns().map(t => [t.ctxTokens, t.input, t.cacheRead, t.cacheCreate, t.output]), [[20000, 5, 15995, 4000, 400], [24000, 10, 20000, 3990, 300]])
    assert.deepEqual(r.totals(), { turns: 2, input: 15, cacheRead: 35995, cacheCreate: 7990, output: 700 })
    const c = r.context()!
    assert.equal(c.totalTokens, 24000)
    assert.equal(c.credits, 42)
    assert.equal(c.at, Date.parse('2026-11-16T15:03:00.000Z'))
  })

  test('incremental: never rereads consumed bytes; a partial line waits for its newline', () => {
    const p = join(dir, 'e.jsonl')
    copyFileSync(FIXTURE, p)
    const r = new SoulEventsReader(p)
    r.poll()
    assert.equal(r.offset, readFileSync(p).length)
    const before = r.bytesRead
    assert.equal(r.poll(), 0)
    assert.equal(r.bytesRead, before)
    const next = ctxLine('sess-a', 30000)
    appendFileSync(p, next.slice(0, 20))
    assert.equal(r.poll(), 0)
    appendFileSync(p, next.slice(20))
    assert.equal(r.poll(), 1)
    assert.equal(r.bytesRead - before, 20 + Buffer.byteLength(next))
    assert.equal(r.last()?.ctxTokens, 30000)
    assert.equal(r.totals().turns, 3)
  })

  test('a start of another session resets; a start of the same session (resume) keeps; foreign context lines ignored', () => {
    const p = join(dir, 'e.jsonl')
    copyFileSync(FIXTURE, p)
    const r = new SoulEventsReader(p)
    r.poll()
    appendFileSync(p, line({ ts: '2026-11-16T16:00:00.000Z', kind: 'start', source: 'resume', sessionId: 'sess-a' }))
    r.poll()
    assert.equal(r.totals().turns, 2)
    appendFileSync(p, line({ ts: '2026-11-16T16:00:00.000Z', kind: 'start', source: 'clear', sessionId: 'sess-b' }) + ctxLine('sess-a', 7) + ctxLine('sess-b', 500))
    assert.equal(r.poll(), 1)
    assert.equal(r.sessionId(), 'sess-b')
    assert.deepEqual(r.turns().map(t => t.ctxTokens), [500])
    assert.equal(r.last()?.id, 'sess-b:1')
    assert.equal(r.context()?.totalTokens, 500)
  })

  test('an open-source context line fills the context but is not a turn; a turn line after it counts', () => {
    const p = join(dir, 'e.jsonl')
    const open = line({
      ts: '2026-11-16T16:00:00.000Z', kind: 'context', source: 'open', sessionId: 'sess-o',
      context: { model: 'm', totalTokens: 4000, maxTokens: 100000, percentage: 4, categories: [{ name: 'Messages', tokens: 4000 }], memoryFiles: [], skills: [], agents: [], mcpTools: [] },
    })
    writeFileSync(p, line({ ts: '2026-11-16T15:59:00.000Z', kind: 'start', source: 'resume', sessionId: 'sess-o' }) + open)
    const r = new SoulEventsReader(p)
    r.poll()
    assert.equal(r.context()?.totalTokens, 4000)
    assert.equal(r.totals().turns, 0)
    assert.deepEqual(r.turns(), [])
    appendFileSync(p, ctxLine('sess-o', 5000))
    assert.equal(r.poll(), 1)
    assert.equal(r.totals().turns, 1)
    assert.equal(r.turns().length, 1)
    assert.equal(r.context()?.totalTokens, 5000)
  })

  test('a truncated file is read again from the start', () => {
    const p = join(dir, 'e.jsonl')
    copyFileSync(FIXTURE, p)
    const r = new SoulEventsReader(p)
    r.poll()
    writeFileSync(p, line({ ts: 'x', kind: 'start', source: 's', sessionId: 'z' }) + ctxLine('z', 9))
    assert.equal(r.poll(), 1)
    assert.deepEqual(r.turns().map(t => t.ctxTokens), [9])
  })
})

describe('the board for a soul pane', () => {
  test('snapshot: header from the last turn (credits, no cost), measured composition, empty disk inventory; no Medir', async () => {
    const home = join(dir, 'home')
    const events = slotEventsPath(home, 's1')
    mkdirSync(dirname(events), { recursive: true })
    copyFileSync(FIXTURE, events)
    const cwd = join(dir, 'proj')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'CLAUDE.md'), 'a'.repeat(400))
    const svc = new ContextService({ home, agentKind: id => (id === 's1' ? 'soul' : undefined), schedule: () => () => {} })
    const r = await svc.snapshot({ slotId: 's1', cwd })
    assert.ok(r.supported)
    assert.equal(r.agent, 'soul')
    assert.equal(r.canMeasure, false)
    assert.equal(r.live?.model, 'claude-test')
    assert.equal(r.live?.effort, '')
    assert.equal(r.live?.usedPct, 12)
    assert.equal(r.live?.windowSize, 200000)
    assert.equal(r.live?.usedTokens, 24000)
    assert.equal(r.live?.costUsd, undefined)
    assert.equal(r.live?.credits, 42)
    assert.ok(r.transcript && r.transcript !== 'same')
    assert.deepEqual(r.transcript.turns.map(t => t[1]), [20000, 24000])
    assert.ok(r.inventory && r.inventory !== 'same')
    assert.equal(r.inventory.memory.length, 0)
    assert.deepEqual(r.measured?.categories.map(c => [c.name, c.tokens]), [['System prompt', 3000], ['Messages', 6900], ['Free space', 176000]])
    assert.equal(r.measured?.maxTokens, 200000)

    appendFileSync(events, ctxLine('sess-a', 30000))
    const again = await svc.snapshot({ slotId: 's1', cwd, rev: r.transcript.rev, invKey: r.inventory.key })
    assert.ok(again.supported && again.transcript !== 'same' && again.inventory === 'same')
    assert.notEqual(sectionSigs(again, { inventoryKey: r.inventory.key, transcriptRev: '' }).compose, sectionSigs(r, { inventoryKey: '', transcriptRev: '' }).compose)
    const m = await svc.measure({ slotId: 's1', cwd })
    assert.ok(m.supported && !m.ok)
    svc.dispose()
  })

  test('deferred categories weigh nothing; measured lists become the fixed weight view', () => {
    // The first turn of sess-a carries the full lists.
    const f = join(dir, 'first.jsonl')
    writeFileSync(f, readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 4).join('\n') + '\n')
    const r = new SoulEventsReader(f)
    r.poll()
    const s = soulProvider({ home: dir }).session('s1')
    const mv = s.measured!(r)!
    assert.deepEqual(mv.categories.find(c => c.name.startsWith('MCP tools')), { name: 'MCP tools (adiado)', tokens: 0, percent: undefined, approx: false })
    const inv = measuredInventory(mv)
    assert.deepEqual(inv.memory, [{ path: '/proj/CLAUDE.md', kind: 'Project', tokens: 1500 }])
    assert.deepEqual(inv.skills, [{ name: 'git-commit', scope: 'user', promptTokens: 600, bodyTokens: 0 }])
    assert.deepEqual(inv.agents.map(a => a.name), ['Cast'])
    assert.deepEqual(inv.mcpServers, [{ name: 'tether-browser', transport: '' }])
    assert.equal(s.live(undefined), undefined)
  })
})
