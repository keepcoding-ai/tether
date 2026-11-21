// Tether for agents, slice X2: the ownership in the daemon. A real tetherd on a test home and test pipe, the for-agents
// extension activated by the daemon's extension host, fake agents in a .cjs file that echo what reaches their stdin. The
// person's gestures are written the way the app writes them (`object-set` on the pipe) and her keys go through the pipe's
// `input`; the agents' gestures go through the store. The user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { wire, type ForAgentsDaemon } from '../../extensions/for-agents/daemon.ts'
import { EXT_ID, manifest } from '../../extensions/for-agents/manifest.ts'
import type { Ownership } from '../../extensions/for-agents/rules.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorAttention, DoorSlots } from '../../src/daemon/door/types.ts'
import type { DeskMap, ObjectKind } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

// Raw stdin, so each chunk arrives as it is written; '\r' shows as "\r" in the echo.
const ECHO = [
  "if (process.stdin.isTTY) process.stdin.setRawMode(true)",
  "process.stdin.on('data', (d) => process.stdout.write('IN:' + JSON.stringify(d.toString()) + '\\r\\n'))",
  "process.stdout.write('READY\\r\\n')",
  'setInterval(() => {}, 1000)',
].join('\n')

interface Booted {
  daemon: Daemon
  door: DoorHost
  host: DaemonExtensionHost
  rec: Recorder
  fa: ForAgentsDaemon
  slots: DoorSlots
  attention: DoorAttention
  probe: DisposableStore
}

