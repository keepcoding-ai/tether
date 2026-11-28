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
// RR5 5.4, she manages from afar (the protected device, every manage:* scope): at 390 px she hibernates and wakes a desk by
// its row's sheet (the app's question when an agent works there), renames a desk in its row, stops a process an agent uses
// (the board "em uso", then the force with a reason), closes a pane with the proof of that act, and with the app closed the
// act says "O tether não está aberto na máquina"; at 1440 the menu opens at the right click and Esc gives the row the keyboard
// back; at 2560 OK opens it and the arrows walk it. The bench's app does the app's half of each act (it claims, changes its
// desks, sends its map and tree, answers); a process host of the bench in this process serves "Sistema".
// RR5 (fio-spec 18), the rest of managing from afar: at 390 px a terminal made in a desk by the "+ Novo" card (what › where ›
// details, the new row when the tree comes), a channel made by the card and agents called into it, a channel closed with the
// proof of the act, "Novo processo" with a common variable (and its value nowhere in the page) and a secret-looking name
// barred before anything goes; at 1440 muting and giving the voice back, and a poll closed on its card; at 2560 "+ Novo" by
// the arrows and OK.
// Captures go to REMOTE_SHOTS_DIR (else test/e2e/artifacts): rr3-live-*.png and rr4-*.png, the TV's under rr3-tv/, RR5's under rr5/.
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
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { hostStore } from '../../src/procd/run-store.ts'
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
  const hostPipe = uniquePipe(home)
  const procHome = join(home, 'procd')
  /** A process of the bench an agent declares it uses (RR5 5.4: stop it from afar, over the board "em uso"). */
  const PROC = 'bench-web'
  let procHost: ProcHost | undefined
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
    // The processes' host of the bench (RR5 5.4: "Sistema" from afar), in this process, with a home of its own.
    // No terminal-pane host on the bench: a terminal made from afar ("+ Novo", RR5) runs in tetherd itself, as in remote.manage.
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door: d, log: (m) => logs.push(m), panelHost: false, connectProcHost: () => HostClient.open(hostPipe, 5_000, { home: procHome }) })
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
  /** What the bench's app changed by the acts asked from afar (RR5 5.4): the desks' names, the hibernating ones, the closed panes. */
  const desksNow = {
    names: { 'desk-obra': 'Obra', 'desk-migr': 'Migração' } as Record<string, string>, asleep: new Set<string>(), gone: new Set<string>(),
    /** Panes born from afar ("+ Novo", RR5) that the bench's app placed, as the app places a new slot's pane in its desk. */
    born: [] as { deskId: string; id: string; title: string }[],
  }
  const treeOf = (o: { conferente?: string; revisor?: string } = {}): Record<string, unknown> => ({
    desks: {
      desks: [
        {
          id: 'desk-obra', name: desksNow.names['desk-obra'], color: 'blue', kind: 'queue', asleep: desksNow.asleep.has('desk-obra'), panes: [
            { id: memberId, type: 'terminal', icon: 'sparkle', title: o.conferente ?? 'conferente', busy: true, lines: ['Revisando a tela de filtro'] },
            { id: 'p-web', type: 'terminal', icon: 'terminal-window', title: 'web · npm run dev' },
            ...desksNow.born.filter((b) => b.deskId === 'desk-obra').map((b) => ({ id: b.id, type: 'terminal', icon: 'terminal-window', title: b.title })),
          ].filter((p) => !desksNow.gone.has(p.id)),
        },
        {
          id: 'desk-migr', name: desksNow.names['desk-migr'], color: 'green', kind: 'queue', asleep: desksNow.asleep.has('desk-migr'), panes: [
            { id: 'p-migra', type: 'terminal', icon: 'ghost', title: 'migra', busy: true },
            { id: 'p-revisor', type: 'terminal', icon: 'sparkle', title: o.revisor ?? 'revisor', attention: 'waiting', lines: ['Esperando você'] },
          ].filter((p) => !desksNow.gone.has(p.id)),
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

    mkdirSync(procHome, { recursive: true })
    procHost = new ProcHost({ home: procHome, pipe: hostPipe, store: hostStore })
    await procHost.listen()
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
    try { await cli.request({ t: 'proc-stop', name: PROC, force: 'fim da bancada' }) } catch { /* gone, or never started */ }
    // What the RR5 steps made from afar, should a step have stopped before its own clean-up.
    try { await cli.request({ t: 'proc-stop', name: 'bench-novo', force: 'fim da bancada' } as never) } catch { /* gone, or never made */ }
    for (const b of desksNow.born) await cli.request({ t: 'stop', slotId: b.id }).catch(() => undefined)
    await stopHouse().catch(() => undefined)
    await procHost?.close().catch(() => undefined)
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
    // Closing a poll early is managing the channel: since RR5 a device with the channels' scope has it (step "RR5 canal 4").
    await card.locator('.ch-pmore').click()
    await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
    assert.match(await text('#ctx-menu'), /Encerrar agora…/, '"Encerrar agora…" from afar (RR5)')
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

  // ---- RR5 5.4: managing from afar, on the protected device ----------------------------------------------------------
  // The bench's app does the app's half of each act (extensions/regency/renderer/remote-acts.ts in the real app): it claims
  // the act (`act.take`), changes its desks, sends tetherd its desk map and the tree again, and answers (`act.done`).
  const rr5 = join(shots, 'rr5')
  const rr5shot = async (name: string): Promise<void> => { await page.screenshot({ path: join(rr5, `${name}.png`) }) }
  const appActs: Record<string, unknown>[] = []
  const deskMapOf = (): Record<string, unknown> => {
    const t = treeOf() as { desks: { desks: { id: string; name: string; asleep: boolean; panes: { id: string; type: string }[] }[] } }
    return { desks: t.desks.desks.map((d) => ({ id: d.id, name: d.name, kind: 'queue', ...(d.asleep ? { asleep: true } : {}), panes: d.panes.map((p) => ({ id: p.id, type: p.type })) })), drawer: [] }
  }
  const sendMap = async (): Promise<void> => { await app.request({ t: 'desk-map', map: deskMapOf() } as never) }
  const onAppAct = (e: { ext: string; name: string; payload?: unknown }): void => {
    if (e.ext !== 'regency' || e.name !== 'act') return
    const { ask, act } = e.payload as { ask: string; act: Record<string, unknown> }
    void (async () => {
      await ext(app, 'act.take', { ask }, 'regency')
      appActs.push(act)
      let answer: Record<string, unknown> = { ask, ok: true, state: 'done' }
      const deskId = String(act.deskId)
      switch (act.act) {
        case 'desks.hibernate': desksNow.asleep.add(deskId); break
        case 'desks.wake': desksNow.asleep.delete(deskId); break
        case 'desks.rename': desksNow.names[deskId] = String(act.name); break
        case 'panes.close': desksNow.gone.add(String(act.paneId)); break
        // "+ Novo" › Mesa from afar (RR5): the app makes the desk at the end of the queue and says its id.
        case 'desks.create': answer = { ask, ok: true, state: 'done', deskId: 'desk-longe' }; break
        default: answer = { ask, ok: false, code: 'refused' }
      }
      await sendMap()
      await publish()
      await ext(app, 'act.done', answer, 'regency')
    })().catch((err: unknown) => logs.push(`bench app act: ${String(err)}`))
  }
  const deskRow = (id: string): string => `.rg-tree [data-target="desk:${id}"]`
  /** The row's "⋯" (the phone has it always in view): its menu, a sheet from the bottom. */
  const rowMenu = async (row: string): Promise<void> => {
    await page.click(`${row} [data-action="row-menu"]`, { timeout: 5_000 })
    await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
  }
  /**
   * Each step starts at its own place, whatever the one before left: no menu nor question open, "Sistema" closed, and on the
   * phone the "Mesas" tab.
   */
  const toTree = async (): Promise<void> => {
    for (let i = 0; i < 3 && (await page.locator('#ctx-menu, .rr-ask').count()) > 0; i++) { await page.keyboard.press('Escape'); await sleep(150) }
    if (await page.isVisible('.rg-sys-back')) await page.click('.rg-sys-back')
    if (await page.isVisible('.rg-tab[data-tab="tether"]')) await page.click('.rg-tab[data-tab="tether"]')
    await page.waitForSelector('.rg-tree [data-key]', { state: 'visible', timeout: 10_000 })
  }
  const menuRow = (label: string): Promise<void> => page.locator('#ctx-menu .rr-mi', { hasText: label }).first().click({ timeout: 5_000 })
  const notice = (): Promise<string> => page.evaluate(() => document.querySelector('.rg-toast:not([hidden]) .rg-toast-t')?.textContent ?? '')

  test('RR5 gerir 1. a 390: hibernar e despertar uma mesa pela gaveta (a pergunta do app quando um agente trabalha)', async () => {
    mkdirSync(rr5, { recursive: true })
    app.on('ext-event', onAppAct)
    await sendMap()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector('.rr[data-tier="mobile"]', { timeout: 10_000 })
    // The device's scopes came (`session.info`): the pane manages, the row's "⋯" shows.
    await page.waitForSelector('.rr[data-manage~="desks"] .rg:not([data-readonly])', { timeout: 15_000 })
    await page.click('.rg-tab[data-tab="tether"]')
    await rowMenu(deskRow('desk-migr'))
    assert.equal(await page.getAttribute('#ctx-menu', 'data-form'), 'sheet', 'a sheet from the bottom on the phone')
    const items = await page.locator('#ctx-menu .rr-mi').evaluateAll((bs) => bs.map((b) => ({ t: b.textContent ?? '', h: b.getBoundingClientRect().height })))
    assert.ok(items.some((i) => i.t.includes('Hibernar mesa')), JSON.stringify(items))
    assert.ok(!items.some((i) => i.t.includes('Despertar mesa')), 'an awake desk offers "Hibernar mesa" only')
    assert.ok(items.every((i) => i.h >= 44), `targets of 44 px: ${JSON.stringify(items)}`)
    await rr5shot('390-gaveta-mesa')
    await menuRow('Hibernar mesa')
    // migra works on that desk: the app's question first.
    await page.waitForSelector('.rr-ask[data-form="sheet"]', { timeout: 5_000 })
    assert.match(await text('.rr-ask'), /Um agente da mesa "Migração" está trabalhando/)
    await rr5shot('390-pergunta-hibernar')
    await page.click('.rr-ask [data-choice="hibernate"]')
    await eventually(async () => (await text(deskRow('desk-migr'))).includes('hibernando') || undefined, 15_000, 'the desk hibernating in the tree')
    assert.ok(appActs.some((a) => a.act === 'desks.hibernate' && a.deskId === 'desk-migr'), JSON.stringify(appActs))
    await eventually(async () => /hibernando/.test(await notice()) || undefined, 5_000, 'the result said')
    await rr5shot('390-hibernando')
    await rowMenu(deskRow('desk-migr'))
    const again = await text('#ctx-menu')
    assert.match(again, /Despertar mesa/, 'a hibernating desk offers "Despertar mesa"')
    assert.doesNotMatch(again, /Hibernar mesa/)
    await menuRow('Despertar mesa')
    await eventually(async () => !(await text(deskRow('desk-migr'))).includes('hibernando') || undefined, 15_000, 'the desk awake again')
    assert.ok(appActs.some((a) => a.act === 'desks.wake' && a.deskId === 'desk-migr'))
  })

  test('RR5 gerir 2. a 390: renomear a mesa na própria linha', async () => {
    await toTree()
    await rowMenu(deskRow('desk-obra'))
    await menuRow('Renomear')
    await page.waitForSelector('.rg-rename', { timeout: 5_000 })
    await page.fill('.rg-rename', 'Obra nova')
    await rr5shot('390-renomear')
    await page.press('.rg-rename', 'Enter')
    await eventually(async () => (await text(deskRow('desk-obra'))).includes('Obra nova') || undefined, 15_000, 'the new name in the tree')
    assert.ok(appActs.some((a) => a.act === 'desks.rename' && a.name === 'Obra nova'))
  })

  test('RR5 gerir 3. a 390: parar um processo que um agente usa: o quadro "em uso" (quem, até quando, para quê), então forçar com o motivo', async () => {
    const recipe = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home }
    assert.equal((await cli.request({ t: 'proc-start', name: PROC, recipe } as never)).proc!.status, 'running')
    await cli.request({ t: 'proc-use', name: PROC, duration: '30m', purpose: 'rodando a bateria', by: { slotId: memberId } } as never)
    await toTree()
    await page.click('.rg-sys-open')
    const row = `.rg-sr.proc[data-proc="${PROC}"]`
    await page.waitForSelector(`${row} [data-sys="stop"]`, { timeout: 15_000 })
    assert.equal(await page.locator('[data-sys="proc-new"]:visible').count(), 1, '"Novo processo" from afar (RR5)')
    await page.click(`${row} [data-sys="stop"]`)
    await page.waitForSelector(`${row} .rg-sr-x.inuse`, { timeout: 15_000 })
    const board = await text(`${row} .rg-sr-x.inuse`)
    assert.match(board, /Não dá para parar "bench-web" agora/)
    assert.match(board, /conferente usa até daqui a .*, para: rodando a bateria/)
    assert.equal(await page.locator(`${row} [data-sys="inuse-wait"]`).count(), 0, 'waiting for the use to end is not from afar')
    await rr5shot('390-processo-em-uso')
    await page.click(`${row} [data-sys="inuse-force"]`)
    await page.fill(`${row} [data-field="reason"]`, 'preciso da porta')
    await page.click(`${row} [data-sys="inuse-force-go"]`)
    await eventually(async () => {
      const info = (await cli.request({ t: 'proc-info', name: PROC } as never)) as unknown as { proc: { status: string } }
      return info.proc.status !== 'running' || undefined
    }, 30_000, 'the process stopped')
    await eventually(async () => ((await page.getAttribute(row, 'data-state')) !== 'ok') || undefined, 15_000, 'the row read again')
    await rr5shot('390-processo-parado')
    await page.click('.rg-sys-back')
  })

  test('RR5 gerir 4. a 390: fechar uma guia com a prova deste ato (a frase da biometria antes; a guia sai da mesa)', async () => {
    const before = (await credentials())[0]!.signCount
    await toTree()
    await rowMenu('.rg-tree [data-target="pane:p-web"]')
    await menuRow('Fechar guia')
    await page.waitForSelector('.rr-ask', { timeout: 5_000 })
    const q = await text('.rr-ask')
    assert.match(q, /Esta guia tem um shell aberto/)
    assert.match(q, /Para isso, o tether pede a biometria deste aparelho\./, 'what is going to be done, before the system asks')
    await rr5shot('390-fechar-guia')
    await page.click('.rr-ask [data-choice="keep"]')
    await eventually(async () => (await page.locator('.rg-tree [data-target="pane:p-web"]').count()) === 0 || undefined, 20_000, 'the pane gone from the tree')
    assert.ok(appActs.some((a) => a.act === 'panes.close' && a.paneId === 'p-web' && a.process === 'keep'), JSON.stringify(appActs))
    assert.ok((await credentials())[0]!.signCount > before, 'the act was proved by the platform authenticator')
    await eventually(async () => /fechada/.test(await notice()) || undefined, 5_000, 'the result said')
  })

  test('RR5 gerir 5. a 390: com o app fechado na máquina, o ato diz "O tether não está aberto na máquina", nunca o código', async () => {
    appCloses()
    lease.skewMs = STALE_MS + 5_000
    lease.expire?.()
    await page.waitForSelector('.rr[data-link="closed"]', { timeout: 15_000 })
    await toTree()
    await rowMenu(deskRow('desk-obra'))
    await menuRow('Hibernar mesa')
    // The app's question comes only while an agent of that desk works (the tree says whether its slot still runs): answered
    // when it comes, then the house's answer.
    await eventually(async () => {
      if (await page.isVisible('.rr-ask [data-choice="hibernate"]')) await tap('.rr-ask [data-choice="hibernate"]')
      return /O tether não está aberto na máquina/.test(await notice()) || undefined
    }, 10_000, 'the sentence of no-app')
    assert.doesNotMatch(await notice(), /no-app/)
    await rr5shot('390-app-fechado')
    lease.skewMs = 0
    await publish()
    appOpens()
    await page.waitForSelector('.rr[data-link="live"]', { timeout: 15_000 })
  })

  test('RR5 gerir 6. a 1440: o menu no ponto do botão direito; Esc fecha e devolve o teclado à linha', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('.rr[data-tier="desktop"]', { timeout: 10_000 })
    await toTree()
    // The bench's agent (its slot id, made in before()): the row is the one the tree draws for it.
    const row = `.rg-tree [data-target="agent:${memberId}"]`
    await page.click(row, { button: 'right' })
    await page.waitForSelector('#ctx-menu[data-form="point"]', { timeout: 5_000 })
    const m = await text('#ctx-menu')
    for (const l of ['O agente conferente', 'Espiar', 'Fechar guia']) assert.ok(m.includes(l), `${l}: ${m}`)
    await rr5shot('1440-menu')
    await page.keyboard.press('Escape')
    await eventually(async () => (await page.locator('#ctx-menu').count()) === 0 || undefined, 5_000, 'the menu closed')
    await eventually(async () => (await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.rg-tree [data-key]') !== null)) || undefined, 5_000, 'the keyboard back on the row')
  })

  test('RR5 gerir 7. a 2560: OK numa linha abre o menu, as setas andam nele, Voltar fecha', async () => {
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.waitForSelector('.rr[data-tier="wide"]', { timeout: 10_000 })
    await toTree()
    await page.focus(deskRow('desk-migr'))
    await page.keyboard.press('ArrowDown')
    const at = await eventually(held, 5_000, 'a row of the tree')
    assert.ok(at.inTree, at.key)
    await page.keyboard.press('Enter')
    await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
    const first = await page.evaluate(() => document.activeElement?.textContent ?? '')
    await page.keyboard.press('ArrowDown')
    const second = await page.evaluate(() => (document.activeElement?.closest('#ctx-menu') ? document.activeElement.textContent ?? '' : ''))
    assert.ok(second !== '' && second !== first, `the arrows walk the menu (${first} → ${second})`)
    await page.screenshot({ path: join(rr5, '2560-menu-setas.png') })
    await page.keyboard.press('Escape')
    await eventually(async () => (await page.locator('#ctx-menu').count()) === 0 || undefined, 5_000, 'the menu closed')
    // The bench's desks as they were for the tests that follow.
    desksNow.names['desk-obra'] = 'Obra'
    desksNow.gone.clear()
    desksNow.asleep.clear()
    app.off('ext-event', onAppAct)
    await sendMap()
    await publish()
    await page.setViewportSize({ width: 1440, height: 900 })
    await sleep(300)
  })

  // ---- RR5 (fio-spec 18): "+ Novo", managing a channel and "Novo processo" from afar, on the protected device -----------
  // Each step starts at its own place (no box open, "Sistema" closed, the size it needs) and makes what it needs itself.
  const card = 'dialog.rg-cr[open]:not(.rg-np)'
  const npForm = 'dialog.rg-cr.rg-np[open]'
  const box = 'dialog.rr-ask[open]'
  const slotsNow = async (): Promise<{ slotId: string; kind: string; name: string }[]> => ((await cli.request({ t: 'list' })).slots ?? []) as never
  const channelsNow = async (): Promise<{ id: string; name: string }[]> => (await ext(app, 'list', {}, 'channels')).channels as { id: string; name: string }[]
  const membersOf = async (channel: string): Promise<{ id: string; muted?: boolean }[]> => (await ext(app, 'members', { channel }, 'channels')).members as { id: string; muted?: boolean }[]
  /** The bench's app reads its channels again and publishes them (the app's tree carries the open channels). */
  const republishChannels = async (): Promise<void> => { channelRows = (await ext(app, 'list', {}, 'channels')).channels as unknown[]; await publish() }
  const startAt = async (width: number, height: number, tier: string): Promise<void> => {
    mkdirSync(rr5, { recursive: true })
    for (let i = 0; i < 4 && (await page.locator('#ctx-menu, dialog[open]').count()) > 0; i++) { await page.keyboard.press('Escape'); await sleep(150) }
    await page.setViewportSize({ width, height })
    await page.waitForSelector(`.rr[data-tier="${tier}"]`, { timeout: 10_000 })
    await toTree()
  }
  /** A channel of the bench in the centre (its row in "Canais"; on the phone, the "Canal" place). */
  const openChannel = async (id: string): Promise<string> => {
    if (await page.isVisible('.rg-tab[data-tab="conversation"]')) await page.click('.rg-tab[data-tab="conversation"]')
    const conv = `.rg-conv[data-target="channel:${id}"]`
    // On the phone "Canais" folds over the conversation once one was chosen: its head unfolds it again.
    await eventually(async () => {
      if (await page.isVisible(conv)) return true
      if (await page.isVisible('.rg-convs-tg[aria-expanded="false"]')) await tap('.rg-convs-tg[aria-expanded="false"]')
      return undefined
    }, 15_000, `the channel ${id} in "Canais"`)
    await page.click(conv)
    const pane = `.ch-pane[data-channel="${id}"]`
    await page.waitForSelector(`${pane} .ch-bar`, { timeout: 15_000 })
    return pane
  }
  /** The channel's "⋯" and a row of its menu (the app's words). */
  const channelMenuRow = async (pane: string, label: string): Promise<void> => {
    // The menu says what the view read of the channel: a row that depends on a change just made comes once it is read again.
    await eventually(async () => {
      await page.click(`${pane} .ch-bar .ch-more`, { timeout: 10_000 })
      await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
      if (await page.locator('#ctx-menu .rr-mi', { hasText: label }).count() > 0) return true
      await page.keyboard.press('Escape')
      await sleep(300)
      return undefined
    }, 15_000, `the row "${label}" in the channel's menu`)
    await menuRow(label)
  }

  // The device has 30 gestures a minute (the portal's limits.ts): the steps of RR5 5.4 above spent theirs, these spend about
  // fifteen, and the steps after them unlock again. A fresh minute before and after keeps each block within its own.
  test('RR5 um minuto novo de gestos antes de "+ Novo", canal e processo', async () => { await sleep(61_000) })

  test('RR5 novo 1. a 390: criar um terminal numa mesa pelo "+ Novo" (o quê › onde › detalhes, um passo por vez, "Voltar")', async () => {
    await startAt(390, 844, 'mobile')
    const before = new Set((await slotsNow()).map((s) => s.slotId))
    await page.click('.rg-right .rg-new')
    await page.waitForSelector(`${card}[data-step="what"]`, { timeout: 15_000 })
    const sheet = (await page.locator(card).boundingBox())!
    assert.ok(sheet.height >= 844 * 0.85 && sheet.width >= 380, `a sheet of nearly the whole screen: ${JSON.stringify(sheet)}`)
    const tiles = await page.locator(`${card} [data-do="tile"]`).evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.arg))
    assert.deepEqual(tiles, ['agent', 'terminal', 'note', 'browser', 'desk', 'channel'], 'every tile the scopes allow')
    await rr5shot('novo-390-o-que')
    await page.click(`${card} [data-do="tile"][data-arg="terminal"]`)
    await page.waitForSelector(`${card}[data-step="where"]`, { timeout: 5_000 })
    assert.equal(await page.locator(`${card} .rg-cr-up`).isVisible(), true, '"Voltar" a step, on the phone')
    assert.equal(await page.locator(`${card} input[data-f="desk"][value="desk-obra"]`).count(), 1)
    await page.check(`${card} input[data-f="desk"][value="desk-obra"]`)
    await rr5shot('novo-390-onde')
    await page.click(`${card} [data-do="next"]`)
    await page.waitForSelector(`${card}[data-step="details"]`, { timeout: 5_000 })
    // The folder is one of the tether's list, by its label; nothing of the machine's screen ("Ir até a guia", an address).
    const folder = await text(`${card} [data-do="folder"]`)
    assert.ok(folder.includes(home.split(/[\\/]/).filter(Boolean).pop()!), `the folder's label: ${folder}`)
    assert.doesNotMatch(folder, /[\\/]/, 'never a path')
    assert.equal(await page.locator(`${card} input[data-f="go"], ${card} input[data-f="url"]`).count(), 0)
    await rr5shot('novo-390-detalhes')
    await page.click(`${card} [data-do="next"]`)
    const born = await eventually(async () => (await slotsNow()).find((s) => !before.has(s.slotId) && s.kind === 'shell'), 20_000, 'the terminal at tetherd')
    assert.equal(born.name, 'Terminal 1')
    await eventually(async () => (await page.locator(card).count()) === 0 || undefined, 15_000, 'the card closed')
    await eventually(async () => /Terminal criado em Obra/.test(await notice()) || undefined, 10_000, 'the result said')
    // She stays where she was ("Mesas"); the new row shows when the tree comes (the app places the slot's pane).
    assert.ok(await page.isVisible('.rg-tree [data-key]'), 'still on "Mesas"')
    desksNow.born.push({ deskId: 'desk-obra', id: born.slotId, title: born.name })
    await publish()
    await page.waitForSelector(`.rg-tree [data-target="pane:${born.slotId}"]`, { timeout: 15_000 })
    await rr5shot('novo-390-linha-nova')
    await cli.request({ t: 'stop', slotId: born.slotId }).catch(() => undefined)
  })

  test('RR5 canal 1. a 390: criar um canal pelo "+ Novo" e chamar o agente da bancada ("Chamar agente…", vários de uma vez)', async () => {
    await startAt(390, 844, 'mobile')
    await page.click('.rg-right .rg-new')
    await page.waitForSelector(`${card} [data-do="tile"][data-arg="channel"]`, { timeout: 15_000 })
    await page.click(`${card} [data-do="tile"][data-arg="channel"]`)
    await page.waitForSelector(`${card}[data-step="details"] input[data-f="channel-name"]`, { timeout: 5_000 })
    await page.fill(`${card} input[data-f="channel-name"]`, 'longe')
    await page.click(`${card} [data-do="next"]`)
    const made = await eventually(async () => (await channelsNow()).find((c) => c.name === 'longe'), 15_000, 'the channel in the house')
    await republishChannels()
    const pane = await openChannel(made.id)
    await page.click(`${pane} .ch-bar .ch-join`)
    await page.waitForSelector(`${box} .rr-ask-ck`, { timeout: 10_000 })
    assert.equal(await page.getAttribute(box, 'data-form'), 'sheet')
    const rows = await page.locator(`${box} .rr-ask-ck`).allTextContents()
    assert.ok(rows.some((r) => r.includes('conferente')) && rows.some((r) => r.includes('revisor')), `the agents by desk: ${rows.join(' | ')}`)
    await page.locator(`${box} .rr-ask-ck`, { hasText: 'conferente' }).first().click()
    await page.locator(`${box} .rr-ask-ck`, { hasText: 'revisor' }).first().click()
    assert.match(await text(`${box} [data-choice="confirm"]`), /Chamar 2/)
    await rr5shot('canal-390-chamar')
    await page.click(`${box} [data-choice="confirm"]`)
    await eventually(async () => (await membersOf(made.id)).some((m) => m.id === memberId) || undefined, 15_000, 'conferente in the channel')
    // revisor is no slot of tetherd (only a pane the app published): the app's dialog says who did not come, in words.
    await page.waitForSelector(`${box}`, { timeout: 10_000 })
    const told = await text(box)
    assert.match(told, /Entraram: conferente/)
    assert.doesNotMatch(told, /unknown-agent/)
    await rr5shot('canal-390-chamados')
    await page.click(`${box} [data-choice="ok"]`)
    const notices = ((await historyOf(made.id)).lines as { kind: string; body: string; afar?: true }[]).filter((l) => l.kind === 'notice')
    assert.ok(notices.some((l) => l.afar === true && l.body.includes('(de longe)')), JSON.stringify(notices))
  })

  test('RR5 canal 2. a 1440: calar e devolver a voz pelo "⋯" do canal (o menu no ponto, a pergunta do app)', async (t) => {
    await startAt(1440, 900, 'desktop')
    // Whatever this step leaves, the bench's agent speaks again after it (the steps after it make it talk).
    t.after(() => ext(app, 'unmute', { channel: channelId, agent: memberId }, 'channels').then(() => undefined, () => undefined))
    const pane = await openChannel(channelId)
    await channelMenuRow(pane, 'Calar agente…')
    await page.waitForSelector(`${box} .rr-ask-o`, { timeout: 10_000 })
    await page.locator(`${box} .rr-ask-o`, { hasText: 'conferente' }).first().click()
    await page.waitForSelector(`${box} [data-choice="mute"]`, { timeout: 5_000 })
    assert.equal(await page.getAttribute(box, 'data-form'), 'dialog')
    assert.match(await text(box), /Calar conferente em #obra\?/)
    await rr5shot('canal-1440-calar')
    await page.click(`${box} [data-choice="mute"]`)
    await eventually(async () => (await membersOf(channelId)).find((m) => m.id === memberId)?.muted === true || undefined, 15_000, 'conferente muted')
    await eventually(async () => /conferente calado em #obra/.test(await notice()) || undefined, 10_000, 'the result said')
    await channelMenuRow(pane, 'Devolver a voz…')
    await page.waitForSelector(`${box} .rr-ask-o`, { timeout: 10_000 })
    await page.locator(`${box} .rr-ask-o`, { hasText: 'conferente' }).first().click()
    await eventually(async () => (await membersOf(channelId)).find((m) => m.id === memberId)?.muted !== true || undefined, 15_000, 'conferente heard again')
    await eventually(async () => /voz de volta/.test(await notice()) || undefined, 10_000, 'the result said')
  })

  test('RR5 canal 3. a 1440: encerrar uma enquete no cartão (a pergunta do app; o resultado no canal)', async () => {
    await startAt(1440, 900, 'desktop')
    // A channel of its own, where the bench's agent owes no vote (it may open a poll only then).
    const room = ((await ext(app, 'create', { name: 'enquete-longe' }, 'channels')).channel as { id: string }).id
    await ext(app, 'join', { channel: room, agent: memberId }, 'channels')
    await republishChannels()
    const pane = await openChannel(room)
    await agent('poll', { canal: room, question: 'Fecho a enquete de longe?', to: ['usuário'] })
    const pollCard = page.locator(`${pane} .ch-poll[data-state="open"]`, { hasText: 'Fecho a enquete de longe?' })
    await pollCard.waitFor({ timeout: 15_000 })
    await pollCard.locator('.ch-pmore').click()
    await page.waitForSelector('#ctx-menu', { timeout: 5_000 })
    await menuRow('Encerrar agora…')
    await page.waitForSelector(`${box} [data-choice="close"]`, { timeout: 5_000 })
    assert.match(await text(box), /Encerrar a enquete agora\?/)
    await rr5shot('canal-1440-enquete')
    await page.click(`${box} [data-choice="close"]`)
    await eventually(async () => {
      const polls = (await historyOf(room)).polls as { seq: number; open?: { question: string }; result?: unknown }[]
      return polls.some((p) => p.open?.question === 'Fecho a enquete de longe?') ? undefined : true
    }, 15_000, 'the poll closed in the house')
    await page.locator(`${pane} .ch-poll:not([data-state="open"])`, { hasText: 'Fecho a enquete de longe?' }).waitFor({ timeout: 15_000 })
  })

  test('RR5 canal 4. a 390: encerrar o canal com a prova deste ato (a pergunta do app, a frase da biometria antes)', async () => {
    await startAt(390, 844, 'mobile')
    const made = (await ext(app, 'create', { name: 'fechar-longe' }, 'channels')).channel as { id: string }
    await republishChannels()
    const pane = await openChannel(made.id)
    const signs = (await credentials())[0]!.signCount
    await channelMenuRow(pane, 'Encerrar canal…')
    await page.waitForSelector(`${box} [data-choice="close"]`, { timeout: 5_000 })
    const q = await text(box)
    assert.match(q, /Encerrar #fechar-longe\?/)
    assert.match(q, /Para isso, o tether pede a biometria deste aparelho\./, 'what is going to be done, before the system asks')
    await rr5shot('canal-390-encerrar')
    await page.click(`${box} [data-choice="close"]`)
    await eventually(async () => !(await channelsNow()).some((c) => c.id === made.id) || undefined, 20_000, 'the channel closed in the house')
    assert.ok((await credentials())[0]!.signCount > signs, 'the act was proved by the platform authenticator')
    await eventually(async () => /#fechar-longe encerrado/.test(await notice()) || undefined, 10_000, 'the result said')
    await republishChannels()
  })

  test('RR5 processo 1. a 390: "Novo processo" com variável comum sobe; o valor não fica em lugar nenhum da página', async () => {
    const MARK = `canary${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
    const NAME = 'bench-novo'
    await startAt(390, 844, 'mobile')
    await page.click('.rg-sys-open')
    await page.waitForSelector('[data-sys="proc-new"]', { state: 'visible', timeout: 15_000 })
    await page.click('[data-sys="proc-new"]')
    await page.waitForSelector(`${npForm} input[data-f="name"]`, { timeout: 15_000 })
    assert.match(await text(`${npForm} .rg-np-warn`), /Aqui não é lugar de senha nem chave\./)
    await page.fill(`${npForm} input[data-f="name"]`, NAME)
    await page.fill(`${npForm} input[data-f="command"]`, 'node -e "setInterval(() => {}, 1000)"')
    await page.fill(`${npForm} input[data-f="description"]`, 'de longe')
    await page.click(`${npForm} [data-do="env-add"]`)
    await page.fill(`${npForm} input[data-f="env-name"]`, 'BENCH_MODE')
    await page.fill(`${npForm} input[data-f="env-value"]`, MARK)
    assert.equal(await page.getAttribute(`${npForm} input[data-f="env-value"]`, 'type'), 'password')
    await rr5shot('processo-390-form')
    const signs = (await credentials())[0]!.signCount
    await page.click(`${npForm} [data-do="create"]`)
    await eventually(async () => ((await cli.request({ t: 'proc-info', name: NAME } as never).catch(() => ({}))) as unknown as { proc?: { status: string } }).proc?.status === 'running' || undefined, 30_000, 'the new process running')
    assert.ok((await credentials())[0]!.signCount > signs, 'a command on the machine is proved by the act')
    await eventually(async () => (await page.locator(npForm).count()) === 0 || undefined, 10_000, 'the form closed')
    await eventually(async () => /Processo bench-novo criado/.test(await notice()) || undefined, 10_000, 'the result said')
    // THE CANARY on the page: no storage of the browser, no field, no text, no attribute and no database holds the value.
    const found = await page.evaluate(async (mark) => {
      const where: string[] = []
      const sweep = (s: Storage, n: string): void => { for (let i = 0; i < s.length; i++) { const k = s.key(i)!; if (k.includes(mark) || (s.getItem(k) ?? '').includes(mark)) where.push(`${n}:${k}`) } }
      sweep(localStorage, 'localStorage')
      sweep(sessionStorage, 'sessionStorage')
      for (const i of document.querySelectorAll('input, textarea')) if ((i as HTMLInputElement).value.includes(mark)) where.push('field')
      if (document.documentElement.outerHTML.includes(mark)) where.push('dom')
      const dbs = (await indexedDB.databases?.()) ?? []
      if (dbs.some((d) => (d.name ?? '').includes(mark))) where.push('indexedDB')
      if (performance.getEntries().some((e) => e.name.includes(mark))) where.push('performance')
      return where
    }, MARK)
    assert.deepEqual(found, [], `the value is nowhere in the page: ${found.join(', ')}`)
    assert.equal(pageErrors.some((e) => e.includes(MARK)), false, 'nor in an error of the page')
    await rr5shot('processo-390-criado')
    await cli.request({ t: 'proc-stop', name: NAME, force: 'fim do passo' } as never).catch(() => undefined)
  })

  test('RR5 processo 2. a 390: um nome com cara de segredo é barrado antes de enviar, com a sugestão do dotenvx e sem "mesmo assim"', async () => {
    await startAt(390, 844, 'mobile')
    await page.click('.rg-sys-open')
    await page.waitForSelector('[data-sys="proc-new"]', { state: 'visible', timeout: 15_000 })
    await page.click('[data-sys="proc-new"]')
    await page.waitForSelector(`${npForm} input[data-f="name"]`, { timeout: 15_000 })
    await page.fill(`${npForm} input[data-f="name"]`, 'bench-segredo')
    await page.fill(`${npForm} input[data-f="command"]`, 'node -e "1"')
    await page.click(`${npForm} [data-do="env-add"]`)
    await page.fill(`${npForm} input[data-f="env-name"]`, 'API_TOKEN')
    await page.fill(`${npForm} input[data-f="env-value"]`, 'qualquer')
    const signs = (await credentials())[0]!.signCount
    await page.click(`${npForm} [data-do="create"]`)
    await page.waitForSelector(`${npForm} .rg-cr-err`, { timeout: 5_000 })
    const err = await text(`${npForm} .rg-cr-err`)
    assert.match(err, /API_TOKEN parece um segredo/)
    assert.match(err, /dotenvx run --/)
    assert.doesNotMatch(err, /qualquer/, 'never the value')
    assert.equal(await page.locator(`${npForm} [data-do="ask-go"]`).count(), 0, 'no "create anyway"')
    assert.equal(await page.locator(npForm).getByText('mesmo assim').count(), 0, 'no "create anyway"')
    assert.equal((await credentials())[0]!.signCount, signs, 'nothing was asked of the biometrics: nothing went')
    await rr5shot('processo-390-segredo')
    const info = await cli.request({ t: 'proc-info', name: 'bench-segredo' } as never).catch((e: unknown) => ({ error: String(e) })) as { proc?: unknown }
    assert.equal(info.proc, undefined, 'nothing at the machine')
    await page.keyboard.press('Escape')
    await eventually(async () => (await page.locator(npForm).count()) === 0 || undefined, 5_000, 'the form closed')
  })

  test('RR5 novo 2. a 2560: "+ Novo" pelas setas e OK, uma mesa nova (o cartão em diálogo, o anel de foco)', async () => {
    await startAt(2560, 1440, 'wide')
    // The remote's arrows reach "+ Novo" in the heading of "Mesas"; OK opens the card.
    await page.focus(deskRow('desk-obra'))
    let at = await eventually(held, 5_000, 'a row of the tree')
    for (let i = 0; i < 8 && !/rg-new/.test(at.key) && at.key !== 'new'; i++) {
      await page.keyboard.press('ArrowUp')
      at = await eventually(held, 5_000, 'the focus after ArrowUp')
    }
    assert.ok(at.key === 'new' || /rg-new/.test(at.key), `the arrows reach "+ Novo" (${at.key})`)
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${card}[data-step="what"][data-tier="wide"]`, { timeout: 15_000 })
    const dlg = (await page.locator(card).boundingBox())!
    assert.ok(dlg.width < 2560 * 0.6, `a dialog, not the whole screen: ${JSON.stringify(dlg)}`)
    // The arrows walk the tiles; OK on "Mesa" goes on to its details.
    const focused = async (): Promise<string> => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return `${a?.dataset.do ?? ''}:${a?.dataset.arg ?? ''}` })
    for (let i = 0; i < 10 && (await focused()) !== 'tile:desk'; i++) await page.keyboard.press('ArrowDown')
    if ((await focused()) !== 'tile:desk') for (let i = 0; i < 10 && (await focused()) !== 'tile:desk'; i++) await page.keyboard.press('ArrowRight')
    assert.equal(await focused(), 'tile:desk', 'the arrows reach the tile "Mesa"')
    await page.screenshot({ path: join(rr5, '2560-novo-setas.png') })
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${card}[data-step="details"] input[data-f="desk-name"]`, { timeout: 5_000 })
    await page.keyboard.type('Longe')
    await page.screenshot({ path: join(rr5, '2560-novo-mesa.png') })
    app.on('ext-event', onAppAct)
    await page.keyboard.press('Enter')
    await eventually(async () => appActs.some((a) => a.act === 'desks.create' && a.name === 'Longe') || undefined, 20_000, 'the desk asked of the app')
    app.off('ext-event', onAppAct)
    await eventually(async () => (await page.locator(card).count()) === 0 || undefined, 15_000, 'the card closed')
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test('RR5 um minuto novo de gestos depois de "+ Novo", canal e processo', async () => {
    await sleep(61_000)
    // The steps after these read the bench's first channel in the centre, as they found it.
    await startAt(1440, 900, 'desktop')
    await openChannel(channelId)
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
