// The Regency's model (extensions/regency/model.ts): who waits for the person, the conversations, the tree by desk and by agent.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  agentTreeOf, conversationsOf, modelSignature, regencyModelOf, treeOf, waitingOf, YOU_ID,
  type RegencyInput,
} from '../../extensions/regency/model.ts'
import type { DeskTree, TreePane } from '../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../../extensions/channels/daemon/requests.ts'

const pane = (id: string, extra: Partial<TreePane> = {}): TreePane => ({ id, type: 'note', icon: 'note', title: id, ...extra })
const channel = (id: string, extra: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id, name: id, title: id, owner: { kind: 'user' }, members: 2, seenByUser: 0, createdAt: '2026-11-25T10:00:00Z', ...extra,
})

const tree = (): DeskTree => ({
  desks: [
    { id: 'd1', name: 'obra', color: 'blue', kind: 'queue', asleep: false, panes: [
      pane('a1', { type: 'agent', title: 'claude · conferente', attention: 'waiting' }),
      pane('a2', { type: 'agent', title: 'soul · bancada', attention: 'done', busy: true }),
      pane('n1', { title: 'nota' }),
    ] },
    { id: 'd2', name: 'casa', color: 'green', kind: 'queue', asleep: true, panes: [
      pane('b1', { type: 'browser', title: 'site', attention: 'waiting' }),
    ] },
    { id: 'regency.main', name: 'Regência', color: 'gold', kind: 'system', asleep: false, icon: 'x', panes: [pane('regency:main', { attention: 'waiting' })] },
    { id: 'drawer', name: 'Gaveta', color: 'gray', kind: 'drawer', asleep: false, panes: [pane('g1')] },
  ],
})

const input = (extra: Partial<RegencyInput> = {}): RegencyInput => ({
  desks: tree(),
  owners: { desk: {}, pane: {} },
  channels: [],
  channelMarks: {},
  agents: [{ id: 'a1', kind: 'claude', name: 'conferente' }, { id: 'a2', kind: 'soul', name: 'bancada' }],
  since: {},
  collapsed: [],
  selfDeskId: 'regency.main',
  ...extra,
})

describe('waiting', () => {
  test('only who waits the person: waiting panes, seals, channel asks; done stays out; the Regency itself too', () => {
    const w = waitingOf(input({
      channels: [channel('c1'), channel('c2'), channel('c3'), channel('c4')],
      channelMarks: {
        c1: { unread: 5, toMe: 2, asks: 0, owed: 0 },
        c2: { unread: 1, toMe: 0, asks: 1, owed: 0 },
        c3: { unread: 0, toMe: 0, asks: 0, owed: 1 },
        c4: { unread: 9, toMe: 0, asks: 0, owed: 0 },
      },
    }))
    assert.deepEqual(w.map(i => [i.target.kind, i.target.id, i.reason]), [
      ['agent', 'a1', 'agent-waiting'],
      ['pane', 'b1', 'seal'],
      ['channel', 'c1', 'to-you'],
      ['channel', 'c2', 'reaction-asks'],
      ['channel', 'c3', 'poll-owed'],
    ])
    assert.equal(w[2]!.count, 2)
    assert.equal(w[2]!.label, '#c1')
    assert.deepEqual(w[0]!.desk, { kind: 'desk', id: 'd1' })
  })

  test('oldest first; untimed after timed, in the order they came', () => {
    const w = waitingOf(input({
      channels: [channel('c1')],
      channelMarks: { c1: { unread: 1, toMe: 1, asks: 0, owed: 0 } },
      since: { 'channel:c1': 100, 'pane:b1': 300, 'agent:a1': 200 },
    }))
    assert.deepEqual(w.map(i => i.target.id), ['c1', 'a1', 'b1'])
    const untimed = waitingOf(input({ since: { 'pane:b1': 5 } }))
    assert.deepEqual(untimed.map(i => i.target.id), ['b1', 'a1'])
  })

  test('closed channels never wait; no marks, nothing', () => {
    const w = waitingOf(input({
      desks: { desks: [] },
      channels: [channel('c1', { closed: { at: 'x', by: 'user' } as ChannelSummary['closed'] })],
      channelMarks: { c1: { unread: 1, toMe: 1, asks: 1, owed: 1 } },
    }))
    assert.deepEqual(w, [])
  })
})

