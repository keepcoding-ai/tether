// E2E of the explorer's sticky scroll (VS Code's tree sticky scroll): while the tree scrolls, the folders above the first row
// in view stay drawn on top of it. Hidden window on a private home/pipe, real tetherd, no agent. Project `sticky` with
// a/b/c and 40 files at each level:
//   1. scrolled into c's files, [sticky, a, b, c] stick; past the end of b's files, b is gone; the wheel over the widget
//      scrolls the tree;
//   2. a click on the sticky `a` brings the real `a` just under the root, selected, with the keyboard, still expanded;
//   3. a click on the sticky twistie of `c` collapses it;
//   4. ArrowUp, repeated through b's files, never leaves the active row behind the widget; PageUp neither;
//   5. "Revelar no explorador" of a file deep in c, from the bottom of the tree, leaves it under the widget.
// Screenshots (light and dark) go to <atrium>/.tmp/f8: the tree scrolled with four sticky rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { root: string; path: string; name: string; level: number; kind: string; expanded: boolean; selected: boolean; focused: boolean }
type Snapshot = { mode: 'empty' | 'roots'; rows: Row[]; sticky: string[] }
type Hooks = {
  connection(): { pid?: number } | undefined
  explorer(): Snapshot | undefined
  notes(): { id: string; path: string }[]
  openNote(path: string): Promise<void>
  runCommand(id: string): Promise<string>
}
type Box = { top: number; bottom: number; left: number; right: number; height: number }
type El = {
  scrollTop: number; scrollHeight: number; clientWidth: number; classList: { contains(c: string): boolean }; textContent: string | null
  getBoundingClientRect(): Box; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> & Iterable<El>
}
declare const window: { __tether: Hooks }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelector(s: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorersticky-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'f8')
const PAD = 'explorer.files'
const N = 40
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
const two = (i: number): string => String(i).padStart(2, '0')

/** List geometry (fixed heights): 6px of padding, the root 28px, every other row 26px. */
const topOf = (index: number): number => index === 0 ? 6 : 6 + 28 + 26 * (index - 1)

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function stubPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('folder:pick'); ipcMain.handle('folder:pick', () => f) }, folder)
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

const snap = async (page: Page): Promise<Snapshot> => (await page.evaluate(() => window.__tether.explorer()))!
/** The sticky rows by name, top to bottom. */
const stickyNames = async (page: Page): Promise<string[]> => (await snap(page)).sticky.map(p => basename(p))
const rowSel = (name: string): string => `.pad.shown .xp-scroll .xp-row:has(> .xp-name:text-is("${name}"))`
const stickySel = (name: string): string => `.pad.shown .xp-sticky .xp-sticky-row:has(> .xp-name:text-is("${name}"))`

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < deadline) { await sleep(80); v = await read() }
  assert.ok(ok(v), `${what}: got ${JSON.stringify(v)}`)
  return v
}

async function scrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate(t => { document.querySelector('.pad.shown .xp-scroll')!.scrollTop = t }, top)
  await sleep(120)
}

/** Where the keyboard's row is against the widget: its top must not be above the widget's bottom (nor below the tree's bottom). */
const activeVsWidget = (page: Page): Promise<{ name: string; rowTop: number; rowBottom: number; widgetBottom: number; treeBottom: number } | undefined> => page.evaluate(() => {
  const tree = document.querySelector('.pad.shown .xp-scroll')!
  const widget = document.querySelector('.pad.shown .xp-sticky')!
  const t = tree.getBoundingClientRect()
  const w = widget.getBoundingClientRect()
  const widgetBottom = widget.classList.contains('empty') ? t.top : w.bottom
  for (const r of tree.querySelectorAll('.xp-row')) {
    if (!r.classList.contains('focused')) continue
    const b = r.getBoundingClientRect()
    return { name: r.querySelector('.xp-name')?.textContent ?? '', rowTop: b.top, rowBottom: b.bottom, widgetBottom, treeBottom: t.bottom }
  }
  return undefined
})

