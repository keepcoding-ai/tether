// The Regency's model (extensions/regency/model.ts): who waits for the person, the conversations, the tree by desk and by agent.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  agentTreeOf, CLOSED_ID, CLOSED_LIMIT, closedOf, conversationsOf, filterModel, foldText, modelSignature, regencyModelOf, stateCounts, treeOf,
  waitingOf, YOU_ID,
  type RegencyInput,
} from '../../extensions/regency/model.ts'
import { deskRowKey, flatRows, groupRowKey, paneRowKey } from '../../extensions/regency/renderer/tree-keys.ts'
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

describe('state counts and filter', () => {
  test('counts the panes by state, before any filter, with the Regency left out', () => {
    assert.deepEqual(stateCounts(input()), { all: 5, waiting: 2, busy: 1, asleep: 1 })
    assert.deepEqual(stateCounts(input({ filter: 'waiting', query: 'obra' })), { all: 5, waiting: 2, busy: 1, asleep: 1 })
  })

  test('"asleep" counts a hibernated pane and every pane of a sleeping desk', () => {
    const d = tree()
    d.desks[0]!.panes[2] = pane('n1', { asleep: true })
    assert.equal(stateCounts(input({ desks: d })).asleep, 2)
    const t = treeOf(input({ desks: d, filter: 'asleep' }))
    assert.deepEqual(t.map(x => [x.target.id, x.panes.map(p => p.target.id)]), [['d1', ['n1']], ['d2', ['b1']]])
  })

  test('"waiting" and "busy" keep only those panes; a desk left with none goes away; counts follow the filter', () => {
    const t = treeOf(input({ filter: 'waiting' }))
    assert.deepEqual(t.map(x => [x.target.id, x.paneCount, x.panes.map(p => p.target.id)]), [['d1', 1, ['a1']], ['d2', 1, ['b1']]])
    assert.deepEqual(treeOf(input({ filter: 'busy' })).map(x => x.panes.map(p => p.target.id)), [['a2']])
    const g = agentTreeOf(input({ filter: 'waiting' }))
    assert.deepEqual(g.map(x => x.target.id), [YOU_ID])
    assert.deepEqual(g[0]!.panes.map(p => p.target.id), ['a1', 'b1'])
  })

  test('with a filter on, the folds do not apply', () => {
    const t = treeOf(input({ collapsed: ['d1'], filter: 'waiting' }))
    assert.equal(t[0]!.collapsed, false)
    assert.deepEqual(t[0]!.panes.map(p => p.target.id), ['a1'])
    assert.equal(agentTreeOf(input({ collapsed: [YOU_ID], filter: 'busy' }))[0]!.collapsed, false)
    // no filter, no search: the fold stands
    assert.equal(treeOf(input({ collapsed: ['d1'], filter: 'all', query: '  ' }))[0]!.collapsed, true)
  })

  test('filterModel is regencyModelOf with the filter and the search apart', () => {
    assert.deepEqual(filterModel(input(), { filter: 'busy' }), regencyModelOf(input({ filter: 'busy' })))
    assert.deepEqual(filterModel(input(), {}), regencyModelOf(input()))
    assert.deepEqual(filterModel(input({ filter: 'busy' }), {}), regencyModelOf(input()))
  })
})

describe('search', () => {
  test('foldText ignores case, accents and edge spaces', () => {
    assert.equal(foldText('  Conferência Ñ '), 'conferencia n')
  })

  test('a desk whose name matches shows all its panes; a pane that matches shows its desk, open even when folded', () => {
    const byDesk = treeOf(input({ query: 'OBRA' }))
    assert.deepEqual(byDesk.map(d => [d.target.id, d.panes.length]), [['d1', 3]])
    const byPane = treeOf(input({ query: 'nota', collapsed: ['d1'] }))
    assert.deepEqual(byPane.map(d => [d.target.id, d.collapsed, d.panes.map(p => p.target.id)]), [['d1', false, ['n1']]])
  })

  test('matches the title, the agent name and the emblem name, without accents', () => {
    const d = tree()
    d.desks[0]!.panes[0] = pane('a1', { type: 'agent', title: 'revisão' })
    const agents = [{ id: 'a1', kind: 'claude', name: 'Conferência', emblem: { name: 'Guardiã', color: 'red', icon: 'shield' } }, { id: 'a2', kind: 'soul', name: 'bancada' }]
    const ids = (query: string): string[] => treeOf(input({ desks: d, agents, query })).flatMap(x => x.panes.map(p => p.target.id))
    assert.deepEqual(ids('revisao'), ['a1'])
    assert.deepEqual(ids('conferencia'), ['a1'])
    assert.deepEqual(ids('guardia'), ['a1'])
    assert.deepEqual(ids('bancada'), ['a2'])
    assert.deepEqual(ids('zzz'), [])
  })

  test('by agent: a group whose owner matches shows all its panes; a pane that matches shows only itself', () => {
    const owners = { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: {} }
    const byOwner = agentTreeOf(input({ owners, query: 'conferente' }))
    assert.deepEqual(byOwner.map(g => [g.target.id, g.panes.map(p => p.target.id)]), [['a1', ['a1', 'a2', 'n1']]])
    const byPane = agentTreeOf(input({ owners, query: 'nota' }))
    assert.deepEqual(byPane.map(g => [g.target.id, g.panes.map(p => p.target.id)]), [['a1', ['n1']]])
    // the desk's name in the by-agent view
    assert.deepEqual(agentTreeOf(input({ owners, query: 'casa' })).flatMap(g => g.panes.map(p => p.target.id)), ['b1'])
  })

  test('search and filter together; a matching desk with no panes stays only under "all"', () => {
    assert.deepEqual(treeOf(input({ query: 'obra', filter: 'busy' })).map(d => d.panes.map(p => p.target.id)), [['a2']])
    const empty = tree()
    empty.desks.push({ id: 'd3', name: 'vazia', color: 'red', kind: 'queue', asleep: false, panes: [] })
    assert.deepEqual(treeOf(input({ desks: empty, query: 'vazia' })).map(d => d.target.id), ['d3'])
    assert.deepEqual(treeOf(input({ desks: empty, query: 'vazia', filter: 'waiting' })), [])
  })
})

