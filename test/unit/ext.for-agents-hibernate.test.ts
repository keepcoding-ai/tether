// Tether for agents: `agents hibernate` and `agents wake`. The verbs run on fake deps (no tetherd): the ownership answers
// from knobs, the app's half of the sleep bridge is played by the test (it hears the `hibernate` event and answers with the
// `hibernated` request, as renderer/sleep.ts does), and the refusals are checked in the order the verbs apply them.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { VerbCaller, VerbResult } from '../../src/daemon/ext-api.ts'
import type { ExtRequestHandler } from '../../src/daemon/door/types.ts'
import { failOf, type VerbDeps } from '../../extensions/for-agents/daemon/verbs/common.ts'
import { HIBERNATE_EVENT, HIBERNATED_REQUEST, hibernateVerb, SleepBridge, type HibernateEvent, type SleepAnswer } from '../../extensions/for-agents/daemon/verbs/hibernate.ts'
import { listVerb } from '../../extensions/for-agents/daemon/verbs/list.ts'
import { wakeVerb } from '../../extensions/for-agents/daemon/verbs/wake.ts'
import { sleepBridge } from '../../extensions/for-agents/renderer/sleep.ts'

const OWNER = 'owner-1'
const PANE = 'pane-1'
const OTHER = 'pane-2'

