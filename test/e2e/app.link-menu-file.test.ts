// E2E of the file rows of a link's context menu (app/renderer/link-menu-rules.ts, main.ts runLinkRow), against the real tetherd on a
// private home/pipe, hidden window, PowerShell panes. A path printed in a terminal whose folder holds the file:
//   1. the menu reads: Abrir, Abrir ao lado, Mostrar no explorador do tether, Mostrar na pasta do sistema, Copiar caminho,
//      Copiar caminho relativo;
//   2. "Copiar caminho relativo" puts the path under the terminal's folder in the clipboard (src/api.ts);
//   3. "Mostrar no explorador do tether" opens the explorer's pad with that file's row selected and its folder expanded;
//   4. "Mostrar na pasta do sistema" calls shell.showItemInFolder with the file (the call is spied: no Explorer window opens);
//   5. a file outside the terminal's folder: the relative row is absent;
//   6. capture: l4-menu-arquivo.png.
// Every kill goes through test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  text(slotId: string): string
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
  addSlotPane(slotId: string): void
  explorer(): { rows: { path: string; kind: string; selected: boolean; expanded: boolean }[] } | undefined
}
declare const window: { __tether: Hooks }
declare const document: any

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.LINK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar/l4'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-linkfile-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const idsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await idsOf(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await idsOf(page)).find(x => !before.includes(x))!
  await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), id, { timeout: 30_000 })
  return id
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

/** Prints `parts` joined (the typed command never holds the printed text) and waits for it on the screen. */
async function print(page: Page, id: string, ...parts: string[]): Promise<string> {
  const printed = parts.join('')
  await page.keyboard.type(`Write-Output (${parts.map(p => `'${p}'`).join('+')})`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, needle]) => window.__tether.screenPos(id!, needle!) !== undefined, [id, printed] as [string, string])
  return printed
}

async function pointOf(page: Page, id: string, needle: string, offset = 2): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(([id, n]) => window.__tether.screenPos(id!, n!), [id, needle])
  assert.ok(pos, `${needle} is on screen`)
  const cell = (await page.evaluate(id => window.__tether.cellSize(id), id))!
  const box = (await page.locator(`.panel[data-slot-id="${id}"] .xterm-screen`).boundingBox())!
  return { x: box.x + (pos.col + offset + 0.5) * cell.width, y: box.y + (pos.row + 0.5) * cell.height }
}

/** The pointer over the text, long enough for the link provider to answer. */
async function over(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(5, 5)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
}

const menuRows = (page: Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = []
  for (const li of document.querySelectorAll('#ctx-menu > li') as any[]) {
    if (li.classList.contains('sep')) { out.push('-'); continue }
    const label = [...li.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('')
    const hint = li.querySelector('kbd')?.textContent
    out.push(hint ? `${label} [${hint}]` : label)
  }
  return out
})

async function rightClick(page: Page, p: { x: number; y: number }): Promise<string[]> {
  await over(page, p)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForSelector('#ctx-menu')
  return menuRows(page)
}
const pick = (page: Page, label: string): Promise<void> => page.locator('#ctx-menu li', { hasText: label }).first().click()

test('menu de link de arquivo: mostrar no explorador do tether, na pasta do sistema, copiar caminho relativo', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-linkfile-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-lf-a-'))
  const outside = mkdtempSync(join(tmpdir(), 'tether-lf-b-'))
  mkdirSync(join(base, 'src'))
  const inside = join(base, 'src', 'api.ts')
  const apart = join(outside, 'fora.ts')
  writeFileSync(inside, 'export const x = 1\n')
  writeFileSync(apart, 'export const y = 2\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let savedClip: string | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 800))
    savedClip = await app.evaluate(({ clipboard }) => clipboard.readText())
    const clip = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText())
    // The system is never asked to show or open anything: the calls are recorded instead.
    await app.evaluate(({ shell }) => {
      const calls: string[] = []
      ;(globalThis as any).__shown = calls
      shell.showItemInFolder = (p: string) => { calls.push(p) }
      shell.openExternal = async () => {}
      shell.openPath = async () => ''
    })

    // The explorer shows the folders of agent panes: an agent slot (not started) in `base` makes it a project.
    const made = await page.evaluate(body => (window as any).tether.request(body), { t: 'create', kind: 'claude', cwd: base, start: false })
    assert.equal(made.t, 'ok', `create claude: ${made.message ?? ''}`)
    await page.evaluate(id => window.__tether.addSlotPane(id), made.slot.slotId as string)
    const host = await createShell(page, base)
    await focusPane(page, host)
    const insideText = await print(page, host, inside.slice(0, 12), inside.slice(12))

    // ---- 1. the rows ----
    const rows = await rightClick(page, await pointOf(page, host, insideText))
    assert.deepEqual(rows, [
      'Abrir [Ctrl+clique]', 'Abrir ao lado', '-', 'Mostrar no explorador do tether', 'Mostrar na pasta do sistema', '-', 'Copiar caminho', 'Copiar caminho relativo',
    ])
    await page.screenshot({ path: join(shots, 'l4-menu-arquivo.png') })

    // ---- 2. copy relative ----
    await pick(page, 'Copiar caminho relativo')
    for (let i = 0; i < 30 && (await clip()) !== 'src/api.ts'; i++) await sleep(100)
    assert.equal(await clip(), 'src/api.ts')

    // ---- 3. show in the tether's explorer ----
    await rightClick(page, await pointOf(page, host, insideText))
    await pick(page, 'Mostrar no explorador do tether')
    await page.waitForFunction(p => {
      const rows = window.__tether.explorer()?.rows ?? []
      return rows.some(r => r.path.replace(/\\/g, '/').toLowerCase() === p && r.selected)
    }, norm(inside), { timeout: 15_000 })
    const shown = (await page.evaluate(() => window.__tether.explorer()!.rows)).filter(r => norm(base).startsWith(norm(r.path)) || norm(inside).startsWith(norm(r.path) + '/'))
    assert.ok(shown.some(r => r.kind === 'dir' && r.expanded && norm(r.path) === norm(join(base, 'src'))), 'the file\'s folder is open in the tree')
    await page.screenshot({ path: join(shots, 'l4-explorador.png') })

    // ---- 4. show in the system's folder (spied) ----
    await focusPane(page, host)
    await rightClick(page, await pointOf(page, host, insideText))
    await pick(page, 'Mostrar na pasta do sistema')
    let calls: string[] = []
    for (let i = 0; i < 30 && calls.length === 0; i++) { calls = await app.evaluate(() => (globalThis as any).__shown as string[]); if (!calls.length) await sleep(100) }
    assert.deepEqual(calls.map(norm), [norm(inside)])

    // ---- 5. a file outside the terminal's folder: no relative row ----
    await focusPane(page, host)
    const apartText = await print(page, host, apart.slice(0, 12), apart.slice(12))
    const outRows = await rightClick(page, await pointOf(page, host, apartText))
    assert.deepEqual(outRows, ['Abrir [Ctrl+clique]', 'Abrir ao lado', '-', 'Mostrar na pasta do sistema', '-', 'Copiar caminho'], 'outside every folder the explorer shows: no explorer row, no relative row')
    await page.keyboard.press('Escape')
  } finally {
    if (app) {
      if (savedClip !== undefined) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClip).catch(() => {})
      await killElectron(app, root).catch(e => console.error(String(e)))
    }
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, base, outside]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
