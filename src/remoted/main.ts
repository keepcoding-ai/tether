// tether-remoted, the remote portal (plano D1b): `node src/remoted/main.ts`, spawned by the `remote` extension of tetherd
// with stdin (the credential), its log as stdout/stderr, and Node's IPC channel to the extension. It is a client of the
// tetherd pipe as `client:'remote'`, dials OUT to the relay, does the house's half of the cipher, checks each device and
// each request by the operations table, and projects what it tells a device by allow list. It never forwards the pipe.
//
// Start, in this order, and refusing to serve at the first failure (a `fatal` line on the IPC, then the exit code):
//   1. the credential: 64 hex and a newline on stdin, then stdin closes (fio-spec 1.5; never env, argument or file);
//   2. <home>/remote/ must be private to the user (M-7): an open folder may hold a planted device or a stolen key;
//   3. the extension's `init` (relay URL, house name, registry), the URL checked by relayUrlAllowed (B-8);
//   4. the keys of <home>/remote/, imported non-extractable;
//   5. the pipe, whose hello must come back as `remote` (a portal whose credential is not tetherd's is nobody).
// It leaves when the pipe closes, when the IPC channel goes (tetherd died) or on `stop`: a portal never outlives the
// tetherd that spawned it, so the credential and the pairing tickets die with both. Async fs only (sync-fs ratchet root).
import { appendFile, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { agentExecutor } from '../agents/agent-exec.ts'
import { remoteBenchOn, tetherHome } from '../core/paths.ts'
import { DaemonClient } from '../daemon/client.ts'
import { pipePath } from '../daemon/protocol.ts'
import { buildHouseAuth, relayUrlAllowed, selfTest, type RelyingParty } from '../remote/index.ts'
import { AttentionView } from './attention.ts'
import { House, PortalError } from './house.ts'
import { PORTAL_EXIT, webRelyingParty, type FromPortal, type PortalAsk, type ToPortal } from './ipc.ts'
import { KEY_FILES, loadKeys } from './keyfiles.ts'
import { makeNotice } from './notice.ts'
import { pipeReads } from './reads.ts'
import { audOf, RelayLink } from './relay.ts'

const home = tetherHome()
const remoteDir = join(home, 'remote')
const logPath = join(home, 'tether-remoted.log')
const bench = remoteBenchOn(process.env, home)
const knob = (name: string): number | undefined => {
  const v = bench ? Number(process.env[name]) : NaN
  return Number.isFinite(v) && v > 0 ? v : undefined
}

function log(msg: string): void {
  appendFile(logPath, `${new Date().toISOString()} [${process.pid}] ${msg}\n`).catch(() => { /* disk full or gone */ })
}

function send(m: FromPortal): void {
  if (process.send && process.connected) process.send(m)
}

let exiting = false
function leave(code: number, reason: string): void {
  if (exiting) return
  exiting = true
  log(`exiting: ${reason}`)
  if (code !== PORTAL_EXIT.ok) send({ t: 'fatal', reason })
  setTimeout(() => process.exit(code), 150)
}

/** The credential from stdin: exactly 64 lowercase hex and a newline, within 5 s. */
function readCredential(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let got = ''
    const done = (v: string | undefined): void => { clearTimeout(timer); process.stdin.removeAllListeners(); process.stdin.pause(); resolve(v) }
    const timer = setTimeout(() => done(undefined), 5_000)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c: string) => {
      got += c
      if (got.length > 128) done(undefined)
      else if (got.includes('\n')) done(/^[0-9a-f]{64}\n$/.test(got) ? got.slice(0, 64) : undefined)
    })
    process.stdin.on('end', () => done(/^[0-9a-f]{64}\n?$/.test(got) ? got.slice(0, 64) : undefined))
    process.stdin.on('error', () => done(undefined))
  })
}

/** The relying party of WebAuthn from the address of the phone's app (ipc.ts webRelyingParty), saying in the log when there is none. */
function rpOf(webUrl: string | undefined): RelyingParty | undefined {
  const rp = webRelyingParty(webUrl)
  if (webUrl !== undefined && !rp) log('the address of the phone app gives no WebAuthn origin: no presence credential')
  return rp
}