describe('for-agents: hibernate and wake', () => {
  let status: string
  let hand: 'owner' | 'user'
  let gateWhy: string | undefined
  let appAnswer: SleepAnswer | 'silent'
  let started: string[]
  let emitted: HibernateEvent[]
  let touched: string[]
  let handler: ExtRequestHandler<unknown> | undefined
  let bridge: SleepBridge
  let deps: VerbDeps

  const slotOf = (id: string) => ({ slotId: id, kind: 'soul', name: id === PANE ? 'p1' : id, cwd: '/x', status: id === PANE ? status : 'running' })
  const caller = { slotId: OWNER, proven: true } as VerbCaller
  const codeOf = (r: VerbResult): unknown => (r.data as { error?: string } | undefined)?.error
  const data = (r: VerbResult): Record<string, unknown> => r.data as Record<string, unknown>
  const hibernate = (guia = PANE): Promise<VerbResult> => hibernateVerb.run(deps, caller, { guia }).catch(failOf)
  const wake = (guia = PANE): Promise<VerbResult> => wakeVerb.run(deps, caller, { guia }).catch(failOf)

  beforeEach(() => {
    status = 'running'; hand = 'owner'; gateWhy = undefined; appAnswer = 'asleep'
    started = []; emitted = []; touched = []; handler = undefined
    const api = {
      events: {
        emit: (name: string, payload: unknown) => {
          assert.equal(name, HIBERNATE_EVENT)
          const ev = payload as HibernateEvent
          emitted.push(ev)
          if (appAnswer !== 'silent') { const state = appAnswer; queueMicrotask(() => { void handler!({ ask: ev.ask, state }, { client: 'app' }) }) }
        },
      },
      requests: { handle: (name: string, h: ExtRequestHandler<unknown>) => { assert.equal(name, HIBERNATED_REQUEST); handler = h; return { dispose() { handler = undefined } } } },
    }
    bridge = new SleepBridge(api as never, 50)
    bridge.listen()
    deps = {
      api: {
        ...api,
        slots: {
          get: (id: string) => ([PANE, OWNER, OTHER].includes(id) ? slotOf(id) : undefined),
          start: async (id: string) => { started.push(id); status = 'starting'; return slotOf(id) },
        },
        desks: { map: () => undefined },
        log: () => {},
      },
      store: {
        panesOf: () => new Set([PANE, OWNER]),
        // OTHER is not in the pool; OWNER is the caller's own pane ("de si").
        effectiveOf: (id: string) => (id === OWNER ? { commander: OWNER, via: 'self', hand: 'owner' } : { commander: OWNER, via: 'pane', hand }),
        inventoryOf: () => ({}),
        recordLast: async (id: string, _by: string, verb: string) => { touched.push(`${verb}:${id}`); return {} },
      },
      gate: { check: () => gateWhy ?? (hand === 'user' ? 'with-user' : undefined) },
      readers: {},
      pending: {},
      sleep: bridge,
    } as unknown as VerbDeps
  })

  test('hibernate asks the app and answers asleep; the last act is recorded', async () => {
    const r = await hibernate()
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r), { state: 'asleep', already: false })
    assert.deepEqual(emitted.map((e) => e.pane), [PANE])
    assert.deepEqual(touched, [`hibernate:${PANE}`])
  })

  test('hibernate on a pane already asleep answers already, with no error', async () => {
    appAnswer = 'already'
    const r = await hibernate()
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r), { state: 'asleep', already: true })
    assert.match(r.text, /já estava hibernada/)
  })

  test('wake starts a stopped pane (resume) and answers its state', async () => {
    status = 'stopped'
    const r = await wake()
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r), { state: 'starting', already: false })
    assert.deepEqual(started, [PANE])
    assert.deepEqual(touched, [`wake:${PANE}`])
  })

  test('wake on an unconfirmed pane refuses unconfirmed and says what to do (ask the person, or restart --fresh)', async () => {
    status = 'unconfirmed'
    const r = await wake()
    assert.equal(codeOf(r), 'unconfirmed')
    assert.match(r.text, /peça à pessoa/)
    assert.match(r.text, /agents restart <guia> --fresh/)
    assert.deepEqual(started, [])
  })

  test('wake on a live pane answers already and starts nothing', async () => {
    for (const s of ['running', 'starting', 'queued']) {
      status = s
      const r = await wake()
      assert.equal(r.isError, undefined, r.text)
      assert.deepEqual(data(r), { state: s, already: true })
    }
    assert.deepEqual(started, [])
  })

  test('refusals: a pane that is not yours (not-commanded), on both verbs, and nothing reaches the app', async () => {
    assert.equal(codeOf(await hibernate(OTHER)), 'not-commanded')
    assert.equal(codeOf(await wake(OTHER)), 'not-commanded')
    assert.equal(codeOf(await hibernate('nobody')), 'not-commanded')
    assert.deepEqual(emitted, [])
  })

  test('refusals: your own pane cannot be hibernated', async () => {
    const r = await hibernate(OWNER)
    assert.equal(codeOf(r), 'bad-request')
    assert.match(r.text, /própria guia/)
    assert.deepEqual(emitted, [])
  })

  test('refusals: a pane with the person answers with-user on both verbs, before already', async () => {
    hand = 'user'
    assert.equal(codeOf(await hibernate()), 'with-user')
    assert.equal(codeOf(await wake()), 'with-user')
    assert.deepEqual(emitted, [])
    assert.deepEqual(started, [])
  })

  test('the app silent: hibernate answers no-app after the wait and nothing is recorded', async () => {
    appAnswer = 'silent'
    const r = await hibernate()
    assert.equal(codeOf(r), 'no-app')
    assert.deepEqual(touched, [])
  })

  test('the bridge: only the app answers; a late or unknown ask is dropped; a bad answer is bad-request', async () => {
    await assert.rejects(async () => handler!({ ask: 's1', state: 'asleep' }, { client: 'cli' }), (e: { code?: string }) => e.code === 'not-app')
    await assert.rejects(async () => handler!({ ask: 's1', state: 'nope' }, { client: 'app' }), (e: { code?: string }) => e.code === 'bad-request')
    assert.deepEqual(await handler!({ ask: 'never-asked', state: 'asleep' }, { client: 'app' }), {})
  })
})

