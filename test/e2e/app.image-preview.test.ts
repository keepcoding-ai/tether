// E2E of the image viewer: against the real tetherd on a private home/pipe, hidden window.
//   1. a .png opens in the viewer (not as text, not with the system's program): size, status bar, fit to the window;
//   2. an .svg opens as a picture drawn by <img> (the SVG is not in the DOM), with "Ver código" in the strip;
//   3. "Ver código" opens the same file as a note with the XML text, which stays editable;
//   4. 1 / Ctrl+= / Ctrl+- / Ctrl+0 zoom the viewer;
//   5. live: a new picture on disk is read again; the layout carries the image panes.
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

type Img = { id: string; path: string; width: number; height: number; size: number; zoom: number; fit: boolean; loads: number; state: string | undefined; status: string; visible: boolean }
type Hooks = {
  openFile(path: string): Promise<void>
  imagePreviews(): Img[]
  notes(): Array<{ id: string; path: string; text: string }>
  connection(): { connected: boolean; pid?: number } | undefined
  layout(): unknown
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-imagepreview-${process.pid}`
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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 820))
  // Nothing is really opened: what main hands to the system is recorded.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __paths: string[] }
    g.__paths = []
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
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64')
const SVG = (color: string, size = '400" height="300'): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" viewBox="0 0 400 300"><rect width="400" height="300" fill="${color}"/><script>window.pwned = 1</script></svg>\n`

test('app image-preview: png and svg open in the viewer; zoom keys; "Ver código" edits the svg; live reload', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-imgp-'))
  const dir = mkdtempSync(join(tmpdir(), 'tether-imgp-files-'))
  const png = join(dir, 'dot.png')
  const svg = join(dir, 'icon.svg')
  writeFileSync(png, PNG)
  writeFileSync(svg, SVG('#3b82f6'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const images = (): Promise<Img[]> => page.evaluate(() => window.__tether.imagePreviews())
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

    await createShell(page, dir) // a pane to open the files next to

    // 1. The png: a viewer, not a note, not the system's program; a small picture is not enlarged.
    await page.evaluate(p => window.__tether.openFile(p), png)
    await page.waitForFunction(() => window.__tether.imagePreviews().some(i => i.width > 0))
    const [pngView] = await images()
    assert.ok(same(pngView!.path, png))
    assert.deepEqual([pngView!.width, pngView!.height], [10, 10])
    assert.equal(pngView!.zoom, 1, 'a 10px picture is not enlarged to fit')
    assert.equal(pngView!.fit, true)
    assert.match(pngView!.status, /^10 × 10 px · \d+ B · 100%$/)
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, 0, 'an image is not a note')
    assert.deepEqual(await app.evaluate(() => (globalThis as unknown as { __paths: string[] }).__paths), [], 'not handed to the system')
    assert.equal(await page.locator('.tether-tab.preview .text').innerText(), 'Prévia: dot.png')

    // 2. The svg: a picture through <img>; its script did not run and its markup is not in the DOM.
    await page.evaluate(p => window.__tether.openFile(p), svg)
    await page.waitForFunction(() => window.__tether.imagePreviews().length === 2)
    const svgView = (await images()).find(i => same(i.path, svg))!
    await page.waitForFunction(id => window.__tether.imagePreviews().find(i => i.id === id)!.width > 0, svgView.id)
    const panel = page.locator(`.image-preview[data-preview-id="${svgView.id}"]`)
    assert.equal(await panel.locator('img.ip-img').count(), 1)
    assert.equal(await panel.locator('rect, script').count(), 0, 'the svg markup is not in the page')
    assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined, 'its script did not run')
    assert.equal(await panel.locator('[data-action="source"]').count(), 1, '"Ver código" for an svg')
    const pngPanel = page.locator(`.image-preview[data-preview-id="${pngView!.id}"]`)
    assert.equal(await pngPanel.locator('[data-action="source"]').count(), 0, 'none for a png')
    await shot(app, 'image-preview-svg')

    // 4. Zoom: the keys are the viewer's while the focus is in it.
    const view = (): Promise<Img> => page.evaluate(id => window.__tether.imagePreviews().find(i => i.id === id)!, svgView.id)
    await panel.locator('.ip-stage').click()
    assert.ok((await view()).zoom <= 1, 'fit never enlarges')
    await page.keyboard.press('1')
    assert.equal((await view()).zoom, 1)
    assert.equal((await view()).fit, false)
    await page.keyboard.press('Control+=')
    assert.equal((await view()).zoom, 1.25)
    await page.keyboard.press('Control+-')
    await page.keyboard.press('Control+-')
    assert.equal(Math.round((await view()).zoom * 100) / 100, 0.8)
    await page.keyboard.press('Control+0')
    assert.equal((await view()).fit, true)
    assert.match((await view()).status, /^400 × 300 px · \d+ B · \d+%$/)

    // 3. "Ver código": the same file as a note, editable.
    await panel.locator('[data-action="source"]').click()
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const [note] = await page.evaluate(() => window.__tether.notes())
    assert.ok(same(note!.path, svg))
    assert.match(note!.text, /<svg xmlns=/)
    assert.equal((await images()).length, 2, 'the viewer stays')

    // 5. Live: another picture on disk is read again.
    const loads = (await view()).loads
    writeFileSync(svg, SVG('#ef4444', '640" height="480'))
    await page.waitForFunction(([id, n]) => { const i = window.__tether.imagePreviews().find(x => x.id === id)!; return i.loads > (n as number) && i.width === 640 }, [svgView.id, loads] as const)
    assert.ok(JSON.stringify(await page.evaluate(() => window.__tether.layout())).includes('"kind":"image"'), 'the layout carries the image panes')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const d of [home, dir]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(d, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
