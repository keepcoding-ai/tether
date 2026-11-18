// currentBinding over event sequences modelled on what Claude Code really emits (spike E0, PRD §4.1).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EventKind, SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { currentBinding } from '../../src/core/store.ts'

const META: SlotMeta = { v: 1, slotId: 'slot0001', agent: 'claude', cwd: 'D:\\initial', args: [], createdAt: '2026-10-29T00:00:00.000Z' }

const A = 'a46e649a-a828-4463-926e-c747ea739289'
const B = 'fef8862b-9f18-46cf-9bda-5c00982ba3dc'
const C = 'b358e415-0000-4000-8000-000000000000'
const F = '5ba4397a-0000-4000-8000-000000000000'

let clock = 0
function e(kind: EventKind, source: string, sessionId: string, extra: Partial<TetherEvent> = {}): TetherEvent {
  clock++
  const ev: TetherEvent = { v: 1, ts: `2026-10-29T00:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}.000Z`, slotId: META.slotId, agent: 'claude', kind, source, sessionId, ...extra }
  if (kind === 'start' && !ev.resume) {
    ev.cwd ??= 'D:\\work'
    ev.resume = { cwd: ev.cwd, args: ['--resume', sessionId] }
  }
  return ev
}
const start = (source: string, id: string, extra?: Partial<TetherEvent>) => e('start', source, id, extra)
const end = (reason: string, id: string) => e('end', reason, id)
const rename = (id: string, title: string) => e('rename', 'rename', id, { title })

describe('currentBinding', () => {
  test('a `cd` before compact does not move the session: cwd stays the one it was opened in', () => {
    const b = currentBinding([start('startup', A, { cwd: 'D:\\atrium' }), start('compact', A, { cwd: 'D:\\atrium\\wt' })], META)!
    assert.equal(b.cwd, 'D:\\atrium')
    assert.deepEqual(b.resume, { cwd: 'D:\\atrium', args: ['--resume', A] })
  })

  test('a new session in the slot takes its own cwd', () => {
    const b = currentBinding([start('startup', A, { cwd: 'D:\\atrium' }), start('clear', B, { cwd: 'D:\\other' })], META)!
    assert.equal(b.cwd, 'D:\\other')
  })

  test('no start → undefined', () => {
    assert.equal(currentBinding([], META), undefined)
    assert.equal(currentBinding([rename(A, 'x'), end('other', A)], META), undefined)
  })

  test('startup: binding = that session, confirmed, not ended, resume recipe and cwd from the event', () => {
    const b = currentBinding([start('startup', A, { title: 'first' })], META)!
    assert.equal(b.sessionId, A)
    assert.equal(b.agent, 'claude')
    assert.equal(b.slotId, META.slotId)
    assert.equal(b.cwd, 'D:\\work')
    assert.deepEqual(b.resume, { cwd: 'D:\\work', args: ['--resume', A] })
    assert.equal(b.title, 'first')
    assert.equal(b.confirmed, true)
    assert.equal(b.ended, false)
    assert.match(b.since, /^2026-/)
  })

  test('cwd falls back to meta.cwd when the start carries none', () => {
    const s: TetherEvent = { v: 1, ts: '2026-10-29T00:00:01.000Z', slotId: META.slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId: A }
    const b = currentBinding([s], META)!
    assert.equal(b.cwd, META.cwd)
    assert.equal(b.resume, undefined)
    assert.equal(b.title, undefined)
  })

  test('/compact: same id, same binding, since moves to the compact start', () => {
    const s1 = start('startup', A)
    const s2 = start('compact', A)
    const b = currentBinding([s1, s2], META)!
    assert.equal(b.sessionId, A)
    assert.equal(b.since, s2.ts)
    assert.equal(b.ended, false)
  })

  test('/clear: end(clear) of old + start(clear) of new → binding is the new id', () => {
    const b = currentBinding([start('startup', A), start('compact', A), end('clear', A), start('clear', B)], META)!
    assert.equal(b.sessionId, B)
    assert.equal(b.ended, false)
  })

  test('/resume inside the session: end(resume) + start(resume, other id)', () => {
    const b = currentBinding([start('startup', A), end('resume', A), start('resume', C)], META)!
    assert.equal(b.sessionId, C)
    assert.equal(b.ended, false)
  })

  test('/exit: end(prompt_input_exit) marks ended but keeps the binding', () => {
    const b = currentBinding([start('startup', A), end('clear', A), start('clear', B), end('prompt_input_exit', B)], META)!
    assert.equal(b.sessionId, B)
    assert.equal(b.ended, true)
    assert.deepEqual(b.resume?.args, ['--resume', B])
  })

  test('kill without SessionEnd: binding stays, ended=false (liveness decides, not the event)', () => {
    const b = currentBinding([start('startup', A), end('clear', A), start('clear', B)], META)!
    assert.equal(b.sessionId, B)
    assert.equal(b.ended, false)
  })

  test('end(other) on kill, then resume of the same id reopens it', () => {
    const evs = [start('startup', C), end('other', C), start('resume', C)]
    assert.equal(currentBinding(evs.slice(0, 2), META)!.ended, true)
    const b = currentBinding(evs, META)!
    assert.equal(b.sessionId, C)
    assert.equal(b.ended, false)
  })

  test('fork gives a new id (spike slotA sequence)', () => {
    const b = currentBinding([start('startup', C), end('other', C), start('resume', C), end('other', C), start('fork', F), end('other', F), start('resume', F)], META)!
    assert.equal(b.sessionId, F)
    assert.equal(b.ended, false)
  })

  test('rename: title of the current session only, latest wins, id unchanged', () => {
    const evs = [start('startup', A, { title: 'from start' }), rename(A, 'one'), rename(A, 'two')]
    let b = currentBinding(evs, META)!
    assert.equal(b.sessionId, A)
    assert.equal(b.title, 'two')

    // Rename of another session (older or stray) does not leak into the binding.
    b = currentBinding([...evs, end('clear', A), start('clear', B), rename(A, 'late rename of A')], META)!
    assert.equal(b.sessionId, B)
    assert.equal(b.title, undefined)

    // A rename before the current start of the same id is not current (the start says what the title is now).
    b = currentBinding([start('startup', A), rename(A, 'old'), end('resume', A), start('resume', A)], META)!
    assert.equal(b.title, undefined)
    b = currentBinding([start('startup', A), rename(A, 'old'), end('resume', A), start('resume', A, { title: 'fresh' }), rename(A, 'newer')], META)!
    assert.equal(b.title, 'newer')
  })

  test('rename after end: last event is not end, so not ended', () => {
    const b = currentBinding([start('startup', A), end('prompt_input_exit', A), rename(A, 't')], META)!
    assert.equal(b.ended, false)
    assert.equal(b.title, 't')
  })

  test('soul: ids and recipe come through unchanged', () => {
    const soulMeta: SlotMeta = { ...META, agent: 'soul', args: ['-H', 'http://srv'] }
    const recipe = { cwd: 'D:\\soul', args: ['-H', 'http://srv', '-r', 'sid-1'], env: { SOUL_X: '1' } }
    const s: TetherEvent = { v: 1, ts: '2026-10-29T01:00:00.000Z', slotId: META.slotId, agent: 'soul', kind: 'start', source: 'new', sessionId: 'sid-1', cwd: 'D:\\soul', resume: recipe }
    const b = currentBinding([s], soulMeta)!
    assert.equal(b.agent, 'soul')
    assert.deepEqual(b.resume, recipe)
    assert.equal(b.cwd, 'D:\\soul')
  })
})
