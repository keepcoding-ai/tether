// Live context data: statusline persistence and the incremental transcript reader.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cacheHitRatio, detectContextJumps, readLiveSummary, TranscriptUsageReader } from '../../src/context/live.ts'

const SCRIPT = resolve(import.meta.dirname, '../../src/report/claude-statusline.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'tether-live-'))

const payload = {
  session_id: 's1', transcript_path: 'C:\\x\\s1.jsonl', version: '2.1.0', cwd: 'D:\\p', extra: 'dropme',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  context_window: {
    context_window_size: 200000, used_percentage: 12.5, remaining_percentage: 87.5,
    total_input_tokens: 5000, total_output_tokens: 900,
    current_usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
  },
  exceeds_200k_tokens: false,
  cost: { total_cost_usd: 0.42, total_duration_ms: 1000, total_api_duration_ms: 800 },
  effort: { level: 'high' },
}

function run(home: string, input: unknown, slot: string | null = 'slot-1') {
  const env: NodeJS.ProcessEnv = { ...process.env, TETHER_HOME: home }
  delete env.TETHER_SLOT_ID
  if (slot) env.TETHER_SLOT_ID = slot
  return spawnSync(process.execPath, [SCRIPT], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env })
}

describe('statusline persistence', () => {
  test('writes the validated summary and keeps stdout unchanged', () => {
    const home = tmp()
    try {
      const r = run(home, payload)
      assert.equal(r.status, 0)
      assert.match(r.stdout, /Opus 5\.5/)
      const s = readLiveSummary(home, 'slot-1')!
      assert.equal(s.session_id, 's1')
      assert.equal(s.context_window?.used_percentage, 12.5)
      assert.equal(s.context_window?.current_usage?.cache_read_input_tokens, 4)
      assert.equal(s.cost?.total_cost_usd, 0.42)
      assert.equal(s.effort?.level, 'high')
      assert.equal((s as any).extra, undefined)
      assert.equal((s as any).cwd, undefined)
      assert.ok(Date.parse(s.at!) > 0)
      assert.deepEqual(readdirSync(join(home, 'context')), ['slot-1.json'])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('null fields at session start are dropped without error', () => {
    const home = tmp()
    try {
      const r = run(home, { session_id: 's', model: { id: 'm', display_name: null }, context_window: { context_window_size: 200000, used_percentage: null, current_usage: null }, cost: null, rate_limits: null })
      assert.equal(r.status, 0)
      const s = readLiveSummary(home, 'slot-1')!
      assert.deepEqual(s.model, { id: 'm' })
      assert.deepEqual(s.context_window, { context_window_size: 200000 })
      assert.equal(s.cost, undefined)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('does not rewrite when the summary is unchanged, rewrites when it changes', () => {
    const home = tmp()
    try {
      run(home, payload)
      const file = join(home, 'context', 'slot-1.json')
      const old = new Date(Date.now() - 60_000)
      utimesSync(file, old, old)
      const at = readLiveSummary(home, 'slot-1')!.at
      run(home, payload)
      assert.equal(statSync(file).mtimeMs, old.getTime())
      assert.equal(readLiveSummary(home, 'slot-1')!.at, at)
      run(home, { ...payload, cost: { total_cost_usd: 0.5 } })
      assert.equal(readLiveSummary(home, 'slot-1')!.cost?.total_cost_usd, 0.5)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('no TETHER_SLOT_ID: nothing is written; bad stdin is harmless', () => {
    const home = tmp()
    try {
      assert.equal(run(home, payload, null).status, 0)
      assert.equal(run(home, '{oops', null).status, 0)
      assert.throws(() => readdirSync(join(home, 'context')))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('readLiveSummary: absent or corrupt gives undefined', () => {
    const home = tmp()
    try {
      assert.equal(readLiveSummary(home, 'nope'), undefined)
      run(home, payload)
      writeFileSync(join(home, 'context', 'slot-1.json'), '{broken')
      assert.equal(readLiveSummary(home, 'slot-1'), undefined)
      assert.equal(readLiveSummary(home, '../x'), undefined)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

const asst = (id: string, ctx: { i?: number; cc?: number; cr?: number; o?: number }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant', uuid: `u-${id}`, timestamp: '2026-11-15T10:00:00.000Z', isSidechain: false,
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: ctx.i ?? 0, cache_creation_input_tokens: ctx.cc ?? 0, cache_read_input_tokens: ctx.cr ?? 0, output_tokens: ctx.o ?? 0 } },
    ...extra,
  }) + '\n'

describe('TranscriptUsageReader', () => {
  test('extracts turns, totals, ignores non-assistant and invalid lines', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\nnot json "usage"\n' + asst('m1', { i: 10, cc: 100, cr: 900, o: 5 }) + asst('m2', { i: 1, cr: 1200, o: 7 }, { isSidechain: true }))
      const r = new TranscriptUsageReader(f)
      assert.equal(r.poll(), 2)
      assert.equal(r.turns().length, 2)
      assert.equal(r.turns()[0]!.ctxTokens, 1010)
      assert.equal(r.turns()[0]!.ts, Date.parse('2026-11-15T10:00:00.000Z'))
      assert.equal(r.last()!.sidechain, true)
      assert.deepEqual(r.totals(), { turns: 2, input: 11, cacheRead: 2100, cacheCreate: 100, output: 12 })
      assert.equal(cacheHitRatio(r.turns()[0]!), 900 / 1010)
      assert.equal(cacheHitRatio({ ctxTokens: 0, cacheRead: 0 }), 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('partial trailing line waits for the next poll', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      const line = asst('m1', { i: 1, o: 2 })
      writeFileSync(f, asst('m0', { i: 1 }) + line.slice(0, 40))
      const r = new TranscriptUsageReader(f)
      assert.equal(r.poll(), 1)
      assert.equal(r.turns().length, 1)
      appendFileSync(f, line.slice(40))
      assert.equal(r.poll(), 1)
      assert.equal(r.turns().length, 2)
      assert.equal(r.last()!.id, 'm1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('multi-byte characters split across polls do not corrupt lines', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      const buf = Buffer.from(asst('m1', { i: 3 }, { note: 'ação—é✓'.repeat(5) }))
      const cut = buf.indexOf('✓') + 1 // mid-character
      writeFileSync(f, buf.subarray(0, cut))
      const r = new TranscriptUsageReader(f)
      assert.equal(r.poll(), 0)
      appendFileSync(f, buf.subarray(cut))
      assert.equal(r.poll(), 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('truncation restarts from zero', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      writeFileSync(f, asst('a', { i: 1 }) + asst('b', { i: 2 }) + asst('c', { i: 3 }))
      const r = new TranscriptUsageReader(f)
      r.poll()
      writeFileSync(f, asst('z', { i: 9 }))
      assert.equal(r.poll(), 1)
      assert.deepEqual(r.turns().map((t) => t.id), ['z'])
      assert.equal(r.totals().turns, 1)
      assert.equal(r.totals().input, 9)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('same message id across lines is deduped; the final usage wins', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      writeFileSync(f, asst('m1', { i: 5, o: 1 }) + asst('m1', { i: 5, o: 40 }))
      const r = new TranscriptUsageReader(f)
      r.poll()
      appendFileSync(f, asst('m1', { i: 5, o: 80 }))
      r.poll()
      assert.equal(r.turns().length, 1)
      assert.equal(r.last()!.output, 80)
      assert.deepEqual(r.totals(), { turns: 1, input: 5, cacheRead: 0, cacheCreate: 0, output: 80 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('ring is bounded', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      let s = ''
      for (let i = 0; i < 50; i++) s += asst(`m${i}`, { i: i + 1 })
      writeFileSync(f, s)
      const r = new TranscriptUsageReader(f, { maxTurns: 10 })
      r.poll()
      assert.equal(r.turns().length, 10)
      assert.equal(r.turns()[0]!.id, 'm40')
      assert.equal(r.totals().turns, 50)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('large file: second poll reads only the delta; missing file is harmless', () => {
    const dir = tmp(); const f = join(dir, 't.jsonl')
    try {
      const r = new TranscriptUsageReader(f)
      assert.equal(r.poll(), 0)
      const lines: string[] = []
      for (let i = 0; i < 50_000; i++) lines.push(asst(`m${i}`, { i: 1, cc: 10, cr: 1000 + i, o: 3 }, { pad: 'x'.repeat(100) }))
      writeFileSync(f, lines.join(''))
      const size = statSync(f).size
      assert.equal(r.poll(), 50_000)
      assert.equal(r.bytesRead, size)
      assert.equal(r.turns().length, 500)
      assert.equal(r.totals().turns, 50_000)
      const extra = asst('new', { i: 1, cr: 5 })
      appendFileSync(f, extra)
      assert.equal(r.poll(), 1)
      assert.equal(r.bytesRead, size + Buffer.byteLength(extra))
      assert.equal(r.poll(), 0)
      assert.equal(r.bytesRead, size + Buffer.byteLength(extra))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('detectContextJumps', () => {
  const t = (id: string, ctx: number, sidechain = false) => ({ id, ts: 0, ctxTokens: ctx, input: ctx, cacheRead: 0, cacheCreate: 0, output: 0, model: '', sidechain })
  test('returns the biggest growth steps, per lane, largest first', () => {
    const turns = [t('a', 1000), t('b', 30_000), t('s1', 500, true), t('c', 31_000), t('d', 90_000), t('s2', 50_000, true), t('e', 20_000)]
    const j = detectContextJumps(turns, { minDelta: 10_000, top: 2 })
    assert.deepEqual(j.map((x) => [x.turn.id, x.delta]), [['d', 59_000], ['s2', 49_500]])
    assert.deepEqual(detectContextJumps(turns).map((x) => x.turn.id), ['d', 's2', 'b'])
  })
})