/** Asks for `init` once listening (a message sent before a listener exists would be lost) and waits for it. */
function askInit(timeoutMs: number): Promise<ToPortal | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { process.off('message', on); resolve(undefined) }, timeoutMs)
    const on = (m: unknown): void => { clearTimeout(timer); process.off('message', on); resolve(m as ToPortal) }
    process.on('message', on)
    send({ t: 'want-init' })
  })
}

async function main(): Promise<void> {
  if (!process.send) { process.stderr.write('tether-remoted: só sobe pelo tetherd (extensão remote)\n'); process.exit(PORTAL_EXIT.config) }
  const cred = await readCredential()
  if (!cred) return leave(PORTAL_EXIT.badCredential, 'no valid credential on stdin')
  process.on('disconnect', () => leave(PORTAL_EXIT.ok, 'the IPC channel closed (tetherd is gone)'))

  const isPrivate = await agentExecutor().run('isPrivateFolder', [remoteDir]).catch(() => false)
  if (!isPrivate) return leave(PORTAL_EXIT.folderOpen, `a pasta ${remoteDir} está aberta a outras contas da máquina: recusei subir`)

  const init = await askInit(10_000)
  if (!init || init.t !== 'init') return leave(PORTAL_EXIT.config, 'no init from the extension')
  if (!relayUrlAllowed(init.relayUrl)) return leave(PORTAL_EXIT.config, 'relay URL refused (wss:// only; ws:// only for localhost)')
  const aud = audOf(init.relayUrl)

  await selfTest()
  let keys
  try {
    keys = await loadKeys({
      house: await readFile(join(remoteDir, KEY_FILES.house), 'utf8'),
      relay: await readFile(join(remoteDir, KEY_FILES.relay), 'utf8'),
      ticket: await readFile(join(remoteDir, KEY_FILES.ticket), 'utf8'),
    })
  } catch (e) { return leave(PORTAL_EXIT.keys, `house keys unreadable (${(e as Error).message})`) }

  const pipe = process.env.TETHER_PIPE ?? pipePath(home, userInfo().username)
  let client: DaemonClient
  try { client = await DaemonClient.open(pipe, 'remote', { home, cred }) } catch (e) {
    return leave(PORTAL_EXIT.pipe, `cannot reach tetherd (${(e as Error).message})`)
  }
  if (client.hello.client !== 'remote') { client.close(); return leave(PORTAL_EXIT.badCredential, 'tetherd did not take this portal as remote') }
  client.on('close', () => leave(PORTAL_EXIT.ok, 'the pipe closed'))

  const attention = new AttentionView()
  let feed: House | undefined // the slots and tetherd's events also feed the house's thin notices, once it exists
  client.on('state', (s) => { attention.state(s); feed?.slotsChanged() })
  client.on('removed', (id) => { attention.removed(id); feed?.slotsChanged() })
  client.on('ext-event', (e) => feed?.extEvent(e.ext, e.name, e.payload))
  attention.reset((await client.request({ t: 'list' })).slots ?? [])

  let askSeq = 0
  const asks = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  const ask = (a: PortalAsk): Promise<void> => new Promise((resolve, reject) => {
    const id = ++askSeq
    const timer = setTimeout(() => { asks.delete(id); reject(new Error('the registry did not answer')) }, 10_000)
    asks.set(id, { resolve, reject, timer })
    send({ t: 'ask', id, ...a })
  })

  let link: RelayLink | undefined // the house writes through it; it is made right after the house
  const idleMs = knob('TETHER_TEST_REMOTE_IDLE_MS')
  const renewDenyAfterMs = knob('TETHER_TEST_REMOTE_DENY_AFTER_MS')
  const channelsGap = knob('TETHER_TEST_REMOTE_CHANNELS_GAP_MS')
  const regencyGap = knob('TETHER_TEST_REMOTE_REGENCY_GAP_MS')
  const house = new House({
    keys, aud, houseName: init.houseName, attention, ask, log, now: Date.now, rp: rpOf(init.webUrl),
    // The class `ext-read` of PIPE_REACH: the only path from a device to tetherd's extensions (./reads.ts).
    reads: pipeReads((body) => client.request(body)),
    ...(channelsGap !== undefined || regencyGap !== undefined
      ? { noticeGapsMs: { ...(channelsGap !== undefined ? { channels: channelsGap } : {}), ...(regencyGap !== undefined ? { regency: regencyGap } : {}) } }
      : {}),
    send: (f) => link?.send(f),
    note: (n) => send({ t: 'note', ...n }),
    notice: makeNotice(bench ? process.env : {}, log),
    ...(idleMs !== undefined ? { idleMs } : {}),
    ...(renewDenyAfterMs !== undefined ? { renewDenyAfterMs } : {}),
  })
  feed = house
  await house.init(init.devices, init.deny)
  // The address changed while no portal was up: said now, as a `web` message says it to a portal already up.
  if (init.webChanged) house.setRelyingParty(rpOf(init.webUrl))
  const relay = new RelayLink({
    url: init.relayUrl, log,
    auth: (r) => buildHouseAuth({ r, aud, pubH: keys.kH.pub, certR: keys.certR, certsT: keys.certsT, kR: keys.kR, nowS: Math.floor(Date.now() / 1000) }),
    up: () => house.linkUp(),
    down: () => house.linkDown(),
    frame: (b) => house.onFrame(b),
    ...(bench ? { backoffMs: { first: 200, max: 2_000 } } : {}),
  })
  link = relay

  process.on('message', (raw: unknown) => {
    const m = raw as ToPortal
    switch (m.t) {
      case 'answer': {
        const w = asks.get(m.id)
        if (!w) return
        asks.delete(m.id)
        clearTimeout(w.timer)
        if (m.ok) w.resolve()
        else w.reject(new Error(m.error ?? 'refused'))
        return
      }
      case 'device': house.upsertDevice(m.device); return
      case 'web': house.setRelyingParty(rpOf(m.webUrl)); return
      case 'forget': house.forgetDevice(m.deviceId); return
      case 'revoke': void house.revoke(m.deviceId, m.deny); return
      case 'stop':
        void house.shutdown().finally(() => { relay.stop(); client.close(); leave(PORTAL_EXIT.ok, 'stop') })
        return
      case 'cmd': void command(m)
    }
  })

  async function command(m: Extract<ToPortal, { t: 'cmd' }>): Promise<void> {
    try {
      let result: unknown
      switch (m.cmd) {
        case 'pair.begin': result = await house.pairBegin(); break
        case 'pair.sas': result = await house.pairSas(m.pairId, m.digits); break
        case 'pair.cancel': result = await house.pairCancel(m.pairId); break
        case 'pair.state': result = house.pairState(m.pairId); break
        case 'status': result = house.status(); break
        case 'session.end': result = await house.endSessions(m.deviceId); break
      }
      send({ t: 'reply', id: m.id, ok: true, result })
    } catch (e) {
      const code = e instanceof PortalError ? e.code : 'failed'
      if (!(e instanceof PortalError)) log(`command ${m.cmd} failed: ${(e as Error).message}`)
      send({ t: 'reply', id: m.id, ok: false, code, error: e instanceof PortalError ? e.message : 'falhou' })
    }
  }

  const tickMs = knob('TETHER_TEST_REMOTE_TICK_MS') ?? 1_000
  setInterval(() => { void house.tick().catch((e: Error) => log(`tick: ${e.message}`)) }, tickMs)
  relay.start()
  log(`started pid ${process.pid}, home ${home}, relay ${aud}`)
  send({ t: 'ready', pid: process.pid })

  process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e.message}`))
  process.on('unhandledRejection', (r) => log(`unhandled rejection: ${String((r as Error)?.stack ?? r)}`))
}

void main().catch((e: Error) => {
  log(`crashed: ${e.message}`)
  leave(PORTAL_EXIT.crashed, 'crashed')
})
