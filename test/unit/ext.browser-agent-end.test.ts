// An agent whose slot is removed for good takes its tabs along (extensions/browser/agent-end.ts); a restart in place, a stop to
// resume later and a lost daemon never do.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { AgentTracker } from '../../app/main/agents.ts'
import { closeTabsOnAgentRemoved } from '../../extensions/browser/agent-end.ts'

const slot = (over: Partial<SlotState> = {}): SlotState => ({ slotId: 'a', kind: 'claude', cwd: '/work/proj/', name: 'Sonda', status: 'running', ...over })

function setup() {
  const agents = new AgentTracker()
  const tabs = [{ tabId: 't1', ownerSlotId: 'a' }, { tabId: 't2', ownerSlotId: 'a' }, { tabId: 't3', ownerSlotId: 'a' }, { tabId: 't4', ownerSlotId: 'b' }]
  const controls: Record<string, { holder: 'agent' | 'user'; asking: boolean }> = { t2: { holder: 'user', asking: false }, t3: { holder: 'agent', asking: true } }
  const closed: Array<[string, string]> = []
  closeTabsOnAgentRemoved(agents, {
    list: () => tabs,
    controlOf: id => controls[id] ?? { holder: 'agent', asking: false },
    close: (id, removal) => closed.push([id, removal.name]),
  })
  agents.apply(slot())
  return { agents, closed }
}

describe('browser: tabs of a removed agent', () => {
  test('removing the slot closes the agent\'s tabs and spares those with the person and other agents\'', () => {
    const { agents, closed } = setup()
    agents.remove('a')
    assert.deepEqual(closed, [['t1', 'Sonda']])
  })

  test('removing a slot already stopped closes them too, once', () => {
    const { agents, closed } = setup()
    agents.apply(slot({ status: 'exited' }))
    agents.remove('a')
    assert.deepEqual(closed, [['t1', 'Sonda']])
  })

  test('restart in place, stop and lost daemon close nothing', () => {
    const { agents, closed } = setup()
    agents.apply(slot({ status: 'exited' }))
    agents.apply(slot({ status: 'starting' }))
    agents.apply(slot({ profileId: 'other' }))
    agents.lost()
    assert.deepEqual(closed, [])
  })
})
