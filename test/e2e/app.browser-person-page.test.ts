// E2E of the page in the person's hands (navegador da pessoa, F3/N3): the app built with TETHER_TEST_EXTENSIONS=1, hidden window,
// private home and pipe, real tetherd. On a tab of hers (owner `person`):
//   1. the page's `alert`, `confirm` and `prompt` show in the band of her pane (no native box, no question dialog of the app), her
//      answer reaches the page and the page goes on;
//   2. `<input type=file>` opens the tether's chooser (stood in by a list with one file: no window opens in a test) and the page
//      receives the file;
//   3. a download lands in the system's Downloads folder (a test build: a folder of its home), never in the agents' tree, and the
//      pad's "Baixados" lists it under "Você";
//   4. Ctrl+L typed with the focus inside the page opens the address field (the page never sees it); her tab throttles in the
//      background;
//   5. on an AGENT's tab (control `agent`) a dialog is not answered by the tether (no band; it waits for the agent's CDP), Ctrl+L
//      stays with the page and the chooser of the tether never opens; the tab does not throttle.
// Screenshots go to BROWSER_PERSON_PAGE_SHOTS (default test/e2e/artifacts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { daemonMain, inBrowser, launchHidden, pidAlive, root, sleep } from './browser-kit.ts'

type Band = { kind: string; head: string; message: string; value: string | null; buttons: string[] }
type Pane = { id: string; tabId?: string; owner?: string; addressField: { editing: boolean; value: string; editable: boolean } }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    browserPanes(): Pane[]
    browserNewTab(url?: string): Promise<string | undefined>
    browserReveal(id: string): void
    browserPageDialog(tabId: string): Band | null
    browserPageDialogAnswer(tabId: string, accept: boolean, text?: string): boolean
    browserPadOpen(): void
    browserPad(): { downloads: { slotId: string; agent: string; files: { name: string }[] }[] } | undefined
  }
}
type Tabs = {
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[]; surface(id: string): { debugger: { send(m: string, p?: object): Promise<unknown> } } | undefined }
  create(owner: string, url: string, ticket?: boolean | string): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  control: { view(id: string): { holder: string }; take(id: string): void }
  setChooser(paths: string[] | null): void
  chooserCalls(): number
  pageDialogs(): { tabId: string; kind: string }[]
  throttling(tabId: string): boolean | undefined
  ctrlKey(tabId: string, key: string): void
  downloadsDir(): string
  personDownloadsDir(): string
}

const pipe = `\\\\.\\pipe\\tether-brpage-${process.pid}`
const AGENT = 'a1b2c3d4'
const shotsDir = process.env.BROWSER_PERSON_PAGE_SHOTS ?? join(root, 'test', 'e2e', 'artifacts')

const PAGE = `<!doctype html><title>Página com diálogos</title><link rel="icon" href="data:,">
<body style="font:16px sans-serif;padding:24px">
<h1>PAGE-READY</h1>
<input type="file" id="f">
<a id="dl" href="/arquivo.txt">baixar</a>
<script>
  window.__keys = []
  addEventListener('keydown', e => { if (e.ctrlKey) window.__keys.push(e.key.toLowerCase()) })
  window.__file = ''
  document.getElementById('f').addEventListener('change', async e => { const f = e.target.files[0]; window.__file = f ? f.name + ':' + (await f.text()) : 'none' })
</script>`

