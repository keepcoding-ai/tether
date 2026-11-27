// The Regency's published tree (RR3 3.2): the app publishes the model's entry when it changes (renderer/publish.ts), tetherd
// keeps the last one (daemon.ts) and joins it with the live slots (publish-rules.ts regencyViewOf).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { TreeKeeper } from '../../extensions/regency/daemon.ts'
import { regencyModelOf, type RegencyInput } from '../../extensions/regency/model.ts'
import {
  asOfLabel, LEASE_MS, publishedTreeOf, regencyViewOf, SEAL_LINE_MAX, SEAL_LINES_MAX, signatureOf, STALE_MS, TREE_MAX_BYTES, treeJson, utf8Length,
  VIEW_MAX_BYTES, type PublishAnswer,
} from '../../extensions/regency/publish-rules.ts'
import { READ_BODY_MAX, resultBody, SEAL_LINE_MAX as REMOTE_SEAL_LINE_MAX, SEAL_LINES_MAX as REMOTE_SEAL_LINES_MAX } from '../../src/remote/projection.ts'
import { TreePublisher } from '../../extensions/regency/renderer/publish.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const APP = { client: 'app', conn: 1 }

function entry(title = 'Agente 1', extra: Partial<RegencyInput> = {}): RegencyInput {
  return {
    desks: { desks: [{ id: 'desk-1', name: 'Mesa', color: 'blue', kind: 'queue', asleep: false, panes: [
      { id: 'a1', type: 'agent', icon: 'claude', title },
      { id: 'n1', type: 'note', icon: 'note', title: 'Notas' },
    ] }] },
    owners: { desk: {}, pane: {} }, channels: [], channelMarks: {},
    agents: [{ id: 'a1', kind: 'claude', name: title }], since: {}, collapsed: ['desk-1'], ...extra,
  }
}

/** A clock and one-shot/interval timers the test fires by hand. */
function clock(start = Date.parse('2026-11-27T13:05:00.000Z')) {
  let now = start
  const timers = new Map<number, { fn: () => void; at: number; every?: number }>()
  let seq = 0
  const add = (fn: () => void, ms: number, every?: number): number => { timers.set(++seq, { fn, at: now + ms, ...(every ? { every } : {}) }); return seq }
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => add(fn, ms),
    setInterval: (fn: () => void, ms: number) => add(fn, ms, ms),
    clear: (t: unknown) => { timers.delete(t as number) },
    pending: () => timers.size,
    /** Moves the clock and fires every timer that came due, in order. */
    async advance(ms: number): Promise<void> {
      const to = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, t] = due
        now = t.at
        if (t.every) t.at += t.every
        else timers.delete(id)
        t.fn()
        await new Promise(r => setImmediate(r))
      }
      now = to
    },
  }
}

/** An app publisher wired to a keeper, as ui.daemon.request would be; counts what went over the pipe. */
function wired(read: () => RegencyInput, c = clock()) {
  const events: { name: string; payload: unknown }[] = []
  const keeper = new TreeKeeper({ now: c.now, emit: (name, payload) => events.push({ name, payload }), setTimer: c.setTimeout, clearTimer: c.clear })
  const sent: { sig: string; tree?: RegencyInput }[] = []
  const pub = new TreePublisher({
    read,
    send: async (args) => { sent.push(args); return keeper.publish(args, APP) as PublishAnswer },
    setTimeout: c.setTimeout, clearTimeout: c.clear, setInterval: c.setInterval, clearInterval: c.clear, log: () => {},
  })
  return { keeper, pub, sent, events, c }
}

