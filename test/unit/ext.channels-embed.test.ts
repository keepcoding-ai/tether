// Feed C of the channels extension (renderer/embed.ts): what the Regency reads of the channels and the mount of the channel's
// view. Off it is empty and mounts nothing; on it reads the source; a change of the source and each turn on or off notify.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createChannelEmbeds, type ChannelEmbedSource, type EmbeddedChannel, type EmbedMarks } from '../../extensions/channels/renderer/embed.ts'
import type { ChannelSummary } from '../../extensions/channels/daemon/requests.ts'

const summary = (id: string, extra: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id, name: id, title: id, owner: { kind: 'user' }, members: 0, seenByUser: 0, createdAt: '2026-11-25T10:00:00Z', ...extra,
})

function fakeSource(channels: ChannelSummary[], marks: Record<string, EmbedMarks> = {}) {
  const listeners = new Set<() => void>()
  const mounts: Array<{ host: unknown; channelId: string; opts: unknown }> = []
  const source: ChannelEmbedSource = {
    list: () => channels,
    marksOf: id => marks[id] ?? { unread: 0, toMe: 0, asks: 0, owed: 0 },
    onDidChange: l => { listeners.add(l); return { dispose: () => { listeners.delete(l) } } },
    mount: (host, channelId, opts) => {
      mounts.push({ host, channelId, opts })
      return { element: host, channelId, members: () => [], onDidChangeMembers: () => ({ dispose() {} }), focus() {}, dispose() {} } as EmbeddedChannel
    },
  }
  return { source, mounts, listeners, change: () => { for (const l of [...listeners]) l() } }
}

const host = {} as HTMLElement

describe('channel embeds feed', () => {
  test('inactive: empty list, zero marks, and mount gives undefined', () => {
    const feed = createChannelEmbeds()
    assert.equal(feed.active, false)
    assert.deepEqual(feed.list(), [])
    assert.deepEqual(feed.marksOf('c1'), { unread: 0, toMe: 0, asks: 0, owed: 0 })
    assert.equal(feed.mount(host, 'c1'), undefined)
  })

  test('active: list, marksOf and mount read the source', () => {
    const feed = createChannelEmbeds()
    const s = fakeSource([summary('c1'), summary('c2', { closed: { at: '2026-11-25T11:00:00Z', by: 'user' } as never })], { c1: { unread: 3, toMe: 1, asks: 1, owed: 2 } })
    feed.publish(s.source)
    assert.equal(feed.active, true)
    assert.deepEqual(feed.list().map(c => c.id), ['c1', 'c2'])
    assert.deepEqual(feed.marksOf('c1'), { unread: 3, toMe: 1, asks: 1, owed: 2 })
    assert.deepEqual(feed.marksOf('nope'), { unread: 0, toMe: 0, asks: 0, owed: 0 })
    const members = {} as HTMLElement
    const v = feed.mount(host, 'c1', { membersHost: members })
    assert.equal(v?.channelId, 'c1')
    assert.deepEqual(s.mounts, [{ host, channelId: 'c1', opts: { membersHost: members } }])
  })

  test('onDidChange: the source\'s changes and each turn on and off notify; a listener lives across publications', () => {
    const feed = createChannelEmbeds()
    let n = 0
    const sub = feed.onDidChange(() => { n++ })
    const a = fakeSource([summary('c1')])
    const pa = feed.publish(a.source)
    assert.equal(n, 1)
    a.change()
    assert.equal(n, 2)
    pa.dispose()
    assert.equal(n, 3)
    assert.equal(feed.active, false)
    assert.deepEqual(feed.list(), [])
    // Off, the old source's changes reach nobody (its subscription went with it).
    assert.equal(a.listeners.size, 0)
    a.change()
    assert.equal(n, 3)
    pa.dispose()
    assert.equal(n, 3)
    const b = fakeSource([summary('c9')])
    feed.publish(b.source)
    assert.equal(n, 4)
    assert.deepEqual(feed.list().map(c => c.id), ['c9'])
    sub.dispose()
    b.change()
    assert.equal(n, 4)
  })

  test('a newer publication replaces the old one; disposing the old one leaves the newer on', () => {
    const feed = createChannelEmbeds()
    const a = fakeSource([summary('c1')])
    const b = fakeSource([summary('c2')])
    const pa = feed.publish(a.source)
    feed.publish(b.source)
    assert.equal(a.listeners.size, 0)
    pa.dispose()
    assert.equal(feed.active, true)
    assert.deepEqual(feed.list().map(c => c.id), ['c2'])
  })

  test('a listener that throws does not stop the others', () => {
    const feed = createChannelEmbeds()
    let n = 0
    feed.onDidChange(() => { throw new Error('boom') })
    feed.onDidChange(() => { n++ })
    const err = console.error
    console.error = () => {}
    try { feed.publish(fakeSource([]).source) } finally { console.error = err }
    assert.equal(n, 1)
  })
})
