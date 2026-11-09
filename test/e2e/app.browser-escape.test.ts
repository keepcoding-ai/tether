// The escape battery of the CDP gatekeeper (Tether Browser E6, design §3.6, §12b rules 12-13): a permanent gate for every change
// of Electron, Playwright or the gate. Ports bench B4 (the account is used, never exported: HttpOnly cookies planted by a local
// "bank", a decoy file on disk) and bench B1/S2 (isolation: another agent's tab, the interface, the machine) against the real
// gate of the app built with TETHER_TEST_EXTENSIONS=1 (hidden window, private home and pipe, loopback only), three ways:
//   1. raw CDP as a hostile agent (any message it likes), plus a sweep of every event it received;
//   2. Playwright's connectOverCDP over the gate (the polite client: cookies(), storageState(), allHeaders(), newCDPSession);
//   3. the vendored `tether-browser` MCP server as agent A (navigate to file:, the network log, document.cookie, upload).
// Each attempt is REFUSED (an error), SCOPED (answered, nothing secret) or LEAKED (a secret in the answer). The goal: zero
// LEAKED. One documented limit is not counted (rule 13): a site that echoes its own cookie back to its own page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, electronPath, launchHidden, pidAlive, rawCdp, root, serverMjs, sleep } from './browser-kit.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  load(tabId: string, url: string): Promise<string>
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[] }
  gate(): Promise<{ port: number; instance: string } | null>
}

const pipe = `\\\\.\\pipe\\tether-brescape-${process.pid}`
const KEY_A = 'aaaaAAAAbbbbBBBBccccCCCCddddDDDDeeee'
const KEY_B = 'bbbbBBBBccccCCCCddddDDDDeeeeEEEEffff'
const HTTPONLY_BAITS = ['BAIT-HTTPONLY-SESSION-9F3A77', 'BAIT-HTTPONLY-STRICT-2B8C', 'BAIT-HTTPONLY-PATH-5E1D']
const DISK_BAIT = 'BAIT-DISK-PRIVATE-KEY-4C6E'
const B_SECRET = 'AGENT-B-SECRET-123'
const AUTH_BAIT = 'BAIT-AUTHORIZATION-31C'
const CRITICAL = [...HTTPONLY_BAITS, DISK_BAIT, B_SECRET, AUTH_BAIT]
const PUBLIC_OK = 'BAIT-PUBLIC-VISIBLE-A1'

const page = (title: string, body: string): string => `<!doctype html><title>${title}</title><link rel="icon" href="data:,">${body}`
const PAGES: Record<string, string> = {
  '/bank/home': page('Tether Bank', '<h1>Tether Bank</h1><p id="bankstate">LOGGED-IN-AS-OWNER</p><a href="/bank/admin">admin</a>'),
  '/up.html': page('Upload', '<input type="file" id="up" aria-label="file">'),
  '/b.html': page('Page B', `<h1>${B_SECRET}</h1><script>window.__bClicks = 0; addEventListener('click', () => window.__bClicks++)</script>`),
}

function serveBank(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/bank/login') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': [
          `tbank_session=${HTTPONLY_BAITS[0]}; HttpOnly; Path=/; SameSite=Lax`,
          `tbank_strict=${HTTPONLY_BAITS[1]}; HttpOnly; Path=/; SameSite=Strict`,
          `tbank_adminonly=${HTTPONLY_BAITS[2]}; HttpOnly; Path=/bank/admin; SameSite=Lax`,
          `tbank_pub=${PUBLIC_OK}; Path=/; SameSite=Lax`,
        ],
      })
      return res.end(PAGES['/bank/home'])
    }
    // A redirect that sets a cookie: its headers ride on the next request's `redirectResponse`.
    if (url.pathname === '/bank/redirect') {
      res.writeHead(302, { location: '/bank/home', 'set-cookie': `tbank_redir=${HTTPONLY_BAITS[0]}; HttpOnly; Path=/` })
      return res.end()
    }
    // The site echoes its own Cookie header to its own page: the documented limit (rule 13), never counted as the channel's.
    if (url.pathname === '/bank/echo') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(req.headers.cookie ?? '') }
    if (url.pathname === '/bank/admin') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('admin area') }
    const body = PAGES[url.pathname]
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body ?? 'not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

