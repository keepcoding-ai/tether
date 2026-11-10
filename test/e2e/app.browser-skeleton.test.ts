// E2E of the browser extension's skeleton (Tether Browser E1), shells only (hidden window, private home/pipe, real tetherd,
// CLAUDE* stripped), the product build (no test extensions): the pill "Browser" sits beside the Drawer's, toggles to the
// empty desk and back; the pad "Guias" is on the left bar and opens with the empty state, plus the line that leads to the
// setting while `browser.serveToAgents` is off (its default).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = { activeDesk(): string; desks(): { id: string }[]; connection(): { connected: boolean; pid?: number } | undefined }
type El = { textContent: string | null; getAttribute(n: string): string | null; previousElementSibling: { id: string } | null }
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(s: string): Iterable<El>; querySelector(s: string): El | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-brsk-${process.pid}`
const DESK = 'browser.desk'
const PAD = 'browser.tabs'
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
  try { await page.waitForSelector('#conn.on', { timeout: 30_000 }) } catch (e) { await killElectron(app, root).catch(() => {}); throw e }
  return { app, page }
}

test('browser skeleton: pill, empty desk and the pad Guias with its empty state', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-brsk-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const [d1] = await page.evaluate(() => window.__tether.desks().map(d => d.id)) as [string]

    // The pill "Browser" beside the Drawer's, not in the queue.
    const pills = await page.evaluate(() => [...document.querySelectorAll('#desk-switch .seg.sys')].map(el => ({ id: el.getAttribute('data-system'), text: el.textContent, pressed: el.getAttribute('aria-pressed'), after: el.previousElementSibling?.id ?? '' })))
    assert.deepEqual(pills, [{ id: DESK, text: 'Browser', pressed: 'false', after: 'btn-drawer' }])
    assert.deepEqual(await page.evaluate(() => window.__tether.desks().map(d => d.id)), [d1], 'the queue does not list it')

    // It toggles to the empty desk and back.
    await page.click(`#desk-switch .seg.sys[data-system="${DESK}"]`)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), DESK)
    await page.click(`#desk-switch .seg.sys[data-system="${DESK}"]`)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), d1)

    // The pad Guias on the left bar: opens with the empty state, and the line to the setting (serveToAgents is perProfile by default).
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.br-pad [data-state="empty"]', { state: 'visible' })
    const text = await page.evaluate(() => document.querySelector('.br-pad [data-state="empty"]')!.textContent)
    assert.match(text ?? '', /Nenhuma guia aberta\. Quando um agente abrir uma, ela aparece aqui\./)
    assert.match(text ?? '', /perfil marcado/)
    await page.waitForSelector('.br-pad button[data-action="open-profiles"]', { state: 'visible' })
    await page.waitForSelector('.br-pad button[data-action="open-settings"]', { state: 'visible' })
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
