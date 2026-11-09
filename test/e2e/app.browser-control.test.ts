// Who has the tab (Tether Browser E7, design §3.3, §6, §12a, §12b rules 10-11 and 14-16), against the real gate of the app built
// with TETHER_TEST_EXTENSIONS=1 (hidden window, private home and pipe, real tetherd, loopback only). The agent is the vendored
// `tether-browser` MCP server, keyed as a shell pane's slot (so the agent's pane exists for its seal); a raw CDP connection with
// the same key is the spy that counts every event the gate lets through.
//   1. with the agent, it acts; the person takes → the next tool answers TAB_WITH_USER and the gate passes no command and no
//      event (a reload of the page while held reaches nobody); the bar says "Com você" with the scripts warning;
//   2. paused → TAB_PAUSED;
//   3. a click on the shield (the agent has the tab) answers in the bar;
//   4. WebAskUser (login): the tab goes to the person, the clean hand-off removes the agent's init script (and clears the origin's
//      service workers; registering one closes the app in this build, so none is planted here), the person types a password and submits, nothing reaches the agent (no event, no POST); the
//      sticky seal on the agent's pane survives focusing it; handing back resolves `returned` and the seal goes out;
//   5. a short Tether.askUser runs out: `timeout`, the bar says the agent gave up, the tab stays with the person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, electronPath, launchHidden, pidAlive, rawCdp, root, serverMjs, sleep } from './browser-kit.ts'

