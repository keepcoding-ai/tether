// E2E of the tab's own × (a real mouse click, not the test hook): closing the tab of a running shell asks
// (close-panel-live); "Encerrar o shell" really stops the slot. Private home/pipe, hidden window.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

declare const window: { __tether: { panelIds(): string[]; slots(): SlotState[]; text(id: string): string; connection(): { pid?: number } | undefined } }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-tabclose-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

test('tab ×: a running shell asks before closing, and "Encerrar" stops it', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-tabclose-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  Object.assign(env, { TETHER_PIPE: pipe, TETHER_HOME: home, TETHER_E2E_HIDDEN: '1' })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page: Page = await app.firstWindow()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    const pid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(pid, 'the app spawned a tetherd')
    daemons.push(await claim(pid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', root)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
    const id = (await page.evaluate(() => window.__tether.panelIds()))[0]!
    await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })

    const tab = page.locator('.tether-tab').first()
    await tab.hover()
    await tab.locator('button.close').click()
    const dlg = page.locator('dialog.ask[data-dialog="close-panel-live"][open]')
    await dlg.waitFor()
    await dlg.locator('button.choice.destructive[data-choice="stop"]').click()
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), id)
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status !== 'running', id, { timeout: 15_000 })
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
