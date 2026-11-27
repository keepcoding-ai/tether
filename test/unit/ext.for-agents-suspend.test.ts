// Tether for agents: `agents suspend`. Same fake deps as the hibernate test: the app's half of the bridge is played by the test.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { VerbCaller, VerbResult } from '../../src/daemon/ext-api.ts'
import type { ExtRequestHandler } from '../../src/daemon/door/types.ts'
import { failOf, type VerbDeps } from '../../extensions/for-agents/daemon/verbs/common.ts'
import { HIBERNATED_REQUEST, SleepBridge } from '../../extensions/for-agents/daemon/verbs/hibernate.ts'
import { listVerb } from '../../extensions/for-agents/daemon/verbs/list.ts'
import { suspendVerb } from '../../extensions/for-agents/daemon/verbs/suspend.ts'
import { SUSPEND_EVENT, type SuspendAnswer, type SuspendEvent } from '../../extensions/for-agents/sleep-names.ts'
import { sleepBridge } from '../../extensions/for-agents/renderer/sleep.ts'

const OWNER = 'owner-1'
const PANE = 'pane-1'
const OTHER = 'pane-2'

describe('for-agents: suspend', () => {
  let slot: Record<string, unknown>
  let mark: { asleep?: true; suspended?: true }
  let hand: 'owner' | 'user'
  let appAnswer: SuspendAnswer | 'silent'
  let emitted: SuspendEvent[]
  let touched: string[]
  let handler: ExtRequestHandler<unknown> | undefined
  let deps: VerbDeps
  let noSlot = false

  const caller = { slotId: OWNER, proven: true } as VerbCaller
  const codeOf = (r: VerbResult): unknown => (r.data as { error?: string } | undefined)?.error
  const data = (r: VerbResult): Record<string, unknown> => r.data as Record<string, unknown>
  const suspend = (guia = PANE): Promise<VerbResult> => suspendVerb.run(deps, caller, { guia }).catch(failOf)

  beforeEach(() => {
    slot = { slotId: PANE, kind: 'claude', name: 'p1', cwd: '/x', status: 'running', canRestart: true }
    mark = {}; hand = 'owner'; appAnswer = 'suspended'; emitted = []; touched = []; handler = undefined; noSlot = false
    const api = {
      events: {
        emit: (name: string, payload: unknown) => {
          assert.equal(name, SUSPEND_EVENT)
          const ev = payload as SuspendEvent
          emitted.push(ev)
          if (appAnswer !== 'silent') { const state = appAnswer; queueMicrotask(() => { void handler!({ ask: ev.ask, state }, { client: 'app' }) }) }
        },
      },
      requests: { handle: (_n: string, h: ExtRequestHandler<unknown>) => { handler = h; return { dispose() { handler = undefined } } } },
    }
    const bridge = new SleepBridge(api as never, 50)
    bridge.listen()
    deps = {
      api: {
        ...api,
        slots: { get: (id: string) => (id === PANE ? (noSlot ? undefined : slot) : id === OWNER ? { slotId: OWNER, kind: 'claude', name: 'owner', cwd: '/x', status: 'running', canRestart: true } : undefined) },
        desks: { map: () => ({ desks: [{ id: 'd1', name: 'D', kind: 'queue', panes: [{ id: PANE, type: 'terminal', ...mark }] }], drawer: [] }) },
        log: () => {},
      },
      store: {
        panesOf: () => new Set([PANE, OWNER]),
        effectiveOf: (id: string) => (id === OWNER ? { commander: OWNER, via: 'self', hand: 'owner' } : { commander: OWNER, via: 'pane', hand }),
        inventoryOf: () => ({}),
        recordLast: async (id: string, _by: string, verb: string) => { touched.push(`${verb}:${id}`); return {} },
      },
      gate: { check: () => (hand === 'user' ? 'with-user' : undefined) },
      readers: {},
      pending: {},
      sleep: bridge,
    } as unknown as VerbDeps
  })

  test('asks the app, answers suspended and records the act', async () => {
    const r = await suspend()
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(data(r), { state: 'suspended', already: false })
    assert.deepEqual(emitted.map((e) => e.pane), [PANE])
    assert.deepEqual(touched, [`suspend:${PANE}`])
  })

  test('already suspended (map or app answer) is already: true, nothing recorded', async () => {
    mark = { suspended: true }
    const r = await suspend()
    assert.deepEqual(data(r), { state: 'suspended', already: true })
    assert.deepEqual(emitted, [])
    mark = {}; appAnswer = 'already'
    assert.deepEqual(data(await suspend()), { state: 'suspended', already: true })
    assert.deepEqual(touched, [])
  })

  test('refusals: own pane, with-user, not commanded, no process', async () => {
    assert.equal(codeOf(await suspend(OWNER)), 'bad-request')
    assert.equal(codeOf(await suspend(OTHER)), 'not-commanded')
    hand = 'user'
    assert.equal(codeOf(await suspend()), 'with-user')
    hand = 'owner'; noSlot = true
    assert.equal(codeOf(await suspend()), 'no-conductor')
    assert.deepEqual(emitted, [])
  })

  test('refusals: a shell, a hibernated pane, an unconfirmed session, a pane not running', async () => {
    slot.kind = 'shell'
    assert.equal(codeOf(await suspend()), 'not-agent')
    slot.kind = 'claude'; mark = { asleep: true }
    assert.equal(codeOf(await suspend()), 'asleep')
    mark = {}; slot.status = 'unconfirmed'
    assert.equal(codeOf(await suspend()), 'unconfirmed')
    slot.status = 'stopped'
    assert.equal(codeOf(await suspend()), 'not-running')
    slot.status = 'running'; slot.canRestart = false
    assert.equal(codeOf(await suspend()), 'unconfirmed')
    assert.deepEqual(emitted, [])
  })

  test('the app refusing (cannot), a missing pane and no app answer', async () => {
    appAnswer = 'cannot'
    assert.equal(codeOf(await suspend()), 'cannot-suspend')
    appAnswer = 'no-pane'
    assert.equal(codeOf(await suspend()), 'no-pane')
    appAnswer = 'silent'
    assert.equal(codeOf(await suspend()), 'no-app')
    assert.deepEqual(touched, [])
  })

  test('list marks a suspended pane `suspended: true` and says suspensa', async () => {
    mark = { suspended: true }
    const d = deps as unknown as { api: Record<string, unknown>; store: Record<string, unknown> }
    d.api.objects = { get: () => undefined }
    d.api.delivery = { pathOf: () => 'wait', pending: () => [] }
    d.store.ownedDesks = () => []
    d.store.ownedPanes = () => [[PANE, { owner: OWNER, since: '' }]]
    d.store.deskFacts = () => ({})
    ;(deps as unknown as { pending: unknown }).pending = { held: () => [], count: () => 0 }
    const r = await listVerb.run(deps, caller, {}).catch(failOf)
    assert.match(r.text, /suspensa/)
    assert.equal(JSON.stringify(r.data).includes('"suspended":true'), true)
  })

  test('the app half answers the event through ui.panes.suspend', async () => {
    const seen: string[] = []
    const requests: unknown[] = []
    let cb: ((ev: unknown) => void) | undefined
    const ui = {
      daemon: { onEvent: (n: string, f: (ev: unknown) => void) => { if (n === SUSPEND_EVENT) cb = f; return { dispose() {} } }, request: async (n: string, a: unknown) => { assert.equal(n, HIBERNATED_REQUEST); requests.push(a) } },
      panes: { suspend: async (id: string) => { seen.push(id); return 'suspended' } },
      desks: {},
    }
    sleepBridge(ui as never)
    cb!({ ask: 's1', pane: PANE })
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(seen, [PANE])
    assert.deepEqual(requests, [{ ask: 's1', state: 'suspended' }])
  })
})
