// RR4 step 4.2a, end to end: the person talks from afar (channels.say, react, vote, poll, seen) through the whole path, no
// screen. A tetherd of the bench in this process (home under TETHER_BENCH_DIR or the system temp, never the person's; the
// daemon's extensions as tetherd's own main loads them, the noisy ones off, panes inside this process) and the real
// portal; the REAL relay (remote/relay/, its own process); a test device in this process (DevicePairing / DeviceHandshake
// over Node's WebSocket) holding a presence credential of a software authenticator (the remote's webUrl is its relying
// party); and a fake `claude` agent (test/fixtures/channels/agent-live.cjs, no LLM) running in a pane, whose MCP stream
// records every channel notification it gets, as the channels' E2E observe a delivery. Played in order: pair and register;
// the device speaks and the agent hears the person (role `moderator`); it reacts; it votes on a poll the agent opened; it
// opens a poll and the agent is asked; it marks seen and the marks change; the thin notice reaches it after each write; a
// resend with the same actId after reconnecting does not speak twice; a locked session is refused; and a device without the
// `channels` scope (the registry edited, the bench restarted) is refused before anything is written.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { decodeOuter, OP_CODES, RES_STATUS, toHex, WS_SUBPROTOCOL, type Bytes } from '../../src/remote/index.ts'
import { EVT } from '../../src/remote/scopes.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { actId, ORIGIN, present, registerAndUnlock, type SoftAuthenticator } from '../unit/remoted.authenticator.ts'
import { benchHome, TestDevice, until, type DeviceSession, type FakeRelay } from '../unit/remoted.helpers.ts'

const root = resolve(import.meta.dirname, '..', '..')
const OP = {
  say: OP_CODES['channels.say'], react: OP_CODES['channels.react'], vote: OP_CODES['channels.vote'], poll: OP_CODES['channels.poll'],
  seen: OP_CODES['channels.seen'], marks: OP_CODES['channels.marks'], page: OP_CODES['channels.page'], lock: OP_CODES['session.lock'],
  file: OP_CODES['channels.file'], upload: OP_CODES['channels.upload'],
}

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>, extName = 'remote'): Promise<Record<string, any>> =>
  (await c.request({ t: 'ext-request', ext: extName, name, ...(args ? { args } : {}) })).result as Record<string, any>

// ---- the device's leg: Node's WebSocket to the real relay, in the shape TestDevice drives (as in remote.read) ---------

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

// ---- child processes of the bench ---------------------------------------------------------------------------------

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

