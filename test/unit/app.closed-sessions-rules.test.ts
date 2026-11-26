// "Fechadas" for a manager (app/renderer/closed-sessions-rules.ts), pure.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSED_LIMIT, closedSessionsOf, closedSignature } from '../../app/renderer/closed-sessions-rules.ts'
import type { SessionSlot } from '../../app/renderer/sessions-rules.ts'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const mk = (slotId: string, extra: Partial<SessionSlot> = {}): SessionSlot => ({ slotId, cwd: `/work/${slotId}`, status: 'exited', kind: 'claude', ...extra })
const tabs = (...ids: string[]) => (id: string): boolean => ids.includes(id)

describe('closedSessionsOf', () => {
  test('only ended sessions without a tab; an open tab and a live session stay out', () => {
    const slots = [mk('a', { endedAt: ago(1000) }), mk('b', { endedAt: ago(2000) }), mk('c', { status: 'running' }), mk('d', { status: 'starting' }), mk('e', { status: 'queued' })]
    assert.deepEqual(closedSessionsOf(slots, tabs('b')).map(c => c.slotId), ['a'])
  })

  test('newest first; without endedAt last, in the daemon order', () => {
    const slots = [mk('old', { endedAt: ago(9000) }), mk('x'), mk('new', { endedAt: ago(1000) }), mk('y')]
    assert.deepEqual(closedSessionsOf(slots, tabs()).map(c => c.slotId), ['new', 'old', 'x', 'y'])
  })

  test('the cap: default 50, `limit` lowers it, and never goes above 50', () => {
    const slots = Array.from({ length: 70 }, (_, i) => mk(`s${i}`, { endedAt: ago(i * 1000) }))
    assert.equal(closedSessionsOf(slots, tabs()).length, CLOSED_LIMIT)
    assert.equal(closedSessionsOf(slots, tabs(), 3).length, 3)
    assert.equal(closedSessionsOf(slots, tabs(), 500).length, CLOSED_LIMIT)
    assert.equal(closedSessionsOf(slots, tabs(), 0).length, CLOSED_LIMIT)
    assert.equal(closedSessionsOf(slots, tabs(), 3)[0]?.slotId, 's0')
  })

  test('name: given name, then title, then the folder; title and endedAt only when present', () => {
    const [a, b, c] = closedSessionsOf([mk('a', { name: 'Obra', title: 'Rota', endedAt: ago(1) }), mk('b', { title: 'Só título' }), mk('c', { cwd: 'C:\\x\\pasta' })], tabs())
    assert.deepEqual(a, { slotId: 'a', kind: 'claude', name: 'Obra', title: 'Rota', cwd: '/work/a', endedAt: ago(1) })
    assert.equal(b?.name, 'Só título')
    assert.equal(c?.name, 'pasta')
    assert.ok(!('title' in c!) && !('endedAt' in c!))
  })

  test('the signature follows the ids and their order only', () => {
    const one = closedSessionsOf([mk('a', { endedAt: ago(1) }), mk('b', { endedAt: ago(2) })], tabs())
    const renamed = closedSessionsOf([mk('a', { name: 'Novo', endedAt: ago(1) }), mk('b', { endedAt: ago(2) })], tabs())
    assert.equal(closedSignature(one), closedSignature(renamed))
    assert.notEqual(closedSignature(one), closedSignature(one.slice(1)))
  })
})
