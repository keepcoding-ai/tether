// The mark of a card answer (`agents answer`): the delivery decides by the mark the writer declares, never by the shape of the
// bytes. A marked chunk is activity (the silence restarts, no draft); an agent's chunk with no mark is a draft as any other.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { DeliveryService } from '../../src/daemon/door/delivery.ts'
import { ANSWER_QUIET_MS, USER_QUIET_MS } from '../../src/daemon/door/user-presence.ts'

function rig(): { delivery: DeliveryService; clock: { t: number } } {
  const clock = { t: 1_000_000 }
  const delivery = new DeliveryService({
    port: () => undefined,
    mcp: { connected: () => false, wakes: () => false, sendChannel: () => false, onDidStream: () => toDisposable(() => undefined) },
    log: () => undefined,
    now: () => clock.t,
  })
  return { delivery, clock }
}

describe('card answer mark', () => {
  test('a marked answer that is not a digit leaves no draft', () => {
    const { delivery } = rig()
    delivery.input('s1', 'y', 'agent', { answer: true })
    assert.equal(delivery.presence.draft('s1', 'agent'), false)
    assert.equal(delivery.presence.typedAt('s1', 'agent') !== undefined, true)
  })

  test('a digit typed by an agent with no mark is a draft', () => {
    const { delivery } = rig()
    delivery.input('s1', '3', 'agent')
    assert.equal(delivery.presence.draft('s1', 'agent'), true)
  })

  test('a marked answer restarts the short settling window', () => {
    const { delivery, clock } = rig()
    delivery.input('s1', 'y', 'agent', { answer: true })
    const first = delivery.presence.freeAt('s1', 'agent')
    assert.equal(first, clock.t + ANSWER_QUIET_MS)
    clock.t += 2_000
    delivery.input('s1', '\r', 'agent', { answer: true })
    assert.equal(delivery.presence.freeAt('s1', 'agent'), clock.t + ANSWER_QUIET_MS)
    assert.equal(delivery.presence.isFree('s1', clock.t + ANSWER_QUIET_MS - 1, 'agent'), false)
    assert.equal(delivery.presence.isFree('s1', clock.t + ANSWER_QUIET_MS, 'agent'), true)
  })

  test('an unmarked chunk of an agent keeps the 10 s of typing, and a later marked answer does not shorten it', () => {
    const { delivery, clock } = rig()
    delivery.input('s1', 'ls\r', 'agent')
    const typing = clock.t + USER_QUIET_MS
    assert.equal(delivery.presence.freeAt('s1', 'agent'), typing)
    clock.t += 1_000
    delivery.input('s1', '1', 'agent', { answer: true })
    assert.equal(delivery.presence.freeAt('s1', 'agent'), typing)
    assert.equal(delivery.presence.hold('s1', 'agent')?.kind, 'typing')
  })
})
