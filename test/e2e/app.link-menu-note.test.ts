// E2E of the right-click menu of a link in the note editor (app/renderer/monaco-links.ts installNoteLinkMenu): against the real
// tetherd on a private home/pipe, hidden window, one PowerShell pane:
//   1. a right click on a tether://tab link shows "Ir para a guia" / "Espiar" / "Copiar link" (with their key hints) on top, a
//      separator, and under it exactly the rows of the editor's own menu (read from a right click on plain text);
//   2. a right click on an http link shows the rows of http; "Copiar link" fills the clipboard (the text that was there is saved
//      first and put back at the end);
//   3. a right click off a link shows the editor's own menu, as before;
//   4. capture: l3-menu-note.png.
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
  connection(): { connected: boolean; pid?: number } | undefined
  text(slotId: string): string
  openNote(path: string): Promise<void>
  notes(): { id: string; text: string }[]
}
declare const window: { __tether: Hooks }
declare const document: any

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PEEK_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar/l3'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-linkmenu-note-${process.pid}`

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

/** Rows of Monaco's menu (it lives in a shadow root): "label [hint]", "-" for a separator. */
const menuRows = (page: Page): Promise<string[]> => page.evaluate(() => {
  for (const host of Array.from(document.querySelectorAll('.shadow-root-host')) as any[]) {
    const menu = host.shadowRoot?.querySelector('.monaco-menu')
    if (!menu) continue
    const out: string[] = []
    for (const li of Array.from(menu.querySelectorAll('li.action-item')) as any[]) {
      const label = li.querySelector('.action-label')
      if (!label || label.classList.contains('separator')) { out.push('-'); continue }
      const hint = li.querySelector('.keybinding')?.textContent
      out.push(hint ? `${label.textContent} [${hint}]` : String(label.textContent))
    }
    return out
  }
  return []
})
const menuIsOpen = (page: Page): Promise<boolean> => page.evaluate(() => Array.from(document.querySelectorAll('.shadow-root-host') as any[]).some(h => h.shadowRoot?.querySelector('.monaco-menu')))

/** The centre of `needle` inside the rendered line of the note that holds it. */
async function pointOf(page: Page, noteId: string, needle: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(([id, n]) => {
    for (const line of Array.from(document.querySelectorAll(`.note-panel[data-note-id="${id}"] .view-line`)) as any[]) {
      const text = String(line.textContent).replace(/\u00a0/g, ' ')
      const at = text.indexOf(n)
      if (at < 0) continue
      const walker = document.createTreeWalker(line, 4 /* NodeFilter.SHOW_TEXT */)
      let offset = 0
      for (let node = walker.nextNode() as any; node; node = walker.nextNode()) {
        const len = node.textContent.length
        const mid = at + Math.floor(n.length / 2)
        if (mid < offset + len) {
          const r = document.createRange()
          r.setStart(node, mid - offset); r.setEnd(node, mid - offset + 1)
          const b = r.getBoundingClientRect()
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        }
        offset += len
      }
    }
    return undefined
  }, [noteId, needle] as [string, string])
  assert.ok(p, `${needle} is rendered`)
  return p
}

async function rightClickAt(page: Page, p: { x: number; y: number }): Promise<string[]> {
  await page.mouse.move(5, 5)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.shadow-root-host') as any[]).some(h => h.shadowRoot?.querySelector('.monaco-menu')))
  await sleep(200)
  return menuRows(page)
}
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('.shadow-root-host') as any[]).some(h => h.shadowRoot?.querySelector('.monaco-menu')))
}

test('menu de link no editor de notas: linhas do link no topo do menu do editor; fora de link o menu é o de sempre', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-linkmenu-note-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-lmn-files-'))
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
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; shell.openPath = async () => '' })

    // A pane the guide link names (a slot the app knows, so "Espiar" is offered).
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', base)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.click('#dlg-new .btn.primary.go')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(() => window.__tether.panelIds().length === 1)
    const slot = (await page.evaluate(() => window.__tether.panelIds()))[0]!

    const mdPath = join(base, 'ligacoes.md')
    writeFileSync(mdPath, `Texto simples sem ligacao nenhuma aqui\n\nsite http://localhost:9/y fim\n\nguia tether://tab/${slot} fim\n`)
    await page.evaluate(path => window.__tether.openNote(path), mdPath)
    await page.waitForFunction(() => window.__tether.notes().length === 1 && window.__tether.notes()[0]!.text.length > 0)
    const noteId = (await page.evaluate(() => window.__tether.notes()))[0]!.id
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await sleep(1500) // the link provider answers

    // Off a link: the editor's own menu (the reference of the rows under the link's).
    const plain = await rightClickAt(page, await pointOf(page, noteId, 'sem ligacao'))
    assert.ok(plain.length > 0, 'the editor menu opens on plain text')
    assert.ok(!plain.some(r => r.includes('Copiar link') || r.includes('Ctrl+clique')), `no link rows off a link: ${plain.join(' | ')}`)
    await closeMenu(page)

    // A tether://tab link.
    const guide = await rightClickAt(page, await pointOf(page, noteId, `tab/${slot.slice(0, 8)}`))
    const top = ['Ir para a guia [Ctrl+clique]', 'Espiar [Alt+clique]', '-', 'Copiar link']
    assert.deepEqual(guide.slice(0, top.length), top)
    assert.deepEqual(guide.slice(top.length), ['-', ...plain], 'under the link rows, a separator and the editor menu as it is')
    await page.screenshot({ path: join(shots, 'l3-menu-note.png') })
    await closeMenu(page)

    // An http link; "Copiar link" copies it.
    const web = await rightClickAt(page, await pointOf(page, noteId, 'localhost:9'))
    const webTop = ['Abrir no navegador do sistema [Ctrl+clique]', 'Abrir no navegador do tether', 'Abrir ao lado', '-', 'Copiar link']
    assert.deepEqual(web.slice(0, webTop.length), webTop)
    assert.deepEqual(web.slice(webTop.length), ['-', ...plain])
    await page.locator('.monaco-menu .action-label', { hasText: 'Copiar link' }).first().click()
    for (let i = 0; i < 30 && (await clip()) !== 'http://localhost:9/y'; i++) await sleep(100)
    assert.equal(await clip(), 'http://localhost:9/y')
    assert.equal(await menuIsOpen(page), false, 'a pick closes the menu')

    // Off a link again: nothing of the link leaks into the menu.
    const again = await rightClickAt(page, await pointOf(page, noteId, 'sem ligacao'))
    assert.deepEqual(again, plain)
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