describe('the app publishes the Regency entry', () => {
  test('at open it publishes; a tab title that changes changes the kept tree and its signature', async () => {
    let title = 'Agente 1'
    const { keeper, pub, sent, c } = wired(() => entry(title))
    pub.start()
    await c.advance(0)
    assert.equal(sent.length, 1, 'published at open')
    const first = keeper.kept!
    assert.equal(first.tree.desks.desks[0]!.panes[0]!.title, 'Agente 1')

    title = 'Agente renomeado'
    pub.changed()
    await c.advance(1_000)
    const second = keeper.kept!
    assert.equal(second.tree.desks.desks[0]!.panes[0]!.title, 'Agente renomeado')
    assert.notEqual(second.sig, first.sig)
    assert.equal(second.sig, signatureOf(treeJson(publishedTreeOf(entry(title)))), 'the app and tetherd sign the same JSON')
    assert.equal(sent.length, 2)
    pub.dispose()
  })

  test('an entry that did not change is not published again; a burst of changes is one publish', async () => {
    let title = 'A'
    const { pub, sent, c, keeper } = wired(() => entry(title))
    pub.start()
    await c.advance(0)
    for (let i = 0; i < 20; i++) pub.changed()
    await c.advance(1_000)
    assert.equal(sent.length, 1, 'same signature: nothing sent')
    title = 'B'
    for (let i = 0; i < 20; i++) pub.changed()
    await c.advance(1_000)
    assert.equal(sent.length, 2, 'twenty changes, one debounce, one publish')
    pub.dispose()
    keeper.dispose()
    assert.equal(c.pending(), 0, 'disposed: no timer left (the app\'s debounce and lease, tetherd\'s one lease timer)')
  })

  // RR3.4d: the seal's lines (what an agent is doing) go, capped; the portal keeps the same ceilings.
  test('the seal lines are published, at most SEAL_LINES_MAX, each cut at SEAL_LINE_MAX; no line, no field', () => {
    assert.deepEqual([SEAL_LINES_MAX, SEAL_LINE_MAX], [REMOTE_SEAL_LINES_MAX, REMOTE_SEAL_LINE_MAX], 'the portal and tetherd cap alike')
    const e = entry()
    e.desks.desks[0]!.panes[0]!.lines = ['a', 'x'.repeat(SEAL_LINE_MAX + 9), '', 'b', 'c', 7 as never]
    e.desks.desks[0]!.panes[1]!.lines = ['', 9 as never]
    const [p1, p2] = publishedTreeOf(e).desks.desks[0]!.panes
    assert.deepEqual(p1!.lines, ['a', 'x'.repeat(SEAL_LINE_MAX), 'b'])
    assert.equal('lines' in p2!, false)
  })

  test('the screen state of the app (folds, filter, search) is not published: it changes nothing', async () => {
    let extra: Partial<RegencyInput> = {}
    const { pub, sent, c, keeper } = wired(() => entry('A', extra))
    pub.start()
    await c.advance(0)
    extra = { collapsed: ['x', 'y'], filter: 'busy', query: 'abc' }
    pub.changed()
    await c.advance(1_000)
    assert.equal(sent.length, 1)
    assert.deepEqual(keeper.kept!.tree.collapsed, [])
    assert.equal('filter' in keeper.kept!.tree || 'query' in keeper.kept!.tree, false)
  })

  test('the lease carries the signature alone; tetherd that lost the tree asks for it and gets it', async () => {
    const { pub, sent, c, keeper } = wired(() => entry())
    pub.start()
    await c.advance(0)
    await c.advance(LEASE_MS)
    assert.equal(sent.length, 2)
    assert.equal(sent[1]!.tree, undefined, 'a lease is the signature only')
    assert.equal(keeper.kept!.seenAt, c.now())
    const fresh = new TreeKeeper({ now: c.now })
    assert.deepEqual(fresh.publish({ sig: sent[0]!.sig }, APP), { need: 'tree' })
    pub.dispose()
    keeper.dispose()
  })

  test('tetherd restarted: the next lease is answered `need` and the tree goes again, once', async () => {
    const c = clock()
    let keeper = new TreeKeeper({ now: c.now, setTimer: c.setTimeout, clearTimer: c.clear })
    const sent: { sig: string; tree?: RegencyInput }[] = []
    const pub = new TreePublisher({
      read: () => entry(), send: async (args) => { sent.push(args); return keeper.publish(args, APP) },
      setTimeout: c.setTimeout, clearTimeout: c.clear, setInterval: c.setInterval, clearInterval: c.clear, log: () => {},
    })
    pub.start()
    await c.advance(0)
    keeper.dispose()
    keeper = new TreeKeeper({ now: c.now, setTimer: c.setTimeout, clearTimer: c.clear })
    await c.advance(LEASE_MS)
    assert.deepEqual(sent.map(s => s.tree !== undefined), [true, false, true], 'tree, lease refused, tree again')
    assert.equal(keeper.kept?.sig, sent[0]!.sig)
    await c.advance(LEASE_MS)
    assert.deepEqual(sent.map(s => s.tree !== undefined), [true, false, true, false], 'then leases again')
    pub.dispose()
    keeper.dispose()
  })

  test('a tree over the ceiling is refused by tetherd and never sent by the app', async () => {
    const big = entry('x'.repeat(200))
    big.desks.desks[0]!.panes = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, type: 'agent', icon: 'claude', title: 'é'.repeat(256) }))
    assert.ok(utf8Length(treeJson(publishedTreeOf(big))) > TREE_MAX_BYTES)
    const keeper = new TreeKeeper()
    assert.throws(() => keeper.publish({ sig: '0'.repeat(16), tree: big }, APP), (e: { code?: string }) => e.code === 'bad-request')
    assert.equal(keeper.kept, undefined)
    const { pub, sent, c } = wired(() => big)
    pub.start()
    await c.advance(LEASE_MS * 2)
    assert.equal(sent.length, 0, 'the app measures first and keeps it home')
    pub.dispose()
  })

  test('only the app publishes; anyone reads', () => {
    const keeper = new TreeKeeper()
    for (const client of ['cli', 'remote', 'test', undefined])
      assert.throws(() => keeper.publish({ sig: '0'.repeat(16), tree: entry() }, { client }), (e: { code?: string }) => e.code === 'door-denied', String(client))
    assert.doesNotThrow(() => new TreeKeeper({ bench: true }).publish({ tree: entry() }, { client: 'test' }))
    assert.equal(keeper.read().live, false)
  })

  // RR3 gate B-3: the lease named only the signature, which goes to every client in `tree.changed`: another connection that
  // says `app` kept `live` true after the app left, and the phone never put the live slots over the tree.
  test('the lease counts only from the connection that published the tree', async () => {
    const c = clock()
    const events: { name: string; payload: unknown }[] = []
    const k = new TreeKeeper({ now: c.now, emit: (name, payload) => events.push({ name, payload }), setTimer: c.setTimeout, clearTimer: c.clear })
    const { sig } = k.publish({ tree: entry() }, APP) as { sig: string }
    const other = { client: 'app', conn: 2 }
    await c.advance(LEASE_MS)
    assert.deepEqual(k.publish({ sig }, other), { need: 'tree' }, 'another connection: refused')
    assert.deepEqual(k.publish({ sig }, { client: 'app' }), { need: 'tree' }, 'a connection without a number: refused')
    assert.deepEqual(k.publish({ sig }, APP), { sig }, 'the publisher renews')
    const before = events.length
    await c.advance(LEASE_MS)
    for (let i = 0; i < 4; i++) { k.publish({ sig }, other); await c.advance(LEASE_MS / 2) }
    assert.equal(k.read().live, false, 'the app left: live falls, whatever the other connection renews')
    assert.deepEqual(events.slice(before).map(e => (e.payload as { live: boolean }).live), [false], 'only the end of the lease is told')
    // A new tree from another connection is a new publish (its own lease from then on).
    k.publish({ tree: entry('Outro') }, other)
    assert.equal(k.read().live, true)
    assert.deepEqual(k.publish({ sig: k.kept!.sig }, APP), { need: 'tree' })
    k.dispose()
  })

  // RR3 final gate B-1: the same tree again from another connection took the lease in silence.
  test('the same tree published again by another connection is a new tree: new `at`, `tree.changed`, the lease is its own', async () => {
    const c = clock()
    const events: { name: string; payload: unknown }[] = []
    const k = new TreeKeeper({ now: c.now, emit: (name, payload) => events.push({ name, payload }), setTimer: c.setTimeout, clearTimer: c.clear })
    const first = k.publish({ tree: entry() }, APP) as { sig: string; at: number }
    await c.advance(LEASE_MS / 2)
    const before = events.length
    const intruder = { client: 'app', conn: 2 }
    const again = k.publish({ tree: entry() }, intruder) as { sig: string; at: number }
    assert.equal(again.sig, first.sig)
    assert.notEqual(again.at, first.at, 'a new `at`')
    assert.equal(events.length, before + 1, 'tree.changed went out')
    assert.deepEqual(k.publish({ sig: first.sig }, APP), { need: 'tree' }, 'the lease is the intruder\'s now, and the app is asked for the tree')
    // The same connection again keeps its time and says nothing.
    const quiet = events.length
    const same = k.publish({ tree: entry() }, intruder) as { at: number }
    assert.equal(same.at, again.at)
    assert.equal(events.length, quiet)
    k.dispose()
  })

  test('utf8Length counts as TextEncoder does', () => {
    for (const s of ['', 'abc', 'ação', '😀x', '\ud800', '€'.repeat(3)]) assert.equal(utf8Length(s), new TextEncoder().encode(s).length, s)
  })
})

