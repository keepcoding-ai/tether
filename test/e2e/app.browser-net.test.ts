// E2E of the tabs' network filter (Tether Browser E3, the S4 cases), with the app built with TETHER_TEST_EXTENSIONS=1 (the
// browser's main side hands its registry to the test as `globalThis.__browserTabs`, standing in for the gatekeeper).
// Hidden window, private home/pipe, real tetherd, CLAUDE* stripped, no internet. Three servers of the test:
//   - PUB on 127.0.0.2, the "public site": the filter is told to treat 127.0.0.2 as public (S4's stand-in, the package's tests
//     do the same), since a public page cannot be hosted here;
//   - LOCAL and OTHER on 127.0.0.1 (two ports): the local services a public page must never reach. Their request log is
//     the proof: a refused request never arrives.
// Cases: a public page's fetch, img, iframe, WebSocket, alternative IP forms, the name localhost, a 302/307 to localhost,
// file: and a popup → all refused, nothing reaches LOCAL; a ticket opens localhost once and not twice, and expires; a
// redirect from the ticket to another local port is refused while a same-origin one (login → dashboard) passes; a local
// page reaches the local network; CDP `Page.navigate` (the gatekeeper's path) uses the ticket too.
// E4 (egress proxy and the local-network question): steps 1–5 run with `localNetwork: allow` (settings.json of the home), so
// the tickets need no person. Step 6: the proxy — a public NAME the proxy resolves to 127.0.0.1 (the test's resolver, no
// lookup leaves the machine) is refused for fetch, WebSocket and the agent's navigation, and LOCAL gets nothing; no
// WebTransport behind a proxy. Step 7: WebRTC with a STUN server on the test's own UDP socket: zero datagrams. Step 8: the
// question — `ask` shows the dialog, "Só desta vez" opens once, "Não permitir" refuses, "Sempre" stops asking (and is kept
// in <home>/browser/local-network.json), a closed tab withdraws its question; `deny` and `allow` never ask.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { inBrowser } from './browser-kit.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
type Blocked = { tabId: string; reason: string; resourceType: string; destination: string }
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  allowOnce(tabId: string, url: string): Promise<boolean>
  setPublicStandIns(hosts: string[]): Promise<void>
  load(tabId: string, url: string): Promise<string>
  cdpNavigate(tabId: string, url: string): Promise<string>
  blocked: Blocked[]
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[]; close(tabId: string): void }
  requestLocalNetwork(tabId: string, owner: string, url: string): Promise<boolean>
  setTestHosts(hosts: Record<string, string[]>): Promise<void>
  egressBlocked(): Promise<number>
  setLocalNetwork(value: string): void
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-brnet-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

const page = (title: string): string => `<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1></body></html>`

/** A server that logs every request path (and WebSocket upgrade) it receives. */
function serve(host: string, name: string, routes: (path: string) => { status?: number; location?: string; body?: string }): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits.push(path)
    const r = routes(path)
    if (r.location) { res.writeHead(r.status ?? 302, { location: r.location }); res.end(); return }
    res.writeHead(r.status ?? 200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(r.body ?? page(`${name} ${path}`))
  })
  server.on('upgrade', (req, socket) => { hits.push(`upgrade ${new URL(req.url ?? '/', 'http://x').pathname}`); socket.destroy() })
  return new Promise(r => server.listen(0, host, () => r({ server, base: `http://${host}:${(server.address() as AddressInfo).port}`, hits })))
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const win = await app.firstWindow()
  win.setDefaultTimeout(10_000)
  win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  try { await win.waitForSelector('#conn.on', { timeout: 30_000 }) } catch (e) { await killElectron(app, root).catch(() => {}); throw e }
  return { app, page: win }
}

