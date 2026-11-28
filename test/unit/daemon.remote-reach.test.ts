// RR3 gate B-8: tetherd checks the reach of the `remote` client itself, by the tables the portal sends by
// (src/remoted/reach.ts). Proved on a bench tetherd with a portal credential of its own (never the person's tether):
// - an ext-request of a pair outside the reach is refused (`door-denied`), the handler never runs, the pipe stays up;
// - every pair of the reach passes and reaches its handler as `remote`;
// - every type PIPE_REACH marks `never` is refused to that client (a request with `door-denied`, a keystroke dropped);
// - `cli` and `app` keep the whole pipe;
// - the log line of a refusal names the type alone, never the extension, the name nor the arguments;
// - parity: the portal's own sender (pipeReads) through a real `remote` connection is never refused by tetherd.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { setPortalCredential } from '../../src/daemon/handshake.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { EXT_READS, EXT_WRITES, PIPE_REACH, REMOTE_EXT_PAIRS, type ExtReadOp, type ExtWriteOp, type PipeType } from '../../src/remoted/gate.ts'
import { pipeReads, type ExtRequestFn } from '../../src/remoted/reads.ts'
import { pipeWrites } from '../../src/remoted/writes.ts'
import { ActError, pipeActs } from '../../src/remoted/acts.ts'
import { manageArgs, type ManageOp } from '../../src/remote/manage.ts'
import { opByName } from '../../src/remote/index.ts'
import { removeHome, uniquePipe } from './daemon.helpers.ts'
import { benchHome, until } from './remoted.helpers.ts'

const MARKER = `canary${randomBytes(8).toString('hex')}`
const denied = (e: unknown): boolean => e instanceof DaemonError && e.code === 'door-denied'

/** The handlers of two bench extensions: the reads of the reach and writes beside them, each recording who called. */
const HANDLERS: Record<string, readonly string[]> = {
  // The reads and the person's speech of the reach, and beside them what manages a channel (outside it).
  channels: ['marks', 'history', 'say', 'react', 'vote', 'poll', 'seen', 'create', 'mute', 'poll-close'],
  regency: ['tree.read', 'tree.publish'],
}
const NEVER = Object.entries(PIPE_REACH).filter(([, r]) => r === 'never').map(([t]) => t as PipeType)
const KEYSTROKES: readonly PipeType[] = ['input', 'typed']

