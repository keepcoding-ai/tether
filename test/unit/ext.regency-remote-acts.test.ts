// RR5 step 5.1, the app's half (extensions/regency/renderer/remote-acts.ts) on a fake app: the act is claimed before it is
// done (a claim tetherd refuses does nothing; an event past its time does nothing), done with the app's own seams and no
// dialog (the seams it gets have none), the desk in view never changed (`in-view`), the pane checked in its desk, the agent
// alive, the ownership through for-agents' own commands, and "Feito de longe" said on the machine.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createOwnerBoard } from '../../extensions/for-agents/renderer/owner-board.ts'
import type { Ownership } from '../../extensions/for-agents/rules.ts'
import { remoteActRunner, remoteActs, type RemoteActsUi } from '../../extensions/regency/renderer/remote-acts.ts'
import type { AppActEvent } from '../../src/remote/app-acts.ts'

function fakeApp() {
  const calls: unknown[][] = []
  const desks = [
    { id: 'desk-1', name: 'Obra', color: 'blue', asleep: false, panes: ['s_1', 'note-1'] },
    { id: 'desk-2', name: 'Casa', color: 'green', asleep: false, panes: ['s_2'] },
  ]
  let active = 'desk-1'
  const requests: [string, unknown][] = []
  const listeners = new Map<string, (p: unknown) => void>()
  let takeOk = true
  const board = createOwnerBoard()
  board.setActive(true)
  const owners = { desk: new Map<string, Ownership>(), pane: new Map<string, Ownership>() }
  const ui: RemoteActsUi = {
    desks: {
      list: () => desks,
      activeId: () => active,
      tree: () => ({ desks: desks.map(d => ({ id: d.id, name: d.name, color: d.color, kind: 'queue' as const, asleep: d.asleep, panes: d.panes.map(id => ({ id, type: id.startsWith('s_') ? 'terminal' : 'note', icon: '', title: `T ${id}` })) })) }),
      hibernate: async (id) => { calls.push(['hibernate', id]); return id === active ? { state: 'in-view', panes: [] } : { state: 'asleep', panes: [] } },
      wake: async (id) => { calls.push(['wake', id]); return { state: 'woke', panes: [] } },
      create: (spec) => { calls.push(['create', spec]); desks.push({ id: 'desk-9', name: spec?.name ?? '', color: 'red', asleep: false, panes: [] }); return 'desk-9' },
      rename: (id, name) => { calls.push(['rename', id, name]); return true },
      recolor: (id, color) => { calls.push(['recolor', id, color]); return true },
      close: async (id, opts) => { calls.push(['close', id, opts]); return id === active ? 'in-view' : 'closed' },
    },
    panes: {
      find: () => undefined,
      describe: (id) => ({ id, type: id.startsWith('s_') ? 'terminal' : 'note' }) as never,
      hibernate: async (id) => { calls.push(['pane-hibernate', id]); return 'asleep' },
      suspend: async (id) => { calls.push(['pane-suspend', id]); return 'cannot' },
      moveToDesk: (id, to) => { calls.push(['move', id, to]); return true },
      closeGuide: async (id, opts) => { calls.push(['closeGuide', id, opts]) },
    },
    sessions: {
      closed: () => [{ slotId: 's_9', kind: 'claude', name: 'antigo' }] as never,
      reopen: (slotId, deskId) => { calls.push(['reopen', slotId, deskId]); return true },
      forget: async (slotId) => { calls.push(['forget', slotId]); return undefined },
    },
    agents: { get: (id) => (id === 'a_1' ? ({ slotId: 'a_1', name: 'conferente', alive: true }) as never : undefined) },
    commands: {
      run: async (id, arg) => {
        calls.push(['command', id, arg])
        const t = arg as { kind: 'desk' | 'pane'; id: string; to?: string }
        const map = t.kind === 'desk' ? owners.desk : owners.pane
        if (id === 'for-agents.give') map.set(t.id, { owner: t.to!, since: '', givenBy: 'user' } as Ownership)
        if (id === 'for-agents.revoke') map.delete(t.id)
        board.publish(owners.desk, owners.pane)
        return 'ran'
      },
    },
    daemon: {
      request: async (name: string, args?: unknown) => {
        requests.push([name, args])
        if (name === 'act.take' && !takeOk) throw Object.assign(new Error('gone'), { code: 'bad-request' })
        return {} as never
      },
      onEvent: (name: string, l: (p: never) => void) => { listeners.set(name, l as (p: unknown) => void); return { dispose: () => listeners.delete(name) } },
    },
  }
  return { ui, calls, requests, board, setActive: (id: string) => { active = id }, emit: (p: AppActEvent) => listeners.get('act')!(p), refuseTake: () => { takeOk = false } }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('the app does an act from afar with its own rules', () => {
  test('a desk in view is never hibernated nor closed (the desk would switch): in-view; another goes, no dialog', async () => {
    const f = fakeApp()
    const run = remoteActRunner(f.ui, { owners: f.board, notice: () => {} })
    assert.deepEqual(await run({ act: 'desks.hibernate', deskId: 'desk-1' }), { ok: false, code: 'in-view' })
    assert.deepEqual(await run({ act: 'desks.close', deskId: 'desk-1', seen: 'Obra', panes: 'move' }), { ok: false, code: 'in-view' })
    assert.equal((await run({ act: 'desks.hibernate', deskId: 'desk-2' })).ok, true)
    assert.deepEqual(await run({ act: 'desks.close', deskId: 'desk-2', seen: 'Casa', panes: 'stop' }), { ok: true, state: 'done', said: 'mesa Casa fechada' })
    assert.deepEqual(f.calls.at(-1), ['close', 'desk-2', { panes: 'stop' }], 'the answer of the dialog comes in the act')
  })

  test('RR5 M-1: the desk is checked by the name the device saw; another desk under that id is stale and nothing is done', async () => {
    const f = fakeApp()
    const run = remoteActRunner(f.ui, { owners: f.board, notice: () => {}, ownerWaitMs: 50 })
    for (const a of [
      { act: 'desks.close', deskId: 'desk-2', seen: 'Rascunhos', panes: 'stop' },
      { act: 'panes.close', deskId: 'desk-2', seen: 'Rascunhos', paneId: 's_2', process: 'stop' },
      { act: 'owners.give', deskId: 'desk-2', seen: 'Rascunhos', to: 'a_1' },
      { act: 'owners.revoke', deskId: 'desk-2', seen: 'Rascunhos' },
      { act: 'owners.take', deskId: 'desk-2', seen: 'Rascunhos', paneId: 's_2' },
      { act: 'owners.return', deskId: 'desk-2', seen: 'Rascunhos' },
    ] as const) assert.deepEqual(await run(a), { ok: false, code: 'stale' }, a.act)
    assert.deepEqual(await run({ act: 'desks.close', deskId: 'desk-7', seen: 'Casa', panes: 'stop' }), { ok: false, code: 'unknown-desk' })
    assert.deepEqual(f.calls, [], 'nothing was done')
  })

  test('a new desk at the end of the queue, staying where the person is; rename and recolour; already when nothing changes', async () => {
    const f = fakeApp()
    const run = remoteActRunner(f.ui, { owners: f.board, notice: () => {} })
    assert.deepEqual(await run({ act: 'desks.create', name: 'Nova', color: 'teal' }), { ok: true, state: 'done', said: 'mesa Nova criada', deskId: 'desk-9' })
    assert.deepEqual(f.calls[0], ['create', { name: 'Nova', color: 'teal', after: 'desk-2', stay: true }])
    assert.equal((await run({ act: 'desks.rename', deskId: 'desk-1', name: 'Obra' })).ok && 'already', 'already')
    assert.equal((await run({ act: 'desks.rename', deskId: 'desk-1', name: 'Obra 2' })).ok, true)
    assert.deepEqual(await run({ act: 'desks.rename', deskId: 'nao-ha', name: 'x' }), { ok: false, code: 'unknown-desk' })
    assert.equal((await run({ act: 'desks.color', deskId: 'desk-2', color: 'green' })).ok && 'already', 'already')
  })

  test('a pane is checked in the desk the device named; a pane that cannot suspend says so', async () => {
    const f = fakeApp()
    const run = remoteActRunner(f.ui, { owners: f.board, notice: () => {} })
    assert.deepEqual(await run({ act: 'panes.hibernate', deskId: 'desk-2', paneId: 's_1' }), { ok: false, code: 'unknown-pane' })
    assert.equal((await run({ act: 'panes.hibernate', deskId: 'desk-1', paneId: 's_1' })).ok, true)
    assert.deepEqual(await run({ act: 'panes.suspend', deskId: 'desk-1', paneId: 's_1' }), { ok: false, code: 'cannot' })
    assert.deepEqual(await run({ act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'desk-1' }), { ok: false, code: 'same-desk' })
    assert.equal((await run({ act: 'panes.move', deskId: 'desk-1', paneId: 's_1', to: 'desk-2' })).ok, true)
    assert.equal((await run({ act: 'panes.close', deskId: 'desk-1', seen: 'Obra', paneId: 's_1', process: 'keep' })).ok, true)
    assert.deepEqual(f.calls.at(-1), ['closeGuide', 's_1', { process: 'keep' }])
    assert.deepEqual(await run({ act: 'closed.reopen', slotId: 's_1', deskId: 'desk-2' }), { ok: false, code: 'not-closed' })
    assert.equal((await run({ act: 'closed.reopen', slotId: 's_9', deskId: 'desk-2' })).ok, true)
    assert.equal((await run({ act: 'closed.forget', slotId: 's_9' })).ok, true)
  })

  test("ownership through for-agents' commands: a live agent only, the board shows it; take back what was given; nothing to take back", async () => {
    const f = fakeApp()
    const run = remoteActRunner(f.ui, { owners: f.board, notice: () => {}, ownerWaitMs: 200 })
    assert.deepEqual(await run({ act: 'owners.give', deskId: 'desk-1', seen: 'Obra', to: 'nao_ha' }), { ok: false, code: 'unknown-agent' })
    assert.deepEqual(await run({ act: 'owners.give', deskId: 'desk-1', seen: 'Obra', paneId: 'note-1', to: 'a_1' }), { ok: false, code: 'cannot' })
    assert.deepEqual(await run({ act: 'owners.revoke', deskId: 'desk-1', seen: 'Obra' }), { ok: false, code: 'not-given' })
    assert.deepEqual(await run({ act: 'owners.take', deskId: 'desk-1', seen: 'Obra', paneId: 's_1' }), { ok: false, code: 'not-given' })
    assert.deepEqual(await run({ act: 'owners.give', deskId: 'desk-1', seen: 'Obra', to: 'a_1' }), { ok: true, state: 'done', said: 'a mesa Obra dada a conferente' })
    assert.deepEqual(f.calls.at(-1), ['command', 'for-agents.give', { kind: 'desk', id: 'desk-1', to: 'a_1' }])
    assert.equal((await run({ act: 'owners.give', deskId: 'desk-1', seen: 'Obra', to: 'a_1' })).ok && 'already', 'already')
    assert.equal((await run({ act: 'owners.take', deskId: 'desk-1', seen: 'Obra', paneId: 's_1' })).ok, true, 'its desk commands it: the command can be taken')
    assert.deepEqual(await run({ act: 'owners.revoke', deskId: 'desk-1', seen: 'Obra' }), { ok: true, state: 'done', said: 'a mesa Obra tirada de conferente' })
    f.board.setActive(false)
    assert.deepEqual(await run({ act: 'owners.give', deskId: 'desk-1', seen: 'Obra', to: 'a_1' }), { ok: false, code: 'owners-off' })
  })
})

describe('the event: claimed first, answered after, said on the machine', () => {
  test('claimed, done, answered; the person is told it was done from afar', async () => {
    const f = fakeApp()
    const said: string[] = []
    remoteActs(f.ui, { owners: f.board, notice: (t) => said.push(t) })
    f.emit({ ask: 'a1', act: { act: 'desks.hibernate', deskId: 'desk-2' }, until: Date.now() + 1_000 })
    await settle()
    assert.deepEqual(f.requests, [['act.take', { ask: 'a1' }], ['act.done', { ask: 'a1', ok: true, state: 'done' }]])
    assert.deepEqual(said, ['Feito de longe: mesa Casa hibernada.'])
    f.emit({ ask: 'a2', act: { act: 'desks.hibernate', deskId: 'desk-1' }, until: Date.now() + 1_000 })
    await settle()
    assert.deepEqual(f.requests.at(-1), ['act.done', { ask: 'a2', ok: false, code: 'in-view' }])
    assert.equal(said.length, 1, 'a refusal is not said as done')
  })

  test('a claim tetherd refuses, an event past its time or outside the list: nothing is done', async () => {
    const f = fakeApp()
    remoteActs(f.ui, { owners: f.board, notice: () => {} })
    f.emit({ ask: 'old', act: { act: 'desks.hibernate', deskId: 'desk-2' }, until: Date.now() - 1 })
    f.emit({ ask: 'x', act: { act: 'desks.hibernate', deskId: 'desk-2', by: 'a_1' } as never, until: Date.now() + 1_000 })
    f.emit({ ask: 'y', act: { act: 'object-set' } as never, until: Date.now() + 1_000 })
    await settle()
    assert.deepEqual(f.requests, [], 'not even claimed')
    f.refuseTake()
    f.emit({ ask: 'late', act: { act: 'desks.hibernate', deskId: 'desk-2' }, until: Date.now() + 1_000 })
    await settle()
    assert.deepEqual(f.requests, [['act.take', { ask: 'late' }]])
    assert.deepEqual(f.calls, [], 'the act never ran')
  })
})
