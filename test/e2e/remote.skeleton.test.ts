// RR1 step 1.5, end to end: a tetherd of the bench (home under TETHER_BENCH_DIR or the system temp, never the person's)
// with the `remote` extension and its real portal, the REAL relay (remote/relay/, its own process), the web client
// (remote/web/, built by its build script and served by its bench server) in a real Chromium (Electron used as a
// plain browser, one ordinary BrowserWindow, driven over CDP), and a spy between the page and the relay: a TCP proxy
// that both legs dial (the relay's `aud` is the proxy's address, as behind a reverse proxy) and that keeps every
// WebSocket payload, unmasked. Played in order: pair with the SAS typed on the house's side, an empty list, a fake slot
// in `waiting` appears live at 390 px, reload reconnects without pairing, the portal goes off and on (the page says
// "offline" and comes back by itself), the spy never saw the canary (the slot's name) nor deviceId nor pub_D in clear,
// and revoking the device on the house drops the page to the pairing screen with the keys gone.
// Screenshots (rr1-*.png) go to REMOTE_SHOTS_DIR, else test/e2e/artifacts.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { fromHex } from '../../src/remote/index.ts'
import { activateWith } from '../../extensions/remote/daemon.ts'
import { manifest } from '../../extensions/remote/manifest.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { guardAppEnv } from './app-env.ts'
import { benchHome, until } from '../unit/remoted.helpers.ts'

const root = resolve(import.meta.dirname, '..', '..')
const shots = resolve(process.env.REMOTE_SHOTS_DIR ?? join(root, 'test', 'e2e', 'artifacts'))
/** The slot's name: it must reach the page, and never cross the relay in clear. */
const CANARY = `canario-${randomBytes(6).toString('hex')}`
/** The slot's args and folder: they must reach neither the relay nor the page. */
const SECRET = `segredo-${randomBytes(6).toString('hex')}`
const TIERS = [[390, 844], [900, 1200], [1440, 900], [2560, 1440]] as const

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await c.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })).result as Record<string, unknown>

// ---- the spy: a TCP proxy that reads the WebSocket frames going through it ---------------------------------------

interface SpyFrame { leg: 'device' | 'house'; dir: 'up' | 'down'; payload: Buffer }

/** Feeds raw bytes of one direction of a WebSocket connection; calls `onFrame` with each data frame's payload, unmasked. */
function wsTap(onHeader: (h: string) => void, onFrame: (payload: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  let header = true
  let frag: Buffer[] = []
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (header) {
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) return
      onHeader(buf.subarray(0, i).toString('latin1'))
      buf = buf.subarray(i + 4)
      header = false
    }
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0]! & 0x80) !== 0
      const op = buf[0]! & 0x0f
      const masked = (buf[1]! & 0x80) !== 0
      let len = buf[1]! & 0x7f
      let at = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
      const maskAt = at
      if (masked) at += 4
      if (buf.length < at + len) return
      const payload = Buffer.from(buf.subarray(at, at + len))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskAt + (i % 4)]!
      buf = buf.subarray(at + len)
      if (op >= 0x8) continue // control frames
      frag.push(payload)
      if (fin) { onFrame(Buffer.concat(frag)); frag = [] }
    }
  }
}

class Spy {
  readonly frames: SpyFrame[] = []
  readonly raw: Buffer[] = []
  target = 0
  #server!: Server
  readonly #sockets = new Set<Socket>()

