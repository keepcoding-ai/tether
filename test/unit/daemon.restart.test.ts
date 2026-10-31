// `tether daemon restart|stop` from inside a slot of the target daemon would end the session asking for it:
// the guard spots the slot through TETHER_SLOT_ID, but only when that slot belongs to the daemon answering.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ENV_SLOT } from '../../src/agents/types.ts'
import { ownSlotOf, selfShutdownMessage } from '../../src/daemon/restart.ts'

const slots = [{ slotId: 'aaaa1111-0000' }, { slotId: 'bbbb2222-0000' }]

describe('ownSlotOf', () => {
  test('outside any slot: undefined', () => {
    assert.equal(ownSlotOf(slots, {}), undefined)
    assert.equal(ownSlotOf(slots, { [ENV_SLOT]: '  ' }), undefined)
  })
  test('inside a slot of the target daemon: that slot', () => {
    assert.equal(ownSlotOf(slots, { [ENV_SLOT]: 'bbbb2222-0000' }), 'bbbb2222-0000')
  })
  test('inside a slot of some other daemon (unknown to this one): undefined', () => {
    assert.equal(ownSlotOf(slots, { [ENV_SLOT]: 'cccc3333-0000' }), undefined)
  })
})

describe('selfShutdownMessage', () => {
  test('says it would end this session and points to --force', () => {
    const m = selfShutdownMessage('restart', 'bbbb2222-0000')
    assert.match(m, /bbbb2222/)
    assert.match(m, /encerraria esta sessão/)
    assert.match(m, /--force/)
    assert.match(selfShutdownMessage('stop', 'x'), /parar/)
  })
})