describe('tree by desk', () => {
  test('leaves the Regency out, keeps queue, system and drawer order, flags and identity', () => {
    const t = treeOf(input({ desks: { desks: [...tree().desks, { id: 's2', name: 'Browser', color: 'blue', kind: 'system', asleep: false, panes: [] }] } }))
    assert.deepEqual(t.map(d => d.target.id), ['d1', 'd2', 'drawer', 's2'])
    const a2 = t[0]!.panes.find(p => p.target.id === 'a2')!
    assert.equal(a2.busy, true)
    assert.equal(a2.attention, 'done')
    assert.deepEqual(a2.identity, { kind: 'soul', name: 'bancada' })
    assert.deepEqual(a2.target, { kind: 'agent', id: 'a2' })
    assert.deepEqual(t[0]!.panes.find(p => p.target.id === 'n1')!.target, { kind: 'pane', id: 'n1' })
    assert.equal(t[1]!.asleep, true)
    assert.equal(t[2]!.kind, 'drawer')
  })

  test('collapsed folds the panes but keeps the count', () => {
    const t = treeOf(input({ collapsed: ['d1'] }))
    assert.equal(t[0]!.collapsed, true)
    assert.deepEqual(t[0]!.panes, [])
    assert.equal(t[0]!.paneCount, 3)
    assert.equal(t[1]!.collapsed, false)
    assert.equal(t[1]!.panes.length, 1)
  })

  test("the pane's owner shows only when it differs from the desk's", () => {
    const me = { id: 'a1', name: 'conferente' }
    const other = { id: 'a2', name: 'bancada' }
    const t = treeOf(input({ owners: { desk: { d1: me }, pane: { a1: me, a2: other, n1: me } } }))
    assert.equal(t[0]!.owner, 'conferente')
    const badges = Object.fromEntries(t[0]!.panes.map(p => [p.target.id, p.ownerBadge]))
    assert.deepEqual(badges, { a1: undefined, a2: 'bancada', n1: undefined })
    // a desk with no owner: any pane owner differs
    const t2 = treeOf(input({ owners: { desk: {}, pane: { a2: other } } }))
    assert.equal(t2[0]!.panes.find(p => p.target.id === 'a2')!.ownerBadge, 'bancada')
  })
})

describe('tree by agent', () => {
  test('each pane once, under who owns it, with the desk badge; no agent goes under "Você"', () => {
    const me = { id: 'a1', name: 'conferente' }
    const other = { id: 'a2', name: 'bancada' }
    const g = agentTreeOf(input({ owners: { desk: { d1: me }, pane: { b1: other } } }))
    assert.deepEqual(g.map(x => x.target.id), [YOU_ID, 'a1', 'a2'])
    assert.equal(g[0]!.you, true)
    assert.equal(g[0]!.name, 'Você')
    assert.deepEqual(g[0]!.panes.map(p => p.target.id), ['g1'])
    assert.deepEqual(g[1]!.panes.map(p => p.target.id), ['a1', 'a2', 'n1'])
    assert.deepEqual(g[2]!.panes.map(p => p.target.id), ['b1'])
    assert.equal(g[2]!.panes[0]!.deskName, 'casa')
    assert.equal(g[2]!.panes[0]!.deskColor, 'green')
    const all = g.flatMap(x => x.panes.map(p => p.target.id))
    assert.equal(new Set(all).size, all.length)
    assert.ok(!all.includes('regency:main'))
  })

  test('collapsed folds a group', () => {
    const g = agentTreeOf(input({ collapsed: [YOU_ID] }))
    assert.equal(g[0]!.collapsed, true)
    assert.deepEqual(g[0]!.panes, [])
    assert.equal(g[0]!.paneCount > 0, true)
  })
})

describe('conversations', () => {
  test('open before closed, each with its target and marks', () => {
    const closed = { at: 'x', by: 'user' } as ChannelSummary['closed']
    const c = conversationsOf(input({
      channels: [channel('c1', { closed }), channel('c2', { desk: 'd1' }), channel('c3', { owner: { kind: 'agent', id: 'a1', name: 'conferente' } })],
      channelMarks: { c2: { unread: 3, toMe: 1, asks: 0, owed: 0 } },
    }))
    assert.deepEqual(c.open.map(r => r.target.id), ['c2', 'c3'])
    assert.deepEqual(c.closed.map(r => r.target.id), ['c1'])
    assert.deepEqual(c.open[0]!.desk, { kind: 'desk', id: 'd1' })
    assert.equal(c.open[0]!.marks.unread, 3)
    assert.equal(c.open[1]!.owner, 'conferente')
    assert.equal(c.closed[0]!.closed, true)
  })
})

describe('model', () => {
  const full = (): RegencyInput => input({
    channels: [channel('c1')],
    channelMarks: { c1: { unread: 1, toMe: 1, asks: 0, owed: 0 } },
    owners: { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: { a2: { id: 'a2', name: 'bancada' } } },
    since: { 'agent:a1': 10 },
  })

  test('serializes: JSON round trip equals the model', () => {
    const model = regencyModelOf(full())
    assert.deepEqual(JSON.parse(JSON.stringify(model)), model)
  })

  test('signature is stable for equal input and changes with the content', () => {
    const a = modelSignature(regencyModelOf(full()))
    assert.equal(a, modelSignature(regencyModelOf(full())))
    assert.notEqual(a, modelSignature(regencyModelOf({ ...full(), collapsed: ['d1'] })))
  })

  test('empty input gives an empty model', () => {
    const m = regencyModelOf(input({ desks: { desks: [] } }))
    assert.deepEqual(m.waiting, [])
    assert.deepEqual(m.tree, [])
    assert.deepEqual(m.conversations, { open: [], closed: [] })
    assert.deepEqual(m.byAgent.map(g => g.paneCount), [0])
  })
})
