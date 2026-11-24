// E2E of the right-click menu of a link (app/renderer/link-menu.ts, link-menu-rules.ts), against the real tetherd on a private
// home/pipe, hidden window, PowerShell panes:
//   1. in a terminal, a printed http link, a tether://tab link (a pane with a tab, and a slot without one) and a path that exists:
//      the pointer over each one and a right click open the menu with the rows and the hints of its kind; "Copiar link" and
//      "Copiar caminho" fill the clipboard (the text that was there is saved first and put back at the end); "Ir para a guia"
//      brings the tab forward; "Espiar" opens the peek card;
//   2. Alt+click on a link to a slot without a tab opens the peek card too (the terminal never sees that press);
//   3. a right click outside any link opens no menu;
//   4. in a markdown preview, a right click on a link opens the link's menu and on plain text the pane's menu as before;
//   5. capture: l1-menu-terminal.png (the menu of a pane link open in the terminal).
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
  peek(slotId: string): void
  peekState(): { open: boolean; slotId?: string; routed: boolean }
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
  openNote(path: string): Promise<void>
  notes(): { id: string; text: string }[]
  previews(): { id: string }[]
  previewRect(id: string, selector: string): { x: number; y: number; width: number; height: number } | undefined
}
declare const window: { __tether: Hooks }
declare const document: any

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-linkmenu-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

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

