// The polite-pause menu model (app/renderer/pause-rules.ts), pure.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PauseBatch, PauseEntry, PauseEntryState } from '../../src/daemon/pause.ts'
import { STILL_FINISHING_MS } from '../../src/daemon/pause.ts'
import { derivedLabel } from '../../src/daemon/pause.ts'
import { buttonTitle, entryLabel, canResume, counter, counterText, entryText, entryTone, hasBatch, orderedEntries, summaryText, toneColor, tierOf, stateLabel, formatElapsed, formatClock, timeline, resolveSelection, followSummary, batchElapsedText, canRemoveEntry } from '../../app/renderer/pause-rules.ts'

const T0 = '2026-01-01T00:00:00.000Z'
const t0 = Date.parse(T0)
const entry = (slotId: string, state: PauseEntryState, extra: Partial<PauseEntry> = {}): PauseEntry => ({ slotId, kind: 'claude', state, since: T0, history: [{ state, at: T0 }], ...extra })
const batch = (entries: PauseEntry[], state: PauseBatch['state'] = 'pausing'): PauseBatch => ({ v: 1, id: 'b', createdAt: T0, state, entries })

describe('tone and colour', () => {
  test('blue in progress, green stopped, grey queued; never orange', () => {
    assert.equal(entryTone(entry('a', 'preparing')), 'progress')
    assert.equal(entryTone(entry('a', 'stopped-silent')), 'stopped')
    assert.equal(entryTone(entry('a', 'queued')), 'queued')
    assert.equal(toneColor('progress'), 'var(--accent)')
    assert.equal(toneColor('stopped'), 'var(--ok)')
    assert.ok(!toneColor('queued').includes('warn'))
  })
})

describe('counter', () => {
  test('counts stopped over active, ignoring removed', () => {
    const b = batch([entry('a', 'stopped'), entry('b', 'preparing'), entry('c', 'removed'), entry('d', 'stopped-silent')])
    assert.deepEqual(counter(b), { stopped: 2, total: 3 })
    assert.equal(counterText(b), '2/3')
    assert.equal(counterText(null), '')
    assert.equal(counterText(batch([], 'closed')), '')
  })
  test('title and hasBatch', () => {
    assert.equal(hasBatch(null), false)
    assert.equal(hasBatch(batch([], 'closed')), false)
    assert.match(buttonTitle(null), /Pausar/)
    assert.match(buttonTitle(batch([entry('a', 'stopped')], 'paused')), /Pausa pronta/)
  })
})

describe('order', () => {
  test('in progress, then queued, then stopped; stable inside groups', () => {
    const b = batch([entry('s1', 'stopped'), entry('q', 'queued'), entry('p1', 'delivered'), entry('x', 'removed'), entry('p2', 'listening')])
    assert.deepEqual(orderedEntries(b).map(e => e.slotId), ['p1', 'p2', 'q', 's1'])
  })
})

describe('resume', () => {
  test('enabled only when every active agent stopped', () => {
    assert.equal(canResume(batch([entry('a', 'stopped'), entry('b', 'stopped-silent'), entry('c', 'removed')], 'paused')), true)
    assert.equal(canResume(batch([entry('a', 'stopped'), entry('b', 'preparing')])), false)
    assert.equal(canResume(batch([entry('a', 'stopped'), entry('b', 'queued')])), false)
    assert.equal(canResume(batch([])), false)
    assert.equal(canResume(batch([entry('a', 'stopped')], 'resuming')), false)
    assert.equal(canResume(null), false)
  })
})

describe('text', () => {
  test('phrase while in progress, note when stopped, else the label; still finishing after 5 min', () => {
    assert.equal(entryText(entry('a', 'preparing', { phrase: 'Terminando o teste' }), t0), 'Terminando o teste')
    assert.equal(entryText(entry('a', 'stopped', { note: 'Parei no passo 3' }), t0), 'Parei no passo 3')
    assert.equal(entryText(entry('a', 'queued'), t0), 'Na fila')
    assert.equal(entryText(entry('a', 'delivered'), t0 + STILL_FINISHING_MS), 'Ainda finalizando')
  })
  test('summary', () => {
    assert.match(summaryText(batch([entry('a', 'stopped'), entry('b', 'stopped')], 'paused'), t0), /Os 2 agentes pararam/)
    assert.match(summaryText(batch([entry('a', 'stopped'), entry('b', 'delivered')]), t0 + STILL_FINISHING_MS), /1 de 2 pararam.*1 ainda finalizando/)
  })
})

describe('label parity', () => {
  test('the renderer mirror matches derivedLabel for every state, before and after 5 minutes', () => {
    const states: PauseEntryState[] = ['queued', 'listening', 'delivered', 'preparing', 'stopped', 'stopped-silent', 'removed', 'resumed', 'resume-skipped']
    for (const s of states) for (const dt of [0, STILL_FINISHING_MS]) assert.equal(entryLabel(entry('a', s), t0 + dt), derivedLabel(entry('a', s), t0 + dt))
  })
})

