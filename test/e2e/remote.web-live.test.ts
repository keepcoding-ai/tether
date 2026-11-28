// RR3 ("ver") end to end, in a browser: the REAL web client (remote/web, built by its own build.mjs with this bench's relay
// written in, served by bench/serve.ts) in a real Chromium (Electron of the bench, driven over CDP, with a virtual platform
// authenticator that answers by itself), against the REAL relay (remote/relay/, its own process) and a tetherd of the bench
// (home under TETHER_BENCH_DIR or the system temp, never the person's) with the `remote`, `channels` and `regency`
// extensions and the real portal. The app is a pipe client `app` that does what the app's renderer does for the Regency:
// it creates a channel, publishes the tree (extensions/regency/daemon.ts `tree.publish`) and keeps its lease. An agent is a
// slot of the bench that speaks by the CLI's road (the pipe's `verb` request).
//
// The roteiro of RR3, one test each, in order: pair; "Agora não" on the offer to protect; unlock; the Regency's tree; a line
// in a channel re-reads the marks; the app closed ("como estavam às HH:MM"); offline (only the notice); paging the channel
// back; locked by the machine; a burst of events. Then the TV (2560 px): five captures of the walk by arrows. Last, a device
// without the scopes of the Regency and of the channels (the bench restarts tetherd with the device's scopes narrowed in its
// registry, the one place they live), because nothing after it could read.
// RR4 4.2b, the person converses from the phone (a protected device): she votes with a short reason on the "não"; opening
// the channel marks it seen and its marks change; at 390 px she speaks (with "@" for whom), the speech shows "enviando" at
// once and is confirmed by its seq, and the channel has it from the moderator; she reacts and takes the reaction off; she
// opens a poll; the four sizes are captured with the box and a poll's card; she locks the device from its strip, and once
// unlocked what waited to be said goes; two windows of the device: the second says where the Regency is, "Usar aqui" takes
// it, and closing the owner gives it back to the other.
// Captures go to REMOTE_SHOTS_DIR (else test/e2e/artifacts): rr3-live-*.png and rr4-*.png, and the TV's under rr3-tv/.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { after, before, describe, test } from 'node:test'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { VerbResult } from '../../src/daemon/door/types.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { activateWith as activateRemote } from '../../extensions/remote/daemon.ts'
import { manifest as remoteManifest } from '../../extensions/remote/manifest.ts'
import { activate as activateChannels } from '../../extensions/channels/daemon.ts'
import { manifest as channelsManifest } from '../../extensions/channels/manifest.ts'
import { activateWith as activateRegency } from '../../extensions/regency/daemon.ts'
import { manifest as regencyManifest } from '../../extensions/regency/manifest.ts'
import { STALE_MS } from '../../extensions/regency/publish-rules.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { guardAppEnv } from './app-env.ts'
import { benchHome, until } from '../unit/remoted.helpers.ts'

const root = resolve(import.meta.dirname, '..', '..')
const shots = resolve(process.env.REMOTE_SHOTS_DIR ?? join(root, 'test', 'e2e', 'artifacts'))
const tvShots = join(shots, 'rr3-tv')
/** Lines the channel holds before the device looks: more than one page (50), so paging back has something to find. */
const LINES = 55
const pad = (n: number): string => String(n).padStart(3, '0')

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>, extName = 'remote'): Promise<Record<string, unknown>> =>
  (await c.request({ t: 'ext-request', ext: extName, name, ...(args ? { args } : {}) })).result as Record<string, unknown>

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A real PNG of one colour (a picture the browser decodes), made here: signature, IHDR, one IDAT, IEND. */
function pngOf(w: number, h: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

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

/** `until` for a check that awaits: polls every 150 ms until it gives a value. */
async function eventually<T>(f: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await sleep(150)
  }
}

interface VirtualCredential { credentialId: string; signCount: number }
interface DeviceRow { id: string; state: string; biometrics: boolean }
/** What the page says of the element that holds the keyboard. */
interface Held { key: string; left: number; right: number; inTree: boolean; inLeft: boolean; inCenter: boolean; inRight: boolean; ring: boolean }

