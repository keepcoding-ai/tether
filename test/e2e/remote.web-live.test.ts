// RR3 ("ver") end to end, in a browser: the REAL web client (remote/web, built by its own build.mjs with this bench's relay
// written in, served by bench/serve.ts) in a real Chromium (Electron of the bench, driven over CDP, with a virtual platform
// authenticator that answers by itself), against the REAL relay (remote/relay/, its own process) and a tetherd of the bench
// (home under TETHER_BENCH_DIR or the system temp, never the person's) with the `remote`, `channels` and `regency`
// extensions and the real portal. The app is a pipe client `app` that does what the app's renderer does for the Regency:
// it creates a channel, publishes the tree (extensions/regency/daemon.ts `tree.publish`) and keeps its lease. An agent is a
// slot of the bench that speaks by the CLI's road (the pipe's `verb` request).
//
// The roteiro of RR3, one test each, in order: pair; "Agora não" on the offer to protect; unlock; the Regency's tree; a line
// in a channel re-reads the marks; the app closed ("como estavam às HH:MM"); offline (only the notice); a poll, read only;
// paging the channel back; locked by the machine; a burst of events. Then the TV (2560 px): five captures of the walk by
// arrows. Last, a device without the scopes of the Regency and of the channels (the bench restarts tetherd with the
// device's scopes narrowed in its registry, the one place they live), because nothing after it could read.
// Captures go to REMOTE_SHOTS_DIR (else test/e2e/artifacts): rr3-live-*.png, and the TV's under rr3-tv/.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
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
interface Held { key: string; left: number; right: number; inTree: boolean; inLeft: boolean; ring: boolean }

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
  let memberId = ''
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

  // ---- the page ------------------------------------------------------------------------------------------------------

  const view = (v: string, ms = 20_000): Promise<unknown> => page.waitForSelector(`#app[data-view="${v}"]`, { timeout: ms })
  const shot = async (name: string): Promise<void> => { await page.screenshot({ path: join(shots, `rr3-live-${name}.png`) }) }
  const text = async (sel: string): Promise<string> => (await page.textContent(sel)) ?? ''
  const msgsHave = (needle: string): Promise<boolean> => page.evaluate((n) => (document.querySelector('.ch-msgs')?.textContent ?? '').includes(n), needle)
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
      if (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await page.click('#unlock').catch(() => undefined)
      else if (await page.isVisible('.rr-off .rr-btn')) await page.click('.rr-off .rr-btn').catch(() => undefined)
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
      inTree: a.closest('.rg-tree') !== null, inLeft: a.closest('.rg-left') !== null,
      ring: (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || cs.boxShadow !== 'none',
    }
  })

  before(async () => {
    mkdirSync(tvShots, { recursive: true })
    mkdirSync(profile, { recursive: true })
    const w = await spawnNode(['remote/web/bench/serve.ts', '--dir', out, '--port', '0'], 'web.listening', webLines)
    web = w.proc
    pageUrl = `http://localhost:${Number(w.line.port)}/`
    const relayPort = await freePort()
    relayUrl = `ws://localhost:${relayPort}`
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
    for (let i = 1; i <= LINES; i++) await ext(app, 'say', { channel: channelId, text: `linha ${pad(i)}` }, 'channels')
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
})
