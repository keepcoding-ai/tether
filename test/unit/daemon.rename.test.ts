// The slot name chosen by the user (tab rename in the app, `tether rename` in the CLI): stored in the slot's
// meta by the daemon, broadcast to every client, kept across a daemon restart, removed by an empty name.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { slotMetaPath } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

const metaName = (slotId: string): unknown => JSON.parse(readFileSync(slotMetaPath(home, slotId), 'utf8')).name

test('rename-slot: the name lands in the meta, reaches other clients, survives a daemon restart, and an empty name removes it', async () => {
  const a = await Recorder.connect(daemon.pipe)
  const b = await Recorder.connect(daemon.pipe)
  const created = await a.client.request({ t: 'create', kind: 'shell', cwd })
  const slotId = created.slot!.slotId
  assert.equal(created.slot!.name, undefined)

  const renamed = await a.client.request({ t: 'rename-slot', slotId, name: 'minha aba' })
  assert.equal(renamed.slot!.name, 'minha aba')
  assert.equal(metaName(slotId), 'minha aba')
  await waitUntil(() => b.states.some((s) => s.slotId === slotId && s.name === 'minha aba'), 5_000, 'state event on the other client')

  a.client.close()
  b.client.close()
  await daemon.close()
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })

  const c = await Recorder.connect(daemon.pipe)
  const list = await c.client.request({ t: 'list' })
  assert.equal(list.slots!.find((s) => s.slotId === slotId)?.name, 'minha aba')

  const cleared = await c.client.request({ t: 'rename-slot', slotId, name: '' })
  assert.equal(cleared.slot!.name, undefined)
  assert.equal(metaName(slotId), undefined)
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(slotMetaPath(home, slotId), 'utf8')), 'name'), false)
  c.client.close()
})