/** `until` for a check that must ask (await) each time. */
async function eventually<T>(f: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** A port free on localhost now (the relay's --aud names it before the relay listens). */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, 'localhost', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

// ---- the test ---------------------------------------------------------------------------------------------------

/** The fake agent (no LLM): found as `claude` on the PATH of the bench, through a shim. */
const AGENT = resolve(import.meta.dirname, '../fixtures/channels/agent-live.cjs')
/** The daemon's extensions that only add noise here (as the channels' E2E turn them off). */
const OFF = ['web-bridge', 'browser', 'skills', 'for-agents', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex']

describe('remote talk end to end (RR4.2a): the person speaks, reacts, votes, opens a poll and marks seen from afar', () => {
  const home = benchHome('tether-remote-talk-')
  const pipe = uniquePipe(home)
  const shim = join(home, 'shim')
  const logs: string[] = []
  const relayLines: string[] = []
  let daemon: Daemon | undefined
  let extHost: DaemonExtensionHost | undefined
  let app: DaemonClient
  let cli: DaemonClient
  let relay: ChildProcess | undefined
  let device: TestDevice
  let auth: SoftAuthenticator
  let s: DeviceSession
  let aud = ''
  let channelId = ''
  let memberId = ''
  let said = 0

  /**
   * This process IS the bench's tetherd (its panes run here too): nothing of the person's tether may reach it or its panes,
   * so every TETHER_* and CLAUDE* of the shell that started the test goes, and the remote's bench switches come in (the
   * portal reads them because the home is not the person's). The shim puts the fake agent first on the PATH.
   */
  function benchEnv(): void {
    for (const k of Object.keys(process.env)) if (/^(TETHER_|CLAUDE)/i.test(k) || k === 'NODE_TEST_CONTEXT') delete process.env[k]
    Object.assign(process.env, {
      TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: join(home, 'notices.txt'), TETHER_TEST_REMOTE_TICK_MS: '200',
      TETHER_TEST_REMOTE_CHANNELS_GAP_MS: '200', TETHER_TEST_REMOTE_REGENCY_GAP_MS: '300',
    })
    mkdirSync(shim, { recursive: true })
    if (process.platform === 'win32') writeFileSync(join(shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    process.env[pathKey] = `${shim}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}`
  }

  /** The bench's tetherd as main.ts builds it (the noisy extensions off), the app's and the CLI's clients; the remote on. */
  async function up(): Promise<void> {
    const door = new DoorHost({ log: (m) => logs.push(m) })
    extHost = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, disabled: OFF })
    extHost.activate()
    daemon = await startDaemon({
      home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m), panelHost: false,
      transformPlan: extHost.transformPlan, onSlot: extHost.emitSlot,
    })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
    // webUrl: the origin of the PWA is the relying party of the software authenticator (remoted.authenticator.ts ORIGIN).
    assert.deepEqual(await ext(app, 'remote.on', { relayUrl: `ws://${aud}/v1/house`, webUrl: `${ORIGIN}/` }), { on: true })
    for (let i = 0; i < 100; i++) { if ((await ext(cli, 'remote.status')).link === 'up') break; await new Promise((res) => setTimeout(res, 200)) }
    assert.equal((await ext(cli, 'remote.status')).link, 'up', `the house at the relay:\n${relayLines.join('\n')}`)
  }

  async function down(): Promise<void> {
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    // The agent's pane stops with its process before tetherd goes (its pty lives in this process).
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

  /** A normal session of the device, unlocked by its credential. */
  async function session(): Promise<DeviceSession> {
    const c = await device.connect()
    assert.ok(!('failed' in c), `session: ${JSON.stringify(c)}`)
    assert.equal((await present(c, auth)).status, RES_STATUS.ok, 'unlocked by the presence credential')
    return c
  }

  const call = async (op: number, body: Record<string, unknown>, id: Bytes = actId(), on: DeviceSession = s) => on.request(op, body, { actId: id })
  const ok = async (op: number, body: Record<string, unknown>, id?: Bytes): Promise<Record<string, any>> => {
    const r = await call(op, body, id)
    assert.equal(r.status, RES_STATUS.ok, `op 0x${op.toString(16)}: ${JSON.stringify(r.body)}`)
    return r.body
  }
  /** The channel notifications the agent's MCP stream carried (agent-live.cjs records them; the content and its attributes). */
  const notes = (): { content: string; meta: Record<string, string> }[] => {
    const f = join(home, 'bench', `${memberId}.chan.jsonl`)
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method?: string; params?: { content: string; meta: Record<string, string> } })
      .filter((n) => n.method === 'notifications/claude/channel').map((n) => n.params!)
  }
  const history = async (): Promise<Record<string, any>> => ext(app, 'history', { channel: channelId }, 'channels')
  const agent = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const r = (await cli.request({ t: 'verb', ns: 'channels', name, slotId: memberId, args })) as unknown as { verb: { isError?: boolean; text: string; data: Record<string, any> } }
    assert.notEqual(r.verb.isError, true, `${name}: ${r.verb.text}`)
    return r.verb.data
  }
  /** The thin notice for the channel, after `from` events. */
  const notified = (from: number): Promise<unknown> =>
    until(() => s.events.slice(from).some((e) => e.evt === EVT.channelsChanged.code && ((e.body.channels as string[]).includes(channelId) || e.body.all === true)) || undefined, 10_000, 'channels.changed')

  before(async () => {
    const port = await freePort()
    aud = `localhost:${port}`
    // No --origins: the device here is no browser; the Origin check is the relay's own test.
    const r = await spawnNode(['remote/relay/src/main.ts', 'serve', '--port', String(port), '--aud', aud], 'relay.listening', relayLines)
    relay = r.proc
    benchEnv()
    await up()
    const made = await ext(app, 'create', { name: 'obra' }, 'channels')
    channelId = (made.channel as { id: string }).id
    const work = join(home, 'conferente')
    mkdirSync(work, { recursive: true })
    const created = await cli.request({ t: 'create', kind: 'claude', cwd: work, name: 'conferente', start: true }) as { slot?: { slotId: string } }
    memberId = created.slot!.slotId
    await eventually(async () => {
      const st = ((await cli.request({ t: 'list' })).slots ?? []).find((x) => x.slotId === memberId)
      return st?.status === 'running' && existsSync(join(home, 'bench', `${memberId}.ready`))
    }, 60_000, `the agent running with its stream\n${logs.slice(-30).join('\n')}`)
    await ext(app, 'join', { channel: channelId, agent: memberId }, 'channels')
    const relayLike = { device: () => new WsLeg(`ws://${aud}/v1/device`), aud } as unknown as FakeRelay
    device = await TestDevice.make(relayLike)
  })

  after(async () => {
    s?.leg.close()
    await down()
    killTree(relay)
    await removeHome(home)
  })

  test('pairing through the real relay, the credential registered in that session, then a normal session unlocked', async () => {
    const begun = await ext(app, 'pair.begin')
    const { sas, done } = await device.pair(String(begun.code), { name: 'Telefone que conversa' })
    const digits = await sas
    for (let i = 0; i < 100 && (await ext(app, 'pair.state', { pairId: begun.pairId })).state !== 'waiting-sas'; i++) await new Promise((res) => setTimeout(res, 100))
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits })
    const first = await done
    assert.ok(!('failed' in first), `pairing: ${JSON.stringify(first)}`)
    for (let i = 0; i < 100 && (await ext(app, 'pair.state', { pairId: begun.pairId })).state !== 'done'; i++) await new Promise((res) => setTimeout(res, 100))
    auth = await registerAndUnlock(first, device.kD.pub)
    first.leg.close()
    s = await session()
    // The reads subscribe the session to the channels' notices.
    assert.equal((await call(OP.marks, {})).status, RES_STATUS.ok)
  })

  test('the device speaks: one line from the person, and the agent of the channel gets it as the moderator', async () => {
    const from = s.events.length
    const body = await ok(OP.say, { channel: channelId, text: 'Bom dia, conferente.\nRevisa a ata?', to: ['conferente'] })
    assert.deepEqual(Object.keys(body), ['seq'])
    said = body.seq
    const line = (await history()).lines.find((l: { seq: number }) => l.seq === said)
    assert.deepEqual([line.kind, line.from.id, line.from.role, line.body, line.to], ['message', 'user', 'moderator', 'Bom dia, conferente.\nRevisa a ata?', ['conferente']])
    const heard = await until(() => notes().find((n) => n.content === 'Bom dia, conferente.\nRevisa a ata?'), 15_000, 'the agent hears the person')
    assert.deepEqual([heard.meta.role, heard.meta.from_id, heard.meta.room, heard.meta.to], ['moderator', 'user', 'obra', 'conferente'])
    await notified(from)
  })

  test('it reacts on that line, and repeating the reaction changes nothing', async () => {
    const from = s.events.length
    assert.deepEqual(await ok(OP.react, { channel: channelId, seq: said, reaction: 'agree' }), { changed: true, emoji: '👍', name: 'agree' })
    assert.deepEqual(await ok(OP.react, { channel: channelId, seq: said, reaction: 'agree' }), { changed: false, emoji: '👍', name: 'agree' })
    const sums = (await history()).reactions.find((r: { seq: number }) => r.seq === said)
    assert.deepEqual(sums.tallies.map((t: { emoji: string; by: { id: string }[] }) => [t.emoji, t.by.map((b) => b.id)]), [['👍', ['user']]])
    await notified(from)
  })

  test('it votes on a poll an agent opened for the person: the vote closes it and the card is the result', async () => {
    const opened = await agent('poll', { canal: channelId, question: 'Posso subir a ata?', to: ['usuário'] })
    const from = s.events.length
    const v = await ok(OP.vote, { channel: channelId, poll: opened.seq, vote: 1, reason: 'pode' })
    assert.deepEqual([v.changed, v.option, v.state.seq, v.state.result?.by], [true, 1, opened.seq, 'all-voted'])
    assert.deepEqual(v.state.result.tally[0].voters, [{ id: 'user', name: v.state.result.tally[0].voters[0].name, reason: 'pode' }])
    const again = await call(OP.vote, { channel: channelId, poll: opened.seq, vote: 2 })
    assert.deepEqual(again, { status: RES_STATUS.failed, body: { error: 'poll-closed' } }, 'a closed poll takes no vote')
    await notified(from)
  })

  test('it opens a poll: the card is open, and the agent is asked by the person', async () => {
    const from = s.events.length
    const p = await ok(OP.poll, { channel: channelId, question: 'Subimos hoje?', options: ['sim', 'amanhã'] })
    assert.equal(p.state.seq, p.seq)
    assert.deepEqual([p.state.open.question, p.state.open.options, p.state.open.author.id, p.state.open.to.map((t: { id: string }) => t.id)], ['Subimos hoje?', ['sim', 'amanhã'], 'user', [memberId]])
    assert.deepEqual(p.deaf, [], 'the agent hears now')
    const line = (await history()).lines.find((l: { seq: number }) => l.seq === p.seq)
    assert.deepEqual([line.kind, line.from.role], ['poll', 'moderator'])
    const asked = await until(() => notes().find((n) => n.content.includes('Subimos hoje?')), 15_000, 'the agent asked')
    assert.equal(asked.meta.role, 'moderator')
    await notified(from)
  })

  test('it marks seen: the marks of the channel change', async () => {
    await agent('say', { canal: channelId, text: 'Ata no ar.', to: ['usuário'] })
    const unread = async (): Promise<number> => {
      const m = await ok(OP.marks, {})
      return (m.channels as { channel: string; unread: number }[]).find((r) => r.channel === channelId)!.unread
    }
    await eventually(async () => (await unread()) > 0, 10_000, 'the agent line unread')
    const last = (await history()).last as number
    const from = s.events.length
    assert.deepEqual(await ok(OP.seen, { channel: channelId, seq: last }), { seenByUser: last })
    await notified(from)
    await eventually(async () => (await unread()) === 0, 10_000, 'nothing unread once seen')
  })

  test('a resend with the same actId after reconnecting does not speak twice', async () => {
    const id = actId()
    const first = await ok(OP.say, { channel: channelId, text: 'Uma vez só.' }, id)
    s.leg.close()
    await eventually(async () => (await ext(cli, 'remote.status')).sessions === 0, 10_000, 'the old session gone')
    s = await session()
    const again = await call(OP.say, { channel: channelId, text: 'Uma vez só.' }, id)
    assert.deepEqual(again, { status: RES_STATUS.ok, body: first })
    const lines = (await history()).lines.filter((l: { body: string }) => l.body === 'Uma vez só.')
    assert.equal(lines.length, 1, 'one line in the channel')
    await until(() => notes().some((n) => n.content === 'Uma vez só.') || undefined, 15_000, 'the agent heard it')
    await new Promise((r) => setTimeout(r, 1_000))
    assert.equal(notes().filter((n) => n.content === 'Uma vez só.').length, 1, 'the agent heard it once')
  })

  test('files (RR4 4.3): an image goes up and is said, the agent gets its path, the device reads it back by its line; the refusals', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)])
    const speech = actId()
    const act = toHex(speech)
    const up = await ok(OP.upload, { channel: channelId, act, file: 0, name: 'foto da obra.png', size: png.length, offset: 0, data: png.toString('base64url') })
    assert.deepEqual(up, { received: png.length, done: true })
    const body = await ok(OP.say, { channel: channelId, text: 'Olha a foto.', files: [0] }, speech)
    const folder = join(home, 'channels', channelId, 'files')
    const line = (await history()).lines.find((l: { seq: number }) => l.seq === body.seq)
    assert.equal(line.files.length, 1)
    assert.equal(line.files[0].name, 'foto da obra.png')
    assert.equal(resolve(line.files[0].path), resolve(folder, 'foto da obra.png'), 'tetherd copied it into the channel folder')
    assert.deepEqual(readFileSync(line.files[0].path), png)
    const heard = await until(() => notes().find((n) => n.content.startsWith('Olha a foto.')), 15_000, 'the agent hears the speech with its file')
    assert.match(heard.content, /anexos:/)
    await eventually(async () => !existsSync(join(folder, '.remote-upload')) || readdirSync(join(folder, '.remote-upload')).length === 0, 10_000, 'no temporary file left')
    // Back to the device, by (channel, seq, index): the bytes and the type by signature, never a path.
    const got = await call(OP.file, { channel: channelId, seq: body.seq, file: 0, offset: 0 })
    assert.equal(got.status, RES_STATUS.ok)
    assert.deepEqual(Object.keys(got.body).sort(), ['data', 'offset', 'size', 'type'])
    assert.deepEqual([got.body.size, got.body.type], [png.length, 'image/png'])
    assert.deepEqual(Buffer.from(got.body.data as string, 'base64url'), png)
    // An image an agent put in the channel, the same way.
    const agentPng = join(home, 'conferente', 'planta.png')
    writeFileSync(agentPng, png)
    const put = await agent('say', { canal: channelId, text: 'A planta.', files: [agentPng] })
    const agentSeq = (put.line?.seq ?? put.seq) as number
    const back = await call(OP.file, { channel: channelId, seq: agentSeq, file: 0 })
    assert.equal(back.status, RES_STATUS.ok, JSON.stringify(back.body))
    assert.equal(back.body.type, 'image/png')
    // The refusals: no file at that index, a line with no file, a channel that is not there: all "not there".
    for (const b of [{ seq: body.seq, file: 1 }, { seq: said, file: 0 }]) {
      assert.deepEqual(await call(OP.file, { channel: channelId, ...b }), { status: RES_STATUS.notFound, body: {} }, JSON.stringify(b))
    }
    assert.equal((await call(OP.file, { channel: 'c_nada', seq: 1, file: 0 })).status, RES_STATUS.notFound)
    assert.equal((await call(OP.file, { channel: channelId, seq: body.seq, file: 0, path: folder })).status, RES_STATUS.badRequest, 'no path in a body')
    assert.deepEqual(await call(OP.upload, { channel: channelId, act: toHex(actId()), file: 0, name: '.env', size: 3, offset: 0, data: 'AAAA' }), { status: RES_STATUS.failed, body: { error: 'secret-file' } })
    assert.deepEqual(await call(OP.say, { channel: channelId, text: 'sem arquivo', files: [0] }), { status: RES_STATUS.notFound, body: { error: 'unknown-file' } })
    const before = (await history()).last
    assert.equal((await call(OP.upload, { channel: '..', act: toHex(actId()), file: 0, name: 'a.png', size: 3, offset: 0, data: 'AAAA' })).status, RES_STATUS.badRequest)
    assert.equal(existsSync(join(home, 'files')), false, 'nothing above the channels')
    assert.equal((await history()).last, before, 'no refusal wrote a line')
  })

  test('a locked session is refused, and nothing is written', async () => {
    const before = (await history()).last
    assert.equal((await call(OP.lock, {})).status, RES_STATUS.ok)
    assert.deepEqual(await call(OP.say, { channel: channelId, text: 'trancado' }), { status: RES_STATUS.locked, body: {} })
    assert.equal((await call(OP.react, { channel: channelId, seq: said, reaction: '👀' })).status, RES_STATUS.locked)
    assert.equal((await history()).last, before)
    assert.equal((await present(s, auth)).status, RES_STATUS.ok, 'the person unlocks again')
  })

  test('a device without the channels scope is refused before anything is written', async () => {
    s.leg.close()
    await down()
    // The registry as the person would leave it after taking `channels` from this device on the machine.
    const file = join(home, 'remote', 'devices.json')
    const reg = JSON.parse(readFileSync(file, 'utf8')) as { devices: { deviceId: string; scopes: string[] }[] }
    const mine = reg.devices.find((d) => d.deviceId === toHex(device.result!.deviceId))!
    mine.scopes = mine.scopes.filter((x) => x !== 'channels')
    writeFileSync(file, JSON.stringify(reg, null, 2) + '\n')
    await up()
    s = await session()
    const before = (await history()).last
    assert.equal((await call(OP.say, { channel: channelId, text: 'sem escopo' })).status, RES_STATUS.noScope)
    assert.equal((await call(OP.seen, { channel: channelId, seq: 1 })).status, RES_STATUS.noScope)
    assert.equal((await call(OP.page, { channel: channelId })).status, RES_STATUS.noScope, 'nor does it read the channels')
    assert.equal((await history()).last, before)
  })
})
