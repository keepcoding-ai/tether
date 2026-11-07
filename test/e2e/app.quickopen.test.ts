// E2E of Quick Open (F5, Ctrl+P): against the real tetherd on a private home/pipe, hidden window, a PowerShell
// pane opened in a temporary git repository.
//   1. Ctrl+P with no history: the hint naming the folder; 2. "apma" → appMain.ts first (VS Code's scorer), name
//   highlighted, folder beside it; .gitignore and node_modules respected; 3. Enter → a note tab in the shell's
//   tab group, TypeScript mode; 4. Ctrl+P from that note: same root, the recent file on top ("abertos
//   recentemente" above "resultados de arquivo"); 5. "x.ts:3" → cursor on line 3; 6. reopening a file focuses
//   its tab (no duplicate), "x.ts:2:4" moves the cursor of the open tab; 7. Ctrl+Enter opens beside;
//   screenshots quickopen-{dark,light}.png. Every kill goes through test/kill.ts (pid + creation time).
// Second test, launched the way the Start Menu shortcut can leave it: working directory outside the repo
// (System32), no rg on PATH, the pane in a folder that is not a git repository: Ctrl+P still lists with the
// app's rg (.gitignore honoured outside git: only rg does that); then a main process without the search handler
// (a window reloaded over an older main) makes the box say why instead of keeping the hint.
// Third test (F8 slice 6): Ctrl+P is scoped to the current project: two pinned projects alpha and beta, a pane in alpha's
// subfolder lists alpha's files only and the field's placeholder names "alpha"; a pane in beta lists beta's; a pane outside
// every project lists its own folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snap = { id: string; path: string; text: string; cursor?: { lineNumber: number; column: number } }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  palette(): { open: boolean; mode?: 'commands' | 'default'; shown: string[]; input: string }
  notes(): Snap[]
  note(id: string): Snap | undefined
  groupOf(id: string): string | undefined
  openFolder(path: string): void
}
declare const window: { __tether: Hooks; tether: { ext: { invoke(id: string, channel: string, ...args: unknown[]): Promise<unknown> } } }
type El = { textContent: string | null; dataset: Record<string, string>; getAttribute(n: string): string | null; querySelector(s: string): El | null }
declare const document: { activeElement: { closest(sel: string): unknown } | null; documentElement: { dataset: Record<string, string> }; querySelectorAll(sel: string): { length: number }; querySelector(sel: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-quickopen-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string, opts: { cwd?: string; path?: string } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  if (opts.path !== undefined) { for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]; env.PATH = opts.path }
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => { const d = window.__tether.deskOf(id); if (d) window.__tether.switchDesk(d); window.__tether.activate(id) }, id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}


const paletteState = (page: Page) => page.evaluate(() => window.__tether.palette())
const paletteOpen = (page: Page, open: boolean) => page.waitForFunction(o => window.__tether.palette().open === o, open)
const notes = (page: Page) => page.evaluate(() => window.__tether.notes())
const sameGroup = (page: Page, a: string, b: string) => page.evaluate(([x, y]) => window.__tether.groupOf(x!) === window.__tether.groupOf(y!), [a, b])

/** Waits until the box shows files (main lists the root in a worker) with `label` first; returns its path. */
async function firstFile(page: Page, label: string): Promise<string> {
  await page.waitForFunction(l => document.querySelector('#palette-list li.pal-item[data-file] .pal-title')?.textContent === l, label, { timeout: 15_000 })
  return (await page.locator('#palette-list li.pal-item[data-file]').first().getAttribute('data-file')) ?? ''
}

async function quickOpen(page: Page, text: string): Promise<void> {
  if (!(await paletteState(page)).open) { await page.keyboard.press('Control+P'); await paletteOpen(page, true) }
  await page.locator('#palette-input').fill('')
  await page.keyboard.type(text)
}

