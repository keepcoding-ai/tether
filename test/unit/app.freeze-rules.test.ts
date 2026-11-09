import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FreezeMachine, FreezeRegistry, type FreezeOps } from '../../app/shared/freeze-rules.ts'

/** A container that holds the listed elements. */
const box = (...els: string[]) => ({ contains: (e: string | null) => e !== null && els.includes(e) })

test('registry: a counter of holds with reasons; disposers are idempotent; nested holds release on the last', () => {
  const r = new FreezeRegistry<string>()
  let changes = 0
  r.onChange(() => { changes++ })
  assert.equal(r.count(), 0)
  assert.equal(r.freezes('a'), false)
  const menu = r.hold('menu')
  const palette = r.hold('palette')
  assert.deepEqual(r.reasons(), ['menu', 'palette'])
  assert.equal(r.freezes('a'), true)
  palette()
  palette()
  assert.equal(r.count(), 1, 'a second dispose does nothing')
  assert.equal(r.freezes('a'), true, 'still one hold: still frozen')
  menu()
  assert.equal(r.freezes('a'), false)
  assert.equal(changes, 4)
})

test('registry: a hold that spares a container (the drawer) freezes only what is outside it', () => {
  const r = new FreezeRegistry<string>()
  const drawer = r.hold('drawer', box('in-drawer'))
  assert.equal(r.freezes('in-drawer'), false, 'the drawer surface stays alive')
  assert.equal(r.freezes('on-desk'), true, 'the desk behind freezes')
  const palette = r.hold('palette')
  assert.equal(r.freezes('in-drawer'), true, 'the palette over the drawer freezes the drawer too')
  palette()
  drawer()
  assert.equal(r.freezes('on-desk'), false)
})

interface Log { calls: string[]; picture: boolean; parked: boolean }

/** Ops whose steps resolve when the test says so (gate) or at once. */
function fakeOps(opts: { gate?: Set<string>; failCapture?: boolean } = {}) {
  const log: Log = { calls: [], picture: false, parked: false }
  const waiting = new Map<string, () => void>()
  const step = (name: string, fn: () => void): Promise<void> => {
    log.calls.push(name)
    if (!opts.gate?.has(name)) { fn(); return Promise.resolve() }
    return new Promise(res => waiting.set(name, () => { waiting.delete(name); fn(); res() }))
  }
  const ops: FreezeOps<string> = {
    capture: () => step('capture', () => {}).then(() => (opts.failCapture ? undefined : 'img')),
    paint: () => step('paint', () => { log.picture = true }),
    unpaint: () => { log.calls.push('unpaint'); log.picture = false },
    park: () => step('park', () => { assert.ok(log.picture, 'parked only with the picture painted'); log.parked = true }),
    unpark: () => step('unpark', () => { log.parked = false }),
  }
  const release = async (name: string) => { for (let i = 0; i < 50 && !waiting.has(name); i++) await Promise.resolve(); waiting.get(name)!() }
  return { ops, log, release }
}

test('machine: freeze = capture, paint, park; thaw = unpark, then unpaint (the picture goes after the surface is back)', async () => {
  const { ops, log } = fakeOps()
  const m = new FreezeMachine(ops)
  m.set(true)
  await m.idle()
  assert.deepEqual(log.calls, ['capture', 'paint', 'park'])
  assert.equal(m.state, 'frozen')
  assert.equal(log.picture && log.parked, true)
  m.set(false)
  await m.idle()
  assert.deepEqual(log.calls.slice(3), ['unpark', 'unpaint'])
  assert.equal(m.state, 'live')
  assert.equal(log.picture || log.parked, false)
})

test('machine: open-and-close before the capture returns paints nothing and parks nothing', async () => {
  const { ops, log, release } = fakeOps({ gate: new Set(['capture']) })
  const m = new FreezeMachine(ops)
  m.set(true)
  m.set(false)
  await release('capture')
  await m.idle()
  assert.deepEqual(log.calls, ['capture'])
  assert.equal(log.picture, false)
})

test('machine: close while the picture is being painted removes it without parking', async () => {
  const { ops, log, release } = fakeOps({ gate: new Set(['paint']) })
  const m = new FreezeMachine(ops)
  m.set(true)
  await release('capture').catch(() => {}) // capture is not gated
  for (let i = 0; i < 10; i++) await Promise.resolve()
  m.set(false)
  await release('paint')
  await m.idle()
  assert.deepEqual(log.calls, ['capture', 'paint', 'unpaint'])
  assert.equal(log.parked, false)
})

test('machine: reopened while coming back: back first, then a fresh freeze', async () => {
  const { ops, log, release } = fakeOps({ gate: new Set(['unpark']) })
  const m = new FreezeMachine(ops)
  m.set(true)
  await m.idle()
  m.set(false)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  m.set(true)
  await release('unpark')
  await m.idle()
  assert.deepEqual(log.calls, ['capture', 'paint', 'park', 'unpark', 'unpaint', 'capture', 'paint', 'park'])
  assert.equal(m.state, 'frozen')
})

test('machine: a failed capture does not loop; dropping the wish allows a retry', async () => {
  const { ops, log } = fakeOps({ failCapture: true })
  const m = new FreezeMachine(ops)
  m.set(true)
  await m.idle()
  assert.deepEqual(log.calls, ['capture'])
  m.set(true)
  await m.idle()
  assert.deepEqual(log.calls, ['capture'], 'still wanted after a failure: no retry')
  m.set(false)
  m.set(true)
  await m.idle()
  assert.deepEqual(log.calls, ['capture', 'capture'])
})

test('machine: force (the safety valve) takes the picture off at once and asks the surface back', async () => {
  const { ops, log } = fakeOps()
  const m = new FreezeMachine(ops)
  m.set(true)
  await m.idle()
  m.force()
  assert.equal(log.picture, false, 'synchronous')
  assert.equal(m.state, 'live')
  await m.idle()
  assert.deepEqual(log.calls.slice(3), ['unpaint', 'unpark'])
})

test('machine: disposed while frozen (pane closed): the picture goes and the surface is asked back; later wishes do nothing', async () => {
  const { ops, log } = fakeOps()
  const m = new FreezeMachine(ops)
  m.set(true)
  await m.idle()
  m.dispose()
  assert.equal(log.picture, false)
  m.set(true)
  await m.idle()
  assert.deepEqual(log.calls, ['capture', 'paint', 'park', 'unpaint', 'unpark'])
})

test('machine: disposed during the capture: nothing is painted', async () => {
  const { ops, log, release } = fakeOps({ gate: new Set(['capture']) })
  const m = new FreezeMachine(ops)
  m.set(true)
  m.dispose()
  await release('capture')
  await m.idle()
  assert.deepEqual(log.calls, ['capture'])
  assert.equal(log.picture, false)
})
