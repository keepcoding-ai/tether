// Who has the tab (Tether Browser E7, design §3.3, §6, §12a, §12b rules 10-11 and 14-16), against the real gate of the app built
// with TETHER_TEST_EXTENSIONS=1 (hidden window, private home and pipe, real tetherd, loopback only). The agent is the vendored
// `tether-browser` MCP server, keyed as a shell pane's slot (so the agent's pane exists for its seal); a raw CDP connection with
// the same key is the spy that counts every event the gate lets through.
//   1. with the agent, it acts; the person takes → the next tool answers TAB_WITH_USER and the gate passes no command and no
//      event (a reload of the page while held reaches nobody); the bar says "Com você" with the scripts warning;
//   2. paused → TAB_PAUSED;
//   3. a click on the shield (the agent has the tab) answers in the bar;
//   4. WebAskUser (login): the tab goes to the person, the clean hand-off removes the agent's init script and the service worker
//      the agent's page registered (E7b), the person types a password and submits, nothing reaches the agent (no event, no POST); the
//      sticky seal on the agent's pane survives focusing it; handing back resolves `returned` and the seal goes out;
//   5. a short Tether.askUser runs out: `timeout`, the bar says the agent gave up, the tab stays with the person;
// E7c (the gatekeeper's security review):
//   6. H1b: a `Runtime.evaluate` awaiting a promise when the person takes answers TAB_WITH_USER at once, never the value the
//      page produced in her turn; H2: a bait the page writes to the console (and the log) in her turn reaches the agent neither
//      through the resync after the hand-back nor through a new session that enables Runtime and Log;
//   7. H1a/M1: a help request of kind 'other' gets the clean hand-off (the agent's init script is gone) and its hand-back reloads
//      (what the person typed and did not send is gone); the login hand-back of step 4 posted nothing again;
//   8. H3: a page opening popups in a loop ends with at most 3 more tabs, the app alive and the seal on the tab; M3: a capture
//      with scale 50 is refused by the gate.
// A second test (E12, E14), with a real agent (an inert "soul" slot) and no MCP:
//   9. "Sair de todas as contas": the confirmation of the design (cancelling changes nothing); confirming clears the cookie and the
//      storage the local site planted, reloads the open tab without the session, and leaves one log line with no address;
//  10. a pending help request reaches the system tray ("Agente pede ajuda em site: mensagem", the attention badge and count), a click
//      on the Browser pill and on the pad's icon takes the person to the OLDEST request (not the first in the list), and handing it
//      back moves the way to the next; with none left the tray has no notice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { FAKE_SOUL_CMD as FAKE_SOUL, cleanEnv, daemonMain, electronPath, launchHidden, pidAlive, rawCdp, root, serverMjs, sleep, inBrowser } from './browser-kit.ts'

type Pane = { id: string; tabId?: string; control: string; controlText: string; action: string; notice: string; noticeKind: string; noticeAction: string; front?: boolean }
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
    browserPadOpen(): void
    openSlot(id: string): Promise<void>
    activeDesk(): string
    switchDesk(id: string): void
  }
  tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> }
}
type Hub = {
  take(id: string): void; pause(id: string): void; resume(id: string): void; giveBack(id: string): Promise<void>; control(id: string): string
  view(id: string): { askExpired?: boolean }
  ask(id: string, owner: string, input: { message: string; kind: 'login' | 'other'; timeoutMs: number }): unknown
}
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  type(tabId: string, text: string): void
  load(tabId: string, url: string): Promise<string> | undefined
  allowOnce(tabId: string, url: string): unknown
  shield(tabId: string): boolean | undefined
  control: Hub
  gate(): Promise<{ port: number } | null>
  registry: { list(): { tabId: string; ownerSlotId: string; popupsRefused?: number }[]; close(tabId: string): void }
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

/** An agent (an inert "soul" slot, E12: a shell is no agent, so its tabs would be "encerradas") with its pane open. */
async function createAgent(win: Page, cwd: string): Promise<string> {
  return win.evaluate(async dir => {
    const r = await (window as unknown as { tether: { request(r: unknown): Promise<{ slot?: { slotId: string } }> } }).tether.request({ t: 'create', kind: 'soul', cwd: dir, name: 'Sonda', start: true })
    await window.__tether.openSlot(r.slot!.slotId)
    return r.slot!.slotId
  }, cwd)
}