function fakeAdapter(home: string): AgentAdapter {
  return {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      return { command: process.execPath, args: [join(home, 'echo.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }
}

/** A tetherd with only for-agents, activated by the real extension host; `wire` is captured to reach its pieces. */
async function boot(home: string, logs: string[], withExt = true, delayObjectsMs = 0): Promise<Booted> {
  let fa: ForAgentsDaemon | undefined
  const entry: ExtensionEntry<TetherDaemon> = { manifest, activate: (api) => { const w = wire(api); fa = w.forAgents; return w.disposables } }
  const door = new DoorHost({ log: (m) => logs.push(m) })
  if (delayObjectsMs > 0) {
    // The read of <home>/objects is held back on purpose: the start pass must wait for it.
    const svc = door.objects as unknown as { load: (home: string) => Promise<void> }
    const load = svc.load.bind(svc)
    svc.load = async (h) => { await sleep(delayObjectsMs); return load(h) }
  }
  const host = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, extensions: withExt ? [entry] : [] })
  host.activate()
  const daemon = await startDaemon({
    home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { soul: fakeAdapter(home) }, door,
    transformPlan: host.transformPlan, onSlot: host.emitSlot, log: (m) => logs.push(m),
  })
  await door.releaseInactive(host.activated) // what main.ts runs between the start and emitStarted
  host.emitStarted()
  const rec = await Recorder.connect(daemon.pipe)
  const probe = new DisposableStore()
  const api = door.apiFor('probe', probe)
 if (withExt) assert.ok(fa, 'for-agents activated')
  return { daemon, door, host, rec, fa: fa as ForAgentsDaemon, slots: api.slots, attention: api.attention, probe }
}

const desk = (id: string, panes: string[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map((p) => ({ id: p, type: 'terminal' })) })

describe('for-agents: the ownership in the daemon (X2)', () => {
  let home: string
  let b: Booted
  const logs: string[] = []
  // A = Atrium and K = Kai (owners), p1..p3 = work panes, all slots of the fake agent.
  let A: string, K: string, p1: string, p2: string, p3: string

  before(async () => {
    home = tempHome()
    writeFileSync(join(home, 'echo.cjs'), ECHO)
    b = await boot(home, logs)
    const make = async (name: string): Promise<string> => {
      const id = (await b.slots.create({ kind: 'soul', cwd: home, name })).slotId
      await waitUntil(() => b.slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${name}`)
      return id
    }
    A = await make('Atrium'); K = await make('Kai'); p1 = await make('p1'); p2 = await make('p2'); p3 = await make('p3')
  })
  after(async () => {
    b.probe.dispose()
    b.rec.close()
    await b.daemon.close().catch(() => {})
    await removeHome(home)
  })

  /** The app's write of a gesture: one key of one object, through the pipe. */
  const appSet = async (kind: ObjectKind, objectId: string, key: string, value?: unknown): Promise<void> => {
    await b.rec.client.request({ t: 'object-set', ext: EXT_ID, kind, objectId, key, ...(value === undefined ? {} : { value }) })
    await b.fa.idle()
  }
  const sendMap = async (map: DeskMap): Promise<void> => { await b.rec.client.request({ t: 'desk-map', map }); await b.fa.idle() }
  const port = (id: string): { held?: string; route?: string } => {
    const held = b.slots.get(id)?.held
    const route = b.attention.routeOf(id)
    return { ...(held ? { held: `${held.ext}:${held.by}` } : {}), ...(route ? { route } : {}) }
  }
  const by = (owner: string): { held: string; route: string } => ({ held: `${EXT_ID}:${owner}`, route: owner })
  const typeKey = async (id: string, data: string): Promise<void> => { b.rec.client.input(id, data); await sleep(250); await b.fa.idle() }
  const mapWith = (cena: string[], casa: string[]): DeskMap => ({ desks: [desk('cena', cena), desk('casa', casa), desk('sistema', [], 'system')], drawer: [] })

  test('giving the desk holds and routes every inherited pane, and not the owner\'s own pane', async () => {
    await sendMap(mapWith([A, p1, p2], [K, p3]))
    for (const id of [A, K, p1, p2, p3]) assert.deepEqual(port(id), {}, 'nothing before a gift')
    await appSet('desk', 'cena', 'owner', { owner: A, since: new Date().toISOString(), givenBy: 'user' } satisfies Ownership)
    assert.deepEqual(port(p1), by(A))
    assert.deepEqual(port(p2), by(A))
    assert.deepEqual(port(A), {}, 'the owner\'s own pane in its desk is the person\'s')
    assert.deepEqual(port(K), {})
    assert.deepEqual(port(p3), {}, 'another desk')
  })

  test('a system desk takes no owner, and only the person gives a desk', async () => {
    await assert.rejects(b.fa.store.giveDesk('sistema', A), { code: 'system-desk' })
    await assert.rejects(b.fa.store.giveDesk('casa', A, K), { code: 'not-owner' })
    await assert.rejects(b.fa.store.giveDesk('nenhuma', A), { code: 'unknown-desk' })
  })

  test('the desk\'s owner gives a pane to another: the hold and the route change to it', async () => {
    await assert.rejects(b.fa.store.givePane(p2, K, K), { code: 'not-owner' }, 'Kai is not the owner of the desk')
    await b.fa.store.givePane(p2, K, A)
    await b.fa.idle()
    assert.deepEqual(port(p2), by(K))
    assert.deepEqual(port(p1), by(A), 'the other pane stays')
    assert.equal(b.fa.store.paneFacts(p2).owner?.givenBy, A)
  })

  test('moving a pane between desks reconciles it; a given pane keeps its owner wherever it goes', async () => {
    await sendMap(mapWith([A, p2], [K, p3, p1]))
    assert.deepEqual(port(p1), {}, 'inherited, moved to a desk with no owner: back to the person')
    assert.deepEqual(port(p2), by(K))
    await sendMap(mapWith([A, p1], [K, p3, p2]))
    assert.deepEqual(port(p1), by(A), 'back in the owned desk')
    assert.deepEqual(port(p2), by(K), 'given: the data is the pane\'s')
  })

  test('a key of the person takes the pane: the hold and the route go, and the hand says typing', async () => {
    await typeKey(p1, 'x')
    assert.deepEqual(port(p1), {})
    const hand = b.fa.store.paneFacts(p1).hand
    assert.equal(hand?.why, 'taken')
    assert.equal(hand?.by, 'typing')
    assert.deepEqual(port(p2), by(K), 'another pane is not touched')
    await typeKey(p3, 'y')
    assert.equal(b.fa.store.paneFacts(p3).hand, undefined, 'a pane nobody commands is not taken')
  })

  test('giving back (the app deletes the hand) puts the hold and the route back', async () => {
    await appSet('pane', p1, 'hand')
    assert.deepEqual(port(p1), by(A))
  })

  test('pausing in the three scopes: a pane, a desk (only what the desk commands), everything of an owner', async () => {
    await b.fa.store.take({ pane: p1 }, 'paused'); await b.fa.idle()
    assert.deepEqual(port(p1), {})
    await b.fa.store.giveBack({ pane: p1 }); await b.fa.idle()
    assert.deepEqual(port(p1), by(A))

    await sendMap(mapWith([A, p1, p2], [K, p3]))
    await b.fa.store.take({ desk: 'cena' }, 'paused'); await b.fa.idle()
    assert.deepEqual(port(p1), {}, 'inherited from the paused desk')
    assert.deepEqual(port(p2), by(K), 'given to another: stays')
    await b.fa.store.giveBack({ desk: 'cena' }); await b.fa.idle()
    assert.deepEqual(port(p1), by(A))

    await b.fa.store.freeze(A); await b.fa.idle()
    assert.deepEqual(port(p1), {}, 'frozen everywhere')
    assert.deepEqual(port(p2), by(K))
    await b.fa.store.unfreeze(A); await b.fa.idle()
    assert.deepEqual(port(p1), by(A))
  })

  test('the agent\'s own pane ("de si") is held with no route; the person typing in it does not take it', async () => {
    await b.fa.store.givePane(A, A); await b.fa.idle()
    assert.deepEqual(port(A), { held: `${EXT_ID}:${A}` })
    await typeKey(A, 'oi')
    assert.deepEqual(port(A), { held: `${EXT_ID}:${A}` })
    assert.equal(b.fa.store.paneFacts(A).hand, undefined)
  })

  test('the gate: refuses a non-commander, refuses with a draft of the person, writes when free, stops at her key', async () => {
    assert.equal(b.fa.gate.check(p1, K), 'not-commanded', 'Kai has nothing on p1')
    assert.equal(b.fa.gate.check(p2, A), 'not-commanded', 'Atrium only sees p2')
    // A draft of the person in the agent's own pane: the self pane is not taken by typing, so the presence is what refuses.
    const before = b.slots.readScreen(A).end
    const r1 = await b.fa.gate.write(A, A, [{ text: 'tether' }, { keys: ['enter'] }])
    assert.deepEqual(r1, { ok: false, why: 'with-user', written: 0 })
    await sleep(300)
    assert.ok(!b.slots.readScreen(A, { since: before }).data.includes('tether'), 'not a byte')

    // With the hand with the person.
    await b.fa.store.take({ pane: p1 }, 'taken'); await b.fa.idle()
    assert.deepEqual(await b.fa.gate.write(p1, A, [{ text: 'z' }]), { ok: false, why: 'with-user', written: 0 })
    await b.fa.store.giveBack({ pane: p1 }); await b.fa.idle()

    // p2 (Kai's): nobody typed there. The write goes; then a key of the person in the pause stops the Enter.
    const mark = b.slots.readScreen(p2).end
    assert.deepEqual(await b.fa.gate.write(p2, K, [{ text: 'abc' }, { waitMs: 150 }, { keys: ['enter'] }]), { ok: true })
    await waitUntil(() => b.slots.readScreen(p2, { since: mark }).data.includes('IN:"\\r"'), 10_000, 'the Enter of the free write')
    // A fresh pane (the gate's own write counts as typing in the presence for USER_QUIET_MS, and p3 has a draft of hers).
    const p4 = (await b.slots.create({ kind: 'soul', cwd: home, name: 'p4' })).slotId
    await waitUntil(() => b.slots.readScreen(p4).data.includes('READY'), 30_000, 'READY in p4')
    await appSet('pane', p4, 'owner', { owner: K, since: new Date().toISOString(), givenBy: 'user' } satisfies Ownership)
    assert.deepEqual(port(p4), by(K))
    const mark4 = b.slots.readScreen(p4).end
    const writing = b.fa.gate.write(p4, K, [{ text: 'def' }, { waitMs: 800 }, { keys: ['enter'] }])
    await sleep(250)
    b.rec.client.input(p4, 'q')
    assert.deepEqual(await writing, { ok: false, why: 'with-user', written: 2 })
    await sleep(300)
    const seen = b.slots.readScreen(p4, { since: mark4 }).data
    assert.ok(seen.includes('IN:"def"') && seen.includes('IN:"q"'), seen)
    assert.ok(!seen.includes('IN:"\\r"'), 'the Enter did not go')
    await b.fa.idle()
    assert.deepEqual(port(p4), {}, 'and the key took the pane')
    await b.slots.forget(p4)
  })

  test('F12: with "answer" off, a card on the screen sends the request to the person; the hold stays', async () => {
    b.fa.reconciler.setCard(p1, true); await b.fa.idle()
    assert.deepEqual(port(p1), by(A), 'with everything on, the card goes to the owner')
    await appSet('desk', 'cena', 'inventory', { answer: false })
    assert.deepEqual(port(p1), { held: `${EXT_ID}:${A}` })
    b.fa.reconciler.setCard(p1, false); await b.fa.idle()
    assert.deepEqual(port(p1), by(A))
    await appSet('desk', 'cena', 'inventory')
  })

  test('reconciling twice in a row: the second pass emits nothing', async () => {
    await b.attention.unroute(p1) // a divergence, so the first pass has work
    const n0 = b.rec.states.length
    await b.fa.reconciler.reconcileAll()
    await sleep(200)
    const n1 = b.rec.states.length
    assert.ok(n1 > n0, 'the first pass mended the route')
    assert.deepEqual(port(p1), by(A))
    const file = readFileSync(join(home, 'objects', 'for-agents.json'), 'utf8')
    await b.fa.reconciler.reconcileAll()
    await sleep(200)
    assert.equal(b.rec.states.length, n1, 'no state emitted by the second pass')
    assert.equal(readFileSync(join(home, 'objects', 'for-agents.json'), 'utf8'), file, 'nothing written')
  })

  test('a forgotten owner: the struck mark on what it owned, the holds and routes go', async () => {
    const X = (await b.slots.create({ kind: 'soul', cwd: home, name: 'Xis' })).slotId
    await waitUntil(() => b.slots.readScreen(X).data.includes('READY'), 30_000, 'READY in Xis')
    await sendMap({ desks: [desk('cena', [A, p1, p2]), desk('casa', [K, p3]), desk('tres', [X])], drawer: [] })
    await b.fa.store.giveDesk('tres', X); await b.fa.store.givePane(p3, X); await b.fa.idle()
    assert.deepEqual(port(p3), by(X))
    await b.slots.forget(X)
    await waitUntil(() => b.fa.store.deskFacts('tres').owner?.ended !== undefined && b.fa.store.paneFacts(p3).owner?.ended !== undefined, 10_000, 'ended')
    await b.fa.idle()
    assert.equal(b.fa.store.deskFacts('tres').owner?.ended?.name, 'Xis')
    assert.equal(b.fa.store.paneFacts(p3).owner?.ended?.name, 'Xis')
    assert.deepEqual(port(p3), {}, 'nothing commands it: back to the person, not to another agent')
    assert.equal(b.fa.store.effectiveOf(p3).ended?.owner, X)
  })

  test('turning the extension off undoes the holds and the routes; the data stays in the file', async () => {
    assert.deepEqual(port(p1), by(A))
    assert.deepEqual(port(p2), by(K))
    b.host.dispose()
    await waitUntil(() => [A, K, p1, p2, p3].every((id) => !b.slots.get(id)?.held && !b.attention.routeOf(id)), 10_000, 'undone')
    const data = JSON.parse(readFileSync(join(home, 'objects', 'for-agents.json'), 'utf8')) as { desk: Record<string, unknown> }
    assert.ok(data.desk.cena, 'the desk keeps its owner on disk')
  })
})

describe('for-agents: a restarted daemon keeps the ownership', () => {
  test('holds, routes and data survive; the start pass changes nothing', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'echo.cjs'), ECHO)
    const logs: string[] = []
    let b = await boot(home, logs)
    try {
      const make = async (name: string): Promise<string> => {
        const id = (await b.slots.create({ kind: 'soul', cwd: home, name })).slotId
        await waitUntil(() => b.slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${name}`)
        return id
      }
      const A = await make('Atrium'), K = await make('Kai'), p1 = await make('p1'), p2 = await make('p2')
      await b.rec.client.request({ t: 'desk-map', map: { desks: [desk('cena', [A, p1, p2]), desk('casa', [K])], drawer: [] } })
      await b.fa.store.giveDesk('cena', A); await b.fa.store.givePane(p2, K, A); await b.fa.store.givePane(K, K); await b.fa.idle()
      const want = (id: string) => ({ held: b.slots.get(id)?.held, route: b.attention.routeOf(id) })
      const before = Object.fromEntries([A, K, p1, p2].map((id) => [id, want(id)]))
      assert.deepEqual(before[p1], { held: { ext: EXT_ID, by: A }, route: A })
      assert.deepEqual(before[p2], { held: { ext: EXT_ID, by: K }, route: K })
      assert.deepEqual(before[K], { held: { ext: EXT_ID, by: K }, route: undefined })
      await b.door.objects.flush(); await b.door.desks.flush()

      // The daemon goes (the extension is not turned off: tetherd never disposes it), and a new one starts on the same home.
      b.probe.dispose(); b.rec.close()
      await b.daemon.close()
      b = await boot(home, logs)
      await b.fa.idle()
      const after = Object.fromEntries([A, K, p1, p2].map((id) => [id, want(id)]))
      assert.deepEqual(after, before)
      assert.equal(b.fa.store.deskFacts('cena').owner?.owner, A)
      const n = b.rec.states.length
      await b.fa.reconciler.reconcileAll()
      await sleep(200)
      assert.equal(b.rec.states.length, n, 'the restarted state needs no mending')
    } finally {
      b.probe.dispose(); b.rec.close()
      await b.daemon.close().catch(() => {})
      await removeHome(home)
    }
  })
})

describe('for-agents: a hold of an inactive extension goes at the start', () => {
  test('without the extension the hold and the route go; with it they stay', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'echo.cjs'), ECHO)
    const logs: string[] = []
    let b = await boot(home, logs)
    try {
      const make = async (name: string): Promise<string> => {
        const id = (await b.slots.create({ kind: 'soul', cwd: home, name })).slotId
        await waitUntil(() => b.slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${name}`)
        return id
      }
      const A = await make('Atrium'), p1 = await make('p1')
      await b.fa.store.givePane(p1, A); await b.fa.idle()
      assert.deepEqual(b.slots.get(p1)?.held, { ext: EXT_ID, by: A })
      assert.equal(b.attention.routeOf(p1), A)
      await b.door.objects.flush(); await b.door.desks.flush()
      const restart = async (withExt: boolean): Promise<void> => {
        b.probe.dispose(); b.rec.close()
        await b.daemon.close()
        b = await boot(home, logs, withExt)
        if (withExt) await b.fa.idle()
      }

      // With it: nothing is swept.
      await restart(true)
      assert.deepEqual(b.slots.get(p1)?.held, { ext: EXT_ID, by: A })
      assert.equal(b.attention.routeOf(p1), A)
      assert.equal(logs.filter((l) => l.includes('extensão inativa')).length, 0)

      // Without it: the hold and the route go, one log line, and the state carries no `held`.
      await restart(false)
      assert.equal(b.slots.get(p1)?.held, undefined)
      assert.equal(b.attention.routeOf(p1), undefined)
      assert.equal(b.slots.get(A)?.held, undefined)
      assert.equal(logs.filter((l) => l.includes(`slot ${p1}: posse da extensão inativa ${EXT_ID}`)).length, 1)
      assert.ok(!('held' in (b.slots.get(p1) ?? {})))
    } finally {
      b.probe.dispose(); b.rec.close()
      await b.daemon.close().catch(() => {})
      await removeHome(home)
    }
  })
})

describe('for-agents: the start pass waits for the data', () => {
  test('with the objects read late, a given pane keeps its hold', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'echo.cjs'), ECHO)
    const logs: string[] = []
    let b = await boot(home, logs)
    try {
      const make = async (name: string): Promise<string> => {
        const id = (await b.slots.create({ kind: 'soul', cwd: home, name })).slotId
        await waitUntil(() => b.slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${name}`)
        return id
      }
      const A = await make('Atrium'), p1 = await make('p1')
      await b.fa.store.givePane(p1, A); await b.fa.idle()
      await b.door.objects.flush(); await b.door.desks.flush()
      b.probe.dispose(); b.rec.close()
      await b.daemon.close()
      b = await boot(home, logs, true, 800)
      await b.fa.idle()
      assert.deepEqual(b.slots.get(p1)?.held, { ext: EXT_ID, by: A })
      assert.equal(b.attention.routeOf(p1), A)
      assert.equal(b.fa.store.effectiveOf(p1).commander, A)
    } finally {
      b.probe.dispose(); b.rec.close()
      await b.daemon.close().catch(() => {})
      await removeHome(home)
    }
  })
})
