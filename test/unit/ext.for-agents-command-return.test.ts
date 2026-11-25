// The return watch of agents_command: how a typed command is seen to stop, with a fake clock and fake pane sources.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  RETURN_LIMIT_MS, RETURN_POLL_MS, RETURN_QUIET_MS, ReturnWatch, returnBody,
  type ReturnClock, type ReturnResult, type ReturnSources,
} from '../../extensions/for-agents/daemon/verbs/command-return.ts'

const T0 = 1_000_000

function fakeClock() {
  let now = T0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: ReturnClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (h) => { timers.delete(h as number) },
  }
  const flush = () => new Promise<void>((r) => setImmediate(r))
  async function advance(ms: number): Promise<void> {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
      await flush(); await flush()
    }
    now = end
  }
  return { clock, advance, pending: () => timers.size, setNow: (v: number) => { now = v } }
}

type Pane = {
  turn: 'busy' | 'idle' | undefined
  idleSince?: string
  paintedAt: number | undefined
  userTypedAt?: number
  state: string
  since: { text: string; reset: boolean }
  all: string
  detects: number
}

function pane(over: Partial<Pane> = {}): { p: Pane; sources: ReturnSources } {
  const p: Pane = { turn: 'idle', paintedAt: 0, state: 'unknown', since: { text: 'saida nova', reset: false }, all: 'tela inteira', detects: 0, ...over }
  const sources: ReturnSources = {
    turn: () => p.turn,
    idleSince: () => p.idleSince,
    paintedAt: () => p.paintedAt,
    userTypedAt: () => p.userTypedAt,
    detect: async () => { p.detects++; return { state: p.state } },
    readSince: async () => p.since,
    readAll: async () => p.all,
  }
  return { p, sources }
}

function start(sources: ReturnSources, clock: ReturnClock) {
  const w = new ReturnWatch(sources, { typedAt: T0, mark: 42, self: false }, clock)
  let result: ReturnResult | undefined | null = null
  void w.run().then((r) => { result = r })
  return { w, get: () => result }
}