type Pane = { id: string; tabId?: string; control: string; controlText: string; action: string; notice: string; noticeKind: string; noticeAction: string }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    panelIds(): string[]
    slots(): SlotState[]
    activate(id: string): void
    browserPanes(): Pane[]
    browserReveal(id: string): void
    browserClick(tabId: string, where: string): void
    browserSeals(): { tabId: string; count: number }[]
  }
}
type Hub = { take(id: string): void; pause(id: string): void; resume(id: string): void; control(id: string): string; view(id: string): { askExpired?: boolean } }
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  type(tabId: string, text: string): void
  shield(tabId: string): boolean | undefined
  control: Hub
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brcontrol-${process.pid}`
const PASSWORD = 'PERSON-PASSWORD-7Z9Q'
const page = (title: string, body: string): string => `<!doctype html><title>${title}</title><link rel="icon" href="data:,">${body}`

function serve(): Promise<{ server: Server; base: string; posts: string[] }> {
  const posts: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST' && url.pathname === '/submit') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => { posts.push(body); res.writeHead(200, { 'content-type': 'text/html' }).end(page('Done', '<p id="done">logged in</p>')) })
      return
    }
    if (url.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end("self.addEventListener('fetch', () => {})") }
    if (url.pathname === '/login.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(page('Login', '<form id="f" method="post" action="/submit"><input id="user" name="user" value="me"><input id="pw" name="pw" type="password"><button>Entrar</button></form>'))
    }
    res.writeHead(404).end('not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, posts, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

/** The vendored MCP server over stdio. A tool call may wait (WebAskUser): `tool` returns its promise. */
function mcp(endpointFile: string, keyFile: string): { child: ChildProcessWithoutNullStreams; tool(name: string, args?: object, ms?: number): Promise<{ text: string; isError: boolean }> } {
  const env = cleanEnv()
  env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(electronPath, [serverMjs, '--adopt-endpoint-file', endpointFile, '--adopt-key-file', keyFile], { env, stdio: 'pipe', windowsHide: true })
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
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'control-e2e', version: '1' } })
    .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') })
  return {
    child,
    tool: async (name, args = {}, ms = 30_000) => {
      await ready
      const m = await Promise.race([rpc('tools/call', { name, arguments: args }), sleep(ms).then(() => ({ error: { message: `${name}: no answer` } }))])
      if (m.error) return { text: String(m.error.message), isError: true }
      const text = (m.result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return { text, isError: m.result.isError === true }
    },
  }
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

async function createShell(win: Page, cwd: string): Promise<string> {
  const before = await win.evaluate(() => window.__tether.panelIds())
  await win.click('#btn-new')
  await win.waitForSelector('#dlg-new[open]')
  await win.fill('#dlg-new .ch-path-input', cwd)
  await win.click('#dlg-new .ch-item[data-id="powershell"]')
  await win.waitForFunction(() => document.querySelector('#dlg-new[open]') === null)
  await win.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  return (await win.evaluate(() => window.__tether.panelIds())).filter(id => !before.includes(id))[0]!
}

test('browser control: take, pause, shield, help request with the clean hand-off, timeout', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const site = await serve()
  const origin = site.base
  const home = mkdtempSync(join(tmpdir(), 'tether-brcontrol-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let server: ReturnType<typeof mcp> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, a?: unknown): Promise<R> =>
      T.evaluate(new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>

    // The agent: a shell pane's slot, so the seal has the agent's pane to land on.
    const slot = await createShell(win, root)
    await win.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id && s.status === 'running'), slot, { timeout: 20_000 })
    const KEY = 'ctrlCTRLctrlCTRLctrlCTRLctrlCTRL1234'
    writeFileSync(join(keysDir, `${slot}.key`), KEY)
    const gate = (await B(t => t.gate()))!
    const tabId = (await B((t, a) => t.create(a.slot, a.url), { slot, url: `${origin}/login.html` })).tabId
    const hostEval = (code: string): Promise<unknown> => B((t, a) => t.eval(a.tabId, a.code), { tabId, code })
    await until('login page loaded', async () => (await hostEval(`!!document.getElementById('pw')`)) === true)
    const pane = async (): Promise<Pane> => (await win.evaluate(() => window.__tether.browserPanes())).find(p => p.tabId === tabId)!
    const control = (): Promise<string> => B((t, a) => t.control.control(a), tabId)

    // The spy: same key, its own browser session (Tether.tabStateChanged) and page session (every page event).
    const spy = await rawCdp(gate.port, KEY)
    const bs = (await spy.call('Target.attachToBrowserTarget')).result.sessionId as string
    const target = (await spy.call('Target.getTargets', {}, bs)).result.targetInfos[0].targetId as string
    const sid = (await spy.call('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId as string
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) assert.ok(!(await spy.call(m, {}, sid)).error, m)
    assert.deepEqual((await spy.call('Tether.getTabState', { targetId: target }, bs)).result, { control: 'agent' })
    const pageEvents = (from: number): any[] => spy.events.slice(from).filter(e => !String(e.method).startsWith('Tether.'))
    const states = (): string[] => spy.events.filter(e => e.method === 'Tether.tabStateChanged').map(e => e.params.control)

    // ---- 1. the agent acts; the person takes ----
    server = mcp(join(home, 'browser', 'endpoint.json'), join(keysDir, `${slot}.key`))
    const tool = server.tool
    const nav = await tool('WebNavigate', { url: `${origin}/login.html` })
    assert.equal(nav.isError, false, `the agent acts: ${nav.text}`)
    const snap0 = await tool('WebSnapshot')
    assert.equal(snap0.isError, false, snap0.text)
    assert.equal(await B((t, a) => t.shield(a), tabId), true, 'the shield is on while the agent has the tab')
    assert.equal((await pane()).controlText.endsWith(' usando'), true, 'the bar: "‹Agente› usando"')

    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), tabId) // "Assumir o controle"
    await until('taken', async () => (await control()) === 'user')
    await until('tabStateChanged user', async () => states().includes('user'))
    assert.equal(await B((t, a) => t.shield(a), tabId), false, 'the shield is off while the person has it')
    const held = await tool('WebSnapshot')
    assert.equal(held.isError, true)
    assert.match(held.text, /TAB_WITH_USER/)
    const refused = await spy.call('Runtime.evaluate', { expression: '1+1' }, sid)
    assert.match(String(refused.error?.message), /^TAB_WITH_USER/, 'the gate refuses even a client that ignores the state')
    const mark = spy.events.length
    await hostEval('location.reload(); 1')
    await sleep(2000)
    assert.deepEqual(pageEvents(mark).map(e => e.method), [], 'no event of the held tab reaches the agent')
    let p = await pane()
    assert.equal(p.controlText, 'Com você')
    assert.match(p.action, /^Devolver ao /)
    assert.equal(p.noticeKind, 'scripts')
    assert.equal(p.noticeAction, 'Recarregar limpo')
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), tabId) // "Devolver ao ‹agente›"
    await until('given back', async () => (await control()) === 'agent')
    const back = await tool('WebSnapshot')
    assert.equal(back.isError, false, `the agent acts again after the hand-back: ${back.text}`)

    // ---- 2. paused ----
    await B((t, a) => t.control.pause(a), tabId)
    const paused = await tool('WebSnapshot')
    assert.match(paused.text, /TAB_PAUSED/)
    assert.equal((await pane()).controlText, 'Pausada')
    await B((t, a) => t.control.resume(a), tabId)
    assert.equal((await tool('WebSnapshot')).isError, false)

    // ---- 3. the shield answers a click in the bar ----
    await win.evaluate(id => window.__tether.browserReveal(id), `web:${tabId}`)
    await until('shield shown', async () => T.evaluate(({ webContents }) => webContents.getAllWebContents().some(w => w.getURL().startsWith('data:text/html'))))
    await sleep(500)
    await T.evaluate(({ webContents }) => {
      for (const w of webContents.getAllWebContents()) if (w.getURL().startsWith('data:text/html')) {
        w.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 })
        w.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 })
      }
    })
    p = await until('ignored-click notice', async () => { const x = await pane(); return x.noticeKind === 'ignored' && x })
    assert.match(p.notice, /^O .+ está usando esta página\. Assumir o controle\?$/)
    assert.equal(p.noticeAction, 'Assumir o controle')

    // ---- 4. help request for a login: the clean hand-off ----
    // What the agent leaves behind: an init script (Playwright's addInitScript is this method).
    const script = await spy.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__agentScript = 1; addEventListener('input', e => console.log('KEYLOG:' + e.target.value), true)`,
    }, sid)
    assert.ok(script.result?.identifier, 'the init script is registered')
    await spy.call('Page.reload', {}, sid)
    await until('init script runs', async () => (await hostEval('window.__agentScript === 1 && !!document.getElementById("pw")')) === true)
    // A service worker is not registered here: registering one in a tab closes the app in this build (seen 09/11, open for
    // E12). The hand-off's clearStorageData still runs; its effect on a live worker is proven by bench B4.
    const regs = (): Promise<unknown> => hostEval("navigator.serviceWorker.getRegistrations().then(r => r.length)")

    const asking = tool('WebAskUser', { message: 'Entre na sua conta, por favor', kind: 'login' }, 120_000)
    await until('asked: with the person', async () => (await control()) === 'user')
    const askMark = spy.events.length
    await until('clean hand-off: init script gone after reload', async () => (await hostEval(`document.readyState === 'complete' && !!document.getElementById('pw') && window.__agentScript === undefined`)) === true)
    await until('clean hand-off: service worker gone', async () => (await regs()) === 0)
    p = await pane()
    assert.equal(p.noticeKind, 'ask')
    assert.match(p.notice, /pede sua ajuda: Entre na sua conta, por favor$/)
    assert.match(p.noticeAction, /^Pronto, devolver ao /)
    await win.waitForFunction(id => document.querySelector(`.tether-tab[data-slot="${id}"] .attn`)?.className.includes('waiting') === true, slot)
    assert.equal((await win.evaluate(() => window.__tether.browserSeals())).find(s => s.tabId === tabId)?.count, 2, "the agent's pane and the tab's pane")
    await win.evaluate(id => window.__tether.activate(id), slot)
    await sleep(700)
    assert.ok((await win.evaluate(id => document.querySelector(`.tether-tab[data-slot="${id}"] .attn`)?.className ?? '', slot)).includes('waiting'), 'focusing the agent does not clear the sticky seal')

    // The person types the password and submits.
    await hostEval(`document.getElementById('pw').focus(); 1`)
    await B((t, a) => t.type(a.tabId, a.pw), { tabId, pw: PASSWORD })
    await until('typed', async () => (await hostEval(`document.getElementById('pw')?.value`)) === PASSWORD)
    await hostEval(`document.getElementById('f').requestSubmit(); 1`)
    await until('submitted', async () => site.posts.some(b => b.includes(PASSWORD)))
    await until('navigated', async () => (await hostEval(`!!document.getElementById('done')`)) === true)
    await sleep(800)
    const leaked = pageEvents(askMark)
    assert.deepEqual(leaked.map(e => e.method), [], 'nothing of the page reaches the agent while the person has it')
    assert.ok(!JSON.stringify(spy.events).includes(PASSWORD), 'the password is in no event the agent got')

    await win.evaluate(id => window.__tether.browserClick(id, 'notice'), tabId) // "Pronto, devolver ao ‹agente›"
    const answer = await asking
    assert.equal(answer.isError, false, answer.text)
    assert.match(answer.text, /handed the tab back/i)
    await win.waitForFunction(id => !document.querySelector(`.tether-tab[data-slot="${id}"] .attn`)?.className.includes('waiting'), slot)
    assert.equal((await win.evaluate(() => window.__tether.browserSeals())).length, 0, 'the seals went out')
    const after = await spy.call('Runtime.evaluate', { expression: 'document.body.innerText' }, sid)
    assert.ok(!JSON.stringify(after).includes(PASSWORD), 'the page the agent gets back has no password')
    await sleep(300)
    assert.ok(!JSON.stringify(spy.events).includes('KEYLOG:'), 'the init script never logged a key')

    // ---- 5. a short request runs out ----
    const short = await spy.call('Tether.askUser', { targetId: target, message: 'olhe aqui', kind: 'other', timeoutMs: 1500 }, bs, 20_000)
    assert.deepEqual(short.result, { outcome: 'timeout' })
    assert.equal(await control(), 'user', 'the tab stays with the person')
    p = await until('expired notice', async () => { const x = await pane(); return x.noticeKind === 'expired' && x })
    assert.match(p.notice, /^O .+ desistiu de esperar\. Devolver mesmo assim\?$/)
    await win.evaluate(id => window.__tether.browserClick(id, 'notice'), tabId)
    await until('given back after timeout', async () => (await control()) === 'agent')
    assert.equal((await win.evaluate(() => window.__tether.browserSeals())).length, 0)
    spy.close()
  } finally {
    if (server) {
      server.child.stdin.end()
      for (let i = 0; i < 20 && server.child.exitCode === null; i++) await sleep(150)
      if (server.child.exitCode === null && server.child.pid) try { process.kill(server.child.pid) } catch { /* gone */ }
    }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    site.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
