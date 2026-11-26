// The pipe's `create` with a target desk (R4b): a remote client (no app at hand) asks a slot's pane in a desk. The daemon checks
// the desk against the map it knows (id, or a unique name; a missing or sleeping desk is refused) and writes `paneRequest` before
// the reply; the next `desk-map` that shows the slot clears it. Without `desk` nothing changes. Test home and pipe only.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeskMap } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

const mapOf = (shown: Record<string, string[]> = {}): DeskMap => ({
  desks: [
    { id: 'd1', name: 'Mesa 1', kind: 'queue', panes: (shown.d1 ?? []).map((id) => ({ id, type: 'terminal' })) },
    { id: 'd2', name: 'Dormente', kind: 'queue', asleep: true, panes: [] },
    { id: 'd3', name: 'Repetida', kind: 'queue', panes: [] },
    { id: 'd4', name: 'Repetida', kind: 'queue', panes: [] },
    { id: 'd5', name: 'Trabalho', kind: 'queue', panes: (shown.d5 ?? []).map((id) => ({ id, type: 'terminal' })) },
  ],
  drawer: [],
})

const refused = (e: unknown): boolean => e instanceof DaemonError && e.code === 'bad-request'

describe('pipe create with a target desk (R4b)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder

  before(async () => {
    home = tempHome()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, door: new DoorHost({ log: () => {} }), log: () => {} })
    rec = await Recorder.connect(daemon.pipe)
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  const create = (extra: Record<string, unknown> = {}) => rec.client.request({ t: 'create', kind: 'shell', cwd: home, ...extra } as never)

  test('without the field: no paneRequest, exactly as before', async () => {
    const r = await create()
    assert.equal(r.slot?.paneRequest, undefined)
  })

  test('before any map: the desk is kept as asked', async () => {
    const r = await create({ desk: 'qualquer' })
    assert.deepEqual(r.slot?.paneRequest, { deskId: 'qualquer' })
  })

  test('with a known map: an id or a unique name is born in that desk; a map that shows the slot clears the request', async () => {
    await rec.client.request({ t: 'desk-map', map: mapOf() })
    const byId = await create({ desk: 'd1' })
    assert.deepEqual(byId.slot?.paneRequest, { deskId: 'd1' })
    const byName = await create({ desk: 'Trabalho' })
    assert.deepEqual(byName.slot?.paneRequest, { deskId: 'd5' })
    await rec.client.request({ t: 'desk-map', map: mapOf({ d1: [byId.slot!.slotId] }) })
    const after = (await rec.client.request({ t: 'list' })).slots ?? []
    assert.equal(after.find((s) => s.slotId === byId.slot!.slotId)?.paneRequest, undefined)
    assert.deepEqual(after.find((s) => s.slotId === byName.slot!.slotId)?.paneRequest, { deskId: 'd5' })
  })

  test('refused with a reason: unknown desk, sleeping desk, ambiguous name, bad value; no slot is born', async () => {
    const before = ((await rec.client.request({ t: 'list' })).slots ?? []).length
    await assert.rejects(create({ desk: 'nao-existe' }), (e: unknown) => refused(e) && /não existe/.test((e as Error).message))
    await assert.rejects(create({ desk: 'd2' }), (e: unknown) => refused(e) && /dormindo/.test((e as Error).message))
    await assert.rejects(create({ desk: 'Repetida' }), (e: unknown) => refused(e) && /mais de uma/.test((e as Error).message))
    await assert.rejects(create({ desk: '' }), refused)
    await assert.rejects(create({ desk: 7 }), refused)
    assert.equal(((await rec.client.request({ t: 'list' })).slots ?? []).length, before)
  })
})
