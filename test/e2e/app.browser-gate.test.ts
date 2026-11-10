// E2E of the CDP gatekeeper (Tether Browser E5): the app built with TETHER_TEST_EXTENSIONS=1, hidden window, private home and
// pipe, real tetherd, CLAUDE* stripped, loopback only. The test writes two agents' keys in <home>/browser/keys (the daemon side
// does it in E8) and drives the gate two ways:
//   1. raw HTTP/WebSocket: identity without key, key refused (absent, unknown, deleted), Origin refused, and isolation — agent A
//      neither sees nor reaches agent B's tab (getTargets, attachToTarget, closeTarget), B's live connection drops when its key
//      is deleted;
//   2. the conformance battery (a representative subset of bench S2/B1, through MCP tools): the VENDORED `tether-browser`
//      server (extensions/browser/vendor/tether-browser/server.mjs) run by the repo's Electron as Node, over stdio, as agent A.
//      E6/E6b: dialogs and captures (viewport, element, full page) of the hidden tab pass; only the resize fails, on purpose;
//   3. E6, raw CDP: the remappings (resize refused by name, focus on answered, off refused, bringToFront without effect, input
//      scaled), a hidden tab's capture at the asked size, a dialog that stays open until the agent answers (no native box),
//      commands of one session kept in order behind a navigation that waits, schemes, refusals by domain;
//   4. E6b, no native surface: HTTP authentication cancelled (and the next tab still opens), `window.print` replaced in the page
//      and its frame, the page's file input intercepted on the core's own session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, electronPath, launchHidden, pidAlive, rawCdp, root, serverMjs, sleep } from './browser-kit.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[] }
  gate(): Promise<{ port: number; instance: string; connections: { slotId: string }[] } | null>
}

const pipe = `\\\\.\\pipe\\tether-brgate-${process.pid}`
const KEY_A = 'aaaaAAAAbbbbBBBBccccCCCCddddDDDDeeee'
const KEY_B = 'bbbbBBBBccccCCCCddddDDDDeeeeEEEEffff'

const PAGES: Record<string, string> = {
  '/a.html': `<!doctype html><title>Page A</title><link rel="icon" href="data:,">
<h1>AGENT-A-CONTENT</h1>
<button id="btn" onclick="window.__clicks.push({isTrusted: event.isTrusted})">Click me</button>
<input id="name" aria-label="name" oninput="document.getElementById('echo').textContent = this.value">
<span id="echo"></span>
<select aria-label="choice"><option>one</option><option>two</option></select>
<label><input type="checkbox" id="chk"> agree</label>
<a href="/two.html">Go to page two</a>
<button onclick="window.__dialogs.push(alert('hi'))">Show alert</button>
<button onclick="window.__dialogs.push(confirm('sure?'))">Ask confirm</button>
<button onclick="window.open('/pop.html')">Open popup</button>
<div style="height:2000px"></div>
<script>window.__clicks = []; window.__dialogs = []; console.log('page a ready')</script>`,
  '/two.html': '<!doctype html><title>Page two</title><link rel="icon" href="data:,"><h1>PAGE-TWO</h1>',
  '/pop.html': '<!doctype html><title>Popup</title><link rel="icon" href="data:,"><h1>POPUP-CONTENT</h1>',
  '/native.html': `<!doctype html><title>Native</title><link rel="icon" href="data:,">
<input type="file" id="f"><iframe id="fr" src="/two.html"></iframe>`,
  '/b.html': '<!doctype html><title>Page B</title><link rel="icon" href="data:,"><h1>AGENT-B-CONTENT</h1><script>window.__bClicks = 0; addEventListener("click", () => window.__bClicks++)</script>',
}

/** Requests to `/auth`, and those that carried credentials (a page's HTTP authentication must be cancelled: never any). */
let authAsked = 0
let authAnswered = 0

function servePages(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/auth') {
      authAsked++
      if (req.headers.authorization) authAnswered++
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'www-authenticate': 'Basic realm="tether-e2e"' })
      res.end('<!doctype html><title>Denied</title><h1>AUTH-DENIED</h1>')
      return
    }
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body ?? 'not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

