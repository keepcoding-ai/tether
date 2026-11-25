// Temper (security gate, navegador da pessoa N4): the clean give must fail closed. When the reload before the give fails, the
// hub still answers true and the caller (main.ts `give`) changes the owner: the agent gets the page as she left it.
// Red on purpose (`todo`) until the give stops on a failed clean reload.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ControlHub } from '../../extensions/browser/control.ts'
import { PERSON_OWNER } from '../../extensions/browser/tab-rules.ts'

test('temper: a failed clean reload stops the give (fail closed)', { todo: 'Temper N4-3: give proceeds after the clean reload fails' }, async () => {
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
})