  async start(): Promise<number> {
    this.#server = createServer((client) => {
      const up = netConnect({ host: 'localhost', port: this.target })
      this.#sockets.add(client).add(up)
      let leg: 'device' | 'house' = 'device'
      const tapUp = wsTap((h) => { leg = /^GET \/v1\/house /.test(h) ? 'house' : 'device' }, (p) => this.frames.push({ leg, dir: 'up', payload: p }))
      const tapDown = wsTap(() => {}, (p) => this.frames.push({ leg, dir: 'down', payload: p }))
      client.on('data', (c: Buffer) => { this.raw.push(c); tapUp(c); up.write(c) })
      up.on('data', (c: Buffer) => { this.raw.push(c); tapDown(c); client.write(c) })
      const end = (): void => { client.destroy(); up.destroy(); this.#sockets.delete(client); this.#sockets.delete(up) }
      client.on('close', end); up.on('close', end)
      client.on('error', () => {}); up.on('error', () => {})
    })
    await new Promise<void>((r) => this.#server.listen(0, 'localhost', r))
    return (this.#server.address() as { port: number }).port
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy()
    return new Promise((r) => this.#server.close(() => r()))
  }

  /** Device-leg frames from the page with this outer type (byte 1 of the outer frame). */
  count(leg: 'device' | 'house', dir: 'up' | 'down', otype: number): number {
    return this.frames.filter((f) => f.leg === leg && f.dir === dir && f.payload[1] === otype).length
  }
}

// ---- child processes of the bench ---------------------------------------------------------------------------------

/** Spawns `node <args>` from the repository root and resolves with the first stdout JSON line that has `event`. */
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

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, 'localhost', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Our own bench process and its tree, by PID only. */
function killTree(p: ChildProcess | undefined): void {
  if (!p?.pid || p.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  else p.kill('SIGKILL')
}

// ---- the test ---------------------------------------------------------------------------------------------------

describe('remote web client, skeleton end to end (RR1.5)', () => {
  const home = benchHome('tether-remote-web-')
  const pipe = uniquePipe(home)
  const out = join(home, 'web-dist')
  const profile = join(home, 'browser-profile')
  const logs: string[] = []
  const relayLines: string[] = []
  const webLines: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env, TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: join(home, 'notices.txt'), TETHER_TEST_REMOTE_TICK_MS: '200',
  }
  const door = new DoorHost({ log: () => {} })
  const spy = new Spy()
  let daemon: Daemon
  let extHost: DaemonExtensionHost
  let app: DaemonClient
  let cli: DaemonClient
  let relay: ChildProcess | undefined
  let web: ChildProcess | undefined
  let electron: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page
  let pageUrl = ''
  let relayUrl = ''
  let slotA = ''
  let deviceId = ''
  let pubD = ''

  const view = (v: string, ms = 20_000): Promise<unknown> => page.waitForSelector(`#app[data-view="${v}"]`, { timeout: ms })
  const shot = async (name: string): Promise<void> => { await page.screenshot({ path: join(shots, `rr1-${name}.png`) }) }
  const houseUp = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) { if ((await ext(cli, 'remote.status')).link === 'up') return; await new Promise((res) => setTimeout(res, 200)) }
    throw new Error(`the house never came up at the relay:\n${relayLines.join('\n')}`)
  }

  before(async () => {
    mkdirSync(shots, { recursive: true })
    mkdirSync(profile, { recursive: true })
    const spyPort = await spy.start()
    relayUrl = `ws://localhost:${spyPort}`
    const w = await spawnNode(['remote/web/bench/serve.ts', '--dir', out, '--port', '0'], 'web.listening', webLines)
    web = w.proc
    pageUrl = `http://localhost:${Number(w.line.port)}/`
    const b = spawnSync(process.execPath, ['remote/web/build.mjs', '--relay', relayUrl, '--out', out], { cwd: root, encoding: 'utf8' })
    assert.equal(b.status, 0, `web build: ${b.stdout}${b.stderr}`)
    const r = await spawnNode(
      ['remote/relay/src/main.ts', 'serve', '--port', '0', '--aud', `localhost:${spyPort}`, '--origins', new URL(pageUrl).origin],
      'relay.listening', relayLines)
    relay = r.proc
    spy.target = Number(r.line.port)

    extHost = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, extensions: [{ manifest, activate: (api) => activateWith(api, { env }).disposables }] })
    extHost.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
    assert.deepEqual(await ext(app, 'remote.on', { relayUrl: `${relayUrl}/v1/house` }), { on: true })
    await houseUp()

    const cdp = await freePort()
    const electronPath = createRequire(import.meta.url)('electron') as string
    const benv: Record<string, string> = {}
    // A plain browser: none of the tether's variables, none of a parent Electron's (its crash handler's pipe included).
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TETHER_|ELECTRON_|CHROME_)/.test(k)) benv[k] = v
    benv.REMOTE_WEB_URL = pageUrl
    benv.REMOTE_WEB_PROFILE = profile
    // The single point of every Electron launch (app-env.ts): private home and pipe, inside a test temp folder.
    benv.TETHER_HOME = join(home, 'browser-home')
    benv.TETHER_PIPE = `${pipe}-browser`
    electron = spawn(electronPath, [`--remote-debugging-port=${cdp}`, join(root, 'remote', 'web', 'bench', 'browser-main.cjs')], { env: guardAppEnv(benv), stdio: 'ignore' })
    for (let i = 0; ; i++) {
      try { browser = await chromium.connectOverCDP(`http://localhost:${cdp}`); break } catch (e) { if (i > 60) throw e; await new Promise((res) => setTimeout(res, 250)) }
    }
    page = await until(() => browser!.contexts()[0]?.pages().find((p) => p.url().startsWith(pageUrl)), 20_000, 'the page in the browser window')
    await page.setViewportSize({ width: 390, height: 844 })
  })

  after(async () => {
    await browser?.close().catch(() => undefined)
    killTree(electron)
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    app?.close()
    cli?.close()
    extHost?.dispose()
    await daemon?.close()
    killTree(relay)
    killTree(web)
    await spy.close()
    await removeHome(home)
  })

  test('first visit: the pairing screen, served under a CSP that only lets the page talk to its relay', async () => {
    await view('pair')
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content')
    // The whole policy, strict: workers and the manifest only from the origin itself, the one Trusted Types policy of the service worker.
    assert.equal(csp, `default-src 'none'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self'; img-src 'self'; connect-src ${relayUrl}; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types tether-sw`)
    await shot('parear-390')
  })

  test('pairing: the code pasted with spaces, the page shows the SAS, the house types it, the device is paired', async () => {
    const begun = await ext(app, 'pair.begin')
    const code = String(begun.code)
    await page.fill('#pair-code', ` ${code} `)
    await page.click('button[type="submit"]')
    await page.waitForSelector('.sas', { timeout: 20_000 })
    const sas = (await page.textContent('.sas'))!.replace(/\s/g, '')
    assert.match(sas, /^\d{6}$/)
    assert.match((await page.textContent('[data-screen="sas"] .status'))!, /Esperando a máquina confirmar/)
    await shot('sas-390')
    let st: Record<string, unknown> = {}
    for (let i = 0; i < 100 && st.state !== 'waiting-sas'; i++) { st = await ext(app, 'pair.state', { pairId: begun.pairId }); await new Promise((r) => setTimeout(r, 100)) }
    assert.equal(st.state, 'waiting-sas')
    assert.match(String((st.device as { declaredName: string }).declaredName), /^Navegador/)
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits: sas })
    await view('list')
    assert.match((await page.textContent('.notice--ok'))!, /Aparelho pareado/)
    const reg = JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as { devices: { deviceId: string; pubD: string; state: string }[] }
    assert.equal(reg.devices.length, 1)
    assert.equal(reg.devices[0]!.state, 'active')
    deviceId = reg.devices[0]!.deviceId
    pubD = reg.devices[0]!.pubD
    // The device's keys: CryptoKeys in the IndexedDB of the origin, not extractable, one record for this house.
    const keys = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open('tether-remote'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      const all = await new Promise<Record<string, unknown>[]>((res, rej) => { const q = db.transaction('houses').objectStore('houses').getAll(); q.onsuccess = () => res(q.result as Record<string, unknown>[]); q.onerror = () => rej(q.error) })
      db.close()
      const k = (o: unknown): { extractable: boolean; type: string; name: string } => {
        const c = (o as { privateKey: CryptoKey }).privateKey
        return { extractable: c.extractable, type: c.type, name: c.algorithm.name }
      }
      return { n: all.length, kD: k(all[0]!.kD), kA: k(all[0]!.kA), state: all[0]!.state, fields: Object.keys(all[0]!).sort() }
    })
    assert.equal(keys.n, 1)
    assert.deepEqual(keys.kD, { extractable: false, type: 'private', name: 'ECDSA' })
    assert.deepEqual(keys.kA, { extractable: false, type: 'private', name: 'ECDSA' })
    assert.equal(keys.state, 'active', 'the normal session that follows the pairing made the record definitive (E-15)')
    assert.deepEqual(keys.fields, ['admitTicket', 'aud', 'deviceId', 'houseId', 'houseName', 'id', 'kA', 'kD', 'pairedAtMs', 'pinnedVer', 'pubH', 'relayUrl', 'state'])
  })

  test('nobody waits: the empty list says so in a sentence', async () => {
    assert.equal(await page.textContent('.empty-title'), 'Ninguém espera você agora.')
    await shot('vazio-390')
  })

  test('a fake slot in `waiting` appears live (attention.watch) at 390 px: name, kind, how long; nothing else of it', async () => {
    const cwd = join(home, `projeto-${SECRET}`)
    mkdirSync(cwd)
    slotA = (await cli.request({ t: 'create', kind: 'shell', cwd, name: `Revisor ${CANARY}`, args: [SECRET], start: false })).slot!.slotId
    door.port!.signal(slotA, 'waiting')
    const item = `.waiting-item[data-id="${slotA}"]`
    await page.waitForSelector(item, { timeout: 15_000 })
    assert.equal(await page.textContent(`${item} .wi-name`), `Revisor ${CANARY}`)
    assert.equal(await page.textContent(`${item} .wi-kind`), 'Terminal')
    assert.equal(await page.textContent(`${item} .wi-since`), 'agora')
    const box = await page.locator(item).boundingBox()
    assert.ok(box && box.height >= 44, `a row of at least 44 px (${box?.height})`)
    assert.ok(box && box.x >= 16 && box.x + box.width <= 390 - 16 + 0.5, 'the row keeps the 16 px gutter')
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(scrollW <= 390, 'no horizontal scroll at 390 px')
    assert.doesNotMatch(await page.content(), new RegExp(SECRET), 'the slot\'s args and folder never reach the page')
    for (const [wd, ht] of TIERS) {
      await page.setViewportSize({ width: wd, height: ht })
      await new Promise((r) => setTimeout(r, 150))
      await shot(`lista-${wd}`)
      const b = await page.locator(item).boundingBox()
      if (wd >= 768) assert.ok(b && b.width < wd * 0.9, `at ${wd} px the list does not run edge to edge (${b?.width})`)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    await shot('lista-390-claro')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shot('lista-390-escuro')
    await page.emulateMedia({ colorScheme: null })
  })

  test('reloading the page reconnects without pairing again: admission with the stored ticket, straight to the Regency', async () => {
    const admitsBefore = spy.count('device', 'up', 0x02)
    await page.reload()
    // The device only reads (no offer is open after a reload): the screen after the admission is the Regency, not the list.
    // (This bench has no Regency keeper, so the casing stays "lendo a casa…": the session is up, the house is not read.)
    await view('regency')
    await page.waitForSelector('.rr:not([data-link="offline"])', { timeout: 20_000 })
    assert.equal(await page.locator('[data-screen="pair"], #pair-code').count(), 0, 'no pairing screen')
    assert.equal(spy.count('device', 'up', 0x02), admitsBefore + 1, 'one D_ADMIT, no D_PAIR')
    const state = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open('tether-remote'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      const all = await new Promise<{ state: string }[]>((res, rej) => { const q = db.transaction('houses').objectStore('houses').getAll(); q.onsuccess = () => res(q.result as { state: string }[]); q.onerror = () => rej(q.error) })
      db.close()
      return all[0]?.state
    })
    assert.equal(state, 'active', 'the first HS_DONE made the record definitive')
  })

  test('the portal goes off: the page says the tether is offline, and comes back by itself when it is on again', async () => {
    await ext(cli, 'remote.off')
    await page.waitForSelector('.rr[data-link="offline"] .rr-off', { timeout: 20_000 })
    assert.match((await page.textContent('.rr-off'))!, /Seu tether está offline/)
    await shot('offline-390')
    await ext(app, 'remote.on', { relayUrl: `${relayUrl}/v1/house` })
    // By itself: nobody taps "Tentar agora".
    await view('regency', 60_000)
    await page.waitForSelector('.rr:not([data-link="offline"])', { timeout: 5_000 })
  })

  test('the spy between the page and the relay: no frame in clear carries the canary, the device name, deviceId or pub_D', () => {
    const device = spy.frames.filter((f) => f.leg === 'device')
    assert.ok(spy.count('device', 'up', 0x10) > 5 && spy.count('device', 'down', 0x10) > 5, 'DATA frames crossed the spy both ways')
    assert.ok(spy.frames.some((f) => f.leg === 'house'), 'the house leg crossed the spy too')
    assert.ok(device.length > 0)
    const all = Buffer.concat([...spy.frames.map((f) => f.payload), ...spy.raw])
    const has = (s: string | Uint8Array): boolean => all.includes(typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s))
    assert.ok(!has(CANARY), 'the canary (the slot\'s name) in clear')
    assert.ok(!has(SECRET), 'the slot\'s args or folder in clear')
    assert.ok(!has('Revisor'), 'a slot name in clear')
    assert.ok(!has('Navegador'), 'the device name in clear')
    assert.ok(!has(fromHex(deviceId)), 'deviceId in clear')
    assert.ok(!has(deviceId), 'deviceId (hex) in clear')
    assert.ok(!has(fromHex(pubD)), 'pub_D in clear')
    // M-10: the relay's log never names the ticket, the meeting point, nor the canary.
    assert.doesNotMatch(relayLines.join('\n'), new RegExp(CANARY))
  })

  test('revoking the device on the house drops the page to the pairing screen, and the device forgets the house', async () => {
    const t0 = Date.now()
    const r = await ext(cli, 'device.revoke', { device: deviceId.slice(0, 8) })
    assert.equal((r.device as { state: string }).state, 'revoked')
    await view('pair', 5_000)
    const fell = Date.now() - t0
    assert.match((await page.textContent('.notice--err'))!, /desconectado na máquina/)
    assert.ok(fell < 3_000, `the page fell in ${fell} ms`)
    await shot('revogado-390')
    const left = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open('tether-remote'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      const n = await new Promise<number>((res, rej) => { const q = db.transaction('houses').objectStore('houses').count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      db.close()
      return n
    })
    assert.equal(left, 0, 'CLOSE(0x04) erased the house and its keys')
    await page.reload()
    await view('pair')
  })
})