/** The vendored MCP server over stdio (newline-delimited JSON-RPC). */
function mcp(endpointFile: string, keyFile: string): { child: ChildProcessWithoutNullStreams; tool(name: string, args?: object): Promise<{ text: string; isError: boolean }>; stderr: () => string } {
  const env = cleanEnv()
  env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(electronPath, [serverMjs, '--adopt-endpoint-file', endpointFile, '--adopt-key-file', keyFile, '--allow-evaluate'], { env, stdio: 'pipe', windowsHide: true })
  const pending = new Map<number, (m: any) => void>()
  let buf = ''
  let err = ''
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
  child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
  const rpc = (method: string, params: object): Promise<any> => new Promise(r => {
    const id = ++next
    pending.set(id, r)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate-e2e', version: '1' } })
    .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') })
  return {
    child,
    stderr: () => err,
    tool: async (name, args = {}) => {
      await ready
      const m = await rpc('tools/call', { name, arguments: args })
      if (m.error) return { text: String(m.error.message), isError: true }
      const text = (m.result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return { text, isError: m.result.isError === true }
    },
  }
}

test('browser gate: endpoint, keys, isolation between agents, and the conformance battery through the vendored MCP server', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const pages = await servePages()
  const home = mkdtempSync(join(tmpdir(), 'tether-brgate-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  writeFileSync(join(keysDir, 'agent-a.key'), KEY_A)
  writeFileSync(join(keysDir, 'agent-b.key'), KEY_B)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let server: ReturnType<typeof mcp> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const gate = await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.gate())
    assert.ok(gate, 'the gate is open')
    const endpointFile = join(home, 'browser', 'endpoint.json')
    const endpoint = JSON.parse(readFileSync(endpointFile, 'utf8'))
    assert.deepEqual(endpoint, { v: 1, port: gate.port, pid: endpoint.pid, instance: gate.instance })
    const base = `http://127.0.0.1:${gate.port}`

    // ---- 1. the endpoint's routes and refusals ----
    const id = await fetch(`${base}/tether/identity`)
    assert.equal(id.status, 200)
    assert.deepEqual(await id.json(), { instance: gate.instance })
    assert.equal((await fetch(`${base}/json/version`)).status, 401, 'no key')
    assert.equal((await fetch(`${base}/json/version`, { headers: { 'x-tether-key': 'zzzzZZZZzzzzZZZZzzzzZZZZ' } })).status, 401, 'unknown key')
    const okVersion = await fetch(`${base}/json/version`, { headers: { 'x-tether-key': KEY_A } })
    assert.equal(okVersion.status, 200)
    assert.match((await okVersion.json()).webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/tether$/)
    assert.equal((await fetch(`${base}/json/version`, { headers: { 'x-tether-key': KEY_A, origin: 'http://evil.test' } })).status, 403, 'Origin refused')
    assert.equal((await fetch(`${base}/tether/identity`, { headers: { origin: 'http://evil.test' } })).status, 403, 'Origin refused on identity too')
    assert.equal((await fetch(`${base}/json/version`, { headers: { 'x-tether-key': KEY_A, referer: 'http://evil.test/' } })).status, 403, 'Referer refused')
    assert.equal((await fetch(`${base}/json/list`, { headers: { 'x-tether-key': KEY_A } })).status, 404)
    await assert.rejects(rawCdp(gate.port, 'zzzzZZZZzzzzZZZZzzzzZZZZ'), 'a WebSocket with an unknown key is refused')

    // ---- 2. isolation: B's tab is invisible and unreachable for A ----
    const bTab = await T.evaluate(async (_e, url) => (await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.create('agent-b', url)).tabId, `${pages.base}/b.html`)
    const b = await rawCdp(gate.port, KEY_B)
    const bTargets = (await b.call('Target.getTargets')).result.targetInfos
    assert.equal(bTargets.length, 1, 'B sees its own tab')
    const bTarget = bTargets[0].targetId as string
    const a = await rawCdp(gate.port, KEY_A)
    assert.deepEqual((await a.call('Target.getTargets')).result.targetInfos, [], 'A sees none of B\'s tabs')
    assert.ok((await a.call('Target.attachToTarget', { targetId: bTarget, flatten: true })).error, 'A cannot attach to B\'s tab')
    assert.ok((await a.call('Target.closeTarget', { targetId: bTarget })).error, 'A cannot close B\'s tab')
    assert.ok((await a.call('Target.getTargetInfo', { targetId: bTarget })).error, 'A cannot read B\'s tab info')
    const bogus = await a.call('Runtime.evaluate', { expression: '1' }, 'NOT-A-SESSION')
    assert.ok(bogus.error, 'a session id A was not given is unknown')
    const bSession = (await b.call('Target.attachToTarget', { targetId: bTarget, flatten: true })).result.sessionId as string
    assert.ok((await a.call('Runtime.evaluate', { expression: 'document.title' }, bSession)).error, 'B\'s session id is unknown to A')
    assert.equal((await b.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, bSession)).result.result.value, 'Page B')
    assert.match((await b.call('Network.getAllCookies', {}, bSession)).error.message, /wasn't found/, 'off the strict list')
    assert.match((await b.call('Storage.getCookies')).error.message, /wasn't found/, 'off the browser-level list')
    assert.ok((await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list().map(t => t.tabId))).includes(bTab), 'B\'s tab is alive')
    a.close()

    // ---- 3. the battery: the vendored MCP server as agent A ----
    server = mcp(endpointFile, join(keysDir, 'agent-a.key'))
    const steps: { name: string; ok: boolean; note: string }[] = []
    const step = async (name: string, fn: () => Promise<string | void>, expectFail = false): Promise<string> => {
      let note = ''
      let ok = false
      try { note = (await fn()) ?? ''; ok = true } catch (e) { note = (e as Error).message.slice(0, 200) }
      steps.push({ name, ok, note })
      process.stderr.write(`${ok ? 'OK  ' : (expectFail ? 'FAIL (expected)' : 'FAIL')} ${name} ${note.replace(/\s+/g, ' ').slice(0, 160)}\n`)
      return note
    }
    const tool = async (name: string, args: object = {}): Promise<string> => {
      const r = await Promise.race([server!.tool(name, args), sleep(30_000).then(() => ({ text: `${name}: no answer in 30 s`, isError: true }))])
      if (r.isError) throw new Error(r.text)
      return r.text
    }
    const aTab = async (): Promise<string> => {
      const list = await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list())
      return list.find(t => t.ownerSlotId === 'agent-a' && /a\.html/.test(t.url))?.tabId ?? ''
    }
    const host = async (code: string): Promise<any> => T.evaluate(async (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(a.tab, a.code), { tab: await aTab(), code })
    const refOf = (tree: string, pattern: string): string => new RegExp(`${pattern}[^\\n]*\\[ref=(\\w+)\\]`).exec(tree)?.[1] ?? 'missing'
    let tree = ''

    const first = steps.length
    await step('navigate a.html (first tool creates the first tab)', () => tool('WebNavigate', { url: `${pages.base}/a.html` }))
    if (!steps[first]!.ok && process.env.TETHER_GATE_TRACE) { writeFileSync(`${process.env.TETHER_GATE_TRACE}.mcp.log`, server.stderr()); throw new Error('first tool failed') }
    await step('snapshot', async () => { tree = await tool('WebSnapshot'); if (!/Click me/.test(tree)) throw new Error('no button in tree') })
    const r = { btn: refOf(tree, 'button "Click me"'), name: refOf(tree, 'textbox'), lnk: refOf(tree, 'link "Go to page two"'), sel: refOf(tree, 'combobox'), chk: refOf(tree, 'checkbox'), alrt: refOf(tree, 'button "Show alert"'), cnf: refOf(tree, 'button "Ask confirm"'), pop: refOf(tree, 'button "Open popup"') }
    await step('click button (real pointer)', () => tool('WebClick', { ref: r.btn }))
    await step('page registered a trusted click (host truth)', async () => {
      const c = await host('window.__clicks')
      if (c.length !== 1 || !c[0].isTrusted) throw new Error(JSON.stringify(c))
    })
    await step('fill textbox', () => tool('WebFill', { ref: r.name, text: 'hello tether' }))
    await step('type more', () => tool('WebType', { text: ' ok', ref: r.name }))
    await step('typed value (host truth)', async () => { const v = await host('document.getElementById("name").value'); if (v !== 'hello tether ok') throw new Error(String(v)) })
    await step('pressKey Tab', () => tool('WebPressKey', { key: 'Tab' }))
    await step('screenshot (viewport)', async () => (await tool('WebScreenshot')).slice(0, 80))
    await step('screenshot (element)', async () => (await tool('WebScreenshot', { ref: r.btn })).slice(0, 80))
    await step('screenshot (fullPage)', async () => (await tool('WebScreenshot', { fullPage: true })).slice(0, 80))
    await step('read page', async () => { const t = await tool('WebRead'); if (!/AGENT-A-CONTENT/.test(t)) throw new Error(t.slice(0, 100)) })
    await step('find buttons', () => tool('WebFind', { role: 'button' }))
    await step('links', () => tool('WebLinks'))
    await step('hover link', () => tool('WebHover', { ref: r.lnk }))
    await step('select option', () => tool('WebSelectOption', { ref: r.sel, label: 'two' }))
    await step('set checked', () => tool('WebSetChecked', { ref: r.chk, checked: true }))
    await step('scroll by', () => tool('WebScroll', { byY: 200 }))
    await step('scroll to top', () => tool('WebScroll', { to: 'top' }))
    await step('wait for text', () => tool('WebWait', { text: 'AGENT-A-CONTENT', timeoutMs: 3000 }))
    await step('console', async () => { const t = await tool('WebConsole'); if (!/page a ready/.test(t)) throw new Error(t.slice(0, 100)) })
    await step('network', () => tool('WebNetwork'))
    await step('click opens alert', async () => { const t = await tool('WebClick', { ref: r.alrt }); if (!/dialog|alert/i.test(t)) throw new Error(t.slice(0, 120)) })
    await step('resolve dialog', () => tool('WebDialog', { accept: true }))
    await step('confirm accepted (host truth)', async () => {
      await tool('WebClick', { ref: r.cnf })
      await tool('WebDialog', { accept: true })
      await sleep(200)
      const d = await host('window.__dialogs')
      if (JSON.stringify(d) !== JSON.stringify([null, true])) throw new Error(JSON.stringify(d))
    })
    await step('click opens popup (a tab of the same owner)', () => tool('WebClick', { ref: r.pop }))
    const tabsText = await step('tabs list has the popup', async () => {
      const deadline = Date.now() + 8000
      let t = ''
      while (Date.now() < deadline) { t = await tool('WebTabs'); if (/pop\.html/.test(t)) return t; await sleep(300) }
      throw new Error(t.slice(0, 200))
    })
    const popId = (() => { try { return (JSON.parse(tabsText) as { id: string; url: string }[]).find(t => /pop\.html/.test(t.url))?.id } catch { return undefined } })()
    await step('close popup tab (explicit close)', () => tool('WebCloseTab', { tab: popId ?? 'missing' }))
    await step('click link (navigates)', () => tool('WebClick', { ref: r.lnk }))
    await step('navigate back', () => tool('WebNavigate', { url: `${pages.base}/a.html` }))
    await step('newTab (the gate creates it)', () => tool('WebNewTab', { url: `${pages.base}/two.html` }))
    await step('host created the new tab for agent-a', async () => {
      const list = await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list())
      if (!list.some(t => t.ownerSlotId === 'agent-a' && /two\.html/.test(t.url))) throw new Error(JSON.stringify(list))
    })
    await step('snapshot of the new tab', async () => { const t = await tool('WebSnapshot'); if (!/PAGE-TWO/.test(t)) throw new Error(t.slice(0, 100)) })
    await step('resize (refused on purpose: the page size is the tether\'s)', () => tool('WebResize', { width: 480, height: 320 }), true)
    await step('evaluate', async () => { const t = await tool('WebEvaluate', { expression: '6*7' }).catch(() => tool('WebEvaluate', { code: '6*7' })); if (!/42/.test(t)) throw new Error(t) })
    await step('B\'s tab untouched (host truth)', async () => {
      const n = await T.evaluate(async (_e, tab) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(tab, 'window.__bClicks'), bTab)
      if (n !== 0) throw new Error(`B clicks: ${n}`)
    })
    if (process.env.TETHER_GATE_TRACE) writeFileSync(`${process.env.TETHER_GATE_TRACE}.mcp.log`, server.stderr())
    const failed = steps.filter(s => !s.ok)
    console.log(`battery: ${steps.length - failed.length}/${steps.length} steps ok; failed: ${failed.map(f => f.name).join(' | ')}`)
    // Only the resize fails, on purpose (rule 3): a hidden tab's viewport and full-page captures pass (E6b: the core keeps it drawing).
    assert.deepEqual(failed.map(f => f.name), ['resize (refused on purpose: the page size is the tether\'s)'], 'only the resize fails')

    // ---- 3b. E6, raw CDP as agent A: remappings, captures, dialogs, order, schemes ----
    const ra = await rawCdp(gate.port, KEY_A)
    const aTarget = ((await ra.call('Target.getTargets')).result.targetInfos as { targetId: string; url: string }[]).find(t => /a\.html/.test(t.url))
    assert.ok(aTarget, 'A\'s a.html tab')
    const rs = (await ra.call('Target.attachToTarget', { targetId: aTarget.targetId, flatten: true })).result.sessionId as string
    const P = (m: string, p: object = {}): Promise<any> => ra.call(m, p, rs)
    await P('Page.enable')
    await P('Runtime.enable')
    const resize = await P('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false })
    assert.match(resize.error?.message ?? '', /refused by the gate: the page size is fixed by the tether/, 'resize refused by name')
    assert.deepEqual((await P('Emulation.setFocusEmulationEnabled', { enabled: true })).result, {}, 'focus on: answered')
    assert.match((await P('Emulation.setFocusEmulationEnabled', { enabled: false })).error?.message ?? '', /refused/, 'focus off: refused')
    assert.deepEqual((await P('Page.bringToFront')).result, {}, 'bringToFront answered without effect')
    assert.match((await P('Storage.getCookies')).error?.message ?? '', /the Storage domain/, 'refusal names the domain')
    assert.match((await P('Network.getResponseBody', { requestId: '1' })).error?.message ?? '', /body/, 'getResponseBody refused')
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'chrome://gpu', 'devtools://devtools/bundled/inspector.html', 'view-source:http://x/', 'data:text/html,x']) {
      assert.match((await P('Page.navigate', { url })).error?.message ?? '', /only http\(s\) and about:blank/, url)
    }
    // A dialog stays open, with no native box, until the agent answers it.
    ra.events.length = 0
    await P('Runtime.evaluate', { expression: `setTimeout(() => { window.__e6 = confirm('e6?') }, 10); 1` })
    await sleep(1000)
    const opened = ra.events.filter(e => e.method === 'Page.javascriptDialogOpening').length
    const closedEarly = ra.events.filter(e => e.method === 'Page.javascriptDialogClosed').length
    assert.deepEqual([opened, closedEarly], [1, 0], 'the dialog opened and is still open after 1 s')
    assert.deepEqual((await P('Page.handleJavaScriptDialog', { accept: true })).result, {}, 'the agent answers it')
    await sleep(200)
    assert.equal(await host('window.__e6'), true, 'confirm() returned the agent\'s answer')
    // Order: a navigation that waits (the local-network check) and a blank-page navigation sent right behind it reach the
    // debugger in that order: the page ends on the blank page (out of order, the http one would land last).
    const aTabId = await aTab()
    await Promise.all([P('Page.navigate', { url: `${pages.base}/two.html` }), P('Page.navigate', { url: 'about:blank' })])
    await sleep(1500)
    const href = await T.evaluate(async (_e, tab) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(tab, 'location.href'), aTabId)
    assert.equal(href, 'about:blank', 'the second navigation went out second')
    ra.close()

    // ---- 3c. E6b: no native surface opens from the page; the main process keeps answering ----
    type Hook = { __browserTabs: Tabs & { registry: { surface(tabId: string): { debugger: { onMessage(l: (m: string, p: unknown, s?: string) => void): { dispose(): void } } } } } }
    const pageEval = (tab: string, code: string): Promise<any> => T.evaluate(async (_e, a) => (globalThis as unknown as Hook).__browserTabs.eval(a.tab, a.code), { tab, code })
    const newTab = (url: string): Promise<string> => T.evaluate(async (_e, u) => (await (globalThis as unknown as Hook).__browserTabs.create('agent-a', u)).tabId, url)
    const until = async (tab: string, code: string, ok: (v: any) => boolean): Promise<any> => {
      let v: any
      for (let i = 0; i < 40; i++) { v = await pageEval(tab, code).catch(() => undefined); if (ok(v)) return v; await sleep(250) }
      return v
    }
    // HTTP authentication: the page gets its 401, nobody answers it, and another tab still opens right after (E6's hang: a tab
    // listener answering the egress proxy's challenge a second time froze the main process).
    const authTab = await newTab(`${pages.base}/auth`)
    assert.match(String(await until(authTab, 'document.body.textContent', v => /AUTH-DENIED/.test(String(v)))), /AUTH-DENIED/, 'the 401 page shows (authentication cancelled, no box)')
    assert.ok(authAsked >= 1, 'the page asked for authentication')
    assert.equal(authAnswered, 0, 'no credential was ever sent')
    const after = await Promise.race([newTab(`${pages.base}/native.html`), sleep(10_000).then(() => 'TIMEOUT')])
    assert.notEqual(after, 'TIMEOUT', 'the next tab opens after an authentication challenge')
    const nativeTab = after
    assert.equal(await until(nativeTab, `!!document.getElementById('fr')?.contentWindow?.document.querySelector('h1')`, v => v === true), true, 'native.html and its frame loaded')
    // window.print: replaced before the page ran, in the page and its frame, and the page cannot put it back. Checked before it is
    // called: a real print() would open the system's box.
    const printOf = (where: string): Promise<any> => pageEval(nativeTab, `(() => { const w = ${where}; const d = Object.getOwnPropertyDescriptor(w, 'print'); return { configurable: d?.configurable, writable: d?.writable, native: /native code/.test(String(w.print)) } })()`)
    assert.deepEqual(await printOf('window'), { configurable: false, writable: false, native: false }, 'print replaced in the page')
    assert.deepEqual(await printOf(`document.getElementById('fr').contentWindow`), { configurable: false, writable: false, native: false }, 'print replaced in the frame')
    assert.deepEqual(await pageEval(nativeTab, `(() => { try { window.print = () => 1 } catch {} try { delete window.print } catch {} return [window.print() ?? null, /native code/.test(String(window.print))] })()`), [null, false], 'print() does nothing and stays replaced')
    // The native file chooser: a click of the page's <input type=file> (with a user gesture) is intercepted on the core's own
    // session (Page.fileChooserOpened there, host truth), so no box opens; the agent's session never sees it.
    await T.evaluate((_e, tab) => {
      const g = globalThis as unknown as Hook & { __rootEvents: string[]; __rootSub: { dispose(): void } }
      g.__rootEvents = []
      g.__rootSub = g.__browserTabs.registry.surface(tab).debugger.onMessage((m, _p, sid) => { if (!sid) g.__rootEvents.push(m) })
    }, nativeTab)
    const rn = await rawCdp(gate.port, KEY_A)
    const nTarget = ((await rn.call('Target.getTargets')).result.targetInfos as { targetId: string; url: string }[]).find(t => /native\.html/.test(t.url))
    assert.ok(nTarget, 'A sees the native tab')
    const ns = (await rn.call('Target.attachToTarget', { targetId: nTarget.targetId, flatten: true })).result.sessionId as string
    await rn.call('Page.enable', {}, ns)
    rn.events.length = 0
    await rn.call('Runtime.evaluate', { expression: `document.getElementById('f').click(); 'clicked'`, userGesture: true }, ns)
    const rootEvents = (): Promise<string[]> => T.evaluate(() => (globalThis as unknown as { __rootEvents: string[] }).__rootEvents)
    for (let i = 0; i < 20 && !(await rootEvents()).includes('Page.fileChooserOpened'); i++) await sleep(150)
    assert.ok((await rootEvents()).includes('Page.fileChooserOpened'), 'the chooser was intercepted on the core\'s session (no native box)')
    assert.equal(rn.events.filter(e => e.method === 'Page.fileChooserOpened').length, 0, 'the agent\'s session did not see it')
    assert.equal(await pageEval(nativeTab, `document.getElementById('f').files.length`), 0, 'no file was chosen')
    await T.evaluate(() => (globalThis as unknown as { __rootSub: { dispose(): void } }).__rootSub.dispose())
    rn.close()

    // ---- 4. a deleted key: refused, and its live connection drops ----
    unlinkSync(join(keysDir, 'agent-b.key'))
    const dropped = await Promise.race([b.closed.then(() => true), sleep(4000).then(() => false)])
    assert.ok(dropped, 'B\'s live connection closed after its key was deleted')
    assert.equal((await fetch(`${base}/json/version`, { headers: { 'x-tether-key': KEY_B } })).status, 401, 'deleted key refused')
    assert.ok((await T.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list().map(t => t.tabId))).includes(bTab), 'B\'s tab stays (an agent that exits keeps its tabs)')
  } finally {
    if (server) {
      server.child.stdin.end()
      for (let i = 0; i < 20 && server.child.exitCode === null; i++) await sleep(150)
      if (server.child.exitCode === null && server.child.pid) try { process.kill(server.child.pid) } catch { /* gone */ }
    }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    pages.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