describe('for-agents: hibernate and wake a desk', () => {
  const D1 = 'desk-1'
  const D2 = 'desk-2'
  const A1 = 'a1'
  const A2 = 'a2'
  const G = 'given'
  const NOTE = 'note-1'
  let withUser: Set<string>
  let ownsD1: boolean
  let deskAsleep: boolean
  let reply: { state: string; panes: string[] }
  let emitted: { name: string; payload: { desk?: string; spare?: string[] } }[]
  let touched: string[]
  let handler: ExtRequestHandler<unknown> | undefined
  let deps: VerbDeps
  const caller = { slotId: OWNER, proven: true } as VerbCaller
  const codeOf = (r: VerbResult): unknown => (r.data as { error?: string } | undefined)?.error
  const data = (r: VerbResult): Record<string, unknown> => r.data as Record<string, unknown>
  const hibernate = (desk = D1): Promise<VerbResult> => hibernateVerb.run(deps, caller, { desk }).catch(failOf)
  const wake = (desk = D1): Promise<VerbResult> => wakeVerb.run(deps, caller, { desk }).catch(failOf)
  const slotOf = (id: string) => ({ slotId: id, kind: 'soul', name: id, cwd: '/x', status: 'running' })

  beforeEach(() => {
    withUser = new Set(); ownsD1 = true; deskAsleep = false; reply = { state: 'asleep', panes: [A1, A2] }
    emitted = []; touched = []; handler = undefined
    const api = {
      events: {
        emit: (name: string, payload: unknown) => {
          const ev = payload as { ask: string; desk?: string; spare?: string[] }
          emitted.push({ name, payload: { desk: ev.desk, spare: ev.spare } })
          const r = reply
          queueMicrotask(() => { void handler!({ ask: ev.ask, state: r.state, panes: r.panes }, { client: 'app' }) })
        },
      },
      requests: { handle: (_n: string, h: ExtRequestHandler<unknown>) => { handler = h; return { dispose() {} } } },
    }
    const bridge = new SleepBridge(api as never, 50)
    bridge.listen()
    const map = () => ({
      desks: [
        { id: D1, name: 'obra', kind: 'queue', ...(deskAsleep ? { asleep: true } : {}), panes: [OWNER, A1, A2, G].map((id) => ({ id, type: 'terminal' })).concat([{ id: NOTE, type: 'note' }]) },
        { id: D2, name: 'outra', kind: 'queue', panes: [] },
      ],
      drawer: [],
    })
    deps = {
      api: {
        ...api,
        slots: { get: (id: string) => ([OWNER, A1, A2, G].includes(id) ? slotOf(id) : undefined) },
        desks: { map },
        objects: { get: () => undefined },
        log: () => {},
      },
      store: {
        ownedDesks: () => [[D1, { owner: ownsD1 ? OWNER : 'someone', since: '' }], [D2, { owner: 'someone', since: '' }]],
        panesOf: () => new Set([OWNER, A1, A2, G]),
        // G was given to another agent: the desk's owner only sees it.
        effectiveOf: (id: string) => (id === G ? { commander: 'other-agent', via: 'pane', viewer: OWNER, hand: 'owner' } : id === OWNER ? { commander: OWNER, via: 'self', hand: 'owner' } : { commander: OWNER, via: 'desk', hand: 'owner' }),
        inventoryOf: () => ({}),
        recordLast: async (id: string, _by: string, verb: string) => { touched.push(`${verb}:${id}`); return {} },
      },
      gate: { check: (id: string) => (withUser.has(id) ? 'with-user' : undefined) },
      readers: {},
      pending: {},
      sleep: bridge,
    } as unknown as VerbDeps
  })

  test('a desk that is not yours: not-owner; an unknown one: unknown-desk; nothing reaches the app', async () => {
    assert.equal(codeOf(await hibernate(D2)), 'not-owner')
    assert.equal(codeOf(await wake(D2)), 'not-owner')
    assert.equal(codeOf(await hibernate('nada')), 'unknown-desk')
    ownsD1 = false
    assert.equal(codeOf(await hibernate(D1)), 'not-owner')
    assert.deepEqual(emitted, [])
  })

  test('guia and desk together, or neither, is bad-request', async () => {
    assert.equal(codeOf(await hibernateVerb.run(deps, caller, { guia: A1, desk: D1 }).catch(failOf)), 'bad-request')
    assert.equal(codeOf(await wakeVerb.run(deps, caller, {}).catch(failOf)), 'bad-request')
  })

  test("the owner's own pane is spared: only the others sleep and the desk stays awake, said in the answer", async () => {
    reply = { state: 'partial', panes: [A1] }
    const r = await hibernate('obra')
    assert.equal(r.isError, undefined, r.text)
    assert.equal(emitted[0]!.name, 'hibernate-desk')
    assert.deepEqual(emitted[0]!.payload, { desk: D1, spare: [OWNER, G] })
    assert.equal(data(r).state, 'awake')
    assert.deepEqual(data(r).slept, [A1])
    assert.deepEqual(data(r).spared, { own: OWNER, withUser: [], others: [G] })
    assert.match(r.text, /1 guia\(s\) da mesa obra dormiram/)
    assert.match(r.text, /segue acordada porque a sua guia está nela/)
    assert.deepEqual(touched, [`hibernate:${A1}`])
  })

  test('a pane with the person is spared and listed', async () => {
    withUser = new Set([A2])
    reply = { state: 'partial', panes: [A1] }
    const r = await hibernate()
    assert.deepEqual(emitted[0]!.payload.spare, [OWNER, A2, G])
    assert.deepEqual((data(r).spared as { withUser: string[] }).withUser, [A2])
    assert.match(r.text, /Com a pessoa, não tocadas: a2/)
  })

  test('a desk with nothing spared sleeps whole; the app refusals come back as errors', async () => {
    const d = deps as unknown as { api: { desks: { map: () => { desks: { id: string; panes: { id: string; type: string }[] }[] } } } }
    const full = d.api.desks.map
    d.api.desks.map = () => { const m = full(); m.desks[0]!.panes = [{ id: A1, type: 'terminal' }, { id: A2, type: 'terminal' }]; return m }
    const r = await hibernate()
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(emitted[0]!.payload.spare, [])
    assert.deepEqual([data(r).state, data(r).already], ['asleep', false])
    assert.match(r.text, /Mesa obra hibernada \(2 guia\(s\) dormiram\)/)
    for (const [state, code] of [['last-desk', 'last-desk'], ['in-view', 'in-view'], ['no-desk', 'unknown-desk']] as const) {
      reply = { state, panes: [] }
      assert.equal(codeOf(await hibernate()), code, state)
    }
  })

  test('already: a sleeping desk answers already without asking the app; a desk with nothing left to sleep too', async () => {
    deskAsleep = true
    const r = await hibernate()
    assert.deepEqual([r.isError, data(r).state, data(r).already], [undefined, 'asleep', true])
    assert.deepEqual(emitted, [])
    deskAsleep = false
    reply = { state: 'already', panes: [] }
    const r2 = await hibernate()
    assert.deepEqual([r2.isError, data(r2).already], [undefined, true])
  })

  test('wake a desk: the app wakes it sparing the panes with the person; nothing to wake answers already', async () => {
    withUser = new Set([A2])
    reply = { state: 'woke', panes: [A1] }
    const r = await wake()
    assert.equal(r.isError, undefined, r.text)
    assert.equal(emitted[0]!.name, 'wake-desk')
    assert.deepEqual(emitted[0]!.payload, { desk: D1, spare: [A2, G] })
    assert.deepEqual([data(r).state, data(r).already, data(r).woke], ['awake', false, [A1]])
    assert.deepEqual(touched, [`wake:${A1}`])
    reply = { state: 'already', panes: [] }
    assert.equal(data(await wake()).already, true)
  })
})