const T = (app: ElectronApplication) => ({
  create: (owner: string, url: string, ticket = true): Promise<string> =>
    inBrowser(app, async (_e, a) => (await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.create(a.owner, a.url, a.ticket)).tabId, { owner, url, ticket }),
  eval: (tabId: string, code: string): Promise<unknown> =>
    inBrowser(app, (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(a.tabId, a.code), { tabId, code }),
  allowOnce: (tabId: string, url: string): Promise<boolean> =>
    inBrowser(app, (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.allowOnce(a.tabId, a.url), { tabId, url }),
  load: (tabId: string, url: string): Promise<string> =>
    inBrowser(app, (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.load(a.tabId, a.url), { tabId, url }),
  cdpNavigate: (tabId: string, url: string): Promise<string> =>
    inBrowser(app, (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.cdpNavigate(a.tabId, a.url), { tabId, url }),
  blocked: (): Promise<Blocked[]> => inBrowser(app, () => [...(globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.blocked]),
  tabs: () => inBrowser(app, () => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list().map(t => ({ tabId: t.tabId, url: t.url }))),
  standIns: (hosts: string[]): Promise<void> => inBrowser(app, (_e, h) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.setPublicStandIns(h), hosts),
  hosts: (hosts: Record<string, string[]>): Promise<void> => inBrowser(app, (_e, h) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.setTestHosts(h), hosts),
  egressBlocked: (): Promise<number> => inBrowser(app, () => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.egressBlocked()),
  setLocalNetwork: (value: string): Promise<void> => inBrowser(app, (_e, v) => { (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.setLocalNetwork(v) }, value),
  requestLocalNetwork: (tabId: string, owner: string, url: string): Promise<boolean> =>
    inBrowser(app, (_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.requestLocalNetwork(a.tabId, a.owner, a.url), { tabId, owner, url }),
  close: (tabId: string): Promise<void> => inBrowser(app, (_e, id) => { (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.close(id) }, tabId),
})

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let v = await fn()
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timeout: ${what}: ${JSON.stringify(v)}`)
    await sleep(150)
    v = await fn()
  }
  return v
}

test('browser network filter: the local network is closed to public pages, open to local ones and to one ticket', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const other = await serve('127.0.0.1', 'Outra', () => ({}))
  const local = await serve('127.0.0.1', 'Local', path => {
    if (path === '/login') return { location: '/hit-dash' }
    if (path === '/to-other') return { location: `${other.base}/hit-other` }
    return {}
  })
  const pub = await serve('127.0.0.2', 'Pública', path => {
    if (path === '/r302') return { location: `${local.base}/hit-302` }
    if (path === '/r307') return { status: 307, location: `${local.base}/hit-307` }
    if (path === '/to-local-login') return { location: `${local.base}/login` }
    return {}
  })
  const L = local.base
  const port = new URL(L).port
  const localHits = (): string[] => [...local.hits, ...other.hits].filter(h => h.includes('hit-'))
  const home = mkdtempSync(join(tmpdir(), 'tether-brnet-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const udp = createSocket('udp4')
  let datagrams = 0
  udp.on('message', () => { datagrams++ })
  await new Promise<void>(r => udp.bind(0, '127.0.0.1', () => r()))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launch(home))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const t = T(app)
    await t.standIns(['127.0.0.2'])
    await t.hosts({ 'rebind.test': ['127.0.0.1'] })

    // ---- 1. a public page reaching the local network ----
    console.log('step 1')
    const tab = await t.create('owner-a', `${pub.base}/page`, false)
    await until('public page loaded', () => t.eval(tab, 'document.title'), v => v === 'Pública /page')
    const fetchTo = (url: string) => t.eval(tab, `fetch(${JSON.stringify(url)}).then(r => 'ok ' + r.status, e => 'err')`)
    assert.equal(await fetchTo(`${L}/hit-fetch`), 'err', 'fetch')
    assert.equal(await fetchTo(`http://localhost:${port}/hit-name`), 'err', 'the name localhost')
    assert.equal(await fetchTo(`http://2130706433:${port}/hit-dec`), 'err', 'decimal IP')
    assert.equal(await fetchTo(`http://0x7f.1:${port}/hit-hex`), 'err', 'hex IP')
    assert.equal(await fetchTo(`http://0177.0.0.1:${port}/hit-oct`), 'err', 'octal IP')
    assert.equal(await fetchTo(`http://[::ffff:127.0.0.1]:${port}/hit-mapped`), 'err', 'IPv4-mapped IPv6')
    assert.equal(await fetchTo(`${pub.base}/r307`), 'err', '307 to localhost (sub-resource)')
    assert.equal(await t.eval(tab, `new Promise(r => { const i = new Image(); i.onload = () => r('load'); i.onerror = () => r('error'); i.src = ${JSON.stringify(`${L}/hit-img`)} })`), 'error', 'img')
    await t.eval(tab, `new Promise(r => { const f = document.createElement('iframe'); f.onload = () => r(1); f.src = ${JSON.stringify(`${L}/hit-iframe`)}; document.body.append(f); setTimeout(() => r(0), 3000) })`)
    assert.equal(await t.eval(tab, `new Promise(r => { const w = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/hit-ws`)}); w.onopen = () => r('open'); w.onerror = () => r('error'); setTimeout(() => r('timeout'), 4000) })`), 'error', 'WebSocket')
    await t.eval(tab, `navigator.sendBeacon(${JSON.stringify(`${L}/hit-beacon`)}, 'x'); 1`)
    assert.equal(await t.eval(tab, `fetch('file:///C:/Windows/win.ini').then(() => 'ok', () => 'err')`), 'err', 'file: from the page')
    // A page-started top navigation to localhost, and a 302 from the public site to localhost.
    await t.eval(tab, `location.href = ${JSON.stringify(`${L}/hit-nav`)}; 1`).catch(() => {})
    await sleep(800)
    assert.match(await t.load(tab, `${pub.base}/r302`), /ERR_BLOCKED_BY_CLIENT/, '302 public → localhost: Chromium\'s error page')
    // file: as a browser-started navigation (will-navigate does not see loadURL; the filter does).
    assert.match(await t.load(tab, 'file:///C:/Windows/win.ini'), /ERR_BLOCKED_BY_CLIENT/, 'file: navigation')
    // A popup from the public page to localhost: a tab of the same owner, but its address gets no ticket.
    assert.equal(await t.load(tab, `${pub.base}/page`), '')
    await t.eval(tab, `window.open(${JSON.stringify(`${L}/hit-popup`)}); 1`)
    await until('popup tab', () => t.tabs(), v => v.length === 2)
    await sleep(1500)
    assert.deepEqual(localHits(), [], 'nothing reached the local servers')
    const blocked = await t.blocked()
    const reasons = new Set(blocked.map(b => `${b.reason}/${b.resourceType}`))
    for (const r of ['local-from-public/xhr', 'local-from-public/image', 'local-from-public/subFrame', 'local-from-public/webSocket', 'local-from-public/mainFrame', 'local-redirect/xhr', 'local-redirect/mainFrame', 'scheme/mainFrame', 'local-without-ticket/mainFrame']) {
      assert.ok(reasons.has(r), `blocked event ${r} in ${[...reasons].join(', ')}`)
    }
    for (const b of blocked) assert.ok(!b.destination.includes('hit-') && !b.destination.includes('/C:'), `only the origin: ${b.destination}`)
    assert.ok(blocked.every(b => b.tabId === tab || b.reason === 'local-without-ticket'), 'events name the tab')

    // ---- 2. the ticket: once, not twice; it expires ----
    console.log('step 2')
    assert.equal(await t.allowOnce(tab, `${L}/hit-ticket`), true)
    assert.equal(await t.load(tab, `${L}/hit-ticket`), '', 'the ticket opens localhost')
    assert.equal(await t.eval(tab, 'document.title'), 'Local /hit-ticket')
    assert.equal(await t.load(tab, `${pub.base}/page`), '')
    assert.match(await t.load(tab, `${L}/hit-ticket`), /ERR_BLOCKED_BY_CLIENT/, 'the second time is refused')
    assert.deepEqual(localHits(), ['/hit-ticket'], 'one arrival')
    await t.allowOnce(tab, `${L}/hit-late`)
    await sleep(5_600)
    assert.match(await t.load(tab, `${L}/hit-late`), /ERR_BLOCKED_BY_CLIENT/, 'an expired ticket')
    assert.equal(await t.allowOnce(tab, `${L}/hit-other-address`), true)
    assert.match(await t.load(tab, `${L}/hit-other-address?x=1`), /ERR_BLOCKED_BY_CLIENT/, 'the ticket is for the exact address')

    // ---- 3. redirects from the ticket ----
    console.log('step 3')
    await t.allowOnce(tab, `${L}/to-other`)
    assert.match(await t.load(tab, `${L}/to-other`), /ERR_BLOCKED_BY_CLIENT/, 'ticket → another local port: refused')
    assert.equal(other.hits.length, 0, 'the other port received nothing')
    await t.allowOnce(tab, `${L}/login`)
    assert.equal(await t.load(tab, `${L}/login`), '', 'ticket → same origin (login → dashboard): kept')
    assert.equal(await t.eval(tab, 'document.title'), 'Local /hit-dash')
    // A ticket to a public address that redirects into the local network does not carry over.
    await t.allowOnce(tab, `${pub.base}/to-local-login`)
    assert.match(await t.load(tab, `${pub.base}/to-local-login`), /ERR_BLOCKED_BY_CLIENT/, 'public → local redirect under a ticket')
    assert.deepEqual(localHits(), ['/hit-ticket', '/hit-dash'])

    // ---- 4. a local page reaches the local network (and its popup opens) ----
    console.log('step 4')
    await t.allowOnce(tab, `${L}/hit-app`)
    assert.equal(await t.load(tab, `${L}/hit-app`), '')
    assert.equal(await t.eval(tab, `fetch(${JSON.stringify(`${other.base}/hit-local-fetch`)}).then(r => 'ok ' + r.status, () => 'err')`), 'ok 200', 'local origin → other local port')
    await t.eval(tab, `new Promise(r => { const w = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/hit-local-ws`)}); w.onopen = w.onerror = w.onclose = () => r(1); setTimeout(() => r(0), 3000) })`)
    await t.eval(tab, `window.open(${JSON.stringify(`${L}/hit-local-popup`)}); 1`)
    await until('local popup reached', async () => localHits(), v => v.includes('/hit-local-popup'))
    assert.ok(localHits().includes('/hit-local-fetch') && localHits().includes('upgrade /hit-local-ws'), JSON.stringify(localHits()))
    // The page-started navigation to the local network from a local page.
    await t.eval(tab, `location.href = ${JSON.stringify(`${L}/hit-local-nav`)}; 1`).catch(() => {})
    await until('local nav', async () => localHits(), v => v.includes('/hit-local-nav'))

    // ---- 5. CDP Page.navigate (the gatekeeper's path) uses the ticket, once ----
    console.log('step 5')
    assert.equal(await t.load(tab, `${pub.base}/page`), '')
    await t.allowOnce(tab, `${L}/hit-cdp`)
    assert.equal(await t.cdpNavigate(tab, `${L}/hit-cdp`), '', 'Page.navigate with the ticket')
    await until('cdp nav arrived', async () => localHits(), v => v.includes('/hit-cdp'))
    assert.equal(await t.load(tab, `${pub.base}/page`), '')
    assert.match(await t.cdpNavigate(tab, `${L}/hit-cdp`), /ERR_BLOCKED_BY_CLIENT/, 'Page.navigate without a ticket')
    assert.equal(localHits().filter(h => h === '/hit-cdp').length, 1)

    // ---- 6. the egress proxy: a public name that resolves to 127.0.0.1; no QUIC ----
    console.log('step 6')
    // A fresh public tab (the last CDP refusal of step 5 can still be settling in the first one).
    const tab6 = await t.create('owner-a', `${pub.base}/page`, false)
    await until('public page loaded', () => t.eval(tab6, 'document.title'), v => v === 'Pública /page')
    const fetch6 = (url: string) => t.eval(tab6, `fetch(${JSON.stringify(url)}).then(r => 'ok ' + r.status, e => 'err')`)
    const proxyBlocks = await t.egressBlocked()
    assert.equal(await fetch6(`http://rebind.test:${port}/hit-rebind`), 'err', 'fetch to a name resolving to 127.0.0.1')
    assert.equal(await t.eval(tab6, `new Promise(r => { const w = new WebSocket('ws://rebind.test:${port}/hit-rebind-ws'); w.onopen = () => r('open'); w.onerror = () => r('error'); setTimeout(() => r('timeout'), 4000) })`), 'error', 'WebSocket')
    const navErr = await t.load(tab6, `http://rebind.test:${port}/hit-rebind-nav`)
    assert.ok(navErr !== '' && !/ERR_BLOCKED_BY_CLIENT/.test(navErr), `the agent's navigation fails at the proxy, not the filter: ${navErr}`)
    assert.ok((await t.egressBlocked()) >= proxyBlocks + 3, 'the proxy refused them')
    assert.ok(!localHits().some(h => h.includes('rebind')), 'LOCAL received nothing')

    // ---- 7. WebRTC: a STUN server on the test's UDP socket gets nothing ----
    console.log('step 7')
    const udpPort = udp.address().port
    const candidates = await t.eval(tab6, `(async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] })
      pc.createDataChannel('x')
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise(r => setTimeout(r, 4000))
      const n = (pc.localDescription?.sdp ?? '').split('\\n').filter(l => l.startsWith('a=candidate')).length
      pc.close()
      return n
    })()`)
    console.log(`webrtc candidates: ${String(candidates)}`)
    // WebTransport is QUIC (UDP): it cannot go through an HTTP proxy, and it does not go around it.
    const wt = await t.eval(tab6, `new Promise(r => { try { const w = new WebTransport('https://127.0.0.1:${udpPort}/hit-wt'); w.ready.then(() => r('ready'), () => r('failed')); setTimeout(() => r('timeout'), 4000) } catch { r('threw') } })`)
    console.log(`webtransport: ${String(wt)}`)
    assert.notEqual(wt, 'ready')
    assert.equal(datagrams, 0, 'zero UDP datagrams (WebRTC STUN and WebTransport)')

    // ---- 8. the local-network question ----
    console.log('step 8')
    await t.setLocalNetwork('ask')
    const dlg = win.locator('dialog.ask[data-dialog="browser.localNetwork"][open]')
    const dest = `127.0.0.1:${port}`
    // A tab created at the agent's request for a local address waits for the person.
    const q = await t.create('owner-q', `${L}/hit-q-once`)
    await dlg.waitFor()
    assert.match((await dlg.textContent()) ?? '', new RegExp(`Permitir que o agente abra ${dest.replace(/\./g, '\\.')}\\?`))
    assert.ok(!localHits().includes('/hit-q-once'), 'nothing loads before the answer')
    assert.equal(await dlg.locator('button.choice.safe.default[data-choice="deny"]').count(), 1, 'refusing is the default')
    await dlg.locator('button.choice[data-choice="once"]').click()
    await until('once: loaded', async () => localHits(), v => v.includes('/hit-q-once'))
    // "Só desta vez" asks again next time; "Não permitir" refuses.
    const denied = t.allowOnce(q, `${L}/hit-q-deny`)
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="deny"]').click()
    assert.equal(await denied, false, 'refused')
    assert.match(await t.load(q, `${L}/hit-q-deny`), /ERR_BLOCKED_BY_CLIENT/)
    // "Sempre para este perfil": granted, kept, never asked again for that destination.
    const always = t.allowOnce(q, `${L}/hit-q-always`)
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="always"]').click()
    assert.equal(await always, true)
    assert.equal(await t.load(q, `${L}/hit-q-always`), '')
    await until('dialog closed', () => dlg.count(), n => n === 0)
    assert.equal(await t.allowOnce(q, `${L}/hit-q-again`), true, 'no question the second time')
    assert.equal(await dlg.count(), 0)
    assert.equal(await t.load(q, `${L}/hit-q-again`), '')
    const kept = join(home, 'browser', 'local-network.json')
    assert.ok(existsSync(kept), 'kept in <home>/browser')
    assert.deepEqual(JSON.parse(readFileSync(kept, 'utf8')), { profiles: { '': [dest] } })
    // Another owner of the tab is refused without a question.
    assert.equal(await t.requestLocalNetwork(q, 'owner-x', `${L}/hit-q-x`), false)
    // A pending question is withdrawn when its tab closes.
    const pending = t.requestLocalNetwork(q, 'owner-q', `${other.base}/hit-q-closed`)
    await dlg.waitFor()
    await t.close(q)
    assert.equal(await pending, false, 'the closed tab refuses')
    await until('withdrawn dialog closed', () => dlg.count(), n => n === 0)
    // deny and allow never ask.
    const q2 = await t.create('owner-q', `${pub.base}/page`, false)
    await t.setLocalNetwork('deny')
    assert.equal(await t.requestLocalNetwork(q2, 'owner-q', `${L}/hit-q-always`), false, 'deny wins over "always"')
    await t.setLocalNetwork('allow')
    assert.equal(await t.requestLocalNetwork(q2, 'owner-q', `${other.base}/hit-q-allow`), true)
    assert.equal(await dlg.count(), 0, 'no question under deny or allow')
    assert.ok(!localHits().includes('/hit-q-deny') && !localHits().includes('/hit-q-closed'))
    console.log(`local hits: ${JSON.stringify(localHits())}`)
  } finally {
    udp.close()
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const s of [pub, local, other]) s.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
