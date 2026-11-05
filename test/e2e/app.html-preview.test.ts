// E2E of the HTML preview (F5): against the real tetherd on a private home/pipe, hidden window, a PowerShell pane opened in a
// temporary folder. The page is the author's and RUNS; it lives in an isolated webview.
//   1. Ctrl+click on a printed `...\demo.html` opens "Prévia: demo.html" as a tab of the SHELL's group (not a note);
//   2. the page's script ran (the DOM changed) and the page has nothing of the app: no require/process/window.tether/electron;
//      the guest is a webview with sandbox + context isolation + no node + no preload, on an in-memory session of its own;
//      geolocation and notifications are denied, a download is cancelled;
//   3. files: the page's own folder loads (image, script); a file outside it (image, script, iframe) does not; plain http and the
//      local network are refused; https is not (a CDN is allowed as a sub-resource); the strip counts what was refused;
//   4. links: https → the system browser (recorded, nothing opens), window.open → the same, a link outside the folder is dropped,
//      a link inside it navigates the preview;
//   5. Ctrl+P on another .html opens its preview; Ctrl+Shift+V on an .html note opens a preview too, an existing one is focused;
//      "Ver código" opens the source as a note, "Abrir no navegador" hands the file to the system (recorded);
//   6. a chord pressed inside the page reaches the app (Ctrl+Shift+P opens the palette);
//   7. live: a change of the page's file, or of a file it loaded, reloads it keeping the scroll; an unrelated file does not;
//   8. the main process is killed and relaunched: the previews come back, tied to their files, same group, scroll restored;
//   9. screenshots html-preview-{dark,light}.png.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Html = { id: string; path: string; currentPath: string; url: string; partition: string; contentsId: number | undefined; files: string[]; blocked: Array<{ url: string; reason: string }>; loads: number; scroll: { x: number; y: number }; state: string | undefined; visible: boolean }
type Note = { id: string; path: string; text: string; cursor?: { lineNumber: number; column: number } }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  groupOf(id: string): string | undefined
  frameOf(id: string): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  commands(): { id: string; title: string; hint: string; available: boolean }[]
  notes(): Note[]
  note(id: string): (Note & { focused: boolean }) | undefined
  openNote(path: string): Promise<void>
  htmlPreviews(): Html[]
  htmlPreview(id: string): Html | undefined
  htmlPreviewRect(id: string): { x: number; y: number; width: number; height: number } | undefined
  palette(): { open: boolean; mode?: string; shown: string[]; input: string }
  text(id: string): string
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
  layout(): unknown
}
declare const window: { __tether: Hooks }
declare const document: { querySelector(sel: string): any; querySelectorAll(sel: string): { length: number } & Iterable<any>; documentElement: { dataset: Record<string, string> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-htmlpreview-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text().slice(0, 300)}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 820))
  // Nothing is really opened: what main hands to the system is recorded.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __external: string[]; __paths: string[] }
    g.__external = []; g.__paths = []
    shell.openExternal = async (url: string) => { g.__external.push(url) }
    shell.openPath = async (p: string) => { g.__paths.push(p); return '' }
  })
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

/** Prints `parts` joined (the typed command never contains the printed text, so the text is on screen once) and waits for it. */
async function print(page: Page, id: string, ...parts: string[]): Promise<string> {
  const printed = parts.join('')
  await page.keyboard.type(`Write-Output (${parts.map(p => `'${p}'`).join('+')})`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, needle]) => window.__tether.screenPos(id!, needle!) !== undefined, [id, printed] as [string, string])
  return printed
}

async function pointOf(page: Page, id: string, needle: string, offset = 2): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(([id, n]) => window.__tether.screenPos(id!, n!), [id, needle])
  assert.ok(pos, `${needle} is on screen`)
  const cell = (await page.evaluate(id => window.__tether.cellSize(id), id))!
  const box = (await page.locator(`.panel[data-slot-id="${id}"] .xterm-screen`).boundingBox())!
  return { x: box.x + (pos.col + offset + 0.5) * cell.width, y: box.y + (pos.row + 0.5) * cell.height }
}

