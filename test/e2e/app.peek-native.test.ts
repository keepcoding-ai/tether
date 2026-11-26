// E2E of the quick view with the native views (V4): the browser's page (a WebContentsView placed by its pane's rectangle) lent
// to the card, and the HTML preview (a <webview>) shown as a copy. A tetherd in this process on a private home and pipe, one
// fake `claude` agent (test/fixtures/channels/agent.cjs, no LLM, member of a channel so the Regency's box of speech is on),
// a page served on http://localhost:<port> (the browser allows the local network in this home's settings), the real app built
// with the test extensions (the tab is created as the agent's through `__browserTabs`), hidden window. Nothing touches the
// person's tether.
//   1. the agent's browser tab (on the Browser desk) in the MODAL card: the page is shown alive (its counter goes on) exactly
//      in the card's page area (main's rectangle of the view = the element's), the freeze holds the window behind and spares
//      the card (no picture); the agent's shield stays on and a click on it answers "Assumir" in the card; a menu over the
//      card freezes its page (picture) and closing it brings the page back; the window resized, the view follows; closed,
//      the pane is back in its tab whole (no reload: the page's own mark is still there), the view hidden until the Browser
//      desk shows it, then placed in the tab again (screenshot r3-cartao-navegador);
//   2. the same tab DOCKED over the Regency's conversation (its own quick view path): the view in the card, never over the
//      tree nor over the box of speech; no freeze; the box takes text and sends with the card open; the "@" list opened then
//      freezes the card's page (it would sit under the native view) and the page lives again when it closes; a line for the
//      person under the card keeps its mark, seen once the card closes; closed, back whole;
//   3. an HTML preview (on another desk) in the card: a COPY of it (its own id and guest, the same file), the tab untouched
//      (no "sendo espiada", no eye, not reloaded: same guest, same load count, the page's mark kept); closing the card drops
//      the copy (screenshot r3-cartao-previa-html).
// The screenshots: the hidden window's capture does not hold the native view (the OS draws it over the interface), so the
// browser's shot paints the page's own capture at the rectangle main gave the view, just for the shot.
// Run alone: node --test --test-force-exit --test-concurrency=1 test/e2e/app.peek-native.test.ts   (the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { MODERATOR_NAME } from '../../extensions/channels/daemon/notices.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, electronPath, inBrowser, mainPath, root } from './browser-kit.ts'

interface Rect { x: number; y: number; width: number; height: number }
type Surface = { visibility: string; rect?: Rect; effective?: Rect; shield: boolean } | undefined
type Freeze = { reasons: string[]; pictures: number }
type Html = { id: string; path: string; contentsId: number | undefined; loads: number; partition: string }
type Note = { kind: string; text: string; action: string }
type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  runCommand(id: string): void
  peekState(): { open: boolean; pane?: string; mode?: string }
  peekPane(id: string, over?: string): void
  freeze(): Freeze
  openNote(path: string): Promise<void>
  notes(): { id: string; path: string }[]
  htmlPreviews(): Html[]
  htmlPreview(id: string): Html | undefined
  browserPanes(): { id: string; tabId?: string; notices: Note[]; control: string }[]
  browserReveal(id: string): void
  ext: {
    note: { openPreview(side: boolean): string | undefined }
    regency: { select(channelId: string): void; quickView(t: { kind: 'pane'; id: string }, focus?: boolean): void; model(): unknown }
    channels: { embedView(id: string): { loaded: boolean; rows: { text: string; mine?: boolean }[] } | undefined; marks(id: string): { toMe: number; unread: number } }
  }
}
declare const window: { __tether: Hooks }
declare const document: {
  querySelector(s: string): { getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } } | null
  querySelectorAll(s: string): ArrayLike<unknown>
  createElement(t: string): any
  body: { append(e: unknown): void }
}
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  shield(tabId: string): boolean | undefined
  registry: { surface(tabId: string): { state(): Surface } | undefined; webContents(tabId: string): { capturePage(): Promise<{ toPNG(): { toString(enc: string): string } }> } | undefined }
}

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas'
const REGENCY = 'regency.main'

