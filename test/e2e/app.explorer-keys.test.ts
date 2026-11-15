// E2E of the explorer extension, slice 4 (F8): the keyboard. Hidden window on a private home/pipe, real tetherd, no agent.
//   1. type to navigate: a prefix jumps to the matching row, a repeated letter cycles and wraps, 800 ms of silence starts over;
//   2. PageDown goes to the last row in view and then a page further, PageUp the reverse (a short window makes the tree scroll);
//   3. Ctrl+K E lands the keyboard on the selected row; Esc gives it back to the pane;
//   4. the ARIA tree: role=tree on the container that holds the keyboard, aria-activedescendant on the active row,
//      role=treeitem with aria-level, aria-setsize/aria-posinset, aria-expanded on folders only, one aria-selected row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { name: string; level: number; kind: string; expanded: boolean; selected: boolean; focused: boolean }
type Hooks = { connection(): { pid?: number } | undefined; explorer(): { rows: Row[]; rendered: number } | undefined }
type El = { id: string; getAttribute(n: string): string | null; dataset: Record<string, string>; classList: { contains(c: string): boolean }; scrollTop: number; scrollHeight: number }
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(s: string): Iterable<El>; querySelector(s: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorerkeys-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const PAD = 'explorer.files'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const focusedName = async (page: Page): Promise<string | undefined> => page.evaluate(() => window.__tether.explorer()!.rows.find(r => r.focused)?.name)
const focusedIndex = async (page: Page): Promise<number> => page.evaluate(() => window.__tether.explorer()!.rows.findIndex(r => r.focused))
const rowSel = (name: string): string => `.pad.shown .xp-row:has(> .xp-name:text-is("${name}"))`

test('explorer 4: type to navigate, paging, focus on the selected row, ARIA tree', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-keys-'))
  const F = join(home, 'proj', 'keys')
  mkdirSync(join(F, 'docs'), { recursive: true })
  for (const f of ['alpha.md', 'apple.md', 'beta.md', 'Bravo.md', 'cherry.md']) writeFileSync(join(F, f), `# ${f}\n`)
  for (let i = 0; i < 60; i++) writeFileSync(join(F, 'docs', `n${String(i).padStart(2, '0')}.txt`), '')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('folder:pick'); ipcMain.handle('folder:pick', () => f) }, F)
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    await page.click('.xp-primary')
    await page.waitForSelector(rowSel('cherry.md'))

    // ---- 1. type to navigate (rows: keys, docs, alpha, apple, beta, Bravo, cherry) ----
    // The keyboard lives on the tree's container; the row it stands on starts as the project just opened.
    await page.locator('.pad.shown .xp-scroll').focus()
    assert.equal(await focusedName(page), 'keys')
    await page.keyboard.type('b')
    assert.equal(await focusedName(page), 'beta.md', 'a prefix jumps to the first match')
    await page.keyboard.type('r')
    assert.equal(await focusedName(page), 'Bravo.md', '"br" narrows, case-insensitive')
    await sleep(1_000) // the buffer is forgotten
    await page.keyboard.type('a')
    assert.equal(await focusedName(page), 'alpha.md', 'wraps around to the top')
    await sleep(1_000)
    await page.keyboard.type('a')
    assert.equal(await focusedName(page), 'apple.md', 'the same letter again moves to the next match')
    await sleep(1_000)
    await page.keyboard.type('c')
    assert.equal(await focusedName(page), 'cherry.md')
    await sleep(1_000)
    await page.keyboard.type('d')
    assert.equal(await focusedName(page), 'docs', 'wraps from the end back up')
    await page.keyboard.press('Home')

    // ---- 2. paging: 60 files in docs, a short window ----
    await page.setViewportSize({ width: 1000, height: 360 })
    await page.keyboard.press('ArrowDown') // docs
    await page.keyboard.press('ArrowRight') // opens it
    // Rows are drawn only around the viewport: the last file of docs is in the tree, not necessarily in the DOM.
    await page.waitForFunction(() => window.__tether.explorer()!.rows.some(r => r.name === 'n59.txt'))
    const before = await focusedIndex(page)
    await page.keyboard.press('PageDown')
    const first = await focusedIndex(page)
    assert.ok(first > before, 'PageDown moves down to the last row in view')
    await page.keyboard.press('PageDown')
    const second = await focusedIndex(page)
    assert.ok(second > first, 'a second PageDown goes a page further')
    await page.keyboard.press('PageUp')
    assert.ok((await focusedIndex(page)) < second, 'PageUp goes up')
    for (let i = 0; i < 12; i++) await page.keyboard.press('PageDown')
    assert.equal(await focusedName(page), 'cherry.md', 'PageDown stops at the last row')
    for (let i = 0; i < 12; i++) await page.keyboard.press('PageUp')
    assert.equal(await focusedName(page), 'keys', 'PageUp stops at the first row')
    await page.setViewportSize({ width: 1280, height: 800 })

    // ---- 3. Ctrl+K E lands on the selected row ----
    // beta.md is below the 60 files of docs: scroll down to it as a person would, then click it.
    await page.evaluate(() => { const tree = document.querySelector('.pad.shown .xp-scroll')!; tree.scrollTop = tree.scrollHeight })
    await page.click(rowSel('beta.md'))
    await page.keyboard.press('Home') // keyboard elsewhere in the tree, the selection stays on beta.md
    await page.keyboard.press('Escape')
    assert.equal(await focusedName(page), undefined, 'Esc gave the keyboard back to the pane')
    await page.keyboard.press('Control+k')
    await page.keyboard.press('e')
    await page.waitForFunction(() => window.__tether.explorer()!.rows.some(r => r.focused))
    assert.equal(await focusedName(page), 'beta.md', 'Ctrl+K E lands on the selected row')

    // ---- 4. ARIA ----
    const aria = await page.evaluate(() => {
      const items: { level: string | null; expanded: string | null; selected: string | null; size: string | null; pos: string | null; kind: string; id: string; focused: boolean }[] = []
      for (const r of document.querySelectorAll('.pad.shown [role=treeitem]')) items.push({ level: r.getAttribute('aria-level'), expanded: r.getAttribute('aria-expanded'), selected: r.getAttribute('aria-selected'), size: r.getAttribute('aria-setsize'), pos: r.getAttribute('aria-posinset'), kind: r.dataset.kind!, id: r.id, focused: r.classList.contains('focused') })
      const trees = [...document.querySelectorAll('.pad.shown [role=tree]')]
      return { trees: trees.length, treeClass: trees[0]?.getAttribute('class') ?? '', active: trees[0]?.getAttribute('aria-activedescendant') ?? '', items }
    })
    assert.equal(aria.trees, 1)
    assert.equal(aria.treeClass, 'xp-scroll', 'the tree is the scrolling container that holds the keyboard')
    const all = (await page.evaluate(() => window.__tether.explorer()!))
    assert.ok(all.rows.length > 60, 'the tree holds every row')
    assert.equal(aria.items.length, all.rendered, 'every row in the DOM is a treeitem')
    assert.ok(aria.items.length < all.rows.length, `only the rows near the viewport are in the DOM (${aria.items.length} of ${all.rows.length})`)
    assert.ok(aria.items.every(i => /^\d+$/.test(i.level ?? '')), 'every item has aria-level')
    assert.ok(aria.items.every(i => /^\d+$/.test(i.size ?? '') && /^\d+$/.test(i.pos ?? '') && Number(i.pos) <= Number(i.size)), 'every item has its place among its siblings')
    assert.equal(aria.items.find(i => i.focused)?.id, aria.active, 'aria-activedescendant names the row the keyboard is on')
    assert.ok(aria.items.filter(i => i.kind === 'dir').every(i => i.expanded === 'true' || i.expanded === 'false'), 'folders have aria-expanded')
    assert.ok(aria.items.filter(i => i.kind === 'file').every(i => i.expanded === null), 'files do not')
    assert.equal(aria.items.filter(i => i.selected === 'true').length, 1, 'one selected row')
    assert.equal(await page.locator(rowSel('beta.md')).getAttribute('aria-selected'), 'true')
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
