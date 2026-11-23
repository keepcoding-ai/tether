// The desk owner feed of for-agents: give, hand over, revoke and the forgotten owner reach the readers; off, it is empty.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bindDeskOwners, createDeskOwnerFeed, type DeskOwnerFact } from '../../extensions/for-agents/desk-owners.ts'

type Change = { kind: string; id: string; key: string; value: unknown }

function fakeObjects(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  const changes = new Set<(e: Change) => void>()
  const drops = new Set<(e: { kind: string; id: string; data: Record<string, unknown> }) => void>()
  let release: () => void = () => {}
  const ready = new Promise<void>((r) => { release = r })
  const objects = {
    ready,
    entries: <T>(kind: string, key: string): [string, T][] => (kind === 'desk' && key === 'owner' ? [...data].map(([k, v]) => [k, v as T]) : []),
    onDidChange: (l: (e: Change) => void) => { changes.add(l); return { dispose: () => { changes.delete(l) } } },
    onDidDrop: (l: (e: { kind: string; id: string; data: Record<string, unknown> }) => void) => { drops.add(l); return { dispose: () => { drops.delete(l) } } },
  }
  return {
    objects: objects as never,
    release,
    set(id: string, value: unknown, kind = 'desk') { if (value === undefined) data.delete(id); else data.set(id, value); for (const l of [...changes]) l({ kind, id, key: 'owner', value }) },
    drop(id: string) { data.delete(id); for (const l of [...drops]) l({ kind: 'desk', id, data: {} }) },
  }
}

const own = (owner: string, extra: object = {}) => ({ owner, since: '2026-11-22T10:00:00Z', givenBy: 'user', ...extra })

describe('desk owner feed', () => {
  test('give, hand over, revoke and the forgotten owner notify; equal facts do not', async () => {
    const feed = createDeskOwnerFeed()
    const o = fakeObjects({ d1: own('s1') })
    const bound = bindDeskOwners(o.objects, feed)
    assert.equal(feed.active, true)
    const seen: [string, DeskOwnerFact | undefined][] = []
    feed.onDidChange((id, f) => seen.push([id, f]))
    o.release()
    await feed.ready
    assert.deepEqual(feed.get('d1'), { deskId: 'd1', owner: 's1', since: '2026-11-22T10:00:00Z' })
    assert.equal(seen.length, 1)

    o.set('d2', own('s2'))
    o.set('d2', own('s2'))
    assert.equal(seen.length, 2)
    o.set('d1', own('s3'))
    assert.equal(feed.get('d1')?.owner, 's3')
    o.set('d1', own('s3', { ended: { at: '2026-11-22T11:00:00Z', name: 'conferente' } }))
    assert.equal(feed.get('d1')?.ended?.name, 'conferente')
    o.set('d1', undefined)
    assert.equal(feed.get('d1'), undefined)
    assert.deepEqual(seen.at(-1), ['d1', undefined])
    o.drop('d2')
    assert.deepEqual(feed.all(), [])
    o.set('p1', own('s9'), 'pane')
    assert.deepEqual(feed.all(), [])
    for (const d of bound) d.dispose()
  })

  test('disposed: inactive and empty, silent, deaf to later changes', async () => {
    const feed = createDeskOwnerFeed()
    const o = fakeObjects({ d1: own('s1') })
    const bound = bindDeskOwners(o.objects, feed)
    o.release()
    await feed.ready
    assert.equal(feed.all().length, 1)
    let notified = 0
    feed.onDidChange(() => { notified++ })
    for (const d of bound) d.dispose()
    assert.equal(feed.active, false)
    assert.deepEqual(feed.all(), [])
    assert.equal(notified, 0)
    o.set('d2', own('s2'))
    assert.deepEqual(feed.all(), [])
  })

  test('ready waits for the objects; a fresh activation starts over', async () => {
    const feed = createDeskOwnerFeed()
    const o = fakeObjects({ d1: own('s1') })
    bindDeskOwners(o.objects, feed)
    let done = false
    feed.ready.then(() => { done = true })
    await new Promise((r) => setImmediate(r))
    assert.equal(done, false)
    o.release()
    await feed.ready
    assert.equal(feed.get('d1')?.owner, 's1')
  })
})
