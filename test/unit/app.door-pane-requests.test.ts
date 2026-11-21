// The daemon's pane request: create, ignore or wait; and the loop that applies it through a port.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPaneRequests, decidePaneRequest, type PaneRequestInput, type PaneRequestPort } from '../../app/renderer/door/pane-requests.ts'
import { DoorHost, type DoorPort } from '../../app/renderer/door/host.ts'
import { emptyLayout } from '../../app/renderer/layout.ts'
import type { DeskMap, SlotState } from '../../src/daemon/protocol.ts'

const base: PaneRequestInput = { deskId: 'd2', hasPane: false, layoutRestored: true, desk: { asleep: false } }
const slot = (slotId: string, deskId?: string): SlotState => ({ slotId, ...(deskId ? { paneRequest: { deskId } } : {}) }) as SlotState

describe('decidePaneRequest', () => {
  test('a request with no pane and a mounted desk creates the pane there', () => {
    assert.deepEqual(decidePaneRequest(base), { action: 'create', deskId: 'd2', asleep: false })
  })
  test('in a hibernated desk the pane is created asleep', () => {
    assert.deepEqual(decidePaneRequest({ ...base, desk: { asleep: true } }), { action: 'create', deskId: 'd2', asleep: true })
  })
  test('no request: nothing', () => {
    assert.deepEqual(decidePaneRequest({ ...base, deskId: undefined }), { action: 'ignore', reason: 'no-request', resend: false })
  })
  test('a slot that already has a pane is not moved, and the map must go so the daemon clears the request', () => {
    assert.deepEqual(decidePaneRequest({ ...base, hasPane: true }), { action: 'ignore', reason: 'has-pane', resend: true })
  })
  test('the layout not restored yet: wait, whatever else is true', () => {
    assert.deepEqual(decidePaneRequest({ ...base, layoutRestored: false }), { action: 'defer', reason: 'layout-not-restored' })
    assert.deepEqual(decidePaneRequest({ ...base, layoutRestored: false, desk: undefined, hasPane: true }), { action: 'defer', reason: 'layout-not-restored' })
  })
  test('a desk that is not mounted: ignored, and the map is resent so the daemon clears the request', () => {
    assert.deepEqual(decidePaneRequest({ ...base, desk: undefined }), { action: 'ignore', reason: 'no-desk', resend: true })
  })
})

type Fake = PaneRequestPort & { added: string[]; resent: number; logs: string[] }

function fakePort(over: Partial<PaneRequestPort> = {}): Fake {
  const p: Fake = {
    added: [], resent: 0, logs: [],
    layoutRestored: () => true,
    hasPane: () => false,
    desk: id => (id === 'd2' ? { asleep: false } : id === 'zz' ? { asleep: true } : undefined),
    addPane: (s, deskId, asleep) => { p.added.push(`${s.slotId}@${deskId}${asleep ? ':asleep' : ''}`) },
    resendMap: () => { p.resent++ },
    log: m => { p.logs.push(m) },
    ...over,
  }
  return p
}

describe('applyPaneRequests', () => {
  test('creates one pane per pending request, in the desk asked, and skips slots with no request', () => {
    const port = fakePort()
    const waiting = applyPaneRequests([slot('a', 'd2'), slot('b'), slot('c', 'zz')], port)
    assert.deepEqual(port.added, ['a@d2', 'c@zz:asleep'])
    assert.deepEqual(waiting, [])
    assert.equal(port.resent, 0)
  })
  test('a slot with a pane elsewhere is left alone and the map is resent once', () => {
    const port = fakePort({ hasPane: () => true })
    applyPaneRequests([slot('a', 'd2'), slot('b', 'd2')], port)
    assert.deepEqual(port.added, [])
    assert.equal(port.resent, 1)
  })
  test('before the layout is restored the requests wait and are named', () => {
    const port = fakePort({ layoutRestored: () => false })
    assert.deepEqual(applyPaneRequests([slot('a', 'd2')], port), ['a'])
    assert.deepEqual(port.added, [])
  })
  test('an unknown desk is logged and the slot stays without a pane', () => {
    const port = fakePort()
    applyPaneRequests([slot('a', 'nope')], port)
    assert.deepEqual(port.added, [])
    assert.equal(port.logs.length, 1)
    assert.equal(port.resent, 1)
  })
})

describe('DoorHost wiring', () => {
  function hostWith(over: Partial<DoorPort> = {}) {
    const sent: DeskMap[] = []
    const added: string[] = []
    const slept: string[] = []
    const all = [slot('a', 'd2')]
    const { resendMap: _r, ...rest } = fakePort()
    const port: DoorPort = {
      ...rest, layout: () => emptyLayout(), paneType: c => c, systemDeskName: () => undefined,
      sendDeskMap: m => { sent.push(m) }, slots: () => all, sleep: id => { slept.push(id) },
      addPane: s => { added.push(s.slotId) },
      ...over,
    }
    return { door: new DoorHost(port), sent, added, slept }
  }
  test('a list before the restore creates nothing; the restore does, and the map goes', () => {
    let restored = false
    const { door, added, sent } = hostWith({ layoutRestored: () => restored })
    door.slotsListed([slot('a', 'd2')])
    assert.deepEqual(added, [])
    assert.equal(sent.length, 0)
    restored = true
    door.layoutRestored()
    assert.deepEqual(added, ['a'])
    assert.equal(sent.length, 1)
    door.stateApplied(slot('a', 'd2'))
    assert.deepEqual(added, ['a', 'a'])
  })
  test('the map goes on the first save, not on a repeat, and again after a reconnection', () => {
    const { door, sent } = hostWith()
    door.layoutSaved(); door.layoutSaved()
    assert.equal(sent.length, 1)
    door.slotsListed([])
    assert.equal(sent.length, 2)
  })
  test('a pane that enters asleep stays asleep through the process coming up, and is left alone once it runs', () => {
    const { door, slept } = hostWith({ desk: () => ({ asleep: true }) })
    door.stateApplied({ ...slot('a', 'd2'), status: 'stopped' } as unknown as SlotState)
    assert.deepEqual(slept, ['a', 'a'])
    door.stateApplied({ ...slot('a'), status: 'starting' } as unknown as SlotState)
    assert.equal(slept.length, 3)
    door.stateApplied({ ...slot('a'), status: 'running' } as unknown as SlotState)
    assert.equal(slept.length, 4)
    door.stateApplied({ ...slot('a'), status: 'running' } as unknown as SlotState)
    assert.equal(slept.length, 4, 'after the first running state the person decides')
  })
  test('with no port the host stays inert', () => {
    const door = new DoorHost()
    door.stateApplied(slot('a', 'd2')); door.slotsListed([slot('a', 'd2')]); door.layoutSaved(); door.layoutRestored()
  })
})
