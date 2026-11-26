// The Regency's model (extensions/regency/model.ts): who waits for the person, the conversations, the tree by desk and by agent.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  agentTreeOf, CLOSED_ID, CLOSED_LIMIT, closedOf, conversationsOf, filterModel, foldText, modelSignature, regencyModelOf, stateCounts, treeOf,
  waitingOf, YOU_ID, NAME_SHOWN_MAX, safeName, TREE_FILTERS,
  type RegencyInput,
} from '../../extensions/regency/model.ts'
import { paneStateOf, stateShown } from '../../app/shared/pane-state.ts'
import { paneCardHead } from '../../app/renderer/peek-rules.ts'
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

  test('a channel\'s card carries what is asked first (the speech\'s first line), on the item of that kind only', () => {
    const w = waitingOf(input({
      desks: { desks: [] },
      channels: [channel('c1')],
      channelMarks: { c1: { unread: 2, toMe: 1, asks: 0, owed: 1, first: { why: 'to-you', text: 'conferente: Posso seguir?' } } },
    }))
    assert.equal(w.find(i => i.reason === 'to-you')?.said, 'conferente: Posso seguir?')
    assert.equal(w.find(i => i.reason === 'poll-owed')?.said, undefined)
  })
})

describe('tree by desk', () => {
  test('leaves the Regency out, keeps queue, system and drawer order, flags and identity', () => {
    const t = treeOf(input({ desks: { desks: [...tree().desks, { id: 's2', name: 'Browser', color: 'blue', kind: 'system', asleep: false, panes: [pane('w1', { type: 'browser' })] }] } }))
    assert.deepEqual(t.map(d => d.target.id), ['d1', 'd2', 'drawer', 's2'])
    // empty, the Browser goes to the shelf at the tree's foot (see "the empty desks")
    assert.deepEqual(treeOf(input({ desks: { desks: [...tree().desks, { id: 's2', name: 'Browser', color: 'blue', kind: 'system', asleep: false, panes: [] }] } })).map(d => d.target.id), ['d1', 'd2', 'drawer'])
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
  const me = { id: 'a1', name: 'conferente' }
  const other = { id: 'a2', name: 'bancada' }
  const placed = (g: ReturnType<typeof agentTreeOf>): string[] => g.flatMap(x => [...(x.self ? [x.self.target.id] : []), ...x.panes.map(p => p.target.id)])

  test('every agent is a group, even with nothing: a leaf whose line is its own pane with its state and desk', () => {
    const g = agentTreeOf(input())
    assert.deepEqual(g.map(x => x.target.id), ['a1', 'a2', YOU_ID])
    assert.deepEqual(g[0]!.target, { kind: 'agent', id: 'a1' })
    assert.equal(g[0]!.name, 'conferente')
    assert.equal(g[0]!.paneCount, 0)
    assert.deepEqual(g[0]!.panes, [])
    assert.equal(g[0]!.self!.attention, 'waiting')
    assert.deepEqual(g[0]!.self!.identity, { kind: 'claude', name: 'conferente' })
    assert.deepEqual([g[0]!.self!.deskName, g[0]!.self!.deskColor], ['obra', 'blue'])
    assert.equal(g[1]!.self!.busy, true)
    assert.equal(g[0]!.inDeskOf, undefined)
  })

  test('"Você" is last and holds what has no agent owner; an agent\'s pane is neither under it nor repeated', () => {
    const g = agentTreeOf(input())
    const you = g[g.length - 1]!
    assert.equal(you.you, true)
    assert.equal(you.name, 'Você')
    assert.equal(you.self, undefined)
    assert.deepEqual(you.panes.map(p => p.target.id), ['n1', 'b1', 'g1'])
    assert.ok(you.panes.every(p => p.target.kind !== 'agent'))
    const all = placed(g)
    assert.equal(new Set(all).size, all.length)
    assert.deepEqual([...all].sort(), ['a1', 'a2', 'b1', 'g1', 'n1'])
    assert.ok(!all.includes('regency:main'))
  })

  test('what an agent has: its panes with the desk badge; a whole desk given to it enters as children', () => {
    const g = agentTreeOf(input({ owners: { desk: { d2: me }, pane: { n1: me } } }))
    const a1 = g.find(x => x.target.id === 'a1')!
    assert.deepEqual(a1.panes.map(p => p.target.id), ['n1', 'b1'])
    assert.deepEqual([a1.panes[1]!.deskName, a1.panes[1]!.deskColor], ['casa', 'green'])
    assert.equal(a1.paneCount, 2)
    assert.deepEqual(g[g.length - 1]!.panes.map(p => p.target.id), ['g1'])
  })

  test('an agent inside a desk of another agent is a group of its own, marked "em mesa de"', () => {
    const g = agentTreeOf(input({ owners: { desk: { d1: me }, pane: { b1: other } } }))
    assert.deepEqual(g.map(x => x.target.id), ['a1', 'a2', YOU_ID])
    assert.deepEqual(g[0]!.panes.map(p => p.target.id), ['n1'])
    assert.equal(g[1]!.inDeskOf, 'conferente')
    assert.deepEqual(g[1]!.panes.map(p => p.target.id), ['b1'])
    assert.equal(g[1]!.panes[0]!.deskName, 'casa')
    assert.deepEqual(g[2]!.panes.map(p => p.target.id), ['g1'])
    const all = placed(g)
    assert.equal(new Set(all).size, all.length)
  })

  test('an owner that is not an agent of the tree owns nothing: its panes stay with "Você"', () => {
    const g = agentTreeOf(input({ owners: { desk: {}, pane: { n1: { id: 'zz', name: 'sumido' } } } }))
    assert.deepEqual(g.map(x => x.target.id), ['a1', 'a2', YOU_ID])
    assert.ok(g[2]!.panes.some(p => p.target.id === 'n1'))
  })

  test('collapsed folds a group that has panes; a leaf has nothing to fold; "Você" folds too', () => {
    const owners = { desk: { d1: me }, pane: {} }
    const g = agentTreeOf(input({ owners, collapsed: ['a1', 'a2', YOU_ID] }))
    assert.deepEqual([g[0]!.collapsed, g[0]!.panes.length, g[0]!.paneCount], [true, 0, 1])
    assert.deepEqual([g[1]!.collapsed, g[1]!.paneCount], [false, 0])
    assert.deepEqual([g[2]!.collapsed, g[2]!.panes.length], [true, 0])
    assert.equal(g[2]!.paneCount > 0, true)
    assert.ok(g[0]!.self, 'the line stays')
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
  test('counts the panes by state, before any filter, with the Regency left out: each pane in one state, all covered', () => {
    // a1 waits; a2 works; n1 and g1 are free; b1 waits even in its sleeping desk (the orange means "needs the person")
    assert.deepEqual(stateCounts(input()), { all: 5, waiting: 2, busy: 1, idle: 2, asleep: 0 })
    assert.deepEqual(stateCounts(input({ filter: 'waiting', query: 'obra' })), { all: 5, waiting: 2, busy: 1, idle: 2, asleep: 0 })
    const c = stateCounts(input())
    assert.equal(c.waiting + c.busy + c.idle + c.asleep, c.all)
  })

  test('"asleep" counts a hibernated pane and every pane of a sleeping desk', () => {
    const d = tree()
    d.desks[0]!.panes[2] = pane('n1', { asleep: true })
    d.desks[1]!.panes.push(pane('b2', { type: 'browser', title: 'outro', busy: true }))
    assert.equal(stateCounts(input({ desks: d })).asleep, 2)
    const t = treeOf(input({ desks: d, filter: 'asleep' }))
    assert.deepEqual(t.map(x => [x.target.id, x.panes.map(p => p.target.id)]), [['d1', ['n1']], ['d2', ['b2']]])
  })

  test('"idle" ("Livre") keeps the free panes, the done and the ended among them, each with its mark', () => {
    const d = tree()
    d.desks[0]!.panes.push(pane('a3', { type: 'agent', title: 'fim', exited: true }))
    const t = treeOf(input({ desks: d, filter: 'idle', agents: [...input().agents, { id: 'a3', kind: 'claude', name: 'fim' }] }))
    assert.deepEqual(t.map(x => [x.target.id, x.panes.map(p => [p.target.id, p.state, p.mark ?? ''])]), [
      ['d1', [['n1', 'idle', ''], ['a3', 'idle', 'ended']]],
      ['drawer', [['g1', 'idle', '']]],
    ])
    const done = tree()
    done.desks[0]!.panes[1] = pane('a2', { type: 'agent', title: 'soul · bancada', attention: 'done' })
    assert.deepEqual(treeOf(input({ desks: done, filter: 'idle' }))[0]!.panes.map(p => [p.target.id, p.mark]), [['a2', 'done'], ['n1', undefined]])
  })

  test('"waiting" and "busy" keep only those panes; a desk left with none goes away; counts follow the filter', () => {
    const t = treeOf(input({ filter: 'waiting' }))
    assert.deepEqual(t.map(x => [x.target.id, x.paneCount, x.panes.map(p => p.target.id)]), [['d1', 1, ['a1']], ['d2', 1, ['b1']]])
    assert.deepEqual(treeOf(input({ filter: 'busy' })).map(x => x.panes.map(p => p.target.id)), [['a2']])
    const g = agentTreeOf(input({ filter: 'waiting' }))
    assert.deepEqual(g.map(x => x.target.id), ['a1', YOU_ID])
    assert.deepEqual(g[1]!.panes.map(p => p.target.id), ['b1'])
    // by agent a leaf that does not pass goes away; one with a pane that passes stays, with its line
    assert.deepEqual(agentTreeOf(input({ filter: 'busy' })).map(x => x.target.id), ['a2'])
    const owned = agentTreeOf(input({ filter: 'waiting', owners: { desk: { d2: { id: 'a2', name: 'bancada' } }, pane: {} } }))
    assert.deepEqual(owned.map(x => [x.target.id, x.panes.map(p => p.target.id)]), [['a1', []], ['a2', ['b1']]])
    assert.equal(owned[1]!.self!.busy, true)
  })

  test('with a filter on, the folds do not apply', () => {
    const t = treeOf(input({ collapsed: ['d1'], filter: 'waiting' }))
    assert.equal(t[0]!.collapsed, false)
    assert.deepEqual(t[0]!.panes.map(p => p.target.id), ['a1'])
    assert.equal(agentTreeOf(input({ collapsed: ['a2', YOU_ID], filter: 'busy' }))[0]!.collapsed, false)
    // no filter, no search: the fold stands
    assert.equal(treeOf(input({ collapsed: ['d1'], filter: 'all', query: '  ' }))[0]!.collapsed, true)
  })

  test('filterModel is regencyModelOf with the filter and the search apart', () => {
    assert.deepEqual(filterModel(input(), { filter: 'busy' }), regencyModelOf(input({ filter: 'busy' })))
    assert.deepEqual(filterModel(input(), {}), regencyModelOf(input()))
    assert.deepEqual(filterModel(input({ filter: 'busy' }), {}), regencyModelOf(input()))
  })
})

describe('one state for a pane (app/shared/pane-state.ts): the line, the filter, "Esperam você" and the card agree', () => {
  test('the rule: waiting first, then sleep (pane or desk), ended, work; the rest free, with "terminou"', () => {
    assert.deepEqual(paneStateOf({ attention: 'waiting', deskAsleep: true, busy: true }), { state: 'waiting', text: 'espera você' })
    assert.deepEqual(paneStateOf({ asleep: true, busy: true }), { state: 'asleep', text: 'hibernando' })
    assert.deepEqual(paneStateOf({ deskAsleep: true }), { state: 'asleep', text: 'hibernando' })
    assert.deepEqual(paneStateOf({ exited: true, attention: 'done' }), { state: 'idle', mark: 'ended', text: 'encerrado' })
    assert.deepEqual(paneStateOf({ busy: true, attention: 'done' }), { state: 'busy', text: 'trabalhando' })
    assert.deepEqual(paneStateOf({ attention: 'done' }), { state: 'idle', mark: 'done', text: 'terminou' })
    assert.deepEqual(paneStateOf({}), { state: 'idle', text: 'livre' })
    assert.equal(stateShown(paneStateOf({}), false), false, 'a note at rest says nothing')
    assert.equal(stateShown(paneStateOf({ exited: true }), false), true)
  })

  test('every pane: its row\'s state is the chip it passes, it is in "Esperam você" exactly when waiting, and the card says the same', () => {
    const d = tree()
    d.desks[0]!.panes.push(pane('a3', { type: 'agent', title: 'fim', exited: true }), pane('a4', { type: 'agent', title: 'pronto', attention: 'done' }))
    const inp = input({ desks: d })
    const m = regencyModelOf(inp)
    const waiting = new Set(m.waiting.map(w => w.target.id))
    for (const desk of m.tree) {
      for (const p of desk.panes) {
        const chips = TREE_FILTERS.filter(f => f !== 'all' && treeOf({ ...inp, filter: f }).some(x => x.panes.some(q => q.target.id === p.target.id)))
        assert.deepEqual(chips, [p.state], `${p.target.id} passes only its own chip`)
        assert.equal(waiting.has(p.target.id), p.state === 'waiting', `${p.target.id}: "Esperam você" agrees`)
        const card = paneCardHead({ title: p.title, typeId: p.type, agent: p.identity !== undefined, asleep: p.asleep === true, deskAsleep: desk.asleep,
          attention: p.attention, busy: p.busy === true, exited: p.exited === true })
        const words = paneStateOf({ ...p, deskAsleep: desk.asleep })
        assert.equal(card.state?.text, stateShown(words, p.identity !== undefined) ? words.text : undefined, `${p.target.id}: the card agrees`)
      }
    }
  })
})

describe('the core\'s empty pane and the empty desks', () => {
  test('the core\'s empty placeholder is not a pane: its desk is an empty desk (0 panes), and it is in no count', () => {
    const d = tree()
    d.desks.splice(1, 0, { id: 'd3', name: 'nova', color: 'red', kind: 'queue', asleep: false, panes: [pane('empty:1', { type: 'empty', title: 'Vazio' })] })
    const row = treeOf(input({ desks: d })).find(x => x.target.id === 'd3')!
    assert.deepEqual([row.paneCount, row.panes], [0, []])
    assert.equal(stateCounts(input({ desks: d })).all, 5)
  })

  test('an empty Browser or drawer goes to the shelf (not a desk row) unless a filter or a search narrows the tree', () => {
    const d = tree()
    d.desks.push({ id: 'browser', name: 'Browser', color: 'blue', kind: 'system', asleep: false, icon: 'globe', panes: [] })
    d.desks[3]!.panes = []
    const m = regencyModelOf(input({ desks: d }))
    assert.deepEqual(m.tree.map(x => x.target.id), ['d1', 'd2'])
    assert.deepEqual(m.shelf.map(s => [s.target.id, s.kind, s.icon ?? '']), [['drawer', 'drawer', ''], ['browser', 'system', 'globe']])
    assert.deepEqual(regencyModelOf(input({ desks: d, query: 'brow' })).shelf, [])
    assert.deepEqual(regencyModelOf(input({ desks: d, query: 'brow' })).tree.map(x => x.target.id), ['browser'])
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

  test('by agent: an agent whose line matches shows all its panes; a pane that matches shows only itself under its agent', () => {
    const owners = { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: {} }
    const byOwner = agentTreeOf(input({ owners, query: 'conferente' }))
    assert.deepEqual(byOwner.map(g => [g.target.id, g.panes.map(p => p.target.id)]), [['a1', ['n1']]])
    // an agent with nothing is found by its name too, as a leaf
    assert.deepEqual(agentTreeOf(input({ query: 'BANCADA' })).map(g => [g.target.id, g.panes.length]), [['a2', 0]])
    const byPane = agentTreeOf(input({ owners, query: 'nota' }))
    assert.deepEqual(byPane.map(g => [g.target.id, g.panes.map(p => p.target.id)]), [['a1', ['n1']]])
    // the desk's name in the by-agent view: the panes of that desk, and the agents sitting in it
    assert.deepEqual(agentTreeOf(input({ owners, query: 'casa' })).flatMap(g => g.panes.map(p => p.target.id)), ['b1'])
    assert.deepEqual(agentTreeOf(input({ owners, query: 'obra' })).map(g => g.target.id), ['a1', 'a2'])
    assert.deepEqual(agentTreeOf(input({ query: 'zzz' })), [])
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
  test('an agent\'s group head IS its pane: one key, no repeated row; only "Você" is a bare group', () => {
    const m = regencyModelOf(input({ owners: { desk: { d1: { id: 'a1', name: 'conferente' } }, pane: {} } }))
    assert.ok(m.byAgent.every(g => g.group === true))
    const g = m.byAgent.find(x => x.target.id === 'a1')!
    assert.deepEqual(g.target, g.self!.target)
    assert.ok(!g.panes.some(p => p.target.id === 'a1'))
    const rows = flatRows(m, 'agent')
    const keys = rows.map(r => r.key)
    assert.equal(new Set(keys).size, keys.length)
    const head = rows.find(r => r.key === paneRowKey(g.target))!
    assert.deepEqual([head.kind, head.level, head.expandable, head.foldId], ['agent', 1, true, 'a1'])
    assert.deepEqual(rows.filter(r => r.parent === head.key).map(r => r.target.id), ['n1'])
    const leaf = rows.find(r => r.key === paneRowKey({ kind: 'agent', id: 'a2' }))!
    assert.deepEqual([leaf.kind, leaf.expandable], ['agent', false])
    assert.equal(rows.find(r => r.key === groupRowKey(YOU_ID))!.kind, 'group')
    assert.equal(rows.filter(r => r.target.id === 'a1').length, 1)
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

describe('names from outside (R-9)', () => {
  test('safeName: control, bidi and zero-width characters go, the emoji joiner stays, white space folds, the cut ends in …', () => {
    assert.equal(safeName('evil‮gnp.exe'), 'evilgnp.exe', 'RLO')
    assert.equal(safeName('a\u0000b\u0007c\u001Bd'), 'abcd', 'C0 controls')
    assert.equal(safeName('linha\num\r\n  dois\tt'), 'linha um dois t', 'line breaks and tabs are a space')
    assert.equal(safeName('⁦x⁩​y‎﻿'), 'xy', 'isolates, zero width, marks, BOM')
    assert.equal(safeName('👨‍👩‍👧 família'), '👨‍👩‍👧 família', 'the joiner glues an emoji')
    assert.equal(safeName('a'.repeat(100)), 'a'.repeat(100), 'no cut without max')
    assert.equal(safeName('a'.repeat(100), 10), `${'a'.repeat(9)}…`)
    assert.equal(safeName('🙂'.repeat(12), 10), `${'🙂'.repeat(9)}…`, 'the cut counts characters, not halves of one')
  })

  test('the model shows every name filtered: desks, panes, channels, agents, owners, closed sessions', () => {
    const rlo = '‮'
    const desks = tree()
    desks.desks[0]!.name = `ob${rlo}ra`
    desks.desks[0]!.panes[2]!.title = `no\u0000ta\n${'x'.repeat(200)}`
    const m = regencyModelOf(input({
      desks,
      owners: { desk: { d1: { id: 'a1', name: `con${rlo}ferente` } }, pane: {} },
      agents: [{ id: 'a1', kind: 'claude', name: `confe${rlo}rente`, emblem: { name: `e${rlo}m`, color: 'red', icon: 'x' } }, { id: 'a2', kind: 'soul', name: 'bancada' }],
      channels: [channel('c1', { name: `o${rlo}bra`, title: `T⁦í⁩tulo` })],
      closed: [{ slotId: 's1', kind: 'claude', name: `ve${rlo}lho`, title: `t${rlo}` }],
    }))
    const json = JSON.stringify(m)
    assert.equal(/[\u0000-\u001F‮⁦⁩]/.test(json.replace(/\\u[0-9a-f]{4}/gi, s => String.fromCharCode(parseInt(s.slice(2), 16)))), false, 'no control or bidi character anywhere')
    const d1 = m.tree.find(d => d.target.id === 'd1')!
    assert.equal(d1.name, 'obra')
    assert.equal(d1.owner, 'conferente')
    const note = d1.panes.find(p => p.target.id === 'n1')!
    assert.equal([...note.title].length, NAME_SHOWN_MAX)
    assert.ok(note.title.startsWith('nota x') && note.title.endsWith('…'))
    assert.equal(d1.panes.find(p => p.target.id === 'a1')!.identity?.name, 'conferente')
    assert.equal(d1.panes.find(p => p.target.id === 'a1')!.identity?.emblem?.name, 'em')
    assert.deepEqual([m.conversations.open[0]!.name, m.conversations.open[0]!.title], ['obra', 'Título'])
    assert.deepEqual([m.closed.rows[0]?.name, m.closed.rows[0]?.title], ['velho', 't'])
  })
})
