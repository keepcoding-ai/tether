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
interface Held { key: string; left: number; right: number; inTree: boolean; inLeft: boolean; inRight: boolean; ring: boolean }

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
      inTree: a.closest('.rg-tree') !== null, inLeft: a.closest('.rg-left') !== null, inRight: a.closest('.rg-right') !== null,
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

  test('5. uma fala num canal faz a tela reler as marcas: "para você" e a conta de não lidas chegam sem recarregar', async () => {
    const conv = `.rg-conv[data-target="channel:${channelId}"]`
    assert.equal(await page.locator(`${conv} .rg-tome`).count(), 0, "the person's own lines call nobody")
    await agent('say', { canal: channelId, text: 'Qual das duas telas de filtro fica?', to: ['usuário'] })
    await page.waitForSelector(`${conv} .rg-tome`, { timeout: 15_000 })
    assert.equal(await text(`${conv} .rg-mk .cnt`), '1', 'one line unread')
    await eventually(async () => (await msgsHave('Qual das duas telas de filtro fica?')) || undefined, 15_000, 'the new line in the open channel')
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

  test('9. enquete aparece só para leitura: o cartão com a pergunta e as opções, nenhuma delas vota', async () => {
    await agent('poll', { canal: channelId, question: 'Qual tela de filtro fica?', options: ['a de cima', 'a de baixo'], to: ['usuário'] })
    await page.waitForSelector('.ch-poll[data-state="open"]', { timeout: 15_000 })
    const card = page.locator('.ch-poll[data-state="open"]').last()
    assert.match((await card.textContent()) ?? '', /Qual tela de filtro fica\?/)
    assert.equal(await card.locator('.ch-opt').count(), 2)
    assert.equal(await card.locator('button.ch-opt').count(), 0, 'no option is a button')
    await card.locator('.ch-opt').first().click()
    await page.keyboard.press('1')
    await sleep(800)
    const h = await ext(app, 'history', { channel: channelId }, 'channels')
    const open = (h.polls as { open?: { votes: Record<string, unknown> } }[]).find((p) => p.open)
    assert.ok(open, 'the poll is open in the house')
    assert.deepEqual(open.open!.votes, {}, 'a tap or a key on the device voted nothing')
    await card.scrollIntoViewIfNeeded()
    await shot('9-enquete')
  })

  test('10. paginar o histórico do canal: subindo, as páginas anteriores chegam até a primeira fala', async () => {
    assert.equal(await msgsHave('linha 001'), false, 'the first line is not on the newest page')
    await eventually(async () => {
      if (await msgsHave('linha 001')) return true
      await page.evaluate(() => {
        const m = document.querySelector<HTMLElement>('.ch-msgs')
        if (m) { m.scrollTop = 0; m.dispatchEvent(new Event('scroll')) }
      })
      if (await page.isVisible('.ch-older')) await page.click('.ch-older').catch(() => undefined)
      return undefined
    }, 30_000, 'the first line of the channel, by paging back')
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
      if (await page.isVisible('.rr-off .rr-btn')) await page.click('.rr-off .rr-btn').catch(() => undefined)
      return (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) || undefined
    }, 40_000, 'the unlock panel')
    assert.match(await text('[data-panel="lock"]'), /Trancado/)
    assert.equal(await page.locator('.rr, .rg-tree, .ch-msgs').count(), 0, 'nothing of the house while locked')
    await shot('11-trancado')
    await page.click('#unlock')
    await toRegency()
    assert.ok((await credentials())[0]!.signCount > signs, 'the unlock was a new proof')
  })

  test('11b. trancar pelo aparelho', { skip: 'a PWA não oferece o gesto: session.lock (0x0007) existe no protocolo e no portal, mas nenhuma tela de remote/web/src o manda' }, () => {})

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

  const tv = (name: string): Promise<Buffer> => page.screenshot({ path: join(tvShots, name) })
  /** The first key the walk would give on the TV (focus-rules.ts initialKeyOf): who waits, else the first channel. */
  const firstOfTv = (): Promise<string | undefined> => page.evaluate(() => {
    const e = document.querySelector<HTMLElement>('.rg-waiting [data-target]') ?? document.querySelector<HTMLElement>('.rg-convs .rg-conv[data-target]')
    return e?.dataset.target
  })
  let firstHeld: Held | undefined

  // Product defect found by this test (reported, not fixed here: remote/web/src is not this test's): the casing paints the
  // pane once while the house is still being read (regency.ts `online` -> paint -> focus.afterPaint), when the only items are
  // the filter chips; the walk gives the keyboard to the first of them ("Todos") and, once someone holds it, keeps it there
  // (keptKeyOf), so the TV opens on "Todos" and not on who waits.
  test('TV (2560) 2. foco inicial ao abrir: quem espera a pessoa segura o teclado', {
    todo: 'defeito de produto: a TV abre com o foco no chip "Todos", não em quem espera (a 1a pintura, antes da árvore, dá o foco ao 1o chip e ele fica)',
  }, async () => {
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
    // From the left column into the desks' column: the walk crosses the centre (nothing to open there).
    let at = ring
    for (let i = 0; i < 6 && !at.inLeft; i++) {
      await page.keyboard.press('ArrowLeft')
      at = await eventually(held, 5_000, 'the focus after ArrowLeft')
    }
    assert.ok(at.inLeft, `the arrows reach the left column (${at.key})`)
    const from = at
    await page.keyboard.press('ArrowRight')
    at = await eventually(held, 5_000, 'the focus after ArrowRight')
    assert.ok(at.inRight && at.left > from.right, `one ArrowRight crossed from ${from.key} into the desks' column (${at.key})`)
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
      if (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await page.click('#unlock').catch(() => undefined)
      else if (await page.isVisible('.rr-off .rr-btn')) await page.click('.rr-off .rr-btn').catch(() => undefined)
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
