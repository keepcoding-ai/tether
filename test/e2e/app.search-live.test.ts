// E2E of the search pad's results kept true to the text of now. Hidden window on a private home/pipe, real tetherd, no
// agent; a fixture project in a temporary folder, pinned as the window's project.
//   1. a file open in an editor is searched in its editor's text (read-only on disk, so the note cannot save it): the
//      row shows the editor's line, the disk's version of the file does not come as a second entry; an open file whose
//      editor text lost the term is not in the results although its disk text has it;
//   2. typing a new line with the term in an open editor adds the match without a new search, deleting it takes it away;
//      an open file that had no match gains one; the counts and the message follow;
//   3. a closed file with two matches on a line: replacing the first, then the second, writes both; the remaining row
//      already shows the new text;
//   4. a replacement with a line break (regex): the matches below stay replaceable;
//   5. the same two replaces on one line in a file open in an editor;
//   6. the guard still holds: a closed file changed on disk after the search is skipped by "Substituir tudo".
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

type Row = { kind: 'folder' | 'file' | 'match'; id: string; level: number; label: string; count?: number; line?: number; before?: string; inside?: string; after?: string; focused: boolean }
type Snap = {
  widget: { search: string; replace: string; replaceShown: boolean; replaceAllEnabled: boolean }
  message: string[]; searching: boolean; replacing: boolean; viewMode: 'list' | 'tree'; count: number; fileCount: number
  results: { rows: Row[] }
}
type Note = { id: string; path: string; text: string; savedText: string; dirty: boolean; focused: boolean }
type Hooks = {
  connection(): { pid?: number } | undefined
  search(): Snap | undefined
  notes(): Note[]
  openFolder(path: string): void
  openNote(path: string): Promise<void>
  runCommand(id: string): Promise<string>
}
type El = { click(): void; getAttribute(n: string): string | null; closest?(s: string): unknown }
declare const window: { __tether: Hooks }
declare const CSS: { escape(s: string): string }
declare const document: { activeElement: El | null; querySelector(s: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-slive-${process.pid}`
const atriumTmp = /^(.*?[\\/]\.tmp)(?=[\\/])/.exec(root)?.[1] ?? resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const PAD_SEL = '.pad[data-pad="search.view"]'
const SCROLL = `${PAD_SEL} .sr-scroll`
const FIELD = (label: string): string => `${PAD_SEL} .srw-field[aria-label="${label}"]`
const TOGGLE = (label: string): string => `${PAD_SEL} .srw-t[aria-label="${label}"]`
const DIALOG = 'dialog[data-dialog="search.replace-all"]'
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
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  return { app, page }
}

const snap = async (page: Page): Promise<Snap> => (await page.evaluate(() => window.__tether.search()))!

async function waitDone(page: Page, first: string | RegExp, what: string, timeout = 10_000): Promise<Snap> {
  const deadline = Date.now() + timeout
  let s: Snap | undefined
  while (Date.now() < deadline) {
    s = await snap(page)
    const line = s.message[0] ?? ''
    if (!s.searching && !s.replacing && (typeof first === 'string' ? line === first : first.test(line))) return s
    await sleep(60)
  }
  assert.fail(`${what}: message ${JSON.stringify(s?.message)}, searching ${s?.searching}, replacing ${s?.replacing}, rows ${JSON.stringify(s?.results.rows.map(r => `${r.kind}:${r.label}`))}`)
}

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(80) }
  assert.fail(`timed out: ${what}`)
}

/** The tree has redrawn: the rows match the model's counts. */
async function settled(page: Page): Promise<Snap> {
  await page.waitForFunction(() => {
    const s = window.__tether.search()!
    const rows = s.results.rows
    return rows.filter(r => r.kind === 'file').reduce((n, r) => n + (r.count ?? 0), 0) === s.count && (s.count > 0 || rows.length === 0)
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
const files = (s: Snap): string[] => s.results.rows.filter(r => r.kind === 'file').map(r => r.label)

async function clickAct(page: Page, id: string, act: string): Promise<void> {
  const ok = await page.evaluate(([sc, rid, a]) => {
    const b = document.querySelector(`${sc} .sr-row[data-id="${CSS.escape(rid!)}"] .sr-act[data-act="${a}"]`)
    if (!b) return false
    b.click()
    return true
  }, [SCROLL, id, act])
  assert.ok(ok, `the ${act} button of ${id} is drawn`)
}

const noteOf = async (page: Page, path: string): Promise<Note | undefined> =>
  (await page.evaluate(() => window.__tether.notes())).find(n => same(n.path, path))

const editorHasKeyboard = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest?.('.monaco-editor') != null)

/** Opens the file in a note with the keyboard in its editor. */
async function focusNote(page: Page, path: string): Promise<void> {
  await page.evaluate(x => window.__tether.openNote(x), path)
  await until(`${path} open`, async () => (await noteOf(page, path)) !== undefined)
  await page.evaluate(x => window.__tether.openNote(x), path)
  await until(`${path} has the keyboard`, async () => (await noteOf(page, path))?.focused === true && await editorHasKeyboard(page))
}

const editorText = async (page: Page, path: string): Promise<string> => ((await noteOf(page, path))?.text ?? '').replaceAll('\r\n', '\n')

test('search: results follow the text of now (open editors searched in memory, live edits, replaces recompute the file)', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpBase, 'tether-slive-'))
  const F = join(home, 'proj', 'fixture')
  const P = (...p: string[]): string => join(F, ...p)
  mkdirSync(F, { recursive: true })
  writeFileSync(P('live.txt'), 'aaa LIVEQ one\nplain\n')
  writeFileSync(P('lost.txt'), 'LIVEQ here\n')
  writeFileSync(P('closed.txt'), 'LIVEQ closed\n')
  writeFileSync(P('gain.txt'), 'nothing yet\n')
  writeFileSync(P('same.txt'), 'SAMEQ and SAMEQ\n')
  writeFileSync(P('nl.txt'), 'NLQ a NLQ\nNLQ b\n')
  writeFileSync(P('op.txt'), 'OPQ and OPQ\n')
  writeFileSync(P('g1.txt'), 'GUARDQ one\n')
  writeFileSync(P('g2.txt'), 'GUARDQ two\n')
  const readOnly = [P('live.txt'), P('lost.txt')]
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(f => window.__tether.openFolder(f), F)

    // ---- 1. open editors are searched in their text ----
    // The disk copies are read-only: the notes cannot save, so the editors' text and the disk's differ when searching.
    for (const p of readOnly) chmodSync(p, 0o444)
    await focusNote(page, P('live.txt'))
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('xx')
    await until('live.txt edited', async () => (await editorText(page, P('live.txt'))).startsWith('xxaaa LIVEQ'))
    await focusNote(page, P('lost.txt'))
    await page.keyboard.press('Control+A')
    await page.keyboard.type('gone')
    await until('lost.txt edited', async () => (await editorText(page, P('lost.txt'))).startsWith('gone'))
    assert.equal(read(P('live.txt')), 'aaa LIVEQ one\nplain\n', 'the disk still has the old text')
    assert.equal(read(P('lost.txt')), 'LIVEQ here\n')
    await page.keyboard.press('Control+Shift+F')
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)
    // A save that fails on a read-only file leaves the note's temp file (<name>.<pid>.tmp) next to it: kept out. Not
    // "*.tmp": the open editors are filtered by their absolute path (as VS Code does), and this home lives under .tmp.
    await page.evaluate(() => window.__tether.runCommand('search.toggle-details'))
    await page.waitForSelector(FIELD('arquivos a excluir'), { state: 'visible' })
    await page.fill(FIELD('arquivos a excluir'), '*.txt.*.tmp')
    let s = await search(page, 'LIVEQ', '2 resultados em 2 arquivos')
    assert.deepEqual(files(s).sort(), ['closed.txt', 'live.txt'], 'one entry per file; the open file without the term is out')
    const liveRow = rowOf(s, r => r.kind === 'match' && r.after === ' one')
    assert.equal(liveRow.before, 'xxaaa ', 'the editor text, not the disk text')
    assert.equal(s.results.rows.filter(r => r.kind === 'file' && r.label === 'live.txt').length, 1)

    // ---- 2. typing in an open editor updates its matches without a new search ----
    await focusNote(page, P('live.txt'))
    await page.keyboard.press('Control+End')
    await page.keyboard.type('LIVEQ new')
    await until('the typed match enters the tree', async () => { const x = await snap(page); return x.count === 3 && x.results.rows.some(r => r.kind === 'match' && r.inside === 'LIVEQ' && r.after === ' new') })
    s = await settled(page)
    assert.equal(s.message[0], '3 resultados em 2 arquivos', 'the message follows')
    assert.equal(rowOf(s, r => r.kind === 'file' && r.label === 'live.txt').count, 2, 'the file count follows')
    await page.keyboard.press('Shift+Home')
    await page.keyboard.press('Backspace')
    await until('the deleted match leaves the tree', async () => (await snap(page)).count === 2)
    s = await settled(page)
    assert.equal(s.message[0], '2 resultados em 2 arquivos')
    assert.ok(!s.results.rows.some(r => r.after === ' new'))
    // An open file with no match gains one.
    await focusNote(page, P('gain.txt'))
    await page.keyboard.press('Control+End')
    await page.keyboard.type('LIVEQ gained')
    await until('the open file without matches enters the tree', async () => (await snap(page)).fileCount === 3)
    s = await settled(page)
    assert.equal(s.message[0], '3 resultados em 3 arquivos')
    assert.ok(files(s).includes('gain.txt'))
    for (const p of readOnly) chmodSync(p, 0o666)

    // ---- 3. a closed file: two matches on one line, replaced one after the other ----
    await page.evaluate(() => window.__tether.runCommand('search.toggle-replace'))
    await page.waitForSelector(FIELD('Substituir'), { state: 'visible' })
    await page.fill(FIELD('Substituir'), 'LONGER')
    s = await search(page, 'SAMEQ', '2 resultados em 1 arquivo')
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.before === '').id, 'replace')
    await waitDone(page, '1 resultado em 1 arquivo', 'the first match replaced')
    assert.equal(read(P('same.txt')), 'LONGER and SAMEQ\n')
    await until('the remaining row shows the new text', async () => (await snap(page)).results.rows.some(r => r.kind === 'match' && r.before === 'LONGER and ' && r.inside === 'SAMEQ'))
    s = await settled(page)
    const focusedAfter = s.results.rows.find(r => r.focused)
    assert.ok(focusedAfter && (focusedAfter.kind === 'match' || focusedAfter.label === 'same.txt'), `the keyboard stays next to the replaced row: ${JSON.stringify(focusedAfter)}`)
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.inside === 'SAMEQ').id, 'replace')
    await waitDone(page, '1 ocorrência substituída em 1 arquivo.', 'the second match on the same line replaced')
    assert.equal(read(P('same.txt')), 'LONGER and LONGER\n', 'both written')

    // ---- 4. a replacement with a line break: the matches below stay replaceable ----
    await page.click(TOGGLE('Expressão regular'))
    await page.fill(FIELD('Substituir'), 'X\\nY')
    s = await search(page, 'NLQ', '3 resultados em 1 arquivo')
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.before === '' && r.after === ' a NLQ').id, 'replace')
    await waitDone(page, '2 resultados em 1 arquivo', 'the first match replaced by two lines')
    assert.equal(read(P('nl.txt')), 'X\nY a NLQ\nNLQ b\n')
    await until('the rest recomputed', async () => (await snap(page)).results.rows.some(r => r.kind === 'match' && r.before === 'Y a '))
    s = await settled(page)
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.after === ' b').id, 'replace')
    await waitDone(page, '1 resultado em 1 arquivo', 'the match two lines below replaced')
    assert.equal(read(P('nl.txt')), 'X\nY a NLQ\nX\nY b\n')
    await until('the rest recomputed again', async () => (await snap(page)).results.rows.some(r => r.kind === 'match' && r.before === 'Y a ' && r.after === ''))
    s = await settled(page)
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.before === 'Y a ').id, 'replace')
    await waitDone(page, '1 ocorrência substituída em 1 arquivo.', 'the last one replaced')
    assert.equal(read(P('nl.txt')), 'X\nY a X\nY\nX\nY b\n', 'every match written where it was')
    await page.click(TOGGLE('Expressão regular'))

    // ---- 5. a file open in an editor: two matches on one line ----
    await page.evaluate(x => window.__tether.openNote(x), P('op.txt'))
    await until('op.txt open', async () => (await editorText(page, P('op.txt'))) === 'OPQ and OPQ\n')
    await page.fill(FIELD('Substituir'), 'LONGER')
    s = await search(page, 'OPQ', '2 resultados em 1 arquivo')
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.before === '').id, 'replace')
    await waitDone(page, '1 resultado em 1 arquivo', 'the first match replaced in the editor')
    await until('the remaining row shows the editor text', async () => (await snap(page)).results.rows.some(r => r.kind === 'match' && r.before === 'LONGER and '))
    s = await settled(page)
    await clickAct(page, rowOf(s, r => r.kind === 'match' && r.inside === 'OPQ').id, 'replace')
    await waitDone(page, '1 ocorrência substituída em 1 arquivo.', 'the second match replaced in the editor')
    assert.equal(await editorText(page, P('op.txt')), 'LONGER and LONGER\n')
    await until('the note saves it', async () => read(P('op.txt')) === 'LONGER and LONGER\n')

    // ---- 6. the guard: a closed file changed on disk after the search is skipped ----
    await page.fill(FIELD('Substituir'), 'SAFE')
    await search(page, 'GUARDQ', '2 resultados em 2 arquivos')
    writeFileSync(P('g2.txt'), 'changed GUARDQ two\n')
    await page.click(`${PAD_SEL} .srw-replace-all`)
    await page.waitForSelector(`${DIALOG}[open]`)
    await page.click(`${DIALOG} button.choice[data-choice="replace"]`)
    await page.waitForSelector(DIALOG, { state: 'detached' })
    s = await waitDone(page, '1 ocorrência substituída em 1 arquivo.', 'the guard')
    assert.equal(read(P('g1.txt')), 'SAFE one\n')
    assert.equal(read(P('g2.txt')), 'changed GUARDQ two\n', 'the changed file is intact')
    assert.equal(s.message[1], '1 arquivo mudou depois da pesquisa e foi pulado: g2.txt. Pesquise de novo para atualizar.')
  } finally {
    for (const p of readOnly) { try { chmodSync(p, 0o666) } catch {} }
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
