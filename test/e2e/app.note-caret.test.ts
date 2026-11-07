// E2E of the note editor's caret: after typing a long line the caret must sit at the right edge of the last
// rendered glyph (within 2 px). It drifts right when Monaco measured character widths with a fallback font
// instead of the bundled web font (app/renderer/monaco.ts remeasureEditorFonts).
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { clickMenuItem } from './menu-helpers.ts'

type Hooks = { panelIds(): string[]; notes(): { id: string }[]; connection(): { connected: boolean; pid?: number } | undefined; activate(id: string): void }
declare const window: { __tether: Hooks }
declare const document: {
  querySelector(sel: string): { getBoundingClientRect(): { left: number } } | null
  querySelectorAll(sel: string): ArrayLike<{ lastChild: { textContent: string | null } | null }> & { length: number }
  createRange(): { setStart(n: unknown, o: number): void; setEnd(n: unknown, o: number): void; getBoundingClientRect(): { right: number } }
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-caret-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function caretGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cursor = document.querySelector('.monaco-editor .cursors-layer .cursor')!.getBoundingClientRect()
    // The right edge of the last glyph: a Range over the line's last text node.
    const spans = document.querySelectorAll('.monaco-editor .view-lines .view-line > span > span')
    const last = spans[spans.length - 1]!.lastChild!
    const range = document.createRange()
    range.setStart(last, 0)
    range.setEnd(last, last.textContent!.length)
    return cursor.left - range.getBoundingClientRect().right
  })
}

test('app note caret: sits at the end of the typed text (font measured after the web font loaded)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-caret-'))
  const repo = mkdtempSync(join(tmpdir(), 'tether-caret-repo-'))
  mkdirSync(join(repo, '.git'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    env.TETHER_PIPE = pipe
    env.TETHER_HOME = home
    env.TETHER_E2E_HIDDEN = '1'
    const a = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    app = a
    const p = await a.firstWindow()
    p.setDefaultTimeout(15_000)
    p.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    await p.waitForSelector('#conn.on', { timeout: 30_000 })
    await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    return { app: a, page: p }
  }
  try {
    let page: Page
    ;({ page } = await launch())
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const before = await page.locator('.tether-tab').count()
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', repo)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await clickMenuItem(page, 'note.new')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const dlg = page.locator('dialog.ask[data-dialog="note-gitignore"][open]')
    if (await dlg.count()) { await dlg.locator('button.choice').first().click() }
    const editor = page.locator('.note-panel .monaco-editor').first()
    await editor.click()
    for (const text of ['criar um painel lateral para a fra', 'WWWW iiii mmmm criar um painel lateral para a fra criar um painel lateral para a fra']) {
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')
      await page.keyboard.type(text)
      await page.waitForTimeout(400) // the smooth caret animation settles
      const gap = await caretGap(page)
      assert.ok(Math.abs(gap) <= 2, `caret ${gap.toFixed(1)}px from the end of "${text.slice(0, 20)}…"`)
    }
    // The note comes back with the restored layout: its editor is created while the page is still loading fonts.
    await page.waitForTimeout(800) // the layout (300 ms debounce) lands
    await killElectron(app!, root)
    app = undefined
    ;({ page } = await launch())
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    await page.waitForFunction(() => document.querySelectorAll('.monaco-editor .view-line').length > 0)
    await page.waitForTimeout(600)
    const restored = await caretGap(page)
    assert.ok(Math.abs(restored) <= 2, `restored note: caret ${restored.toFixed(1)}px from the end of the text`)
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
  }
})
