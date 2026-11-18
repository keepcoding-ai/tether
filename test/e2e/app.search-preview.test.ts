// E2E of the search pad's replace preview. Hidden window on a private home/pipe, real tetherd, no agent; a fixture project
// in a temporary folder, pinned as the window's project.
//   1. the replace field open, a click on a match: ONE preview pane titled "<name> ↔ <name> (prévia da substituição)",
//      left = the file's text, right = every match of the file replaced, the match's line in view; the keyboard stays in
//      the tree; ↓ + Enter on another match of the same file reuses the pane; a far line is brought into view; a match of
//      another file changes the content of the same pane;
//   2. a new replace text rebuilds the right side; regex with $1 and "preserve case" show on the right side;
//   3. a file open in an editor with text newer than the disk: the left side is the editor's text;
//   4. Ctrl+click opens the file itself (beside), not the preview; useReplacePreview off opens the file; the replace field
//      closed closes the preview, and a click then opens the file;
//   5. "replace all in this file" on the preview's file closes it; clearing the results closes it;
//   6. closing the tab leaves no preview model in Monaco;
//   7. a file that cannot be read (deleted after the search): the pane shows the message;
//   8. relaunch with a preview in layout.json: it does not come back (not even empty).
// Screenshots (light and dark) of the pad with the preview beside it go to <atrium>/.tmp/search (search-preview-*.png).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { kind: 'folder' | 'file' | 'match'; id: string; level: number; label: string; count?: number; expanded?: boolean; before?: string; inside?: string; after?: string; focused: boolean }
type Snap = {
  widget: { search: string; replace: string; replaceShown: boolean; replaceAllEnabled: boolean }
  message: string[]; searching: boolean; replacing: boolean; viewMode: 'list' | 'tree'; count: number; fileCount: number
  results: { rows: Row[] }
}
type Preview = {
  panes: string[]; id?: string; title?: string; tooltip?: string; path?: string; error?: string; original?: string; modified?: string
  language?: string; line?: number; modifiedLine?: number; visible?: { original: [number, number]; modified: [number, number] }; sideBySide?: boolean
}
type Note = { id: string; path: string; text: string; savedText: string; dirty: boolean; focused: boolean }
type Hooks = {
  connection(): { pid?: number } | undefined
  search(): Snap | undefined
  searchPreview(): Preview
  monacoModels(): string[]
  notes(): Note[]
  openFolder(path: string): void
  openNote(path: string): Promise<void>
  runCommand(id: string): Promise<string>
}
type El = { click(): void; getAttribute(n: string): string | null; closest?(s: string): unknown }
declare const window: { __tether: Hooks }
declare const CSS: { escape(s: string): string }
declare const document: { documentElement: { dataset: Record<string, string> }; activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sprev-${process.pid}`
const atriumTmp = /^(.*?[\\/]\.tmp)(?=[\\/])/.exec(root)?.[1] ?? resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'search')
const PAD_SEL = '.pad[data-pad="search.view"]'
const SCROLL = `${PAD_SEL} .sr-scroll`
const FIELD = (label: string): string => `${PAD_SEL} .srw-field[aria-label="${label}"]`
const TOGGLE = (label: string): string => `${PAD_SEL} .srw-t[aria-label="${label}"]`
const PREVIEW_SCHEME = 'search-preview:'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
const read = (p: string): string => readFileSync(p, 'utf8')

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
const preview = (page: Page): Promise<Preview> => page.evaluate(() => window.__tether.searchPreview())
const previewModels = async (page: Page): Promise<string[]> => (await page.evaluate(() => window.__tether.monacoModels())).filter(u => u.startsWith('search-preview:'))

async function waitDone(page: Page, first: string | RegExp, what: string, timeout = 10_000): Promise<Snap> {
  const deadline = Date.now() + timeout
  let s: Snap | undefined
  while (Date.now() < deadline) {
    s = await snap(page)
    const line = s.message[0] ?? ''
    if (!s.searching && !s.replacing && (typeof first === 'string' ? line === first : first.test(line))) return s
    await sleep(60)
  }
  assert.fail(`${what}: message ${JSON.stringify(s?.message)}, searching ${s?.searching}, replacing ${s?.replacing}`)
}

async function until<T>(what: string, fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms
  let v: T | undefined
  while (Date.now() < deadline) { v = await fn(); if (ok(v)) return v; await sleep(80) }
  assert.fail(`timed out: ${what} (last: ${JSON.stringify(v)})`)
}

/** The tree has redrawn: the rows match the model's counts, and every expanded file shows as many match rows as it counts. */
async function settled(page: Page): Promise<Snap> {
  await page.waitForFunction(() => {
    const s = window.__tether.search()!
    const rows = s.results.rows
    if (rows.filter(r => r.kind === 'file').reduce((n, r) => n + (r.count ?? 0), 0) !== s.count || (s.count === 0 && rows.length > 0)) return false
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      if (r.kind !== 'file' || r.expanded === false) continue
      let n = 0
      while (rows[i + 1 + n]?.kind === 'match') n++
      if (n !== r.count) return false
    }
    return true
  })
  return snap(page)
}

async function search(page: Page, term: string, first: string): Promise<Snap> {
  await page.fill(FIELD('Pesquisar'), term)
  await waitDone(page, first, `search ${term}`)
  return settled(page)
}

const rowOf = (s: Snap, pred: (r: Row) => boolean): Row => {
  const r = s.results.rows.find(pred)
  assert.ok(r, `row in ${JSON.stringify(s.results.rows.map(x => `${x.kind}:${x.label}|${x.before ?? ''}[${x.inside ?? ''}]${x.after ?? ''}`))}`)
  return r
}
const rowSel = (id: string): string => `${SCROLL} .sr-row[data-id="${id.replace(/["\\]/g, '\\$&')}"]`

