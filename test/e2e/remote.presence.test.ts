// RR2.4c end to end: presence from the device. The bench of remote.skeleton (a tetherd of the bench with the `remote`
// extension and its real portal, the REAL relay, the web client built and served, a real Chromium driven over CDP), plus
// a virtual platform authenticator with user verification (CDP WebAuthn.enable + addVirtualAuthenticator). Played in
// order: pair, the offer "Proteger com a biometria deste aparelho" at 390 and 1440 px, a refused ceremony that leaves the
// session standing, the registration on the pairing session, "protegido", and an unlock carried by a real assertion
// (the authenticator's counter grows and the list comes through).
// Screenshots (rr24c-*.png) go to REMOTE_SHOTS_DIR, else test/e2e/artifacts.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { activateWith } from '../../extensions/remote/daemon.ts'
import { manifest } from '../../extensions/remote/manifest.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { guardAppEnv } from './app-env.ts'
import { benchHome, until } from '../unit/remoted.helpers.ts'

const root = resolve(import.meta.dirname, '..', '..')
const shots = resolve(process.env.REMOTE_SHOTS_DIR ?? join(root, 'test', 'e2e', 'artifacts'))

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await c.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })).result as Record<string, unknown>

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

/** `until` for a check that awaits: polls the page every 100 ms until it gives a value. */
async function eventually<T>(f: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

interface VirtualCredential { credentialId: string; signCount: number; rpId?: string }

describe('remote web client, presence end to end (RR2.4c)', () => {
  const home = benchHome('tether-remote-uv-')
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
  let daemon: Daemon
  let extHost: DaemonExtensionHost
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

  const view = (v: string, ms = 20_000): Promise<unknown> => page.waitForSelector(`#app[data-view="${v}"]`, { timeout: ms })
  const shot = async (name: string): Promise<void> => { await page.screenshot({ path: join(shots, `rr24c-${name}.png`) }) }
  const credentials = async (): Promise<VirtualCredential[]> =>
    ((await cdp.send('WebAuthn.getCredentials', { authenticatorId })) as { credentials: VirtualCredential[] }).credentials
  const houseUp = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) { if ((await ext(cli, 'remote.status')).link === 'up') return; await new Promise((res) => setTimeout(res, 200)) }
    throw new Error(`the house never came up at the relay:\n${relayLines.join('\n')}`)
  }
  const storedCredentialId = (): Promise<string | undefined> => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open('tether-remote'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
    const all = await new Promise<{ credentialId?: Uint8Array }[]>((res, rej) => { const q = db.transaction('houses').objectStore('houses').getAll(); q.onsuccess = () => res(q.result as { credentialId?: Uint8Array }[]); q.onerror = () => rej(q.error) })
    db.close()
    const id = all[0]?.credentialId
    return id ? btoa(String.fromCharCode(...id)) : undefined
  })
  /** At each width: nothing overflows, the action button keeps 44 px and is not stretched past a reading width. */
  const fits = async (wd: number, button: string): Promise<void> => {
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(scrollW <= wd, `no horizontal scroll at ${wd} px (${scrollW})`)
    const b = await page.locator(button).boundingBox()
    assert.ok(b && b.height >= 44, `a target of at least 44 px at ${wd} px (${b?.height})`)
    if (wd < 768) assert.ok(b && b.x >= 16 && b.x + b.width <= wd - 16 + 0.5, 'the button keeps the 16 px gutter')
    else assert.ok(b && b.width <= 480, `at ${wd} px the action button is not stretched (${b?.width})`)
  }

  before(async () => {
    mkdirSync(shots, { recursive: true })
    mkdirSync(profile, { recursive: true })
    const w = await spawnNode(['remote/web/bench/serve.ts', '--dir', out, '--port', '0'], 'web.listening', webLines)
    web = w.proc
    pageUrl = `http://localhost:${Number(w.line.port)}/`
    const relayPort = await freePort()
    relayUrl = `ws://localhost:${relayPort}`
    const b = spawnSync(process.execPath, ['remote/web/build.mjs', '--relay', relayUrl, '--out', out], { cwd: root, encoding: 'utf8' })
    assert.equal(b.status, 0, `web build: ${b.stdout}${b.stderr}`)
    const r = await spawnNode(
      ['remote/relay/src/main.ts', 'serve', '--port', String(relayPort), '--aud', `localhost:${relayPort}`, '--origins', new URL(pageUrl).origin],
      'relay.listening', relayLines)
    relay = r.proc

    extHost = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, extensions: [{ manifest, activate: (api) => activateWith(api, { env }).disposables }] })
    extHost.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
    // webUrl: the origin of the PWA is the relying party the portal checks every ceremony against.
    assert.deepEqual(await ext(app, 'remote.on', { relayUrl: `${relayUrl}/v1/house`, webUrl: pageUrl }), { on: true })
    await houseUp()

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
      try { browser = await chromium.connectOverCDP(`http://localhost:${port}`); break } catch (e) { if (i > 60) throw e; await new Promise((res) => setTimeout(res, 250)) }
    }
    page = await until(() => browser!.contexts()[0]?.pages().find((p) => p.url().startsWith(pageUrl)), 20_000, 'the page in the browser window')
    await page.setViewportSize({ width: 390, height: 844 })
    // A platform authenticator with user verification, as a phone with a fingerprint reader. It answers by itself.
    cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable', { enableUI: false })
    const added = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })
    authenticatorId = (added as { authenticatorId: string }).authenticatorId
    // The offer is decided once, right after pairing: the page must already see the authenticator.
    await page.reload()
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
    await removeHome(home)
  })

  test('pairing, then the offer to protect this device, in words of a person, at 390 and 1440 px', async () => {
    await view('pair')
    const begun = await ext(app, 'pair.begin')
    await page.fill('#pair-code', String(begun.code))
    await page.click('button[type="submit"]')
    await page.waitForSelector('.sas', { timeout: 20_000 })
    const sas = (await page.textContent('.sas'))!.replace(/\s/g, '')
    let st: Record<string, unknown> = {}
    for (let i = 0; i < 100 && st.state !== 'waiting-sas'; i++) { st = await ext(app, 'pair.state', { pairId: begun.pairId }); await new Promise((r) => setTimeout(r, 100)) }
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits: sas })
    await view('list')
    await page.waitForSelector('[data-panel="guard"] #guard-protect', { timeout: 10_000 })
    const panel = (await page.textContent('[data-panel="guard"]'))!
    assert.match(panel, /Proteger com a biometria deste aparelho/)
    assert.match(panel, /só vê/)
    assert.doesNotMatch(await page.content(), /webauthn|passkey|credencial/i, 'no jargon on the screen')
    await fits(390, '#guard-protect')
    await shot('oferta-390')
    await page.setViewportSize({ width: 1440, height: 900 })
    await new Promise((r) => setTimeout(r, 150))
    await fits(1440, '#guard-protect')
    await shot('oferta-1440')
    await page.setViewportSize({ width: 390, height: 844 })
  })

  test('a ceremony the person does not complete says so, and the session and the offer stay', async () => {
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    await page.click('#guard-protect')
    await page.waitForSelector('[data-panel="guard"] .notice--warn', { timeout: 20_000 })
    assert.match((await page.textContent('[data-panel="guard"] .notice--warn'))!, /cancelado|não deixou/)
    assert.equal(await page.getAttribute('#app', 'data-view'), 'list', 'the session did not fall')
    assert.ok(await page.isEnabled('#guard-protect'), 'the offer can be taken again')
    assert.equal(await storedCredentialId(), undefined)
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true })
  })

  test('the registration on the pairing session: "protegido", the credential id kept, and an unlock with a real proof', async () => {
    const before = (await credentials()).length
    await page.click('#guard-protect')
    await page.waitForSelector('.guard-state[data-guard="protected"]', { timeout: 30_000 })
    const kept = await storedCredentialId()
    assert.ok(kept, 'the credential id is in the house record')
    const creds = await credentials()
    assert.equal(creds.length, before + 1, 'one credential was created on the platform authenticator')
    const cred = creds.find((c) => c.credentialId === kept)
    assert.ok(cred, 'the stored id is the authenticator\'s credential')
    // The unlock follows the registration; when the machine asks for it again, the panel offers "Destrancar".
    await eventually(async () => {
      if (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await page.click('#unlock')
      return (await page.isVisible('.empty-title')) || undefined
    }, 30_000, 'the list after the unlock')
    const signed = (await credentials()).find((c) => c.credentialId === kept)!
    // The virtual authenticator counts every ceremony: 1 for the registration, one more for each assertion.
    assert.ok(signed.signCount >= 2, `an assertion was made after the registration (signCount ${signed.signCount})`)
    assert.equal(await page.isVisible('[data-panel="guard"]'), false, 'the offer is over')
    const b = await page.locator('.guard-state').boundingBox()
    assert.ok(b && b.x + b.width <= 390 - 16 + 0.5, 'the state line keeps the gutter')
    await shot('protegido-390')
    await page.setViewportSize({ width: 1440, height: 900 })
    await new Promise((r) => setTimeout(r, 150))
    await shot('protegido-1440')
    await page.setViewportSize({ width: 390, height: 844 })
  })

  test('reloading: the device still reads as protected (nothing re-registers)', async () => {
    const n = (await credentials()).length
    await page.reload()
    await page.waitForSelector('.guard-state[data-guard="protected"]', { timeout: 20_000 })
    await eventually(async () => {
      if (await page.isVisible('[data-panel="lock"] #unlock:not([disabled])')) await page.click('#unlock')
      return (await page.isVisible('.empty-title')) || undefined
    }, 30_000, 'the list after the reload')
    assert.equal((await credentials()).length, n)
  })
})