async function ctrlClick(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(5, 5)
  await page.keyboard.down('Control')
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up('Control')
  await page.mouse.move(5, 5)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64')

/** Runs code in the page of a preview's guest, from main (the app itself has no way into a guest). */
function inGuest<T>(app: ElectronApplication, contentsId: number, code: string): Promise<T> {
  return app.evaluate(({ webContents }, [id, src]) => {
    const wc = webContents.fromId(id as number)
    if (!wc) throw new Error(`no guest ${id}`)
    return wc.executeJavaScript(src as string)
  }, [contentsId, code] as const) as Promise<T>
}

/** What main knows of a guest: type, session, the preferences it was created with. */
function guestFacts(app: ElectronApplication, contentsId: number): Promise<{ type: string; persistent: boolean; isDefaultSession: boolean; prefs: Record<string, unknown>; url: string; windows: number }> {
  return app.evaluate(({ webContents, session }, id) => {
    const wc = webContents.fromId(id)!
    const p = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences() ?? {}
    return {
      type: wc.getType(), persistent: wc.session.isPersistent(), isDefaultSession: wc.session === session.defaultSession, url: wc.getURL(),
      prefs: { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox, preload: p.preload, webSecurity: p.webSecurity, webviewTag: p.webviewTag, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames },
      windows: webContents.getAllWebContents().filter(w => w.getType() === 'webview').length,
    }
  }, contentsId)
}

/** A real click inside the guest: the element's centre, sent as input events to the page's own process. */
async function clickIn(app: ElectronApplication, contentsId: number, selector: string): Promise<void> {
  const r = await inGuest<{ x: number; y: number }>(app, contentsId, `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); var r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await app.evaluate(({ webContents }, [id, x, y]) => {
    const wc = webContents.fromId(id as number)!
    wc.sendInputEvent({ type: 'mouseMove', x: x as number, y: y as number })
    wc.sendInputEvent({ type: 'mouseDown', x: x as number, y: y as number, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: x as number, y: y as number, button: 'left', clickCount: 1 })
  }, [contentsId, r.x, r.y] as const)
}

const DEMO = (outsideUrl: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo</title><style>body { font-family: sans-serif; background: #fffbe6; color: #222 }</style></head>
<body>
<h1 id="t">antes</h1>
<pre id="probe"></pre>
<img id="in" src="img/in.png"><img id="out" src="${outsideUrl}/out.png"><img id="cdn" src="https://cdn.example.invalid/p.png"><img id="plain" src="http://example.com/p.png"><img id="lan" src="https://192.168.0.7/p.png">
<iframe id="fin" src="next.html" width="40" height="20"></iframe><iframe id="fout" src="${outsideUrl}/secret.html" width="40" height="20"></iframe>
<script src="${outsideUrl}/evil.js"></script>
<a id="ext" href="https://example.com/docs">ext</a> <a id="pop" href="#" onclick="window.open('https://example.com/popup'); return false">pop</a>
<a id="next" href="next.html">next</a> <a id="up" href="${outsideUrl}/secret.html">up</a> <a id="dl" download="x.txt" href="data:text/plain,hello">dl</a>
<div style="height:3000px"></div><div id="end">fim</div>
<script src="ext.js"></script>
<script>
document.getElementById('t').textContent = 'rodou'
var probe = { require: typeof require, process: typeof process, module: typeof module, tether: typeof window.tether, electron: typeof window.electron, ipc: typeof window.ipcRenderer, evil: typeof window.evil }
Promise.all([
  new Promise(function (r) { var x = new XMLHttpRequest(); x.open('GET', '${outsideUrl}/secret.txt'); x.onload = function () { r('xhr-read:' + x.responseText) }; x.onerror = function () { r('xhr-blocked') }; x.send() }),
  new Promise(function (r) { navigator.geolocation.getCurrentPosition(function () { r('geo-granted') }, function (e) { r('geo-denied:' + e.code) }) }),
  Notification.requestPermission().then(function (p) { return 'notif:' + p })
]).then(function (r) { probe.results = r; document.getElementById('probe').textContent = JSON.stringify(probe); document.title = 'done' })
</script></body></html>
`

test('app html-preview: Ctrl+click opens a running page in an isolated webview; policy, links, chords, live reload, resume', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-htmlp-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-hp-files-'))
  const dir = join(base, 'page')
  const outside = join(base, 'outside')
  mkdirSync(join(dir, 'img'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  const demo = join(dir, 'demo.html')
  const outsideUrl = `file:///${outside.replace(/\\/g, '/')}`
  writeFileSync(demo, DEMO(outsideUrl))
  writeFileSync(join(dir, 'ext.js'), "document.title = 'ext-v1'; window.extVersion = 1\n")
  writeFileSync(join(dir, 'next.html'), '<!doctype html><title>Next</title><h1 id="n">próxima</h1><a id="back" href="demo.html">voltar</a>')
  writeFileSync(join(dir, 'second.html'), '<!doctype html><title>Second</title><h1>segunda</h1><script>document.querySelector("h1").textContent = "segunda rodou"</script>')
  writeFileSync(join(dir, 'unrelated.txt'), 'x')
  writeFileSync(join(dir, 'img', 'in.png'), PNG)
  writeFileSync(join(outside, 'out.png'), PNG)
  writeFileSync(join(outside, 'secret.txt'), 'SEGREDO')
  writeFileSync(join(outside, 'secret.html'), '<h1>segredo</h1>')
  writeFileSync(join(outside, 'evil.js'), 'window.evil = 1')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const external = (): Promise<string[]> => app!.evaluate(() => (globalThis as unknown as { __external: string[] }).__external)
    const systemPaths = (): Promise<string[]> => app!.evaluate(() => (globalThis as unknown as { __paths: string[] }).__paths)
    const htmls = (): Promise<Html[]> => page.evaluate(() => window.__tether.htmlPreviews())
    const html = (id: string): Promise<Html> => page.evaluate(id => window.__tether.htmlPreview(id)!, id)
    const guestId = async (id: string): Promise<number> => {
      await page.waitForFunction(id => window.__tether.htmlPreview(id)?.contentsId !== undefined, id)
      return (await html(id)).contentsId!
    }
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

    await createShell(page, base)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusPane(page, shell!)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), shell!, { timeout: 20_000 })

    // 1. Ctrl+click on the printed absolute path of the page: its preview, in the shell's group, not a note.
    const half = Math.floor(demo.length / 2)
    const printed = await print(page, shell!, demo.slice(0, half), demo.slice(half))
    await ctrlClick(page, await pointOf(page, shell!, printed, 3))
    await page.waitForFunction(() => window.__tether.htmlPreviews().length === 1)
    const [first] = await htmls()
    const demoId = first!.id
    assert.ok(same(first!.path, demo), 'the preview is tied to the page file')
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, 0, 'an .html opens rendered, not as a note')
    assert.equal(await page.evaluate(([a, b]) => window.__tether.groupOf(a!) === window.__tether.groupOf(b!), [demoId, shell!] as const), true, 'in the shell\'s tab group')
    assert.equal(await page.locator('.tether-tab.preview .text').innerText(), 'Prévia: demo.html')
    assert.equal(await page.evaluate(() => window.__tether.activeId()), demoId, 'the preview is in front')
    const gid = await guestId(demoId)
    for (let i = 0; i < 100 && (await inGuest<string>(app, gid, 'document.title')) !== 'done'; i++) await sleep(150)
    assert.equal(await inGuest<string>(app, gid, 'document.title'), 'done', 'the page finished its script')

    // 2. It runs, and it is alone: nothing of the app reaches it.
    assert.equal(await inGuest<string>(app, gid, "document.getElementById('t').textContent"), 'rodou', 'the page\'s script ran and changed the DOM')
    const probe = JSON.parse(await inGuest<string>(app, gid, "document.getElementById('probe').textContent")) as Record<string, unknown>
    for (const k of ['require', 'process', 'module', 'tether', 'electron', 'ipc', 'evil']) assert.equal(probe[k], 'undefined', `${k} does not exist in the page`)
    assert.deepEqual(probe.results, ['xhr-blocked', 'geo-denied:1', 'notif:denied'], 'a file outside the folder cannot be read; geolocation and notifications are denied')
    const facts = await guestFacts(app, gid)
    assert.equal(facts.type, 'webview')
    assert.deepEqual(facts.prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: undefined, webSecurity: true, webviewTag: false, nodeIntegrationInSubFrames: false })
    assert.equal(facts.persistent, false, 'a session in memory')
    assert.equal(facts.isDefaultSession, false, 'not the app\'s session')
    assert.match((await html(demoId)).partition, /^htmlprev-/)
    // A download is cancelled (the page asks for one).
    await app.evaluate(({ webContents }, id) => {
      const g = globalThis as unknown as { __downloads: { cancelled: boolean }[] }
      g.__downloads = []
      webContents.fromId(id)!.session.on('will-download', e => { g.__downloads.push({ cancelled: false }); setImmediate(() => { g.__downloads[g.__downloads.length - 1]!.cancelled = e.defaultPrevented }) })
    }, gid)
    await clickIn(app, gid, '#dl')
    await sleep(600)
    const downloads = await app.evaluate(() => (globalThis as unknown as { __downloads: { cancelled: boolean }[] }).__downloads)
    assert.ok(downloads.length === 0 || downloads.every(d => d.cancelled), `no download went through (${JSON.stringify(downloads)})`)

    // 3. The file policy: the folder and below load, the rest does not; the strip says how many were refused.
    const images = await inGuest<Record<string, number>>(app, gid, "Object.fromEntries([...document.images].map(i => [i.id, i.naturalWidth]))")
    assert.ok(images.in! > 0, 'the image of the page\'s folder loaded')
    assert.equal(images.out, 0, 'the image outside the folder did not')
    await page.waitForFunction(id => (window.__tether.htmlPreview(id)?.blocked.length ?? 0) >= 4, demoId)
    const snap = await html(demoId)
    const blocked = snap.blocked.map(b => b.url.toLowerCase())
    for (const needle of ['/outside/out.png', '/outside/secret.html', '/outside/evil.js', 'http://example.com/p.png', 'https://192.168.0.7/p.png']) {
      assert.ok(blocked.some(u => u.includes(needle.toLowerCase())), `refused: ${needle} (${blocked.join(' | ')})`)
    }
    assert.ok(!blocked.some(u => u.includes('cdn.example.invalid')), 'an https CDN is allowed as a sub-resource (the request is made; the host does not exist here)')
    assert.ok(snap.files.some(f => same(f, join(dir, 'ext.js'))) && snap.files.some(f => same(f, join(dir, 'img', 'in.png'))) && snap.files.some(f => same(f, join(dir, 'next.html'))), `the page's own files are reported (${snap.files.join(', ')})`)
    assert.ok(!snap.files.some(f => /outside/i.test(f)), 'nothing outside the folder is reported as loaded')
    assert.match(await page.locator(`.html-preview[data-preview-id="${demoId}"] .hp-blocked`).innerText(), /\d+ recursos bloqueados/)

    // 4. Links.
    await clickIn(app, gid, '#ext')
    await waitUntil(async () => (await external()).length === 1)
    assert.deepEqual(await external(), ['https://example.com/docs'], 'an https link goes to the system browser')
    assert.ok(same(fileOf((await guestFacts(app, gid)).url), demo), 'and the preview stays where it was')
    await clickIn(app, gid, '#pop')
    await waitUntil(async () => (await external()).length === 2)
    assert.equal((await external())[1], 'https://example.com/popup', 'window.open goes to the system browser')
    assert.equal((await guestFacts(app, gid)).windows, 1, 'no window was created')
    await clickIn(app, gid, '#up')
    await sleep(500)
    assert.ok(same(fileOf((await guestFacts(app, gid)).url), demo), 'a link to a folder outside the page\'s is dropped')
    assert.equal((await external()).length, 2)
    await clickIn(app, gid, '#next')
    await waitUntil(async () => /next\.html$/i.test((await guestFacts(app!, gid)).url))
    await page.waitForFunction(id => /next\.html$/i.test(window.__tether.htmlPreview(id)!.currentPath), demoId)
    assert.equal(await inGuest<string>(app, gid, "document.getElementById('n').textContent"), 'próxima', 'a link inside the folder navigates the preview')
    await clickIn(app, gid, '#back')
    await waitUntil(async () => /demo\.html$/i.test((await guestFacts(app!, gid)).url))
    await page.waitForFunction(id => window.__tether.htmlPreview(id)!.state === undefined, demoId)

    // 5. "Ver código" opens the file as a note in the same group; Ctrl+Shift+V on that note brings the preview forward (no second one).
    await page.click(`.html-preview[data-preview-id="${demoId}"] .hp-btn[data-action="source"]`)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const src = (await page.evaluate(() => window.__tether.notes()))[0]!
    assert.ok(same(src.path, demo), 'the source of the page')
    assert.equal(await page.evaluate(([a, b]) => window.__tether.groupOf(a!) === window.__tether.groupOf(b!), [src.id, demoId] as const), true)
    await page.locator(`.note-panel[data-note-id="${src.id}"] .monaco-editor`).click()
    await page.waitForFunction(id => window.__tether.note(id)?.focused === true, src.id)
    const cmds = await page.evaluate(() => window.__tether.commands())
    assert.equal(cmds.find(c => c.id === 'markdown.preview')?.available, true, 'the preview command is available on an html note')
    await page.keyboard.press('Control+Shift+V')
    await page.waitForFunction(id => window.__tether.activeId() === id, demoId)
    assert.equal((await htmls()).length, 1, 'asking again focuses the existing preview')
    // A second page: open as a note, Ctrl+Shift+V → a second preview, and its script ran.
    const second = join(dir, 'second.html')
    await page.evaluate(path => window.__tether.openNote(path), second)
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    const secondNote = (await page.evaluate(() => window.__tether.notes())).find(n => same(n.path, second))!
    await page.locator(`.note-panel[data-note-id="${secondNote.id}"] .monaco-editor`).click()
    await page.waitForFunction(id => window.__tether.note(id)?.focused === true, secondNote.id)
    await page.keyboard.press('Control+Shift+V')
    await page.waitForFunction(() => window.__tether.htmlPreviews().length === 2)
    const secondPrev = (await htmls()).find(h => same(h.path, second))!
    const gid2 = await guestId(secondPrev.id)
    await waitUntil(async () => (await inGuest<string>(app!, gid2, 'document.querySelector("h1").textContent')) === 'segunda rodou')
    // Ctrl+P on an .html also opens the preview: close this one, then go to it through Quick Open.
    await page.evaluate(id => window.__tether.activate(id), shell!)
    await page.locator(`.tether-tab.preview >> nth=1`).hover()
    await page.locator(`.tether-tab.preview >> nth=1 >> .close`).click()
    await page.waitForFunction(() => window.__tether.htmlPreviews().length === 1)
    await focusPane(page, shell!)
    await page.keyboard.press('Control+p')
    await page.waitForFunction(() => window.__tether.palette().open)
    await page.keyboard.type('second.html')
    await page.waitForFunction(() => window.__tether.palette().shown.some(s => /second/.test(s)), undefined, { timeout: 20_000 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tether.htmlPreviews().length === 2)
    const viaPalette = (await htmls()).find(h => same(h.path, second))!
    assert.equal(await page.evaluate(([a, b]) => window.__tether.groupOf(a!) === window.__tether.groupOf(b!), [viaPalette.id, shell!] as const), true, 'Ctrl+P opened the preview in the focused pane\'s group')

    // 6. A chord pressed inside the page reaches the app: Ctrl+Shift+P opens the palette.
    await page.evaluate(id => window.__tether.activate(id), demoId)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.palette().open)
    await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)!
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control', 'shift'] })
    }, gid)
    await page.waitForFunction(() => window.__tether.palette().open, undefined, { timeout: 5_000 })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.palette().open)

    // "Abrir no navegador": the file goes to the system (recorded, not opened).
    await page.evaluate(id => window.__tether.activate(id), demoId)
    await page.click(`.html-preview[data-preview-id="${demoId}"] .hp-btn[data-action="browser"]`)
    await waitUntil(async () => (await systemPaths()).length === 1)
    assert.ok(same((await systemPaths())[0]!, demo), 'the page file was handed to the system')

    // 7. Live: scroll, change a file the page loaded → reload, same scroll; an unrelated file → nothing.
    await inGuest(app, gid, 'window.scrollTo({ top: 1400, behavior: "instant" })')
    await waitUntil(async () => (await html(demoId)).scroll.y >= 1390, 5_000)
    const loadsBefore = (await html(demoId)).loads
    await sleep(300)
    writeFileSync(join(dir, 'unrelated.txt'), 'y')
    await sleep(1200)
    assert.equal((await html(demoId)).loads, loadsBefore, 'a file the page never loaded does not reload it')
    writeFileSync(join(dir, 'ext.js'), "document.title = 'ext-v2'; window.extVersion = 2\n")
    await waitUntil(async () => (await html(demoId)).loads > loadsBefore, 8_000)
    await waitUntil(async () => (await inGuest<string>(app!, gid, 'document.title')) === 'ext-v2' || (await inGuest<string>(app!, gid, 'document.title')) === 'done', 8_000)
    await waitUntil(async () => (await inGuest<number>(app!, gid, 'window.extVersion')) === 2, 8_000)
    await waitUntil(async () => (await inGuest<number>(app!, gid, 'Math.round(window.scrollY)')) >= 1380, 5_000)
    writeFileSync(demo, DEMO(outsideUrl).replace('<h1 id="t">antes</h1>', '<h1 id="t">antes</h1><p id="marker">editado</p>'))
    await waitUntil(async () => (await inGuest<boolean>(app!, gid, "!!document.getElementById('marker')")) === true, 8_000)
    assert.ok((await inGuest<number>(app, gid, 'Math.round(window.scrollY)')) >= 1380, 'the scroll survived the reloads')
    await sleep(1300) // the poll persists the scroll with the layout

    // 9 (before the kill). Screenshots, dark and light: the strip and the page (the page is the author's, the theme does not touch it).
    await page.evaluate(id => window.__tether.activate(id), demoId)
    await inGuest(app, gid, 'window.scrollTo({ top: 0, behavior: "instant" })')
    await sleep(1500)
    await shot(app, 'html-preview-dark')
    await page.evaluate(() => window.__tether.runCommand('theme.light'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await sleep(900)
    await shot(app, 'html-preview-light')
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await inGuest(app, gid, 'window.scrollTo({ top: 1400, behavior: "instant" })')
    await waitUntil(async () => (await html(demoId)).scroll.y >= 1390, 5_000)
    await sleep(1300)

    // 8. Kill the main process and relaunch: the previews come back.
    assert.ok(JSON.stringify(await page.evaluate(() => window.__tether.layout())).includes('html-preview'), 'the layout carries the html preview panes')
    const before = (await htmls()).map(h => ({ id: h.id, path: h.path, frame: undefined as string | undefined, y: h.scroll.y }))
    for (const b of before) b.frame = await page.evaluate(id => window.__tether.frameOf(id), b.id)
    const groupBefore = await page.evaluate(id => window.__tether.groupOf(id), demoId)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(n => window.__tether.htmlPreviews().length === n, before.length)
    const back = await htmls()
    assert.deepEqual(back.map(h => h.id).sort(), before.map(b => b.id).sort(), 'the same panes')
    for (const b of before) {
      const h = back.find(x => x.id === b.id)!
      assert.ok(same(h.path, b.path), 'same file')
      assert.equal(await page.evaluate(id => window.__tether.frameOf(id), b.id), b.frame, 'same frame')
    }
    assert.equal(await page.evaluate(id => window.__tether.groupOf(id), demoId), groupBefore, 'same group')
    assert.equal(await page.locator('.tether-tab.preview .text').first().innerText(), 'Prévia: demo.html')
    const gidBack = await guestId(demoId)
    await waitUntil(async () => (await inGuest<string>(app!, gidBack, "document.getElementById('t')?.textContent ?? ''")) === 'rodou', 10_000)
    await waitUntil(async () => (await inGuest<number>(app!, gidBack, 'Math.round(window.scrollY)')) >= 1380, 10_000)
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const d of [home, base]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(d, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})

async function waitUntil(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await check()) return; await sleep(100) }
  throw new Error('condition not met in time')
}

/** The local path a file: URL names (the guest's address, decoded). */
function fileOf(url: string): string {
  const m = /^file:\/\/\/(.*?)(?:[?#].*)?$/.exec(url)
  return m ? decodeURIComponent(m[1]!).replace(/\//g, '\\') : url
}