/** The vendored MCP server over stdio, as agent A. */
function mcp(endpointFile: string, keyFile: string): { child: ChildProcessWithoutNullStreams; tool(name: string, args?: object): Promise<{ text: string; isError: boolean }> } {
  const env = cleanEnv()
  env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(electronPath, [serverMjs, '--adopt-endpoint-file', endpointFile, '--adopt-key-file', keyFile, '--allow-evaluate'], { env, stdio: 'pipe', windowsHide: true })
  const pending = new Map<number, (m: any) => void>()
  let buf = ''
  let next = 10
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { const m = JSON.parse(line); if (m.id !== undefined) pending.get(m.id)?.(m) } catch { /* not ours */ }
    }
  })
  child.stderr.on('data', () => {})
  const rpc = (method: string, params: object): Promise<any> => new Promise(r => {
    const id = ++next
    pending.set(id, r)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'escape-e2e', version: '1' } })
    .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') })
  return {
    child,
    tool: async (name, args = {}) => {
      await ready
      const m = await Promise.race([rpc('tools/call', { name, arguments: args }), sleep(30_000).then(() => ({ error: { message: `${name}: no answer` } }))])
      if (m.error) return { text: String(m.error.message), isError: true }
      const text = (m.result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return { text, isError: m.result.isError === true }
    },
  }
}

type Verdict = 'REFUSED' | 'SCOPED' | 'LEAKED' | 'SITE-ECHO'
const secretsIn = (v: unknown): string[] => { const s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''; return CRITICAL.filter(b => s.includes(b)) }

