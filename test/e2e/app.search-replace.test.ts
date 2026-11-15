// E2E of the search pad's replace. Hidden window on a private home/pipe, real tetherd, no agent; a fixture project in a
// temporary folder, pinned as the window's project. After every step the files are read back from the disk.
//   1. one match by the row's button, then by Ctrl+Shift+1: only it changes, its row goes, counts and message follow, the
//      keyboard goes to the next row;
//   2. "Substituir tudo neste arquivo" (row menu) and, in tree view, "Substituir tudo nesta pasta";
//   3. "Substituir tudo": the dialog shows the counts; Esc and Enter (Cancelar) change nothing; confirming replaces all;
//   4. regex with $1 and \u$1; preserve case (quux/Quux/QUUX); an empty replace field erases the found text;
//   5. \r\n, accents and emoji before the match, a BOM: the bytes outside the replaced text stay;
//   6. the guard: a file changed on disk after the search is skipped (intact), named on the message line, still in the tree;
//   7. files open in an editor: the replace lands in the editor, the note saves it, Ctrl+Z undoes it; an open file whose
//      editor text differs from what the search found is skipped;
//   8. a read-only file fails with the reason, the others are replaced;
//   9. the replace field closed: no replace button on the rows, the commands do nothing; "Substituir nos arquivos" opens it;
//  10. volume: "Substituir tudo" over 1 000 files × 5 matches (time logged), sampled on disk.
// Screenshots (light and dark) of the confirmation and of the pad after a replace with a skipped file go to <atrium>/.tmp/search.
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

type Row = { kind: 'folder' | 'file' | 'match'; id: string; level: number; label: string; count?: number; before?: string; inside?: string; after?: string; focused: boolean }
type Snap = {
  widget: { search: string; replace: string; replaceShown: boolean; replaceAllEnabled: boolean }
  message: string[]; searching: boolean; replacing: boolean; viewMode: 'list' | 'tree'; count: number; fileCount: number
  results: { rows: Row[] }
}
type Note = { id: string; path: string; text: string; savedText: string; dirty: boolean; focused: boolean }
type Hooks = {
  connection(): { pid?: number } | undefined
  search(): Snap | undefined
  searchStatus(): { searching: boolean; replacing?: 'confirm' | 'apply'; count: number; message: string[] } | undefined
  notes(): Note[]
  openFolder(path: string): void
  openNote(path: string): Promise<void>
  runCommand(id: string): Promise<string>
}
type El = { click(): void; getAttribute(n: string): string | null; textContent: string | null; closest?(s: string): unknown }
declare const window: { __tether: Hooks }
declare const CSS: { escape(s: string): string }
declare const performance: { now(): number }
declare const document: { documentElement: { dataset: Record<string, string> }; activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appsrepl-${process.pid}`
const atriumTmp = /^(.*?[\\/]\.tmp)(?=[\\/])/.exec(root)?.[1] ?? resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(atriumTmp, 'search')
const PAD_SEL = '.pad[data-pad="search.view"]'
const SCROLL = `${PAD_SEL} .sr-scroll`
const FIELD = (label: string): string => `${PAD_SEL} .srw-field[aria-label="${label}"]`
const TOGGLE = (label: string): string => `${PAD_SEL} .srw-t[aria-label="${label}"]`
const DIALOG = 'dialog[data-dialog="search.replace-all"]'
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

/** Waits until the pad is idle (no search, no replace) and its first message line is `first`. */
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

const rowOf = (s: Snap, pred: (r: Row) => boolean): Row => { const r = s.results.rows.find(pred); assert.ok(r, `row in ${JSON.stringify(s.results.rows.map(x => x.label + '|' + (x.before ?? '') + (x.inside ?? '')))}`); return r }

/** Clicks a row's action button (shown on hover: clicked in the page). */
async function clickAct(page: Page, id: string, act: string): Promise<void> {
  const ok = await page.evaluate(([sc, rid, a]) => {
    const b = document.querySelector(`${sc} .sr-row[data-id="${CSS.escape(rid!)}"] .sr-act[data-act="${a}"]`)
    if (!b) return false
    b.click()
    return true
  }, [SCROLL, id, act])
  assert.ok(ok, `the ${act} button of ${id} is drawn`)
}

async function rowMenu(page: Page, id: string, item: string): Promise<void> {
  await page.click(`${SCROLL} .sr-row[data-id="${id.replace(/["\\]/g, '\\$&')}"]`, { button: 'right' })
  await page.click(`#ctx-menu li:has-text("${item}")`)
}

