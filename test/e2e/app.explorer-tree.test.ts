// E2E of the explorer extension, slice 1b (F8): the file tree under a project root. Hidden window on a private home/pipe, real
// tetherd, no agent. The native folder picker is replaced in main (ipcMain 'folder:pick').
//   1. the fixture folder is a pinned root, expanded at once: version-control folders and OS litter (.git, Thumbs.db) are not
//      listed, node_modules is (collapsed), folders come first in natural order;
//   2. a click expands/collapses a folder (rows at the next level appear and go); a click on a .md opens it in the note editor;
//   3. keyboard: → expands, ↓ moves, ← goes to the parent, Enter opens a file; "Abrir ao lado" opens the file in another group;
//   4. a folder of 2000 files expands without freezing the window (rows complete, longest gap between timer ticks measured);
//   5. the expanded folders survive a relaunch; a project folder deleted from the disk shows "pasta não encontrada".
// Screenshots (light and dark) go to <atrium>/.tmp/f8: the tree expanded with a file open beside.
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

type Row = { root: string; path: string; name: string; level: number; kind: string; expanded: boolean; selected: boolean; focused: boolean; icon: string }
type Snapshot = {
  mode: 'empty' | 'roots'
  roots: { path: string; name: string; pinned: boolean; hint: string; current: boolean; missing: boolean }[]
  rows: Row[]
  messages: string[]
  recent: string[]
}
type Hooks = {
  connection(): { pid?: number } | undefined
  explorer(): Snapshot | undefined
  sidebars(): { left: { strip: string[]; open?: string; width: number } } | undefined
  notes(): { id: string; path: string }[]
  groupOf(id: string): string | undefined
}
declare const window: { __tether: Hooks; __hb: { max: number; last: number }; setInterval(f: () => void, ms: number): number }
declare const performance: { now(): number }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelectorAll(s: string): ArrayLike<{ textContent: string | null; click(): void }> & Iterable<{ textContent: string | null; click(): void }> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorertree-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'f8')
const PAD = 'explorer.files'
const BIG = 2000
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

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
const names = async (page: Page): Promise<string[]> => (await snap(page)).rows.map(r => `${r.level}:${r.name}`)
const rowSel = (name: string): string => `.pad.shown .xp-row:has(> .xp-name:text-is("${name}"))`

async function waitNames(page: Page, expected: string[], what: string): Promise<void> {
  const deadline = Date.now() + 8_000
  let got: string[] = []
  while (Date.now() < deadline) {
    got = await names(page)
    if (got.join('|') === expected.join('|')) return
    await sleep(100)
  }
  assert.deepEqual(got, expected, what)
}

