// extensions/context/service.ts against a synthetic statusline file and transcript (no Claude, no Electron).
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextService } from '../../extensions/context/service.ts'
import type { Inventory } from '../../src/context/inventory.ts'
import type { MeasureInput, MeasureResult } from '../../src/context/measure.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-svc-')); mkdirSync(join(dir, 'context')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const line = (id: string, input: number, cacheRead: number, cacheCreate = 0): string => JSON.stringify({
  type: 'assistant', uuid: id, timestamp: '2026-01-01T10:00:00Z', message: { id, model: 'claude-x', usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 5 } },
}) + '\n'

const emptyInv = (cwd: string): Inventory => ({
  cwd, claudeVersion: '1', memory: [{ path: join(cwd, 'CLAUDE.md'), bytes: 40, mtimeMs: 1, kind: 'project', tokens: 10, estimated: true }], skills: [], agents: [], commands: [],
  mcpServers: [], hooks: [], statusLine: undefined, plugins: [], files: [],
})

function setup(opts: { kind?: string; now?: () => number } = {}) {
  const transcript = join(dir, 't.jsonl')
  writeFileSync(transcript, line('a', 10, 0, 1000) + line('b', 20, 1000))
  writeFileSync(join(dir, 'context', 's1.json'), JSON.stringify({
    transcript_path: transcript, model: { id: 'claude-x', display_name: 'Claude X' }, effort: { level: 'high' },
    context_window: { context_window_size: 1000, used_percentage: 12.5, current_usage: { input_tokens: 20, cache_read_input_tokens: 1000 } },
    cost: { total_cost_usd: 0.5 }, secret_field: 'must-not-leak', at: '2026-01-01T10:00:00Z',
  }))
  const measured: MeasureInput[] = []
  let invReads = 0
  const sweeps: (() => void)[] = []
  const svc = new ContextService({
    home: dir,
    agentKind: id => (id === 's1' ? (opts.kind ?? 'claude') : undefined),
    ...(opts.now ? { now: opts.now } : {}),
    readInventory: async cwd => { invReads++; return emptyInv(cwd) },
    meter: { measure: async (i): Promise<MeasureResult> => { measured.push(i); return { ok: false, reason: 'failed', message: 'não deu' } } },
    schedule: fn => { sweeps.push(fn); return () => { sweeps.length = 0 } },
  })
  return { svc, transcript, measured, reads: () => invReads, sweeps }
}

describe('ContextService', () => {
  test('snapshot: live summary, turns and totals, inventory; nothing the statusline had besides the numbers', async () => {
    const { svc } = setup()
    const r = await svc.snapshot({ slotId: 's1', cwd: dir })
    assert.ok(r.supported)
    assert.equal(r.live?.model, 'Claude X')
    assert.equal(r.live?.usedTokens, 1020)
    assert.equal(r.live?.costUsd, 0.5)
    assert.ok(r.transcript && r.transcript !== 'same')
    assert.equal(r.transcript.turns.length, 2)
    assert.equal(r.transcript.totals.turns, 2)
    assert.equal(r.transcript.cold, false)
    assert.ok(Math.abs((r.transcript.cacheHit ?? 0) - 1000 / 1020) < 1e-9)
    assert.ok(r.inventory && r.inventory !== 'same')
    assert.ok(!JSON.stringify(r).includes('must-not-leak'))
    svc.dispose()
  })

  test('unchanged content is answered "same" and an appended turn is picked up incrementally', async () => {
    const { svc, transcript } = setup()
    const first = await svc.snapshot({ slotId: 's1', cwd: dir })
    assert.ok(first.supported && first.transcript && first.transcript !== 'same' && first.inventory && first.inventory !== 'same')
    const req = { slotId: 's1', cwd: dir, rev: first.transcript.rev, invKey: first.inventory.key }
    const again = await svc.snapshot(req)
    assert.ok(again.supported)
    assert.equal(again.transcript, 'same')
    assert.equal(again.inventory, 'same')
    appendFileSync(transcript, line('c', 5, 0, 30000))
    const after = await svc.snapshot(req)
    assert.ok(after.supported && after.transcript && after.transcript !== 'same')
    assert.equal(after.transcript.turns.length, 3)
    assert.equal(after.transcript.cold, true)
    assert.equal(after.transcript.jumps[0]?.index, 2)
    svc.dispose()
  })

  test('the inventory is not rescanned on every call', async () => {
    let t = 1_000_000
    const { svc, reads } = setup({ now: () => t })
    await svc.snapshot({ slotId: 's1', cwd: dir })
    await svc.snapshot({ slotId: 's1', cwd: dir })
    t += 1000
    await svc.snapshot({ slotId: 's1', cwd: dir })
    assert.equal(reads(), 1)
    svc.dispose()
  })

  test('turns sent are capped', async () => {
    const { svc, transcript } = setup()
    let big = ''
    for (let i = 0; i < 260; i++) big += line(`m${i}`, 1, 0)
    appendFileSync(transcript, big)
    const r = await svc.snapshot({ slotId: 's1', cwd: dir })
    assert.ok(r.supported && r.transcript && r.transcript !== 'same')
    assert.equal(r.transcript.turns.length, 200)
    assert.equal(r.transcript.firstTurn, 63)
    svc.dispose()
  })

  test('readers idle for 60 s are dropped on the next sweep, and the sweep timer stops with them', async () => {
    let t = 1_000_000
    const { svc, sweeps } = setup({ now: () => t })
    await svc.snapshot({ slotId: 's1', cwd: dir })
    assert.equal(svc.readerCount, 1)
    assert.equal(sweeps.length, 1)
    t += 61_000
    sweeps[0]!()
    assert.equal(svc.readerCount, 0)
    assert.equal(sweeps.length, 0)
    svc.dispose()
  })

  test('not Claude, unknown slot, bad folder: unsupported, no work', async () => {
    const other = setup({ kind: 'gemini' })
    assert.deepEqual(await other.svc.snapshot({ slotId: 's1', cwd: dir }), { supported: false, reason: 'not-claude' })
    assert.equal(other.svc.readerCount, 0)
    const c = setup()
    assert.deepEqual(await c.svc.snapshot({ slotId: 'nope', cwd: dir }), { supported: false, reason: 'unknown-slot' })
    assert.deepEqual(await c.svc.snapshot({ slotId: 's1', cwd: 'relative' }), { supported: false, reason: 'unknown-slot' })
    assert.deepEqual(await c.svc.snapshot({ slotId: 's1', cwd: join(dir, 'missing') }), { supported: false, reason: 'unknown-slot' })
  })

  test('measure passes the session model and folder, and reports a failure in the person\'s words', async () => {
    const { svc, measured } = setup()
    const r = await svc.measure({ slotId: 's1', cwd: dir, force: true })
    assert.deepEqual(r, { supported: true, ok: false, message: 'não deu' })
    assert.equal(measured[0]?.model, 'claude-x')
    assert.equal(measured[0]?.cwd, dir)
    assert.equal(measured[0]?.force, true)
    svc.dispose()
  })
})
