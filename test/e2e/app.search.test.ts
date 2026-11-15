// E2E of the search extension: the "Pesquisar" pad end to end. Hidden window on a private home/pipe, real tetherd, no agent;
// a fixture project in a temporary folder, pinned as the window's project.
//   1. Ctrl+Shift+F opens the pad with the keyboard in the search field; typing fills the tree without Enter: the files,
//      their counts and the three parts of each match follow the fixture; .gitignore'd files and node_modules stay out;
//      the message says "N resultados em M arquivos";
//   2. the toggles (click and Alt+C/W/R) change the results; an invalid regex shows a message under the field; smart case off;
//   3. "…" opens the details: include *.md restricts, exclude removes, the exclusions toggle off brings the ignored files;
//   4. a click on a match opens the file with the match selected (exact columns, on a line with accents before it);
//      Ctrl+click opens it beside;
//   5. the keyboard in the tree: ↓/↑, → expands, ← collapses, Enter opens, Delete dismisses (counts follow), ↑ on the first
//      row goes back to the field; F4 / Shift+F4 walk the matches and open each one;
//   6. collapse all / expand all; tree / list (the tree shows the intermediate folders);
//   7. the replace preview: the found text struck out beside the new one (with a regex and $1);
//   8. a search past 20 000 matches: the partial-results warning, few rows in the DOM, the window never freezes;
//   9. cancelling a big search (button and Esc) keeps what arrived;
//  10. "Limpar resultados"; the fields' state (term, toggles, details open, view mode) survives a relaunch.
// Screenshots (light and dark) go to <atrium>/.tmp/search.
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