test('explorer 1b: the file tree under a root; excludes; expand; open; keyboard; 2000 files; relaunch; missing folder', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-tree-'))
  const F = join(home, 'proj', 'fixture')
  const M = join(home, 'proj', 'vanishing')
  for (const d of ['.git', 'node_modules/pkg', 'src/components', 'src/deep/level', 'docs', 'big']) mkdirSync(join(F, d), { recursive: true })
  mkdirSync(M, { recursive: true })
  writeFileSync(join(F, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(F, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(F, 'src', 'components', 'button.ts'), 'export const button = 1\n')
  writeFileSync(join(F, 'src', 'util.ts'), 'export const util = 1\n')
  writeFileSync(join(F, 'src', 'deep', 'level', 'here.md'), '# here\n')
  writeFileSync(join(F, 'docs', 'readme.md'), '# readme\n')
  writeFileSync(join(F, 'docs', 'notes.md'), '# notes\n')
  writeFileSync(join(F, 'a.md'), '# a\n')
  writeFileSync(join(F, 'B.md'), '# b\n')
  writeFileSync(join(F, 'file10.txt'), '')
  writeFileSync(join(F, 'file2.txt'), '')
  writeFileSync(join(F, 'Thumbs.db'), '')
  for (let i = 0; i < BIG; i++) writeFileSync(join(F, 'big', `f${String(i).padStart(4, '0')}.txt`), '')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const noteOf = async (): Promise<{ id: string; path: string }[]> => page.evaluate(() => window.__tether.notes())

    // ---- 1. the root, expanded; excludes; order ----
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    await stubPicker(app, F)
    await page.click('.xp-primary')
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '2:node_modules', '2:src', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], 'root expanded: no .git, no Thumbs.db, node_modules there, folders first, natural order')
    const first = await snap(page)
    assert.equal(first.rows.find(r => r.name === 'node_modules')!.expanded, false, 'node_modules stays collapsed')
    assert.equal(first.rows.find(r => r.name === 'docs')!.icon, 'folder')
    assert.equal(first.rows.find(r => r.name === 'a.md')!.icon, 'file-md')
    assert.equal(first.rows.find(r => r.name === 'fixture')!.expanded, true)

    // ---- 2. expand and collapse by click; open a .md by click ----
    await page.click(rowSel('src'))
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '2:node_modules', '2:src', '3:components', '3:deep', '3:util.ts', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], 'src expanded in place')
    assert.equal((await snap(page)).rows.find(r => r.name === 'src')!.icon, 'folder-open')
    await page.click(rowSel('deep'))
    await page.click(rowSel('level'))
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '2:node_modules', '2:src', '3:components', '3:deep', '4:level', '5:here.md', '3:util.ts', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], 'nested folders expand')
    await page.click(rowSel('deep'))
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '2:node_modules', '2:src', '3:components', '3:deep', '3:util.ts', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], 'collapsing a folder drops its subtree')
    await page.click(rowSel('deep')) // expanded again: the inner folder was remembered
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '2:node_modules', '2:src', '3:components', '3:deep', '4:level', '5:here.md', '3:util.ts', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], 'the inner expansion came back')
    await page.click(rowSel('deep'))
    await page.click(rowSel('a.md'))
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    assert.ok(same((await noteOf())[0]!.path, join(F, 'a.md')), 'a click on a.md opens it in the note editor')
    assert.equal((await snap(page)).rows.find(r => r.name === 'a.md')!.selected, true)

    // ---- 3. keyboard: → expands, ↓ moves, ← parent, Enter opens; "Abrir ao lado" ----
    await page.locator(rowSel('docs')).focus()
    await page.keyboard.press('ArrowRight')
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '3:notes.md', '3:readme.md', '2:node_modules', '2:src', '3:components', '3:deep', '3:util.ts', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], '→ expands docs')
    await page.keyboard.press('ArrowRight') // on an expanded folder: the first child
    await page.keyboard.press('ArrowDown')
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'readme.md', '↓ moves down')
    await page.keyboard.press('ArrowLeft')
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'docs', '← on a file goes to its folder')
    await page.keyboard.press('ArrowLeft')
    await waitNames(page, ['1:fixture', '2:big', '2:docs', '2:node_modules', '2:src', '3:components', '3:deep', '3:util.ts', '2:a.md', '2:B.md', '2:file2.txt', '2:file10.txt'], '← on an open folder collapses it')
    await page.keyboard.press('End')
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'file10.txt', 'End goes to the last row')
    await page.keyboard.press('Home')
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'fixture', 'Home goes to the root')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown') // docs
    await page.keyboard.press('Enter') // toggles the folder
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown') // readme.md
    assert.equal((await snap(page)).rows.find(r => r.focused)?.name, 'readme.md')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    assert.ok(same((await noteOf()).find(n => /readme/.test(n.path))!.path, join(F, 'docs', 'readme.md')), 'Enter opens a file')
    // "Abrir ao lado" from the row menu
    await page.click(rowSel('notes.md'), { button: 'right' })
    const labels = await page.evaluate(() => [...document.querySelectorAll('#ctx-menu li[role=menuitem]')].map(li => li.textContent ?? ''))
    assert.deepEqual(labels, ['Abrir', 'Abrir ao lado', 'Renomear…', 'Mover para a lixeira', 'Copiar caminho', 'Copiar caminho relativo', 'Mostrar no explorador de arquivos'])
    await page.click('#ctx-menu li:has-text("Abrir ao lado")')
    await page.waitForFunction(() => window.__tether.notes().length === 3)
    const ns = await noteOf()
    const side = ns.find(n => /notes\.md$/.test(n.path))!
    const readme = ns.find(n => /readme\.md$/.test(n.path))!
    const groups = await page.evaluate(([a, b]) => [window.__tether.groupOf(a!), window.__tether.groupOf(b!)], [side.id, readme.id])
    assert.notEqual(groups[0], groups[1], 'beside: another group than the pane that was focused')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(400)
      await page.screenshot({ path: join(shots, `explorer-tree-${scheme}.png`) })
    }

    // ---- 4. a folder of 2000 files expands without freezing ----
    await page.evaluate(() => {
      window.__hb = { max: 0, last: performance.now() }
      window.setInterval(() => { const n = performance.now(); window.__hb.max = Math.max(window.__hb.max, n - window.__hb.last); window.__hb.last = n }, 20)
    })
    const t0 = Date.now()
    await page.click(rowSel('big'))
    await page.waitForFunction(n => window.__tether.explorer()!.rows.filter(r => /^f\d{4}\.txt$/.test(r.name)).length === n, BIG, { timeout: 15_000 })
    const took = Date.now() - t0
    const gap = await page.evaluate(() => window.__hb.max)
    console.log(`2000-file folder: ${took} ms to complete, longest timer gap ${Math.round(gap)} ms`)
    assert.ok(took < 8_000, `expanded in ${took} ms`)
    assert.ok(gap < 1_500, `the window stayed responsive (longest gap ${Math.round(gap)} ms)`)
    const big = (await snap(page)).rows.filter(r => /^f\d{4}\.txt$/.test(r.name))
    assert.equal(big[0]!.name, 'f0000.txt')
    assert.equal(big[BIG - 1]!.name, 'f1999.txt', 'in order')
    // Playwright's :has()/text-is selectors are slow over 2000 rows; click the folder's name by script.
    await page.evaluate(() => { for (const n of document.querySelectorAll('.xp-row.xp-item[data-level="2"] > .xp-name')) if (n.textContent === 'big') n.click() })
    await page.waitForFunction(() => window.__tether.explorer()!.rows.every(r => !/^f\d{4}\.txt$/.test(r.name)))

    // ---- 5. relaunch keeps the expanded folders; a vanished project folder is flagged ----
    const expectedAfter = await names(page)
    await stubPicker(app, M)
    await page.click('.xp-topbar .xp-open')
    await page.waitForFunction(() => window.__tether.explorer()!.roots.length === 2)
    rmSync(M, { recursive: true, force: true })
    await sleep(1_800) // layout.json is written soon after the last change
    await killElectron(app, root)
    app = undefined
    await sleep(2_000)
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.explorer()?.roots.length === 2, undefined, { timeout: 15_000 })
    const deadline = Date.now() + 8_000
    let after: string[] = []
    while (Date.now() < deadline) {
      after = (await names(page)).filter(n => !/vanishing/.test(n))
      if (after.join('|') === expectedAfter.join('|')) break
      await sleep(100)
    }
    assert.deepEqual(after, expectedAfter, 'the expanded folders came back after the relaunch')
    await page.waitForFunction(() => window.__tether.explorer()!.roots.find(r => r.name === 'vanishing')?.missing === true, undefined, { timeout: 8_000 })
    assert.equal(await page.locator('.pad.shown .xp-root:has(.xp-name:text-is("vanishing")) .xp-warn').innerText(), 'pasta não encontrada')
    assert.equal((await snap(page)).roots.find(r => r.name === 'fixture')!.missing, false)
    await page.screenshot({ path: join(shots, 'explorer-missing-dark.png') })
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