describe('for-agents: list shows the sleep the app publishes in the desk map', () => {
  test('asleep on the pane and on the desk', async () => {
    const D = 'desk-1'
    const deps = {
      api: {
        slots: { get: (id: string) => ({ slotId: id, kind: 'soul', name: id, cwd: '/x', status: 'exited' }) },
        desks: { map: () => ({ desks: [{ id: D, name: 'obra', kind: 'queue', asleep: true, panes: [{ id: 'a1', type: 'terminal', asleep: true }, { id: 'a2', type: 'terminal' }] }], drawer: [] }) },
        objects: { get: () => undefined },
        delivery: { pathOf: () => 'wait', pending: () => [] },
        log: () => {},
      },
      store: {
        ownedDesks: () => [[D, { owner: OWNER, since: '' }]],
        ownedPanes: () => [],
        deskFacts: () => ({}),
        effectiveOf: () => ({ commander: OWNER, via: 'desk', hand: 'owner' }),
        inventoryOf: () => ({}),
      },
      pending: { count: () => 0 },
    } as unknown as VerbDeps
    const r = await listVerb.run(deps, { slotId: OWNER, proven: true } as VerbCaller, {})
    const desk = (r.data as { desks: { asleep?: boolean; panes: { id: string; asleep?: boolean }[] }[] }).desks[0]!
    assert.equal(desk.asleep, true)
    assert.deepEqual(desk.panes.map((p) => [p.id, p.asleep ?? false]), [['a1', true], ['a2', false]])
    assert.match(r.text, /Mesa "obra" \(hibernada\)/)
    assert.match(r.text, /a1 \(soul, hibernada\)/)
  })
})