type Row = {
  kind: 'folder' | 'file' | 'match'; id: string; level: number; label: string; description: string; count?: number; expanded?: boolean
  before?: string; inside?: string; after?: string; replacement?: string; focused: boolean; selected: boolean
}
type WidgetState = {
  search: string; replace: string; replaceShown: boolean; caseSensitive: boolean; wholeWord: boolean; regex: boolean; preserveCase: boolean
  detailsShown: boolean; include: string; exclude: string; useExcludesAndIgnoreFiles: boolean; searchMessage?: string; replaceAllEnabled: boolean
}
type Snap = {
  widget: WidgetState; message: string[]; searching: boolean; viewMode: 'list' | 'tree'; count: number; fileCount: number
  lastSearchMs?: number; results: { rows: Row[]; rendered: number; sticky: string[] }
}
type Sel = { startLine: number; startColumn: number; endLine: number; endColumn: number }
type Note = { id: string; path: string; selection?: Sel }
type Hooks = {
  connection(): { pid?: number } | undefined
  search(): Snap | undefined
  searchStatus(): { searching: boolean; count: number; fileCount: number; message: string[] } | undefined
  notes(): Note[]
  groupOf(id: string): string | undefined
  openFolder(path: string): void
  runCommand(id: string): Promise<string>
}
type Box = { left: number; top: number; width: number; height: number }
type El = { getBoundingClientRect(): Box; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null; value: string; textContent: string | null }
declare const window: { __tether: Hooks; __hb: { max: number; last: number }; setInterval(f: () => void, ms: number): number }
declare const performance: { now(): number }
declare const CSS: { escape(s: string): string }
declare const KeyboardEvent: new (type: string, init: { key: string; bubbles: boolean; cancelable: boolean }) => unknown
declare function setTimeout(f: () => void, ms: number): number
declare const document: {
  documentElement: { dataset: Record<string, string> }
  activeElement: El | null
  querySelector(s: string): El | null
  querySelectorAll(s: string): ArrayLike<El>
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appsearch-${process.pid}`
// <atrium>/.tmp: the checkout lives in <atrium>/workspace/tether, or in a worktree under <atrium>/.tmp itself.
const atriumTmp = /^(.*?[\\/]\.tmp)(?=[\\/])/.exec(root)?.[1] ?? resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'search')
const PAD_SEL = '.pad[data-pad="search.view"]'
const SCROLL = `${PAD_SEL} .sr-scroll`
const FIELD = (label: string): string => `${PAD_SEL} .srw-field[aria-label="${label}"]`
const TOGGLE = (label: string): string => `${PAD_SEL} .srw-t[aria-label="${label}"]`
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

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

const snap = async (page: Page): Promise<Snap> => (await page.evaluate(() => window.__tether.search()))!

/** Waits until the search is idle and its first message line is `first` (a string or a test). */
async function waitDone(page: Page, first: string | RegExp, what: string, timeout = 10_000): Promise<Snap> {
  const deadline = Date.now() + timeout
  let s: Snap | undefined
  while (Date.now() < deadline) {
    s = await snap(page)
    const line = s.message[0] ?? ''
    if (!s.searching && (typeof first === 'string' ? line === first : first.test(line))) return s
    await sleep(60)
  }
  assert.fail(`${what}: message ${JSON.stringify(s?.message)}, searching ${s?.searching}`)
}

/** The files of the results with their counts, as "relative-name:count" (list view: the file rows). */
const files = (s: Snap): string[] => s.results.rows.filter(r => r.kind === 'file').map(r => `${r.description ? `${r.description.replace(/\\/g, '/')}/` : ''}${r.label}:${r.count}`).sort()

/** Clicks the visible list row of an element (the sticky copy has the same id, so the list's row is picked). */
async function clickRow(page: Page, id: string, opts: { modifiers?: ('Control' | 'Shift')[]; button?: 'left' | 'right' } = {}): Promise<void> {
  const box = await page.evaluate(([scroll, rid]) => {
    const r = document.querySelector(`${scroll} .sr-row[data-id="${CSS.escape(rid!)}"]`)
    if (!r) return undefined
    const b = r.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  }, [SCROLL, id])
  assert.ok(box, `row ${id} is drawn`)
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m)
  await page.mouse.click(box.x, box.y, { button: opts.button ?? 'left' })
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m)
}

/** Replaces the text of a field as typed (an input event: search on type). */
async function setField(page: Page, label: string, value: string): Promise<void> {
  await page.fill(FIELD(label), value)
}

const noteOf = async (page: Page, path: string): Promise<Note | undefined> =>
  (await page.evaluate(() => window.__tether.notes())).find(n => same(n.path, path))

async function waitSelection(page: Page, path: string, sel: Sel, what: string): Promise<Note> {
  const deadline = Date.now() + 8_000
  let n: Note | undefined
  while (Date.now() < deadline) {
    n = await noteOf(page, path)
    if (n?.selection && JSON.stringify(n.selection) === JSON.stringify(sel)) return n
    await sleep(80)
  }
  assert.fail(`${what}: note ${n ? JSON.stringify(n.selection) : 'not open'}, expected ${JSON.stringify(sel)}`)
}

const activeLabel = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)

test('search: the pad end to end (fields, tree, open, keyboard, replace preview, big search, cancel, state)', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-search-'))
  const F = join(home, 'proj', 'fixture')
  for (const d of ['.git', 'node_modules/pkg', 'src/deep', 'docs', 'big', 'huge']) mkdirSync(join(F, d), { recursive: true })
  writeFileSync(join(F, '.git', 'HEAD'), 'needle in git\n')
  writeFileSync(join(F, '.gitignore'), 'ignored.txt\nbig-out/\n')
  writeFileSync(join(F, 'ignored.txt'), 'needle in ignored\n')
  writeFileSync(join(F, 'node_modules', 'pkg', 'index.js'), 'needle in node_modules\n')
  writeFileSync(join(F, 'a.md'), '# Alpha\nthe needle is here\nNeedle again, needle twice\n')
  writeFileSync(join(F, 'src', 'code.ts'), 'const needle = 1\nexport function needles() {}\n')
  writeFileSync(join(F, 'src', 'deep', 'acento.txt'), 'ação é needle\n')
  writeFileSync(join(F, 'docs', 'notes.md'), 'NEEDLE upper\n')
  // 8. past the limit: 250 files × 100 lines × 2 "zebra" = 50 000 matches; 9. a bigger one to cancel: 800 × 200 × 2 "okapi".
  const zebra = 'a zebra and a zebra again\n'.repeat(100)
  for (let i = 0; i < 250; i++) writeFileSync(join(F, 'big', `z${String(i).padStart(3, '0')}.txt`), zebra)
  const okapi = 'okapi okapi okapi okapi\n'.repeat(200)
  for (let i = 0; i < 800; i++) writeFileSync(join(F, 'huge', `o${String(i).padStart(3, '0')}.txt`), okapi)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(f => window.__tether.openFolder(f), F)

    // ---- 1. Ctrl+Shift+F, type, results without Enter ----
    await page.keyboard.press('Control+Shift+F')
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)
    assert.equal(await activeLabel(page), 'Pesquisar', 'Ctrl+Shift+F puts the keyboard in the search field')
    await page.keyboard.type('needle')
    let s = await waitDone(page, '7 resultados em 4 arquivos', 'typing searches without Enter')
    assert.deepEqual(files(s), ['a.md:3', 'docs/notes.md:1', 'src/code.ts:2', 'src/deep/acento.txt:1'], 'files and counts; .gitignore, node_modules and .git stay out')
    const parts = s.results.rows.filter(r => r.kind === 'match').map(r => [r.before, r.inside, r.after])
    for (const p of [['the ', 'needle', ' is here'], ['', 'Needle', ' again, needle twice'], ['Needle again, ', 'needle', ' twice'], ['const ', 'needle', ' = 1'],
      ['export function ', 'needle', 's() {}'], ['ação é ', 'needle', ''], ['', 'NEEDLE', ' upper']]) {
      assert.ok(parts.some(q => JSON.stringify(q) === JSON.stringify(p)), `the match ${JSON.stringify(p)} is in the tree (${JSON.stringify(parts)})`)
    }
    assert.equal(s.widget.caseSensitive, false, 'case-insensitive by default')
    await setField(page, 'Pesquisar', 'Needle')
    s = await waitDone(page, '7 resultados em 4 arquivos', 'smart case is off: an upper-case term still ignores case')

    // ---- 2. toggles, Alt shortcuts, invalid regex ----
    await setField(page, 'Pesquisar', 'needle')
    await waitDone(page, '7 resultados em 4 arquivos', 'back to needle')
    await page.click(TOGGLE('Diferenciar maiúsculas de minúsculas'))
    s = await waitDone(page, '5 resultados em 3 arquivos', 'Aa: case-sensitive')
    assert.equal(s.widget.caseSensitive, true)
    await page.focus(FIELD('Pesquisar'))
    await page.keyboard.press('Alt+C')
    await waitDone(page, '7 resultados em 4 arquivos', 'Alt+C turns it off')
    await page.keyboard.press('Alt+W')
    s = await waitDone(page, '6 resultados em 4 arquivos', 'Alt+W: whole word leaves "needles" out')
    assert.equal(s.widget.wholeWord, true)
    await page.click(TOGGLE('Palavra inteira'))
    await waitDone(page, '7 resultados em 4 arquivos', 'click turns whole word off')
    await page.focus(FIELD('Pesquisar'))
    await page.keyboard.press('Alt+R')
    await setField(page, 'Pesquisar', 'need(le)s')
    s = await waitDone(page, '1 resultado em 1 arquivo', 'regex')
    assert.equal(s.widget.regex, true)
    await setField(page, 'Pesquisar', 'need(')
    await page.waitForFunction(() => /^Expressão regular inválida/.test(window.__tether.search()!.widget.searchMessage ?? ''))
    assert.equal(await page.locator(`${PAD_SEL} .srw-msg`).isVisible(), true, 'the regex message shows under the field')
    s = await snap(page)
    assert.equal(s.searching, false, 'an invalid regex never reaches the engine')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(300)
      await page.screenshot({ path: join(shots, `search-regex-error-${scheme}.png`) })
    }
    await setField(page, 'Pesquisar', 'need(le)')
    await waitDone(page, '7 resultados em 4 arquivos', 'a valid regex again: the message goes')
    assert.equal((await snap(page)).widget.searchMessage, undefined)
    await page.click(TOGGLE('Expressão regular'))
    await setField(page, 'Pesquisar', 'needle')
    await waitDone(page, '7 resultados em 4 arquivos', 'regex off')

    // ---- 3. details: include, exclude, the exclusions toggle ----
    await page.click(`${PAD_SEL} .srw-dots`)
    await page.waitForSelector(`${FIELD('arquivos a incluir')}`, { state: 'visible' })
    await setField(page, 'arquivos a incluir', '*.md')
    s = await waitDone(page, '4 resultados em 2 arquivos', 'include *.md')
    assert.deepEqual(files(s), ['a.md:3', 'docs/notes.md:1'])
    await setField(page, 'arquivos a incluir', '')
    await setField(page, 'arquivos a excluir', 'docs')
    s = await waitDone(page, '6 resultados em 3 arquivos', 'exclude docs')
    assert.ok(!files(s).some(f => f.startsWith('docs/')))
    await setField(page, 'arquivos a excluir', 'nothing-here')
    await setField(page, 'arquivos a incluir', 'nothing-here')
    s = await waitDone(page, /^Nenhum resultado encontrado em 'nothing-here' excluindo 'nothing-here'\./, 'no results: where it looked')
    await setField(page, 'arquivos a incluir', '')
    await setField(page, 'arquivos a excluir', '')
    await waitDone(page, '7 resultados em 4 arquivos', 'details emptied')
    await page.click(TOGGLE('Usar exclusões das configurações e arquivos ignore'))
    s = await waitDone(page, /^\d+ resultados em \d+ arquivos — exclusões das configurações e arquivos ignore desligados$/, 'exclusions off')
    const off = files(s)
    assert.ok(off.includes('ignored.txt:1'), `the .gitignore'd file comes in (${off})`)
    assert.ok(off.includes('node_modules/pkg/index.js:1'), `node_modules comes in (${off})`)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(300)
      await page.screenshot({ path: join(shots, `search-details-${scheme}.png`) })
    }
    await page.click(TOGGLE('Usar exclusões das configurações e arquivos ignore'))
    await waitDone(page, '7 resultados em 4 arquivos', 'exclusions on again')
    await page.click(`${PAD_SEL} .srw-dots`)
    await page.waitForSelector(`${FIELD('arquivos a incluir')}`, { state: 'hidden' })

    // ---- 4. open a match: the range is selected; Ctrl+click opens beside ----
    s = await snap(page)
    const acento = join(F, 'src', 'deep', 'acento.txt')
    const accentMatch = s.results.rows.find(r => r.kind === 'match' && r.before === 'ação é ')!
    await clickRow(page, accentMatch.id)
    await waitSelection(page, acento, { startLine: 1, startColumn: 8, endLine: 1, endColumn: 14 }, 'a click opens the file with the match selected (after the accents)')
    const a = join(F, 'a.md')
    const second = s.results.rows.find(r => r.kind === 'match' && r.before === 'Needle again, ')!
    await clickRow(page, second.id, { modifiers: ['Control'] })
    const aNote = await waitSelection(page, a, { startLine: 3, startColumn: 15, endLine: 3, endColumn: 21 }, 'Ctrl+click opens a.md with the match selected')
    const accentNote = (await noteOf(page, acento))!
    const groups = await page.evaluate(([x, y]) => [window.__tether.groupOf(x!), window.__tether.groupOf(y!)], [aNote.id, accentNote.id])
    assert.notEqual(groups[0], groups[1], 'Ctrl+click: beside, in another group')
    // The opened note takes the keyboard a frame later: let it land before the keyboard goes back to the tree.
    await page.waitForFunction(() => (document.activeElement as unknown as { closest?(s: string): unknown })?.closest?.('.monaco-editor') != null)

    // ---- 5. the keyboard in the tree; F4 / Shift+F4 ----
    s = await snap(page)
    const firstFile = s.results.rows[0]!
    assert.equal(firstFile.kind, 'file')
    // The keyboard lands on the row it was on (the last clicked one): start from the top.
    await page.locator(SCROLL).focus()
    await page.keyboard.press('Home')
    s = await snap(page)
    assert.equal(s.results.rows.find(r => r.focused)?.id, firstFile.id, 'Home: the first row')
    await page.keyboard.press('ArrowUp')
    assert.equal(await activeLabel(page), 'Pesquisar', '↑ on the first row goes back to the search field')
    await page.locator(SCROLL).focus()
    await page.keyboard.press('ArrowDown')
    s = await snap(page)
    const focusedIdx = s.results.rows.findIndex(r => r.focused)
    assert.equal(focusedIdx, 1, '↓ moves to the first match')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowLeft')
    s = await snap(page)
    assert.equal(s.results.rows[0]!.expanded, false, '← collapses the file')
    assert.equal(s.results.rows[1]!.kind, 'file', 'its matches went')
    await page.keyboard.press('ArrowRight')
    s = await snap(page)
    assert.equal(s.results.rows[0]!.expanded, true, '→ expands it')
    await page.keyboard.press('ArrowDown')
    const enterRow = (await snap(page)).results.rows[1]!
    await page.keyboard.press('Enter')
    await page.waitForFunction(p => window.__tether.notes().some(n => n.path.toLowerCase().endsWith(p)), firstFile.label.toLowerCase())
    await page.waitForFunction(() => (document.activeElement as unknown as { closest?(s: string): unknown })?.closest?.('.monaco-editor') != null)
    // Delete dismisses the focused match: counts and message follow.
    await page.locator(SCROLL).focus()
    s = await snap(page)
    assert.equal(s.results.rows.find(r => r.focused)?.id, enterRow.id)
    await page.keyboard.press('Delete')
    await waitDone(page, '6 resultados em 4 arquivos', 'Delete dismisses a match')
    // The tree follows the model at its redraw pace.
    await page.waitForFunction(id => !window.__tether.search()!.results.rows.some(r => r.id === id), enterRow.id)
    s = await snap(page)
    assert.equal(s.results.rows[0]!.count, (firstFile.count ?? 0) - 1, 'the file count follows')
    // F4 from the search field: the first match opens (the keyboard goes to the editor); F4 again, then Shift+F4.
    await page.focus(FIELD('Pesquisar'))
    const matches = s.results.rows.filter(r => r.kind === 'match')
    const fileOf = (id: string): string => { const i = s.results.rows.findIndex(r => r.id === id); for (let j = i; j >= 0; j--) if (s.results.rows[j]!.kind === 'file') return s.results.rows[j]!.label; return '' }
    const selectedId = async (): Promise<string | undefined> => (await snap(page)).results.rows.find(r => r.selected)?.id
    // F4 starts after the row the tree's keyboard is on (the one after the dismissed match) and wraps.
    const focusedNow = s.results.rows.findIndex(r => r.focused)
    const expectAt = (from: number): Row => { for (let k = 1; k <= s.results.rows.length; k++) { const r = s.results.rows[(from + k) % s.results.rows.length]!; if (r.kind === 'match') return r } return matches[0]! }
    const m1 = expectAt(focusedNow)
    const m2 = expectAt(s.results.rows.findIndex(r => r.id === m1.id))
    await page.keyboard.press('F4')
    await page.waitForFunction(id => window.__tether.search()!.results.rows.find(r => r.selected)?.id === id, m1.id)
    const noteWithFocus = async (): Promise<string | undefined> => page.evaluate(() => (document.activeElement as unknown as { closest?(s: string): El | null })?.closest?.('.monaco-editor') ? 'editor' : document.activeElement?.getAttribute('aria-label') ?? 'other')
    await page.waitForFunction(n => window.__tether.notes().some(x => x.path.toLowerCase().endsWith(n)), fileOf(m1.id).toLowerCase())
    await page.waitForFunction(() => (document.activeElement as unknown as { closest?(s: string): unknown })?.closest?.('.monaco-editor') != null)
    assert.equal(await noteWithFocus(), 'editor', 'F4 opens the match and the keyboard goes to the editor')
    await page.keyboard.press('F4')
    await page.waitForFunction(id => window.__tether.search()!.results.rows.find(r => r.selected)?.id === id, m2.id)
    await page.keyboard.press('Shift+F4')
    await page.waitForFunction(id => window.__tether.search()!.results.rows.find(r => r.selected)?.id === id, m1.id)
    assert.equal(await selectedId(), m1.id, 'Shift+F4 goes back')

    // ---- 6. collapse all / expand all; tree / list ----
    await page.click(`${PAD_SEL} .srch-collapse`)
    s = await snap(page)
    assert.ok(s.results.rows.every(r => r.kind === 'file' && r.expanded === false), 'Recolher tudo: only collapsed files')
    assert.equal(await page.getAttribute(`${PAD_SEL} .srch-collapse`, 'aria-label'), 'Expandir tudo')
    await page.click(`${PAD_SEL} .srch-collapse`)
    s = await snap(page)
    assert.ok(s.results.rows.some(r => r.kind === 'match'), 'Expandir tudo brings the matches back')
    assert.equal(await page.getAttribute(`${PAD_SEL} .srch-collapse`, 'aria-label'), 'Recolher tudo')
    await page.click(`${PAD_SEL} .srch-view`)
    s = await snap(page)
    assert.equal(s.viewMode, 'tree')
    const folders = s.results.rows.filter(r => r.kind === 'folder').map(r => `${r.level}:${r.label}`)
    assert.deepEqual(folders, ['1:docs', '1:src', '2:deep'], `the tree shows the intermediate folders (${folders})`)
    assert.equal(await page.getAttribute(`${PAD_SEL} .srch-view`, 'aria-label'), 'Ver como lista')
    await page.click(`${PAD_SEL} .srch-view`)
    assert.equal((await snap(page)).viewMode, 'list')

    // ---- 7. the replace preview, then with a regex and $1 ----
    await page.click(`${PAD_SEL} .srw-arrow`)
    await page.waitForSelector(FIELD('Substituir'), { state: 'visible' })
    await setField(page, 'Substituir', 'pin')
    await page.waitForFunction(() => window.__tether.search()!.results.rows.some(r => r.kind === 'match' && r.replacement === 'pin'))
    s = await snap(page)
    assert.equal(s.widget.replaceAllEnabled, true, 'Substituir tudo is enabled with results and the field open')
    const drawn = await page.evaluate(sc => { const r = document.querySelector(`${sc} .sr-row.sr-match .sr-hit-replaced`); return r ? { hit: r.textContent, rep: document.querySelector(`${sc} .sr-row.sr-match .sr-rep`)?.textContent } : undefined }, SCROLL)
    assert.deepEqual(drawn && { rep: drawn.rep }, { rep: 'pin' }, 'the row shows the replacement')
    assert.match(drawn!.hit ?? '', /^needle$/i, 'and the found text struck out')
    await page.focus(FIELD('Pesquisar'))
    await page.keyboard.press('Alt+R')
    await setField(page, 'Pesquisar', 'ne(e)dle')
    await waitDone(page, '7 resultados em 4 arquivos', 'regex with a group')
    await setField(page, 'Substituir', 'X$1')
    await page.waitForFunction(() => window.__tether.search()!.results.rows.some(r => r.kind === 'match' && r.inside === 'needle' && r.replacement === 'Xe'))
    await setField(page, 'Pesquisar', 'needle')
    await setField(page, 'Substituir', 'pin')
    await page.focus(FIELD('Pesquisar'))
    await page.keyboard.press('Alt+R')
    await waitDone(page, '7 resultados em 4 arquivos', 'regex off for the screenshots')
    await page.waitForFunction(() => window.__tether.search()!.results.rows.some(r => r.replacement === 'pin'))
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(300)
      await page.screenshot({ path: join(shots, `search-results-replace-${scheme}.png`) })
    }
    await page.click(`${PAD_SEL} .srw-arrow`)
    await page.waitForSelector(FIELD('Substituir'), { state: 'hidden' })

    // ---- 8. past the limit: the warning, few rows in the DOM, no freeze ----
    await page.evaluate(() => {
      window.__hb = { max: 0, last: performance.now() }
      window.setInterval(() => { const n = performance.now(); window.__hb.max = Math.max(window.__hb.max, n - window.__hb.last); window.__hb.last = n }, 20)
    })
    const t0 = Date.now()
    await setField(page, 'Pesquisar', 'zebra')
    // Every match the engine kept arrives, even the batches that land after the search's reply.
    // (Polled with the cheap status: the full snapshot draws every row's text and would itself hold the window.)
    await page.waitForFunction(() => { const x = window.__tether.searchStatus()!; return !x.searching && x.count === 20_000 }, undefined, { timeout: 60_000, polling: 100 })
    const took = Date.now() - t0
    await sleep(300) // the tree's last redraw
    const gap = await page.evaluate(() => window.__hb.max)
    const domRows = await page.evaluate(sc => document.querySelector(sc)!.querySelectorAll('.sr-row').length, SCROLL)
    s = await waitDone(page, '20.000 resultados em 100 arquivos', 'the big search ends at the limit')
    console.log(`big search: ${took} ms until all 20000 matches are in (reply after ${s.lastSearchMs} ms), ${s.count} matches in ${s.fileCount} files, ${s.results.rows.length} rows in the tree, ${domRows} in the DOM, longest timer gap ${Math.round(gap)} ms`)
    assert.equal(s.count, 20_000)
    assert.ok(s.message.includes('O conjunto de resultados contém só uma parte das correspondências. Refine a pesquisa para restringir os resultados.'), `the partial-results warning (${s.message})`)
    assert.ok(domRows < 200, `few rows in the DOM (${domRows})`)
    assert.ok(gap < 1_500, `the window stayed responsive (longest gap ${Math.round(gap)} ms)`)

    // ---- 9. cancel a big search: the button, then Esc ----
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { search: { maxResults: 200_000 } } }))
    await sleep(1_500) // settings.json is read again on change
    for (const how of ['button', 'Escape'] as const) {
      await page.focus(FIELD('Pesquisar'))
      await setField(page, 'Pesquisar', how === 'button' ? 'okapi' : 'okap')
      // The person cancels as soon as the first batch is in. Done in the page: a round trip to the test would land after the
      // end (the engine takes ~1 s for this one). Esc is a keydown on the focused field, as the keyboard sends it.
      const at = await page.evaluate(([way, button, field]) => new Promise<number>(resolve => {
        const tick = (): void => {
          const x = window.__tether.searchStatus()!
          if (!(x.searching && x.count > 0)) { setTimeout(tick, 0); return }
          if (way === 'button') (document.querySelector(button!) as unknown as { click(): void }).click()
          else (document.querySelector(field!) as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
          resolve(x.count)
        }
        tick()
      }), [how, `${PAD_SEL} .srch-cancel`, FIELD('Pesquisar')])
      await page.waitForFunction(() => { const x = window.__tether.searchStatus()!; return !x.searching && x.message.includes('Pesquisa cancelada.') }, undefined, { timeout: 20_000, polling: 100 })
      await sleep(500) // batches already on their way when it was cancelled still land
      s = await snap(page)
      console.log(`cancel by ${how}: cancelled with ${at} matches in, ${s.count} kept of 640000`)
      assert.ok(s.count > 0 && s.count < 640_000, `what arrived stays (${s.count})`)
      assert.ok(s.message.includes('Pesquisa cancelada.'), `the message says so (${s.message})`)
      assert.equal(await page.isVisible(`${PAD_SEL} .srch-cancel`), false, 'the cancel button hides')
    }

    // ---- 10. clear; the state survives a relaunch ----
    await setField(page, 'Pesquisar', 'needle')
    await waitDone(page, '7 resultados em 4 arquivos', 'needle again')
    await page.click(`${PAD_SEL} .srch-clear`)
    s = await snap(page)
    assert.equal(s.widget.search, '')
    assert.equal(s.widget.replace, '')
    assert.equal(s.results.rows.length, 0)
    assert.deepEqual(s.message, [])
    assert.equal(await activeLabel(page), 'Pesquisar', 'clear puts the keyboard in the search field')
    await page.focus(FIELD('Pesquisar'))
    await page.keyboard.type('needle')
    await waitDone(page, '7 resultados em 4 arquivos', 'search before the relaunch')
    await page.click(TOGGLE('Palavra inteira'))
    await waitDone(page, '6 resultados em 4 arquivos', 'whole word before the relaunch')
    await page.click(`${PAD_SEL} .srw-dots`)
    await page.click(`${PAD_SEL} .srch-view`)
    const before = (await snap(page)).widget
    await sleep(2_500) // the history delayer and layout.json
    await killElectron(app, root)
    app = undefined
    await sleep(2_000)
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.search() !== undefined, undefined, { timeout: 15_000 })
    s = await snap(page)
    assert.equal(s.widget.search, 'needle')
    assert.equal(s.widget.wholeWord, true)
    assert.equal(s.widget.detailsShown, true)
    assert.equal(s.widget.replace, before.replace)
    assert.equal(s.viewMode, 'tree')
    assert.equal(s.searching, false, 'restoring does not search by itself')
    assert.equal(s.results.rows.length, 0)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    // ripgrep and the editors may hold files a moment after the window goes.
    for (let i = 0; i < 20; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(500) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
