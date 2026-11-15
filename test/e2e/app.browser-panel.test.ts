// The `web` panel complete (Tether Browser E9, design §5.2, §7, §12a), against the real app built with TETHER_TEST_EXTENSIONS=1
// (hidden window, private home and pipe, real tetherd, loopback only). The agent is a real "soul" slot (an inert stand-in) named Sonda.
//   1. the bar: the real address (read-only), the owner's chip (name, hue derived from the slot id), loading, cookies of the site,
//      the "logins not kept" notice, history and reload disabled while the agent has the tab; the tab: icon, title, chip, activity;
//   2. the agent acts → the tab's dot lights;
//   3. the letterbox: the fitted page is centred in the page area, never enlarged;
//   4. "Assumir o controle" maximizes the pane; back, forward and reload work; "Devolver ao ‹agente›" restores the size;
//   5. the agent ends → "Sonda encerrado" (bar and tab), the chip dimmed.
// Prints in both themes: test/e2e/artifacts/browser-panel-*.png.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { ownerHue } from '../../extensions/browser/rules.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { daemonMain, launchHidden, pidAlive, rawCdp, root, sleep, inBrowser } from './browser-kit.ts'

type Lb = { host: { width: number; height: number }; effective: { x: number; y: number; width: number; height: number } | undefined; scale: number; visibility: string }
type TabView = { title: string; owner: string; ownerHue: string; ownerEnded: boolean; icon: boolean; activity: string }
type Pane = {
  id: string; tabId?: string; owner?: string; state?: string; title: string; address: string; control: string; controlText: string; action: string
  chip: string; ownerEnded: boolean; ownerHue: string; nav: Record<string, boolean>; loadingShown: boolean; cookiesShown: boolean
  memoryShown: boolean; memoryText: string; tab?: TabView; maximized: boolean; letterbox?: Lb
}
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    slots(): SlotState[]
    openSlot(id: string): Promise<void>
    browserPanes(): Pane[]
    browserReveal(id: string): void
    browserClick(tabId: string, where: string): void
  }
  tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> }
}
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  load(tabId: string, url: string): Promise<string>
  allowOnce(tabId: string, url: string): Promise<boolean>
  control: { control(id: string): string }
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brpanel-${process.pid}`
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const FAKE_SOUL = `"${process.execPath}" -e "setInterval(()=>{},1000)"`
const html = (title: string, body: string): string => `<!doctype html><title>${title}</title><link rel="icon" href="${ICON}"><body style="font:16px sans-serif;margin:0;background:#fffbe6">${body}`

function serve(): Promise<{ server: Server; base: string; hits: Record<string, number> }> {
  const hits: Record<string, number> = {}
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits[path] = (hits[path] ?? 0) + 1
    if (path === '/a.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=abc; Max-Age=3600; Path=/' })
      return res.end(html('Página A', '<h1 style="padding:24px">Página A</h1>'))
    }
    if (path === '/b.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html('Página B', '<h1 style="padding:24px">Página B</h1>')) }
    res.writeHead(404).end('not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
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

async function setTheme(win: Page, scheme: 'light' | 'dark'): Promise<void> {
  await win.click('#btn-theme')
  await win.waitForSelector('#theme-menu:not([hidden])')
  await win.click(`#theme-menu li[data-theme="${scheme}"]`)
  await win.waitForFunction(s => (document.documentElement as { dataset: Record<string, string> }).dataset.theme === s, scheme)
  await win.mouse.move(5, 5)
  await sleep(350)
}

/** The same state in both themes, ending back in the dark one. */
async function shots(win: Page, name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await setTheme(win, scheme)
    await win.screenshot({ path: join(artifacts, `browser-panel-${name}-${scheme}.png`) })
  }
  await setTheme(win, 'dark')
}

