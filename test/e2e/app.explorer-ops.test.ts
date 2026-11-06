// E2E of the explorer extension, slice 5 (F8): the file operations. Hidden window on a private home/pipe, real tetherd, no agent.
//   1. new file: the root's menu → an input row → Enter creates it on disk, opens it in a note and selects its row;
//   2. invalid names are refused with a message (reserved name, existing name); Esc leaves nothing behind;
//   3. new folder inside a folder;
//   4. F2 renames in place with the name without its extension selected; the open note follows the rename;
//   5. Delete asks (cancel keeps the file), then "Mover para a lixeira" removes it from the disk (the system trash; never emptied here);
//   6. main's guard refuses writes outside the project roots and on the root itself;
//   7. copy path / copy relative path (the person's clipboard is put back);
//   8. "Novo painel aqui" opens the chooser on that folder.
// Screenshots (light and dark) of the inline rename and of the delete dialog go to <atrium>/.tmp/f8.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { name: string; path: string; level: number; kind: string; selected: boolean; focused: boolean }
type Edit = { value: string; message: string; severity: string; selection: [number, number] }
type Result = { ok: boolean; message?: string }
type Hooks = {
  connection(): { pid?: number } | undefined
  explorer(): { rows: Row[]; edit: Edit | undefined } | undefined
  notes(): { id: string; path: string }[]
  explorerWrite: { create(p: string, k: 'file' | 'dir'): Promise<Result>; rename(a: string, b: string): Promise<Result>; trash(p: string): Promise<Result> }
}
declare const window: { __tether: Hooks }
declare const document: { documentElement: { dataset: Record<string, string> }; activeElement: { className?: string } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorerops-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = join(tmpBase, 'f8')
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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

const rowSel = (name: string): string => `.pad.shown .xp-row:has(> .xp-name:text-is("${name}"))`
/** A click on a file opens it in the editor (the keyboard goes there): Ctrl+K E puts it back on the selected row, as a person does. */
async function toTree(page: Page): Promise<void> {
  // The opened note takes the keyboard on its next frame: wait for it, or Ctrl+K E would be undone by it.
  await page.waitForFunction(() => (globalThis as unknown as { document: { activeElement: { closest?(s: string): unknown } | null } }).document.activeElement?.closest?.('[data-editor]') != null, undefined, { timeout: 3_000 }).catch(() => {})
  await sleep(150)
  await page.keyboard.press('Control+k')
  await page.keyboard.press('e')
  await page.waitForFunction(() => (globalThis as unknown as { document: { activeElement: { classList?: { contains(c: string): boolean } } | null } }).document.activeElement?.classList?.contains('xp-row') === true)
}
async function pick(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await page.click(rowSel(name))
    await sleep(150)
    if ((await page.evaluate(() => window.__tether.explorer()!.rows)).some(r => r.name === name && r.selected)) break
  }
  await toTree(page)
  assert.equal((await page.evaluate(() => window.__tether.explorer()!.rows)).find(r => r.focused)?.name, name, `the keyboard on ${name}`)
}
const edit = async (page: Page): Promise<Edit | undefined> => (await page.evaluate(() => window.__tether.explorer()))!.edit
const menu = async (page: Page, row: string, item: string): Promise<void> => {
  await page.click(rowSel(row), { button: 'right' })
  await page.click(`#ctx-menu li:has-text("${item}")`)
}
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(80) }
  assert.fail(`timed out: ${what}`)
}

