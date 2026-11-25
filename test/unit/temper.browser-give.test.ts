// Temper (security gate, navegador da pessoa N4): the clean give must fail closed. When the clean give fails, the hub answers
// false (the caller hands nothing over) and the tab is back in her hands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ControlHub } from '../../extensions/browser/control.ts'
import { PERSON_OWNER } from '../../extensions/browser/tab-rules.ts'

test('temper: a failed clean reload stops the give (fail closed)', async () => {
  const logs: string[] = []
  const h = new ControlHub({
    ownerOf: () => PERSON_OWNER,
    cleanHandoff: async () => {},
    beforeGiveBack: async () => {},
    beforeGive: async () => { throw new Error('reload failed') },
    log: m => { logs.push(m) },
  })
  h.added('t1', undefined, PERSON_OWNER)
  assert.equal(h.control('t1'), 'user', 'her own tab is with her')
  const gave = await h.give('t1')
  assert.ok(logs.some(l => l.includes('recarga da entrega falhou')), 'the failure is only logged')
  assert.equal(gave, false, 'a give whose clean reload failed must not go on to change the owner')
  assert.equal(h.view('t1').why, 'own', 'the tab is hers again')
  assert.equal(h.control('t1'), 'user')
})