test('browser panel: bar, tab, letterbox, take maximizes and give back restores, agent ended', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const site = await serve()
  const home = mkdtempSync(join(tmpdir(), 'tether-brpanel-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let spy: Awaited<ReturnType<typeof rawCdp>> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, a?: unknown): Promise<R> =>
      inBrowser(app!, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>

    // The agent: a soul slot named Sonda (alive).
    const slot = await win.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, home)
    await until('the soul runs', async () => (await win.evaluate(() => window.__tether.slots())).find(s => s.slotId === slot)?.status === 'running', 20_000)
    const gate = (await B(t => t.gate()))!
    const KEY = 'panelPANELpanelPANELpanelPANEL12345'
    writeFileSync(join(keysDir, `${slot}.key`), KEY)

    const urlA = `${site.base}/a.html`
    const urlB = `${site.base}/b.html`
    const tabId = (await B((t, a) => t.create(a.slot, a.url), { slot, url: urlA })).tabId
    const paneId = `web:${tabId}`
    const pane = async (): Promise<Pane> => (await win.evaluate(() => window.__tether.browserPanes())).find(p => p.tabId === tabId)!
    const control = (): Promise<string> => B((t, a) => t.control.control(a), tabId)
    await until('the pane exists', async () => (await win.evaluate(() => window.__tether.browserPanes())).some(p => p.tabId === tabId))
    await win.evaluate(id => window.__tether.browserReveal(id), paneId)
    await until('page A loaded', async () => { const p = await pane(); return p.state === 'live' && p.title === 'Página A' })

    // ---- 1. the bar and the tab, the agent has the tab ----
    let p = await pane()
    assert.equal(p.address, urlA, 'the real address of the page')
    assert.equal(p.chip, 'Sonda', 'the owner chip: the short name')
    assert.equal(p.ownerEnded, false)
    assert.equal(Number(p.ownerHue), ownerHue(slot), 'the colour is derived from the slot id')
    assert.equal(p.controlText, 'Sonda usando')
    assert.deepEqual(p.nav, { back: false, forward: false, reload: false }, 'history and reload wait for the person')
    assert.equal(p.loadingShown, false)
    await until('cookies of the site shown', async () => (await pane()).cookiesShown)
    if (p.memoryShown) assert.equal(p.memoryText, 'Logins não guardados')
    console.log(`logins not kept notice shown: ${p.memoryShown}`)
    await until('the tab strip shows icon, title and chip', async () => { const t = (await pane()).tab; return !!t && t.icon && t.title === 'Página A' && t.owner === 'Sonda' })
    p = await pane()
    assert.equal(Number(p.tab!.ownerHue), ownerHue(slot), 'the same colour on the tab')

    // ---- 2. the agent acts: the tab's dot ----
    spy = await rawCdp(gate.port, KEY)
    const bs = (await spy.call('Target.attachToBrowserTarget')).result.sessionId as string
    const target = (await spy.call('Target.getTargets', {}, bs)).result.targetInfos[0].targetId as string
    const sid = (await spy.call('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId as string
    await spy.call('Runtime.evaluate', { expression: '1+1' }, sid)
    await until('the dot lights while the agent acts', async () => (await pane()).tab?.activity === 'agent', 4000)
    await shots(win, 'agent')
    await until('the dot goes out', async () => (await pane()).tab?.activity === 'idle', 6000)

    // ---- 3. the letterbox ----
    const lb = (await until('the letterbox is reported', async () => { const x = await pane(); return x.letterbox?.effective ? x.letterbox : undefined }))
    const eff = lb.effective!
    assert.ok(lb.scale > 0 && lb.scale <= 1, `never enlarged: scale ${lb.scale}`)
    assert.ok(eff.width <= lb.host.width + 1 && eff.height <= lb.host.height + 1, 'the page fits its area')
    const left = eff.x, right = lb.host.width - (eff.x + eff.width), top = eff.y, bottom = lb.host.height - (eff.y + eff.height)
    assert.ok(Math.abs(left - right) <= 1.5 && Math.abs(top - bottom) <= 1.5, `centred: ${JSON.stringify({ left, right, top, bottom })}`)
    assert.ok(Math.abs(eff.width / eff.height - 1280 / 800) < 0.02, 'the page keeps its 1280x800 proportion')
    console.log(`letterbox: area ${lb.host.width.toFixed(0)}x${lb.host.height.toFixed(0)}, page ${eff.width.toFixed(0)}x${eff.height.toFixed(0)}, scale ${lb.scale.toFixed(3)}, bands ${JSON.stringify({ left, right, top, bottom })}`)

    // ---- 4. take: maximizes; history; give back: restores ----
    assert.equal(p.maximized, false)
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), tabId) // "Assumir o controle"
    await until('taken', async () => (await control()) === 'user')
    p = await until('the pane is maximized', async () => { const x = await pane(); return x.maximized ? x : undefined })
    assert.equal(p.controlText, 'Com você')
    assert.equal(p.nav.reload, true, 'reload is active')
    assert.equal(p.nav.forward, false, 'nothing to go forward to')
    // (a local address needs a one-use ticket for a browser-started navigation; the buttons below grant their own)
    await B((t, a) => t.allowOnce(a.tabId, a.url), { tabId, url: urlB })
    assert.equal(await B((t, a) => t.load(a.tabId, a.url), { tabId, url: urlB }), '')
    p = await until('page B', async () => { const x = await pane(); return x.address === urlB && x.title === 'Página B' && x.nav.back ? x : undefined })
    assert.equal(p.nav.forward, false)
    await win.evaluate(id => window.__tether.browserClick(id, 'back'), tabId)
    p = await until('back to A', async () => { const x = await pane(); return x.address === urlA && x.nav.forward ? x : undefined })
    await win.evaluate(id => window.__tether.browserClick(id, 'forward'), tabId)
    await until('forward to B', async () => (await pane()).address === urlB)
    const before = site.hits['/b.html']!
    await win.evaluate(id => window.__tether.browserClick(id, 'reload'), tabId)
    await until('reload fetched B again', async () => site.hits['/b.html']! > before)
    await until('loaded', async () => (await pane()).state === 'live')
    await shots(win, 'user')
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), tabId) // "Devolver ao ‹agente›"
    await until('given back', async () => (await control()) === 'agent')
    p = await until('the size is restored', async () => { const x = await pane(); return !x.maximized ? x : undefined })
    // History and reload are the person's: with the agent the buttons are off and a click does nothing.
    assert.deepEqual(p.nav, { back: false, forward: false, reload: false })
    const hitsB = site.hits['/b.html']!
    await win.evaluate(id => window.__tether.browserClick(id, 'reload'), tabId)
    await sleep(800)
    assert.equal(site.hits['/b.html'], hitsB, 'a disabled reload does nothing')

    // ---- 5. the agent ends ----
    void win.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), slot)
    p = await until('"Sonda encerrado"', async () => { const x = await pane(); return x.chip === 'Sonda encerrado' ? x : undefined }, 50_000)
    assert.equal(p.ownerEnded, true)
    await until('the tab strip says it too', async () => { const t = (await pane()).tab; return t?.owner === 'Sonda encerrado' && t.ownerEnded })
    await shots(win, 'ended')
  } finally {
    spy?.close()
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    site.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