test('browser escape: 0 leaks of HttpOnly cookies, credentials, the disk decoy or another agent\'s tab through the gate (raw CDP, Playwright, vendored MCP)', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const bank = await serveBank()
  const origin = bank.base
  const home = mkdtempSync(join(tmpdir(), 'tether-brescape-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  writeFileSync(join(keysDir, 'agent-a.key'), KEY_A)
  writeFileSync(join(keysDir, 'agent-b.key'), KEY_B)
  mkdirSync(join(home, 'decoy'), { recursive: true })
  const decoyPath = join(home, 'decoy', 'id_rsa_decoy')
  writeFileSync(decoyPath, `-----BEGIN KEY-----\n${DISK_BAIT}\n-----END KEY-----\n`)
  const decoyUrl = 'file:///' + decoyPath.replace(/\\/g, '/')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let server: ReturnType<typeof mcp> | undefined
  const rows: { group: string; vector: string; verdict: Verdict; detail: string }[] = []
  const add = (group: string, vector: string, verdict: Verdict, detail: string): void => {
    rows.push({ group, vector, verdict, detail })
    if (verdict === 'LEAKED') process.stderr.write(`LEAKED ${group} ${vector}: ${detail}\n`)
  }
  /** One attempt: an error answer is REFUSED; an answer is LEAKED when it carries a secret, else SCOPED. */
  const attempt = async (group: string, vector: string, fn: () => Promise<unknown>, siteEcho = false): Promise<unknown> => {
    try {
      const v = await Promise.race([fn(), sleep(20_000).then(() => { throw new Error('no answer in 20 s') })])
      const err = v && typeof v === 'object' && 'error' in (v as object) ? (v as { error: unknown }).error : undefined
      const leaks = secretsIn(v)
      if (siteEcho) add(group, vector, 'SITE-ECHO', 'documented limit (rule 13)')
      else if (leaks.length) add(group, vector, 'LEAKED', leaks.join(','))
      else add(group, vector, err ? 'REFUSED' : 'SCOPED', JSON.stringify(err ?? v ?? '').slice(0, 120))
      return v
    } catch (e) {
      const leaks = secretsIn(String((e as Error).message))
      add(group, vector, leaks.length ? 'LEAKED' : 'REFUSED', String((e as Error).message).slice(0, 120))
      return undefined
    }
  }
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const gate = (await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.gate()))!
    assert.ok(gate, 'the gate is open')
    const base = `http://127.0.0.1:${gate.port}`

    // ---- setup, from the HOST side: A's tab logs the shared partition into the bank; B's tab holds B's secret. ----
    const aTab = await T.evaluate(async (_e, url) => (await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.create('agent-a', url)).tabId, `${origin}/bank/login`)
    const bTab = await T.evaluate(async (_e, url) => (await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.create('agent-b', url)).tabId, `${origin}/b.html`)
    await sleep(1500)
    const hostEval = (tab: string, code: string): Promise<unknown> => T.evaluate(async (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(a.tab, a.code), { tab, code })
    assert.equal(await hostEval(aTab, `document.getElementById('bankstate')?.textContent`), 'LOGGED-IN-AS-OWNER', 'A is logged in')

    // ============================ 1. the endpoint (B1/S2 handshake) ============================
    for (const p of ['/json', '/json/list', '/json/protocol', '/json/new?about:blank', '/json/activate/x', '/json/close/x', '/devtools/inspector.html']) {
      await attempt('http', `GET ${p} with key`, async () => { const r = await fetch(base + p, { headers: { 'x-tether-key': KEY_A } }); return r.status === 200 ? await r.text() : { error: r.status } })
    }
    await attempt('http', 'GET /json/version without key', async () => { const r = await fetch(`${base}/json/version`); return r.status === 200 ? await r.text() : { error: r.status } })
    await attempt('http', 'POST /json/version with key', async () => { const r = await fetch(`${base}/json/version`, { method: 'POST', headers: { 'x-tether-key': KEY_A } }); return r.status === 200 ? await r.text() : { error: r.status } })
    await attempt('handshake', 'WebSocket with a wrong key', () => rawCdp(gate.port, 'zzzzZZZZzzzzZZZZzzzzZZZZ').then(c => { c.close(); return 'opened' }))
    await attempt('handshake', 'WebSocket from a web page (Origin), valid key', () => rawCdp(gate.port, KEY_A, { origin: 'http://evil.test' }).then(c => { c.close(); return 'opened' }))
    await attempt('handshake', 'WebSocket with Sec-Fetch-Site, valid key', () => rawCdp(gate.port, KEY_A, { 'sec-fetch-site': 'cross-site' }).then(c => { c.close(); return 'opened' }))

    // ============================ 2. raw CDP as the hostile agent A ============================
    const cdp = await rawCdp(gate.port, KEY_A)
    const browserSession = (await cdp.call('Target.attachToBrowserTarget')).result.sessionId as string
    const targets = (await cdp.call('Target.getTargets', {}, browserSession)).result.targetInfos as { targetId: string; url: string }[]
    assert.equal(targets.length, 1, 'A sees only its own tab')
    const bCdp = await rawCdp(gate.port, KEY_B)
    const bTarget = (await bCdp.call('Target.getTargets')).result.targetInfos[0].targetId as string
    const sid = (await cdp.call('Target.attachToTarget', { targetId: targets[0]!.targetId, flatten: true })).result.sessionId as string
    for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable']) await cdp.call(m, {}, sid)
    const P = (method: string, params: object = {}): Promise<any> => cdp.call(method, params, sid)
    const B = (method: string, params: object = {}): Promise<any> => cdp.call(method, params, browserSession)
    // cookies, every scope
    await attempt('cdp-cookie', 'Network.getAllCookies', () => P('Network.getAllCookies'))
    await attempt('cdp-cookie', 'Network.getCookies', () => P('Network.getCookies', { urls: [`${origin}/bank/admin`] }))
    await attempt('cdp-cookie', 'Storage.getCookies (browser)', () => B('Storage.getCookies'))
    await attempt('cdp-cookie', 'Storage.getCookies (page)', () => P('Storage.getCookies'))
    await attempt('cdp-cookie', 'Page.getCookies (deprecated)', () => P('Page.getCookies'))
    await attempt('cdp-cookie', 'Network.setCookie', () => P('Network.setCookie', { name: 'x', value: '1', url: origin }))
    await attempt('cdp-cookie', 'Network.setCookies', () => P('Network.setCookies', { cookies: [{ name: 'x', value: '1', url: origin }] }))
    await attempt('cdp-cookie', 'Network.setExtraHTTPHeaders', () => P('Network.setExtraHTTPHeaders', { headers: { 'x-steal': '1' } }))
    await attempt('cdp-cookie', 'Storage.getStorageKeyForFrame', () => P('Storage.getStorageKeyForFrame', { frameId: targets[0]!.targetId }))
    // bodies and interception
    await attempt('cdp-body', 'Network.getResponseBody', () => P('Network.getResponseBody', { requestId: '1' }))
    await attempt('cdp-body', 'Network.getRequestPostData', () => P('Network.getRequestPostData', { requestId: '1' }))
    await attempt('cdp-body', 'Network.loadNetworkResource', () => P('Network.loadNetworkResource', { url: `${origin}/bank/echo`, frameId: targets[0]!.targetId, options: { disableCache: true, includeCredentials: true } }))
    await attempt('cdp-body', 'Fetch.enable', () => P('Fetch.enable', { patterns: [{ urlPattern: '*' }] }))
    await attempt('cdp-body', 'Page.getResourceContent', () => P('Page.getResourceContent', { frameId: targets[0]!.targetId, url: `${origin}/bank/home` }))
    // disk
    await attempt('cdp-disk', 'Page.navigate file:// decoy', () => P('Page.navigate', { url: decoyUrl }))
    for (const url of [`view-source:${origin}/bank/home`, 'chrome://version', 'devtools://devtools/bundled/inspector.html', 'javascript:document.title', `data:text/html,<iframe src="${decoyUrl}">`]) {
      await attempt('cdp-disk', `Page.navigate ${url.slice(0, 30)}`, () => P('Page.navigate', { url }))
    }
    await attempt('cdp-disk', 'DOM.setFileInputFiles', () => P('DOM.setFileInputFiles', { files: [decoyPath], backendNodeId: 1 }))
    await attempt('cdp-disk', 'Input.dispatchDragEvent with files', () => P('Input.dispatchDragEvent', { type: 'drop', x: 10, y: 10, data: { items: [], files: [decoyPath], dragOperationsMask: 1 } }))
    await attempt('cdp-disk', 'IO.read', () => P('IO.read', { handle: '1' }))
    await attempt('cdp-disk', 'Page.setDownloadBehavior', () => P('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:/' }))
    await attempt('cdp-disk', 'Target.createTarget file://', () => B('Target.createTarget', { url: decoyUrl }))
    await attempt('cdp-disk', 'Target.createTarget devtools://', () => B('Target.createTarget', { url: 'devtools://devtools/bundled/inspector.html' }))
    // diagnostics
    for (const m of ['Audits.enable', 'Tracing.start', 'HeapProfiler.enable', 'Memory.getDOMCounters', 'SystemInfo.getInfo', 'SystemInfo.getProcessInfo', 'Browser.getBrowserCommandLine']) {
      await attempt('cdp-diag', m, () => (m.startsWith('Browser') || m.startsWith('SystemInfo') ? B(m) : P(m)))
    }
    // the page's own reach (HttpOnly never appears; file: never loads)
    await attempt('page', 'document.cookie', async () => (await P('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true })).result?.result?.value)
    await attempt('page', 'cookieStore.getAll', async () => (await P('Runtime.evaluate', { expression: 'cookieStore.getAll().then(a => JSON.stringify(a))', awaitPromise: true, returnByValue: true })).result?.result?.value)
    await attempt('page', 'fetch(file://decoy)', async () => (await P('Runtime.evaluate', { expression: `fetch(${JSON.stringify(decoyUrl)}).then(r => r.text()).catch(e => 'ERR ' + e)`, awaitPromise: true, returnByValue: true })).result?.result?.value)
    await attempt('page', 'fetch(/bank/echo) — the site echoes itself', async () => (await P('Runtime.evaluate', { expression: `fetch('/bank/echo', { credentials: 'include' }).then(r => r.text())`, awaitPromise: true, returnByValue: true })).result?.result?.value, true)
    await attempt('page', 'page script looks for the embedder', async () => (await P('Runtime.evaluate', { expression: `JSON.stringify([typeof require, typeof process, typeof window.__tether, String(window.top === window), String(window.opener)])`, returnByValue: true })).result?.result?.value)
    // the emulation is the tether's
    await attempt('emulation', 'Emulation.setDeviceMetricsOverride', () => P('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false }))
    await attempt('emulation', 'Emulation.clearDeviceMetricsOverride', () => P('Emulation.clearDeviceMetricsOverride'))
    await attempt('emulation', 'Emulation.setFocusEmulationEnabled(false)', () => P('Emulation.setFocusEmulationEnabled', { enabled: false }))
    // another agent's tab, the interface, the browser
    await attempt('cross-tab', 'Target.getTargets (browser)', () => B('Target.getTargets'))
    await attempt('cross-tab', 'Target.getTargets (page session)', () => P('Target.getTargets'))
    await attempt('cross-tab', 'Target.attachToTarget B', () => B('Target.attachToTarget', { targetId: bTarget, flatten: true }))
    await attempt('cross-tab', 'Target.attachToTarget B (page session)', () => P('Target.attachToTarget', { targetId: bTarget, flatten: true }))
    await attempt('cross-tab', 'Target.getTargetInfo B', () => B('Target.getTargetInfo', { targetId: bTarget }))
    await attempt('cross-tab', 'Target.getTargetInfo B (page session)', () => P('Target.getTargetInfo', { targetId: bTarget }))
    await attempt('cross-tab', 'Target.closeTarget B', () => B('Target.closeTarget', { targetId: bTarget }))
    await attempt('cross-tab', 'Target.activateTarget B', () => B('Target.activateTarget', { targetId: bTarget }))
    await attempt('cross-tab', 'Runtime.evaluate on a guessed session', () => cdp.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, 'ABCDEF0123456789ABCDEF0123456789'))
    await attempt('cross-tab', 'Target.createBrowserContext', () => B('Target.createBrowserContext'))
    await attempt('cross-tab', 'Target.getBrowserContexts', () => B('Target.getBrowserContexts'))
    await attempt('cross-tab', 'Target.setRemoteLocations', () => B('Target.setRemoteLocations', { locations: [{ host: '127.0.0.1', port: 9222 }] }))
    await attempt('cross-tab', 'Target.exposeDevToolsProtocol', () => B('Target.exposeDevToolsProtocol', { targetId: targets[0]!.targetId }))
    await attempt('cross-tab', 'Target.attachToBrowserTarget (page session)', () => P('Target.attachToBrowserTarget'))
    await attempt('browser', 'Browser.setWindowBounds', () => B('Browser.setWindowBounds', { windowId: 1, bounds: { windowState: 'minimized' } }))
    await attempt('browser', 'Browser.grantPermissions', () => B('Browser.grantPermissions', { permissions: ['geolocation'] }))
    await attempt('browser', 'Browser.close', () => B('Browser.close'))
    await attempt('browser', 'Browser.crash', () => B('Browser.crash'))
    await attempt('browser', 'Browser.crashGpuProcess', () => B('Browser.crashGpuProcess'))
    await attempt('page', 'Page.crash', () => P('Page.crash'))
    await attempt('page', 'Page.close', () => P('Page.close'))
    await attempt('page', 'Page.printToPDF', () => P('Page.printToPDF'))
    await attempt('page', 'Page.bringToFront (no effect on the window)', () => P('Page.bringToFront'))
    await attempt('page', 'mouse click aimed outside the page (the interface)', () => P('Input.dispatchMouseEvent', { type: 'mousePressed', x: -50, y: -50, button: 'left', clickCount: 1 }))

    // ---- THE EVENT SWEEP: Network.enable, a login (Set-Cookie), a redirect that sets a cookie, a request with Cookie and
    // Authorization, a WebSocket-free page load; then every event A received is scanned. ----
    cdp.events.length = 0
    await P('Network.enable')
    await P('Page.navigate', { url: `${origin}/bank/login` })
    await sleep(500)
    await P('Page.navigate', { url: `${origin}/bank/redirect` })
    await sleep(500)
    await P('Runtime.evaluate', { expression: `fetch('/bank/admin', { headers: { Authorization: 'Bearer ${AUTH_BAIT}' }, credentials: 'include' }).then(r => r.status)`, awaitPromise: true, returnByValue: true })
    await sleep(500)
    const extra = cdp.events.filter(e => /ExtraInfo$/.test(e.method)).length
    const evLeaks = secretsIn(cdp.events.filter(e => !/^Runtime\.|^Log\./.test(e.method)))
    add('cdp-events', `every event received (${cdp.events.length}, ${extra} ExtraInfo)`, evLeaks.length ? 'LEAKED' : 'SCOPED', evLeaks.join(',') || 'no secret in any event')
    assert.ok(extra > 0, 'the ExtraInfo events did come (the sweep saw the path that leaked on the bench)')

    // positive control: A USES the logged-in session (reads the page, sees the non-HttpOnly cookie)
    await P('Page.navigate', { url: `${origin}/bank/home` })
    await sleep(500)
    const pub = (await P('Runtime.evaluate', { expression: `({ state: document.getElementById('bankstate')?.textContent, pub: document.cookie.includes(${JSON.stringify(PUBLIC_OK)}) })`, returnByValue: true })).result?.result?.value
    assert.deepEqual(pub, { state: 'LOGGED-IN-AS-OWNER', pub: true }, 'the agent uses the account')
    cdp.close()
    bCdp.close()

    // ============================ 3. Playwright over the gate ============================
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${gate.port}/devtools/browser/tether`, { headers: { 'x-tether-key': KEY_A } })
    try {
      const ctx = browser.contexts()[0]!
      const pg = ctx.pages().find(p => p.url().includes('/bank')) ?? ctx.pages()[0]!
      await attempt('pw', 'context.cookies()', async () => JSON.stringify(await ctx.cookies()))
      await attempt('pw', 'context.storageState()', async () => JSON.stringify(await ctx.storageState()))
      await attempt('pw', 'response.allHeaders() / request.allHeaders() (the ExtraInfo path)', async () => {
        const [resp] = await Promise.all([pg.waitForResponse(r => r.url().includes('/bank/login'), { timeout: 8000 }), pg.goto(`${origin}/bank/login`)])
        return JSON.stringify({ resp: await resp.allHeaders(), req: await resp.request().allHeaders() })
      })
      await attempt('pw', 'newCDPSession → Network.getAllCookies', async () => JSON.stringify(await (await ctx.newCDPSession(pg)).send('Network.getAllCookies')))
      await attempt('pw', 'setInputFiles(decoy)', async () => { await pg.goto(`${origin}/up.html`); await pg.setInputFiles('#up', decoyPath); return 'attached' })
      await attempt('pw', 'page.goto(file://decoy)', async () => { await pg.goto(decoyUrl); return await pg.content() })
    } finally {
      await browser.close().catch(() => {})
    }

    // ============================ 4. the vendored MCP server as agent A ============================
    server = mcp(join(home, 'browser', 'endpoint.json'), join(keysDir, 'agent-a.key'))
    const tool = (name: string, args: object = {}): Promise<unknown> => server!.tool(name, args).then(r => (r.isError ? { error: r.text } : r.text))
    await attempt('mcp', 'WebNavigate file://decoy', () => tool('WebNavigate', { url: decoyUrl }))
    await attempt('mcp', 'WebNavigate /bank/login', () => tool('WebNavigate', { url: `${origin}/bank/login` }))
    await attempt('mcp', 'WebNavigate /bank/redirect', () => tool('WebNavigate', { url: `${origin}/bank/redirect` }))
    await attempt('mcp', 'WebNetwork (headers and bodies of the log)', () => tool('WebNetwork', { limit: 50 }))
    await attempt('mcp', 'WebEvaluate document.cookie', () => tool('WebEvaluate', { expression: 'document.cookie' }))
    await attempt('mcp', 'WebTabs (only A\'s)', () => tool('WebTabs'))
    await attempt('mcp', 'WebNavigate /up.html then WebUpload decoy', async () => { await tool('WebNavigate', { url: `${origin}/up.html` }); return tool('WebUpload', { ref: 'e1', paths: [decoyPath] }) })

    // ---- the host's truth: B untouched, the decoy unread, nothing of B's opened by A ----
    assert.equal(await hostEval(bTab, 'window.__bClicks'), 0, 'B\'s tab untouched')
    assert.ok((await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list())).some(t => t.tabId === bTab), 'B\'s tab alive')
    assert.equal(readFileSync(decoyPath, 'utf8').includes(DISK_BAIT), true)

    const count = (v: Verdict): number => rows.filter(r => r.verdict === v).length
    console.log(`escape battery: ${rows.length} attempts — ${count('REFUSED')} refused, ${count('SCOPED')} scoped, ${count('SITE-ECHO')} site echo (limit), ${count('LEAKED')} LEAKED`)
    for (const r of rows) process.stderr.write(`${r.verdict.padEnd(9)} ${r.group.padEnd(10)} ${r.vector} — ${r.detail.replace(/\s+/g, ' ').slice(0, 100)}\n`)
    assert.deepEqual(rows.filter(r => r.verdict === 'LEAKED').map(r => `${r.group} ${r.vector}`), [], 'zero leaks')
    // The refusals the Temper asked for by name (C1) are refusals, not scoped answers.
    const mustRefuse = ['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies (browser)', 'Storage.getCookies (page)', 'Network.setExtraHTTPHeaders', 'Fetch.enable', 'DOM.setFileInputFiles', 'Input.dispatchDragEvent with files', 'Network.getResponseBody', 'Emulation.setDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled(false)', 'Target.attachToTarget B', 'Target.closeTarget B', 'Page.navigate file:// decoy']
    for (const v of mustRefuse) assert.equal(rows.find(r => r.vector === v)?.verdict, 'REFUSED', v)
  } finally {
    if (server) {
      server.child.stdin.end()
      for (let i = 0; i < 20 && server.child.exitCode === null; i++) await sleep(150)
      if (server.child.exitCode === null && server.child.pid) try { process.kill(server.child.pid) } catch { /* gone */ }
    }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    bank.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
