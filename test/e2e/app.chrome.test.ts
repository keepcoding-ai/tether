// E2E of the phase 4 chrome (visual redesign, PLAN.md "Fase 4"), against the real tetherd on a private home/pipe,
// hidden window, shells only. Slice 1 (tokens, surfaces, cards):
//   1. the new tokens resolve per scheme (--desk-bg, --frame-bg, …) and the toolbar/window paint --desk-bg;
//   2. frames are cards: radius, 1 px border, --frame-bg, a --gap gutter between two cards;
//   3. panes inside a card are separated by the --pane-divider line; the desk-level gutter draws no line;
//   4. the "+" still appears at a card's edge (frame) and in the outer gutter (desk), on the card's border;
//   5. small screenshots chrome-cards-{light,dark}.png (compare with preview-{light,dark}.png, preview-shot.ts).
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  frameIds(): string[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  activeId(): string | undefined
}
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
declare const window: { __tether: Hooks; getComputedStyle(el: unknown, pseudo?: string): Record<string, string> & { getPropertyValue(n: string): string } }
declare const document: {
  querySelectorAll(selector: string): ArrayLike<{ getBoundingClientRect(): Rect }> & { length: number }
  querySelector(selector: string): { getBoundingClientRect(): Rect } | null
  documentElement: unknown
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-chrome-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const TOKENS = {
  dark: { '--desk-bg': '#141418', '--frame-bg': '#1e1e23', '--frame-border': 'rgba(255, 255, 255, .08)', desk: 'rgb(20, 20, 24)', frame: 'rgb(30, 30, 35)', border: 'rgb(53, 53, 61)', windowBg: '#141418' },
  light: { '--desk-bg': '#e7e9ed', '--frame-bg': '#fbfbfd', '--frame-border': 'rgba(0, 0, 0, .09)', desk: 'rgb(231, 233, 237)', frame: 'rgb(251, 251, 253)', border: 'rgb(207, 209, 216)', windowBg: '#E7E9ED' },
} as const

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.keyboard.press('Control+Shift+T')
  await page.waitForSelector('#dlg-new[open]')
  await page.check('input[name=profile][value=powershell]')
  await page.fill('#new-cwd', cwd)
  await page.click('#btn-create')
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-menu')
  await page.waitForSelector('#app-menu:not([hidden])')
  await page.click(`#app-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => (document.documentElement as { dataset: Record<string, string> }).dataset.theme === s, scheme)
  await page.mouse.move(400, 300) // inside a card, away from its edges: no "+" in the screenshot
  await sleep(300)
}

const rects = (page: Page, sel: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }), sel)
const token = (page: Page, name: string) => page.evaluate(n => window.getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)

/** A small PNG of the window (half size), so the artifacts stay light on disk. */
async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

async function assertScheme(app: ElectronApplication, page: Page, scheme: 'light' | 'dark'): Promise<void> {
  const want = TOKENS[scheme]
  for (const n of ['--desk-bg', '--frame-bg', '--frame-border'] as const) assert.equal(await token(page, n), want[n], `${scheme}: ${n}`)
  assert.equal(await token(page, '--gap'), '8px')
  assert.equal(await token(page, '--frame-radius'), '10px')
  assert.equal(await token(page, '--drawer-inset'), '16px')
  assert.ok((await token(page, '--x-alert')).startsWith('oklch('), `${scheme}: --x-alert`)
  assert.ok(await token(page, '--x-alert-foreground'), `${scheme}: --x-alert-foreground`)
  assert.ok(await token(page, '--pane-divider'), `${scheme}: --pane-divider`)
  const bg = (sel: string) => page.locator(sel).first().evaluate(el => window.getComputedStyle(el).backgroundColor)
  assert.equal(await bg('body'), want.desk, `${scheme}: body = --desk-bg`)
  assert.equal(await bg('#toolbar'), want.desk, `${scheme}: toolbar = --desk-bg`)
  assert.equal(await page.locator('#toolbar').evaluate(el => window.getComputedStyle(el).borderBottomWidth), '0px', `${scheme}: toolbar without border`)
  assert.equal((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor()))?.toUpperCase(), want.windowBg.toUpperCase(), `${scheme}: window background`)
  // Cards.
  const card = page.locator('.desk-layer:not(.inactive) .frame-dock').first()
  const cs = await card.evaluate(el => { const s = window.getComputedStyle(el); return { radius: s.borderTopLeftRadius, bw: s.borderTopWidth, bg: s.backgroundColor, overflow: s.overflow } })
  assert.deepEqual(cs, { radius: '10px', bw: '1px', bg: want.frame, overflow: 'hidden' }, `${scheme}: frame card`)
  assert.equal(await page.locator('.desk-layer:not(.inactive) .dv-theme-tether').count() > 0, true, `${scheme}: dockview theme class`)
  assert.equal(await page.locator('.dockview-theme-dark, .dockview-theme-light').count(), 0, `${scheme}: no built-in dockview theme`)
  // The divider between the two panes of the first card: dockview's separator, coloured by --pane-divider.
  const divider = await page.locator('.desk-layer:not(.inactive) .frame-dock .dv-split-view-container .dv-view:not(:first-child)').first()
    .evaluate(el => window.getComputedStyle(el, '::before').backgroundColor)
  assert.equal(divider, want.border, `${scheme}: pane divider`)
}

test('app chrome: tokens, cards on the desk, pane divider and edge "+" (phase 4, slice 1)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-chrome-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // Two panes side by side in the first card, then a second card at the desk's right edge.
    await createShell(page, root)
    const [a] = await page.evaluate(() => window.__tether.panelIds())
    await focusPane(page, a!)
    await page.keyboard.press('Control+Shift+D')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 2)
    await focusPane(page, a!)
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 3)
    await page.waitForFunction(() => window.__tether.frameIds().length === 2)
    await sleep(400)

    // Geometry: the full --gap between the cards, and from the desk border to each card.
    const desk = (await rects(page, '.desk-layer.desk:not(.inactive), .desk-layer:not(.inactive) > .desk'))[0]!
    const cards = (await rects(page, '.desk-layer:not(.inactive) .frame-dock')).sort((x, y) => x.left - y.left)
    assert.equal(cards.length, 2, 'two cards')
    assert.ok(Math.abs(cards[1]!.left - cards[0]!.right - 8) <= 1, `gap between cards: ${cards[1]!.left - cards[0]!.right}`)
    assert.ok(Math.abs(cards[0]!.left - desk.left - 8) <= 1, `gap desk→card: ${cards[0]!.left - desk.left}`)
    assert.ok(Math.abs(desk.bottom - cards[0]!.bottom - 8) <= 1, `gap card→desk bottom: ${desk.bottom - cards[0]!.bottom}`)
    // The desk-level sash fills the gutter (still draggable there).
    const sash = (await rects(page, '.desk-layer:not(.inactive) .desk-grid .dv-sash:not(.frame-dock *)')).filter(r => r.left >= cards[0]!.right - 2 && r.right <= cards[1]!.left + 2 && r.height > 100)
    assert.ok(sash.length >= 1 && sash[0]!.width >= 8, `desk sash in the gutter: ${JSON.stringify(sash)}`)

    // The "+" at a card's edge (inside the card's top band) and in the desk's outer gutter, on the card border.
    const c1 = cards[1]!
    await page.mouse.move(c1.left + c1.width / 2, c1.top + 6)
    const fp = page.locator('.edge-plus.frame[data-side="top"]:not([hidden])')
    await fp.waitFor()
    const fr = (await fp.boundingBox())!
    assert.ok(fr.y >= c1.top && fr.y <= c1.top + 6, `frame "+" sits on the card's top: ${fr.y} vs ${c1.top}`)
    assert.equal(await page.locator('.edge-plus.desk:not([hidden])').count(), 0, 'only the frame "+" inside the card')
    await page.mouse.move(desk.right - 3, desk.top + desk.height / 2)
    const dp = page.locator('.edge-plus.desk[data-side="right"]:not([hidden])')
    await dp.waitFor()
    const dr = (await dp.boundingBox())!
    const centre = dr.x + dr.width / 2
    assert.ok(Math.abs(centre - c1.right) <= 4, `desk "+" centred on the card's right border: ${centre} vs ${c1.right}`)
    await page.mouse.move(400, 300) // inside a card, away from its edges: no "+" in the screenshot

    for (const scheme of ['dark', 'light'] as const) {
      await setTheme(page, scheme)
      await assertScheme(app, page, scheme)
      await shot(app, `chrome-cards-${scheme}`)
    }
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
