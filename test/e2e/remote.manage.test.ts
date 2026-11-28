// RR5 step 5.2, end to end: the person manages from afar, direct on tetherd (no screen, no bridge of the app). A tetherd
// of the bench in this process (home under TETHER_BENCH_DIR or the system temp, never the person's), its process host in
// this process too (tether-procd's ProcHost on a pipe of the bench), the real portal, the REAL relay (remote/relay/, its own
// process), a test device in this process holding a presence credential of a software authenticator, and a fake `claude`
// agent (test/fixtures/channels/agent-live.cjs, no LLM) in a pane. Played in order: pair and register; stop a slot and
// start it again, and a stop resent with the same actId stops nothing more; switch its ronda on and off; stop a process an
// agent declared it uses: the board "in use" (who, until when, what for), then the force with a reason as a second act;
// restart resent with the same actId after reconnecting restarts once; forget without a proof refused, with one done; every
// act in the audit with the device, the op and the target, never the text nor the env; a device without `manage:procs`
// refused before anything is done.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { hostStore } from '../../src/procd/run-store.ts'
import { decodeOuter, OP_CODES, RES_STATUS, toHex, WS_SUBPROTOCOL, type Bytes } from '../../src/remote/index.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { act, actId, ORIGIN, present, registerAndUnlock, type SoftAuthenticator } from '../unit/remoted.authenticator.ts'
import { benchHome, TestDevice, type DeviceSession, type FakeRelay } from '../unit/remoted.helpers.ts'

const root = resolve(import.meta.dirname, '..', '..')
const OP = OP_CODES
const MARKER = `canary${randomBytes(10).toString('hex')}`
const PROC = 'bench-web'

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>, extName = 'remote'): Promise<Record<string, any>> =>
  (await c.request({ t: 'ext-request', ext: extName, name, ...(args ? { args } : {}) })).result as Record<string, any>

// ---- the device's leg: Node's WebSocket to the real relay (as in remote.talk) --------------------------------------

class WsLeg {
  readonly inbox: ReturnType<typeof decodeOuter>[] = []
  closed = false
  route: number | undefined
  readonly #ws: WebSocket
  readonly #pending: Bytes[] = []
  #waiters: (() => void)[] = []

  constructor(url: string) {
    this.#ws = new WebSocket(url, WS_SUBPROTOCOL)
    this.#ws.binaryType = 'arraybuffer'
    this.#ws.onopen = () => { for (const b of this.#pending.splice(0)) this.#ws.send(b) }
    this.#ws.onmessage = (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer)) return
      this.inbox.push(decodeOuter('device', 'relay', new Uint8Array(e.data)))
      this.#wake()
    }
    this.#ws.onclose = () => { this.closed = true; this.#wake() }
    this.#ws.onerror = () => { this.closed = true; this.#wake() }
  }

  #wake(): void { for (const w of this.#waiters.splice(0)) w() }

  async next(ms = 5_000): Promise<ReturnType<typeof decodeOuter>> {
    const end = Date.now() + ms
    while (this.inbox.length === 0) {
      if (this.closed) throw new Error('device leg closed')
      if (Date.now() > end) throw new Error('device leg: nothing arrived')
      await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 50) })
    }
    return this.inbox.shift()!
  }

  send(bytes: Bytes): void {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(bytes)
    else if (this.#ws.readyState === WebSocket.CONNECTING) this.#pending.push(bytes)
  }

  close(): void { if (!this.closed) { this.closed = true; this.#ws.close() } }
}

function spawnNode(args: string[], event: string, lines: string[]): Promise<{ proc: ChildProcess; line: Record<string, unknown> }> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let pending = ''
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`${args[0]}: no ${event} in 15 s`)) } }, 15_000)
    proc.stdout!.on('data', (c: Buffer) => {
      pending += c.toString('utf8')
      let i
      while ((i = pending.indexOf('\n')) >= 0) {
        const l = pending.slice(0, i)
        pending = pending.slice(i + 1)
        lines.push(l)
        try {
          const j = JSON.parse(l) as Record<string, unknown>
          if (!done && j.event === event) { done = true; clearTimeout(timer); resolveP({ proc, line: j }) }
        } catch { /* not JSON */ }
      }
    })
    proc.stderr!.on('data', (c: Buffer) => lines.push(`[stderr] ${c.toString('utf8')}`))
    proc.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`${args[0]} exited ${code}: ${lines.join('\n')}`)) } })
  })
}

