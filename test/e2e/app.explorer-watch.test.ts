// E2E of the explorer extension, slice 3 (F8): the tree follows the disk. Hidden window on a private home/pipe, real tetherd, no
// agent. The native folder picker is replaced in main (ipcMain 'folder:pick'); the disk is changed from the test process.
//   1. create, rename, delete a file and a folder in an expanded folder: the tree shows it in about a second, and the selection,
//      the scroll and the keyboard stay where they were (a 600-file folder, past the 400-row chunk);
//   2. a change in a folder that is not open costs no read (the read counter of the pad and the sent counter of main stay);
//   3. a burst of 500 file creations: the window stays responsive and the folder is read once;
//   4. changes inside a node_modules package are not watched (no read), a new package folder is;
//   5. a failed watcher shows the notice with "Atualizar"; the "⋯" menu has "Atualizar" and "Recolher tudo", both work;
//   6. one watcher handle per project root: a root deleted from the disk, then a root closed, release theirs.
// Screenshots (light and dark) go to <atrium>/.tmp/f8: the notice over the tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  reads: number
  notice: string
}
type Stats = { recursive: boolean; roots: number; handles: number; expanded: number; windows: number; events: number; sent: number }
type Hooks = {
  connection(): { pid?: number } | undefined
  explorer(): Snapshot | undefined
  explorerWatch(): Promise<Stats>
}
declare const window: { __tether: Hooks; __hb: { max: number; last: number }; setInterval(f: () => void, ms: number): number }
declare const performance: { now(): number }
declare const document: {
  documentElement: { dataset: Record<string, string> }
  querySelector(s: string): { scrollTop: number; scrollHeight: number; clientHeight: number } | null
  querySelectorAll(s: string): Iterable<{ textContent: string | null; click(): void; scrollIntoView(o?: unknown): void; focus(): void }> & ArrayLike<unknown>
  activeElement: { querySelector(s: string): { textContent: string | null } | null } | null
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorerwatch-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'f8')
const PAD = 'explorer.files'
const MANY = 600
const BURST = 500
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
const stats = async (page: Page): Promise<Stats> => page.evaluate(() => window.__tether.explorerWatch())
const names = async (page: Page): Promise<string[]> => (await snap(page)).rows.map(r => `${r.level}:${r.name}`)
const rowSel = (name: string): string => `.pad.shown .xp-row:has(> .xp-name:text-is("${name}"))`

/** Waits for a condition on the pad's rows; returns how long it took. */
async function until(page: Page, what: string, ok: (s: Snapshot) => boolean, timeout = 6_000): Promise<number> {
  const t0 = Date.now()
  let last: Snapshot | undefined
  while (Date.now() - t0 < timeout) {
    last = await snap(page)
    if (ok(last)) return Date.now() - t0
    await sleep(40)
  }
  assert.fail(`${what} (rows: ${last?.rows.map(r => r.name).slice(0, 40).join(', ')})`)
}

const has = (name: string) => (s: Snapshot): boolean => s.rows.some(r => r.name === name)
const hasNot = (name: string) => (s: Snapshot): boolean => !s.rows.some(r => r.name === name)