test('browser control: take, pause, shield, help request with the clean hand-off, timeout, in-flight answers, console, popups', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const site = await serve()
  const origin = site.base
  const soulBefore = process.env.TETHER_SOUL_CMD
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
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
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>

    // The agent: a shell pane's slot, so the seal has the agent's pane to land on.
    const slot = await createAgent(win, root)
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
    // And a service worker, registered through the agent's page session (it survives a reload: rule 15). The gate never attaches
    // it (E7b: detaching one crashed the main), so the agent's auto-attach announces nothing for it.
    const regs = (): Promise<unknown> => hostEval("navigator.serviceWorker.getRegistrations().then(r => r.length)")
    const planted = await spy.call('Runtime.evaluate', { expression: "navigator.serviceWorker.register('/sw.js').then(r => r.scope)", awaitPromise: true, returnByValue: true }, sid)
    assert.equal(planted.result?.result?.value, `${origin}/`, `the agent's page registers a worker: ${JSON.stringify(planted)}`)
    await until('the worker is active', async () => (await hostEval("navigator.serviceWorker.getRegistrations().then(r => r.length === 1 && !!r[0].active)")) === true)
    assert.ok(!spy.events.some(e => e.method === 'Target.attachedToTarget' && e.params?.targetInfo?.type === 'service_worker'), 'the worker is not announced')

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

    // ---- 6. H1b: the answer in flight; H2: the console of the person's turn ----
    assert.ok(!(await spy.call('Page.navigate', { url: `${origin}/login.html` }, sid)).error)
    await until('login page again', async () => (await hostEval(`document.readyState === 'complete' && !!document.getElementById('pw')`)) === true)
    const inflight = spy.call('Runtime.evaluate', { expression: 'new Promise(r => { window.__h1 = r })', awaitPromise: true, returnByValue: true }, sid, 20_000)
    await until('the promise waits in the page', async () => (await hostEval('typeof window.__h1')) === 'function')
    await B((t, a) => t.control.take(a), tabId)
    await until('taken (6)', async () => (await control()) === 'user')
    await hostEval(`window.__h1('SECRET-H1B'); console.log('BAIT-H2-CONSOLE'); console.error('BAIT-H2-ERROR'); fetch('/bait-H2-LOG').catch(() => {}); 1`)
    const late = await inflight
    assert.match(String(late.error?.message), /^TAB_WITH_USER/, `the answer in flight is the held error: ${JSON.stringify(late)}`)
    assert.ok(!JSON.stringify(spy.events).includes('SECRET-H1B') && !JSON.stringify(late).includes('SECRET-H1B'), 'the value of her turn never reaches the agent')
    await sleep(500)
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), tabId) // manual take: handed back without a reload
    await until('given back (6)', async () => (await control()) === 'agent')
    await sleep(1200) // the resync's Runtime.disable/enable
    const fresh = (await spy.call('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId as string
    for (const m of ['Runtime.enable', 'Log.enable']) assert.ok(!(await spy.call(m, {}, fresh)).error, m)
    await sleep(800)
    const baits = spy.events.filter(e => JSON.stringify(e).includes('BAIT-H2') || JSON.stringify(e).includes('bait-H2'))
    assert.deepEqual(baits.map(e => `${e.method} ${e.sessionId === fresh ? 'new session' : 'resync'}`), [], 'the bait of her turn reaches the agent by no way')
    await spy.call('Target.detachFromTarget', { sessionId: fresh }, bs)

    // ---- 7. H1a/M1: a request of kind 'other' ----
    assert.equal(site.posts.filter(b => b.includes(PASSWORD)).length, 1, 'the login hand-back reloaded without posting the form again')
    const script2 = await spy.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__agentScript2 = 1' }, sid)
    assert.ok(script2.result?.identifier)
    await hostEval('location.reload(); 1')
    await until('init script 2 runs', async () => (await hostEval('window.__agentScript2 === 1 && document.readyState === "complete" && !!document.getElementById("pw")')) === true)
    const other = spy.call('Tether.askUser', { targetId: target, message: 'Entre na sua conta', kind: 'other', timeoutMs: 120_000 }, bs, 120_000)
    await until('asked (other): with the person', async () => (await control()) === 'user')
    await until("clean hand-off (other): the agent's script is gone", async () => (await hostEval(`document.readyState === 'complete' && !!document.getElementById('pw') && window.__agentScript2 === undefined`)) === true)
    await hostEval(`document.getElementById('user').value = 'TYPED-NOT-SENT'; window.__beforeGiveBack = 1; 1`)
    await B((t, a) => t.control.giveBack(a), tabId)
    assert.deepEqual((await other).result, { outcome: 'returned' })
    await until('the hand-back reloaded', async () => (await hostEval(`window.__beforeGiveBack === undefined && document.readyState === 'complete'`)) === true)
    const typed = await spy.call('Runtime.evaluate', { expression: "document.getElementById('user').value", returnByValue: true }, sid)
    assert.equal(typed.result?.result?.value, 'me', `what she typed and did not send is gone: ${JSON.stringify(typed)}`)

    // ---- 8. M3: a capture past the ceiling; H3: popups in a loop ----
    const big = await spy.call('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 100, height: 100, scale: 50 } }, sid)
    assert.match(String(big.error?.message), /scale/, `the gate refuses the capture: ${JSON.stringify(big).slice(0, 200)}`)
    const ownerTabs = (): Promise<number> => B((t, a) => t.registry.list().filter(x => x.ownerSlotId === a).length, slot)
    const n0 = await ownerTabs()
    await hostEval(`for (let i = 0; i < 60; i++) window.open('/login.html?p=' + i); 1`)
    await sleep(4000)
    const n1 = await ownerTabs()
    console.log(`popups: ${n1 - n0} tab(s) opened from 60 window.open`)
    assert.ok(n1 - n0 >= 1, 'a popup still opens')
    assert.ok(n1 - n0 <= 3, `at most 3 popups per 10 s (got ${n1 - n0})`)
    assert.equal(await B(() => 1 + 1), 2, 'the app is alive')
    assert.ok(((await B((t, a) => t.registry.list().find(x => x.tabId === a)?.popupsRefused ?? 0, tabId)) as number) > 0)
    await until('the tab carries the seal', async () => (await pane()).noticeKind === 'popups')

    // ---- 9. V2b: with no tab left the local-network question is still asked (here the setting answers: allow), never refused unasked ----
    for (const id of (await B((t, a) => t.registry.list().filter(x => x.ownerSlotId === a).map(x => x.tabId), slot)) as string[]) await B((t, a) => t.registry.close(a), id)
    await until('the agent has no tab', async () => (await ownerTabs()) === 0)
    const noTab = await spy.call('Tether.requestLocalNetwork', { url: `${origin}/login.html` }, bs)
    assert.deepEqual(noTab.result, { allowed: true }, `no tab: the request is judged, not refused unasked: ${JSON.stringify(noTab).slice(0, 200)}`)
    const reborn = await spy.call('Target.createTarget', { url: `${origin}/login.html` }, bs)
    assert.ok(reborn.result?.targetId, `the tab opens right after the yes: ${JSON.stringify(reborn).slice(0, 200)}`)
    assert.equal(await ownerTabs(), 1)
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
    if (soulBefore === undefined) delete process.env.TETHER_SOUL_CMD; else process.env.TETHER_SOUL_CMD = soulBefore
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})

const SESSION = 'SESSION-COOKIE-4Q8'
type TrayModel = { items: { kind: string; label?: string; slotId?: string }[]; badge: string; attention: number; tooltip: string }

test('browser accounts and help requests: logout of all accounts, tray, pill and icon lead to the oldest request', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/set') res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${SESSION}; Path=/; Max-Age=3600` })
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Site ${path.slice(1)}</title><body>cookie=${path === '/set' ? 'set' : (req.headers.cookie ?? 'none')}`)
  })
  const base = await new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://localhost:${(server.address() as AddressInfo).port}`)))
  const host = new URL(base).host
  const home = mkdtempSync(join(tmpdir(), 'tether-brlogin-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const previous = process.env.TETHER_SOUL_CMD
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, `\\\\.\\pipe\\tether-brlogin-${process.pid}`))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, a?: unknown): Promise<R> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>
    const d1 = await win.evaluate(() => window.__tether.activeDesk())
    const slot = await win.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, home)
    await win.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id && s.status === 'running'), slot, { timeout: 20_000 })
    const panes = (): Promise<Pane[]> => win.evaluate(() => window.__tether.browserPanes())
    const mk = async (path: string): Promise<string> => (await B((t, a) => t.create(a.slot, a.url), { slot, url: `${base}${path}` })).tabId
    const evalIn = (tabId: string, code: string): Promise<unknown> => B((t, a) => t.eval(a.tabId, a.code), { tabId, code })
    const body = (tabId: string): Promise<string> => evalIn(tabId, 'document.body.innerText') as Promise<string>
    const tray = (): Promise<TrayModel> => T.evaluate(() => (globalThis as unknown as { __tetherTray: { model(): TrayModel } }).__tetherTray.model())

    // ---- 9. "Sair de todas as contas" ----
    const tab = await mk('/set')
    await until('the site set its cookie', async () => (await body(tab)) === 'cookie=set')
    await evalIn(tab, "localStorage.setItem('k', 'v'); 1")
    await B((t, a) => t.allowOnce(a.tab, a.url), { tab, url: `${base}/who` })
    assert.equal(await B((t, a) => t.load(a.tab, a.url), { tab, url: `${base}/who` }), '')
    await until('the page carries the session', async () => (await body(tab)) === `cookie=sid=${SESSION}`)
    await win.evaluate(() => window.__tether.browserPadOpen())
    const logout = win.locator('[data-pad="browser.tabs"] [data-action="logout-all"]')
    await logout.waitFor()
    assert.equal(await logout.textContent(), 'Sair de todas as contas')

    await logout.click()
    const dlg = win.locator('dialog[data-dialog="browser-logout-all"]')
    await dlg.waitFor()
    assert.match(await dlg.textContent() ?? '', /Todos os agentes perdem o acesso às contas logadas\./)
    await dlg.locator('button.choice[data-choice="cancel"]').click()
    await dlg.waitFor({ state: 'detached' })
    await sleep(800)
    assert.equal(await body(tab), `cookie=sid=${SESSION}`, 'cancelling changes nothing')

    await logout.click()
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="logout"]').click()
    await until('the open tab was reloaded without the session', async () => (await body(tab)) === 'cookie=none')
    assert.equal(await evalIn(tab, "localStorage.getItem('k')"), null, 'the storage is gone too')
    const log = await until('the log line', async () => { const f = join(home, 'tether-app.log'); const t = existsSync(f) ? readFileSync(f, 'utf8') : ''; return /sair de todas as contas/.test(t) ? t : undefined })
    const line = log.split('\n').find(l => /sair de todas as contas/.test(l))!
    assert.ok(!/localhost|http|:\d{4,}/.test(line), `the log line has no address: ${line}`)

    // ---- 10. help requests: tray, pill, icon ----
    const c = await mk('/c')
    const a = await mk('/a')
    await until('two more panes', async () => (await panes()).length === 3)
    const ask = (id: string, message: string): Promise<unknown> => B((t, x) => { void t.control.ask(x.id, x.slot, { message: x.message, kind: 'other', timeoutMs: 600_000 }); return 1 }, { id, slot, message })
    await ask(c, 'primeiro')
    await until('the first seal', async () => (await win.evaluate(() => window.__tether.browserSeals())).length === 1)
    await sleep(30)
    await ask(a, 'segundo')
    await until('both seals', async () => (await win.evaluate(() => window.__tether.browserSeals())).length === 2)
    // V2b: two requests, two on the Browser pill (the panes' seals and the extension's badge added up to four for two requests).
    const pillCount = '#desk-switch .seg.sys[data-system="browser.desk"] .sys-badge'
    await until('the Browser pill counts requests, not seals', async () => (await win.locator(pillCount).first().textContent().catch(() => null)) === '2')

    let m = await until('the tray carries both', async () => { const x = await tray(); return x.items.filter(i => i.kind === 'notice').length === 2 ? x : undefined })
    assert.deepEqual(m.items.filter(i => i.kind === 'notice').map(i => [i.label, i.slotId]), [
      [`Sonda pede ajuda em ${host}: primeiro`, slot], [`Sonda pede ajuda em ${host}: segundo`, slot],
    ], 'the tray menu says who asks, where and what, and a click opens the agent')
    assert.equal(m.badge, 'attention')
    assert.ok(m.attention >= 2)
    assert.match(m.tooltip, /esperando você/)

    const front = async (): Promise<string | undefined> => (await panes()).find(p => p.front && (p.tabId === c || p.tabId === a))?.tabId
    const show = async (id: string): Promise<void> => {
      await win.evaluate(x => window.__tether.browserReveal(`web:${x}`), id)
      await until('shown', async () => (await front()) === id)
      await win.evaluate(d => window.__tether.switchDesk(d), d1)
      await until('back on the first desk', async () => (await win.evaluate(() => window.__tether.activeDesk())) === d1)
    }
    const away = async (): Promise<boolean> => (await win.evaluate(() => window.__tether.activeDesk())) !== d1
    const pill = '#desk-switch .seg.sys[data-system="browser.desk"]'
    await show(a)
    await win.click(pill)
    await until('the pill leads to the oldest request', async () => (await front()) === c && await away())

    await show(a)
    await win.click('.sb-icon[data-pad="browser.tabs"]')
    if (!(await win.locator('[data-pad="browser.tabs"] .br-pad-list').isVisible())) await win.click('.sb-icon[data-pad="browser.tabs"]')
    await until('the icon leads to the oldest request', async () => (await front()) === c && await away())

    // handing the oldest back moves the way to the next
    await B((t, x) => t.control.giveBack(x), c)
    await until('one notice left', async () => (await tray()).items.filter(i => i.kind === 'notice').length === 1)
    await show(c)
    await win.click(pill)
    await until('the pill now leads to the other one', async () => (await front()) === a && await away())
    await B((t, x) => t.control.giveBack(x), a)
    m = await until('no notice left', async () => { const x = await tray(); return x.items.every(i => i.kind !== 'notice') ? x : undefined })
    assert.equal(m.attention, 0)
    await until('the pill is clear', async () => (await win.locator(pillCount).count()) === 0)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    server.close()
    if (previous === undefined) delete process.env.TETHER_SOUL_CMD; else process.env.TETHER_SOUL_CMD = previous
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