describe('focus ids in the by-agent view', () => {
  test('the group header is marked and its focus key differs from the pane of the agent it is named after', () => {
    const m = regencyModelOf(input({ owners: { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: {} } }))
    assert.ok(m.byAgent.every(g => g.group === true))
    const g = m.byAgent.find(x => x.target.id === 'a1')!
    const own = g.panes.find(p => p.target.id === 'a1')!
    assert.deepEqual(g.target, own.target)
    assert.notEqual(groupRowKey(g.target.id), paneRowKey(own.target))
    const keys = flatRows(m, 'agent').map(r => r.key)
    assert.equal(new Set(keys).size, keys.length)
    const deskKeys = flatRows(m, 'desk').map(r => r.key)
    assert.equal(new Set(deskKeys).size, deskKeys.length)
    assert.ok(deskKeys.includes(deskRowKey('d1')))
  })

  test('one `collapsed` list folds desks and groups apart (the ids do not collide)', () => {
    const owners = { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: {} }
    const m = regencyModelOf(input({ owners, collapsed: ['a1'] }))
    assert.equal(m.tree[0]!.collapsed, false)
    assert.equal(m.byAgent.find(g => g.target.id === 'a1')!.collapsed, true)
    const m2 = regencyModelOf(input({ owners, collapsed: ['d1'] }))
    assert.equal(m2.tree[0]!.collapsed, true)
    assert.equal(m2.byAgent.find(g => g.target.id === 'a1')!.collapsed, false)
  })
})

describe('closed sessions', () => {
  const ended = (n: number) => Array.from({ length: n }, (_, i) => ({ slotId: `s${i}`, kind: 'claude', name: `sessão ${i}`, ...(i === 0 ? { title: 'Revisão do plano', endedAt: '2026-11-26T10:00:00Z' } : {}) }))

  test('rows with a session target, in the order given; the title falls to the name; none by default', () => {
    assert.deepEqual(closedOf(input()), { collapsed: false, count: 0, rows: [] })
    const c = closedOf(input({ closed: ended(2) }))
    assert.deepEqual(c.rows.map(r => [r.target, r.title]), [[{ kind: 'session', id: 's0' }, 'Revisão do plano'], [{ kind: 'session', id: 's1' }, 'sessão 1']])
    assert.equal(c.rows[0]!.endedAt, '2026-11-26T10:00:00Z')
    assert.equal('endedAt' in c.rows[1]!, false)
  })

  test('capped; folded by its own id keeping the count; a search opens it and narrows it; a state filter hides it', () => {
    const many = ended(CLOSED_LIMIT + 10)
    assert.equal(closedOf(input({ closed: many })).rows.length, CLOSED_LIMIT)
    const folded = closedOf(input({ closed: ended(3), collapsed: [CLOSED_ID] }))
    assert.deepEqual([folded.collapsed, folded.count, folded.rows.length], [true, 3, 0])
    const searched = closedOf(input({ closed: ended(3), collapsed: [CLOSED_ID], query: 'REVISAO' }))
    assert.deepEqual([searched.collapsed, searched.count], [false, 1])
    assert.deepEqual(closedOf(input({ closed: ended(3), filter: 'busy' })), { collapsed: false, count: 0, rows: [] })
  })

  test('the model carries them, JSON round trip included, and the tree rows stay sessions-free', () => {
    const m = regencyModelOf(input({ closed: ended(2), filter: 'all' }))
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m)
    assert.equal(m.closed.count, 2)
    assert.ok(m.tree.every(d => d.panes.every(p => p.target.kind !== 'session')))
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