test('app quick open: Ctrl+P lists the pane folder\'s files (VS Code scorer), recents on top, Enter opens in the same group, file:line positions, reopening focuses the tab', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-quickopen-'))
  const repo = mkdtempSync(join(tmpdir(), 'tether-qo-repo-'))
  const files: Record<string, string> = {
    'src/appMain.ts': 'export function main(): void {\n  console.log("oi")\n}\n',
    'src/apple/map.ts': 'export const map = new Map()\n',
    'src/x.ts': 'linha 1\nlinha 2\n    linha 3 aqui\nlinha 4\n',
    'docs/readme.md': '# leia\n',
    'data.json': '{ "a": 1 }\n',
    'build.log': 'ignorado\n',
    'node_modules/dep/index.js': 'fora\n',
    '.gitignore': '*.log\n',
  }
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text) }
  spawnSync('git', ['init', '-q'], { cwd: repo })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await createShell(page, repo)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusPane(page, shell!)

    // 1. Ctrl+P with no history: no rows, the hint names the pane's folder.
    await page.keyboard.press('Control+P')
    await paletteOpen(page, true)
    assert.equal((await paletteState(page)).mode, 'default')
    await page.waitForFunction(() => /Digite para procurar arquivos em/.test(document.querySelector('#palette .pal-empty')?.textContent ?? ''))
    assert.match(await page.locator('#palette .pal-empty').innerText(), /Digite > para procurar um comando/)

    // 2. "apma" → appMain.ts first, matched letters highlighted, folder beside it; .gitignore and node_modules respected.
    await quickOpen(page, 'apma')
    const first = await firstFile(page, 'appMain.ts')
    assert.equal(first.toLowerCase(), join(repo, 'src', 'appMain.ts').toLowerCase())
    const row = page.locator('#palette-list li.pal-item[data-file]').first()
    assert.equal(await row.locator('.pal-title b').first().innerText(), 'ap')
    assert.equal(await row.locator('.qo-folder').innerText(), 'src')
    await shot(app, 'quickopen-dark')
    await quickOpen(page, 'index')
    await sleep(500)
    assert.ok(!(await paletteState(page)).shown.some(p => /node_modules/.test(p)), 'node_modules stays out')
    await quickOpen(page, 'build.log')
    await sleep(500)
    assert.ok(!(await paletteState(page)).shown.some(p => /build\.log$/.test(p)), '.gitignore respected')

    // 3. Enter on appMain.ts → a note tab in the shell's group, focused, TypeScript highlighting.
    await quickOpen(page, 'apma')
    await firstFile(page, 'appMain.ts')
    await page.keyboard.press('Enter')
    await paletteOpen(page, false)
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const [appNote] = await notes(page)
    assert.equal(appNote!.path.toLowerCase(), join(repo, 'src', 'appMain.ts').toLowerCase())
    assert.ok(await sameGroup(page, appNote!.id, shell!), 'same tab group as the shell')
    await page.waitForFunction(id => window.__tether.note(id)?.text.includes('console.log') ?? false, appNote!.id)
    await page.waitForFunction(id => window.__tether.activeId() === id, appNote!.id)
    assert.equal(await page.evaluate(id => document.querySelector(`[data-note-id="${id}"] .monaco-editor`)?.getAttribute('data-mode-id') ?? document.querySelector(`[data-note-id="${id}"] [data-mode-id]`)?.getAttribute('data-mode-id') ?? '', appNote!.id), 'typescript')

    // 4. Ctrl+P from the note: the same root (the note remembers it); the recent file on top.
    await page.keyboard.press('Control+P')
    await paletteOpen(page, true)
    await page.waitForFunction(() => document.querySelectorAll('#palette-list li.pal-item[data-kind="recent"]').length === 1)
    assert.equal(await page.locator('#palette-list .pal-sep').first().innerText(), 'abertos recentemente')
    await quickOpen(page, 'ts')
    await page.waitForFunction(() => document.querySelectorAll('#palette-list li.pal-item[data-kind="file"]').length >= 2)
    assert.equal(await page.locator('#palette-list li.pal-item').first().getAttribute('data-kind'), 'recent')
    assert.deepEqual(await page.locator('#palette-list .pal-sep').allInnerTexts(), ['abertos recentemente', 'resultados de arquivo'])

    // 5. "x.ts:3" → opens x.ts with the cursor on line 3, in the same group.
    await quickOpen(page, 'x.ts:3')
    await firstFile(page, 'x.ts')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tether.notes().length === 2)
    const xNote = (await notes(page)).find(n => n.path.toLowerCase().endsWith('x.ts'))!
    await page.waitForFunction(id => window.__tether.note(id)?.cursor?.lineNumber === 3, xNote.id)
    assert.ok(await sameGroup(page, xNote.id, shell!))

    // 6. Reopening appMain.ts focuses its tab (no duplicate); "x.ts:2:4" moves the cursor of the open tab.
    await quickOpen(page, 'apma')
    await firstFile(page, 'appMain.ts')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.activeId() === id, appNote!.id)
    assert.equal((await notes(page)).length, 2, 'no duplicate tab')
    await quickOpen(page, 'x.ts:2:4')
    await firstFile(page, 'x.ts')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => { const c = window.__tether.note(id)?.cursor; return c?.lineNumber === 2 && c.column === 4 }, xNote.id)
    assert.equal((await notes(page)).length, 2)

    // 7. Ctrl+Enter opens beside (another group).
    await quickOpen(page, 'readme')
    await firstFile(page, 'readme.md')
    await page.keyboard.press('Control+Enter')
    await page.waitForFunction(() => window.__tether.notes().length === 3)
    const readme = (await notes(page)).find(n => n.path.toLowerCase().endsWith('readme.md'))!
    assert.ok(!(await sameGroup(page, readme.id, shell!)), 'beside: another group')

    assert.equal(await page.evaluate(() => window.__tether.runCommand('theme.light')), 'ran')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await quickOpen(page, 'ts')
    await sleep(500)
    await shot(app, 'quickopen-light')
    await page.keyboard.press('Escape')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, repo]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})

