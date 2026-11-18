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
import { clickMenuItem } from './menu-helpers.ts'

type Hooks = {
  panelIds(): string[]
  notes(): { id: string }[]
  commands(): { id: string }[]
  connection(): { connected: boolean; pid?: number } | undefined
}
declare const window: { innerWidth: number; innerHeight: number; __tether: Hooks; tether: { setTheme(s: string): Promise<unknown> } }
declare const document: {
  documentElement: { dataset: Record<string, string | undefined> }
  querySelectorAll(sel: string): { length: number } & ArrayLike<Menu>
  elementFromPoint(x: number, y: number): Menu | null
  querySelector(s: string): Menu | null
  activeElement: Menu | null
}
type Menu = {
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number }; getAttribute(n: string): string | null; scrollHeight: number; clientHeight: number
  querySelector(s: string): Menu | null; closest(s: string): Menu | null; querySelectorAll(s: string): ArrayLike<Menu>; contains(n: unknown): boolean; hidden: boolean
}

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
    await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await page.locator(`.panel[data-slot-id="${shell}"] .panel-term`).click()

    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await clickMenuItem(page, 'note.new')
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

    // The approved structure: root rows and four submenus; every command is reachable and is also a palette command.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    const root = await page.evaluate(() => Array.from(document.querySelectorAll('#app-menu > li')).map(li => li.getAttribute('data-command') ?? (li.getAttribute('role') === 'separator' ? '---' : `sub:${li.getAttribute('data-submenu')}`)))
    assert.deepEqual(root, ['palette.show', '---', 'pane.new', 'explorer.open-folder', 'drawer.toggle', '---', 'sub:pane', 'sub:note', 'sub:desk', 'sub:tools', '---', 'terminal.theme', 'settings.show', '---', 'window.close', 'app.quit-all'])
    const cmds = await page.evaluate(() => Array.from(document.querySelectorAll('#app-menu li[data-command]')).map(li => li.getAttribute('data-command')!))
    for (const gone of ['theme.light', 'ui.desk-line', 'ui.dim-weak', 'ui.word-wrap', 'confirmations.restore']) assert.ok(!cmds.includes(gone), `${gone} left the menu`)
    const palette = new Set((await page.evaluate(() => window.__tether.commands())).map(c => c.id))
    for (const c of cmds) assert.ok(palette.has(c), `${c} is in the palette`)
    assert.equal(cmds.length, 27)

    // The root fits without scrolling at the default size (1280x800) and in a modest window (1024x560).
    const fits = (): Promise<{ scrollHeight: number; clientHeight: number; top: number; bottom: number; inner: number }> => page.evaluate(() => {
      const el = document.querySelector('#app-menu')!
      const r = el.getBoundingClientRect()
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top: r.top, bottom: r.bottom, inner: window.innerHeight }
    })
    let f = await fits()
    assert.ok(f.scrollHeight <= f.clientHeight, `root does not scroll at 1280x800: ${JSON.stringify(f)}`)
    assert.ok(f.bottom < f.inner * 0.7, `root is short: ${JSON.stringify(f)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu', { state: 'hidden' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 560))
    await page.waitForFunction(() => window.innerHeight <= 561)
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    f = await fits()
    assert.ok(f.scrollHeight <= f.clientHeight, `root does not scroll at 1024x560: ${JSON.stringify(f)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu', { state: 'hidden' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    await page.waitForFunction(() => window.innerHeight >= 790)

    // Hover opens each submenu (after a short delay) with its items, inside the viewport, flipped to the left at the right edge.
    const SUBS: Record<string, string[]> = {
      pane: ['pane.new-tab', 'pane.duplicate.pane.right', 'pane.duplicate.pane.below', 'pane.new-at-frame-edge', 'frame.new', 'pane.switch-profile'],
      note: ['note.new', 'note.open', 'note.save-as'],
      desk: ['desk.new', 'pane.move', 'desk.actions', 'desk.close'],
      tools: ['profiles.manage', 'keybindings.show', 'extensions.show', 'web-bridge.install'],
    }
    const subState = (id: string): Promise<{ open: boolean; side: string | null; items: string[]; rect: { left: number; right: number; top: number; bottom: number }; menuLeft: number; inner: [number, number]; visibleItems: number }> => page.evaluate(sub => {
      const li = document.querySelector(`#app-menu > li.sub[data-submenu="${sub}"]`)!
      const ul = li.querySelector('ul.submenu')!
      const r = ul.getBoundingClientRect()
      const hit = Array.from(ul.querySelectorAll('li[data-command]')).filter(i => {
        const b = i.getBoundingClientRect()
        const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        return b.width > 0 && el !== null && i.contains(el)
      })
      return {
        open: li.getAttribute('aria-expanded') === 'true' && !ul.hidden,
        side: li.getAttribute('data-side'),
        items: Array.from(ul.querySelectorAll('li[data-command]')).map(i => i.getAttribute('data-command')!),
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        menuLeft: document.querySelector('#app-menu')!.getBoundingClientRect().left,
        inner: [window.innerWidth, window.innerHeight],
        visibleItems: hit.length,
      }
    }, id)
    for (const sub of Object.keys(SUBS)) {
      await page.click('#btn-menu')
      await page.waitForSelector('#app-menu:not([hidden])')
      assert.equal((await subState(sub)).open, false, `${sub}: closed before the hover`)
      await page.locator(`#app-menu > li.sub[data-submenu="${sub}"]`).hover()
      await page.waitForSelector(`#app-menu > li.sub[data-submenu="${sub}"][aria-expanded="true"]`)
      const st = await subState(sub)
      assert.deepEqual(st.items, SUBS[sub], `${sub}: items`)
      assert.equal(st.visibleItems, SUBS[sub]!.length, `${sub}: every item is on top and reachable`)
      assert.ok(st.rect.left >= 0 && st.rect.right <= st.inner[0] && st.rect.top >= 0 && st.rect.bottom <= st.inner[1], `${sub}: inside the viewport ${JSON.stringify(st)}`)
      assert.equal(st.side, 'left', `${sub}: the menu hugs the right edge, so the submenu flips left`)
      assert.ok(st.rect.right <= st.menuLeft + 3, `${sub}: left of the menu`)
      // Only one submenu is open at a time: hovering another closes this one.
      const other = Object.keys(SUBS).find(k => k !== sub)!
      await page.locator(`#app-menu > li.sub[data-submenu="${other}"]`).hover()
      await page.waitForSelector(`#app-menu > li.sub[data-submenu="${other}"][aria-expanded="true"]`)
      assert.equal((await subState(sub)).open, false, `${sub}: closed by the hover on ${other}`)
      await page.keyboard.press('Escape')
      await page.waitForSelector('#app-menu', { state: 'hidden' })
    }

    // The submenu stays open while the pointer travels diagonally to it across the rows below the opener.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    const opener = (await page.locator('#app-menu > li.sub[data-submenu="pane"]').boundingBox())!
    await page.mouse.move(opener.x + opener.width - 20, opener.y + opener.height / 2)
    await page.waitForSelector('#app-menu > li.sub[data-submenu="pane"][aria-expanded="true"]')
    const target = (await page.locator('#app-menu li[data-command="frame.new"]').boundingBox())!
    // Left submenu: the pointer goes left and down across "Nota"/"Mesa" rows toward the submenu's lower items.
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
    assert.equal((await subState('pane')).open, true, 'the submenu survived the diagonal trip over the rows below the opener')
    await page.mouse.move(opener.x + opener.width - 20, opener.y + 200, { steps: 4 })
    await sleep(500)
    assert.equal((await subState('pane')).open, false, 'resting on another root row closes it')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu', { state: 'hidden' })

    // Keyboard: ArrowRight and Enter open each submenu and focus its first item; ArrowDown/Up cycle inside; ArrowLeft and Escape close only the submenu.
    for (const [sub, key] of [['pane', 'ArrowRight'], ['note', 'Enter'], ['desk', 'ArrowRight'], ['tools', 'Enter']] as const) {
      await page.click('#btn-menu')
      await page.waitForSelector('#app-menu:not([hidden])')
      await page.locator(`#app-menu > li.sub[data-submenu="${sub}"]`).focus()
      await page.keyboard.press(key)
      await page.waitForSelector(`#app-menu > li.sub[data-submenu="${sub}"][aria-expanded="true"]`)
      const first = await page.evaluate(() => document.activeElement?.getAttribute('data-command'))
      assert.equal(first, SUBS[sub]![0], `${sub}: ${key} focuses the first item`)
      await page.keyboard.press('ArrowUp')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-command')), SUBS[sub]!.at(-1), `${sub}: ArrowUp wraps inside the submenu`)
      await page.keyboard.press('ArrowLeft')
      assert.equal((await subState(sub)).open, false, `${sub}: ArrowLeft closes the submenu`)
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-submenu')), sub, `${sub}: the focus returns to its row`)
      await page.keyboard.press('ArrowRight')
      await page.waitForSelector(`#app-menu > li.sub[data-submenu="${sub}"][aria-expanded="true"]`)
      await page.keyboard.press('Escape')
      assert.equal((await subState(sub)).open, false, `${sub}: Escape closes the submenu`)
      assert.equal(await page.locator('#app-menu').isVisible(), true, `${sub}: Escape in a submenu leaves the menu open`)
      await page.keyboard.press('Escape')
      await page.waitForSelector('#app-menu', { state: 'hidden' })
    }

    // A command in a submenu runs from the keyboard (Nota > Nova nota) and closes the whole menu.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await page.locator('#app-menu > li.sub[data-submenu="note"]').focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#app-menu', { state: 'hidden' })
    await page.waitForFunction(() => window.__tether.notes().length === 2)

    // Screenshot: the Painel submenu open (the menu hugs the right edge, so it flips to the left).
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await page.locator('#app-menu > li.sub[data-submenu="pane"]').hover()
    await page.waitForSelector('#app-menu > li.sub[data-submenu="pane"][aria-expanded="true"]')
    await sleep(400)
    await shot(app, join(outDir, 'tether-menu-submenu.png'))
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu', { state: 'hidden' })

    // Fallback: in a very short window (300 px) the root still scrolls, and End reaches the last item.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 300))
    await page.waitForFunction(() => window.innerHeight <= 301)
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    const short = await fits()
    assert.ok(short.top >= 0 && short.bottom <= short.inner, `the menu is inside the viewport: ${JSON.stringify(short)}`)
    assert.ok(short.scrollHeight > short.clientHeight, `the menu scrolls as a fallback: ${JSON.stringify(short)}`)
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-command')), 'app.quit-all', 'End focuses the last root item')
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