test('explorer 3: the tree follows the disk; reads only what is open; one handle per root; notice and menu actions', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-watch-'))
  const F = join(home, 'proj', 'watched')
  const M = join(home, 'proj', 'vanishing')
  for (const d of ['src', 'docs', 'many', 'node_modules/pkg']) mkdirSync(join(F, d), { recursive: true })
  mkdirSync(M, { recursive: true })
  writeFileSync(join(F, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(F, 'docs', 'd1.md'), '# d1\n')
  writeFileSync(join(F, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(F, 'a.md'), '# a\n')
  for (let i = 0; i < MANY; i++) writeFileSync(join(F, 'many', `m${String(i).padStart(3, '0')}.txt`), '')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    await stubPicker(app, F)
    await page.click('.xp-primary')
    await until(page, 'root expanded', has('src'))
    await page.click(rowSel('src'))
    await page.click(rowSel('node_modules'))
    await until(page, 'pkg shows', has('pkg'))
    await page.click(rowSel('pkg'))
    await until(page, 'index.js shows', has('index.js'))
    const st0 = await stats(page)
    console.log(`watcher: recursive=${st0.recursive} roots=${st0.roots} handles=${st0.handles} expanded=${st0.expanded}`)
    assert.equal(st0.roots, 1)
    if (st0.recursive) assert.equal(st0.handles, 1, 'one recursive handle for the root')
    else assert.equal(st0.handles, st0.expanded, 'one handle per expanded folder')

    // ---- 1. create, rename, delete in an expanded folder; the person stays where they were ----
    writeFileSync(join(F, 'src', 'new.ts'), 'export const n = 1\n')
    const tCreate = await until(page, 'a created file shows', has('new.ts'))
    renameSync(join(F, 'src', 'new.ts'), join(F, 'src', 'renamed.ts'))
    const tRename = await until(page, 'a renamed file shows its new name', s => has('renamed.ts')(s) && hasNot('new.ts')(s))
    rmSync(join(F, 'src', 'renamed.ts'))
    const tDelete = await until(page, 'a deleted file goes', hasNot('renamed.ts'))
    mkdirSync(join(F, 'src', 'sub'))
    const tMkdir = await until(page, 'a created folder shows', s => s.rows.some(r => r.name === 'sub' && r.kind === 'dir'))
    rmSync(join(F, 'src', 'sub'), { recursive: true })
    await until(page, 'a deleted folder goes', hasNot('sub'))
    console.log(`follows the disk: create ${tCreate} ms, rename ${tRename} ms, delete ${tDelete} ms, mkdir ${tMkdir} ms`)
    for (const [what, ms] of [['create', tCreate], ['rename', tRename], ['delete', tDelete], ['mkdir', tMkdir]] as const) assert.ok(ms < 1_500, `${what} showed in ${ms} ms`)

    // selection, scroll and keyboard stay put when the folder being read again is big (past the 400-row chunk)
    await page.click(rowSel('many')) // selects the folder row and opens it
    await until(page, 'the big folder is drawn', s => s.rows.filter(r => /^m\d{3}\.txt$/.test(r.name)).length === MANY, 10_000)
    await page.locator(rowSel('m420.txt')).focus()
    await page.evaluate(() => {
      for (const n of document.querySelectorAll('.xp-row.xp-item > .xp-name')) if (n.textContent === 'm420.txt') (n as unknown as { parentElement: { scrollIntoView(o?: unknown): void } }).parentElement.scrollIntoView({ block: 'center' })
    })
    await sleep(150)
    const before = await page.evaluate(() => ({ top: document.querySelector('.pad.shown .xp')!.scrollTop, active: document.activeElement?.querySelector('.xp-name')?.textContent ?? '' }))
    assert.ok(before.top > 1_000, `the folder is scrolled (${before.top})`)
    assert.equal(before.active, 'm420.txt')
    writeFileSync(join(F, 'many', 'm9999.txt'), '')
    await until(page, 'the big folder shows the new file', has('m9999.txt'), 10_000)
    await sleep(200)
    const after = await page.evaluate(() => ({ top: document.querySelector('.pad.shown .xp')!.scrollTop, active: document.activeElement?.querySelector('.xp-name')?.textContent ?? '' }))
    assert.ok(Math.abs(after.top - before.top) <= 2, `the scroll stayed (${before.top} → ${after.top})`)
    assert.equal(after.active, 'm420.txt', 'the keyboard stayed on the same row')
    assert.equal((await snap(page)).rows.find(r => r.name === 'many')!.selected, true, 'the selection stayed')
    await page.evaluate(() => { for (const n of document.querySelectorAll('.xp-row.xp-item[data-level="2"] > .xp-name')) if (n.textContent === 'many') n.click() })
    await until(page, 'the big folder closes', s => s.rows.every(r => !/^m\d{3}\.txt$/.test(r.name)))
    rmSync(join(F, 'many', 'm9999.txt'))

    // ---- 2. a folder that is not open costs nothing ----
    await sleep(500)
    const r2 = (await snap(page)).reads
    const s2 = await stats(page)
    writeFileSync(join(F, 'docs', 'closed.md'), '# x\n')
    writeFileSync(join(F, 'docs', 'closed2.md'), '# x\n')
    await sleep(900)
    assert.equal((await snap(page)).reads, r2, 'no read for a folder that is closed')
    assert.equal((await stats(page)).sent, s2.sent, 'main sent nothing for a folder that is closed')
    await page.click(rowSel('docs'))
    await until(page, 'opening it shows what changed meanwhile', has('closed2.md'))
    await page.click(rowSel('docs'))

    // ---- 3. a burst of 500 creations: responsive, read once ----
    await page.evaluate(() => {
      window.__hb = { max: 0, last: performance.now() }
      window.setInterval(() => { const n = performance.now(); window.__hb.max = Math.max(window.__hb.max, n - window.__hb.last); window.__hb.last = n }, 20)
    })
    await sleep(400)
    const r3 = (await snap(page)).reads
    const s3 = await stats(page)
    for (let i = 0; i < BURST; i++) writeFileSync(join(F, 'src', `b${String(i).padStart(3, '0')}.ts`), '')
    const tBurst = await until(page, 'the burst shows', s => s.rows.filter(r => /^b\d{3}\.ts$/.test(r.name)).length === BURST, 10_000)
    await sleep(1_300)
    const gap = await page.evaluate(() => window.__hb.max)
    const readsBurst = (await snap(page)).reads - r3
    const sentBurst = (await stats(page)).sent - s3.sent
    console.log(`burst of ${BURST}: shown ${tBurst} ms after the last write, ${readsBurst} read(s), main sent ${sentBurst} folder(s), longest timer gap ${Math.round(gap)} ms`)
    assert.ok(gap < 1_000, `the window stayed responsive (longest gap ${Math.round(gap)} ms)`)
    assert.equal(readsBurst, 1, 'the folder was read once for the whole burst')
    assert.equal(sentBurst, 1, 'main sent the folder once')
    for (let i = 0; i < BURST; i++) rmSync(join(F, 'src', `b${String(i).padStart(3, '0')}.ts`))
    await until(page, 'the burst goes', s => s.rows.every(r => !/^b\d{3}\.ts$/.test(r.name)), 10_000)

    // ---- 4. inside node_modules packages nothing is watched; a new package is ----
    await sleep(600)
    const r4 = (await snap(page)).reads
    const s4 = await stats(page)
    writeFileSync(join(F, 'node_modules', 'pkg', 'index.js'), 'module.exports = 2\n')
    writeFileSync(join(F, 'node_modules', 'pkg', 'extra.js'), '')
    mkdirSync(join(F, 'node_modules', 'pkg', 'lib'))
    await sleep(1_000)
    assert.equal((await snap(page)).reads, r4, 'no read for changes inside a package')
    assert.equal((await stats(page)).sent, s4.sent, 'main sent nothing for them')
    assert.ok(!(await snap(page)).rows.some(r => r.name === 'extra.js'), 'the package listing is not refreshed by itself')
    mkdirSync(join(F, 'node_modules', 'newpkg'))
    await until(page, 'a new package folder shows in the open node_modules', has('newpkg'))

    // ---- 5. the notice and the menu actions ----
    await app.evaluate(({ BrowserWindow }, f) => { BrowserWindow.getAllWindows()[0]!.webContents.send('ext:explorer:watchFailed', f, 'Sem permissão para vigiar esta pasta.') }, F)
    await page.waitForSelector('.pad.shown .xp-notice:not([hidden])')
    assert.match((await snap(page)).notice, /não está acompanhando o disco/)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(300)
      await page.screenshot({ path: join(shots, `explorer-notice-${scheme}.png`) })
    }
    const r5 = (await snap(page)).reads
    await page.click('.pad.shown .xp-notice-btn')
    await page.waitForSelector('.pad.shown .xp-notice', { state: 'hidden' })
    await until(page, 'Atualizar reads the open folders again', s => s.reads > r5 && s.notice === '')

    const menu = async (): Promise<string[]> => {
      await page.click('.pad.shown .pad-more')
      await page.waitForSelector('#ctx-menu')
      return page.evaluate(() => [...document.querySelectorAll('#ctx-menu li[role^=menuitem]')].map(li => li.textContent ?? ''))
    }
    assert.deepEqual((await menu()).slice(-2), ['Atualizar', 'Recolher tudo'])
    const r6 = (await snap(page)).reads
    await page.click('#ctx-menu li:has-text("Atualizar")')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    await until(page, 'the menu Atualizar reads again', s => s.reads > r6)
    await menu()
    await page.click('#ctx-menu li:has-text("Recolher tudo")')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    await until(page, 'Recolher tudo closes every folder, the root stays', s => s.rows.length === 6 && s.rows[0]!.expanded && s.rows.slice(1).every(r => !r.expanded))
    assert.deepEqual((await names(page)).slice(0, 4), ['1:watched', '2:docs', '2:many', '2:node_modules'])
    assert.equal((await stats(page)).expanded, 1, 'main hears that only the root is open')

    // ---- 6. one handle per root; a root deleted, a root closed ----
    await stubPicker(app, M)
    await page.click('.xp-add')
    await page.waitForFunction(() => window.__tether.explorer()!.roots.length === 2)
    const two = await stats(page)
    assert.equal(two.roots, 2)
    if (two.recursive) assert.equal(two.handles, 2, 'a handle for each root')
    rmSync(M, { recursive: true, force: true })
    await page.waitForFunction(() => window.__tether.explorer()!.roots.find(r => r.name === 'vanishing')?.missing === true, undefined, { timeout: 6_000 })
    const gone = await stats(page)
    if (gone.recursive) assert.equal(gone.handles, 1, 'the handle of a root that is gone is released')
    await page.screenshot({ path: join(shots, 'explorer-watch-missing-dark.png') })
    // close the vanished root (unpin), then the other one
    await page.click('.pad.shown .xp-root:has(.xp-name:text-is("vanishing")) .xp-pin')
    await page.waitForFunction(() => window.__tether.explorer()!.roots.length === 1)
    await page.click('.pad.shown .xp-root .xp-pin')
    await page.waitForFunction(() => window.__tether.explorer()!.mode === 'empty')
    const end = await stats(page)
    assert.equal(end.roots, 0)
    assert.equal(end.handles, 0, 'no watcher left when no root is open')
    assert.equal(end.expanded, 0)
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