// A page that shows it is alive: a counter that goes on every 100 ms, on a colour no part of the interface has.
const LIVE = `<!doctype html><title>Página viva</title><body style="margin:0;font:20px sans-serif;background:#1f6f5c;color:#fff">
<div style="padding:28px"><h1 style="margin:0 0 12px">Página viva</h1><p>Esta página está rodando no navegador do tether.</p>
<p>Contador: <b id="n">0</b></p></div>
<script>window.ticks = 0; setInterval(function () { window.ticks++; document.getElementById('n').textContent = String(window.ticks) }, 100)</script>`

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/live.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LIVE) }
    res.writeHead(404).end('not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = cleanEnv()
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_BROWSER_EAGER = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  app.context().on('dialog', () => {})
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const near = (a: Rect | undefined, b: Rect | undefined, tol = 1.5): boolean =>
  !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol

test('quick view V4: the browser page lent alive to the card (modal and docked), the HTML preview as a copy', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const site = await serve()
  const home = tempHome()
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = '1'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  contribution.channels = () => []

  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
    log: m => logs.push(m),
  })
  const doorApi = door.apiFor('channels', own)
  own.add(doorApi.delivery.enable())
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  let app: ElectronApplication | undefined
  try {
    const a = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'conferente', desk: 'desk-1' })).slotId
    await waitUntil(() => doorApi.slots.get(a)?.status === 'running' && doorApi.slots.readScreen(a).data.includes('READY'), 30_000, 'agent running')
    await waitUntil(() => doorApi.delivery.pathOf(a) === 'inside', 30_000, 'agent opened its stream')
    const made = await ch.create(USER, { name: 'obra', title: 'Obra' })
    assert.ok(made.ok)
    const obra = made.channel.id
    assert.ok((await ch.join(USER, obra, a)).ok)
    assert.ok((await ch.say(a, obra, { body: 'Abro a página e olho.' })).ok)

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    const T = app
    await T.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 900))
    await page.waitForFunction(() => typeof window.__tether.ext?.regency?.model === 'function' && typeof window.__tether.openNote === 'function')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), a)
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, arg?: unknown): Promise<R> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, arg) as Promise<R>
    const until = async <V>(what: string, fn: () => Promise<V | undefined | false>, ms = 15_000): Promise<V> => {
      const end = Date.now() + ms
      let last: unknown
      while (Date.now() < end) {
        try { const v = await fn(); if (v) return v } catch (e) { last = e }
        await page.waitForTimeout(120)
      }
      throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}`)
    }
    const rectOf = (sel: string): Promise<Rect | undefined> => page.evaluate(s => {
      const r = document.querySelector(s)?.getBoundingClientRect()
      return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined
    }, sel)
    const count = (sel: string): Promise<number> => page.evaluate(s => document.querySelectorAll(s).length, sel)
    const freeze = (): Promise<Freeze> => page.evaluate(() => window.__tether.freeze())
    const peekState = (): Promise<{ open: boolean; pane?: string; mode?: string }> => page.evaluate(() => window.__tether.peekState())
    const homeDesk = await page.evaluate(() => window.__tether.activeDesk())

    // ---- the agent's tab on the Browser desk, alive ----
    console.log('step 0')
    const tabId = (await B((t, x) => t.create(x.owner, x.url), { owner: a, url: `${site.base}/live.html` })).tabId
    const webPane = `web:${tabId}`
    const surface = (): Promise<Surface> => B((t, id) => t.registry.surface(id)?.state(), tabId)
    const ticks = async (): Promise<number> => Number(await B((t, id) => t.eval(id, 'window.ticks'), tabId))
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), webPane)
    await until('the page runs', async () => (await ticks()) > 0, 20_000)
    await B((t, id) => t.eval(id, 'window.__mark = 7; 1'), tabId)
    assert.notEqual(await page.evaluate(() => window.__tether.activeDesk()), 'browser.desk', 'the Browser desk is not the one shown')
    const CARD_PAGE = '.peek-pane .br-web-page'
    const SHELL_PAGE = `.pane-shell[data-pane="${webPane}"] .br-web-page`

    // The page in a shot: the view's own capture painted at main's rectangle for it (the hidden window's capture lacks it).
    const shotWithPage = async (file: string): Promise<void> => {
      const png = await B((t, id) => t.registry.webContents(id)?.capturePage().then(i => i.toPNG().toString('base64')), tabId)
      const st = await surface()
      const r = st?.effective
      assert.ok(png && r, 'the page and its rectangle for the shot')
      await page.evaluate(([src, rect]) => new Promise<void>(done => {
        const img = document.createElement('img')
        img.id = 'shot-native-page'
        img.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:2147483647;pointer-events:none`
        img.onload = () => done()
        img.src = `data:image/png;base64,${src}`
        document.body.append(img)
      }), [png, r] as const)
      await page.screenshot({ path: join(SHOTS, file) })
      await page.evaluate(() => { (document.querySelector('#shot-native-page') as unknown as { remove(): void } | null)?.remove() })
    }

    // ---- 1. modal: alive in the card's rectangle ----
    console.log('step 1')
    await page.evaluate(id => window.__tether.peekPane(id), webPane)
    await page.waitForSelector(`#peek[data-open="true"][data-mode="modal"] ${CARD_PAGE}`)
    assert.equal(await count(`.pane-shell[data-pane="${webPane}"] > .peek-lent`), 1, 'the tab shows "sendo espiada"')
    const inCard = await until('the view placed in the card', async () => {
      const [st, el] = [await surface(), await rectOf(CARD_PAGE)]
      return st?.visibility === 'shown' && near(st.rect, el) && st
    })
    const body = (await rectOf('#peek .peek-body'))!
    assert.ok(inCard.rect!.x >= body.x - 0.5 && inCard.rect!.y >= body.y - 0.5 && inCard.rect!.x + inCard.rect!.width <= body.x + body.width + 0.5 && inCard.rect!.y + inCard.rect!.height <= body.y + body.height + 0.5,
      `the view inside the card's body: ${JSON.stringify({ view: inCard.rect, body })}`)
    const f1 = await until('the window behind frozen, the card spared', async () => { const f = await freeze(); return f.reasons.includes('peek') && f.pictures === 0 && f })
    assert.ok(f1, 'peek holds; no picture over the card page')
    const t1 = await ticks()
    await until('the page goes on in the card', async () => (await ticks()) > t1 + 5)
    await until('the agent\'s shield on over the page in the card', async () => (await B((t, id) => t.shield(id), tabId)) === true)
    await page.waitForTimeout(300)
    await shotWithPage('r3-cartao-navegador.png')

    // The person clicks the page: the shield answers in the card, with the way to take the tab. (The shield is a view of the
    // process the page lives in: the browser process when there is one, else the app's main.)
    const clickShield = (electron: any): number => {
      let n = 0
      if (!electron) return n
      for (const w of electron.webContents.getAllWebContents()) if (w.getURL().startsWith('data:text/html')) {
        w.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 })
        w.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 })
        n++
      }
      return n
    }
    const clicked = Number(await inBrowser(T, clickShield)) + Number(await T.evaluate(clickShield))
    assert.ok(clicked >= 1, 'a shield was there to click')
    const ignored = await until('the ignored-click notice', async () => (await page.evaluate(id => window.__tether.browserPanes().find(p => p.id === id), webPane))?.notices.find(n => n.kind === 'ignored'))
    assert.equal(ignored.action, 'Assumir')
    assert.equal(await count('#peek .br-web-note[data-kind="ignored"]'), 1, 'the notice is in the card')
    assert.equal(await B((t, id) => t.shield(id), tabId), true, 'still the agent\'s: the click did not take it')

    // A menu over the card: the card's page freezes under it (a picture), and lives again when it closes.
    await page.click('#peek .qv-menu')
    await page.waitForSelector('.menu[role="menu"]:not([hidden])')
    await until('the card page frozen under the menu', async () => { const [f, st] = [await freeze(), await surface()]; return f.reasons.includes('menu') && f.pictures >= 1 && st?.visibility === 'parked' })
    await page.keyboard.press('Escape')
    await until('the menu closed, the page back', async () => { const [f, st] = [await freeze(), await surface()]; return !f.reasons.includes('menu') && f.pictures === 0 && st?.visibility === 'shown' })

    // The window resized: the view follows the card.
    await T.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1300, 780))
    await until('the view follows the resized card', async () => {
      const [st, el] = [await surface(), await rectOf(CARD_PAGE)]
      return st?.visibility === 'shown' && el && el.width < inCard.rect!.width && near(st.rect, el)
    })
    await T.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 900))
    await until('the view follows it back', async () => { const [st, el] = [await surface(), await rectOf(CARD_PAGE)]; return st?.visibility === 'shown' && el && el.width > inCard.rect!.width - 2 && near(st.rect, el) })

    // Closed: the pane is back in its tab whole; the view hidden (the Browser desk is not shown), the page not reloaded.
    await page.click('#peek .qv-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    assert.equal(await count(`.pane-shell[data-pane="${webPane}"] > .br-web`), 1, 'the pane is back in its shell')
    assert.equal(await count('.peek-lent'), 0, 'no notice left')
    assert.equal(await count('.peek-tab-eye'), 0, 'no eye left')
    await until('the view hidden with its tab', async () => (await surface())?.visibility === 'hidden')
    assert.deepEqual((await freeze()).reasons, [], 'nothing holds the freeze')
    assert.equal(await B((t, id) => t.eval(id, 'window.__mark'), tabId), 7, 'the same page: not reloaded')
    await page.evaluate(id => window.__tether.browserReveal(id), webPane)
    await until('in its tab again, at the tab\'s rectangle', async () => { const [st, el] = [await surface(), await rectOf(SHELL_PAGE)]; return st?.visibility === 'shown' && near(st.rect, el) })
    await page.evaluate(d => window.__tether.switchDesk(d), homeDesk)
    await until('hidden again', async () => (await surface())?.visibility === 'hidden')

    // ---- 2. docked over the Regency's conversation ----
    console.log('step 2')
    await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), REGENCY)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, REGENCY)
    await page.evaluate(id => window.__tether.ext.regency.select(id), obra)
    await until('the conversation shown', async () => (await page.evaluate(id => window.__tether.ext.channels.embedView(id), obra))?.loaded === true)
    await page.evaluate(id => window.__tether.ext.regency.quickView({ kind: 'pane', id }), webPane)
    await page.waitForSelector(`#peek[data-open="true"][data-mode="docked"] ${CARD_PAGE}`)
    const docked = await until('the view placed in the docked card', async () => {
      const [st, el] = [await surface(), await rectOf(CARD_PAGE)]
      return st?.visibility === 'shown' && near(st.rect, el) && st.rect
    })
    const tree = (await rectOf('.rg-tree'))!
    const centre = (await rectOf('.rg-center'))!
    const BOX = `.rg-center .ch-pane[data-channel="${obra}"] .ch-composer-slot textarea`
    const box = (await rectOf(BOX))!
    const apart = (p: Rect, q: Rect): boolean => p.x + p.width <= q.x + 0.5 || q.x + q.width <= p.x + 0.5 || p.y + p.height <= q.y + 0.5 || q.y + q.height <= p.y + 0.5
    assert.ok(apart(docked, tree), `the view never over the tree: ${JSON.stringify({ view: docked, tree })}`)
    assert.ok(docked.x >= centre.x - 0.5 && docked.x + docked.width <= centre.x + centre.width + 0.5 && docked.y >= centre.y - 0.5, `the view over the conversation's area only: ${JSON.stringify({ view: docked, centre })}`)
    assert.ok(docked.y + docked.height <= box.y + 0.5, `the view never over the box of speech: ${JSON.stringify({ view: docked, box })}`)
    assert.equal((await freeze()).reasons.includes('peek'), false, 'docked: no freeze')
    const t2 = await ticks()
    await until('alive in the docked card', async () => (await ticks()) > t2 + 5)
    await page.locator(BOX).click()
    await page.locator(BOX).fill('Falo com a página aberta no cartão.')
    await page.keyboard.press('Enter')
    await until('the line went with the card open', async () => (await page.evaluate(id => window.__tether.ext.channels.embedView(id), obra))?.rows.some(r => r.text === 'Falo com a página aberta no cartão.' && r.mine) === true)
    assert.equal((await peekState()).open, true, 'the card stays')
    assert.equal((await surface())?.visibility, 'shown', 'and the page with it')
    await page.waitForTimeout(300)
    await shotWithPage('r3-cartao-navegador-regencia.png')
    // R-4: a popover of the conversation (the "@" list) opened with the card docked would open UNDER the native page: the page
    // freezes (a picture) while it is open, and lives again when it closes.
    const PANE_SEL = `.rg-center .ch-pane[data-channel="${obra}"]`
    await page.locator(BOX).fill('@')
    const listOpen = await until('the "@" list open', async () => (await count(`${PANE_SEL} .ch-mention-list:not([hidden])`)) === 1, 5_000).catch(() => false)
    await page.waitForTimeout(400)
    const r4 = { list: listOpen, frozen: (await freeze()).reasons.includes('popover'), page: (await surface())?.visibility }
    await page.keyboard.press('Escape')
    await page.locator(BOX).fill('')
    await page.waitForTimeout(400)
    const r4after = { frozen: (await freeze()).reasons.includes('popover'), page: (await surface())?.visibility, card: (await peekState()).open }
    // R-1: a line for the person that sits UNDER the docked card is not seen (its mark stays); closing the card shows it, and then it is.
    const marks = (): Promise<{ toMe: number; unread: number }> => page.evaluate(i => window.__tether.ext.channels.marks(i), obra)
    const toHer = await ch.say(a, obra, { body: 'Preciso da sua decisão sobre o índice.', to: [MODERATOR_NAME] })
    assert.ok(toHer.ok)
    for (let i = 1; i <= 6; i++) assert.ok((await ch.say(a, obra, { body: `Linha de contexto ${i}.` })).ok)
    await until('the lines shown', async () => (await page.evaluate(id => window.__tether.ext.channels.embedView(id), obra))?.rows.some(r => r.text === 'Linha de contexto 6.') === true)
    await page.waitForTimeout(800)
    const rowRect = (await rectOf(`${PANE_SEL} .ch-msg[data-seq="${toHer.line.seq}"]`))!
    const cardRect = (await rectOf('#peek .peek-card'))!
    const midY = rowRect.y + rowRect.height / 2
    const r1 = { under: midY > cardRect.y && midY < cardRect.y + cardRect.height && rowRect.x + rowRect.width / 2 > cardRect.x, toMe: (await marks()).toMe }
    assert.deepEqual({ r4, r4after, r1 }, {
      r4: { list: true, frozen: true, page: 'parked' },
      r4after: { frozen: false, page: 'shown', card: true },
      r1: { under: true, toMe: 1 },
    }, `${JSON.stringify({ rowRect, cardRect })}`)
    await page.click('#peek .qv-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    await until('the line seen once the card is gone', async () => (await marks()).toMe === 0, 5_000)
    assert.equal(await count(`.pane-shell[data-pane="${webPane}"] > .br-web`), 1, 'back in its shell')
    await until('hidden with its tab', async () => (await surface())?.visibility === 'hidden')
    assert.equal(await B((t, id) => t.eval(id, 'window.__mark'), tabId), 7, 'still not reloaded')

    // ---- 3. the HTML preview: a copy in the card, the tab untouched ----
    console.log('step 3')
    await page.evaluate(d => window.__tether.switchDesk(d), homeDesk)
    const otherDesk = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(d => window.__tether.switchDesk(d), otherDesk)
    const htmlPath = join(home, 'pagina.html')
    writeFileSync(htmlPath, '<!doctype html><title>Prévia</title><body style="margin:0;font:20px sans-serif;background:#2b3f8f;color:#fff"><div style="padding:28px"><h1>Prévia de HTML</h1><p>Uma cópia desta página no cartão; a guia segue rodando a dela.</p></div>')
    await page.evaluate(p => window.__tether.openNote(p), htmlPath)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    await page.waitForTimeout(200)
    const previewId = (await page.evaluate(() => window.__tether.ext.note.openPreview(false)))!
    assert.ok(previewId, 'the preview tab')
    const html = (id: string): Promise<Html | undefined> => page.evaluate(i => window.__tether.htmlPreview(i), id)
    const original = await until('the preview loaded', async () => { const h = await html(previewId); return h?.contentsId !== undefined && h.loads >= 1 && h })
    await T.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.__mark = 9; 1'), original.contentsId!)
    await page.evaluate(d => window.__tether.switchDesk(d), homeDesk)

    await page.evaluate(id => window.__tether.peekPane(id), previewId)
    await page.waitForSelector('#peek[data-open="true"] .peek-pane .html-preview webview')
    const copy = await until('the copy loaded', async () => {
      const c = (await page.evaluate(() => window.__tether.htmlPreviews())).find(h => h.id !== previewId)
      return c && c.contentsId !== undefined && c.loads >= 1 && c
    })
    assert.ok(copy.id.startsWith(`${previewId}~peek-`), `the copy has an id of its own: ${copy.id}`)
    assert.equal(copy.path.toLowerCase(), original.path.toLowerCase(), 'the same file')
    assert.notEqual(copy.contentsId, original.contentsId, 'its own guest')
    assert.notEqual(copy.partition, original.partition)
    const now = (await html(previewId))!
    assert.equal(now.contentsId, original.contentsId, 'the tab\'s guest is the same')
    assert.equal(now.loads, original.loads, 'the tab did not reload')
    assert.equal(await T.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.__mark'), original.contentsId!), 9, 'the tab\'s page kept its state')
    assert.equal(await count(`.pane-shell[data-pane="${previewId}"] > .peek-lent`), 0, 'no "sendo espiada" on the tab')
    assert.equal(await count(`.pane-shell[data-pane="${previewId}"] .html-preview webview`), 1, 'the tab keeps its own page')
    assert.equal(await count('.peek-tab-eye'), 0, 'no eye on the tab')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, 'r3-cartao-previa-html.png') })
    await page.click('#peek .qv-close')
    await page.waitForSelector('#peek', { state: 'hidden' })
    await until('the copy dropped', async () => (await page.evaluate(() => window.__tether.htmlPreviews())).length === 1)
    const after = (await html(previewId))!
    assert.equal(after.contentsId, original.contentsId)
    assert.equal(after.loads, original.loads, 'still not reloaded')
  } finally {
    contribution.channels = savedChannels
    if (app) await killElectron(app, root).catch(() => {})
    site.server.close()
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
