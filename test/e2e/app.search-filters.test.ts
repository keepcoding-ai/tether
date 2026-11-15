// E2E of the search pad's filters and menus. Hidden window on a private home/pipe, real tetherd, no agent; a fixture project
// (a git repository when `git` is on the PATH) in a temporary folder, pinned as the window's project.
//   1. "only open editors" (book-open): nothing open -> the message and no search; two notes open -> only their files, and the
//      count line says so;
//   2. "only changed files" (git-diff): a modified, a new untracked and an unchanged file -> only the first two; with both
//      switches on, the open files that changed; a clean repository -> the message;
//   3. the rows' context menu with a real right click: copy a match, a file, a folder and everything (read from the clipboard),
//      copy path, restrict the search to a folder, exclude a folder, and Ctrl+C on the focused row;
//   4. the sort order setting reorders the tree without a new search;
//   5. the explorer's "Pesquisar na pasta…" on a folder and, with two projects, on a folder and on a root;
//   6. a real click on a row's "Dispensar" leaves the keyboard on the tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { kind: 'folder' | 'file' | 'match'; id: string; level: number; label: string; count?: number; before?: string; inside?: string; after?: string; focused: boolean }
type Snap = {
  widget: { search: string; include: string; exclude: string; detailsShown: boolean; onlyOpenEditors: boolean; onlyChangedFiles: boolean }
  message: string[]; searching: boolean; replacing: boolean; viewMode: 'list' | 'tree'; count: number; fileCount: number; lastSearchMs: number | undefined
  results: { rows: Row[] }
}
type Hooks = {
  connection(): { pid?: number } | undefined
  search(): Snap | undefined
  openFolder(path: string): void
  openNote(path: string): Promise<void>
  runCommand(id: string): Promise<string>
}
declare const window: { __tether: Hooks; tether: { settingsSet(key: string, value: unknown): Promise<{ ok: boolean }> } }
declare const document: { activeElement: { className?: string; getAttribute(n: string): string | null } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sfilters-${process.pid}`
const atriumTmp = /^(.*?[\\/]\.tmp)(?=[\\/])/.exec(root)?.[1] ?? resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const PAD_SEL = '.pad[data-pad="search.view"]'
const SCROLL = `${PAD_SEL} .sr-scroll`
const FIELD = (label: string): string => `${PAD_SEL} .srw-field[aria-label="${label}"]`
const TOGGLE = (label: string): string => `${PAD_SEL} .srw-t[aria-label="${label}"]`
const OPEN_EDITORS = 'Pesquisar só nos editores abertos'
const CHANGED_FILES = 'Pesquisar só nos arquivos alterados'
const EOL = process.platform === 'win32' ? '\r\n' : '\n'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
/** Paths compared as the platform does: separators and case do not matter. */
const norm = (s: string): string => s.replaceAll('\\', '/').toLowerCase()
const gitOk = spawnSync('git', ['--version']).status === 0

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
  return { app, page }
}

const snap = async (page: Page): Promise<Snap> => (await page.evaluate(() => window.__tether.search()))!

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(80) }
  assert.fail(`timed out: ${what}`)
}

/** The search ended and its first message line is `first` (a string, or a pattern); the tree has redrawn to match. */
async function waitDone(page: Page, first: string | RegExp, what: string): Promise<Snap> {
  let s: Snap | undefined
  await until(what, async () => {
    s = await snap(page)
    const line = s.message[0] ?? ''
    if (s.searching || s.replacing || !(typeof first === 'string' ? line === first : first.test(line))) return false
    const rows = s.results.rows
    return rows.filter(r => r.kind === 'file').reduce((n, r) => n + (r.count ?? 0), 0) === s.count
  }).catch(() => assert.fail(`${what}: message ${JSON.stringify(s?.message)}, searching ${s?.searching}, rows ${JSON.stringify(s?.results.rows.map(r => `${r.kind}:${r.label}`))}`))
  return s!
}

async function search(page: Page, term: string, first: string | RegExp): Promise<Snap> {
  await page.fill(FIELD('Pesquisar'), term)
  return waitDone(page, first, `search ${term}`)
}

const files = (s: Snap): string[] => s.results.rows.filter(r => r.kind === 'file').map(r => r.label)
const clip = (app: ElectronApplication): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText())
const setClip = (app: ElectronApplication, text: string): Promise<void> => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)

/** The row of the tree: a folder or file by its name, a match by the text it shows. */
const rowByName = (page: Page, kind: 'folder' | 'file', name: string) =>
  page.locator(`${SCROLL} .sr-row.sr-${kind}`).filter({ has: page.locator('.sr-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) })
const matchRow = (page: Page, text: string) => page.locator(`${SCROLL} .sr-row.sr-match`).filter({ hasText: text })

/** A real right click on a row and a real click on a menu item (an exact label). */
async function menuOn(row: ReturnType<typeof rowByName>, page: Page, item: string): Promise<void> {
  await row.click({ button: 'right' })
  await page.locator('#ctx-menu li').filter({ hasText: new RegExp(`^${item}$`) }).click()
}

async function setDetails(page: Page, shown: boolean): Promise<void> {
  if ((await snap(page)).widget.detailsShown !== shown) await page.evaluate(() => window.__tether.runCommand('search.toggle-details'))
  await page.waitForSelector(FIELD('arquivos a incluir'), { state: shown ? 'visible' : 'hidden' })
}

const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
}

test('search filters: open editors, changed files, row menu, sort order, explorer, focus', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpBase, 'tether-sfilters-'))
  const F = join(home, 'proj', 'fixture')
  const G = join(home, 'proj', 'second')
  const P = (...p: string[]): string => join(F, ...p)
  for (const d of ['sub/deep', 'other']) mkdirSync(P(...d.split('/')), { recursive: true })
  mkdirSync(G, { recursive: true })
  writeFileSync(P('a.txt'), 'alpha FILTQ end\n')
  writeFileSync(P('b.txt'), 'beta old\n')
  writeFileSync(P('sub', 'd.txt'), 'one FILTQ\ntwo FILTQ\n')
  writeFileSync(P('sub', 'deep', 'e.txt'), 'deep FILTQ\n')
  writeFileSync(P('other', 'f.txt'), 'other FILTQ\n')
  writeFileSync(join(G, 'g.txt'), 'gee FILTQ\n')
  if (gitOk) {
    git(F, 'init', '-q')
    git(F, 'add', '-A')
    git(F, 'commit', '-q', '-m', 'init')
  }
  // The change set: b.txt modified, c.txt new and untracked (a, d, e, f unchanged).
  writeFileSync(P('b.txt'), 'beta FILTQ end\n')
  writeFileSync(P('c.txt'), 'gamma FILTQ end\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let clipboardBefore: string | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    clipboardBefore = await clip(app)
    await page.evaluate(f => window.__tether.openFolder(f), F)
    await page.keyboard.press('Control+Shift+F')
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)
    await setDetails(page, true)

    let s = await search(page, 'FILTQ', '7 resultados em 6 arquivos')
    if (!gitOk) s = await search(page, 'FILTQ', /resultados em \d+ arquivos/)
    const all = files(s).sort()

    // ---- 1. only open editors ----
    await page.click(TOGGLE(OPEN_EDITORS))
    s = await waitDone(page, 'Nenhum editor aberto para pesquisar.', 'no editor open')
    assert.equal(s.results.rows.length, 0, 'nothing is searched')
    await page.click(TOGGLE(OPEN_EDITORS))
    await waitDone(page, /^\d+ resultados? em \d+ arquivos?$/, 'back to everything')
    await page.evaluate(x => window.__tether.openNote(x), P('a.txt'))
    await page.evaluate(x => window.__tether.openNote(x), P('sub', 'd.txt'))
    await sleep(500)
    await page.click(TOGGLE(OPEN_EDITORS))
    s = await waitDone(page, '3 resultados em 2 arquivos — só nos editores abertos', 'two editors open')
    assert.deepEqual(files(s).sort(), ['a.txt', 'd.txt'])

    // ---- 2. only changed files ----
    if (gitOk) {
      await page.click(TOGGLE(OPEN_EDITORS)) // off
      await page.click(TOGGLE(CHANGED_FILES))
      s = await waitDone(page, '2 resultados em 2 arquivos — só nos arquivos alterados', 'changed files')
      assert.deepEqual(files(s).sort(), ['b.txt', 'c.txt'], 'the modified and the untracked file; not the unchanged ones')
      // Both on: the open files that changed (a and d are open, neither changed).
      await page.click(TOGGLE(OPEN_EDITORS))
      s = await waitDone(page, /^Nenhum resultado encontrado/, 'both on, nothing in common')
      assert.equal(s.results.rows.length, 0)
      await page.evaluate(x => window.__tether.openNote(x), P('b.txt'))
      await sleep(500)
      await page.evaluate(() => window.__tether.runCommand('search.refresh'))
      s = await waitDone(page, '1 resultado em 1 arquivo — só nos editores abertos — só nos arquivos alterados', 'both on, b changed and open')
      assert.deepEqual(files(s), ['b.txt'])
      await page.click(TOGGLE(OPEN_EDITORS)) // off
      // A clean repository.
      git(F, 'add', '-A')
      git(F, 'commit', '-q', '-m', 'all')
      await page.evaluate(() => window.__tether.runCommand('search.refresh'))
      s = await waitDone(page, 'Nenhum arquivo alterado no git nestas pastas.', 'clean repository')
      assert.equal(s.results.rows.length, 0)
      await page.click(TOGGLE(CHANGED_FILES)) // off
    }
    s = await waitDone(page, /^\d+ resultados? em \d+ arquivos?$/, 'every filter off')
    assert.deepEqual(files(s).sort(), all)
    assert.ok(!s.message[0]!.includes('—'), 'no note on the count line')

    // ---- 3. the rows' context menu (tree view, so the folders are rows) ----
    await page.evaluate(() => window.__tether.runCommand('search.view-as-tree'))
    s = await waitDone(page, '7 resultados em 6 arquivos', 'tree view')
    assert.ok(s.results.rows.some(r => r.kind === 'folder' && r.label === 'sub'), 'the folders are rows')

    await menuOn(matchRow(page, 'one FILTQ'), page, 'Copiar')
    await until('match copied', async () => (await clip(app!)) === '1,5: one FILTQ')
    await menuOn(matchRow(page, 'one FILTQ'), page, 'Copiar caminho')
    await until('match path copied', async () => norm(await clip(app!)) === norm(P('sub', 'd.txt')))

    await menuOn(rowByName(page, 'file', 'd.txt'), page, 'Copiar')
    await until('file copied', async () => norm((await clip(app!)).split(EOL)[0]!) === norm(P('sub', 'd.txt')))
    assert.deepEqual((await clip(app)).split(EOL).slice(1), ['  1,5: one FILTQ', '  2,5: two FILTQ'])
    await menuOn(rowByName(page, 'file', 'd.txt'), page, 'Copiar caminho')
    await until('file path copied', async () => norm(await clip(app!)) === norm(P('sub', 'd.txt')))

    await menuOn(rowByName(page, 'folder', 'sub'), page, 'Copiar')
    await until('folder copied', async () => (await clip(app!)).includes('deep FILTQ'))
    {
      const blocks = (await clip(app)).split(EOL + EOL)
      assert.equal(blocks.length, 2, 'the subfolder\'s file, then the folder\'s own file')
      assert.ok(norm(blocks[0]!.split(EOL)[0]!) === norm(P('sub', 'deep', 'e.txt')) && norm(blocks[1]!.split(EOL)[0]!) === norm(P('sub', 'd.txt')), blocks.join('|'))
    }
    await menuOn(rowByName(page, 'folder', 'sub'), page, 'Copiar caminho')
    await until('folder path copied', async () => norm(await clip(app!)) === norm(P('sub')))

    await menuOn(rowByName(page, 'file', 'a.txt'), page, 'Copiar tudo')
    await until('everything copied', async () => (await clip(app!)).includes('other FILTQ'))
    {
      const blocks = (await clip(app)).split(EOL + EOL)
      const heads = blocks.map(b => norm(b.split(EOL)[0]!))
      assert.deepEqual(heads, ['other/f.txt', 'sub/deep/e.txt', 'sub/d.txt', 'a.txt', 'b.txt', 'c.txt'].map(x => norm(P(...x.split('/')))), 'every file of the result, folders first')
    }

    // Restrict to a folder: the include field takes it, the details are open, the results are that folder's.
    await setDetails(page, false)
    await menuOn(rowByName(page, 'folder', 'sub'), page, 'Restringir a pesquisa à pasta')
    s = await waitDone(page, '3 resultados em 2 arquivos', 'restricted to sub')
    assert.equal(s.widget.include, './sub')
    assert.equal(s.widget.detailsShown, true)
    assert.deepEqual(files(s).sort(), ['d.txt', 'e.txt'])
    await page.fill(FIELD('arquivos a incluir'), '')
    await waitDone(page, '7 resultados em 6 arquivos', 'include cleared')

    // Exclude a folder: the exclude field takes it, the folder is gone.
    await menuOn(rowByName(page, 'folder', 'other'), page, 'Excluir a pasta da pesquisa')
    s = await waitDone(page, '6 resultados em 5 arquivos', 'other excluded')
    assert.equal(s.widget.exclude, './other')
    assert.ok(!files(s).includes('f.txt'))
    // (A folder with an open file would keep that file: the in-memory search ignores a folder-relative exclude. `deep` has none.)
    await menuOn(rowByName(page, 'folder', 'deep'), page, 'Excluir a pasta da pesquisa')
    s = await waitDone(page, '5 resultados em 4 arquivos', 'deep excluded too')
    assert.equal(s.widget.exclude, './other, ./sub/deep')
    await page.fill(FIELD('arquivos a excluir'), '')
    await waitDone(page, '7 resultados em 6 arquivos', 'exclude cleared')

    // Ctrl+C on the focused row.
    await setClip(app, 'sentinel')
    // A right click gives the row the keyboard without opening it; Escape closes the menu.
    await matchRow(page, 'one FILTQ').click({ button: 'right' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+c')
    await until('Ctrl+C copied the row', async () => (await clip(app!)) === '1,5: one FILTQ')
    await setClip(app, 'sentinel')
    await rowByName(page, 'file', 'a.txt').click({ button: 'right' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+c')
    await until('Ctrl+C on a file row', async () => (await clip(app!)).includes('alpha FILTQ end'))

    // ---- 4. sort order: the tree reorders with no new search ----
    await page.evaluate(() => window.__tether.runCommand('search.view-as-list'))
    s = await waitDone(page, '7 resultados em 6 arquivos', 'list view')
    const before = s.lastSearchMs
    unlinkSync(P('other', 'f.txt')) // a new search would not find it any more
    const order = async (value: string): Promise<string[]> => {
      assert.equal((await page.evaluate(v => window.tether.settingsSet('extensions.search.sortOrder', v), value)).ok, true)
      let got: string[] = []
      await until(`order ${value}`, async () => { got = files(await snap(page)); return got.length === 6 })
      return got
    }
    await until('default order drawn', async () => files(await snap(page)).length === 6)
    const byName = await order('fileNames')
    assert.deepEqual(byName, ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'])
    const desc = await order('countDescending')
    assert.equal(desc[0], 'd.txt', 'most results first')
    const asc = await order('countAscending')
    assert.equal(asc.at(-1), 'd.txt', 'fewest results first')
    s = await snap(page)
    assert.equal(s.lastSearchMs, before, 'no new search ran')
    assert.equal(s.count, 7)
    await page.evaluate(() => window.tether.settingsSet('extensions.search.sortOrder', 'default'))
    writeFileSync(P('other', 'f.txt'), 'other FILTQ\n')

    // ---- 6. focus: a real click on "Dispensar" leaves the keyboard on the tree ----
    await page.focus(FIELD('Pesquisar'))
    const row = rowByName(page, 'file', 'a.txt')
    await row.hover()
    await row.locator('.sr-act[data-act="dismiss"]').click()
    await until('the tree has the keyboard', () => page.evaluate(() => document.activeElement?.className?.includes('sr-scroll') === true))
    await until('the row is dismissed', async () => !files(await snap(page)).includes('a.txt'))
    s = await snap(page)
    const at = s.results.rows.findIndex(r => r.focused)
    assert.ok(at >= 0, 'a row has the keyboard')
    await page.keyboard.press('ArrowDown')
    await until('the arrow moves the focus', async () => (await snap(page)).results.rows.findIndex(r => r.focused) === at + 1)

    // ---- 5. the explorer's "Pesquisar na pasta…" ----
    await page.fill(FIELD('Pesquisar'), '')
    await page.click('#sidebar-left .sb-icon[data-pad="explorer.files"]')
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-row')
    const xp = (name: string): string => `.pad[data-pad="explorer.files"].shown .xp-row:has(> .xp-name:text-is("${name}"))`
    await page.click(xp('sub'), { button: 'right' })
    await page.locator('#ctx-menu li').filter({ hasText: /^Pesquisar na pasta…$/ }).click()
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)
    s = await snap(page)
    assert.equal(s.widget.include, './sub', 'one project: relative to it')
    assert.equal(s.widget.detailsShown, true)
    await until('the search field has the keyboard', () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Pesquisar'))
    await page.keyboard.type('FILTQ')
    s = await waitDone(page, '3 resultados em 2 arquivos', 'search in the folder')
    assert.deepEqual(files(s).sort(), ['d.txt', 'e.txt'])
    // A file's menu does not offer it.
    await page.click('#sidebar-left .sb-icon[data-pad="explorer.files"]')
    await page.click(xp('b.txt'), { button: 'right' })
    assert.equal(await page.locator('#ctx-menu li').filter({ hasText: /^Pesquisar na pasta…$/ }).count(), 0, 'files do not offer it')
    await page.keyboard.press('Escape')

    // Two projects: the name of the project leads.
    await page.evaluate(g => window.__tether.openFolder(g), G)
    await page.waitForSelector(xp('second'))
    await page.click(xp('sub'), { button: 'right' })
    await page.locator('#ctx-menu li').filter({ hasText: /^Pesquisar na pasta…$/ }).click()
    await until('include with the project name', async () => (await snap(page)).widget.include === './fixture/sub')
    await page.click('#sidebar-left .sb-icon[data-pad="explorer.files"]')
    await page.click(xp('second'), { button: 'right' })
    await page.locator('#ctx-menu li').filter({ hasText: /^Pesquisar na pasta…$/ }).click()
    await until('include with the root', async () => (await snap(page)).widget.include === './second')
    s = await waitDone(page, '1 resultado em 1 arquivo', 'search in the second project')
    assert.deepEqual(files(s), ['g.txt'])
  } finally {
    if (clipboardBefore !== undefined && app) await setClip(app, clipboardBefore).catch(() => {})
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 20; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(500) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