describe('for-agents: the app half of hibernate (renderer/sleep.ts)', () => {
  test('hears the three events, does each through ui.panes / ui.desks and answers hibernated with the same ask', async () => {
    const listeners = new Map<string, (p: unknown) => void>()
    const asked: unknown[] = []
    const did: unknown[] = []
    const ui = {
      daemon: {
        onEvent: (name: string, l: (p: unknown) => void) => { listeners.set(name, l); return { dispose() {} } },
        request: async (name: string, args: unknown) => { asked.push({ name, args }); return {} },
      },
      panes: { hibernate: async (id: string) => { did.push(['pane', id]); return id === PANE ? 'asleep' : 'no-pane' } },
      desks: {
        hibernate: async (id: string, o: { spare: string[] }) => { did.push(['sleep', id, o.spare]); return { state: 'partial', panes: ['x'] } },
        wake: async (id: string, o: { spare: string[] }) => { did.push(['wake', id, o.spare]); return { state: 'woke', panes: ['x'] } },
      },
    }
    sleepBridge(ui as never)
    assert.deepEqual([...listeners.keys()], [HIBERNATE_EVENT, 'hibernate-desk', 'wake-desk'])
    listeners.get(HIBERNATE_EVENT)!({ ask: 's7', pane: PANE })
    listeners.get(HIBERNATE_EVENT)!({ ask: 's8', pane: 'gone' })
    listeners.get(HIBERNATE_EVENT)!({ nonsense: true })
    listeners.get('hibernate-desk')!({ ask: 's9', desk: 'd', spare: ['o'] })
    listeners.get('wake-desk')!({ ask: 's10', desk: 'd', spare: [] })
    listeners.get('wake-desk')!({ ask: 's11', desk: 'd' })
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(did, [['pane', PANE], ['pane', 'gone'], ['sleep', 'd', ['o']], ['wake', 'd', []]])
    const byAsk = (x: unknown): number => Number(((x as { args: { ask: string } }).args.ask).slice(1))
    assert.deepEqual(asked.sort((a, b) => byAsk(a) - byAsk(b)), [
      { name: HIBERNATED_REQUEST, args: { ask: 's7', state: 'asleep' } },
      { name: HIBERNATED_REQUEST, args: { ask: 's8', state: 'no-pane' } },
      { name: HIBERNATED_REQUEST, args: { ask: 's9', state: 'partial', panes: ['x'] } },
      { name: HIBERNATED_REQUEST, args: { ask: 's10', state: 'woke', panes: ['x'] } },
    ])
  })
})