/** Clicks a row on its text (not on its action buttons). */
async function clickRow(page: Page, id: string, modifiers?: ('Control')[]): Promise<void> {
  await page.click(rowSel(id), { position: { x: 60, y: 10 }, ...(modifiers ? { modifiers } : {}) })
}

async function clickAct(page: Page, id: string, act: string): Promise<void> {
  const ok = await page.evaluate(([sc, rid, a]) => {
    const b = document.querySelector(`${sc} .sr-row[data-id="${CSS.escape(rid!)}"] .sr-act[data-act="${a}"]`)
    if (!b) return false
    b.click()
    return true
  }, [SCROLL, id, act])
  assert.ok(ok, `the ${act} button of ${id} is drawn`)
}

const treeHasKeyboard = (page: Page): Promise<boolean> => page.evaluate(sc => document.activeElement === document.querySelector(sc), SCROLL)
const noteOf = async (page: Page, path: string): Promise<Note | undefined> =>
  (await page.evaluate(() => window.__tether.notes())).find(n => same(n.path, path))
const editorHasKeyboard = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest?.('.monaco-editor') != null)

/** Waits for the preview to show `path` built (diff or message), the pane alone of its type. */
async function previewOf(page: Page, path: string, what: string, ok: (p: Preview) => boolean = () => true): Promise<Preview> {
  return until(what, () => preview(page), p => p.panes.length === 1 && p.id === p.panes[0] && p.path !== undefined && same(p.path, path) &&
    (p.modified !== undefined || p.error !== undefined) && ok(p))
}

const inView = (range: [number, number] | undefined, line: number): boolean => !!range && range[0] <= line && line <= range[1]