async function openConfirm(page: Page, via: 'button' | 'command' = 'button'): Promise<string> {
  if (via === 'button') await page.click(`${PAD_SEL} .srw-replace-all`)
  else await page.evaluate(() => { void window.__tether.runCommand('search.replace-all') })
  await page.waitForSelector(`${DIALOG}[open]`)
  return (await page.locator(`${DIALOG} h2`).innerText()).trim()
}

async function confirm(page: Page): Promise<void> {
  await page.click(`${DIALOG} button.choice[data-choice="replace"]`)
  await page.waitForSelector(DIALOG, { state: 'detached' })
}

async function replaceAll(page: Page, first: string | RegExp, what: string): Promise<Snap> {
  await openConfirm(page)
  await confirm(page)
  await waitDone(page, first, what, 60_000)
  return settled(page)
}

const noteOf = async (page: Page, path: string): Promise<Note | undefined> =>
  (await page.evaluate(() => window.__tether.notes())).find(n => same(n.path, path))

const editorHasKeyboard = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest?.('.monaco-editor') != null)

test('search: replace end to end (match, file, folder, all, regex, case, encodings, guard, open editors, read-only, closed field, volume)', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-srepl-'))
  const F = join(home, 'proj', 'fixture')
  const P = (...p: string[]): string => join(F, ...p)
  for (const d of ['dirA', 'dirB', 'enc', 'vol', 'ed']) mkdirSync(P(d), { recursive: true })
  writeFileSync(P('single.txt'), 'ALPHAQ one\nALPHAQ two\nALPHAQ three\nALPHAQ four\n')
  writeFileSync(P('file1.txt'), 'GAMMAQ\nGAMMAQ\n')
  writeFileSync(P('file2.txt'), 'GAMMAQ\n')
  writeFileSync(P('dirA', 'x.txt'), 'EPSQ x\n')
  writeFileSync(P('dirA', 'y.txt'), 'EPSQ EPSQ y\n')
  writeFileSync(P('dirB', 'z.txt'), 'EPSQ z\n')
  writeFileSync(P('r1.txt'), 'ZETAQ\n')
  writeFileSync(P('r2.txt'), 'ZETAQ and ZETAQ\n')
  writeFileSync(P('rx.txt'), 'keyq=val1\nkeyq=val2\n')
  writeFileSync(P('rx2.txt'), 'nameq: bob\nnameq: amy\n')
  writeFileSync(P('pc.txt'), 'quux Quux QUUX\n')
  writeFileSync(P('del.txt'), 'keep DROPQ keep\n')
  writeFileSync(P('enc', 'crlf.txt'), 'line one\r\nCRXQ here\r\nend\r\n')
  writeFileSync(P('enc', 'emoji.txt'), 'ação 😀 CRXQ!\n')
  writeFileSync(P('enc', 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('CRXQ bom\n', 'utf8')]))
  writeFileSync(P('g1.txt'), 'GUARDQ one\n')
  writeFileSync(P('g2.txt'), 'GUARDQ two\n')
  writeFileSync(P('ed', 'ed.txt'), 'EDQ first\nsecond EDQ\n')
  writeFileSync(P('ed', 'ed2.txt'), 'EDQ x\n')
  writeFileSync(P('ro.txt'), 'ROQ\n')
  writeFileSync(P('ok.txt'), 'ROQ\n')
  writeFileSync(P('cl.txt'), 'SHUTQ\n')
  const vol = 'VOLQ a\nb VOLQ\nVOLQ VOLQ c\nd\nVOLQ\n'
  for (let i = 0; i < 1000; i++) writeFileSync(P('vol', `v${String(i).padStart(4, '0')}.txt`), vol)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(f => window.__tether.openFolder(f), F)
    await page.keyboard.press('Control+Shift+F')
    await page.waitForSelector(`${PAD_SEL}.shown .srw`)

    // ---- 9 (first half). The replace field closed: no replace action anywhere ----
    let s = await search(page, 'SHUTQ', '1 resultado em 1 arquivo')
    assert.equal(s.widget.replaceShown, false)
    assert.equal(await page.locator(`${SCROLL} .sr-act[data-act="replace"]`).count(), 0, 'no replace button on the rows')
    await page.evaluate(() => window.__tether.runCommand('search.replace-all'))
    await page.locator(SCROLL).focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    await page.evaluate(() => window.__tether.runCommand('search.replace'))
    await page.keyboard.press('Control+Shift+Digit1')
    await sleep(500)
    assert.equal(await page.locator(DIALOG).count(), 0, 'Substituir tudo asks nothing with the field closed')
    assert.equal(read(P('cl.txt')), 'SHUTQ\n', 'and nothing is replaced')
    const matchRow = rowOf(await snap(page), r => r.kind === 'match')
    await page.click(`${SCROLL} .sr-row[data-id="${matchRow.id.replace(/["\\]/g, '\\$&')}"]`, { button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    assert.equal(await page.locator('#ctx-menu li:has-text("Substituir")').count(), 0, 'the row menu offers no replace')
    await page.keyboard.press('Escape')
    // "Substituir nos arquivos" opens the field with the keyboard in it.
    await page.evaluate(() => window.__tether.runCommand('search.toggle-replace'))
    await page.waitForSelector(FIELD('Substituir'), { state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null), 'Substituir', 'the keyboard in the replace field')
    assert.ok((await page.locator(`${SCROLL} .sr-act[data-act="replace"]`).count()) > 0, 'the rows get their replace button')

    // ---- 1. one match: the row's button, then Ctrl+Shift+1 ----
    await page.fill(FIELD('Substituir'), 'BETA')
    s = await search(page, 'ALPHAQ', '4 resultados em 1 arquivo')
    const m = (s2: Snap, after: string): Row => rowOf(s2, r => r.kind === 'match' && r.after === after)
    await clickAct(page, m(s, ' one').id, 'replace')
    s = await waitDone(page, '3 resultados em 1 arquivo', 'one match replaced by its button')
    assert.equal(read(P('single.txt')), 'BETA one\nALPHAQ two\nALPHAQ three\nALPHAQ four\n', 'only that match changed on disk')
    s = await settled(page)
    assert.ok(!s.results.rows.some(r => r.after === ' one'), 'its row went')
    assert.equal(rowOf(s, r => r.kind === 'file').count, 3, 'the file count follows')
    assert.equal(s.results.rows.find(r => r.focused)?.after, ' two', 'the keyboard on the next row')
    await page.locator(SCROLL).focus()
    await page.keyboard.press('Control+Shift+Digit1')
    s = await waitDone(page, '2 resultados em 1 arquivo', 'Ctrl+Shift+1 replaces the focused match')
    assert.equal(read(P('single.txt')), 'BETA one\nBETA two\nALPHAQ three\nALPHAQ four\n')
    s = await settled(page)
    assert.equal(s.results.rows.find(r => r.focused)?.after, ' three', 'the keyboard on the next row again')
    // The command on the focused row, and the row menu's "Substituir".
    await page.evaluate(() => window.__tether.runCommand('search.replace'))
    await waitDone(page, '1 resultado em 1 arquivo', 'search.replace takes the focused row')
    assert.equal(read(P('single.txt')), 'BETA one\nBETA two\nBETA three\nALPHAQ four\n')
    s = await settled(page)
    await rowMenu(page, m(s, ' four').id, 'Substituir')
    s = await waitDone(page, '1 ocorrência substituída em 1 arquivo.', 'the row menu replaces the last match; nothing left to count: the summary')
    assert.equal(read(P('single.txt')), 'BETA one\nBETA two\nBETA three\nBETA four\n')

    // ---- 2. a file (row menu); a folder (tree view) ----
    await page.fill(FIELD('Substituir'), 'DELTA')
    s = await search(page, 'GAMMAQ', '3 resultados em 2 arquivos')
    await rowMenu(page, rowOf(s, r => r.kind === 'file' && r.label === 'file1.txt').id, 'Substituir tudo neste arquivo')
    s = await waitDone(page, '2 ocorrências substituídas em 1 arquivo.', 'replace in a file')
    assert.equal(read(P('file1.txt')), 'DELTA\nDELTA\n')
    assert.equal(read(P('file2.txt')), 'GAMMAQ\n', 'the other file untouched')
    s = await settled(page)
    assert.deepEqual(s.results.rows.filter(r => r.kind === 'file').map(r => r.label), ['file2.txt'], 'the replaced file left the tree')
    await page.fill(FIELD('Substituir'), 'OMEGA')
    s = await search(page, 'EPSQ', '4 resultados em 3 arquivos')
    await page.click(`${PAD_SEL} .srch-view`)
    s = await settled(page)
    assert.equal(s.viewMode, 'tree')
    await rowMenu(page, rowOf(s, r => r.kind === 'folder' && r.label === 'dirA').id, 'Substituir tudo nesta pasta')
    await waitDone(page, '3 ocorrências substituídas em 2 arquivos.', 'replace in a folder')
    assert.equal(read(P('dirA', 'x.txt')), 'OMEGA x\n')
    assert.equal(read(P('dirA', 'y.txt')), 'OMEGA OMEGA y\n', 'two matches on one line')
    assert.equal(read(P('dirB', 'z.txt')), 'EPSQ z\n', 'the other folder untouched')
    s = await settled(page)
    assert.ok(!s.results.rows.some(r => r.label === 'dirA'), 'the folder left the tree')
    await page.click(`${PAD_SEL} .srch-view`)

    // ---- 3. replace all: the dialog, Esc, Enter, then confirm ----
    await page.fill(FIELD('Substituir'), 'ETA')
    await search(page, 'ZETAQ', '3 resultados em 2 arquivos')
    assert.equal(await openConfirm(page), 'Substituir 3 ocorrências em 2 arquivos?', 'the counts in the title')
    const msg = (await page.locator(`${DIALOG} .message`).innerText()).trim()
    assert.equal(msg, "Cada ocorrência será trocada por 'ETA'. Arquivos abertos no editor podem ser desfeitos com Ctrl+Z; os demais são gravados em disco.")
    await page.keyboard.press('Escape')
    await page.waitForSelector(DIALOG, { state: 'detached' })
    await openConfirm(page, 'command')
    await page.keyboard.press('Enter')
    await page.waitForSelector(DIALOG, { state: 'detached' })
    await sleep(300)
    assert.equal(read(P('r1.txt')), 'ZETAQ\n', 'Esc and Enter (Cancelar) change nothing')
    assert.equal(read(P('r2.txt')), 'ZETAQ and ZETAQ\n')
    assert.equal((await snap(page)).message[0], '3 resultados em 2 arquivos', 'the message stays')
    s = await replaceAll(page, '3 ocorrências substituídas em 2 arquivos.', 'replace all')
    assert.equal(read(P('r1.txt')), 'ETA\n')
    assert.equal(read(P('r2.txt')), 'ETA and ETA\n')
    assert.equal(s.results.rows.length, 0, 'everything replaced left the tree')
    assert.equal(s.widget.search, 'ZETAQ', 'the fields stay as they are')
    assert.equal(s.widget.replace, 'ETA')

    // ---- 4. regex $1, \u$1; preserve case; empty replace ----
    await page.click(TOGGLE('Expressão regular'))
    await page.fill(FIELD('Substituir'), 'K:$1')
    await search(page, 'keyq=(val\\d)', '2 resultados em 1 arquivo')
    await replaceAll(page, '2 ocorrências substituídas em 1 arquivo.', 'regex $1')
    assert.equal(read(P('rx.txt')), 'K:val1\nK:val2\n')
    await page.fill(FIELD('Substituir'), '\\u$1')
    await search(page, 'nameq: (\\w+)', '2 resultados em 1 arquivo')
    await replaceAll(page, '2 ocorrências substituídas em 1 arquivo.', 'regex \\u$1')
    assert.equal(read(P('rx2.txt')), 'Bob\nAmy\n')
    await page.click(TOGGLE('Expressão regular'))
    await page.fill(FIELD('Substituir'), 'zap')
    await page.click(TOGGLE('Preservar maiúsculas'))
    await search(page, 'quux', '3 resultados em 1 arquivo')
    await replaceAll(page, '3 ocorrências substituídas em 1 arquivo.', 'preserve case')
    assert.equal(read(P('pc.txt')), 'zap Zap ZAP\n')
    await page.click(TOGGLE('Preservar maiúsculas'))
    await page.fill(FIELD('Substituir'), '')
    await search(page, 'DROPQ', '1 resultado em 1 arquivo')
    assert.equal(await openConfirm(page), 'Substituir 1 ocorrência em 1 arquivo?')
    assert.match(await page.locator(`${DIALOG} .message`).innerText(), /^O texto encontrado será apagado\./)
    await confirm(page)
    await waitDone(page, '1 ocorrência substituída em 1 arquivo.', 'empty replace')
    assert.equal(read(P('del.txt')), 'keep  keep\n', 'the found text erased')

    // ---- 5. \r\n, accents and emoji, BOM ----
    await page.fill(FIELD('Substituir'), 'ok')
    await search(page, 'CRXQ', '3 resultados em 3 arquivos')
    await replaceAll(page, '3 ocorrências substituídas em 3 arquivos.', 'encodings')
    assert.deepEqual(readFileSync(P('enc', 'crlf.txt')), Buffer.from('line one\r\nok here\r\nend\r\n'), '\\r\\n kept')
    assert.deepEqual(readFileSync(P('enc', 'emoji.txt')), Buffer.from('ação 😀 ok!\n', 'utf8'), 'accents and emoji before the match kept')
    assert.deepEqual(readFileSync(P('enc', 'bom.txt')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok bom\n', 'utf8')]), 'the BOM kept')

    // ---- 6. the guard: a file changed after the search is skipped ----
    await page.fill(FIELD('Substituir'), 'SAFE')
    await search(page, 'GUARDQ', '2 resultados em 2 arquivos')
    writeFileSync(P('g2.txt'), 'changed GUARDQ two\n')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await openConfirm(page)
      await sleep(300)
      await page.screenshot({ path: join(shots, `search-replace-confirm-${scheme}.png`) })
      await page.keyboard.press('Escape')
      await page.waitForSelector(DIALOG, { state: 'detached' })
    }
    s = await replaceAll(page, '1 ocorrência substituída em 1 arquivo.', 'the guard')
    assert.equal(read(P('g1.txt')), 'SAFE one\n')
    assert.equal(read(P('g2.txt')), 'changed GUARDQ two\n', 'the changed file is intact')
    assert.equal(s.message[1], '1 arquivo mudou depois da pesquisa e foi pulado: g2.txt. Pesquise de novo para atualizar.')
    assert.deepEqual(s.results.rows.filter(r => r.kind === 'file').map(r => r.label), ['g2.txt'], 'the skipped file stays in the tree')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await sleep(300)
      await page.screenshot({ path: join(shots, `search-replace-skipped-${scheme}.png`) })
    }

    // ---- 7. files open in an editor ----
    const ed = P('ed', 'ed.txt')
    const ed2 = P('ed', 'ed2.txt')
    for (const [p, text] of [[ed2, 'EDQ x\n'], [ed, 'EDQ first\nsecond EDQ\n']] as const) {
      await page.evaluate(x => window.__tether.openNote(x), p)
      await until(`${p} open`, async () => (await noteOf(page, p))?.text.replaceAll('\r\n', '\n') === text)
    }
    await page.fill(FIELD('Substituir'), 'Y')
    await search(page, 'EDQ', '3 resultados em 2 arquivos')
    // ed2's text changes in its editor after the search.
    await page.evaluate(x => window.__tether.openNote(x), ed2)
    await until('ed2 has the keyboard', async () => (await noteOf(page, ed2))?.focused === true && await editorHasKeyboard(page))
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('abc')
    await until('ed2 saved', async () => { const n = await noteOf(page, ed2); return !!n && !n.dirty && n.text.startsWith('abcEDQ') })
    s = await replaceAll(page, '2 ocorrências substituídas em 1 arquivo.', 'open editors')
    assert.match(s.message[1] ?? '', /^1 arquivo mudou depois da pesquisa e foi pulado: ed2\.txt\./, 'the edited open file is skipped')
    let note = (await noteOf(page, ed))!
    assert.equal(note.text.replaceAll('\r\n', '\n'), 'Y first\nsecond Y\n', 'the replace landed in the editor')
    assert.equal((await noteOf(page, ed2))!.text.replaceAll('\r\n', '\n'), 'abcEDQ x\n', 'the skipped editor untouched')
    await until('the note saves the replace', async () => { const n = await noteOf(page, ed); return !!n && !n.dirty && read(ed) === n.text })
    assert.equal(read(ed).replaceAll('\r\n', '\n'), 'Y first\nsecond Y\n', 'the disk got the new text by the note')
    await page.evaluate(x => window.__tether.openNote(x), ed)
    await until('ed has the keyboard', async () => (await noteOf(page, ed))?.focused === true && await editorHasKeyboard(page))
    await page.keyboard.press('Control+Z')
    await until('Ctrl+Z undoes the replace in one step', async () => (await noteOf(page, ed))?.text.replaceAll('\r\n', '\n') === 'EDQ first\nsecond EDQ\n')
    await until('the undo is saved', async () => { const n = await noteOf(page, ed); return !!n && !n.dirty && read(ed).replaceAll('\r\n', '\n') === 'EDQ first\nsecond EDQ\n' })
    note = (await noteOf(page, ed))!

    // ---- 8. a read-only file ----
    chmodSync(P('ro.txt'), 0o444)
    await page.fill(FIELD('Substituir'), 'W')
    await search(page, 'ROQ', '2 resultados em 2 arquivos')
    s = await replaceAll(page, '1 ocorrência substituída em 1 arquivo.', 'read-only')
    assert.equal(read(P('ok.txt')), 'W\n')
    assert.equal(read(P('ro.txt')), 'ROQ\n', 'the read-only file untouched')
    assert.equal(s.message[1], 'Não foi possível gravar ro.txt: Sem permissão para gravar neste arquivo.')
    assert.deepEqual(s.results.rows.filter(r => r.kind === 'file').map(r => r.label), ['ro.txt'])
    chmodSync(P('ro.txt'), 0o666)

    // ---- 9 (second half). Closing the field takes the actions away again ----
    await search(page, 'SHUTQ', '1 resultado em 1 arquivo')
    await page.click(`${PAD_SEL} .srw-arrow`)
    await page.waitForSelector(FIELD('Substituir'), { state: 'hidden' })
    await page.waitForFunction(sc => document.querySelectorAll(`${sc} .sr-act[data-act="replace"]`).length === 0, SCROLL)
    await page.evaluate(() => window.__tether.runCommand('search.replace-all'))
    await sleep(400)
    assert.equal(await page.locator(DIALOG).count(), 0)
    assert.equal(read(P('cl.txt')), 'SHUTQ\n')
    await page.click(`${PAD_SEL} .srw-arrow`)
    await page.waitForSelector(FIELD('Substituir'), { state: 'visible' })

    // ---- 10. volume: 1 000 files × 5 matches ----
    await page.fill(FIELD('Substituir'), 'VV')
    await page.fill(FIELD('Pesquisar'), 'VOLQ')
    await waitDone(page, '5.000 resultados em 1.000 arquivos', 'the volume search', 60_000)
    await openConfirm(page)
    assert.equal((await page.locator(`${DIALOG} h2`).innerText()).trim(), 'Substituir 5.000 ocorrências em 1.000 arquivos?')
    const t0 = Date.now()
    // While it runs: the progress bar shows, another "Substituir tudo" is ignored, a new search waits.
    // Polled with the cheap status (the full snapshot draws every row and would slow the window down itself).
    const during = page.evaluate(([pad, dlg]) => new Promise<{ bar: boolean; dialog: boolean; searched: boolean; message: string; ms: number }>(resolve => {
      const seen = { bar: false, dialog: false, searched: false, message: '', ms: 0 }
      let asked = false
      let started = 0
      const tick = (): void => {
        const s2 = window.__tether.searchStatus()
        if (s2?.replacing === 'apply') {
          if (!started) started = performance.now()
          if (document.querySelector(`${pad} .srch.searching`)) seen.bar = true
          if (!asked) { asked = true; void window.__tether.runCommand('search.replace-all'); void window.__tether.runCommand('search.refresh') }
          if (document.querySelector(`${dlg}[open]`)) seen.dialog = true
          if (s2.searching) seen.searched = true
          setTimeout(tick, 20)
          return
        }
        if (asked) { seen.message = s2?.message[0] ?? ''; seen.ms = Math.round(performance.now() - started); resolve(seen); return }
        setTimeout(tick, 5)
      }
      tick()
    }), [PAD_SEL, DIALOG])
    await page.click(`${DIALOG} button.choice[data-choice="replace"]`)
    const seen = await during
    const took = Date.now() - t0
    console.log(`volume: replace all of 5000 matches in 1000 files: ${seen.ms} ms replacing (in the page), ${took} ms from the dialog to the end (test side)`)
    assert.equal(seen.message, '5.000 ocorrências substituídas em 1.000 arquivos.', 'the summary')
    assert.deepEqual({ bar: seen.bar, dialog: seen.dialog, searched: seen.searched }, { bar: true, dialog: false, searched: false }, 'while replacing: the bar, no second dialog, no search')
    // The refresh asked for during the replace runs after it: everything replaced, nothing found any more.
    s = await waitDone(page, /^Nenhum resultado encontrado/, 'the deferred search ran after the replace', 60_000)
    for (const i of [0, 1, 499, 998, 999]) assert.equal(read(P('vol', `v${String(i).padStart(4, '0')}.txt`)), 'VV a\nb VV\nVV VV c\nd\nVV\n', `vol file ${i}`)
    let total = 0
    for (let i = 0; i < 1000; i++) total += (read(P('vol', `v${String(i).padStart(4, '0')}.txt`)).match(/VV/g) ?? []).length
    assert.equal(total, 5000, 'every match replaced')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    try { chmodSync(join(home, 'proj', 'fixture', 'ro.txt'), 0o666) } catch {}
    for (let i = 0; i < 20; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(500) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