describe('remote web client live (RR3): the real PWA over the real relay, portal and tetherd of the bench', () => {
  const home = benchHome('tether-remote-web-live-')
  const pipe = uniquePipe(home)
  const out = join(home, 'web-dist')
  const profile = join(home, 'browser-profile')
  const logs: string[] = []
  const relayLines: string[] = []
  const webLines: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env, TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: join(home, 'notices.txt'), TETHER_TEST_REMOTE_TICK_MS: '200',
    TETHER_TEST_REMOTE_CHANNELS_GAP_MS: '500', TETHER_TEST_REMOTE_REGENCY_GAP_MS: '500',
  }
  /** Web Push (RR4 4.4): on the bench the portal dials only this origin (set in before(); nothing listens there). */
  let pushOrigin = ''
  /**
   * The Regency keeper's clock: `skewMs` moves it past the lease (the app "closed" without waiting 75 s), and `expire` is the
   * keeper's own lease timer, run at once.
   */
  const lease: { skewMs: number; expire: (() => void) | undefined } = { skewMs: 0, expire: undefined }
  let door: DoorHost | undefined
  let extHost: DaemonExtensionHost | undefined
  let daemon: Daemon | undefined
  let app: DaemonClient
  let cli: DaemonClient
  let relay: ChildProcess | undefined
  let web: ChildProcess | undefined
  let electron: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page
  let cdp: CDPSession
  let authenticatorId = ''
  let pageUrl = ''
  let relayUrl = ''
  let channelId = ''
  let extraId = ''
  let memberId = ''
  let auditorId = ''
  /** The device's own speech of step 13, the one it reacts on. */
  let saidSeq = 0
  let channelRows: unknown[] = []
  let treeSig = ''
  let treeAt = 0
  let renew: ReturnType<typeof setInterval> | undefined
  const pageErrors: string[] = []

  // ---- the house: tetherd of the bench, stopped and started again with the same home --------------------------------

  const startHouse = async (): Promise<void> => {
    const d = new DoorHost({ log: () => {} })
    door = d
    extHost = new DaemonExtensionHost({
      home, log: (m) => logs.push(m), door: d,
      extensions: [
        { manifest: remoteManifest, activate: (api) => activateRemote(api, { env }).disposables },
        { manifest: channelsManifest, activate: (api) => activateChannels(api) },
        {
          manifest: regencyManifest,
          activate: (api) => activateRegency(api, {
            now: () => Date.now() + lease.skewMs,
            setTimer: (fn, ms) => { lease.expire = fn; const t = setTimeout(fn, ms); t.unref(); return t },
          }).disposables,
        },
      ],
    })
    extHost.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door: d, log: (m) => logs.push(m) })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
  }

  const stopHouse = async (): Promise<void> => {
    appCloses()
    try { await ext(app, 'remote.off') } catch { /* already off */ }
    app?.close()
    cli?.close()
    extHost?.dispose()
    extHost = undefined
    await daemon?.close()
    daemon = undefined
    door?.delivery.dispose()
    await door?.mcp.close().catch(() => undefined)
    door = undefined
  }

  const remoteOn = (): Promise<Record<string, unknown>> => ext(app, 'remote.on', { relayUrl: `${relayUrl}/v1/house`, webUrl: pageUrl })

  const houseUp = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) { if ((await ext(cli, 'remote.status')).link === 'up') return; await sleep(200) }
    throw new Error(`the house never came up at the relay:\n${relayLines.join('\n')}`)
  }

  // ---- what the app does for the Regency: publish the tree and keep its lease ----------------------------------------

  /** The Regency's entry in the shape the app publishes it: two desks, the channel's member as an agent, the open channels. */
  const treeOf = (o: { conferente?: string; revisor?: string } = {}): Record<string, unknown> => ({
    desks: {
      desks: [
        {
          id: 'desk-obra', name: 'Obra', color: 'blue', kind: 'queue', asleep: false, panes: [
            { id: memberId, type: 'terminal', icon: 'sparkle', title: o.conferente ?? 'conferente', busy: true, lines: ['Revisando a tela de filtro'] },
            { id: 'p-web', type: 'terminal', icon: 'terminal-window', title: 'web · npm run dev' },
          ],
        },
        {
          id: 'desk-migr', name: 'Migração', color: 'green', kind: 'queue', asleep: false, panes: [
            { id: 'p-migra', type: 'terminal', icon: 'ghost', title: 'migra', busy: true },
            { id: 'p-revisor', type: 'terminal', icon: 'sparkle', title: o.revisor ?? 'revisor', attention: 'waiting', lines: ['Esperando você'] },
          ],
        },
      ],
    },
    owners: { desk: {}, pane: {} },
    channels: channelRows,
    channelMarks: {},
    agents: [
      { id: memberId, kind: 'claude', name: 'conferente' },
      { id: 'p-migra', kind: 'soul', name: 'migra' },
      { id: 'p-revisor', kind: 'claude', name: 'revisor' },
    ],
    since: { 'agent:p-revisor': Date.now() - 6 * 60_000, 'pane:p-revisor': Date.now() - 6 * 60_000 },
    collapsed: [],
  })

  const publish = async (o: { conferente?: string; revisor?: string } = {}): Promise<void> => {
    const r = await ext(app, 'tree.publish', { tree: treeOf(o) }, 'regency')
    treeSig = String(r.sig)
    treeAt = Number(r.at)
  }

  /** The open app renews the lease (every LEASE_MS in the app; more often here). */
  const appOpens = (): void => {
    appCloses()
    renew = setInterval(() => { void ext(app, 'tree.publish', { sig: treeSig }, 'regency').catch(() => undefined) }, 10_000)
  }
  function appCloses(): void {
    if (renew) clearInterval(renew)
    renew = undefined
  }

  /** An agent of the bench speaks or acts by the CLI's road (the pipe's `verb` request). */
  const agent = async (name: string, args: Record<string, unknown>): Promise<VerbResult> => {
    const r = (await cli.request({ t: 'verb', ns: 'channels', name, slotId: memberId, args })) as unknown as { verb: VerbResult }
    assert.notEqual(r.verb.isError, true, `${name}: ${r.verb.text}`)
    return r.verb
  }

  /** What the house holds of a channel (the app's own reading). */
  const historyOf = async (channel: string): Promise<Record<string, unknown>> => ext(app, 'history', { channel }, 'channels')

  // ---- the page ------------------------------------------------------------------------------------------------------

  const view = (v: string, ms = 20_000): Promise<unknown> => page.waitForSelector(`#app[data-view="${v}"]`, { timeout: ms })
  const shot = async (name: string): Promise<void> => { await page.screenshot({ path: join(shots, `rr3-live-${name}.png`) }) }
  const text = async (sel: string): Promise<string> => (await page.textContent(sel)) ?? ''
  /**
   * A tap on what was just seen on screen, which may go before it lands (the screen moves on its own): a short wait, never
   * the 30 s default that would outlast the check around it.
   */
  const tap = (sel: string): Promise<void> => page.click(sel, { timeout: 1_500 }).catch(() => undefined)
  const msgsHave =(needle: string): Promise<boolean> => page.evaluate((n) => (document.querySelector('.ch-msgs')?.textContent ?? '').includes(n), needle)
  const credentials = async (): Promise<VirtualCredential[]> =>
    ((await cdp.send('WebAuthn.getCredentials', { authenticatorId })) as { credentials: VirtualCredential[] }).credentials
  const devices = async (): Promise<DeviceRow[]> => (await ext(app, 'device.list')).devices as DeviceRow[]

  /** The code typed on the device, the six digits typed on the machine; resolves on the screen after the pairing. */
  const pairHere = async (): Promise<void> => {
    await view('pair')
    const begun = await ext(app, 'pair.begin')
    await page.fill('#pair-code', String(begun.code))
    await page.click('button[type="submit"]')
    await page.waitForSelector('.sas', { timeout: 20_000 })
    const sas = (await text('.sas')).replace(/\s/g, '')
    let st: Record<string, unknown> = {}
    for (let i = 0; i < 100 && st.state !== 'waiting-sas'; i++) { st = await ext(app, 'pair.state', { pairId: begun.pairId }); await sleep(100) }
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits: sas })
    await view('list')
  }

  /**
   * Until the Regency is on screen and live: the person taps "Destrancar" when the machine asks for it, and "Tentar agora"
   * while the house is out of reach.
   */
  const toRegency = async (ms = 45_000): Promise<void> => {
    await eventually(async () => {
      if (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await tap('#unlock')
      else if (await page.isVisible('.rr-off .rr-btn')) await tap('.rr-off .rr-btn')
      return (await page.isVisible('.rr[data-link="live"] .rg-tree [data-key]')) || undefined
    }, ms, 'the Regency, live')
  }

  /** What holds the keyboard now (undefined: nobody). */
  const held = (): Promise<Held | undefined> => page.evaluate(() => {
    const a = document.activeElement
    if (!(a instanceof HTMLElement) || a === document.body) return undefined
    const r = a.getBoundingClientRect()
    const cs = getComputedStyle(a)
    const d = a.dataset
    return {
      key: d.key ?? d.target ?? d.filter ?? d.action ?? a.className, left: r.left, right: r.right,
      inTree: a.closest('.rg-tree') !== null, inLeft: a.closest('.rg-left') !== null, inCenter: a.closest('.rg-center') !== null, inRight: a.closest('.rg-right') !== null,
      ring: (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || cs.boxShadow !== 'none',
    }
  })

  before(async () => {
    mkdirSync(tvShots, { recursive: true })
    mkdirSync(profile, { recursive: true })
    // `--shell`: the service worker too (step 18 needs one to ask the browser for a subscription).
    const w = await spawnNode(['remote/web/bench/serve.ts', '--dir', out, '--port', '0', '--shell'], 'web.listening', webLines)
    web = w.proc
    pageUrl = `http://localhost:${Number(w.line.port)}/`
    const relayPort = await freePort()
    relayUrl = `ws://localhost:${relayPort}`
    // A port that was free when taken, so no notice leaves the machine. It must be one benchPushOrigin takes (2 to 5 digits):
    // any other is no bench origin, and the portal refuses the page's subscription as `push-service`.
    pushOrigin = `http://localhost:${await freePort()}`
    env.TETHER_TEST_REMOTE_PUSH_ORIGIN = pushOrigin
    // The relay of an origin is written into its page by the build (spec 3.2): the published bundle, with this bench's relay.
    const b = spawnSync(process.execPath, ['remote/web/build.mjs', '--relay', relayUrl, '--out', out], { cwd: root, encoding: 'utf8' })
    assert.equal(b.status, 0, `web build: ${b.stdout}${b.stderr}`)
    const r = await spawnNode(
      ['remote/relay/src/main.ts', 'serve', '--port', String(relayPort), '--aud', `localhost:${relayPort}`, '--origins', new URL(pageUrl).origin],
      'relay.listening', relayLines)
    relay = r.proc

    await startHouse()
    assert.deepEqual(await remoteOn(), { on: true })
    await houseUp()

    // What the app holds: a channel with a member (an agent's slot, not started) and LINES lines of the person.
    const made = await ext(app, 'create', { name: 'obra' }, 'channels')
    channelId = (made.channel as { id: string }).id
    const created = await cli.request({ t: 'create', kind: 'claude', cwd: home, name: 'conferente', start: false }) as { slot?: { slotId: string } }
    memberId = created.slot!.slotId
    await ext(app, 'join', { channel: channelId, agent: memberId }, 'channels')
    // A second member (a poll that calls it stays open after the person votes) and a second channel (it calls the person
    // while another one is on screen, so its marks are seen only when she opens it).
    const auditor = await cli.request({ t: 'create', kind: 'claude', cwd: home, name: 'auditor', start: false }) as { slot?: { slotId: string } }
    auditorId = auditor.slot!.slotId
    await ext(app, 'join', { channel: channelId, agent: auditorId }, 'channels')
    for (let i = 1; i <= LINES; i++) await ext(app, 'say', { channel: channelId, text: `linha ${pad(i)}` }, 'channels')
    const extra = await ext(app, 'create', { name: 'extra' }, 'channels')
    extraId = (extra.channel as { id: string }).id
    await ext(app, 'join', { channel: extraId, agent: memberId }, 'channels')
    channelRows = (await ext(app, 'list', {}, 'channels')).channels as unknown[]
    await publish()
    appOpens()

    const port = await freePort()
    const electronPath = createRequire(import.meta.url)('electron') as string
    const benv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TETHER_|ELECTRON_|CHROME_)/.test(k)) benv[k] = v
    benv.REMOTE_WEB_URL = pageUrl
    benv.REMOTE_WEB_PROFILE = profile
    benv.TETHER_HOME = join(home, 'browser-home')
    benv.TETHER_PIPE = `${pipe}-browser`
    electron = spawn(electronPath, [`--remote-debugging-port=${port}`, join(root, 'remote', 'web', 'bench', 'browser-main.cjs')], { env: guardAppEnv(benv), stdio: 'ignore' })
    for (let i = 0; ; i++) {
      try { browser = await chromium.connectOverCDP(`http://localhost:${port}`); break } catch (e) { if (i > 60) throw e; await sleep(250) }
    }
    page = await until(() => browser!.contexts()[0]?.pages().find((p) => p.url().startsWith(pageUrl)), 20_000, 'the page in the browser window')
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    // A platform authenticator with user verification, as a phone with a fingerprint reader. It answers by itself.
    cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable', { enableUI: false })
    const added = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })
    authenticatorId = (added as { authenticatorId: string }).authenticatorId
    // The window is hidden: the page is told it has the focus, as a phone's open app has (the focus ring follows it).
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // The offer is decided once, right after pairing: the page must already see the authenticator (reload after its first load).
    await page.waitForLoadState('load')
    await page.reload()
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  after(async () => {
    appCloses()
    await browser?.close().catch(() => undefined)
    killTree(electron)
    await stopHouse().catch(() => undefined)
    killTree(relay)
    killTree(web)
    await removeHome(home)
  })

  test('1. parear: o código digitado no aparelho, os seis dígitos confirmados na máquina', async () => {
    await pairHere()
    await page.waitForSelector('[data-panel="guard"] #guard-skip', { timeout: 10_000 })
    assert.match(await text('[data-panel="guard"]'), /Proteger com a biometria deste aparelho/)
    const ds = await devices()
    assert.equal(ds.filter((d) => d.state !== 'revoked').length, 1, 'one device on the machine')
    await shot('1-oferta')
  })

  test('2. "Agora não" na oferta de proteger: o aparelho só lê e vai direto à Regência, sem trancar', async () => {
    await page.click('#guard-skip')
    await view('regency')
    await page.waitForSelector('.rr[data-link="live"] .rg-tree [data-key]', { timeout: 20_000 })
    assert.equal(await page.isVisible('[data-panel="lock"]'), false, 'a device that only reads is never asked to unlock')
    assert.equal((await credentials()).length, 0, 'no credential was made')
    const [d] = (await devices()).filter((x) => x.state !== 'revoked')
    assert.equal(d!.biometrics, false)
  })

  test('3. destrancar: um aparelho protegido destranca com a biometria (a máquina revoga o que só lia; o novo pareamento aceita a proteção)', async () => {
    const [old] = (await devices()).filter((x) => x.state !== 'revoked')
    await ext(app, 'device.revoke', { device: old!.id })
    await view('pair')
    assert.match(await text('#app'), /desconectado na máquina/)
    await pairHere()
    await page.waitForSelector('[data-panel="guard"] #guard-protect', { timeout: 10_000 })
    await page.click('#guard-protect')
    await toRegency()
    const creds = await credentials()
    assert.equal(creds.length, 1, 'one credential on the platform authenticator')
    // 1 for the registration, one more for each assertion: the unlock was a real proof.
    assert.ok(creds[0]!.signCount >= 2, `an assertion was made after the registration (signCount ${creds[0]!.signCount})`)
    const [d] = (await devices()).filter((x) => x.state !== 'revoked')
    assert.equal(d!.biometrics, true)
  })

  test('4. a árvore da Regência aparece: as mesas e as guias que o app publicou, ao vivo, e o canal no centro', async () => {
    const tree = await text('.rg-tree')
    for (const name of ['Obra', 'Migração', 'conferente', 'web · npm run dev', 'migra', 'revisor']) assert.ok(tree.includes(name), `the tree shows ${name}: ${tree}`)
    assert.equal(await page.getAttribute('.rr', 'data-link'), 'live')
    assert.match(await text('.rr-where-t'), /ao vivo/)
    assert.ok(await page.isVisible(`.rg-conv[data-target="channel:${channelId}"]`), 'the channel in the list of channels')
    assert.match(await text('.rg-waiting'), /revisor/, 'who waits for the person')
    await eventually(async () => (await msgsHave(`linha ${pad(LINES)}`)) || undefined, 15_000, "the channel's newest page in the centre")
    await shot('4-arvore')
  })

  // The channel that calls her is not the one on screen: a device that converses marks seen what it shows (step 16).
  test('5. uma fala num canal faz a tela reler as marcas: "para você" e a conta de não lidas chegam sem recarregar', async () => {
    const conv = `.rg-conv[data-target="channel:${extraId}"]`
    assert.equal(await page.locator(`.rg-conv[data-target="channel:${channelId}"] .rg-tome`).count(), 0, "the person's own lines call nobody")
    await agent('say', { canal: extraId, text: 'Qual das duas telas de filtro fica?', to: ['usuário'] })
    await page.waitForSelector(`${conv} .rg-tome`, { timeout: 15_000 })
    assert.equal(await text(`${conv} .rg-mk .cnt`), '1', 'one line unread')
    await agent('say', { canal: channelId, text: 'Deixei as duas telas no #extra.' })
    await eventually(async () => (await msgsHave('Deixei as duas telas no')) || undefined, 15_000, 'the new line in the open channel')
    await shot('5-marcas')
  })

  test('6. app fechado: a tela diz "como estavam às HH:MM" e segue mostrando as mesas; o app abre e volta "ao vivo"', async () => {
    appCloses()
    lease.skewMs = STALE_MS + 5_000
    lease.expire?.()
    await page.waitForSelector('.rr[data-link="closed"] .rr-snap-l', { timeout: 15_000 })
    const hhmm = await page.evaluate((ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }, treeAt)
    assert.equal(await text('.rr-snap-l'), `O tether está fechado na máquina. As mesas são como estavam às ${hhmm}.`)
    assert.match(await text('.rr-where-t'), /app fechado na máquina/)
    assert.match(await text('.rg-tree'), /conferente/, 'the desks stay')
    await shot('6-app-fechado')
    lease.skewMs = 0
    await publish()
    appOpens()
    await page.waitForSelector('.rr[data-link="live"]', { timeout: 15_000 })
    assert.equal(await page.locator('.rr-snap').count(), 0, 'the band goes with the app open')
  })

  test('7. offline: com a máquina fora do alcance, só o aviso; nada da casa fica na tela; ela volta e a Regência também', async () => {
    await ext(app, 'remote.off')
    await page.waitForSelector('.rr[data-link="offline"] .rr-off', { timeout: 20_000 })
    assert.match(await text('.rr-off'), /Seu tether está offline/)
    assert.equal(await page.isVisible('.rr-stage'), false, 'the stage is hidden')
    assert.equal(await page.locator('.rg-tree, .ch-msgs, .rg-conv').count(), 0, 'nothing of the house is kept on the screen')
    assert.doesNotMatch(await text('#app'), /conferente|linha 0|revisor/)
    await shot('7-offline')
    assert.deepEqual(await remoteOn(), { on: true })
    await houseUp()
    // The portal came back without its memory of the unlock: the device is asked for presence again.
    await toRegency()
  })

  test('9. votar numa enquete: "não ok" vota na hora e pede a razão curta; a razão vai com o voto', async () => {
    await agent('poll', { canal: channelId, question: 'Subo a ata hoje?', to: ['usuário', 'auditor'] })
    const card = page.locator('.ch-poll[data-state="open"]', { hasText: 'Subo a ata hoje?' })
    await card.waitFor({ timeout: 15_000 })
    assert.equal(await card.locator('button.ch-opt').count(), 2, 'each option votes')
    assert.equal(await card.locator('.ch-pmore').count(), 1)
    await card.locator('button.ch-opt[data-n="2"]').click()
    await page.waitForSelector('.ch-reason .ch-pr-in', { timeout: 10_000 })
    await page.fill('.ch-reason .ch-pr-in', 'falta a revisão')
    await page.press('.ch-reason .ch-pr-in', 'Enter')
    const vote = await eventually(async () => {
      const h = await historyOf(channelId)
      const p = (h.polls as { open?: { question: string; votes: Record<string, { option: number; reason?: string }> } }[]).find((x) => x.open?.question === 'Subo a ata hoje?')
      const v = p?.open?.votes.user
      return v?.reason ? v : undefined
    }, 15_000, 'the vote with its reason in the house')
    assert.deepEqual([vote.option, vote.reason], [2, 'falta a revisão'])
    await eventually(async () => (await card.locator('button.ch-opt.mine[data-n="2"]').count()) === 1 || undefined, 10_000, 'the card says her vote')
    // Closing a poll early is managing the channel: not on this device.
    await card.locator('.ch-pmore').click()
    await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
    assert.doesNotMatch(await text('#ctx-menu'), /Encerrar/, 'no "Encerrar agora" from afar')
    await page.keyboard.press('Escape')
    await card.scrollIntoViewIfNeeded()
    await shot('9-enquete')
  })

  test('16. visto: abrir o canal que chama a pessoa marca o que ela viu, e as marcas mudam na casa e na tela', async () => {
    const conv = `.rg-conv[data-target="channel:${extraId}"]`
    const last = Number((await historyOf(extraId)).last)
    const seenOf = async (): Promise<number> => ((await ext(app, 'list', {}, 'channels')).channels as { id: string; seenByUser: number }[]).find((c) => c.id === extraId)!.seenByUser
    assert.ok((await seenOf()) < last, 'not seen before she looks')
    await page.click(conv)
    await eventually(async () => (await msgsHave('Qual das duas telas de filtro fica?')) || undefined, 15_000, 'the channel on screen')
    await eventually(async () => ((await seenOf()) >= last) || undefined, 15_000, 'the house holds it seen')
    await eventually(async () => ((await page.locator(`${conv} .rg-tome`).count()) === 0) || undefined, 15_000, 'the "para você" mark goes')
    await shot('16-visto')
    await page.click(`.rg-conv[data-target="channel:${channelId}"]`)
    await eventually(async () => (await msgsHave('Subo a ata hoje?')) || undefined, 15_000, 'back to the first channel')
  })

  test('13. falar pelo navegador a 390 px: "enviando" na hora, confirmada com o seq, e o canal a tem da moderadora, para quem o "@" disse', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector('.rr[data-tier="mobile"]', { timeout: 10_000 })
    await page.click('.rg-tab[data-tab="conversation"]')
    await page.waitForSelector('.ch-say textarea.ch-field', { timeout: 15_000 })
    // Every state the speech on its way goes through, as the page draws it.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __out: string[] }).__out = seen
      new MutationObserver(() => {
        for (const i of document.querySelectorAll<HTMLElement>('.rr-out-i')) { const s = i.dataset.state ?? ''; if (seen[seen.length - 1] !== s) seen.push(s) }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] })
    })
    const before = Number((await historyOf(channelId)).last)
    await page.click('.ch-field')
    await page.keyboard.type('@conf')
    await page.waitForSelector('.ch-mention-list:not([hidden])', { timeout: 5_000 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('Revisa a ata pelo celular?')
    await page.screenshot({ path: join(shots, 'rr4-13-caixa-390.png') })
    await page.click('.ch-send')
    const line = await eventually(async () => ((await historyOf(channelId)).lines as { seq: number; body: string; to?: string[]; from: { id: string; role: string } }[])
      .find((l) => l.seq > before && l.body.includes('Revisa a ata pelo celular?')), 15_000, 'the speech in the channel')
    saidSeq = line.seq
    assert.deepEqual([line.from.id, line.from.role, line.to, line.body], ['user', 'moderator', ['conferente'], '@conferente Revisa a ata pelo celular?'])
    await eventually(async () => ((await msgsHave('Revisa a ata pelo celular?')) && !(await page.isVisible('.rr-out-i'))) || undefined, 15_000, 'the line in the conversation, nothing on its way')
    const states = await page.evaluate(() => (window as unknown as { __out: string[] }).__out)
    assert.equal(states[0], 'sending', `shown at once as "enviando" (${states.join(' → ')})`)
    assert.equal(await page.inputValue('.ch-field'), '', 'the box emptied')
    assert.match((await page.textContent('.rr-out + .rr-sr')) ?? '', /Fala enviada/, 'said aloud once')
    await page.screenshot({ path: join(shots, 'rr4-13-enviada-390.png') })
  })

  test('14. reagir pelo "⋯" da fala (a folha do celular) e tirar a reação no próprio selo', async () => {
    const mine = page.locator(`.ch-msgs > .ch-msg[data-seq="${saidSeq}"]`)
    await mine.locator('.ch-msg-more').click()
    await page.waitForSelector('#ctx-menu[data-form="sheet"]', { timeout: 5_000 })
    assert.doesNotMatch(await text('#ctx-menu'), /Calar|Tirar|Encerrar/, 'nothing that manages')
    await page.screenshot({ path: join(shots, 'rr4-14-menu-390.png') })
    await page.locator('#ctx-menu .rr-mi', { hasText: '👍' }).click()
    const tallies = async (): Promise<{ emoji: string; by: { id: string }[] }[]> =>
      (((await historyOf(channelId)).reactions as { seq: number; tallies: { emoji: string; by: { id: string }[] }[] }[]).find((r) => r.seq === saidSeq)?.tallies) ?? []
    await eventually(async () => (await tallies()).some((t) => t.emoji === '👍' && t.by.some((b) => b.id === 'user')) || undefined, 15_000, 'the reaction in the house')
    await mine.locator('.ch-pill.mine').waitFor({ timeout: 10_000 })
    await mine.locator('.ch-pill.mine').click()
    await eventually(async () => ((await tallies()).length === 0) || undefined, 15_000, 'the reaction taken off')
  })

  test('15. abrir enquete pela caixa: o cartão aberto, da moderadora, chamando os membros', async () => {
    await page.click('.ch-pollbtn')
    await page.waitForSelector('.ch-pf:not([hidden]) .ch-pf-q', { timeout: 5_000 })
    await page.fill('.ch-pf-q', 'Subimos hoje à noite?')
    await page.click('.ch-pf-go')
    const line = await eventually(async () => ((await historyOf(channelId)).lines as { seq: number; kind: string; body: string; poll?: { question: string }; from: { role: string } }[])
      .find((l) => l.kind === 'poll' && (l.poll?.question ?? l.body).includes('Subimos hoje à noite?')), 15_000, 'the poll in the channel')
    assert.equal(line.from.role, 'moderator')
    const state = ((await historyOf(channelId)).polls as { seq: number; open?: { to: { id: string }[] } }[]).find((p) => p.seq === line.seq)
    assert.deepEqual(state?.open?.to.map((t) => t.id).sort(), [memberId, auditorId].sort())
    await page.locator('.ch-poll[data-state="open"]', { hasText: 'Subimos hoje à noite?' }).waitFor({ timeout: 15_000 })
  })

  test('17. anexos a 390 px: o clipe anexa uma imagem, a miniatura aparece, abre grande; e a imagem que um agente pôs no canal também', async () => {
    const errors = pageErrors.length
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector('.rr[data-tier="mobile"]', { timeout: 10_000 })
    await tap('.rg-tab[data-tab="conversation"]')
    await page.waitForSelector('.ch-say .ch-clip', { timeout: 15_000 })
    // The clip sits beside "Enquete" (the remote's box).
    assert.equal(await page.evaluate(() => document.querySelector('.ch-say .ch-clip')?.nextElementSibling?.classList.contains('ch-pollbtn')), true)
    const png = pngOf(96, 64, [40, 140, 220])
    const before = Number((await historyOf(channelId)).last)
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), page.click('.ch-say .ch-clip')])
    await chooser.setFiles({ name: 'obra-celular.png', mimeType: 'image/png', buffer: png })
    await page.waitForSelector('.ch-fchip .ch-fchip-th img[src^="blob:"]', { timeout: 10_000 })
    assert.match(await text('.ch-roomnote'), /Todos os membros do canal poderão ler/)
    await page.fill('.ch-field', 'Foto da obra, do celular.')
    await page.screenshot({ path: join(shots, 'rr4-17-anexo-390.png') })
    await page.click('.ch-send')
    const line = await eventually(async () => ((await historyOf(channelId)).lines as { seq: number; body: string; files?: { name: string; path: string }[] }[])
      .find((l) => l.seq > before && l.body.includes('Foto da obra, do celular.') && l.files?.length), 30_000, 'the speech with its file in the channel')
    assert.equal(line.files![0]!.name, 'obra-celular.png')
    assert.deepEqual(readFileSync(line.files![0]!.path), png, 'the same bytes in the channel folder')
    const thumb = `.ch-msgs > .ch-msg[data-seq="${line.seq}"] .ch-shot`
    await page.waitForSelector(`${thumb} img[src^="blob:"]`, { timeout: 20_000 })
    assert.match((await page.getAttribute(thumb, 'aria-label')) ?? '', /^obra-celular\.png, Imagem · /, 'named by the file')
    await page.locator(thumb).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'rr4-17-miniatura-390.png') })
    await page.click(thumb)
    await page.waitForSelector('.ch-viewer .ch-vimg[src^="blob:"]', { timeout: 10_000 })
    assert.equal(await page.getAttribute('.ch-viewer .ch-vimg', 'alt'), 'obra-celular.png')
    const box = (await page.locator('.ch-viewer').boundingBox())!
    assert.deepEqual([Math.round(box.width), Math.round(box.height)], [390, 844], 'the whole screen on a phone')
    const close = (await page.locator('.ch-viewer .ch-vclose').boundingBox())!
    assert.ok(close.width >= 44 && close.height >= 44, `close ${close.width}x${close.height}`)
    assert.equal(await page.isVisible('.ch-viewer .ch-vmenu'), false, 'no file menu from afar')
    await page.screenshot({ path: join(shots, 'rr4-17-grande-390.png') })
    await page.click('.ch-viewer .ch-vclose')
    await page.waitForSelector('.ch-viewer', { state: 'detached', timeout: 5_000 })
    // An image an agent put in the channel: it comes the same way, by its line.
    const agentPng = join(home, 'planta-do-agente.png')
    writeFileSync(agentPng, pngOf(80, 120, [220, 120, 40]))
    const put = await agent('say', { canal: channelId, text: 'A planta, do agente.', files: [agentPng] })
    const agentSeq = (put.data as { seq: number }).seq
    const theirs = `.ch-msgs > .ch-msg[data-seq="${agentSeq}"] .ch-shot`
    await page.waitForSelector(`${theirs} img[src^="blob:"]`, { timeout: 20_000 })
    await page.click(theirs)
    await page.waitForSelector('.ch-viewer .ch-vimg[src^="blob:"]', { timeout: 10_000 })
    assert.equal(await page.getAttribute('.ch-viewer .ch-vimg', 'alt'), 'planta-do-agente.png')
    await page.screenshot({ path: join(shots, 'rr4-17-agente-grande-390.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.ch-viewer', { state: 'detached', timeout: 5_000 })
    assert.deepEqual(pageErrors.slice(errors), [], 'no error on the page')
  })

  test('capturas: a caixa de fala e um cartão de enquete nos quatro tamanhos', async () => {
    for (const [w, h, tier] of [[390, 844, 'mobile'], [1024, 768, 'tablet'], [1440, 900, 'desktop'], [2560, 1440, 'wide']] as const) {
      await page.setViewportSize({ width: w, height: h })
      await page.waitForSelector(`.rr[data-tier="${tier}"]`, { timeout: 10_000 })
      if (tier === 'mobile') await tap('.rg-tab[data-tab="conversation"]')
      await page.waitForSelector('.ch-say textarea.ch-field', { timeout: 10_000 })
      await page.fill('.ch-field', 'Combinado: subimos às 21h.')
      await page.locator('.ch-poll[data-state="open"]', { hasText: 'Subimos hoje à noite?' }).scrollIntoViewIfNeeded()
      await sleep(400)
      await page.screenshot({ path: join(shots, `rr4-${w}.png`) })
    }
    await page.fill('.ch-field', '')
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test('10. paginar o histórico do canal: subindo, as páginas anteriores chegam até a primeira fala', async () => {
    assert.equal(await msgsHave('linha 001'), false, 'the first line is not on the newest page')
    await eventually(async () => {
      if (await msgsHave('linha 001')) return true
      await page.evaluate(() => {
        const m = document.querySelector<HTMLElement>('.ch-msgs')
        if (m) { m.scrollTop = 0; m.dispatchEvent(new Event('scroll')) }
      })
      if (await page.isVisible('.ch-older')) await tap('.ch-older')
      return undefined
    }, 30_000, 'the first line of the channel, by paging back').catch(async (e: Error) => {
      const state = await page.evaluate((n) => {
        const m = document.querySelector<HTMLElement>('.ch-msgs')
        const rows = [...document.querySelectorAll<HTMLElement>('.ch-msgs [data-seq]')]
        const seqs = rows.map((r) => Number(r.dataset.seq))
        const all = m?.textContent ?? ''
        const missing = Array.from({ length: n },(_, i) => `linha ${String(i + 1).padStart(3, '0')}`).filter((l) => !all.includes(l))
        return { firsts: rows.slice(0, 6).map((r) => `${r.className}#${r.dataset.seq}:${(r.textContent ?? '').slice(0, 50)}`), missing, rows: seqs.length, min: Math.min(...seqs), max: Math.max(...seqs), scrollTop: m?.scrollTop, scrollHeight: m?.scrollHeight, clientHeight: m?.clientHeight, older: document.querySelector('.ch-older') !== null, view: document.getElementById('app')?.dataset.view, link: document.querySelector<HTMLElement>('.rr')?.dataset.link }
      }, LINES)
      throw new Error(`${e.message}; the view: ${JSON.stringify(state)}; errors: ${JSON.stringify(pageErrors)}`)
    })
    const all = await page.evaluate(() => document.querySelector('.ch-msgs')?.textContent ?? '')
    const missing = Array.from({ length: LINES }, (_, i) => `linha ${pad(i + 1)}`).filter((l) => !all.includes(l))
    assert.deepEqual(missing, [], 'every line of the channel, no hole between the pages')
    await shot('10-paginas')
  })

  test('11. trancar: a máquina tranca o aparelho (o portal recomeça sem o destrancado); a tela vira "Trancado", sem nada da casa, e Destrancar devolve', async () => {
    const signs = (await credentials())[0]!.signCount
    await ext(app, 'remote.off')
    assert.deepEqual(await remoteOn(), { on: true })
    await houseUp()
    await eventually(async () => {
      if (await page.isVisible('.rr-off .rr-btn')) await tap('.rr-off .rr-btn')
      return (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) || undefined
    }, 40_000, 'the unlock panel')
    assert.match(await text('[data-panel="lock"]'), /Trancado/)
    assert.equal(await page.locator('.rr, .rg-tree, .ch-msgs').count(), 0, 'nothing of the house while locked')
    await shot('11-trancado')
    await page.click('#unlock')
    await toRegency()
    assert.ok((await credentials())[0]!.signCount > signs, 'the unlock was a new proof')
  })

  test('11b. trancar pelo aparelho: "Trancar" na faixa tranca a sessão; destrancada, o que esperava para ser dito vai, uma vez', async () => {
    const signs = (await credentials())[0]!.signCount
    await page.click('.rr-top .rr-lock')
    await page.waitForSelector('[data-panel="lock"] #unlock:not([disabled])', { timeout: 15_000 })
    assert.match(await text('[data-panel="lock"]'), /Trancado/)
    assert.equal(await page.locator('.rr, .rg-tree, .ch-msgs').count(), 0, 'nothing of the house while locked')
    await page.screenshot({ path: join(shots, 'rr4-11b-trancado.png') })
    // A speech that was waiting for the session (as one cut on its way is): the outbox of this origin holds it.
    const put = await page.evaluate((channel) => {
      const key = Object.keys(localStorage).find((k) => /^tether\.remote\.v1\.[0-9a-f]+\.outbox$/.test(k))
      if (!key) return false
      const box = JSON.parse(localStorage.getItem(key) ?? '{"v":1,"items":[]}') as { v: 1; items: unknown[] }
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
      box.items.push({ id, channel, text: 'Esperou o destrancar.', to: [], at: Date.now(), state: 'sending' })
      localStorage.setItem(key, JSON.stringify(box))
      return true
    }, channelId)
    assert.ok(put, 'the outbox of this device is in its storage')
    await page.click('#unlock')
    await toRegency()
    assert.ok((await credentials())[0]!.signCount > signs, 'the unlock was a new proof')
    const said = async (): Promise<number> => ((await historyOf(channelId)).lines as { body: string }[]).filter((l) => l.body === 'Esperou o destrancar.').length
    await eventually(async () => ((await said()) === 1) || undefined, 15_000, 'what waited, said once unlocked')
    await sleep(1_500)
    assert.equal(await said(), 1, 'said once')
  })

  // What this step does NOT prove: a real push service (the bench's Electron has none), a notice delivered, the service
  // worker showing it on a locked screen, nor its tap. Those are the unit tests' (remote.webpush, remote.web-push) and
  // remote.talk's (the portal's POST, the cipher and VAPID against a fake push service).
  test('18. avisos neste aparelho, num navegador sem serviço de push: o item junto do "Trancar"; o toque pede a permissão (o diálogo do navegador simulado); o navegador não assina e a tela diz que não ligou; uma assinatura injetada vai da página ao portal e desligar a tira', async () => {
    await toRegency()
    await page.waitForSelector('.rr-top .rr-push', { timeout: 10_000 })
    assert.ok(await page.evaluate(() => document.querySelector('.rr-top .rr-push')?.nextElementSibling?.nextElementSibling?.classList.contains('rr-lock') === true), 'beside "Trancar"')
    const pushOf = (): { endpoint: string } | undefined => {
      const reg = JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as { devices: { state: string; push?: { endpoint: string } }[] }
      return reg.devices.find((d) => d.state === 'active' && d.push)?.push
    }
    const settled = async (): Promise<string> => eventually(async () => {
      const s = await page.getAttribute('.rr-top .rr-push', 'data-state')
      return s && s !== 'busy' ? s : undefined
    }, 20_000, 'the item settled')
    const card = async (): Promise<string> => {
      await page.click('.rr-top .rr-push')
      await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
      return text('#ctx-menu')
    }
    // The card says what the notices are, where they are now, and offers the one gesture.
    const words = await card()
    assert.match(words, /Avisos neste aparelho/)
    assert.match(words, /Avisa quando um agente espera você ou quando falam com você num canal\./)
    assert.match(words, /Desligados\./)
    await page.screenshot({ path: join(shots, 'rr4-44-avisos-cartao.png') })
    // The bench's browser grants notifications by itself and never shows a dialog, so the page's ask is watched through a
    // stand-in for that dialog: the permission reads "default" until the page asks, and the ask grants it.
    await page.evaluate(() => {
      const w = window as unknown as { __asked: number }
      w.__asked = 0
      let perm: NotificationPermission = 'default'
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => perm })
      Notification.requestPermission = async () => { w.__asked++; perm = 'granted'; return perm }
    })
    // The tap: the permission is asked there, then the browser is asked to subscribe.
    await page.click('#ctx-menu button.rr-mi')
    const first = await settled()
    assert.deepEqual(await page.evaluate(() => [(window as unknown as { __asked: number }).__asked, Notification.permission]), [1, 'granted'], 'asked once, on the tap')
    if (first === 'on') {
      // A browser with a push service: its endpoint is one of the list (and on the bench no notice is ever sent to it).
      assert.match(pushOf()!.endpoint, /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.push\.apple\.com|[\w.-]+\.notify\.windows\.com)\//)
    } else {
      // Why it did not turn on, asked of the browser itself (the service worker is up; any key will do): it has no push
      // service. The item says it did not turn on and offers the tap again; nothing reached the house.
      const refusal = await page.evaluate(async () => {
        const within = <T,>(p: Promise<T>, what: string): Promise<T> => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what}: no answer in 8 s`)), 8_000))])
        try {
          const reg = await within(navigator.serviceWorker.ready, 'serviceWorker.ready')
          const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
          const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
          await within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }), 'pushManager.subscribe')
          return 'subscribed'
        } catch (e) { return `${(e as Error).name}: ${(e as Error).message}` }
      })
      // Electron answers "AbortError: Registration failed - push service not available". A timeout here would be a bench
      // with no service worker, which proves nothing about the browser.
      assert.notEqual(refusal, 'subscribed', 'the bench\'s browser has no push service')
      assert.doesNotMatch(refusal, /no answer in 8 s/, `the service worker is up and the browser itself refused: ${refusal}`)
      assert.equal(first, 'failed', `the item after the browser refused (${refusal}): ${first}`)
      const said = await card()
      assert.match(said, /Não consegui ligar agora\. Tente de novo\./, `the honest state (${refusal})`)
      assert.match(said, /Ligar avisos/)
      await page.screenshot({ path: join(shots, 'rr4-44-avisos-sem-servico.png') })
      await page.keyboard.press('Escape')
      assert.equal(pushOf(), undefined)
      // From here the page's own path to the portal, with a subscription the bench puts in the page in PushManager's
      // place, as a browser with a push service would give it.
      await page.evaluate(async (endpoint: string) => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
        const auth = crypto.getRandomValues(new Uint8Array(16))
        const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        let current: unknown = null
        const proto = PushManager.prototype as unknown as Record<string, unknown>
        proto.getSubscription = async () => current
        proto.subscribe = async (o: { applicationServerKey: Uint8Array }) => {
          const k = o.applicationServerKey
          current = {
            endpoint, options: { applicationServerKey: k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength) },
            toJSON: () => ({ endpoint, keys: { p256dh: b64(raw), auth: b64(auth) } }),
            unsubscribe: async () => { current = null; return true },
          }
          return current
        }
      }, `${pushOrigin}/push/web`)
      await card()
      await page.click('#ctx-menu button.rr-mi')
      const second = await settled()
      assert.equal(second, 'on', `the item with the injected subscription: ${second}, "${await text('.rr-top .rr-push')}"`)
      assert.equal(pushOf()?.endpoint, `${pushOrigin}/push/web`, 'the subscription reached the portal and the registry')
    }
    assert.match(await card(), /Ligados\./)
    await page.screenshot({ path: join(shots, 'rr4-44-avisos-ligados.png') })
    // Off: the house forgets it.
    await page.click('#ctx-menu button.rr-mi')
    assert.equal(await settled(), 'off')
    await eventually(async () => pushOf() === undefined || undefined, 10_000, 'the registry forgot the subscription')
    const audit = readFileSync(join(home, 'remote', 'audit.jsonl'), 'utf8')
    assert.match(audit, /"act":"attention\.push-on"[^\n]*"result":"ok"/)
    assert.match(audit, /"act":"attention\.push-off"[^\n]*"result":"ok"/)
    assert.equal(audit.includes('/push/web'), false, 'no endpoint in the audit')
    // The phone: the card is a sheet from the bottom.
    await page.setViewportSize({ width: 390, height: 844 })
    await sleep(300)
    await card()
    assert.equal(await page.getAttribute('#ctx-menu', 'data-form'), 'sheet')
    await page.screenshot({ path: join(shots, 'rr4-44-avisos-390.png') })
    await page.keyboard.press('Escape')
    // The TV: nothing to tap, it only says so.
    await page.setViewportSize({ width: 2560, height: 1440 })
    await sleep(300)
    assert.equal(await page.isVisible('.rr-top .rr-push'), false)
    assert.match(await text('.rr-top .rr-push-na'), /não disponível aqui/)
    await page.setViewportSize({ width: 1440, height: 900 })
    await sleep(300)
  })

  test('12. rajada de eventos não quebra a tela: falas, uma enquete e árvores em sequência rápida, e a tela chega ao último estado', async () => {
    const errors = pageErrors.length
    const N = 60
    const burst: Promise<unknown>[] = []
    for (let i = 1; i <= N; i++) {
      burst.push(i % 2 === 0
        ? agent('say', { canal: channelId, text: `rajada ${pad(i)}` })
        : ext(app, 'say', { channel: channelId, text: `rajada ${pad(i)}` }, 'channels'))
      if (i % 10 === 0) burst.push(publish({ conferente: `conferente · passo ${i / 10}` }))
    }
    await Promise.all(burst)
    await eventually(async () => (await msgsHave(`rajada ${pad(N)}`) && (await text('.rg-tree')).includes(`passo ${N / 10}`)) || undefined, 60_000, 'the last line and the last tree')
    assert.equal(await page.getAttribute('#app', 'data-view'), 'regency')
    assert.equal(await page.getAttribute('.rr', 'data-link'), 'live', 'the session stood (no limit closed it)')
    assert.deepEqual(pageErrors.slice(errors), [], 'no error in the page')
    await shot('12-rajada')
    // More than a page came at once: the view holds the newest page (mergeNewest) and the rest is a scroll up away.
    await eventually(async () => {
      if (await msgsHave('rajada 001')) return true
      await page.evaluate(() => {
        const m = document.querySelector<HTMLElement>('.ch-msgs')
        if (m) { m.scrollTop = 0; m.dispatchEvent(new Event('scroll')) }
      })
      return undefined
    }, 30_000, 'the first line of the burst, by paging back')
    const all = await page.evaluate(() => document.querySelector('.ch-msgs')?.textContent ?? '')
    const missing = Array.from({ length: N }, (_, i) => `rajada ${pad(i + 1)}`).filter((l) => !all.includes(l))
    assert.deepEqual(missing, [], 'every line of the burst, no hole between the pages')
  })

  test('duas abas: a segunda diz que a Regência está aberta em outra janela, "Usar aqui" toma, fechar a dona faz a outra assumir', async () => {
    const ctx = page.context()
    const opened = ctx.waitForEvent('page', { timeout: 20_000 })
    await page.evaluate((u) => { window.open(u, '_blank') }, pageUrl)
    const page2 = await opened
    page2.on('pageerror', (e) => pageErrors.push(`[2] ${String(e)}`))
    // The second window's platform authenticator holds the same credential (one phone, one fingerprint).
    const cdp2 = await ctx.newCDPSession(page2)
    await cdp2.send('WebAuthn.enable', { enableUI: false })
    const a2 = ((await cdp2.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })) as { authenticatorId: string }).authenticatorId
    for (const c of await credentials()) await cdp2.send('WebAuthn.addCredential', { authenticatorId: a2, credential: c as never })
    await cdp2.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page2.setViewportSize({ width: 1440, height: 900 })
    await page2.waitForSelector('#app[data-view="elsewhere"]', { timeout: 20_000 })
    assert.match((await page2.textContent('#app')) ?? '', /A Regência está aberta em outra janela/)
    assert.equal(await page.getAttribute('#app', 'data-view'), 'regency', 'the first window keeps it meanwhile')
    await page2.screenshot({ path: join(shots, 'rr4-abas-outra-janela.png') })
    await page2.click('#app .btn')
    await page.waitForSelector('#app[data-view="elsewhere"]', { timeout: 20_000 })
    await eventually(async () => {
      if (await page2.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await page2.click('#unlock', { timeout: 1_500 }).catch(() => undefined)
      return (await page2.isVisible('.rr[data-link="live"] .rg-tree [data-key]')) || undefined
    }, 45_000, 'the Regency in the second window')
    // One authenticator per window, one credential: the first goes on from the count the second reached.
    const [c2] = ((await cdp2.send('WebAuthn.getCredentials', { authenticatorId: a2 })) as { credentials: VirtualCredential[] }).credentials
    await page2.close()
    const [c1] = await credentials()
    if (c1 && c2 && c2.signCount > c1.signCount) {
      await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: c1.credentialId })
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { ...c1, signCount: c2.signCount } as never })
    }
    await toRegency()
    assert.equal(await page.getAttribute('#app', 'data-view'), 'regency', 'closing the owner gave it back')
  })

  const tv = (name: string): Promise<Buffer> => page.screenshot({ path: join(tvShots, name) })
  /** The first key the walk would give on the TV (focus-rules.ts initialKeyOf): who waits, else the first channel. */
  const firstOfTv = (): Promise<string | undefined> => page.evaluate(() => {
    const e = document.querySelector<HTMLElement>('.rg-waiting [data-target]') ?? document.querySelector<HTMLElement>('.rg-convs .rg-conv[data-target]')
    return e?.dataset.target
  })
  let firstHeld: Held | undefined

  // The first paint (before the house is read) has only the chips; the walk decides the first focus when the content arrives
  // (focus-rules.ts firstFocusOf), so the TV opens on who waits and not on "Todos".
  test('TV (2560) 2. foco inicial ao abrir: quem espera a pessoa segura o teclado', async () => {
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.reload()
    await toRegency()
    await page.waitForSelector('.rr[data-tier="wide"][data-keys="on"]', { timeout: 10_000 })
    firstHeld = await eventually(held, 10_000, 'the first focus on the TV')
    await sleep(300)
    await tv('2-foco-inicial.png')
    const want = await firstOfTv()
    assert.equal(firstHeld.key, want, `the TV opens on who waits (${want}); it opened on ${firstHeld.key}`)
  })

  test('TV (2560) 1, 3, 4 e 5: o anel de foco, a faixa de teclas, as setas entre colunas e o foco que fica quando a árvore muda', async () => {
    assert.ok(firstHeld, 'the TV is open')
    // The ring follows the arrows.
    await page.keyboard.press('ArrowDown')
    const ring = await eventually(held, 5_000, 'the focus after an arrow')
    assert.notEqual(ring.key, firstHeld.key, 'the arrow moved the focus')
    assert.ok(ring.ring, `the ring is drawn on ${ring.key}`)
    await tv('1-anel-de-foco.png')
    // The strip of the remote's keys, on top.
    assert.ok(await page.isVisible('.rr-keys'), 'the strip of keys shows on the TV')
    await page.locator('.rr-top').screenshot({ path: join(tvShots, '3-faixa-de-teclas.png') })
    // From the left column into the conversation (its speeches, its box: the TV converses too), and on into the desks.
    let at = ring
    for (let i = 0; i < 6 && !at.inLeft; i++) {
      await page.keyboard.press('ArrowLeft')
      at = await eventually(held, 5_000, 'the focus after ArrowLeft')
    }
    assert.ok(at.inLeft, `the arrows reach the left column (${at.key})`)
    const from = at
    await page.keyboard.press('ArrowRight')
    at = await eventually(held, 5_000, 'the focus after ArrowRight')
    assert.ok(at.inCenter && at.left > from.right, `one ArrowRight crossed from ${from.key} into the conversation (${at.key})`)
    assert.ok(at.ring, `the ring is drawn on ${at.key}`)
    await tv('6-setas-na-conversa.png')
    const mid = at
    await page.keyboard.press('ArrowRight')
    at = await eventually(held, 5_000, 'the focus after ArrowRight')
    assert.ok(at.inRight && at.left > mid.right, `the next ArrowRight crossed from ${mid.key} into the desks' column (${at.key})`)
    assert.ok(at.ring)
    await tv('5-setas-entre-colunas.png')
    // Down into the desks' rows.
    for (let i = 0; i < 8 && !at.inTree; i++) {
      await page.keyboard.press('ArrowDown')
      at = await eventually(held, 5_000, 'the focus after ArrowDown')
    }
    assert.ok(at.inTree, `the arrows reach a desk's row (${at.key})`)
    // The tree changes in the house (another pane's title): the focus stays on its row.
    await publish({ revisor: 'revisor · olhando a migração' })
    await eventually(async () => (await text('.rg-tree')).includes('olhando a migração') || undefined, 15_000, 'the new tree')
    await sleep(300)
    const kept = await eventually(held, 5_000, 'the focus after the tree changed')
    assert.equal(kept.key, at.key, 'the focus is held by the row, not by its node')
    assert.ok(kept.ring)
    await tv('4-foco-apos-mudanca.png')
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  // Last, because nothing after it could read: the device's scopes live in the machine's registry only, so the bench stops
  // tetherd, narrows them there and starts it again (the portal is born with the registry it is given).
  test('8. sem escopo: a tela diz que este aparelho não pode ver a Regência nem ler os canais, e não mostra nada deles', async () => {
    await stopHouse()
    const file = join(home, 'remote', 'devices.json')
    const reg = JSON.parse(readFileSync(file, 'utf8')) as { devices: { state: string; scopes: string[] }[] }
    for (const d of reg.devices) if (d.state !== 'revoked') d.scopes = d.scopes.filter((s) => s !== 'regency:read' && s !== 'channels')
    writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`)
    await startHouse()
    assert.deepEqual(await remoteOn(), { on: true })
    await houseUp()
    // The app is open and publishing: the tree is there; this device may not see it.
    await publish()
    appOpens()
    await eventually(async () => {
      if (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await tap('#unlock')
      else if (await page.isVisible('.rr-off .rr-btn')) await tap('.rr-off .rr-btn')
      const why = await page.isVisible('.rr-why') ? await text('.rr-why') : ''
      return (/ver a Regência/.test(why) && /ler os canais/.test(why)) || undefined
    }, 45_000, 'the lines that say why')
    const why = await text('.rr-why')
    assert.match(why, /As mesas não aparecem: este aparelho não tem permissão para ver a Regência\./)
    assert.match(why, /Os canais não aparecem: este aparelho não tem permissão para ler os canais\./)
    assert.equal(await page.locator('.rg-conv, .ch-msgs').count(), 0, 'no channel, no page')
    assert.doesNotMatch(await text('.rr'), /conferente|revisor|Obra|linha 0|rajada/, 'nothing of the desks or the channels')
    await shot('8-sem-escopo')
  })
})