function servePages(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/page.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE) }
    if (path === '/arquivo.txt') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="arquivo.txt"' })
      return res.end('CONTEUDO-BAIXADO')
    }
    res.writeHead(404).end('not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

test('browser: the page in her hands (dialogs, chooser, downloads, Ctrl+L); an agent\'s tab is left to its agent', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shotsDir, { recursive: true })
  const pages = await servePages()
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-brpage-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'ask' } } }))
  // The file the stand-in chooser returns.
  const picked = join(home, 'escolhido.txt')
  writeFileSync(picked, 'ARQUIVO-ESCOLHIDO')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R, arg?: unknown): Promise<Awaited<R>> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`), arg) as Promise<Awaited<R>>
    const pageEval = (tabId: string, code: string): Promise<unknown> => B((t, a) => t.eval(a.id, a.code), { id: tabId, code })
    const band = (tabId: string): Promise<Band | null> => win.evaluate(id => window.__tether.browserPageDialog(id), tabId)
    const answer = (tabId: string, accept: boolean, text?: string): Promise<boolean> => win.evaluate(([id, a, x]) => window.__tether.browserPageDialogAnswer(id as string, a as boolean, x as string | undefined), [tabId, accept, text] as const)
    const appDialogs = (): Promise<string[]> => win.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(d => (d as HTMLElement).dataset.dialog ?? '?'))
    const pane = async (tabId: string): Promise<Pane | undefined> => (await win.evaluate(() => window.__tether.browserPanes())).find(p => p.tabId === tabId)
    const shot = async (name: string): Promise<void> => { await win.mouse.move(5, 5); await sleep(300); await win.screenshot({ path: join(shotsDir, `browser-person-page-${name}.png`) }) }

    // ---- her tab, the page loaded ----
    const url = `${pages.base}/page.html`
    const mine = await win.evaluate(u => window.__tether.browserNewTab(u), url)
    assert.ok(mine, 'her tab opened')
    await until('her page loaded', async () => (await pageEval(mine, 'document.body && document.body.innerText.includes("PAGE-READY")')) === true, 20_000)
    assert.equal(await B((t, id) => t.control.view(id).holder, mine), 'user')

    // ---- 1. alert, confirm, prompt in the band ----
    await pageEval(mine, `setTimeout(() => { alert('Olá da página'); window.__a = 'seguiu' }, 10); 1`)
    const alertBand = await until('the alert in the band', () => band(mine))
    assert.deepEqual(alertBand, { kind: 'alert', head: `${pages.base} diz`, message: 'Olá da página', value: null, buttons: ['OK'] })
    assert.deepEqual(await appDialogs(), [], 'no question dialog of the app: the band is in the pane')
    assert.deepEqual((await B(t => t.pageDialogs())).map(d => [d.tabId, d.kind]), [[mine, 'alert']])
    await shot('alert')
    assert.equal(await answer(mine, true), true)
    await until('the page went on after OK', async () => (await pageEval(mine, 'window.__a')) === 'seguiu')
    assert.equal(await band(mine), null, 'the band went with the answer')

    await pageEval(mine, `setTimeout(() => { window.__c = confirm('Seguir adiante?') }, 10); 1`)
    const confirmBand = await until('the confirm in the band', () => band(mine))
    assert.equal(confirmBand.kind, 'confirm')
    assert.deepEqual(confirmBand.buttons, ['Cancelar', 'OK'])
    await shot('confirm')
    await answer(mine, false)
    await until('confirm() returned false', async () => (await pageEval(mine, 'window.__c')) === false)
    await pageEval(mine, `setTimeout(() => { window.__c = confirm('De novo?') }, 10); 1`)
    await until('the second confirm', () => band(mine))
    await answer(mine, true)
    await until('confirm() returned true', async () => (await pageEval(mine, 'window.__c')) === true)

    // `prompt`: Electron replaces it in every page with a function that throws (no dialog is ever opened, for the agent's CDP
    // either): pinned here until the regency decides (the band is ready for it: page-rules `pageDialogOf`, `dialogReply`).
    const promptError = await pageEval(mine, `(() => { try { prompt('Seu nome?', 'Ana'); return 'no error' } catch (e) { return String(e && e.message) } })()`)
    console.log(`[person-page] prompt() in the page: ${JSON.stringify(promptError)}`)
    assert.notEqual(promptError, 'no error', 'prompt() throws in an Electron page (pinned)')
    assert.equal(await band(mine), null, 'no band: no dialog was opened')

    // ---- 2. the file chooser of the tether ----
    await B((t, p) => t.setChooser([p]), picked)
    await pageEval(mine, `document.getElementById('f').click(); 1`)
    await until('the tether\'s chooser opened', async () => (await B(t => t.chooserCalls())) === 1)
    assert.equal(await until('the page received the file', async () => { const v = await pageEval(mine, 'window.__file'); return v ? v : undefined }), 'escolhido.txt:ARQUIVO-ESCOLHIDO')

    // ---- 3. a download of hers: the system's Downloads folder (its stand-in), "Baixados" under "Você" ----
    await pageEval(mine, `document.getElementById('dl').click(); 1`)
    const folder = await B(t => t.personDownloadsDir())
    assert.ok(folder.startsWith(home), 'a test build never writes to the real Downloads folder')
    await until('her download saved in the Downloads folder', async () => existsSync(join(folder, 'arquivo.txt')))
    assert.equal(existsSync(join(await B(t => t.downloadsDir()), 'person')), false, 'nothing of hers in the agents\' downloads tree')
    await win.evaluate(() => window.__tether.browserPadOpen())
    const pad = await until('"Baixados" lists it', async () => {
      const p = await win.evaluate(() => window.__tether.browserPad())
      return p?.downloads.find(d => d.slotId === 'person' && d.files.some(f => f.name === 'arquivo.txt'))
    })
    assert.equal(pad.agent, 'Você')
    await shot('downloads')

    // ---- 4. Ctrl+L with the focus in her page; her tab throttles in the background ----
    await win.evaluate(id => window.__tether.browserReveal(id), (await pane(mine))!.id)
    await until('the field closed', async () => (await pane(mine))?.addressField.editing === false)
    await B((t, id) => t.ctrlKey(id, 'L'), mine)
    await until('Ctrl+L in the page opened the address field', async () => (await pane(mine))?.addressField.editing)
    assert.deepEqual(await pageEval(mine, 'window.__keys'), [], 'the page never saw Ctrl+L')
    await shot('ctrl-l')
    await win.keyboard.press('Escape')
    assert.equal(await B((t, id) => t.throttling(id), mine), true, 'her tab throttles out of view')

    // ---- 5. an agent's tab: left to the agent ----
    // A granted first ticket (as a restored tab): no local-network question in the way.
    const agentTab = (await B((t, a) => t.create(a.owner, a.url, 'granted'), { owner: AGENT, url })).tabId
    await until('the agent\'s page loaded', async () => (await pageEval(agentTab, 'document.body && document.body.innerText.includes("PAGE-READY")')) === true, 20_000)
    assert.equal(await B((t, id) => t.control.view(id).holder, agentTab), 'agent')
    assert.equal(await B((t, id) => t.throttling(id), agentTab), false, 'an agent\'s tab never throttles')
    await until('the agent\'s pane', () => pane(agentTab))
    await pageEval(agentTab, `setTimeout(() => { window.__c = confirm('Do agente?') }, 10); 1`)
    await sleep(1500)
    assert.equal(await band(agentTab), null, 'no band on the agent\'s tab')
    assert.deepEqual(await B(t => t.pageDialogs()), [], 'main serves no dialog of the agent\'s tab')
    assert.deepEqual(await appDialogs(), [])
    // The dialog is still open, waiting for CDP: answered here as the agent would (Page.handleJavaScriptDialog), the page goes on.
    await B((t, id) => t.registry.surface(id)!.debugger.send('Page.handleJavaScriptDialog', { accept: true }), agentTab)
    await until('the agent\'s answer reached the page', async () => (await pageEval(agentTab, 'window.__c')) === true)
    await B((t, id) => t.ctrlKey(id, 'L'), agentTab)
    await until('the agent\'s page got Ctrl+L', async () => JSON.stringify(await pageEval(agentTab, 'window.__keys')) === '["l"]')
    assert.equal((await pane(agentTab))?.addressField.editing, false, 'the address field stays closed')
    await pageEval(agentTab, `document.getElementById('f').click(); 1`)
    await sleep(800)
    assert.equal(await B(t => t.chooserCalls()), 1, 'the tether\'s chooser never opens for an agent\'s tab')
    assert.equal(await pageEval(agentTab, 'window.__file'), '')
    // Temper N3-1: taken by her ("Assumir"), the agent's tab still gets no tether chooser (the agent's upload consent is the way).
    await B((t, id) => t.control.take(id), agentTab)
    await until('she holds the agent\'s tab', async () => (await B((t, id) => t.control.view(id).holder, agentTab)) === 'user')
    await pageEval(agentTab, `document.getElementById('f').click(); 1`)
    await sleep(800)
    assert.equal(await B(t => t.chooserCalls()), 1, 'no tether chooser on an agent\'s tab she took')
    assert.equal(await pageEval(agentTab, 'window.__file'), '')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    pages.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