test('search: the replace preview (diff beside the pad, reused, follows the replace term, closes with its file)', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-sprev-'))
  const F = join(home, 'proj', 'fixture')
  const P = (...p: string[]): string => join(F, ...p)
  mkdirSync(F, { recursive: true })
  const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i + 4}`).join('\n')
  const aText = `const FOOQ = 1\nline two\nlet x = FOOQ + FOOQ\n${filler}\nFOOQ far below\n`
  const aLines = aText.split('\n').length - 1
  writeFileSync(P('a.ts'), aText)
  writeFileSync(P('b.txt'), 'other FOOQ\n')
  writeFileSync(P('rx.txt'), 'PCQ1 and PCQ2\n')
  writeFileSync(P('pc.txt'), 'Quuxq QUUXQ quuxq\n')
  writeFileSync(P('ed.txt'), 'EDQ disk\n')
  writeFileSync(P('gone.txt'), 'GONEQ GONEQ\n')
  writeFileSync(P('cl0.txt'), 'CLQ zero\n')
  writeFileSync(P('cl1.txt'), 'CLQ one\n')
  writeFileSync(P('cl2.txt'), 'CLQ two\n')
  writeFileSync(P('cl3.txt'), 'CLQ three\n')
  const readOnly = [P('ed.txt')]
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(f => window.__tether.openFolder(f), F)
    await page.keyboard.press('Control+Shift+F')
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)
    // A save that fails on a read-only file (section 3) leaves the note's temp file (<name>.<pid>.tmp) next to it: kept out.
    await page.evaluate(() => window.__tether.runCommand('search.toggle-details'))
    await page.waitForSelector(FIELD('arquivos a excluir'), { state: 'visible' })
    await page.fill(FIELD('arquivos a excluir'), '*.tmp')
    await page.evaluate(() => window.__tether.runCommand('search.toggle-replace'))
    await page.waitForSelector(FIELD('Substituir'), { state: 'visible' })
    await page.fill(FIELD('Substituir'), 'BARQ')

    // ---- 1. a click on a match: one preview, both sides, the line in view, the keyboard in the tree ----
    let s = await search(page, 'FOOQ', '5 resultados em 2 arquivos')
    const aMatches = s.results.rows.filter(r => r.kind === 'match' && (r.before ?? '').startsWith('const'))
    assert.equal(aMatches.length, 1)
    await clickRow(page, aMatches[0]!.id)
    let p = await previewOf(page, P('a.ts'), 'the preview of a.ts')
    assert.equal(p.title, 'a.ts ↔ a.ts (prévia da substituição)')
    assert.ok(p.tooltip?.includes(P('a.ts')), `the tooltip names the path: ${p.tooltip}`)
    assert.equal(p.original, aText, 'left: the file as it is')
    assert.equal(p.modified, aText.replaceAll('FOOQ', 'BARQ'), 'right: every match of the file replaced')
    assert.equal(p.language, 'typescript')
    assert.equal(p.line, 1)
    assert.ok(inView(p.visible?.modified, 1), `line 1 in view: ${JSON.stringify(p.visible)}`)
    assert.equal(await page.locator('.srp-tab').count(), 1, 'one tab of the preview')
    assert.ok(await treeHasKeyboard(page), 'the keyboard stays in the results tree')
    assert.equal(await noteOf(page, P('a.ts')), undefined, 'the file itself is not opened')
    const id = p.id
    // ↓ + Enter: the next match of the same file, same pane.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    p = await previewOf(page, P('a.ts'), 'the preview follows ↓ + Enter', x => x.line === 3)
    assert.equal(p.id, id, 'the same pane is reused')
    assert.ok(await treeHasKeyboard(page), 'the keyboard still in the tree')
    // A far line is brought into view.
    s = await snap(page)
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.after === ' far below').id)
    p = await previewOf(page, P('a.ts'), 'the far match', x => x.line === aLines)
    assert.ok(inView(p.visible?.modified, aLines) && inView(p.visible?.original, aLines), `line ${aLines} in view on both sides: ${JSON.stringify(p.visible)}`)
    // Another file: the same pane shows it.
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.before === 'other ').id)
    p = await previewOf(page, P('b.txt'), 'the preview of b.txt')
    assert.equal(p.id, id, 'still one pane')
    assert.equal(p.title, 'b.txt ↔ b.txt (prévia da substituição)')
    assert.equal(p.original, 'other FOOQ\n')
    assert.equal(p.modified, 'other BARQ\n')

    // ---- 2. the replace term: a new text, regex with $1, preserve case ----
    await page.fill(FIELD('Substituir'), 'ZAPQ')
    p = await previewOf(page, P('b.txt'), 'the right side follows the replace text', x => x.modified === 'other ZAPQ\n')
    assert.equal(p.original, 'other FOOQ\n')
    // Screenshots: the pad with the preview of a.ts beside it.
    await clickRow(page, aMatches[0]!.id)
    await previewOf(page, P('a.ts'), 'a.ts for the screenshots', x => x.modified === aText.replaceAll('FOOQ', 'ZAPQ'))
    await page.locator(SCROLL).focus()
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(400)
      await page.screenshot({ path: join(shots, `search-preview-${scheme}.png`) })
    }
    await page.click(TOGGLE('Expressão regular'))
    await page.fill(FIELD('Substituir'), 'R$1')
    s = await search(page, 'PCQ(\\d)', '2 resultados em 1 arquivo')
    await clickRow(page, rowOf(s, r => r.kind === 'match').id)
    p = await previewOf(page, P('rx.txt'), 'regex with $1', x => x.modified === 'R1 and R2\n')
    assert.equal(p.original, 'PCQ1 and PCQ2\n')
    await page.click(TOGGLE('Expressão regular'))
    await page.fill(FIELD('Substituir'), 'zorkq')
    s = await search(page, 'quuxq', '3 resultados em 1 arquivo')
    await clickRow(page, rowOf(s, r => r.kind === 'match').id)
    await previewOf(page, P('pc.txt'), 'plain replace', x => x.modified === 'zorkq zorkq zorkq\n')
    await page.click(TOGGLE('Preservar maiúsculas'))
    await previewOf(page, P('pc.txt'), 'preserve case on the right side', x => x.modified === 'Zorkq ZORKQ zorkq\n')
    await page.click(TOGGLE('Preservar maiúsculas'))

    // ---- 3. a file open in an editor with newer text: the left side is the editor's ----
    for (const f of readOnly) chmodSync(f, 0o444)
    await page.evaluate(x => window.__tether.openNote(x), P('ed.txt'))
    await until('ed.txt open', () => noteOf(page, P('ed.txt')), n => n !== undefined)
    await page.evaluate(x => window.__tether.openNote(x), P('ed.txt'))
    await until('ed.txt has the keyboard', async () => (await noteOf(page, P('ed.txt')))?.focused === true && await editorHasKeyboard(page), v => v)
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('xx')
    await until('ed.txt edited', () => noteOf(page, P('ed.txt')), n => (n?.text ?? '').replaceAll('\r\n', '\n') === 'xxEDQ disk\n')
    assert.equal(read(P('ed.txt')), 'EDQ disk\n', 'the disk keeps the old text')
    await page.keyboard.press('Control+Shift+F')
    await page.fill(FIELD('Substituir'), 'NEW')
    s = await search(page, 'EDQ', '1 resultado em 1 arquivo')
    await clickRow(page, rowOf(s, r => r.kind === 'match').id)
    p = await previewOf(page, P('ed.txt'), 'the editor text on the left')
    assert.equal((p.original ?? '').replaceAll('\r\n', '\n'), 'xxEDQ disk\n')
    assert.equal((p.modified ?? '').replaceAll('\r\n', '\n'), 'xxNEW disk\n')

    // ---- 4. Ctrl+click, the setting off, the field closed: the file itself ----
    await page.fill(FIELD('Substituir'), 'CLR')
    s = await search(page, 'CLQ', '4 resultados em 4 arquivos')
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.after === ' zero').id)
    await previewOf(page, P('cl0.txt'), 'the preview of cl0.txt')
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.after === ' one').id, ['Control'])
    await until('Ctrl+click opens cl1.txt', () => noteOf(page, P('cl1.txt')), n => n !== undefined)
    p = await preview(page)
    assert.ok(p.path !== undefined && same(p.path, P('cl0.txt')), `the preview is left as it was: ${p.path}`)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { search: { useReplacePreview: false } } }))
    await sleep(1_500) // settings.json is read again on change
    await page.keyboard.press('Control+Shift+F')
    s = await settled(page)
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.after === ' two').id)
    await until('with the setting off the file opens', () => noteOf(page, P('cl2.txt')), n => n !== undefined)
    p = await preview(page)
    assert.ok(p.path !== undefined && same(p.path, P('cl0.txt')), 'the preview did not take it')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({}))
    await sleep(1_500)
    await page.keyboard.press('Control+Shift+F')
    await page.click(`${PAD_SEL} .srw-arrow`) // the replace field closes
    await page.waitForSelector(FIELD('Substituir'), { state: 'hidden' })
    await until('closing the replace field closes the preview', () => preview(page), x => x.panes.length === 0)
    assert.equal(await page.locator('.srp-tab').count(), 0)
    s = await settled(page)
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.after === ' three').id)
    await until('the field closed: the file opens', () => noteOf(page, P('cl3.txt')), n => n !== undefined)
    assert.equal((await preview(page)).panes.length, 0, 'and no preview')

    // ---- 5. the preview's file replaced as a whole; the results cleared ----
    await page.click(`${PAD_SEL} .srw-arrow`)
    await page.waitForSelector(FIELD('Substituir'), { state: 'visible' })
    await page.fill(FIELD('Substituir'), 'DONE')
    s = await search(page, 'FOOQ', '5 resultados em 2 arquivos')
    await clickRow(page, aMatches[0]!.id)
    await previewOf(page, P('a.ts'), 'the preview of a.ts again', x => x.modified === aText.replaceAll('FOOQ', 'DONE'))
    await clickAct(page, rowOf(s, r => r.kind === 'file' && r.label === 'a.ts').id, 'replace')
    await waitDone(page, /substituídas? em 1 arquivo|1 resultado em 1 arquivo/, 'a.ts replaced')
    assert.equal(read(P('a.ts')), aText.replaceAll('FOOQ', 'DONE'))
    await until('replacing its file closes the preview', () => preview(page), x => x.panes.length === 0)
    s = await settled(page)
    await clickRow(page, rowOf(s, r => r.kind === 'match' && r.before === 'other ').id)
    await previewOf(page, P('b.txt'), 'the preview of b.txt again')
    await page.evaluate(() => window.__tether.runCommand('search.clear'))
    await until('clearing the results closes the preview', () => preview(page), x => x.panes.length === 0)

    // ---- 6. closing the tab: no preview model is left ----
    await page.fill(FIELD('Substituir'), 'Q2')
    s = await search(page, 'FOOQ', '1 resultado em 1 arquivo')
    await clickRow(page, rowOf(s, r => r.kind === 'match').id)
    await previewOf(page, P('b.txt'), 'the preview before closing its tab', x => x.modified === 'other Q2\n')
    // Closed previews' models go MODEL_GRACE_MS after their pane: then only this pane's two are left.
    await until("only the preview's two models", () => previewModels(page), m => m.length === 2, 5_000)
    await page.click('.srp-tab .close')
    await until('the tab closed', () => preview(page), x => x.panes.length === 0)
    await until('no preview model left in Monaco', () => previewModels(page), m => m.length === 0, 5_000)

    // ---- 7. a file that cannot be read ----
    s = await search(page, 'GONEQ', '2 resultados em 1 arquivo')
    rmSync(P('gone.txt'))
    await clickRow(page, rowOf(s, r => r.kind === 'match').id)
    p = await previewOf(page, P('gone.txt'), 'the message of a missing file', x => x.error !== undefined)
    assert.equal(p.error, 'O arquivo não foi encontrado.')
    assert.equal(await page.locator('.srp-msg:visible').innerText(), 'O arquivo não foi encontrado.')

    // ---- 8. relaunch with a preview in layout.json ----
    s = await search(page, 'FOOQ', '1 resultado em 1 arquivo')
    await clickRow(page, rowOf(s, r => r.kind === 'match').id)
    p = await previewOf(page, P('b.txt'), 'the preview before the relaunch')
    await until('the preview is in layout.json', () => existsSync(join(home, 'layout.json')) ? read(join(home, 'layout.json')) : '', t => t.includes(p.id!), 10_000)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await sleep(2_000)
    assert.deepEqual((await preview(page)).panes, [], 'the preview does not come back')
    assert.equal(await page.locator('.srp-tab').count(), 0, 'not even as an empty tab')
    assert.deepEqual(await previewModels(page), [], 'no preview model after the relaunch')
    await until('layout.json saved without it', () => read(join(home, 'layout.json')), t => !t.includes(PREVIEW_SCHEME), 10_000)
  } finally {
    for (const f of readOnly) { try { chmodSync(f, 0o666) } catch {} }
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