const slot = (slotId: string, extra: Partial<SlotState> = {}): SlotState =>
  ({ slotId, kind: 'claude', cwd: 'C:\\work\\proj', status: 'running', ...extra }) as SlotState

describe('the kept tree joined with the live slots', () => {
  test('app open: the tree is the app\'s, live', () => {
    const { keeper } = wired(() => entry())
    const now = Date.now()
    const k = new TreeKeeper({ now: () => now, live: () => ({ slots: [slot('a1', { attention: 'waiting' })] }) })
    k.publish({ tree: entry() }, APP)
    const v = k.read()
    assert.equal(v.live, true)
    assert.equal(v.asOf, undefined)
    assert.equal(v.input.desks.desks[0]!.panes[0]!.attention, undefined, 'live: the app already said what waits')
    void keeper
  })

  test('app closed: the tree as it was, the live slots over it, and "como estavam às HH:MM"', async () => {
    const c = clock()
    const events: { name: string; payload: unknown }[] = []
    let slots: SlotState[] = [slot('a1')]
    const k = new TreeKeeper({ now: c.now, live: () => ({ slots }), emit: (name, payload) => events.push({ name, payload }), setTimer: c.setTimeout, clearTimer: c.clear })
    const tree = entry()
    tree.agents.push({ id: 'gone', kind: 'claude', name: 'Foi embora' })
    tree.desks.desks[0]!.panes.push({ id: 'gone', type: 'agent', icon: 'claude', title: 'Foi embora', busy: true, lines: ['revisando'] })
    tree.desks.desks[0]!.panes[0]!.lines = ['escrevendo o plano']
    tree.desks.desks[0]!.panes[1]!.lines = ['nota']
    k.publish({ tree }, APP)
    assert.deepEqual(k.read().input.desks.desks[0]!.panes[0]!.lines, ['escrevendo o plano'], 'live: the seal says what the agent does')
    const at = c.now()
    await c.advance(STALE_MS + 10)
    assert.deepEqual(events.at(-1), { name: 'tree.changed', payload: { sig: k.kept!.sig, at, live: false } }, 'the screens hear that the app left')

    slots = [slot('a1', { attention: 'waiting', turn: 'busy' }), slot('new1', { title: 'Nova sessão' })]
    const v = k.read()
    assert.equal(v.live, false)
    assert.equal(v.asOf, at)
    assert.equal(asOfLabel(v.asOf!, () => ({ h: 10, m: 5 })), 'como estavam às 10:05')
    const panes = v.input.desks.desks[0]!.panes
    assert.deepEqual(panes[0], { id: 'a1', type: 'agent', icon: 'claude', title: 'Agente 1', attention: 'waiting', busy: true }, 'the app\'s title, the live state')
    assert.deepEqual(panes[1], { id: 'n1', type: 'note', icon: 'note', title: 'Notas' }, 'a pane that is not a slot stays as it was')
    assert.deepEqual(panes[2], { id: 'gone', type: 'agent', icon: 'claude', title: 'Foi embora', exited: true }, 'an agent whose slot is gone ended')
    assert.equal(panes.some(p => p.lines !== undefined), false, 'the app left: no seal says what an agent WAS doing')
    const extra = v.input.desks.desks.find(d => d.id === 'remote:slots')
    assert.deepEqual(extra?.panes.map(p => p.id), ['new1'], 'a slot born after the app closed shows in its own desk')
    assert.ok(v.input.agents.some(a => a.id === 'new1'))
    const m = regencyModelOf(v.input)
    assert.deepEqual(m.waiting.map(w => w.target.id), ['a1'], 'the model reads the joined entry')

    // The app comes back: the same tree renews the lease and keeps its time.
    k.publish({ sig: k.kept!.sig }, APP)
    assert.equal(k.read().live, true)
    assert.equal(events.at(-1)!.payload && (events.at(-1)!.payload as { live: boolean }).live, true)
  })

  // RR3 gate B-6: tetherd took a tree of up to 256 KiB and the portal refuses a read over 224 KiB: a big house never reached
  // the phone, and with the app closed the slots over the tree only made it bigger.
  test('every tree tree.publish accepts fits regency.tree, the live slots over it included', async () => {
    assert.ok(TREE_MAX_BYTES + 16 * 1024 <= VIEW_MAX_BYTES && VIEW_MAX_BYTES + 8 * 1024 <= READ_BODY_MAX, `${TREE_MAX_BYTES} < ${VIEW_MAX_BYTES} < ${READ_BODY_MAX}`)
    const pane = (id: string): RegencyInput['desks']['desks'][number]['panes'][number] => ({ id, type: 'agent', icon: 'claude', title: 'é'.repeat(100) })
    const tree = (n: number): RegencyInput => {
      const desks = Array.from({ length: Math.ceil(n / 500) }, (_, d) => ({ id: `d${d}`, name: 'Mesa', color: 'blue', kind: 'queue' as const, asleep: false, panes: [] as ReturnType<typeof pane>[] }))
      for (let i = 0; i < n; i++) desks[Math.floor(i / 500)]!.panes.push(pane(`p${i}`))
      return { desks: { desks }, owners: { desk: {}, pane: {} }, channels: [], channelMarks: {}, agents: [], since: {}, collapsed: [] }
    }
    const size = (n: number): number => utf8Length(treeJson(publishedTreeOf(tree(n))))
    let n = Math.floor(TREE_MAX_BYTES / (size(2) - size(1)))
    while (size(n) > TREE_MAX_BYTES) n--
    const biggest = tree(n)
    const c = clock()
    // Every pane of the tree is a slot that waits and works now; 512 slots more were born after the app closed.
    const slots: SlotState[] = [
      ...Array.from({ length: n }, (_, i) => slot(`p${i}`, { attention: 'waiting', turn: 'busy' })),
      ...Array.from({ length: 512 }, (_, i) => slot(`new${i}`, { title: 'ü'.repeat(256) })),
    ]
    const k = new TreeKeeper({ now: c.now, live: () => ({ slots }), setTimer: c.setTimeout, clearTimer: c.clear })
    k.publish({ tree: biggest }, APP)
    await c.advance(STALE_MS + 10)
    const view = k.read()
    assert.equal(view.live, false)
    const body = resultBody('regency.tree', { view, channels: true })
    assert.ok(body.length <= READ_BODY_MAX, `regency.tree is ${body.length} bytes (ceiling ${READ_BODY_MAX})`)
    assert.ok(utf8Length(JSON.stringify(view)) <= VIEW_MAX_BYTES)
    // A small house keeps every newcomer.
    const small = new TreeKeeper({ now: c.now, live: () => ({ slots: [slot('a1'), slot('new1')] }), setTimer: c.setTimeout, clearTimer: c.clear })
    small.publish({ tree: entry() }, APP)
    await c.advance(STALE_MS + 10)
    assert.deepEqual(small.read().input.desks.desks.find(d => d.id === 'remote:slots')?.panes.map(p => p.id), ['new1'])
    k.dispose()
    small.dispose()
  })

  test('no tree at all: the floor of remote-input alone, not live', () => {
    const v = regencyViewOf(undefined, { slots: [slot('s1', { attention: 'waiting' })] }, Date.now())
    assert.equal(v.live, false)
    assert.equal(v.asOf, undefined)
    assert.deepEqual(regencyModelOf(v.input).waiting.map(w => w.target.id), ['s1'])
  })
})