/** PATH without any folder that holds an rg binary: the app must find its own. */
function pathWithoutRg(): string {
  const raw = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  return raw.split(delimiter).filter(d => d !== '' && !existsSync(join(d, name))).join(delimiter)
}

test('app quick open: launched outside the repo (cwd System32, no rg on PATH) it still lists with the app\'s rg; a failure is said in the box', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-quickopen-cwd-'))
  const dir = mkdtempSync(join(tmpdir(), 'tether-qo-plain-')) // no git: git ls-files cannot be the one listing
  for (const [p, text] of Object.entries({ 'CLAUDE.md': '# instruções\n', 'docs/clara.md': 'x\n', 'build.log': 'fora\n', '.gitignore': '*.log\n' })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text)
  }
  const cwd = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/'
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, { cwd, path: pathWithoutRg() }))
    assert.equal((await app.evaluate(() => process.cwd())).toLowerCase(), cwd.toLowerCase(), 'main runs outside the repo')
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await createShell(page, dir)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await focusPane(page, shell!)

    // "CLAUD" → CLAUDE.md first; build.log stays out (.gitignore outside git: rg's --no-require-git, not the own walk).
    await quickOpen(page, 'CLAUD')
    const first = await firstFile(page, 'CLAUDE.md')
    assert.equal(first.toLowerCase(), join(dir, 'CLAUDE.md').toLowerCase())
    await quickOpen(page, 'build')
    await sleep(500)
    assert.ok(!(await paletteState(page)).shown.some(p => /build\.log$/.test(p)), '.gitignore respected outside git')
    const direct = await page.evaluate(d => window.tether.ext.invoke('quick-open', 'search', d, 'CLA', []), dir) as { source?: string; error?: string } | null
    assert.equal(direct?.source, 'rg', 'the app\'s rg, resolved from the app folder and not from the cwd')
    assert.equal(direct?.error, undefined)

    // A main process without the search handler (a window reloaded over an older main): the box says why.
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler('ext:quick-open:search'))
    await quickOpen(page, 'CLAU')
    await page.waitForFunction(() => /Não consegui listar os arquivos de .*versão anterior.*Reiniciar o app/.test(document.querySelector('#palette .pal-empty')?.textContent ?? ''))
    assert.deepEqual((await paletteState(page)).shown, [])
    await shot(app, 'quickopen-error')
    await page.keyboard.press('Escape')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const d of [home, dir]) for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})

test('app quick open (F8 slice 6): Ctrl+P searches the project of the focused pane, names it in the field, and falls back to the pane folder', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-quickopen-proj-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-qo-proj-'))
  const A = join(base, 'alpha')
  const B = join(base, 'beta')
  const C = join(base, 'gamma')
  const expected = { alpha: ['a-only.ts', 'a-deep.ts'], beta: ['b-only.ts'], gamma: ['c-only.ts'] }
  for (const [p, text] of Object.entries({ 'alpha/a-only.ts': 'a', 'alpha/sub/a-deep.ts': 'a', 'beta/b-only.ts': 'b', 'gamma/c-only.ts': 'c' })) {
    mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), text)
  }
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(([a, b]) => { window.__tether.openFolder(a!); window.__tether.openFolder(b!) }, [A, B])

    const panes: Record<string, string> = {}
    for (const [name, cwd] of [['alpha', join(A, 'sub')], ['beta', B], ['gamma', C]] as const) {
      const before = await page.evaluate(() => window.__tether.panelIds())
      await createShell(page, cwd)
      panes[name] = (await page.evaluate(() => window.__tether.panelIds())).find(id => !before.includes(id))!
    }
    const listed = async (): Promise<string[]> => (await paletteState(page)).shown.map(p => p.split(/[\\/]/).at(-1)!).sort()

    for (const [name, files, placeholder] of [
      ['alpha', expected.alpha, /no projeto alpha/],
      ['beta', expected.beta, /no projeto beta/],
      ['gamma', expected.gamma, /em gamma/],
    ] as const) {
      await focusPane(page, panes[name]!)
      await page.keyboard.press('Control+P')
      await paletteOpen(page, true)
      await page.locator('#palette-input').fill('')
      await page.keyboard.type('.ts')
      await page.waitForFunction(n => document.querySelectorAll('#palette-list li.pal-item[data-file]').length === n, files.length, { timeout: 15_000 })
      await sleep(400)
      assert.deepEqual(await listed(), [...files].sort(), `${name}: only its own files`)
      assert.match((await page.locator('#palette-input').getAttribute('placeholder')) ?? '', placeholder, `${name}: the scope is named`)
      await page.keyboard.press('Escape')
      await paletteOpen(page, false)
    }
    // The commands mode puts the field's own placeholder back.
    await page.keyboard.press('Control+Shift+P')
    await paletteOpen(page, true)
    assert.doesNotMatch((await page.locator('#palette-input').getAttribute('placeholder')) ?? '', /no projeto|em gamma/)
    await page.keyboard.press('Escape')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const d of [home, base]) for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
