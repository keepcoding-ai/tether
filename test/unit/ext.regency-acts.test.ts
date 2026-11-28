// RR5 step 5.1, tetherd's half: the bridge of the app's gestures asked from afar (extensions/regency/daemon.ts ActBridge).
// Proved here, with the bridge's own seams (no pipe):
// - only the portal asks (`remote`), and only an act of the closed list, field by field (src/remote/app-acts.ts);
// - no app holding the tree's lease: `no-app` at once, nothing emitted; an app that does not claim in time: `no-app`, and a
//   claim after that is refused (the act never runs late); claimed and not answered: `no-answer`;
// - tetherd confers what it knows alone: the desk, the pane IN that desk, the slot, the person typing in it, the agent;
// - one act at a time per target, and a ceiling of acts waiting (`busy`);
// - only the app's connection that holds the lease claims and answers; its answer goes by the allow list, a code outside the
//   app's list becomes `refused`;
// - waking a pane is the slot's start, done by tetherd alone, with or without the app.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { HUE_NAMES } from '../../app/shared/palette.ts'
import { ActBridge, type ActBridgeDeps } from '../../extensions/regency/daemon.ts'
import { APP_ACTS_PENDING_MAX, DESK_COLORS, type AppActEvent } from '../../src/remote/app-acts.ts'
import type { DeskMap, ExtRequestContext } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const REMOTE: ExtRequestContext = { client: 'remote', conn: 9 }
const APP: ExtRequestContext = { client: 'app', conn: 3 }
const code = (c: string) => (e: unknown): boolean => (e as { code?: string }).code === c

const MAP: DeskMap = {
  desks: [
    { id: 'desk-1', name: 'Obra', kind: 'queue', panes: [{ id: 's_1', type: 'terminal' }, { id: 'note-1', type: 'note' }] },
    { id: 'desk-2', name: 'Casa', kind: 'queue', panes: [{ id: 's_2', type: 'terminal' }] },
    { id: 'regency.main', name: 'Regência', kind: 'system', panes: [{ id: 'regency:main', type: 'regency' }] },
  ],
  drawer: [{ id: 's_4', type: 'terminal' }],
}

function bench(o: Partial<ActBridgeDeps> & { status?: Record<string, string>; typing?: string[] } = {}) {
  const events: AppActEvent[] = []
  const started: string[] = []
  let live = true
  const status: Record<string, string> = { s_1: 'running', s_2: 'exited', s_3: 'exited', s_4: 'running', a_1: 'running', ...(o.status ?? {}) }
  const bridge = new ActBridge({
    map: () => MAP,
    slots: {
      get: (id) => (status[id] ? ({ slotId: id, status: status[id] } as unknown as SlotState) : undefined),
      userFree: (id) => !(o.typing ?? []).includes(id),
      start: async (id) => { started.push(id); return { slotId: id, status: 'running' } as unknown as SlotState },
    },
    app: () => ({ live, conn: 3 }),
    emit: (name, payload) => { assert.equal(name, 'act'); events.push(payload as AppActEvent) },
    ackMs: 60, bridgeMs: 120,
    ...o,
  })
  return { bridge, events, started, setLive: (v: boolean) => { live = v } }
}

/** The app's part: claim the last event and answer it. */
async function appAnswers(b: ReturnType<typeof bench>, answer: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < 50 && b.events.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
  const ev = b.events.at(-1)!
  assert.deepEqual(b.bridge.take({ ask: ev.ask }, APP), { go: true })
  b.bridge.done({ ask: ev.ask, ...answer }, APP)
}