async function detachPane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`.tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
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
const menuOpen = (page: Page): Promise<boolean> => page.evaluate(() => document.getElementById('ctx-menu') !== null)

/** Right click on the link under the pointer; returns the menu's rows. */
async function rightClick(page: Page, p: { x: number; y: number }): Promise<string[]> {
  await over(page, p)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForSelector('#ctx-menu')
  return menuRows(page)
}
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.getElementById('ctx-menu') === null)
  await page.mouse.move(5, 5)
}
const pick = (page: Page, label: string): Promise<void> => page.locator('#ctx-menu li', { hasText: label }).first().click()
const waitClosed = (page: Page): Promise<unknown> => page.waitForSelector('#peek', { state: 'hidden' })

test('menu de link: botão direito no terminal (http, guia, arquivo), Alt+clique espia, fora de link nada, prévia de markdown', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-linkmenu-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-lm-files-'))
  const filePath = join(base, 'alvo.ts')
  writeFileSync(filePath, 'export const x = 1\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let savedClip: string | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    savedClip = await app.evaluate(({ clipboard }) => clipboard.readText())
    const clip = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText())
    const clipBecomes = async (text: string): Promise<void> => { for (let i = 0; i < 30 && (await clip()) !== text; i++) await sleep(100); assert.equal(await clip(), text) }
    // The system is never asked to open anything.
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; shell.openPath = async () => '' })

    const host = await createShell(page, base)
    const tabbed = await createShell(page, base) // a pane with a tab, hidden behind the host's
    const loose = await createShell(page, base)
    await detachPane(page, loose) // a slot with no tab: only the peek card can show it
    await focusPane(page, host)

    // ---- 1. the menus of a terminal's links ----
    console.log('step 1')
    const url = await print(page, host, 'http://local', 'host:9/x')
    const tabUrl = await print(page, host, 'tether://ta', `b/${tabbed}`)
    const looseUrl = await print(page, host, 'tether://ta', `b/${loose}`)
    const fileText = await print(page, host, filePath.slice(0, 12), filePath.slice(12))

    const urlRows = await rightClick(page, await pointOf(page, host, url))
    assert.deepEqual(urlRows, ['Abrir no navegador do sistema [Ctrl+clique]', '-', 'Copiar link'])
    await pick(page, 'Copiar link')
    await clipBecomes(url)
    assert.equal(await menuOpen(page), false, 'a pick closes the menu')

    const tabRows = await rightClick(page, await pointOf(page, host, tabUrl))
    assert.deepEqual(tabRows, ['Ir para a guia [Ctrl+clique]', 'Espiar [Alt+clique]', '-', 'Copiar link'])
    await pick(page, 'Ir para a guia')
    await page.waitForFunction(id => window.__tether.activeId() === id, tabbed)
    await focusPane(page, host)

    const looseRows = await rightClick(page, await pointOf(page, host, looseUrl))
    assert.deepEqual(looseRows, ['Ir para a guia [Ctrl+clique]', 'Espiar [Alt+clique]', '-', 'Copiar link'])
    await page.screenshot({ path: join(shots, 'l1-menu-terminal.png') })
    await pick(page, 'Copiar link')
    await clipBecomes(looseUrl)
    await rightClick(page, await pointOf(page, host, looseUrl))
    await pick(page, 'Espiar')
    await page.waitForSelector('#peek[data-open="true"]')
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id }, loose)
    await page.evaluate(() => window.__tether.runCommand('peek.close'))
    await waitClosed(page)
    await focusPane(page, host)

    const fileRows = await rightClick(page, await pointOf(page, host, fileText))
    assert.deepEqual(fileRows, ['Abrir [Ctrl+clique]', 'Abrir ao lado', '-', 'Mostrar na pasta do sistema', '-', 'Copiar caminho', 'Copiar caminho relativo'])
    await pick(page, 'Copiar caminho')
    for (let i = 0; i < 30 && !(await clip()).toLowerCase().endsWith('alvo.ts'); i++) await sleep(100)
    assert.equal((await clip()).replace(/\\/g, '/').toLowerCase(), filePath.replace(/\\/g, '/').toLowerCase())

    // ---- 2. Alt+click on a link to a slot without a tab peeks at it ----
    console.log('step 2')
    const lp = await pointOf(page, host, looseUrl)
    await over(page, lp)
    await page.keyboard.down('Alt')
    await page.mouse.down(); await page.mouse.up()
    await page.keyboard.up('Alt')
    await page.waitForSelector('#peek[data-open="true"]')
    await page.waitForFunction(id => { const s = window.__tether.peekState(); return s.open && s.slotId === id }, loose)
    await page.evaluate(() => window.__tether.runCommand('peek.close'))
    await waitClosed(page)
    await focusPane(page, host)

    // ---- 3. outside any link: no menu of ours ----
    console.log('step 3')
    const box = (await page.locator(`.panel[data-slot-id="${host}"] .xterm-screen`).boundingBox())!
    const empty = { x: box.x + box.width - 20, y: box.y + box.height - 10 }
    await over(page, empty)
    await page.mouse.click(empty.x, empty.y, { button: 'right' })
    await sleep(500)
    assert.equal(await menuOpen(page), false, 'right click outside a link opens no menu')

    // ---- 4. markdown preview ----
    console.log('step 4')
    const mdPath = join(base, 'ligacoes.md')
    writeFileSync(mdPath, `# Ligações\n\nTexto simples sem ligação nenhuma aqui.\n\n[site](http://localhost:9/y) e [guia](tether://tab/${tabbed}).\n`)
    await page.evaluate(path => window.__tether.openNote(path), mdPath)
    await page.waitForFunction(() => window.__tether.notes().length === 1 && window.__tether.notes()[0]!.text.length > 0)
    const note = (await page.evaluate(() => window.__tether.notes()))[0]!
    await page.locator(`.note-panel[data-note-id="${note.id}"] .monaco-editor`).click()
    await page.keyboard.press('Control+Shift+V')
    await page.waitForFunction(() => window.__tether.previews().length === 1)
    const pid = (await page.evaluate(() => window.__tether.previews()))[0]!.id
    await page.waitForFunction(id => window.__tether.previewRect(id, 'a[href^="http"]') !== undefined, pid)
    const centre = async (sel: string): Promise<{ x: number; y: number }> => {
      const r = (await page.evaluate(([id, s]) => window.__tether.previewRect(id!, s!), [pid, sel]))!
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    const web = await centre('a[href^="http"]')
    await page.mouse.click(web.x, web.y, { button: 'right' })
    await page.waitForSelector('#ctx-menu')
    assert.deepEqual(await menuRows(page), ['Abrir no navegador do sistema [Ctrl+clique]', '-', 'Copiar link'])
    await closeMenu(page)
    const guide = await centre('a[href^="tether"]')
    await page.mouse.click(guide.x, guide.y, { button: 'right' })
    await page.waitForSelector('#ctx-menu')
    assert.deepEqual(await menuRows(page), ['Ir para a guia [Ctrl+clique]', 'Espiar [Alt+clique]', '-', 'Copiar link'])
    await closeMenu(page)
    const plain = await centre('h1')
    await page.mouse.click(plain.x, plain.y, { button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const plainRows = await menuRows(page)
    assert.ok(plainRows.length > 0 && !plainRows.some(r => r.includes('[Ctrl+clique]')), `on plain text the pane menu opens, not a link menu: ${plainRows.join(' | ')}`)
    await closeMenu(page)
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
    for (const dir of [home, base]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
