// The door's `objects.ready` and `desks.ready` are stable: an extension activates before the server attaches the door
// (src/daemon/main.ts), so a promise taken then has to wait for the load from disk, not resolve on the empty memory.
// The real user's home, pipe and tetherd are never touched: a temp home and a bare port.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { after, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { desksPath } from '../../src/daemon/door/desks.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { objectsDir, objectsPath } from '../../src/daemon/door/objects.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

describe('agent door ready before attach', () => {
  const homes: string[] = []
  after(async () => { for (const h of homes) await removeHome(h) })

  test('ready read before attach resolves only after the load, with the disk data visible', async () => {
    const home = tempHome()
    homes.push(home)
    await mkdir(objectsDir(home), { recursive: true })
    await writeFile(objectsPath(home, 'probe'), JSON.stringify({ desk: { d1: { owner: 'agent-a' } }, pane: {} }))
    await writeFile(desksPath(home), JSON.stringify({ desks: [{ id: 'd1', name: 'd1', kind: 'queue', panes: [] }], drawer: [] }))

    const door = new DoorHost({ log: () => {} })
    const own = new DisposableStore()
    const api = door.apiFor('probe', own)
    // What an extension does in activate(): take the promises before the server exists.
    const seen = Promise.all([api.objects.ready, api.desks.ready]).then(() => ({
      owner: api.objects.get('desk', 'd1', 'owner'),
      desks: api.desks.map()?.desks.map((d) => d.id),
    }))

    door.attach({ home, stateOf: () => undefined } as unknown as SlotPort)
    assert.deepEqual(await seen, { owner: 'agent-a', desks: ['d1'] })
    own.dispose()
    await door.mcp.close()
  })
})
