// Tether for agents, slice U3: the rules of the inventory pad (extensions/for-agents/renderer/inventory-rules.ts), pure. The model
// for a desk and for a pane's line, the three states of a pane's line, the writes (what is stored on a desk and on a pane) and
// "Ligar tudo". The verb's side (`off`) is the E2E's.
// A = Atrium (owner of desk 'kai-aware'), K = Kai.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { capabilityOn } from '../../extensions/for-agents/rules.ts'
import type { Inventory, Ownership } from '../../extensions/for-agents/rules.ts'
import {
  CONDUCTOR_CAPABILITIES, allOnWrites, asInventory, inventoryModel, nextPaneState, paneCapabilities, withDeskItem, withPaneItem,
  type InventoryFacts,
} from '../../extensions/for-agents/renderer/inventory-rules.ts'

const own = (owner: string, extra: Partial<Ownership> = {}): Ownership => ({ owner, since: '2026-11-21T14:02:00', givenBy: 'user', ...extra })
const NAMES: Record<string, string> = { A: 'Atrium', K: 'Kai' }

interface Spec {
  deskOwner?: Record<string, Ownership>
  paneOwner?: Record<string, Ownership>
  deskInv?: Record<string, Inventory>
  paneInv?: Record<string, Inventory>
}
const PANES = [
  { id: 'A', deskId: 'd1', title: 'Atrium' }, { id: 'c1', deskId: 'd1', title: 'soul · testes' }, { id: 'c2', deskId: 'd1', title: 'soul · outra' },
  { id: 'c3', deskId: 'd1', title: 'soul · terceira' }, { id: 'g', deskId: 'd1', title: 'codex · conferência' }, { id: 'K', deskId: 'd1', title: 'Kai' },
  { id: 'n1', deskId: 'd2', title: 'notas' }, { id: 'loose', title: 'solta' },
]
const facts = (s: Spec = {}): InventoryFacts => ({
  panes: PANES.map(p => ({ id: p.id, type: 'terminal', deskId: p.deskId, title: p.title, agent: true })),
  desks: [{ id: 'd1', name: 'kai-aware' }, { id: 'd2', name: 'geral' }],
  paneOwner: new Map(Object.entries(s.paneOwner ?? {})),
  paneHand: new Map(),
  deskOwner: new Map(Object.entries(s.deskOwner ?? {})),
  deskHand: new Map(),
  frozen: new Map(),
  nameOf: id => NAMES[id] ?? id,
  deskInv: new Map(Object.entries(s.deskInv ?? {})),
  paneInv: new Map(Object.entries(s.paneInv ?? {})),
})
// The desk of the preview: Atrium owns it; g was given to K, K is K's own ("de si"); c1 differs.
const given: Spec = { deskOwner: { d1: own('A') }, paneOwner: { g: own('K', { givenBy: 'A' }), K: own('K') } }