describe('the bridge of acts: who asks and what', () => {
  test('only the portal asks; an act outside the closed list, field by field, is bad-request; nothing emitted', async () => {
    const b = bench()
    for (const client of ['app', 'cli', 'test', undefined])
      await assert.rejects(b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-1' }, { client }), code('door-denied'), String(client))
    for (const args of [{ act: 'desks.hibernate' }, { act: 'desks.hibernate', deskId: 'desk-1', by: 'a_1' }, { act: 'object-set', kind: 'desk' }, { act: 'desks.rename', deskId: 'desk-1', name: ' x ' }, 'desks.hibernate'])
      await assert.rejects(b.bridge.act(args, REMOTE), code('bad-request'), JSON.stringify(args))
    assert.deepEqual(b.events, [])
  })

  test('the colours a desk may get are the app\'s hues', () => {
    assert.deepEqual([...DESK_COLORS], [...HUE_NAMES])
  })
})

describe('the bridge of acts: the app there or not', () => {
  test('no app holding the lease: no-app at once, nothing emitted, nothing kept for later', async () => {
    const b = bench()
    b.setLive(false)
    await assert.rejects(b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-2' }, REMOTE), code('no-app'))
    assert.deepEqual(b.events, [])
    assert.equal(b.bridge.pending, 0)
  })

  test('an app that does not claim in time is no app; its late claim is refused, so the act never runs', async () => {
    const b = bench()
    await assert.rejects(b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-2' }, REMOTE), code('no-app'))
    assert.equal(b.events.length, 1)
    assert.ok(b.events[0]!.until > Date.now() - 1_000 && b.events[0]!.until <= Date.now() + 60)
    assert.throws(() => b.bridge.take({ ask: b.events[0]!.ask }, APP), code('bad-request'))
    assert.equal(b.bridge.pending, 0)
  })

  test('claimed and done: the answer by the allow list; claimed and not answered: no-answer', async () => {
    const b = bench()
    const p = b.bridge.act({ act: 'desks.create', name: 'Obra nova', color: 'teal' }, REMOTE)
    await appAnswers(b, { ok: true, state: 'done', deskId: 'desk-9', name: 'vazou', extra: { x: 1 } })
    assert.deepEqual(await p, { state: 'done', deskId: 'desk-9' })
    assert.deepEqual(b.events[0]!.act, { act: 'desks.create', name: 'Obra nova', color: 'teal' })
    const q = b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-2' }, REMOTE)
    for (let i = 0; i < 50 && b.events.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    b.bridge.take({ ask: b.events[1]!.ask }, APP)
    await assert.rejects(q, code('no-answer'))
    assert.throws(() => b.bridge.done({ ask: b.events[1]!.ask, ok: true }, APP), code('bad-request'), 'a late answer finds nothing')
  })

  test("the app's refusal keeps its code when it is one of the app's; any other is refused", async () => {
    const b = bench()
    const p = b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-2' }, REMOTE)
    await appAnswers(b, { ok: false, code: 'in-view' })
    await assert.rejects(p, code('in-view'))
    for (const c of ['no-app', 'busy', 'door-denied', 'vazou', 7]) {
      const q = b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-2' }, REMOTE)
      await appAnswers(b, { ok: false, code: c })
      await assert.rejects(q, code('refused'), String(c))
    }
  })

  test('only the app, on the connection that holds the lease, claims and answers', async () => {
    const b = bench()
    const p = b.bridge.act({ act: 'desks.wake', deskId: 'desk-2' }, REMOTE)
    for (let i = 0; i < 50 && b.events.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    const ask = b.events[0]!.ask
    for (const ctx of [REMOTE, { client: 'cli', conn: 3 }, { client: 'app', conn: 4 }] as ExtRequestContext[])
      assert.throws(() => b.bridge.take({ ask }, ctx), code('door-denied'), JSON.stringify(ctx))
    assert.throws(() => b.bridge.done({ ask, ok: true }, APP), code('bad-request'), 'not claimed yet')
    b.bridge.take({ ask }, APP)
    assert.throws(() => b.bridge.take({ ask }, APP), code('bad-request'), 'claimed once')
    b.bridge.done({ ask, ok: true, state: 'already' }, APP)
    assert.deepEqual(await p, { state: 'already' })
  })
})

describe('the bridge of acts: what tetherd confers alone', () => {
  test('the desk, the pane in THAT desk, the slot, the agent; system desks and the drawer are no target', async () => {
    const b = bench()
    const cases: [Record<string, unknown>, string][] = [
      [{ act: 'desks.hibernate', deskId: 'nao-ha' }, 'unknown-desk'],
      [{ act: 'desks.rename', deskId: 'regency.main', name: 'X' }, 'unknown-desk'],
      [{ act: 'panes.hibernate', deskId: 'desk-2', paneId: 's_1' }, 'unknown-pane'],
      [{ act: 'panes.hibernate', deskId: 'desk-1', paneId: 's_4' }, 'unknown-pane'],
      [{ act: 'panes.hibernate', deskId: 'desk-1', paneId: 'note-1' }, 'cannot'],
      [{ act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'desk-1' }, 'same-desk'],
      [{ act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'nao-ha' }, 'unknown-desk'],
      [{ act: 'closed.reopen', slotId: 's_1', deskId: 'desk-2' }, 'not-closed'],
      [{ act: 'closed.reopen', slotId: 's_4', deskId: 'desk-2' }, 'not-closed'],
      [{ act: 'closed.reopen', slotId: 'nao_ha', deskId: 'desk-2' }, 'unknown-slot'],
      [{ act: 'closed.forget', slotId: 's_2' }, 'not-closed'],
      [{ act: 'owners.give', deskId: 'desk-1', to: 'nao_ha' }, 'unknown-agent'],
      [{ act: 'owners.give', deskId: 'desk-1', paneId: 'note-1', to: 'a_1' }, 'cannot'],
      [{ act: 'owners.take', deskId: 'desk-2', paneId: 's_1' }, 'unknown-pane'],
    ]
    for (const [args, c] of cases) await assert.rejects(b.bridge.act(args, REMOTE), code(c), JSON.stringify(args))
    assert.deepEqual(b.events, [], 'nothing reached the app')
  })

  test('the person typing in a pane: with-user for what would take it from under her hands', async () => {
    const b = bench({ typing: ['s_1'] })
    for (const args of [
      { act: 'panes.hibernate', deskId: 'desk-1', paneId: 's_1' }, { act: 'panes.suspend', deskId: 'desk-1', paneId: 's_1' },
      { act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'desk-2' }, { act: 'panes.close', deskId: 'desk-1', paneId: 's_1', process: 'keep' },
    ]) await assert.rejects(b.bridge.act(args, REMOTE), code('with-user'), args.act)
    assert.deepEqual(b.events, [])
  })

  test('one act at a time per target, and a ceiling of acts waiting', async () => {
    const b = bench({ ackMs: 400 })
    const first = b.bridge.act({ act: 'panes.hibernate', deskId: 'desk-1', paneId: 's_1' }, REMOTE)
    await assert.rejects(b.bridge.act({ act: 'panes.close', deskId: 'desk-1', paneId: 's_1', process: 'keep' }, REMOTE), code('busy'), 'the same pane')
    const other = b.bridge.act({ act: 'desks.hibernate', deskId: 'desk-2' }, REMOTE)
    assert.equal(b.bridge.pending, 2, 'another target goes')
    const creates = Array.from({ length: APP_ACTS_PENDING_MAX - 2 }, () => b.bridge.act({ act: 'desks.create', name: 'Nova' }, REMOTE).catch(() => undefined))
    await assert.rejects(b.bridge.act({ act: 'desks.wake', deskId: 'desk-1' }, REMOTE), code('busy'), 'the ceiling')
    await assert.rejects(first, code('no-app'))
    await other.catch(() => undefined)
    await Promise.all(creates)
    assert.equal(b.bridge.pending, 0)
  })

  test("a new desk is answered once tetherd's map shows it (the next act on it is not unknown), bounded", async () => {
    const listeners = new Set<() => void>()
    let map: DeskMap = { desks: [...MAP.desks], drawer: [] }
    const b = bench({ map: () => map, mapChanged: (l) => { listeners.add(l); return { dispose: () => listeners.delete(l) } }, mapWaitMs: 300 })
    let answered = false
    const p = b.bridge.act({ act: 'desks.create', name: 'Nova' }, REMOTE).then((r) => { answered = true; return r })
    await appAnswers(b, { ok: true, deskId: 'desk-9' })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(answered, false, 'waits for the map')
    map = { desks: [...MAP.desks, { id: 'desk-9', name: 'Nova', kind: 'queue', panes: [] }], drawer: [] }
    for (const l of listeners) l()
    assert.deepEqual(await p, { state: 'done', deskId: 'desk-9' })
    assert.equal(listeners.size, 0, 'the watch goes')
    const q = b.bridge.act({ act: 'desks.create', name: 'Outra' }, REMOTE)
    await appAnswers(b, { ok: true, deskId: 'desk-10' })
    assert.deepEqual(await q, { state: 'done', deskId: 'desk-10' }, 'a map that never shows it does not hold the answer past the bound')
  })

  test('waking a pane is the slot\'s start, by tetherd alone, app or not; live already; unconfirmed asks the pane', async () => {
    const b = bench({ status: { s_3: 'unconfirmed' } })
    b.setLive(false)
    assert.deepEqual(await b.bridge.act({ act: 'panes.wake', deskId: 'desk-2', paneId: 's_2' }, REMOTE), { state: 'done' })
    assert.deepEqual(b.started, ['s_2'])
    assert.deepEqual(await b.bridge.act({ act: 'panes.wake', deskId: 'desk-1', paneId: 's_1' }, REMOTE), { state: 'already' })
    await assert.rejects(b.bridge.act({ act: 'panes.wake', deskId: 'desk-1', paneId: 'note-1' }, REMOTE), code('cannot'))
    await assert.rejects(b.bridge.act({ act: 'panes.wake', deskId: 'desk-1', paneId: 's_2' }, REMOTE), code('unknown-pane'))
    assert.deepEqual(b.events, [])
  })
})