test('explorer: sticky scroll of the folders above the first row in view', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-sticky-'))
  const P = join(home, 'proj', 'sticky')
  mkdirSync(join(P, 'a', 'b', 'c'), { recursive: true })
  for (let i = 1; i <= N; i++) {
    writeFileSync(join(P, `p${two(i)}.txt`), '')
    writeFileSync(join(P, 'a', `a${two(i)}.txt`), '')
    writeFileSync(join(P, 'a', 'b', `b${two(i)}.txt`), '')
    writeFileSync(join(P, 'a', 'b', 'c', `c${two(i)}.md`), `# c${two(i)}\n`)
  }
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    await stubPicker(app, P)
    await page.click('.xp-primary')
    await page.waitForSelector(rowSel('a'))
    for (const name of ['a', 'b', 'c']) {
      await page.click(rowSel(name))
      await waitFor(`${name} expanded`, async () => (await snap(page)).rows.find(r => r.name === name)?.expanded, v => v === true)
    }
    // Rows: 0 sticky, 1 a, 2 b, 3 c, 4–43 c01–c40, 44–83 b01–b40, 84–123 a01–a40, 124–163 p01–p40.
    await waitFor('every row', async () => (await snap(page)).rows.length, v => v === 4 + 4 * N)
    assert.deepEqual(await stickyNames(page), [], 'nothing sticks at the top')

    // ---- 1. scrolled: the ancestors stick; past b's end, b leaves; the wheel over the widget scrolls ----
    await scrollTo(page, topOf(4 + 9)) // c10 at the top
    await waitFor('[sticky, a, b, c] stick', () => stickyNames(page), v => v.join('/') === 'sticky/a/b/c')
    const layer = await page.evaluate(() => {
      const tree = document.querySelector('.pad.shown .xp-scroll')!
      const w = document.querySelector('.pad.shown .xp-sticky')!
      return { width: w.getBoundingClientRect().right - w.getBoundingClientRect().left, client: tree.clientWidth, height: w.getBoundingClientRect().height, hidden: w.classList.contains('empty') }
    })
    assert.equal(layer.hidden, false)
    assert.equal(layer.width, layer.client, 'the widget leaves the scrollbar uncovered')
    assert.equal(layer.height, 28 + 3 * 26, 'four rows high')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(400)
      await page.locator('.pad.shown').screenshot({ path: join(shots, `explorer-sticky-${scheme}.png`) })
    }
    const b40Bottom = topOf(83) + 26
    await scrollTo(page, b40Bottom - 54 + 20) // b40 has gone under [sticky, a]
    await waitFor('b leaves after its last file', () => stickyNames(page), v => v.join('/') === 'sticky/a')
    const before = await page.evaluate(() => document.querySelector('.pad.shown .xp-scroll')!.scrollTop)
    const wb = (await page.locator('.pad.shown .xp-sticky').boundingBox())!
    await page.mouse.move(wb.x + 40, wb.y + 10)
    await page.mouse.wheel(0, 200)
    await waitFor('the wheel over the widget scrolls the tree', () => page.evaluate(() => document.querySelector('.pad.shown .xp-scroll')!.scrollTop), v => v > before)

    // ---- 2. a click on the sticky `a`: the real `a` just under the root, selected, with the keyboard, still expanded ----
    await scrollTo(page, topOf(4 + 9))
    await waitFor('scrolled back', () => stickyNames(page), v => v.join('/') === 'sticky/a/b/c')
    await page.click(`${stickySel('a')} > .xp-name`)
    const scrolled = await page.evaluate(() => document.querySelector('.pad.shown .xp-scroll')!.scrollTop)
    assert.equal(scrolled, topOf(1) - 28, 'scrolled so that a sits right under its sticky root')
    let s = await snap(page)
    const a = s.rows.find(r => r.name === 'a')!
    assert.deepEqual({ selected: a.selected, focused: a.focused, expanded: a.expanded }, { selected: true, focused: true, expanded: true }, 'a selected, with the keyboard, still expanded')
    const aBox = await page.evaluate(() => {
      const tree = document.querySelector('.pad.shown .xp-scroll')!
      for (const r of tree.querySelectorAll('.xp-row')) if (r.querySelector('.xp-name')?.textContent === 'a') return r.getBoundingClientRect().top - tree.getBoundingClientRect().top
      return undefined
    })
    assert.equal(aBox, 28, 'the real a is just under the root')

    // ---- 3. a click on the sticky twistie of `c` collapses it ----
    await scrollTo(page, topOf(4 + 9))
    await waitFor('c sticks again', () => stickyNames(page), v => v.join('/') === 'sticky/a/b/c')
    await page.click(`${stickySel('c')} > .xp-twist`)
    await waitFor('c collapsed', async () => (await snap(page)).rows.find(r => r.name === 'c')?.expanded, v => v === false)
    s = await snap(page)
    assert.equal(s.rows.length, 4 + 3 * N, "c's files are gone")
    assert.equal(s.rows.find(r => r.name === 'c')!.selected, true, 'c selected')

    // ---- 4. ArrowUp through b's files (and PageUp) never leaves the active row behind the widget ----
    // Rows now: 0 sticky, 1 a, 2 b, 3 c, 4–43 b01–b40, 44–83 a01–a40, 84–123 p01–p40.
    await page.locator('.pad.shown .xp-scroll').focus()
    await page.keyboard.type('a20')
    await sleep(900)
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'a20.txt')
    for (let i = 0; i < 20 + N + 2; i++) {
      await page.keyboard.press('ArrowUp')
      const at = (await activeVsWidget(page))!
      assert.ok(at, 'the active row is drawn')
      assert.ok(at.rowTop >= at.widgetBottom - 0.5, `ArrowUp #${i + 1}: ${at.name} (top ${at.rowTop}) is not behind the widget (bottom ${at.widgetBottom})`)
      assert.ok(at.rowBottom <= at.treeBottom + 0.5, `ArrowUp #${i + 1}: ${at.name} in view`)
    }
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'a', 'up to a')
    await page.keyboard.press('End')
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('PageUp')
      const at = (await activeVsWidget(page))!
      assert.ok(at.rowTop >= at.widgetBottom - 0.5, `PageUp #${i + 1}: ${at.name} (top ${at.rowTop}) is not behind the widget (bottom ${at.widgetBottom})`)
    }

    // ---- 5. "Revelar no explorador" of a file deep in c, from the bottom of the tree ----
    await page.keyboard.press('End')
    const deep = join(P, 'a', 'b', 'c', 'c35.md')
    await page.evaluate(p => window.__tether.openNote(p), deep)
    await page.waitForFunction(p => window.__tether.notes().some(n => n.path.toLowerCase() === p.toLowerCase()), deep)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('explorer.reveal')), 'ran')
    await waitFor('c35 revealed and selected', async () => (await snap(page)).rows.find(r => r.selected)?.name, v => v === 'c35.md')
    await waitFor('the widget shows c35\'s folders', () => stickyNames(page), v => v.join('/') === 'sticky/a/b/c')
    const revealed = await page.evaluate(() => {
      const tree = document.querySelector('.pad.shown .xp-scroll')!
      const w = document.querySelector('.pad.shown .xp-sticky')!.getBoundingClientRect()
      for (const r of tree.querySelectorAll('.xp-row')) {
        if (r.querySelector('.xp-name')?.textContent !== 'c35.md') continue
        return { top: r.getBoundingClientRect().top, bottom: r.getBoundingClientRect().bottom, widgetBottom: w.bottom, treeBottom: tree.getBoundingClientRect().bottom }
      }
      return undefined
    })
    assert.ok(revealed, 'the revealed row is drawn')
    assert.ok(revealed.top >= revealed.widgetBottom - 0.5, `c35 (top ${revealed.top}) is below the widget (bottom ${revealed.widgetBottom})`)
    assert.ok(revealed.bottom <= revealed.treeBottom + 0.5, 'c35 in view')
    assert.ok(same((await snap(page)).rows.find(r => r.selected)!.path, deep))
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
