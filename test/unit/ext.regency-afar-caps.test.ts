// RR5 M-2: the ceilings on what a device creates from afar, kept by tetherd (src/daemon/afar-caps.ts). Proved here:
// - AfarCaps: per device and per hour, per house and per hour, and the live ceiling the caller counts; the hour slides;
// - tetherd's Creator ("+ Novo" › agent or terminal): 40 creations in a row from one device create six, the rest are
//   `too-many` before anything is created; another device has its own six up to the house's twelve; the slots made from
//   afar that run (or will, `want: run`) hold the live ceiling across restarts (they are counted from the slots' own meta).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Creator, type CreateDeps } from '../../extensions/regency/daemon.ts'
import { AFAR_CAPS, AFAR_HOUR_MS, AfarCaps, afarDevice } from '../../src/daemon/afar-caps.ts'
import { CREATE_REFUSALS, folderId, parseCreateSlot } from '../../src/remote/create.ts'
import { RES_STATUS } from '../../src/remote/index.ts'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)
const code = (c: string) => (e: unknown): boolean => (e as { code?: string }).code === c

describe('AfarCaps', () => {
  test('six an hour per device, twelve an hour for the house, the live ceiling first; the hour slides', () => {
    let now = 1_000_000
    const caps = new AfarCaps({ now: () => now })
    for (let i = 0; i < 6; i++) assert.equal(caps.take('slots', A, 0), true, `A #${i + 1}`)
    assert.equal(caps.take('slots', A, 0), false, 'the seventh of one device')
    for (let i = 0; i < 6; i++) assert.equal(caps.take('slots', B, 0), true, `B #${i + 1}`)
    assert.equal(caps.take('slots', C, 0), false, 'the house took twelve this hour')
    assert.equal(caps.take('procs', C, 0), true, 'processes are counted apart')
    now += AFAR_HOUR_MS
    assert.equal(caps.take('slots', A, 0), true, 'an hour later')
    assert.equal(caps.take('slots', C, AFAR_CAPS.slots.houseLive), false, 'the live ceiling, whatever the hour')
    assert.equal(caps.take('procs', C, AFAR_CAPS.procs.houseLive), false)
  })

  test('the numbers', () => {
    assert.deepEqual(AFAR_CAPS, { slots: { perDeviceHour: 6, houseHour: 12, houseLive: 16 }, procs: { perDeviceHour: 6, houseHour: 12, houseLive: 8 } })
    assert.equal(afarDevice(A), A)
    for (const v of [undefined, '', 'A'.repeat(32), 'a'.repeat(31), '__proto__', 7]) assert.equal(afarDevice(v), '?')
  })

  test('the device the portal adds to a creation is taken by tetherd in its form only; too-many is 0x07', () => {
    const folder = folderId('C:\\p\\obra', true)
    const act = { what: 'agent', engine: 'claude', deskId: 'desk-1', folder }
    assert.deepEqual(parseCreateSlot({ ...act, device: A }), act, 'the device is not part of the act')
    for (const device of ['x', A.toUpperCase(), 7, '']) assert.equal(parseCreateSlot({ ...act, device }), undefined, String(device))
    assert.equal(CREATE_REFUSALS['too-many'], RES_STATUS.limit)
  })
})

function creatorBench(over: Partial<CreateDeps> = {}) {
  const created: { slotId: string }[] = []
  const slots: Record<string, unknown>[] = []
  const deps: CreateDeps = {
    map: () => ({ desks: [{ id: 'desk-1', name: 'Obra', kind: 'queue' as const, panes: [] }], drawer: [] }),
    slots: {
      list: () => slots as never,
      create: async () => {
        const slotId = `s_${created.length + 1}`
        created.push({ slotId })
        slots.push({ slotId, kind: 'claude', cwd: 'C:\\p\\obra', status: 'running', createdBy: { ext: 'regency' } })
        return { slotId } as never
      },
    },
    engines: async () => ['claude'],
    profiles: async () => [],
    defaultFor: () => undefined,
    appFolders: async () => ({ pinned: ['C:\\p\\obra'], recent: [] }),
    exists: async () => true,
    caseInsensitive: true,
    ...over,
  }
  return { creator: new Creator(deps), created, slots }
}

describe("tetherd's Creator: the ceilings of what is created from afar", () => {
  const folder = folderId('C:\\p\\obra', true)
  const agent = (device: string) => ({ what: 'agent', engine: 'claude', deskId: 'desk-1', folder, device })
  const remote = { client: 'remote' }

  test('40 create.agent in a row from one device: six are created, the rest too-many, nothing more created', async () => {
    const b = creatorBench()
    const out: string[] = []
    for (let i = 0; i < 40; i++) out.push(await b.creator.create(agent(A), remote).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error'))
    assert.deepEqual(out.slice(0, 6), Array(6).fill('ok'))
    assert.deepEqual(out.slice(6), Array(34).fill('too-many'))
    assert.equal(b.created.length, 6)
    // Another device has its own six; a third finds the house's twelve taken.
    for (let i = 0; i < 6; i++) await b.creator.create(agent(B), remote)
    await assert.rejects(b.creator.create(agent(C), remote), code('too-many'))
    // A creation without a device counts as the one unnamed device, under the same house ceiling.
    await assert.rejects(b.creator.create({ what: 'terminal', engine: 'shell', deskId: 'desk-1', folder }, remote), code('too-many'))
    assert.equal(b.created.length, 12)
  })

  test('the live ceiling counts the slots made from afar that run or will run, from their own meta', async () => {
    const b = creatorBench({ caps: new AfarCaps({ caps: { slots: { perDeviceHour: 100, houseHour: 100, houseLive: 3 }, procs: AFAR_CAPS.procs } }) })
    // Two of the person's own (no createdBy from this extension) and one that ended do not count.
    b.slots.push({ slotId: 'mine', status: 'running' }, { slotId: 'other', status: 'running', createdBy: { ext: 'for-agents' } }, { slotId: 'ended', status: 'exited', want: 'ended', createdBy: { ext: 'regency' } })
    b.slots.push({ slotId: 'back', status: 'exited', want: 'run', createdBy: { ext: 'regency' } })
    for (let i = 0; i < 2; i++) await b.creator.create(agent(A), remote)
    await assert.rejects(b.creator.create(agent(B), remote), code('too-many'), 'three live from afar (one comes back at the next start)')
    const back = b.slots.find((s) => s.slotId === 'back')!
    back.want = 'ended'
    await b.creator.create(agent(B), remote)
  })
})
