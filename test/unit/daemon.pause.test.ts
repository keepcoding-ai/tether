// The polite pause batch: entry state machine, report folding, request text, derived label, pause.json round-trip.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { pausePath } from '../../src/core/paths.ts'
import {
  applyReportLine, buildRequestText, canTransition, derivedLabel, newEntry, transition,
  type PauseBatch, type PauseEntry,
} from '../../src/daemon/pause.ts'
import { readPauseFile } from '../../src/daemon/pause-read.ts'
import { writePauseFile } from '../../src/daemon/pause-sync.ts'
import { tempDirs } from './tmp.helpers.ts'

const dirs = tempDirs('tether-pause-')
after(() => dirs.cleanup())

const T0 = '2026-11-09T10:00:00.000Z'
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString()
const listening = (): PauseEntry => transition(newEntry('s1', 'claude', T0), 'listening', at(1))
const line = (o: object) => JSON.stringify(o)

describe('transition', () => {
  test('valid path appends history', () => {
    let e = listening()
    e = transition(e, 'delivered', at(2))
    e = transition(e, 'preparing', at(3), { phrase: 'x' })
    e = transition(e, 'stopped', at(4), { note: 'n' })
    assert.deepEqual(e.history.map((h) => h.state), ['queued', 'listening', 'delivered', 'preparing', 'stopped'])
    assert.equal(e.since, at(4))
    assert.equal(e.phrase, 'x')
    assert.equal(e.note, 'n')
  })
  test('invalid moves throw; terminal states are final', () => {
    assert.throws(() => transition(newEntry('s', 'claude', T0), 'stopped', at(1)))
    assert.equal(canTransition('removed', 'queued'), false)
    assert.equal(canTransition('resumed', 'stopped'), false)
    assert.equal(canTransition('stopped', 'delivered'), false)
    assert.equal(canTransition('stopped', 'resumed'), true)
    assert.equal(canTransition('stopped-silent', 'stopped'), true)
  })
  test('does not mutate the input', () => {
    const e = listening()
    transition(e, 'delivered', at(2))
    assert.equal(e.state, 'listening')
    assert.equal(e.history.length, 2)
  })
})

describe('buildRequestText', () => {
  test('carries the commands and the instructions', () => {
    const t = buildRequestText('node "/r/bin/tether.mjs"')
    assert.match(t, /node "\/r\/bin\/tether\.mjs" pause ack "/)
    assert.match(t, /node "\/r\/bin\/tether\.mjs" pause done "/)
    assert.match(t, /pausa temporária/)
    assert.match(t, /sem começar tarefa nova/)
    assert.match(t, /ignore/)
  })
})

describe('applyReportLine', () => {
  test('delivered is idempotent', () => {
    const e = applyReportLine(listening(), line({ ts: at(2), kind: 'delivered' }))
    assert.equal(e.state, 'delivered')
    assert.deepEqual(applyReportLine(e, line({ ts: at(3), kind: 'delivered' })), e)
  })
  test('ack then done', () => {
    let e = applyReportLine(listening(), line({ ts: at(2), kind: 'ack', text: 'editando' }))
    assert.equal(e.state, 'preparing')
    assert.equal(e.phrase, 'editando')
    e = applyReportLine(e, line({ ts: at(5), kind: 'done', text: 'segue no passo 3' }))
    assert.equal(e.state, 'stopped')
    assert.equal(e.note, 'segue no passo 3')
  })
  test('stop without done is stopped-silent with the fallback note; a later done upgrades it', () => {
    let e = applyReportLine(listening(), line({ ts: at(2), kind: 'stop', text: 'última mensagem' }))
    assert.equal(e.state, 'stopped-silent')
    assert.equal(e.note, 'última mensagem')
    e = applyReportLine(e, line({ ts: at(3), kind: 'done', text: 'nota real' }))
    assert.equal(e.state, 'stopped')
    assert.equal(e.note, 'nota real')
  })
  test('stop after done keeps the note', () => {
    let e = applyReportLine(listening(), line({ ts: at(2), kind: 'done', text: 'nota' }))
    e = applyReportLine(e, line({ ts: at(3), kind: 'stop', text: 'outra' }))
    assert.equal(e.state, 'stopped')
    assert.equal(e.note, 'nota')
  })
  test('ignores corrupt, old, foreign-batch and unknown lines', () => {
    const e = listening()
    assert.equal(applyReportLine(e, '{not json'), e)
    assert.equal(applyReportLine(e, '[]'), e)
    assert.equal(applyReportLine(e, line({ ts: 'x', kind: 'ack' })), e)
    assert.equal(applyReportLine(e, line({ ts: at(2), kind: 'wat' })), e)
    assert.equal(applyReportLine(e, line({ ts: '2026-11-09T09:00:00.000Z', kind: 'done', text: 'velho' })), e)
    assert.equal(applyReportLine(e, line({ ts: at(2), batchId: 'other', kind: 'done' }), 'mine'), e)
    assert.equal(applyReportLine(e, line({ ts: at(2), batchId: 'mine', kind: 'delivered' }), 'mine').state, 'delivered')
  })
  test('lines do not touch removed entries', () => {
    const e = transition(listening(), 'removed', at(2))
    assert.equal(applyReportLine(e, line({ ts: at(3), kind: 'done', text: 'n' })), e)
  })
})

describe('derivedLabel', () => {
  test('still finishing after 5 minutes in delivered/preparing', () => {
    const d = transition(listening(), 'delivered', at(2))
    assert.notEqual(derivedLabel(d, Date.parse(at(60))), 'Ainda finalizando')
    assert.equal(derivedLabel(d, Date.parse(at(2 + 300))), 'Ainda finalizando')
    const p = transition(d, 'preparing', at(10))
    assert.equal(derivedLabel(p, Date.parse(at(10 + 299))), 'Preparando para parar')
    assert.equal(derivedLabel(p, at(10 + 301)), 'Ainda finalizando')
    assert.equal(derivedLabel(transition(p, 'stopped', at(11)), Date.parse(at(9999))), 'Parou')
  })
})

describe('persistence', () => {
  test('round-trips and is missing-safe', () => {
    const home = dirs.make()
    assert.equal(readPauseFile(home), undefined)
    const batch: PauseBatch = {
      v: 1, id: 'b1', createdAt: T0, state: 'pausing',
      entries: [transition(listening(), 'delivered', at(2)), newEntry('s2', 'soul', T0, 'sess')],
    }
    writePauseFile(home, batch)
    assert.deepEqual(readPauseFile(home), batch)
    writePauseFile(home, { ...batch, state: 'paused' })
    assert.equal(readPauseFile(home)?.state, 'paused')
  })
  test('corrupt file reads as undefined', () => {
    const home = dirs.make()
    writeFileSync(pausePath(home), '{oops')
    assert.equal(readPauseFile(home), undefined)
  })
})
