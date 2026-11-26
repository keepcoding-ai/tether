// The pipe's `create { desk }` and the rule of ownership (Regência gate, R-2): a system desk is always refused; a request that
// carries an agent pane's identity (slotId + key) gets only a desk that agent owns, by the rule `agents open` applies; the
// person (no identity, or her own shell pane) gets any ordinary desk. Test home and pipe only.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeskMap } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { ownsDesk } from '../../extensions/for-agents/daemon/ownership.ts'
import { Recorder, removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

const MAP: DeskMap = {
  desks: [
    { id: 'mine', name: 'Minha', kind: 'queue', panes: [] },
    { id: 'theirs', name: 'De outro', kind: 'queue', panes: [] },
    { id: 'plain', name: 'Da pessoa', kind: 'queue', panes: [] },
    { id: 'regency', name: 'Regência', kind: 'system', panes: [] },
    { id: 'browser', name: 'Browser', kind: 'system', panes: [] },
  ],
  drawer: [],
}

const denied = (e: unknown): boolean => e instanceof DaemonError && e.code === 'door-denied'
const refused = (e: unknown): boolean => e instanceof DaemonError && e.code === 'bad-request'

describe('pipe create with a desk: system desks and ownership (R-2)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  let host: DoorHost
  let agentId: string
  let agentKey: string
  let shellId: string
  let shellKey: string
  const owned: [string, { owner: string; since: string; ended?: { at: string; name: string } }][] = []

  before(async () => {
    home = tempHome()
    host = new DoorHost({ log: () => {} })
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, door: host, log: () => {} })
    rec = await Recorder.connect(daemon.pipe)
    await rec.client.request({ t: 'desk-map', map: MAP })
    agentId = (await rec.client.request({ t: 'create', kind: 'claude', cwd: home } as never)).slot!.slotId
    shellId = (await rec.client.request({ t: 'create', kind: 'shell', cwd: home } as never)).slot!.slotId
    agentKey = host.slotKeys.issue(agentId)
    shellKey = host.slotKeys.issue(shellId)
    owned.push(['mine', { owner: agentId, since: '' }], ['theirs', { owner: 'someone-else', since: '' }])
    host.desks.useOwnership((slotId, deskId) => ownsDesk({ ownedDesks: () => owned as never }, slotId, deskId))
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  const create = (extra: Record<string, unknown>) => rec.client.request({ t: 'create', kind: 'shell', cwd: home, ...extra } as never)
  const asAgent = (desk: string, key: string | undefined = agentKey) => create({ desk, slotId: agentId, ...(key ? { key } : {}) })

  test('the person: any ordinary desk, but never a system desk', async () => {
    assert.deepEqual((await create({ desk: 'plain' })).slot?.paneRequest, { deskId: 'plain' })
    assert.deepEqual((await create({ desk: 'theirs' })).slot?.paneRequest, { deskId: 'theirs' })
    await assert.rejects(create({ desk: 'Regência' }), (e: unknown) => refused(e) && /sistema/.test((e as Error).message))
    await assert.rejects(create({ desk: 'browser' }), refused)
  })

  test('an agent: its own desk only; another agent\'s, the person\'s and system desks are refused', async () => {
    assert.deepEqual((await asAgent('mine')).slot?.paneRequest, { deskId: 'mine' })
    await assert.rejects(asAgent('theirs'), (e: unknown) => denied(e) && /não é sua/.test((e as Error).message))
    await assert.rejects(asAgent('plain'), denied)
    await assert.rejects(asAgent('regency'), refused)
    await assert.rejects(asAgent('Browser'), refused)
  })

  test('an owner that was forgotten no longer owns the desk', async () => {
    owned[0] = ['mine', { owner: agentId, since: '', ended: { at: '', name: 'x' } }]
    await assert.rejects(asAgent('mine'), denied)
    owned[0] = ['mine', { owner: agentId, since: '' }]
  })

  test('an identity that does not prove itself is refused; a shell pane is the person\'s own terminal', async () => {
    await assert.rejects(asAgent('mine', 'chave-errada'), denied)
    await assert.rejects(asAgent('mine', ''), denied)
    const r = await create({ desk: 'theirs', slotId: shellId, key: shellKey })
    assert.deepEqual(r.slot?.paneRequest, { deskId: 'theirs' })
    await assert.rejects(create({ desk: 'Regência', slotId: shellId, key: shellKey }), refused)
  })

  test('no slot is born by a refusal', async () => {
    const before = ((await rec.client.request({ t: 'list' })).slots ?? []).length
    await assert.rejects(asAgent('theirs'), denied)
    await assert.rejects(create({ desk: 'regency' }), refused)
    assert.equal(((await rec.client.request({ t: 'list' })).slots ?? []).length, before)
  })
})