describe('for-agents inventory: the model of the pad', () => {
  test('the desk of an owner: title, every line on, the owner to go to', () => {
    const m = inventoryModel(facts(given), { deskId: 'd1' })
    assert.equal(m.title, 'O que Atrium pode · kai-aware')
    assert.deepEqual(m.owner, { id: 'A', name: 'Atrium' })
    assert.equal(m.free, undefined)
    assert.equal(m.deskHeading, 'A mesa · vale para toda guia que Atrium comanda pela mesa')
    assert.deepEqual(m.deskLines.map(l => l.cap), [...CONDUCTOR_CAPABILITIES.map(c => c.id), 'open-close', 'give-revoke'])
    assert.ok(m.deskLines.every(l => l.on))
    assert.deepEqual(m.writes, [], 'nothing stored: "Ligar tudo" has nothing to do')
  })

  test('a line off on the desk reads off; the panes that differ list under "herdar", the others are counted', () => {
    const m = inventoryModel(facts({ ...given, deskInv: { d1: { interrupt: false } }, paneInv: { c1: { answer: false }, c2: { interrupt: true } } }), { deskId: 'd1' })
    assert.equal(m.deskLines.find(l => l.cap === 'interrupt')!.on, false)
    assert.deepEqual(m.exceptions.map(e => [e.title, e.cap, e.state]), [['soul · testes', 'answer', 'off'], ['soul · outra', 'interrupt', 'on']])
    // A is the owner's own pane (commanded "de si" only if given to itself: here it is the person's), c3 follows the desk.
    assert.deepEqual(m.follow, { count: 1, all: false })
    assert.equal(m.writes.length, 3, 'the desk and the two panes with data')
  })

  test('the panes with another owner come last, and the desk does not reach them: only their own inventory counts', () => {
    const m = inventoryModel(facts({ ...given, deskInv: { d1: { send: false, command: false } }, paneInv: { g: { send: true }, K: { keys: false } } }), { deskId: 'd1' })
    assert.equal(m.othersHeading, 'Guias desta mesa com outro dono')
    assert.deepEqual(m.others.map(o => [o.title, o.ownerName, o.self, o.summary]), [
      ['codex · conferência', 'Kai', false, 'tudo ligado'],
      ['Kai', 'Kai', true, '1 desligado'],
    ])
  })

  test('a desk with no owner says so and offers giving; what was stored is still shown', () => {
    const m = inventoryModel(facts(), { deskId: 'd1' })
    assert.deepEqual(m.free, { text: 'Esta mesa não foi dada a ninguém.', canGive: true })
    assert.equal(m.title, 'O que um agente pode · kai-aware')
    assert.equal(m.deskStored, false)
    const kept = inventoryModel(facts({ deskInv: { d1: { keys: false } } }), { deskId: 'd1' })
    assert.equal(kept.deskStored, true)
    assert.equal(kept.deskLines.find(l => l.cap === 'keys')!.on, false)
  })

  test('an owner that ended leaves the desk free, with its name', () => {
    const m = inventoryModel(facts({ deskOwner: { d1: own('A', { ended: { at: '2026-11-21T15:00:00', name: 'Atrium' } }) } }), { deskId: 'd1' })
    assert.equal(m.owner, undefined)
    assert.equal(m.free!.text, 'Atrium encerrou: esta mesa não tem dono agora.')
  })

  test('the pane\'s line (opened from its tab): its items in three states, and it is not listed twice', () => {
    const m = inventoryModel(facts({ ...given, deskInv: { d1: { interrupt: false } }, paneInv: { c1: { answer: false, interrupt: true } } }), { paneId: 'c1' })
    assert.equal(m.deskId, 'd1', 'the desk comes from the pane')
    assert.equal(m.focus!.title, 'soul · testes')
    assert.equal(m.focus!.note, 'Atrium a comanda pela mesa')
    const by = Object.fromEntries(m.focus!.items.map(i => [i.cap, i]))
    assert.deepEqual([by.send!.state, by.send!.on], ['desk', true])
    assert.deepEqual([by.answer!.state, by.answer!.on], ['off', false])
    assert.deepEqual([by.interrupt!.state, by.interrupt!.deskOn, by.interrupt!.on], ['on', false, true], '"ligado aqui" against a desk that is off')
    assert.deepEqual(m.exceptions, [], 'the pane of the line is not in the list below')
  })

  test('the line of a pane in a desk without owner, and of a pane outside any desk', () => {
    const none = inventoryModel(facts(), { paneId: 'c1' })
    assert.equal(none.focus!.note, 'Nenhum agente comanda esta guia')
    const loose = inventoryModel(facts({ paneOwner: { loose: own('K') } }), { paneId: 'loose' })
    assert.equal(loose.deskId, undefined)
    assert.equal(loose.focus!.outside, true)
    assert.equal(loose.focus!.note, 'Dada a Kai')
    assert.deepEqual(loose.deskLines, [])
    assert.equal(loose.free!.canGive, false)
  })

  test('the capabilities of the data that no conductor list knows are drawn with their id', () => {
    const caps = paneCapabilities([{ weird: false, 'open-close': false }])
    assert.deepEqual(caps.map(c => c.id), [...CONDUCTOR_CAPABILITIES.map(c => c.id), 'weird'], 'a desk-only id is not a pane line')
    assert.equal(caps.at(-1)!.label, 'weird')
  })
})

describe('for-agents inventory: the writes', () => {
  test('the desk keeps only what is off; turning on deletes, and nothing off is no inventory at all', () => {
    assert.deepEqual(withDeskItem(undefined, 'send', false), { send: false })
    assert.deepEqual(withDeskItem({ send: false, keys: false }, 'send', true), { keys: false })
    assert.equal(withDeskItem({ send: false }, 'send', true), undefined)
  })

  test('the pane keeps what the person set: on, off, or "herdar" (deleted)', () => {
    assert.deepEqual(withPaneItem(undefined, 'answer', 'off'), { answer: false })
    assert.deepEqual(withPaneItem({ answer: false }, 'answer', 'on'), { answer: true })
    assert.equal(withPaneItem({ answer: false }, 'answer', 'desk'), undefined)
    assert.deepEqual(withPaneItem({ answer: false, send: true }, 'answer', 'desk'), { send: true })
  })

  test('a click states the opposite of what the line is now; the stored value is what the verb reads', () => {
    assert.equal(nextPaneState({ state: 'desk', deskOn: true }), 'off')
    assert.equal(nextPaneState({ state: 'desk', deskOn: false }), 'on')
    assert.equal(nextPaneState({ state: 'on', deskOn: true }), 'off')
    assert.equal(nextPaneState({ state: 'off', deskOn: true }), 'on')
    const stored = withPaneItem(undefined, 'answer', nextPaneState({ state: 'desk', deskOn: true }))
    assert.equal(capabilityOn('answer', undefined, stored), false)
    assert.equal(capabilityOn('answer', withDeskItem(undefined, 'answer', false), withPaneItem(undefined, 'answer', 'on')), true, 'on here beats a desk that is off')
  })

  test('"Ligar tudo" clears the desk and the panes of that desk, only where there is data', () => {
    const f = facts({ ...given, deskInv: { d1: { send: false }, d2: { send: false } }, paneInv: { c1: { answer: false }, n1: { send: false } } })
    assert.deepEqual(allOnWrites(f, 'd1'), [{ kind: 'desk', id: 'd1', value: undefined }, { kind: 'pane', id: 'c1', value: undefined }])
    assert.deepEqual(allOnWrites(facts(), 'd1'), [])
    assert.deepEqual(allOnWrites(f, undefined, 'n1'), [{ kind: 'pane', id: 'n1', value: undefined }], 'a pane outside any desk: its own line')
  })

  test('a stored value that is not an inventory is ignored', () => {
    assert.equal(asInventory('x'), undefined)
    assert.equal(asInventory([true]), undefined)
    assert.deepEqual(asInventory({ send: false, odd: 'no', n: 1 }), { send: false })
    assert.equal(asInventory({}), undefined)
  })
})
