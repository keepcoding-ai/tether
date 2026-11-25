// E2E of the search editor: the pad's results as a `.code-search` document in the note editor. Hidden window on a
// private home/pipe (the home is the person's configuration folder, so the documents land in <home>/search-editors), real
// tetherd, no agent; fixture projects in the temporary home, pinned as the window's projects.
//   1. "Abrir novo editor de pesquisa": a tab with a .code-search file in <home>/search-editors; the header (term, flags),
//      the count in Portuguese, the files and numbered lines; the language is search-result; the matches are decorated;
//   2. Ctrl+click on a result line opens its file at that line (and column); on a file line, the file; F12 on a result
//      line does the same; with two projects the label <name>/rel opens that project's file;
//   3. the header edited (term, # ContextLines: 1, CaseSensitive) and Ctrl+Shift+R: the body rewritten with the new
//      results and the context lines, one undo step back; the decorations follow;
//   4. # Including: and # Excluding: restrict as the pad's fields do;
//   5. an invalid regex: a warning, the text untouched;
//   6. the pad's search does not find the document (it lies outside the projects);
//   7. relaunch: the tab comes back with its text and no decorations; "pesquisar de novo" works there. (No CodeLens: the app's Monaco has no CodeLens contribution.)
// The pad's live search is not cancelled by the editor's: proved in test/unit/ext.search.service.test.ts (two services).
// Screenshots (light and dark) of the document with results and context go to <atrium>/.tmp/search (search-editor-*.png).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
type Doc = { path: string; language: string; text: string; matches: Range[]; canUndo: boolean }
type Snap = { message: string[]; searching: boolean; replacing: boolean; count: number; results: { rows: { kind: string; label: string }[] } }
type Note = { id: string; path: string; text: string; focused: boolean; cursor?: { lineNumber: number; column: number } }
type Hooks = {
  connection(): { pid?: number } | undefined
  search(): Snap | undefined
  searchEditors(): Doc[]
  searchEditorLinks(path: string): { range: Range; line: number }[]
  searchEditorPoint(path: string, line: number, column: number): { x: number; y: number } | undefined
  notes(): Note[]
  openFolder(path: string): void
  openNote(path: string): Promise<void>
  runCommand(id: string): Promise<string>
}
declare const window: { __tether: Hooks }
declare const document: { documentElement: { dataset: Record<string, string> }; activeElement: { closest?(s: string): unknown } | null; querySelector(s: string): { click(): void } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sed-${process.pid}`
const atriumTmp = /^(.*?[\\/]\.tmp)(?=[\\/])/.exec(root)?.[1] ?? resolve(root, '..', '..', '.tmp')
const tmpBase = tmpdir() // the test home must live in the OS temp folder: guardAppEnv refuses any other
const shots = join(atriumTmp, 'search')
const PAD_SEL = '.pad[data-pad="search.view"]'
const FIELD = (label: string): string => `${PAD_SEL} .srw-field[aria-label="${label}"]`
const TOGGLE = (label: string): string => `${PAD_SEL} .srw-t[aria-label="${label}"]`
const WARNING = 'dialog.ask[data-dialog="search-editor-warning"][open]'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
const read = (p: string): string => readFileSync(p, 'utf8').replaceAll('\r\n', '\n')

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  delete env.TETHER_USER_DIR
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

async function until<T>(what: string, fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  let v: T | undefined
  while (Date.now() < deadline) { v = await fn(); if (ok(v)) return v; await sleep(80) }
  assert.fail(`timed out: ${what} (last: ${JSON.stringify(v)})`)
}

const snap = async (page: Page): Promise<Snap> => (await page.evaluate(() => window.__tether.search()))!
const docs = (page: Page): Promise<Doc[]> => page.evaluate(() => window.__tether.searchEditors())
const docOf = async (page: Page, path: string): Promise<Doc | undefined> => (await docs(page)).find(d => same(d.path, path))
const noteOf = async (page: Page, path: string): Promise<Note | undefined> => (await page.evaluate(() => window.__tether.notes())).find(n => same(n.path, path))

async function search(page: Page, term: string, first: string): Promise<Snap> {
  await page.fill(FIELD('Pesquisar'), term)
  return until(`search ${term}`, () => snap(page), s => !s.searching && s.message[0] === first)
}

/** The text a decoration covers. */
const covered = (text: string, r: Range): string => (text.split('\n')[r.startLineNumber - 1] ?? '').slice(r.startColumn - 1, r.endColumn - 1)

/** Puts the keyboard in the document's editor (its tab brought forward). */
async function focusDoc(page: Page, path: string): Promise<void> {
  await page.evaluate(p => window.__tether.openNote(p), path)
  await until('the document has the keyboard', async () => (await noteOf(page, path))?.focused === true && await page.evaluate(() => document.activeElement?.closest?.('.monaco-editor') != null), v => v)
}

/** Replaces the document's text with typing (Ctrl+A, then the keys), as a person edits the header. */
async function typeDoc(page: Page, path: string, text: string): Promise<void> {
  await focusDoc(page, path)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await until('the typed text', () => docOf(page, path), d => d?.text === text)
}

/** A real Ctrl+click on the document at a position. */
async function ctrlClick(page: Page, path: string, line: number, column: number): Promise<void> {
  // The links are computed a moment after the text changes (Monaco's link detector waits for the edits to settle).
  await sleep(1_500)
  const pt = await until('the position is on screen', () => page.evaluate(([p, l, c]) => window.__tether.searchEditorPoint(p as string, l as number, c as number), [path, line, column]), v => v !== undefined)
  await page.mouse.move(pt!.x, pt!.y)
  await page.keyboard.down('Control')
  await sleep(150)
  await page.mouse.click(pt!.x, pt!.y)
  await page.keyboard.up('Control')
}

test('search: the search editor (.code-search in the note editor: links, F12, pesquisar de novo, restored)', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-sed-'))
  const A = join(home, 'proj', 'alpha')
  const B = join(home, 'proj', 'beta')
  mkdirSync(join(A, 'sub'), { recursive: true })
  mkdirSync(B, { recursive: true })
  writeFileSync(join(A, 'a.ts'), 'line one\nconst needleq = 1\nline three\n')
  writeFileSync(join(A, 'sub', 'b.txt'), 'x needleq and needleqs\nNEEDLEQ upper\n')
  writeFileSync(join(A, 'z.txt'), 'before zeta\nZetaq here\nzetaq lower\nafter\n')
  writeFileSync(join(A, 'same.txt'), 'alpha needleq\n')
  writeFileSync(join(B, 'same.txt'), 'pad\npad\nbeta needleq\n')
  const editorsDir = join(home, 'search-editors')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(f => window.__tether.openFolder(f), A)
    await page.keyboard.press('Control+Shift+F')
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)
    assert.equal(await page.locator(`${PAD_SEL} .srch-editor`).isDisabled(), true, 'disabled with no term')

    // ---- 1. open the results as a document ----
    await page.click(TOGGLE('Palavra inteira'))
    await search(page, 'needleq', '4 resultados em 3 arquivos')
    assert.equal(await page.locator(`${PAD_SEL} .srch-editor`).isDisabled(), false)
    await page.click(`${PAD_SEL} .srch-editor`)
    let doc = await until('the document opened and decorated', () => docs(page), d => d.length === 1 && d[0]!.matches.length > 0)
    let d = doc[0]!
    const P = d.path
    assert.ok(same(join(P, '..'), editorsDir), `in <home>/search-editors: ${P}`)
    assert.match(P.split(/[\\/]/).pop()!, /^Pesquisa-\d{8}-\d{6}\.code-search$/)
    assert.ok(await noteOf(page, P), 'a note tab shows it')
    assert.equal(d.language, 'search-result')
    assert.equal(d.text, [
      '# Query: needleq', '# Flags: WordMatch', '', '4 resultados - 3 arquivos', '',
      'a.ts:', '  2: const needleq = 1', '',
      'same.txt:', '  1: alpha needleq', '',
      'sub/b.txt:', '  1: x needleq and needleqs', '  2: NEEDLEQ upper', '',
    ].join('\n'))
    assert.equal(read(P), d.text, 'the file on disk is the document')
    assert.equal(d.matches.length, 4, 'one decoration per match')
    assert.deepEqual(d.matches.map(r => covered(d.text, r).toLowerCase()), ['needleq', 'needleq', 'needleq', 'needleq'])
    assert.equal(await page.locator('.monaco-editor .srch-ed-match').count() > 0, true, 'the decoration is drawn')

    // ---- 2. Ctrl+click and F12 ----
    const links = await page.evaluate(p => window.__tether.searchEditorLinks(p), P)
    assert.ok(links.some(l => l.line === 6 && l.range.startColumn === 1 && l.range.endColumn === 5), `a link on the label "a.ts": ${JSON.stringify(links)}`)
    assert.ok(links.some(l => l.line === 13), 'a link on a result line')
    // A result line: the file at the match.
    await ctrlClick(page, P, 13, 10)
    // A new note starts at 1:1: the reveal comes once its text is in.
    let n = await until('Ctrl+click opened sub/b.txt at line 1, column 3 (the first match)', () => noteOf(page, join(A, 'sub', 'b.txt')), x => x?.cursor?.lineNumber === 1 && x.cursor.column === 3)
    // A file line: the file.
    await focusDoc(page, P)
    await ctrlClick(page, P, 6, 2)
    await until('Ctrl+click on the file line opened a.ts', () => noteOf(page, join(A, 'a.ts')), x => x !== undefined)
    // F12 on a result line.
    await focusDoc(page, P)
    const pt = (await page.evaluate(([p]) => window.__tether.searchEditorPoint(p!, 14, 8), [P]))!
    await page.mouse.click(pt.x, pt.y)
    await page.keyboard.press('F12')
    n = await until('F12 moved sub/b.txt to line 2', () => noteOf(page, join(A, 'sub', 'b.txt')), x => x?.cursor?.lineNumber === 2 && x.focused)
    assert.equal(n!.cursor!.column, 1, 'the first match of that line')

    // Two projects: the labels carry the project name, and beta/same.txt opens beta's file.
    await page.evaluate(f => window.__tether.openFolder(f), B)
    await typeDoc(page, P, '# Query: needleq\n# Including: same.txt\n')
    await page.keyboard.press('Control+Shift+R')
    d = (await until('rerun with two projects', () => docOf(page, P), x => !!x && x.text.includes('beta/same.txt:')))!
    assert.equal(d.text, [
      '# Query: needleq', '# Including: same.txt', '', '2 resultados - 2 arquivos', '',
      'alpha/same.txt:', '  1: alpha needleq', '',
      'beta/same.txt:', '  3: beta needleq', '',
    ].join('\n'))
    await ctrlClick(page, P, 10, 6)
    await until("Ctrl+click opened beta's same.txt at line 3", () => noteOf(page, join(B, 'same.txt')), x => x?.cursor?.lineNumber === 3)
    assert.equal(await noteOf(page, join(A, 'same.txt')), undefined, "alpha's same.txt stays closed")

    // ---- 3. the header edited, Ctrl+Shift+R: results with context, one undo step ----
    const edited = '# Query: Zetaq\n# Flags: CaseSensitive\n# ContextLines: 1\n# Including: z.txt\n'
    await typeDoc(page, P, edited)
    await page.keyboard.press('Control+Shift+R')
    d = (await until('rerun with context', () => docOf(page, P), x => !!x && x.text.startsWith('# Query: Zetaq') && x.text.includes('resultado')))!
    const contextDoc = [
      '# Query: Zetaq', '# Flags: CaseSensitive', '# Including: z.txt', '# ContextLines: 1', '', '1 resultado - 1 arquivo', '',
      'alpha/z.txt:', '  1  before zeta', '  2: Zetaq here', '  3  zetaq lower', '',
    ].join('\n')
    assert.equal(d.text, contextDoc)
    assert.equal(d.matches.length, 1)
    assert.equal(covered(d.text, d.matches[0]!), 'Zetaq')
    assert.equal((await noteOf(page, P))!.cursor!.lineNumber, 1, 'the cursor on the # Query: line')
    await until('the document is written', () => read(P), t => t === contextDoc)
    // Screenshots of the document with results and context.
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(500)
      await page.screenshot({ path: join(shots, `search-editor-${scheme}.png`) })
    }
    await focusDoc(page, P)
    await page.keyboard.press('Control+Z')
    await until('one Ctrl+Z gives back the whole text before the search', () => docOf(page, P), x => x?.text === edited)
    await page.keyboard.press('Control+Y')
    await until('Ctrl+Y redoes it', () => docOf(page, P), x => x?.text === contextDoc)

    // ---- 4. # Including: / # Excluding: ----
    await typeDoc(page, P, '# Query: needleq\n# Including: *.ts\n')
    await page.keyboard.press('Control+Shift+R')
    d = (await until('including *.ts', () => docOf(page, P), x => !!x && x.text.includes('resultado')))!
    assert.ok(d.text.includes('alpha/a.ts:') && !d.text.includes('same.txt') && !d.text.includes('b.txt'), d.text)
    await typeDoc(page, P, '# Query: needleq\n# Excluding: *.ts, same.txt\n')
    await page.keyboard.press('Control+Shift+R')
    d = (await until('excluding *.ts and same.txt', () => docOf(page, P), x => !!x && x.text.includes('resultado')))!
    assert.equal(d.text, '# Query: needleq\n# Excluding: *.ts, same.txt\n\n3 resultados - 1 arquivo\n\nalpha/sub/b.txt:\n  1: x needleq and needleqs\n  2: NEEDLEQ upper\n')
    assert.equal(d.matches.length, 3)

    // ---- 5. an invalid regex: a warning, the text untouched ----
    const bad = '# Query: (unclosed\n# Flags: RegExp\n'
    await typeDoc(page, P, bad)
    await page.keyboard.press('Control+Shift+R')
    await page.waitForSelector(WARNING)
    const warning = await page.locator(WARNING).innerText()
    assert.match(warning, /Expressão regular inválida/, warning)
    await page.locator(`${WARNING} button.choice[data-choice="ok"]`).click()
    await sleep(300)
    assert.equal((await docOf(page, P))!.text, bad, 'the text is as it was')
    assert.equal((await docOf(page, P))!.matches.length, 0)

    // ---- 6. the pad does not find the document ----
    await page.keyboard.press('Control+Shift+F')
    await page.fill(FIELD('Pesquisar'), 'Query')
    const s = await until('the pad searched Query', () => snap(page), x => !x.searching && (x.message[0] ?? '').startsWith('Nenhum resultado encontrado'))
    assert.equal(s.count, 0, JSON.stringify([s.message, s.results.rows.map(r => r.kind + ':' + r.label)]))
    assert.ok(!s.results.rows.some(r => r.label.endsWith('.code-search')), `no .code-search in the results: ${JSON.stringify(s.results.rows)}`)

    // ---- 7. relaunch: the tab is back with its text, no decorations; Ctrl+Shift+R searches again ----
    await typeDoc(page, P, '# Query: needleq\n# Including: a.ts\n')
    await until('the document is written', () => read(P), t => t === '# Query: needleq\n# Including: a.ts\n')
    await sleep(1_500) // layout.json
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.evaluate(f => window.__tether.openFolder(f), A)
    d = (await until('the document is back', () => docOf(page, P), x => !!x && x.text.startsWith('# Query: needleq')))!
    assert.equal(d.language, 'search-result')
    assert.equal(d.matches.length, 0, 'no decorations from disk')
    await focusDoc(page, P)
    assert.ok(await noteOf(page, P), 'its tab is back')
    await page.keyboard.press('Control+Shift+R')
    d = (await until('searched again after the relaunch', () => docOf(page, P), x => !!x && x.matches.length > 0))!
    assert.ok(d.text.includes('a.ts:') && d.text.includes('  2: const needleq = 1'), d.text)
    assert.ok(readdirSync(editorsDir).length >= 1)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const dm of daemons) await killOwned(dm, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(dm => pidAlive(dm.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 20; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(500) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
