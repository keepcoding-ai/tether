// E2E of the extensions' marks (agent door, slice R2) with the door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in this
// process on a private home and pipe, the real app on the same pipe, hidden window. No agent process, no LLM.
//   1. a menu row whose icon name the app does not have draws without an icon and does not take the menu down;
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  openSlot(id: string): Promise<void>
  switchDesk(id: string): void
  openNote?(path: string): Promise<void>
  ext: Record<string, Record<string, unknown>>
}
declare const window: { __tether: Hooks; tether: { request(r: unknown): Promise<{ slot?: { slotId: string } }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')

before(() => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
})

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

/** Runs `body` with the app on a private daemon; everything is closed after, by identity. */
async function withApp(body: (page: Page, home: string) => Promise<void>): Promise<void> {
  const home = tempHome()
  const pipe = uniquePipe(home)
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, log: () => {} })
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await body(page, home)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
}

const menuLabels = (page: Page): Promise<string[]> => page.locator('#ctx-menu li').allInnerTexts().then(ts => ts.map(t => t.trim()))

test('door marks: a menu row with an unknown icon name draws without an icon and the menu opens', { timeout: 300_000 }, async () => {
  await withApp(async (page, home) => {
    const id = await page.evaluate(async cwd => (await window.tether.request({ t: 'create', kind: 'shell', cwd, name: 'SondaIcone', start: false })).slot!.slotId, home)
    await page.waitForTimeout(500)
    await page.evaluate(id => window.__tether.openSlot(id), id)
    const tab = page.locator('.tether-tab', { hasText: 'SondaIcone' }).first()
    await tab.waitFor()
    await tab.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    const row = page.locator('#ctx-menu li', { hasText: 'Item da sonda (ícone que não existe)' })
    assert.equal(await row.count(), 1, `the row is in the menu (${(await menuLabels(page)).join(' | ')})`)
    assert.equal(await row.locator('svg').count(), 0, 'no icon is drawn for a name the app does not have')
    const known = page.locator('#ctx-menu li', { hasText: /^Fechar/ }).first()
    assert.ok(await known.locator('svg').count() > 0, 'the rows with a valid icon keep theirs')
  })
})