describe('ReturnWatch', () => {
  test('command without a turn ends done with the text since the mark', async () => {
    const c = fakeClock(); const { sources } = pane({ paintedAt: T0 + 200 })
    const s = start(sources, c.clock)
    await c.advance(RETURN_QUIET_MS)
    assert.equal(s.get(), null)
    await c.advance(RETURN_POLL_MS)
    assert.deepEqual(s.get(), { outcome: 'done', text: 'saida nova', elapsedMs: 3_500 })
    assert.equal(c.pending(), 0)
  })

  test('a busy turn seen in a poll ends turn without text', async () => {
    const c = fakeClock(); const { p, sources } = pane()
    const s = start(sources, c.clock)
    p.turn = 'busy'
    await c.advance(RETURN_POLL_MS)
    assert.deepEqual(s.get(), { outcome: 'turn', elapsedMs: RETURN_POLL_MS })
  })

  test('a short turn seen only by idleSince ends turn', async () => {
    const c = fakeClock(); const { p, sources } = pane()
    const s = start(sources, c.clock)
    p.idleSince = new Date(T0 + 300).toISOString()
    await c.advance(RETURN_POLL_MS)
    assert.equal(s.get()?.outcome, 'turn')
  })

  test('an idleSince older than the typing is not a turn', async () => {
    const c = fakeClock(); const { sources } = pane({ idleSince: new Date(T0 - 5_000).toISOString() })
    const s = start(sources, c.clock)
    await c.advance(RETURN_QUIET_MS)
    assert.equal(s.get()?.outcome, 'done')
  })

  test('/compact painting for 7 s with the turn idle does not end before the screen is quiet', async () => {
    const c = fakeClock(); const { p, sources } = pane()
    const s = start(sources, c.clock)
    for (let t = 0; t < 7_000; t += RETURN_POLL_MS) { p.paintedAt = c.clock.now(); await c.advance(RETURN_POLL_MS) }
    p.paintedAt = c.clock.now()
    assert.equal(s.get(), null)
    assert.equal(p.detects, 0)
    await c.advance(RETURN_QUIET_MS - RETURN_POLL_MS)
    assert.equal(s.get(), null)
    await c.advance(RETURN_POLL_MS)
    assert.equal(s.get()?.outcome, 'done')
  })

  for (const state of ['dialog', 'permission', 'question']) {
    test(`a ${state} on the quiet screen ends waiting`, async () => {
      const c = fakeClock(); const { sources } = pane({ state })
      const s = start(sources, c.clock)
      await c.advance(RETURN_QUIET_MS)
      assert.deepEqual(s.get(), { outcome: 'waiting', state, text: 'saida nova', elapsedMs: RETURN_QUIET_MS })
    })
  }

  test('a screen that never quiets ends timeout at the limit', async () => {
    const c = fakeClock(); const { p, sources } = pane()
    const s = start(sources, c.clock)
    while (s.get() === null && c.clock.now() - T0 < RETURN_LIMIT_MS + 1_000) { p.paintedAt = c.clock.now(); await c.advance(RETURN_POLL_MS) }
    assert.deepEqual(s.get(), { outcome: 'timeout', text: 'saida nova', elapsedMs: RETURN_LIMIT_MS })
  })

  test('the person typing after the tether ends interfered with the screen', async () => {
    const c = fakeClock(); const { p, sources } = pane()
    const s = start(sources, c.clock)
    p.userTypedAt = T0 + 100
    await c.advance(RETURN_POLL_MS)
    assert.deepEqual(s.get(), { outcome: 'interfered', text: 'saida nova', elapsedMs: RETURN_POLL_MS })
  })

  test('a lost mark returns the whole screen with markLost', async () => {
    const c = fakeClock(); const { sources } = pane({ since: { text: '', reset: true } })
    const s = start(sources, c.clock)
    await c.advance(RETURN_QUIET_MS)
    assert.deepEqual(s.get(), { outcome: 'done', text: 'tela inteira', markLost: true, elapsedMs: RETURN_QUIET_MS })
  })

  test('a slot that vanished ends gone', async () => {
    const c = fakeClock(); const { p, sources } = pane()
    const s = start(sources, c.clock)
    p.turn = undefined; p.paintedAt = undefined
    await c.advance(RETURN_POLL_MS)
    assert.deepEqual(s.get(), { outcome: 'gone', elapsedMs: RETURN_POLL_MS })
  })

  test('dispose stops the polling and resolves undefined', async () => {
    const c = fakeClock(); const { sources } = pane()
    const s = start(sources, c.clock)
    s.w.dispose()
    await c.advance(0)
    assert.equal(s.get(), undefined)
    assert.equal(c.pending(), 0)
  })
})

describe('returnBody', () => {
  const base = { text: 'linha', elapsedMs: 1 }
  test('each outcome in words', () => {
    assert.equal(returnBody('/context', { outcome: 'done', ...base }), 'comando /context: terminou\ntela:\nlinha')
    assert.match(returnBody('/x', { outcome: 'waiting', state: 'permission', ...base }) ?? '', /parou esperando você: permission/)
    assert.match(returnBody('/x', { outcome: 'timeout', ...base }) ?? '', /não terminou em 5 min/)
    assert.match(returnBody('/x', { outcome: 'interfered', ...base }) ?? '', /a pessoa digitou na guia durante a espera; a vez é dela/)
    assert.match(returnBody('/x', { outcome: 'done', markLost: true, ...base }) ?? '', /a marca se perdeu no redesenho; segue a tela inteira\ntela:\nlinha/)
  })
  test('nothing for turn and gone', () => {
    assert.equal(returnBody('/x', { outcome: 'turn', elapsedMs: 1 }), undefined)
    assert.equal(returnBody('/x', { outcome: 'gone', elapsedMs: 1 }), undefined)
  })
})
