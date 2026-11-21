// The agent colour function (app/shared/agent-color.ts): stable per id, always inside the teal-to-rose range, and the
// browser's owner hue is the same function.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_HUE_FROM, AGENT_HUE_TO, agentHue } from '../../app/shared/agent-color.ts'
import { ownerHue } from '../../extensions/browser/rules.ts'

describe('agent colour: agentHue', () => {
  test('the same id always gives the same hue', () => {
    assert.equal(agentHue('slot-a'), agentHue('slot-a'))
    assert.equal(agentHue('0f8d2c3e-aaaa'), agentHue('0f8d2c3e-aaaa'))
  })

  test('every hue stays between teal (170) and rose (330) for ten thousand ids', () => {
    assert.equal(AGENT_HUE_FROM, 170)
    assert.equal(AGENT_HUE_TO, 330)
    for (let i = 0; i < 10_000; i++) {
      const h = agentHue(`slot-${i}-${i * 7919}`)
      assert.ok(Number.isInteger(h) && h >= AGENT_HUE_FROM && h <= AGENT_HUE_TO, `id ${i}: ${h}`)
    }
  })

  test('the browser owner hue is the agent hue', () => {
    for (const id of ['slot-a', 'slot-1', '0f8d2c3e-aaaa', 'x'.repeat(40)]) assert.equal(ownerHue(id), agentHue(id))
  })
})
