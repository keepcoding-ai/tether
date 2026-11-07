// E2E of the layering between the toolbar menus and the pane content: with a note (Monaco, minimap on) in the frame
// at the window's right edge, the app menu opens over the minimap and scrollbar, so every point inside the menu must
// hit the menu itself. Real tetherd on a private home/pipe, hidden window. Screenshots menu-over-minimap-{light,dark}.png
// (TETHER_SHOT_DIR overrides the folder).
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

type Hooks = {
  panelIds(): string[]
  notes(): { id: string }[]
  connection(): { connected: boolean; pid?: number } | undefined
}
declare const window: { innerWidth: number; innerHeight: number; __tether: Hooks; tether: { setTheme(s: string): Promise<unknown> } }
declare const document: {
  documentElement: { dataset: Record<string, string | undefined> }
  querySelectorAll(sel: string): { length: number } & ArrayLike<Menu>
  elementFromPoint(x: number, y: number): { closest(s: string): unknown } | null
  querySelector(s: string): Menu | null
  activeElement: Menu | null
}
type Menu = { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number }; getAttribute(n: string): string | null; scrollHeight: number; clientHeight: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-menulayer-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const outDir = process.env.TETHER_SHOT_DIR ?? artifacts

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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function shot(app: ElectronApplication, file: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.toPNG().toString('base64')
  })
  writeFileSync(file, Buffer.from(b64, 'base64'))
}

test('app menu layer: the app menu stays above the editor minimap and scrollbar', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(outDir, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-menulayer-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tether-menulayer-cwd-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', cwd)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await page.locator(`.panel[data-slot-id="${shell}"] .panel-term`).click()

    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await page.click('#app-menu li[data-command="note.new"]')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const noteId = (await page.evaluate(() => window.__tether.notes()))[0]!.id
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await page.keyboard.insertText(Array.from({ length: 120 }, (_, n) => `line ${n} lorem ipsum dolor sit amet`).join('\n'))

    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate(async s => { await window.tether.setTheme(s) }, scheme)
      await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
      await sleep(300)
      await page.click('#btn-menu')
      await page.waitForSelector('#app-menu:not([hidden])')
      await sleep(200)
      const minimap = await page.locator(`.note-panel[data-note-id="${noteId}"] .minimap`).first().boundingBox()
      assert.ok(minimap && minimap.width > 0, `${scheme}: the minimap is visible`)
      const misses = await page.evaluate(() => {
        const r = document.querySelector('#app-menu')!.getBoundingClientRect()
        let seen = 0
        const bad: string[] = []
        for (let ix = 0; ix <= 6; ix++) for (let iy = 0; iy <= 6; iy++) {
          const x = Math.round(r.left + 2 + (r.right - r.left - 4) * ix / 6), y = Math.round(r.top + 2 + (r.bottom - r.top - 4) * iy / 6)
          if (y >= window.innerHeight || x >= window.innerWidth) continue
          seen++
          if (!document.elementFromPoint(x, y)?.closest('#app-menu')) bad.push(`${x},${y}`)
        }
        if (seen < 20) bad.push(`only ${seen} points in the viewport`)
        return bad
      })
      const rect = await page.locator('#app-menu').boundingBox()
      assert.ok(rect && rect.x + rect.width > minimap.x, `${scheme}: the menu overlaps the minimap strip`)
      await shot(app, join(outDir, `menu-over-minimap-${scheme}.png`))
      assert.deepEqual(misses, [], `${scheme}: points inside the menu hit pane content instead`)
      await page.keyboard.press('Escape')
      await page.waitForSelector('#app-menu', { state: 'hidden' })
    }

    // The slim menu (settings plan 9): no look group; the app group is Atalhos, Instalar, Extensões, Configurações.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    const cmds = await page.evaluate(() => Array.from(document.querySelectorAll('#app-menu li[data-command]')).map(li => li.getAttribute('data-command')))
    for (const gone of ['theme.light', 'ui.desk-line', 'ui.dim-weak', 'ui.word-wrap', 'terminal.theme', 'confirmations.restore']) assert.ok(!cmds.includes(gone), `${gone} left the menu`)
    const at = cmds.indexOf('keybindings.show')
    assert.deepEqual(cmds.slice(at, at + 4), ['keybindings.show', 'web-bridge.install', 'extensions.show', 'settings.show'])
    await sleep(400)
    await shot(app, join(outDir, 'tether-menu-slim.png'))
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu', { state: 'hidden' })

    // A short window (480 px high): the menu fits the viewport, scrolls, and the End key reaches the last item (settings plan 10).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 480))
    await page.waitForFunction(() => window.innerHeight <= 481)
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    const fit = await page.evaluate(() => {
      const el = document.querySelector('#app-menu')!
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, inner: window.innerHeight, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    })
    assert.ok(fit.top >= 0 && fit.bottom <= fit.inner, `the menu is inside the viewport: ${JSON.stringify(fit)}`)
    assert.ok(fit.scrollHeight > fit.clientHeight, `the menu scrolls: ${JSON.stringify(fit)}`)
    await page.keyboard.press('End')
    const last = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#app-menu li[role^=menuitem]'))
      const li = items[items.length - 1]!
      const a = document.activeElement
      const m = document.querySelector('#app-menu')!.getBoundingClientRect()
      const r = li.getBoundingClientRect()
      return { focused: a?.getAttribute('data-command'), last: li.getAttribute('data-command'), visible: r.top >= m.top - 1 && r.bottom <= m.bottom + 1 }
    })
    assert.equal(last.focused, last.last, 'End focuses the last item')
    assert.ok(last.visible, 'the last item was scrolled into view')
    await sleep(400)
    await shot(app, join(outDir, 'tether-scrollbar.png'))
    await page.keyboard.press('Escape')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, cwd]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