describe('tetherd: the reach of the remote client (B-8)', () => {
  const home = benchHome('tether-remote-reach-')
  const pipe = uniquePipe(home)
  const cred = randomBytes(32)
  const logs: string[] = []
  const calls: { ext: string; name: string; client: string | undefined }[] = []
  let daemon: Daemon
  let host: DaemonExtensionHost
  let remote: DaemonClient

  before(async () => {
    const door = new DoorHost({ log: () => {} })
    const extensions = Object.entries(HANDLERS).map(([id, names]) => ({
      manifest: { id, version: '0.0.0', displayName: id, description: id, hosts: ['daemon'] },
      activate: (api: { requests: { handle: (name: string, fn: (args: unknown, ctx: { client?: string }) => unknown) => unknown } }) => {
        for (const name of names) api.requests.handle(name, (_args, ctx) => { calls.push({ ext: id, name, client: ctx.client }); return { ext: id, name } })
        return []
      },
    }))
    host = new DaemonExtensionHost({ home, log: () => {}, door, extensions: extensions as never })
    host.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    host.emitStarted()
    setPortalCredential(home, cred)
    remote = await DaemonClient.open(pipe, 'remote', { home, cred: cred.toString('hex') })
  })
  after(async () => { remote?.close(); setPortalCredential(home, undefined); host?.dispose(); await daemon?.close(); await removeHome(home) })

  test('the connection is the portal: tetherd took it as remote', async () => {
    const hello = await remote.request({ t: 'list' })
    assert.ok(Array.isArray(hello.slots))
    calls.length = 0
    await remote.request({ t: 'ext-request', ext: 'regency', name: 'tree.read' })
    assert.deepEqual(calls, [{ ext: 'regency', name: 'tree.read', client: 'remote' }])
  })

  test('a pair outside the reach is refused, its handler never runs, and the pipe stays up', async () => {
    calls.length = 0
    const from = logs.length
    for (const [ext, name] of [['channels', 'create'], ['channels', 'mute'], ['channels', 'poll-close'], ['regency', 'tree.publish'], ['remote', 'device.revoke'], [MARKER, MARKER], ['channels', 7], [undefined, 'marks'], ['channels', '__proto__']] as const)
      await assert.rejects(remote.request({ t: 'ext-request', ext, name, args: { text: MARKER } } as never), denied, `${String(ext)} ${String(name)}`)
    assert.deepEqual(calls, [], 'no handler ran')
    assert.ok(Array.isArray((await remote.request({ t: 'list' })).slots), 'the same connection still answers')
    const lines = logs.slice(from)
    assert.equal(lines.filter((l) => l === 'remote client: an ext-request outside its reach refused').length, 9, lines.join('\n'))
    assert.equal(lines.some((l) => l.includes(MARKER) || /create|mute|poll-close|tree\.publish|device\.revoke/.test(l)), false, 'the log names no extension, request nor argument')
  })

  test('RR4 B-1: a second hello never relabels the portal; it is refused and logged, and the reach still holds', async () => {
    const from = logs.length
    calls.length = 0
    for (const client of ['app', 'cli', 'remote'] as const)
      await assert.rejects(remote.request({ t: 'hello', v: 3, client } as never), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request', client)
    await assert.rejects(remote.request({ t: 'ext-request', ext: 'channels', name: 'create', args: { name: MARKER } }), denied, 'still remote after the hellos')
    await assert.rejects(remote.request({ t: 'shutdown' } as never), denied, 'a never type is still refused')
    assert.deepEqual(calls, [], 'no handler ran')
    await remote.request({ t: 'ext-request', ext: 'regency', name: 'tree.read' })
    assert.deepEqual(calls, [{ ext: 'regency', name: 'tree.read', client: 'remote' }], 'the connection is still the portal')
    assert.equal(logs.slice(from).filter((l) => l === 'client refused: a second hello (remote)').length, 3, logs.slice(from).join('\n'))
    const app = await DaemonClient.open(pipe, 'app', { home })
    await assert.rejects(app.request({ t: 'hello', v: 3, client: 'remote' } as never), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request', 'nor does an app relabel')
    app.close()
  })

  test('every pair of the reach passes and reaches its handler as remote', async () => {
    calls.length = 0
    for (const p of REMOTE_EXT_PAIRS) assert.deepEqual((await remote.request({ t: 'ext-request', ext: p.ext, name: p.name, args: {} })).result, { ext: p.ext, name: p.name })
    assert.deepEqual(calls, REMOTE_EXT_PAIRS.map((p) => ({ ext: p.ext, name: p.name, client: 'remote' })))
  })

  test("every type PIPE_REACH marks `never` is refused to the remote client, a keystroke dropped; the pipe stays up", async () => {
    const from = logs.length
    const requests = NEVER.filter((t) => !KEYSTROKES.includes(t))
    assert.ok(requests.includes('shutdown') && requests.includes('verb') && requests.includes('create'))
    for (const t of requests)
      await assert.rejects(remote.request({ t, slotId: MARKER, name: MARKER } as never), denied, t)
    remote.input(MARKER, MARKER)
    remote.typed(MARKER, MARKER)
    await assert.rejects(remote.request({ t: `x-${MARKER}` } as never), denied, 'a type the pipe does not know')
    await until(() => logs.slice(from).includes('remote client: a message of unknown type refused') || undefined, 5_000, 'the refusal of the unknown type')
    const lines = logs.slice(from)
    for (const t of NEVER) assert.ok(lines.includes(`remote client: ${t} refused`), `${t} logged`)
    assert.equal(lines.some((l) => l.includes(MARKER)), false, 'the log carries no content of the message')
    assert.ok(Array.isArray((await remote.request({ t: 'list' })).slots), 'tetherd is up and the connection answers')
  })

  test('cli and app keep the whole pipe: the writes reach their handlers and a `never` type answers', async () => {
    for (const kind of ['cli', 'app'] as const) {
      const c = await DaemonClient.open(pipe, kind, { home })
      calls.length = 0
      await c.request({ t: 'ext-request', ext: 'channels', name: 'say', args: { text: 'x' } })
      await c.request({ t: 'ext-request', ext: 'regency', name: 'tree.publish' })
      assert.deepEqual(calls.map((x) => [x.name, x.client]), [['say', kind], ['tree.publish', kind]])
      assert.ok((await c.request({ t: 'perf' })).perf, `${kind}: perf`)
      assert.ok(Array.isArray((await c.request({ t: 'verb-list' })).verbs), `${kind}: verb-list`)
      await assert.rejects(c.request({ t: 'ext-request', ext: MARKER, name: MARKER }), (e: unknown) => e instanceof DaemonError && e.code === 'unknown-request', `${kind}: an unknown pair is unknown, not denied`)
      c.close()
    }
  })

  test("parity: the portal's own sender, through a real remote connection, is never refused by tetherd", async () => {
    const request: ExtRequestFn = async (b) => await remote.request(b)
    const reads = pipeReads(request)
    calls.length = 0
    for (const op of Object.keys(EXT_READS) as ExtReadOp[]) assert.deepEqual(await reads.read(op, {}), { ext: EXT_READS[op].ext, name: EXT_READS[op].name }, op)
    assert.deepEqual(calls.map((c) => c.client), Object.keys(EXT_READS).map(() => 'remote'))
    // The same for the portal's write path: every pair of EXT_WRITES reaches its handler as remote.
    const writes = pipeWrites(request)
    calls.length = 0
    for (const op of Object.keys(EXT_WRITES) as ExtWriteOp[]) assert.deepEqual(await writes.write(op, {}).answer, { ext: EXT_WRITES[op].ext, name: EXT_WRITES[op].name }, op)
    assert.deepEqual(calls.map((c) => [c.name, c.client]), Object.values(EXT_WRITES).map((p) => [p.name, 'remote']))
    // And the reach tetherd enforces is exactly what the portal's tables list: the reads, then the writes.
    assert.deepEqual(REMOTE_EXT_PAIRS, [...Object.values(EXT_READS), ...Object.values(EXT_WRITES)])
  })

  test('RR5 5.2 parity: every act the portal builds passes the reach; a target that does not exist is unknown, never denied', async () => {
    const acts = pipeActs(async (m) => await remote.request(m as never) as Record<string, unknown>)
    const bodies: Record<ManageOp, Record<string, unknown>> = {
      'agents.stop': { slotId: MARKER }, 'agents.start': { slotId: MARKER, choice: 'resume' }, 'agents.restart': { slotId: MARKER },
      'agents.rename': { slotId: MARKER, name: 'novo' }, 'agents.forget': { slotId: MARKER },
      'ronda.get': { slotId: MARKER }, 'ronda.set': { slotId: MARKER, interval: '10m', nudge: 'oi', criterion: '' }, 'ronda.off': { slotId: MARKER },
      'procs.list': {}, 'procs.info': { name: 'nada' }, 'procs.start': { name: 'nada' }, 'procs.stop': { name: 'nada', reason: 'r' },
      'procs.stop-force': { name: 'nada', reason: 'r' }, 'procs.restart': { name: 'nada' }, 'procs.restart-force': { name: 'nada', reason: 'r' },
      'procs.use': { name: 'nada', duration: '5m', purpose: 'p' }, 'procs.release': { name: 'nada' }, 'procs.forget': { name: 'nada' },
      'procs.forget-force': { name: 'nada', reason: 'r' },
    }
    const from = logs.length
    for (const [op, body] of Object.entries(bodies) as [ManageOp, Record<string, unknown>][]) {
      const a = manageArgs(op, body)
      assert.ok(typeof a !== 'string', op)
      const run = opByName(op)!.mutates ? acts.act(a.msg).answer : acts.read(a.msg)
      try {
        const reply = await run
        assert.ok(op === 'procs.list' || op === 'procs.release', `${op}: ${JSON.stringify(reply)}`)
      } catch (e) {
        assert.ok(e instanceof ActError && e.why === 'refused' && e.code !== 'door-denied' && e.code !== 'outside-reach', `${op}: ${String(e)}`)
        assert.ok(['unknown-slot', 'unknown-proc', 'proc-host'].includes(e.code!), `${op}: ${e.code}`)
      }
    }
    assert.equal(logs.slice(from).some((l) => l.startsWith('remote client:')), false, logs.slice(from).join('\n'))
  })

  test('RR5 5.2: an act with a field outside its rule is refused by tetherd itself (never by, a recipe, a wait, another why)', async () => {
    const from = logs.length
    for (const m of [
      { t: 'stop', slotId: MARKER, why: 'hibernate' }, { t: 'proc-stop', name: 'nada', by: { slotId: MARKER } }, { t: 'proc-forget', name: 'nada', waitMs: 10 },
      { t: 'proc-start', name: 'nada', recipe: { command: MARKER, args: [], cwd: '.' } }, { t: 'proc-start', name: 'nada', force: true },
      { t: 'ronda-off', slotId: MARKER, force: false }, { t: 'proc-use', name: 'nada', purpose: 'p', by: { as: MARKER } },
    ]) await assert.rejects(remote.request(m as never), denied, JSON.stringify(m))
    const lines = logs.slice(from)
    assert.equal(lines.filter((l) => /^remote client: a [\w-]+ outside its reach refused$/.test(l)).length, 7, lines.join('\n'))
    assert.equal(lines.some((l) => l.includes(MARKER)), false, 'the log names the type alone')
  })
})