describe('management popup rules', () => {
  test('tierOf: 767 phone, 768 narrow, 1279 narrow, 1280 desktop, 2559 desktop, 2560 wide', () => {
    assert.deepEqual([320, 767, 768, 1279, 1280, 2559, 2560, 3840].map(tierOf), ['phone', 'phone', 'narrow', 'narrow', 'desktop', 'desktop', 'wide', 'wide'])
  })
  test('formatElapsed: seconds, minutes, hours, days; negative and NaN read as zero', () => {
    assert.equal(formatElapsed(0), '0 s')
    assert.equal(formatElapsed(999), '0 s')
    assert.equal(formatElapsed(12_000), '12 s')
    assert.equal(formatElapsed(59_999), '59 s')
    assert.equal(formatElapsed(60_000), '1 min 00 s')
    assert.equal(formatElapsed(185_000), '3 min 05 s')
    assert.equal(formatElapsed(3_600_000), '1 h 00 min')
    assert.equal(formatElapsed(3_900_000), '1 h 05 min')
    assert.equal(formatElapsed(86_400_000 + 3 * 3_600_000), '1 d 03 h')
    assert.equal(formatElapsed(-5000), '0 s')
    assert.equal(formatElapsed(Number.NaN), '0 s')
  })
  test('formatClock is the local wall clock, empty when invalid', () => {
    assert.equal(formatClock(new Date(2026, 0, 1, 9, 5, 7).toISOString()), '09:05:07')
    assert.equal(formatClock('nope'), '')
  })
  test('stateLabel matches the label of a fresh entry in each state', () => {
    for (const s of ['queued', 'listening', 'delivered', 'preparing', 'stopped', 'stopped-silent', 'removed', 'resumed', 'resume-skipped'] as const) {
      assert.equal(stateLabel(s), entryLabel(entry('a', s), t0), s)
    }
  })
  test('timeline: durations to the next state, the last one runs to now, spans read in Portuguese', () => {
    const at = (s: number): string => new Date(t0 + s * 1000).toISOString()
    const e = entry('a', 'preparing', {
      since: at(70),
      history: [{ state: 'listening', at: at(0) }, { state: 'delivered', at: at(0.4) }, { state: 'preparing', at: at(70) }],
    })
    const tl = timeline(e, t0 + 135_000)
    assert.deepEqual(tl.map(i => i.state), ['listening', 'delivered', 'preparing'])
    assert.deepEqual(tl.map(i => i.current), [false, false, true])
    assert.equal(tl[0]!.spanText, 'durou menos de 1 s')
    assert.equal(tl[1]!.spanText, 'durou 1 min 09 s')
    assert.equal(tl[2]!.spanText, 'há 1 min 05 s')
    assert.deepEqual(tl.map(i => i.tone), ['progress', 'progress', 'progress'])
    assert.equal(tl[0]!.label, 'Pedido enviado')
  })
  test('timeline: the current label follows the clock ("Ainda finalizando"), and an empty history is rebuilt', () => {
    const e = entry('a', 'preparing', { history: [] })
    const tl = timeline(e, t0 + STILL_FINISHING_MS + 1000)
    assert.equal(tl.length, 1)
    assert.equal(tl[0]!.label, 'Ainda finalizando')
    assert.equal(tl[0]!.state, 'preparing')
  })
  test('timeline: a stopped entry is green and its last span counts since it stopped', () => {
    const e = entry('a', 'stopped', { history: [{ state: 'preparing', at: T0 }, { state: 'stopped', at: new Date(t0 + 30_000).toISOString() }], since: new Date(t0 + 30_000).toISOString() })
    const tl = timeline(e, t0 + 90_000)
    assert.equal(tl[1]!.tone, 'stopped')
    assert.equal(tl[1]!.spanText, 'há 1 min 00 s')
  })
  test('resolveSelection keeps the chosen entry while it is in the pause, else the first row', () => {
    const b = batch([entry('a', 'stopped'), entry('b', 'preparing'), entry('c', 'removed')])
    assert.equal(resolveSelection(b, 'a'), 'a')
    assert.equal(resolveSelection(b, 'c'), 'b') // removed: falls to the first row (in progress first)
    assert.equal(resolveSelection(b, undefined), 'b')
    assert.equal(resolveSelection(null, 'a'), undefined)
    assert.equal(resolveSelection(batch([]), 'a'), undefined)
  })
  test('followSummary and batchElapsedText', () => {
    assert.equal(followSummary(batch([entry('a', 'stopped'), entry('b', 'preparing'), entry('c', 'queued')])), '1 de 3 já pararam')
    assert.equal(followSummary(batch([entry('a', 'stopped')])), '1 de 1 já parou')
    assert.equal(followSummary(batch([entry('a', 'stopped')], 'resuming')), 'Retomando os agentes, um passo de cada vez')
    assert.equal(followSummary(batch([])), 'Ninguém na pausa')
    assert.equal(followSummary(null), 'Nenhuma pausa em andamento')
    assert.equal(batchElapsedText(batch([]), t0 + 252_000), 'Pausa há 4 min 12 s')
  })
  test('canRemoveEntry: not while resuming, not once resumed', () => {
    assert.equal(canRemoveEntry(batch([]), entry('a', 'preparing')), true)
    assert.equal(canRemoveEntry(batch([], 'resuming'), entry('a', 'stopped')), false)
    assert.equal(canRemoveEntry(batch([]), entry('a', 'resumed')), false)
  })
})
