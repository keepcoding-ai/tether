// What an extension may read of the slot behind a pane (TetherUi.panes.slotFacts), the notice of a change of marks and the
// way an extension closes the pane of a slot: the pure rules (app/renderer/door/slot-facts.ts) and the DoorHost that serves them.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agentHue } from '../../app/shared/agent-color.ts'
import { DoorHost, type DoorPort } from '../../app/renderer/door/host.ts'
import { AttentionStamps, slotFactsOf } from '../../app/renderer/door/slot-facts.ts'
import { emptyLayout } from '../../app/renderer/layout.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const slot = (slotId: string, extra: Partial<SlotState> = {}): SlotState => ({ slotId, ...extra }) as SlotState
const names: Record<string, string> = { A: 'Atrium' }

describe('attention stamps', () => {
  test('the time is the first sight of each attention, and a new attention gets a new time', () => {
    let t = 0
    const stamps = new AttentionStamps(() => `2026-11-21T14:0${++t}:00.000Z`)
    assert.equal(stamps.observe(slot('c1')), false)
    assert.equal(stamps.observe(slot('c1', { attentionFor: { slotId: 'A', value: 'waiting' } })), true)
    assert.equal(stamps.sinceOf('c1'), '2026-11-21T14:01:00.000Z')
    assert.equal(stamps.observe(slot('c1', { attentionFor: { slotId: 'A', value: 'waiting' } })), false, 'the same attention again: no change, same time')
    assert.equal(stamps.sinceOf('c1'), '2026-11-21T14:01:00.000Z')
    assert.equal(stamps.observe(slot('c1', { attentionFor: { slotId: 'A', value: 'done' } })), true)
    assert.equal(stamps.sinceOf('c1'), '2026-11-21T14:02:00.000Z')
    assert.equal(stamps.observe(slot('c1', { attention: 'waiting' })), true, 'the owner went: the same wait now belongs to the person')
    assert.equal(stamps.observe(slot('c1')), true)
    assert.equal(stamps.sinceOf('c1'), undefined)
    assert.equal(stamps.size, 0)
  })
})

describe('slot facts', () => {
  const stamps = new AttentionStamps(() => '2026-11-21T14:05:00.000Z')
  test('a slot with nothing special has empty facts, and no slot has none', () => {
    assert.deepEqual(slotFactsOf(slot('c1'), stamps, id => names[id]), {})
    assert.equal(slotFactsOf(undefined, stamps, id => names[id]), undefined)
  })
  test('createdBy is copied', () => {
    assert.deepEqual(slotFactsOf(slot('c1', { createdBy: { ext: 'for-agents', slotId: 'A' } }), stamps, id => names[id]), { createdBy: { ext: 'for-agents', slotId: 'A' } })
  })
  test('an attention that waits for the owner is `routed`, with the owner\'s hue, the tab\'s words and the time', () => {
    const s = slot('c1', { attentionFor: { slotId: 'A', value: 'waiting' } })
    stamps.observe(s)
    assert.deepEqual(slotFactsOf(s, stamps, id => names[id]), {
      routed: { owner: 'A', value: 'waiting', since: '2026-11-21T14:05:00.000Z', hue: agentHue('A'), tooltip: 'Esperando Atrium' },
    })
  })
  test('an attention that waits for the person is `attention`, never `routed`', () => {
    const s = slot('c2', { attention: 'waiting' })
    stamps.observe(s)
    assert.deepEqual(slotFactsOf(s, stamps, id => names[id]), { attention: { value: 'waiting', since: '2026-11-21T14:05:00.000Z' } })
  })
})

describe('DoorHost: slot facts, marks and closing', () => {
  function hostWith(slots: SlotState[]) {
    const closed: string[] = []
    const port: DoorPort = {
      layoutRestored: () => true, hasPane: () => true, desk: () => undefined, addPane: () => {}, log: () => {},
      layout: () => emptyLayout(), paneType: c => c, systemDeskName: () => undefined, sendDeskMap: () => {}, sleep: () => {},
      slots: () => slots, slot: id => slots.find(s => s.slotId === id), ownerName: id => names[id],
      closeGuide: async (id, process) => { closed.push(`${id}:${process}`) },
    }
    return { door: new DoorHost(port), closed }
  }

  test('facts follow the state the host was given, and the stamp is taken on the first sight', () => {
    const c1 = slot('c1')
    const { door } = hostWith([c1])
    assert.deepEqual(door.slotFacts('c1'), {})
    const waiting = slot('c1', { attentionFor: { slotId: 'A', value: 'waiting' } })
    Object.assign(c1, waiting)
    door.stateApplied(c1)
    const f = door.slotFacts('c1')!
    assert.equal(f.routed?.owner, 'A')
    assert.ok(!Number.isNaN(Date.parse(f.routed!.since)))
    assert.equal(door.slotFacts('nope'), undefined)
    door.slotRemoved('c1')
  })

  test('marks: an emblem, a status-bar line and a change of routed attention each tell the listeners the pane', () => {
    const c1 = slot('c1')
    const { door } = hostWith([c1])
    const heard: Array<string | undefined> = []
    const d = door.onMarksChange(id => heard.push(id))
    door.setEmblems('x', 'c1', [{ icon: 'eye', tooltip: 'vê' }])
    door.setHeadItem('x', 'c1', { icon: '', text: 'Atrium · enviou pedido', tooltip: '' })
    door.setTabLine('x', 'c1', 200)
    Object.assign(c1, { attentionFor: { slotId: 'A', value: 'waiting' } })
    door.stateApplied(c1)
    door.stateApplied(c1) // the same attention again says nothing
    assert.deepEqual(heard, ['c1', 'c1', 'c1', 'c1'])
    assert.deepEqual(door.emblemsOf('c1').map(e => e.icon), ['eye'])
    d.dispose()
    door.setEmblems('x', 'c1', undefined)
    assert.equal(heard.length, 4, 'a disposed listener hears nothing')
  })

  test('a listener that throws does not stop the others', () => {
    const { door } = hostWith([slot('c1')])
    const heard: string[] = []
    const log = console.error
    console.error = () => {}
    try {
      door.onMarksChange(() => { throw new Error('boom') })
      door.onMarksChange(id => heard.push(String(id)))
      door.setEmblems('x', 'c1', [{ icon: 'eye', tooltip: '' }])
    } finally { console.error = log }
    assert.deepEqual(heard, ['c1'])
  })

  test('closeGuide goes to the port, keeping the process by default; with no port it does nothing', async () => {
    const { door, closed } = hostWith([slot('c1')])
    await door.closeGuide('c1')
    await door.closeGuide('c1', 'stop')
    assert.deepEqual(closed, ['c1:keep', 'c1:stop'])
    await new DoorHost().closeGuide('c1')
    assert.equal(new DoorHost().slotFacts('c1'), undefined)
  })

  test('taking the extension away takes its emblems away and tells the listeners', () => {
    const { door } = hostWith([slot('c1')])
    door.setEmblems('x', 'c1', [{ icon: 'eye', tooltip: '' }])
    let n = 0
    door.onMarksChange(() => { n++ })
    door.removeOwner('x')
    assert.equal(n, 1)
    assert.deepEqual(door.emblemsOf('c1'), [])
  })
})
