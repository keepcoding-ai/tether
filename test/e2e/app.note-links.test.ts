// E2E of the note editor's links: Ctrl+click on a tether://tab/<id> line in a note brings that tab up (a plain click only
// edits). The same handler as the terminal's (app/renderer/monaco-links.ts → link-open.ts → main.ts followTetherLink).
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { clickMenuItem } from './menu-helpers.ts'

type Hooks = { notes(): { id: string }[]; connection(): { connected: boolean; pid?: number } | undefined; activeId(): string | undefined }
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-notelinks-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

test('app note links: Ctrl+click on a tether://tab link activates that tab; a plain click only edits', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-notelinks-'))
  const repo = mkdtempSync(join(tmpdir(), 'tether-notelinks-repo-'))
  mkdirSync(join(repo, '.git'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    env.TETHER_PIPE = pipe
    env.TETHER_HOME = home
    env.TETHER_E2E_HIDDEN = '1'
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const before = await page.locator('.tether-tab').count()
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', repo)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
    const tabId = (await page.evaluate(() => window.__tether.activeId()))!
    assert.ok(tabId, 'the new terminal tab is active')

    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await clickMenuItem(page, 'note.new')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const dlg = page.locator('dialog.ask[data-dialog="note-gitignore"][open]')
    if (await dlg.count()) { await dlg.locator('button.choice').first().click() }
    await page.locator('.note-panel .monaco-editor').first().click()
    await page.keyboard.type(`> Guia do agente: tether://tab/${tabId}`)
    await page.waitForTimeout(800) // Monaco's link detection settles
    assert.notEqual(await page.evaluate(() => window.__tether.activeId()), tabId, 'the note is the active panel')

    const box = (await page.locator('.note-panel .monaco-editor .view-line').first().boundingBox())!
    const x = box.x + 150, y = box.y + box.height / 2
    await page.mouse.click(x, y) // plain click: only places the caret
    await page.waitForTimeout(300)
    assert.notEqual(await page.evaluate(() => window.__tether.activeId()), tabId, 'a plain click does not follow')
    await page.keyboard.down('Control')
    await page.mouse.move(x, y, { steps: 3 })
    await page.waitForTimeout(300)
    await page.mouse.down(); await page.mouse.up()
    await page.keyboard.up('Control')
    await page.waitForFunction(id => window.__tether.activeId() === id, tabId, { timeout: 10_000 })
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
  }
})