test('explorer 5: new file/folder, rename, trash, guard, copy path, new pane here', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-ops-'))
  const F = join(home, 'proj', 'ops')
  const outside = join(home, 'outside')
  mkdirSync(join(F, 'docs'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(F, 'keep.txt'), 'keep\n')
  writeFileSync(join(F, 'notes.md'), '# notes\n')
  writeFileSync(join(outside, 'secret.txt'), 'x')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let clipboardBefore: string | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText())
    await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('folder:pick'); ipcMain.handle('folder:pick', () => f) }, F)
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    await page.click('.xp-primary')
    await page.waitForSelector(rowSel('notes.md'))

    // ---- 1. new file ----
    await menu(page, 'ops', 'Novo arquivo…')
    await page.waitForSelector('.pad.shown .xp-edit .xp-input')
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'xp-input', 'the input has the keyboard')
    await page.keyboard.type('novo.md')
    await page.keyboard.press('Enter')
    await until('novo.md on disk', () => existsSync(join(F, 'novo.md')))
    assert.equal(statSync(join(F, 'novo.md')).size, 0)
    await until('novo.md opened in a note', async () => (await page.evaluate(() => window.__tether.notes())).some(n => /novo\.md$/.test(n.path)))
    await until('novo.md row selected', async () => (await page.evaluate(() => window.__tether.explorer()!.rows)).some(r => r.name === 'novo.md' && r.selected))
    assert.equal(await page.locator('.pad.shown .xp-edit').count(), 0, 'the input row is gone')

    // ---- 2. invalid names ----
    await menu(page, 'ops', 'Novo arquivo…')
    await page.waitForSelector('.pad.shown .xp-edit .xp-input')
    await page.keyboard.type('CON')
    await until('reserved name message', async () => /não é um nome válido/.test((await edit(page))?.message ?? ''))
    await page.keyboard.press('Enter')
    assert.ok(await edit(page), 'Enter on an invalid name keeps the input')
    await page.fill('.pad.shown .xp-input', 'keep.txt')
    await until('existing name message', async () => /Já existe/.test((await edit(page))?.message ?? ''))
    assert.equal((await edit(page))!.severity, 'error')
    await page.fill('.pad.shown .xp-input', 'nome.')
    await until('trailing dot message', async () => /não é um nome válido/.test((await edit(page))?.message ?? ''))
    await page.keyboard.press('Escape')
    assert.equal(await edit(page), undefined, 'Esc cancels')
    assert.equal(existsSync(join(F, 'nome.')), false)
    assert.equal(existsSync(join(F, 'CON')), false)

    // ---- 3. new folder inside docs ----
    await menu(page, 'docs', 'Nova pasta…')
    await page.waitForSelector('.pad.shown .xp-edit .xp-input')
    await page.keyboard.type('sub')
    await page.keyboard.press('Enter')
    await until('docs/sub on disk', () => existsSync(join(F, 'docs', 'sub')) && statSync(join(F, 'docs', 'sub')).isDirectory())
    await page.waitForSelector(rowSel('sub'))

    // ---- 4. F2 rename: the stem selected; the screenshots; the note follows ----
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await pick(page, 'keep.txt')
      await page.keyboard.press('F2')
      await page.waitForSelector('.pad.shown .xp-row .xp-input')
      const e = (await edit(page))!
      assert.equal(e.value, 'keep.txt')
      assert.deepEqual(e.selection, [0, 4], 'the name without its extension is selected')
      await sleep(250)
      await page.screenshot({ path: join(shots, `explorer-rename-${scheme}.png`) })
      await page.keyboard.press('Escape')
      assert.equal(await edit(page), undefined)
    }
    await pick(page, 'keep.txt')
    await page.keyboard.press('F2')
    await page.waitForSelector('.pad.shown .xp-row .xp-input')
    await page.keyboard.type('kept')
    await page.keyboard.press('Enter')
    await until('keep.txt renamed to kept.txt', () => existsSync(join(F, 'kept.txt')) && !existsSync(join(F, 'keep.txt')))
    await until('kept.txt row selected', async () => (await page.evaluate(() => window.__tether.explorer()!.rows)).some(r => r.name === 'kept.txt' && r.selected))
    // the open note's file renamed: the note follows
    await pick(page, 'novo.md')
    await page.keyboard.press('F2')
    await page.waitForSelector('.pad.shown .xp-row .xp-input')
    await page.keyboard.type('renomeado')
    await page.keyboard.press('Enter')
    await until('novo.md renamed on disk', () => existsSync(join(F, 'renomeado.md')) && !existsSync(join(F, 'novo.md')))
    await until('the note follows the rename', async () => {
      const ns = await page.evaluate(() => window.__tether.notes())
      return ns.some(n => /renomeado\.md$/.test(n.path)) && !ns.some(n => /novo\.md$/.test(n.path))
    })

    // ---- 5. delete: cancel keeps it, confirm sends it to the trash ----
    await setTheme(page, 'light')
    await pick(page, 'notes.md')
    await page.keyboard.press('Delete')
    await page.waitForSelector('dialog[data-dialog="explorer.delete"][open]')
    await sleep(250)
    await page.screenshot({ path: join(shots, 'explorer-delete-light.png') })
    await page.keyboard.press('Enter')
    await page.waitForSelector('dialog[data-dialog="explorer.delete"]', { state: 'detached' })
    assert.ok(existsSync(join(F, 'notes.md')), 'Enter takes "Manter": nothing deleted')
    await pick(page, 'notes.md')
    await page.keyboard.press('Delete')
    await page.waitForSelector('dialog[data-dialog="explorer.delete"][open]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog[data-dialog="explorer.delete"]', { state: 'detached' })
    assert.ok(existsSync(join(F, 'notes.md')), 'Esc deletes nothing')
    await setTheme(page, 'dark')
    await pick(page, 'notes.md')
    await page.keyboard.press('Delete')
    await page.waitForSelector('dialog[data-dialog="explorer.delete"][open]')
    await sleep(250)
    await page.screenshot({ path: join(shots, 'explorer-delete-dark.png') })
    await page.click('dialog[data-dialog="explorer.delete"] button.choice[data-choice="trash"]')
    await until('notes.md gone from the disk', () => !existsSync(join(F, 'notes.md')))
    await page.waitForSelector(rowSel('notes.md'), { state: 'detached' })

    // ---- 6. the guard in main ----
    const refused = await page.evaluate(([out, f, fsub]) => Promise.all([
      window.__tether.explorerWrite.trash(out!),
      window.__tether.explorerWrite.create(`${f}\\..\\..\\outside\\new.txt`, 'file'),
      window.__tether.explorerWrite.rename(`${f}\\kept.txt`, `${out!}\\..\\stolen.txt`),
      window.__tether.explorerWrite.trash(f!),
      window.__tether.explorerWrite.rename(f!, `${f}-x`),
      window.__tether.explorerWrite.trash(fsub!),
    ]), [join(outside, 'secret.txt'), F, join(F, 'missing.txt')])
    for (const r of refused) assert.equal(r.ok, false, JSON.stringify(r))
    assert.match(refused[0]!.message ?? '', /não está em um projeto aberto/)
    assert.ok(existsSync(join(outside, 'secret.txt')), 'outside the roots untouched')
    assert.ok(existsSync(join(F, 'kept.txt')))
    assert.equal(existsSync(join(outside, 'new.txt')), false)
    assert.ok(existsSync(F), 'the root is never trashed')

    // ---- 7. copy path / copy relative path ----
    await menu(page, 'kept.txt', 'Copiar caminho')
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), join(F, 'kept.txt'))
    await menu(page, 'sub', 'Copiar caminho relativo')
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), join('docs', 'sub'))

    // ---- 8. "Novo painel aqui" ----
    await menu(page, 'docs', 'Novo painel aqui…')
    await page.waitForSelector('#dlg-new[open]')
    await until('the chooser on docs', async () => (await page.inputValue('#dlg-new .ch-path-input')).replace(/[\\/]+$/, '') === join(F, 'docs'))
    await page.keyboard.press('Escape')
    await page.waitForSelector('#dlg-new[open]', { state: 'detached' })
  } finally {
    if (app && clipboardBefore !== undefined) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), clipboardBefore).catch(() => {})
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
