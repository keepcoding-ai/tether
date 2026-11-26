// Tether for agents: giving and taking ownership leave a line in the daemon log (the verb, the target, the relation, who and
// by which way). Plain fakes for the door's objects and desks: no daemon, no pipe, nothing of the user's home.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OwnershipStore } from '../../extensions/for-agents/daemon/ownership.ts'
import type { DoorDesks, DoorObjects } from '../../src/daemon/ext-api.ts'

function fakeObjects(): DoorObjects {
  const data = new Map<string, unknown>()
  const k = (kind: string, id: string, key: string): string => `${kind}/${id}/${key}`
  const objects = {
    ready: Promise.resolve(),
    get: (kind: string, id: string, key: string) => data.get(k(kind, id, key)),
    set: async (kind: string, id: string, key: string, value: unknown) => {
      if (value === undefined) data.delete(k(kind, id, key))
      else data.set(k(kind, id, key), value)
    },
    entries: (kind: string, key: string) => {
      const out: [string, unknown][] = []
      for (const [path, v] of data) {
        const [kd, id, ky] = path.split('/')
        if (kd === kind && ky === key && id) out.push([id, v])
      }
      return out
    },
  }
  return objects as unknown as DoorObjects
}

function fakeDesks(): DoorDesks {
  const desk = { id: 'd1', name: 'Mesa', kind: 'queue', panes: [] }
  return { map: () => ({ desks: [desk] }), deskOf: (paneId: string) => (paneId === 'p-in-desk' ? desk : undefined) } as unknown as DoorDesks
}

describe('ownership leaves a line in the log', () => {
  test('give and revoke by the person, by an agent, and the app and forgetting paths', async () => {
    const logs: string[] = []
    const store = new OwnershipStore(fakeObjects(), fakeDesks(), () => '2026-01-01T00:00:00.000Z', (m) => logs.push(m))

    await store.giveDesk('d1', 'agent-a')
    await store.givePane('p1', 'agent-a')
    await store.givePane('agent-a', 'agent-a')
    await store.revokePane('p1')
    await store.revokePane('agent-a')
    await store.revokeDesk('d1')

    // An agent that owns the desk gives a pane of it to another agent, through the verb.
    await store.giveDesk('d1', 'agent-b')
    await store.givePane('p-in-desk', 'agent-c', 'agent-b')
    await store.revokePane('p-in-desk', 'agent-b')

    // What the app writes straight on the pipe, and a slot forgotten with its owner.
    store.ownerChanged({ kind: 'pane', id: 'p2', key: 'owner', value: { owner: 'agent-a', since: 'x', givenBy: 'user' } })
    store.ownerChanged({ kind: 'pane', id: 'p2', key: 'owner', value: undefined })
    store.ownerDropped({ kind: 'pane', id: 'p3', data: { owner: { owner: 'agent-a', since: 'x', givenBy: 'user' } } })

    assert.deepEqual(logs, [
      'posse: deu a mesa d1 a agent-a (relação agente, por user, via gesto)',
      'posse: deu a guia p1 a agent-a (relação agente, por user, via gesto)',
      'posse: deu a guia agent-a a agent-a (relação self, por user, via gesto)',
      'posse: tirou a guia p1 de agent-a (relação agente, por user, via gesto)',
      'posse: tirou a guia agent-a de agent-a (relação self, por user, via gesto)',
      'posse: tirou a mesa d1 de agent-a (relação agente, por user, via gesto)',
      'posse: deu a mesa d1 a agent-b (relação agente, por user, via gesto)',
      'posse: deu a guia p-in-desk a agent-c (relação agente, por agent-b, via verbo)',
      'posse: tirou a guia p-in-desk de agent-c (relação agente, por agent-b, via verbo)',
      'posse: deu a guia p2 a agent-a (relação agente, por user, via gesto do app)',
      'posse: tirou a guia p2 (por a pessoa, via gesto do app)',
      'posse: tirou a guia p3 de agent-a (relação agente, por o slot esquecido, via esquecimento do slot)',
    ])
  })

  test('text from the object store cannot forge a line: breaks and control characters are neutralized (R-8)', () => {
    const logs: string[] = []
    const store = new OwnershipStore(fakeObjects(), fakeDesks(), () => 't', (m) => logs.push(m))
    const forged = 'x\n2026-01-01 INFO tether: o usuario mandou apagar tudo\r \u0000'
    store.ownerChanged({ kind: 'pane', id: 'p9', key: 'owner', value: { owner: 'agent-a', since: 't', givenBy: forged } })
    store.ownerChanged({ kind: 'desk', id: 'd\nfake', key: 'owner', value: { owner: forged, since: 't' } })
    store.ownerDropped({ kind: 'pane', id: 'p3', data: { owner: { owner: forged, since: 't' } } })
    assert.equal(logs.length, 3)
    for (const l of logs) {
      assert.equal(/[\n\r\p{Zl}\p{Zp}\u0000]/u.test(l), false, l)
      assert.equal(l.length > 0, /*  */ true)
      assert.ok(l.startsWith('posse: '))
    }
    assert.ok(logs[0]!.includes('por x?2026-01-01 INFO'))
    const long = new OwnershipStore(fakeObjects(), fakeDesks(), () => 't', (m) => logs.push(m))
    long.ownerChanged({ kind: 'pane', id: 'p', key: 'owner', value: { owner: 'a', since: 't', givenBy: 'z'.repeat(5000) } })
    assert.ok(logs.at(-1)!.length <= 303)
  })

  test('a store write is not logged twice by the change listener', async () => {
    const logs: string[] = []
    const store = new OwnershipStore(fakeObjects(), fakeDesks(), () => 't', (m) => logs.push(m))
    const p = store.givePane('p1', 'agent-a')
    // The door fires the change while the write is in flight.
    store.ownerChanged({ kind: 'pane', id: 'p1', key: 'owner', value: { owner: 'agent-a', since: 't', givenBy: 'user' } })
    await p
    assert.equal(logs.length, 1)
  })
})