/** Our own bench process and its tree, by PID only. */
function killTree(p: ChildProcess | undefined): void {
  if (!p?.pid || p.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill('SIGKILL')
}

async function eventually<T>(f: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, 'localhost', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

const AGENT = resolve(import.meta.dirname, '../fixtures/channels/agent-live.cjs')
const OFF = ['web-bridge', 'browser', 'skills', 'for-agents', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex']

describe('remote manage end to end (RR5.2): slots, ronda and processes from afar, direct on tetherd', () => {
  const home = benchHome('tether-remote-manage-')
  const pipe = uniquePipe(home)
  const hostPipe = uniquePipe(home)
  const procHome = join(home, 'procd')
  const shim = join(home, 'shim')
  const logs: string[] = []
  const relayLines: string[] = []
  const replies: unknown[] = []
  let daemon: Daemon | undefined
  let extHost: DaemonExtensionHost | undefined
  let procHost: ProcHost | undefined
  let app: DaemonClient
  let cli: DaemonClient
  let relay: ChildProcess | undefined
  let device: TestDevice
  let auth: SoftAuthenticator
  let s: DeviceSession
  let aud = ''
  let slotId = ''

  function benchEnv(): void {
    for (const k of Object.keys(process.env)) if (/^(TETHER_|CLAUDE)/i.test(k) || k === 'NODE_TEST_CONTEXT') delete process.env[k]
    Object.assign(process.env, { TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: join(home, 'notices.txt'), TETHER_TEST_REMOTE_TICK_MS: '200' })
    mkdirSync(shim, { recursive: true })
    if (process.platform === 'win32') writeFileSync(join(shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    process.env[pathKey] = `${shim}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}`
  }

  async function up(): Promise<void> {
    const door = new DoorHost({ log: (m) => logs.push(m) })
    extHost = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, disabled: OFF })
    extHost.activate()
    daemon = await startDaemon({
      home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m), panelHost: false, minAgentAgeMs: 1_000,
      transformPlan: extHost.transformPlan, onSlot: extHost.emitSlot, connectProcHost: () => HostClient.open(hostPipe, 5_000, { home: procHome }),
    })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
    assert.deepEqual(await ext(app, 'remote.on', { relayUrl: `ws://${aud}/v1/house`, webUrl: `${ORIGIN}/` }), { on: true })
    for (let i = 0; i < 100; i++) { if ((await ext(cli, 'remote.status')).link === 'up') break; await new Promise((res) => setTimeout(res, 200)) }
    assert.equal((await ext(cli, 'remote.status')).link, 'up', `the house at the relay:\n${relayLines.join('\n')}\n${logs.slice(-40).join('\n')}`)
  }

  async function down(): Promise<void> {
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    try {
      const slots = (await cli.request({ t: 'list' })).slots ?? []
      await Promise.all(slots.filter((x) => x.pid).map((x) => cli.request({ t: 'stop', slotId: x.slotId }).catch(() => undefined)))
      for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 250)))
        if (((await cli.request({ t: 'list' }).catch(() => ({ slots: [] }))).slots ?? []).every((x) => !x.pid)) break
    } catch { /* tetherd gone */ }
    app?.close()
    cli?.close()
    extHost?.dispose()
    await daemon?.close()
    extHost = undefined
    daemon = undefined
  }

  async function session(): Promise<DeviceSession> {
    const c = await device.connect()
    assert.ok(!('failed' in c), `session: ${JSON.stringify(c)}`)
    assert.equal((await present(c, auth)).status, RES_STATUS.ok, 'unlocked by the presence credential')
    return c
  }

  const call = async (op: number, body: Record<string, unknown>, id: Bytes = actId(), on: DeviceSession = s) => {
    const r = await on.request(op, body, { actId: id })
    replies.push(r)
    return r
  }
  const ok = async (op: number, body: Record<string, unknown>, id?: Bytes): Promise<Record<string, any>> => {
    const r = await call(op, body, id)
    assert.equal(r.status, RES_STATUS.ok, `op 0x${op.toString(16)}: ${JSON.stringify(r.body)}`)
    return r.body
  }
  const slotNow = async () => ((await cli.request({ t: 'list' })).slots ?? []).find((x) => x.slotId === slotId)
  const procNow = async () => (await cli.request({ t: 'proc-info', name: PROC })) as unknown as { proc: { status: string; run?: number; uses?: unknown[] }; events: { kind: string; reason?: string }[] }
  const audits = (): { act: string; device?: string; target?: string; result: string }[] => {
    const f = join(home, 'remote', 'audit.jsonl')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }

  before(async () => {
    const port = await freePort()
    aud = `localhost:${port}`
    const r = await spawnNode(['remote/relay/src/main.ts', 'serve', '--port', String(port), '--aud', aud], 'relay.listening', relayLines)
    relay = r.proc
    benchEnv()
    // The host keeps a home of its own: what it writes there is never taken for tetherd's (the portal finds tetherd by home).
    mkdirSync(procHome, { recursive: true })
    procHost = new ProcHost({ home: procHome, pipe: hostPipe, store: hostStore })
    await procHost.listen()
    await up()
    const work = join(home, 'conferente')
    mkdirSync(work, { recursive: true })
    const created = await cli.request({ t: 'create', kind: 'claude', cwd: work, name: 'conferente', start: true }) as { slot?: { slotId: string } }
    slotId = created.slot!.slotId
    await eventually(async () => (await slotNow())?.status === 'running' && existsSync(join(home, 'bench', `${slotId}.ready`)), 60_000, `the agent running\n${logs.slice(-30).join('\n')}`)
    // A process of the bench with a secret in its env, which an agent declares it uses.
    const recipe = { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home, env: { BENCH_SECRET: MARKER } }
    assert.equal((await cli.request({ t: 'proc-start', name: PROC, recipe })).proc!.status, 'running')
    const relayLike = { device: () => new WsLeg(`ws://${aud}/v1/device`), aud } as unknown as FakeRelay
    device = await TestDevice.make(relayLike)
  })

  after(async () => {
    s?.leg.close()
    try { await cli.request({ t: 'proc-stop', name: PROC, force: 'fim da bancada' }) } catch { /* gone */ }
    try { await cli.request({ t: 'proc-stop', name: 'bench-new', force: 'fim da bancada' }) } catch { /* gone */ }
    await down()
    await procHost?.close()
    killTree(relay)
    await removeHome(home)
  })

  test('pairing through the real relay, the credential registered, then a normal session unlocked', async () => {
    const begun = await ext(app, 'pair.begin')
    const { sas, done } = await device.pair(String(begun.code), { name: 'Telefone que gere' })
    const digits = await sas
    for (let i = 0; i < 100 && (await ext(app, 'pair.state', { pairId: begun.pairId })).state !== 'waiting-sas'; i++) await new Promise((res) => setTimeout(res, 100))
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits })
    const first = await done
    assert.ok(!('failed' in first), `pairing: ${JSON.stringify(first)}`)
    for (let i = 0; i < 100 && (await ext(app, 'pair.state', { pairId: begun.pairId })).state !== 'done'; i++) await new Promise((res) => setTimeout(res, 100))
    auth = await registerAndUnlock(first, device.kD.pub)
    first.leg.close()
    s = await session()
  })

  test('a slot stops from afar and starts again; a stop resent with the same actId does nothing more', async () => {
    const id = actId()
    const stopped = await ok(OP['agents.stop'], { slotId }, id)
    assert.deepEqual([stopped.slot.slotId, stopped.slot.status, stopped.slot.want], [slotId, 'exited', 'ended'])
    assert.equal((await slotNow())?.pid, undefined, 'no process at tetherd')
    assert.deepEqual(await ok(OP['agents.stop'], { slotId }, id), stopped, 'the same answer')
    assert.deepEqual((await call(OP['agents.stop'], { slotId: 'nao_existe' })).status, RES_STATUS.notFound, 'an id that names nothing')
    const started = await ok(OP['agents.start'], { slotId, choice: 'new' })
    assert.equal(started.slot.slotId, slotId)
    await eventually(async () => (await slotNow())?.status === 'running', 60_000, 'running again')
  })

  test('its ronda switches on with an interval, a nudge and a criterion, and off', async () => {
    const on = await ok(OP['ronda.set'], { slotId, interval: '10m', nudge: 'olhe o build', criterion: 'até o build passar' })
    assert.deepEqual([on.ronda.intervalMs, on.ronda.nudge, on.ronda.criterion, on.outcome], [600_000, 'olhe o build', 'até o build passar', 'created'])
    assert.equal((await cli.request({ t: 'ronda-get', slotId })).ronda?.intervalMs, 600_000)
    assert.equal((await ok(OP['ronda.get'], { slotId })).ronda.intervalMs, 600_000)
    assert.deepEqual(await ok(OP['ronda.off'], { slotId }), { ronda: null, outcome: 'off' })
    assert.equal((await cli.request({ t: 'ronda-get', slotId })).ronda, null)
  })

  test('a process in use by an agent: the board (who, until when, what for), then "anyway" with a reason as a second act', async () => {
    // Declared now, by the agent's panel running again (a panel that stopped ends its uses).
    await cli.request({ t: 'proc-use', name: PROC, duration: '30m', purpose: 'rodando os testes', by: { slotId } })
    const listed = await ok(OP['procs.list'], {})
    const mine = listed.procs.find((p: { name: string }) => p.name === PROC)
    assert.deepEqual(mine.envNames, ['BENCH_SECRET'])
    const refused = await call(OP['procs.stop'], { name: PROC })
    assert.equal(refused.status, RES_STATUS.failed)
    assert.equal(refused.body.error, 'proc-in-use')
    const uses = refused.body.uses as { by: { kind: string; name?: string }; until: string; purpose: string }[]
    assert.deepEqual(uses.map((u) => [u.by.kind, u.by.name, u.purpose]), [['agent', 'conferente', 'rodando os testes']])
    assert.ok(Date.parse(uses[0]!.until) > Date.now())
    assert.equal((await procNow()).proc.status, 'running', 'nothing was done')
    const forced = await ok(OP['procs.stop-force'], { name: PROC, reason: 'preciso da porta' })
    assert.notEqual(forced.proc.status, 'running')
    const info = await procNow()
    assert.ok(info.events.some((e) => e.kind === 'forced' && e.reason === 'preciso da porta'), JSON.stringify(info.events.map((e) => e.kind)))
  })

  test('start the stored recipe; a restart resent with the same actId after reconnecting restarts once', async () => {
    assert.equal((await ok(OP['procs.start'], { name: PROC })).proc.status, 'running')
    const run0 = (await procNow()).proc.run!
    const id = actId()
    const first = await ok(OP['procs.restart-force'], { name: PROC, reason: 'versão nova' }, id)
    s.leg.close()
    await eventually(async () => (await ext(cli, 'remote.status')).sessions === 0, 10_000, 'the old session gone')
    s = await session()
    assert.deepEqual(await ok(OP['procs.restart-force'], { name: PROC, reason: 'versão nova' }, id), first)
    assert.equal((await procNow()).proc.run, run0 + 1, 'one restart')
  })

  test('forgetting needs a proof of the act: without it refused, with it done', async () => {
    await cli.request({ t: 'proc-release', name: PROC, by: { slotId } })
    await ok(OP['procs.stop'], { name: PROC })
    assert.equal((await call(OP['procs.forget'], { name: PROC })).status, RES_STATUS.presenceRequired)
    assert.equal((await procNow()).proc.status !== undefined, true, 'still there')
    const done = await act(s, auth, OP['procs.forget'], { name: PROC })
    replies.push(done)
    assert.deepEqual(done, { status: RES_STATUS.ok, body: {} })
    assert.equal(((await cli.request({ t: 'proc-list' })).procs ?? []).some((p) => p.name === PROC), false)
  })

  // ---- RR5 (fio-spec 18): a channel managed from afar, "+ Novo" and "Novo processo" ----------------------------------

  let room = ''
  const history = async (): Promise<{ kind: string; body: string; afar?: true; event?: { type: string } }[]> =>
    (await ext(app, 'history', { channel: room }, 'channels')).lines

  test('a fresh minute of gestures: the device has 30 a minute (limits.ts), and the acts above spent them', async () => {
    await new Promise((r) => setTimeout(r, 61_000))
  })

  test('a channel from afar: created, the agent called, muted, a poll closed; each system line says "(de longe)"', async () => {
    const made = await ok(OP['channels.create'], { name: '#Longe' })
    assert.equal(made.name, 'longe')
    room = made.channel
    assert.deepEqual(await ok(OP['channels.join'], { channel: room, agent: slotId }), { already: false })
    assert.deepEqual(await ok(OP['channels.mute'], { channel: room, agent: slotId }), { already: false })
    assert.deepEqual(await ok(OP['channels.unmute'], { channel: room, agent: slotId }), { already: false })
    const poll = await ok(OP['channels.poll'], { channel: room, question: 'Seguimos?', to: [slotId] })
    const closed = await ok(OP['channels.poll-close'], { channel: room, poll: poll.seq })
    assert.equal(closed.state.seq, poll.seq)
    assert.equal(closed.state.result.by, 'author')
    const notices = (await history()).filter((l) => l.kind === 'notice')
    assert.deepEqual(notices.map((l) => [l.event?.type, l.afar, l.body.includes('(de longe)')]), [
      ['create', true, true], ['join', true, true], ['mute', true, true], ['unmute', true, true],
    ], JSON.stringify(notices))
    assert.equal((await call(OP['channels.join'], { channel: room, agent: 'nao_existe' })).status, RES_STATUS.notFound, 'an agent that names nothing')
  })

  test('closing a channel needs a proof of the act: without it refused, with it done', async () => {
    assert.equal((await call(OP['channels.close'], { channel: room })).status, RES_STATUS.presenceRequired)
    assert.equal(((await ext(app, 'list', {}, 'channels')).channels as { id: string }[]).some((c) => c.id === room), true, 'still open')
    const done = await act(s, auth, OP['channels.close'], { channel: room })
    replies.push(done)
    assert.deepEqual(done, { status: RES_STATUS.ok, body: {} })
    assert.equal(((await ext(app, 'list', {}, 'channels')).channels as { id: string }[]).some((c) => c.id === room), false, 'closed')
    const last = (await history()).at(-1)!
    assert.deepEqual([last.event?.type, last.afar], ['close', true])
  })

  let folder = ''
  test('"+ Novo": the choices without a path; a terminal born in a desk, in a folder the tether knows, by its id', async () => {
    await app.request({ t: 'desk-map', map: { desks: [{ id: 'desk-1', name: 'Obra', kind: 'queue', panes: [] }], drawer: [] } } as never)
    const o = await ok(OP['create.options'], {})
    assert.ok(o.engines.includes('claude') && o.engines.includes('shell'), JSON.stringify(o.engines))
    assert.deepEqual(o.desks, [{ deskId: 'desk-1', name: 'Obra' }])
    const f = (o.folders as { id: string; label: string; kind: string }[]).find((x) => x.label === 'conferente')
    assert.ok(f, JSON.stringify(o.folders))
    folder = f.id
    assert.equal(JSON.stringify(o).includes(home), false, 'no path reaches the device')
    assert.equal(JSON.stringify(o).toLowerCase().includes('c:\\'), false)
    const before = ((await cli.request({ t: 'list' })).slots ?? []).length
    const made = await ok(OP['create.terminal'], { deskId: 'desk-1', folder, name: 'de longe' })
    const born = ((await cli.request({ t: 'list' })).slots ?? []).find((x) => x.slotId === made.slotId)
    assert.ok(born, 'the slot exists at tetherd')
    assert.deepEqual([born.kind, born.name, ((await cli.request({ t: 'list' })).slots ?? []).length], ['shell', 'de longe', before + 1])
    assert.equal((await call(OP['create.terminal'], { deskId: 'desk-1', folder: '0123456789abcdef' })).status, RES_STATUS.notFound, 'a folder outside the list')
    assert.equal((await call(OP['create.terminal'], { deskId: 'desk-9', folder })).status, RES_STATUS.notFound, 'a desk that is not there')
    assert.equal((await call(OP['create.note'], { deskId: 'desk-1', folder })).status, RES_STATUS.noApp, 'a note only the app makes: no app on the bench')
    await cli.request({ t: 'stop', slotId: made.slotId }).catch(() => undefined)
  })

  const NEW = 'bench-new'
  const NEW_MARKER = `canary${randomBytes(10).toString('hex')}`
  test('"Novo processo": with a common variable it runs, and its value is in no frame, log or audit line', async () => {
    const body = { name: NEW, command: 'node -e "setInterval(() => {}, 1000)"', folder, description: 'de longe', env: [{ name: 'BENCH_MODE', value: NEW_MARKER }] }
    assert.equal((await call(OP['procs.new'], body)).status, RES_STATUS.presenceRequired, 'a command on the machine needs a proof')
    const r = await act(s, auth, OP['procs.new'], body)
    replies.push(r)
    assert.equal(r.status, RES_STATUS.ok, JSON.stringify(r.body))
    assert.deepEqual((r.body.proc as { envNames: string[] }).envNames, ['BENCH_MODE'])
    await eventually(async () => (await cli.request({ t: 'proc-info', name: NEW })).proc?.status === 'running', 20_000, 'the new process running')
    const again = await act(s, auth, OP['procs.new'], { ...body, env: [] })
    assert.deepEqual(again.body, { error: 'proc-exists' }, 'from afar a recipe never replaces another')
  })

  test('a variable that looks like a secret is refused by its name, with no "anyway"; nothing starts', async () => {
    const r = await act(s, auth, OP['procs.new'], { name: 'bench-secret', command: 'node -e "1"', folder, env: [{ name: 'API_TOKEN', value: NEW_MARKER }] })
    replies.push(r)
    assert.deepEqual(r, { status: RES_STATUS.failed, body: { error: 'secret-env', names: ['API_TOKEN'] } })
    assert.equal(((await cli.request({ t: 'proc-list' })).procs ?? []).some((p) => p.name === 'bench-secret'), false)
  })

  test('THE CANARY of the new recipe: no reply, no audit line, no log of tetherd and no file of the portal carries the value', () => {
    assert.equal(JSON.stringify(replies).includes(NEW_MARKER), false, 'frames')
    assert.equal(JSON.stringify(audits()).includes(NEW_MARKER), false, 'audit')
    assert.equal(logs.some((l) => l.includes(NEW_MARKER)), false, 'tetherd log')
    const dir = join(home, 'remote')
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isFile()) assert.equal(readFileSync(p, 'latin1').includes(NEW_MARKER), false, `remote/${f}`)
    }
    const lines = audits()
    assert.ok(lines.some((l) => l.act === 'procs.new' && l.result === 'ok' && l.target === NEW))
    assert.ok(lines.some((l) => l.act === 'procs.new' && l.result === 'refused:secret-env'))
    assert.ok(lines.some((l) => l.act === 'channels.close' && l.result === 'ok' && l.target === room))
    assert.ok(lines.some((l) => l.act === 'create.terminal' && l.result === 'ok' && l.target === 'desk-1'))
  })

  test('the audit says device, op, target and result of every act; no reply and no line carries the env or the text', () => {
    const lines = audits()
    const dev = toHex(device.result!.deviceId)
    const of = (a: string) => lines.filter((l) => l.act === a)
    assert.ok(of('agents.stop').some((l) => l.result === 'ok' && l.target === slotId && l.device === dev))
    assert.ok(of('agents.stop').some((l) => l.result === 'replay'))
    assert.ok(of('ronda.set').some((l) => l.result === 'ok' && l.target === slotId))
    assert.ok(of('procs.stop').some((l) => l.result === 'refused:proc-in-use' && l.target === PROC))
    assert.ok(of('procs.stop-force').some((l) => l.result === 'ok' && l.target === PROC))
    assert.ok(of('procs.forget').some((l) => l.result === 'ok' && l.target === PROC))
    const text = JSON.stringify(lines)
    for (const t of [MARKER, 'preciso da porta', 'olhe o build', 'rodando os testes']) assert.equal(text.includes(t), false, t)
    assert.equal(JSON.stringify(replies).includes(MARKER), false, 'the env value never reached the device')
  })

  test('a device without manage:procs is refused before anything is done', async () => {
    s.leg.close()
    await down()
    const file = join(home, 'remote', 'devices.json')
    const reg = JSON.parse(readFileSync(file, 'utf8')) as { devices: { deviceId: string; scopes: string[] }[] }
    const mine = reg.devices.find((d) => d.deviceId === toHex(device.result!.deviceId))!
    mine.scopes = mine.scopes.filter((x) => x !== 'manage:procs')
    writeFileSync(file, JSON.stringify(reg, null, 2) + '\n')
    await up()
    s = await session()
    const recipe = { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home }
    await cli.request({ t: 'proc-start', name: PROC, recipe })
    assert.equal((await call(OP['procs.list'], {})).status, RES_STATUS.noScope)
    assert.equal((await call(OP['procs.stop'], { name: PROC })).status, RES_STATUS.noScope)
    assert.equal((await procNow()).proc.status, 'running', 'nothing was done')
  })
})
