// The polite-pause menu model (app/renderer/pause-rules.ts), pure.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PauseBatch, PauseEntry, PauseEntryState } from '../../src/daemon/pause.ts'
import { STILL_FINISHING_MS } from '../../src/daemon/pause.ts'
import { derivedLabel } from '../../src/daemon/pause.ts'
import { buttonTitle, entryLabel, canResume, counter, counterText, entryText, entryTone, hasBatch, orderedEntries, summaryText, toneColor } from '../../app/renderer/pause-rules.ts'

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
