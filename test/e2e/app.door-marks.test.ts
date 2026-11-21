// E2E of the extensions' marks (agent door, slice R2) with the door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in this
// process on a private home and pipe, the real app on the same pipe, hidden window. No agent process, no LLM.
//   1. a menu row whose icon name the app does not have draws without an icon and does not take the menu down;
//   2. the seal shows on a common desk pill, the orange count does not change, and everything goes when the extension goes;
//   3. the emblem shows on the right of a terminal tab and of a note tab and follows the pane when it changes desk. With
//      TETHER_MARKS_PRINTS set to a folder, two prints (light and dark theme) go there.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { agentHue } from '../../app/shared/agent-color.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  activeDesk(): string
  openSlot(id: string): Promise<void>
  switchDesk(id: string): void
  movePaneToDesk(slotId: string, deskId: string): void
  disposeExtension(id: string): void
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

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })

/** door.css is linked from index.html once the shell does it; until then the test lends it, so the geometry and the prints are the real ones. */
async function ensureDoorCss(page: Page): Promise<boolean> {
  const linked = await page.evaluate(() => [...document.styleSheets].some(sheet => (sheet.href ?? '').endsWith('door/door.css')))
  if (!linked) await page.addStyleTag({ path: join(root, 'app', 'renderer', 'door', 'door.css') })
  return linked
}

const pill = (page: Page, desk: string) => page.locator(`#desk-switch .seg[data-desk="${desk}"]`)
const tabOf = (page: Page, paneId: string) => page.locator(`.tether-tab[data-slot="${paneId}"]`)

test('door marks: the desk seal and the tab emblem', { timeout: 300_000 }, async () => {
  await withApp(async (page, home) => {
    await ensureDoorCss(page)
    // Two desks so the pill strip shows, a shell pane and a note.
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const shellId = await page.evaluate(async cwd => (await window.tether.request({ t: 'create', kind: 'shell', cwd, name: 'SondaShell', start: false })).slot!.slotId, home)
    await page.waitForTimeout(500)
    await page.evaluate(id => window.__tether.openSlot(id), shellId)
    const notePath = join(home, 'sonda-nota.md')
    writeFileSync(notePath, '# Sonda\n')
    await page.evaluate(p => window.__tether.openNote!(p), notePath)
    const noteTab = page.locator('.tether-tab.note', { hasText: 'sonda-nota' })
    await noteTab.waitFor()
    const noteId = (await noteTab.getAttribute('data-slot'))!
    await tabOf(page, shellId).waitFor()
    const hue = agentHue('claude-1')

    // ---- the seal on a common pill ----
    assert.equal(await pill(page, 'desk-2').locator('.desk-seal').count(), 0, 'no seal before the extension puts one')
    await probe(page, 'seal', 'desk-2', { icon: 'puzzle-piece', hue, tooltip: 'Dona: Atrium' })
    await pill(page, 'desk-2').locator('.desk-seal').waitFor()
    assert.match((await pill(page, 'desk-2').getAttribute('title')) ?? '', /Dona: Atrium/, 'the tooltip line joins the pill tooltip')
    assert.equal(await pill(page, 'desk-2').locator('.desk-seal svg').count(), 1, 'the glyph is drawn')
    assert.equal(await pill(page, 'desk-2').locator('.desk-seal').evaluate(el => (el as HTMLElement).style.getPropertyValue('--seal-hue')), String(hue))
    assert.equal(await pill(page, 'desk-2').locator('.cnt').count(), 0, 'a seal is not a count')

    // The orange count does not change: one attention on desk-1 reads 1 before, during and after a seal on that pill.
    await probe(page, 'raiseAttention', shellId)
    await pill(page, 'desk-1').locator('.desk-badge').waitFor()
    const count = (): Promise<string> => pill(page, 'desk-1').locator('.desk-badge').innerText()
    assert.equal(await count(), '1')
    await probe(page, 'seal', 'desk-1', { icon: 'puzzle-piece', tooltip: 'Sem cor' })
    await pill(page, 'desk-1').locator('.desk-seal').waitFor()
    assert.equal(await count(), '1', 'the orange count is the same with a seal on the pill')
    await probe(page, 'seal', 'desk-1', undefined)
    await page.waitForFunction(() => document.querySelectorAll('#desk-switch .seg[data-desk="desk-1"] .desk-seal').length === 0)
    assert.equal(await count(), '1', 'and the same after it is taken away')

    // ---- the emblem on the right of a terminal tab and of a note tab ----
    for (const [what, id] of [['terminal', shellId], ['note', noteId]] as const) {
      await probe(page, 'emblem', id, { icon: 'tag', hue, tooltip: `Emblema (${what})`, clickable: what === 'terminal' })
      const emblem = tabOf(page, id).locator(':scope > .ext-emblems .ext-emblem')
      await emblem.waitFor()
      const [text, kind, box] = await Promise.all([tabOf(page, id).locator('.text').boundingBox(), tabOf(page, id).locator('.kind').boundingBox(), emblem.boundingBox()])
      assert.ok(kind!.x < text!.x && text!.x < box!.x, `${what}: the emblem is on the right of the title (kind ${kind!.x}, text ${text!.x}, emblem ${box!.x})`)
      assert.equal(await tabOf(page, id).locator('.kind .ext-emblem').count(), 0, `${what}: nothing of the extension on the left`)
      assert.equal(await emblem.getAttribute('title'), `Emblema (${what})`)
    }
    // A click on the emblem reaches the extension.
    await tabOf(page, shellId).locator('.ext-emblem').click()
    assert.deepEqual(await probe<string[]>(page, 'emblemClicks'), [shellId])

    // It follows the pane to another desk and back.
    await page.evaluate(id => { window.__tether.movePaneToDesk(id, 'desk-2'); window.__tether.switchDesk('desk-2') }, shellId)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await tabOf(page, shellId).locator(':scope > .ext-emblems .ext-emblem').waitFor()
    assert.equal(await tabOf(page, shellId).locator('.ext-emblem').count(), 1, 'one emblem on the pane in its new desk')
    await page.evaluate(id => { window.__tether.movePaneToDesk(id, 'desk-1'); window.__tether.switchDesk('desk-1') }, shellId)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    await tabOf(page, shellId).locator(':scope > .ext-emblems .ext-emblem').waitFor()
    assert.equal(await tabOf(page, shellId).locator('.ext-emblem').count(), 1, 'one emblem again in the first desk')
    assert.equal(await tabOf(page, noteId).locator('.ext-emblem').count(), 1, 'the note kept its emblem')

    // ---- the prints: light and dark, the strip and the tabs ----
    const dir = process.env.TETHER_MARKS_PRINTS
    if (dir) {
      mkdirSync(dir, { recursive: true })
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme)
        await page.waitForTimeout(300)
        const strip = (await page.locator('#desk-switch').boundingBox())!
        const tab = (await tabOf(page, shellId).boundingBox())!
        const top = Math.max(0, Math.min(strip.y, tab.y) - 8)
        await page.screenshot({ path: join(dir, `r2-marcas-${scheme}.png`), clip: { x: 0, y: top, width: 1100, height: tab.y + tab.height + 12 - top } })
      }
    }

    // ---- everything goes with the extension ----
    await page.evaluate(() => window.__tether.disposeExtension('door-probe'))
    await page.waitForFunction(() => document.querySelectorAll('.ext-emblem, .desk-seal').length === 0)
    assert.equal(await tabOf(page, noteId).locator(':scope > .ext-emblems').evaluate(el => (el as HTMLElement).hidden), true, 'the emblem container is hidden again')
  })
})
