// E2E of the phase 4 chrome (visual redesign, PLAN.md "Fase 4"), against the real tetherd on a private home/pipe,
// hidden window, shells only. Slice 1 (tokens, surfaces, cards):
//   1. the new tokens resolve per scheme (--desk-bg, --frame-bg, …) and the toolbar/window paint --desk-bg;
//   2. frames are cards: radius, 1 px border, --frame-bg, a --gap gutter between two cards;
//   3. panes inside a card are separated by the --pane-divider line; the desk-level gutter draws no line;
//   4. the "+" still appears at a card's edge (frame) and in the outer gutter (desk), on the card's border;
//   5. small screenshots chrome-cards-{light,dark}.png (compare with preview-{light,dark}.png, preview-shot.ts).
// Slice 2 (toolbar and capsule):
//   6. icon-only sides (4 left, 3 right) with aria-labels, no "tether" name, the drawer pill in the capsule;
//   7. the capsule on the window's true centre (±2 px) at 1280 and 900 px, sides asymmetric;
//   8. 10 desks at 900 px: "+N" shows, the active desk stays visible, a pick replaces the visible desk used longest ago;
//   9. the theme icon menu, the connection popover (pipe, pid, version, agents, "Reiniciar serviço");
//  10. the desk colour line follows the active desk; the ≡ toggle turns it off and it stays off after a relaunch;
//  11. screenshots chrome-bar-{light,dark}.png with the preview's five desks.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  desks(): { id: string; name: string; color: number }[]
  activeDesk(): string
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  renameDesk(id: string, name: string): void
  recolorDesk(id: string, color: number): void
  switchState(): { visible: string[]; hidden: string[]; active: string }
  deskLine(): boolean
}
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
declare const window: { __tether: Hooks; innerWidth: number; getComputedStyle(el: unknown, pseudo?: string): Record<string, string> & { getPropertyValue(n: string): string } }
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

/** Slice 2: icon-only toolbar sides (4 left, 3 right), no "tether" name, every icon button labelled. */
async function toolbarChecks(page: Page): Promise<void> {
  const text = await page.locator('#toolbar').innerText()
  assert.ok(!/tether(?!d)/i.test(text.replace(/Mesa \d+/g, '')), `no "tether" in the toolbar: ${JSON.stringify(text)}`)
  const sides = await page.evaluate(() => {
    const read = (sel: string) => Array.from(document.querySelectorAll(sel) as unknown as ArrayLike<{ innerText: string; getAttribute(n: string): string | null }>).map(b => ({ text: b.innerText.trim(), label: b.getAttribute('aria-label') ?? '' }))
    return { left: read('#toolbar .tb-left button.ib'), right: read('#toolbar .tb-right button.ib') }
  })
  assert.equal(sides.left.length, 4, 'four icons on the left')
  assert.equal(sides.right.length, 3, 'three icons on the right')
  for (const b of [...sides.left, ...sides.right]) {
    assert.equal(b.text, '', `icon only: ${JSON.stringify(b)}`)
    assert.ok(b.label.length > 0, `aria-label: ${JSON.stringify(b)}`)
  }
  assert.equal(await page.locator('#brand, #desk-strip, #theme-select').count(), 0, 'old toolbar pieces are gone')
  assert.equal(await page.locator('#desk-switch #btn-drawer #drawer-badge').count(), 1, 'the drawer pill lives in the capsule')
}

/** The capsule's centre is the window's centre (±2 px), and it overlaps neither side. */
async function assertCentred(page: Page, width: number): Promise<void> {
  const r = await page.evaluate(() => {
    const box = (sel: string) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { left: b.left, right: b.right } }
    return { cap: box('#desk-switch'), left: box('#toolbar .tb-left'), right: box('#toolbar .tb-right'), w: (globalThis as unknown as { innerWidth: number }).innerWidth }
  })
  assert.ok(Math.abs(r.w - width) <= 2, `window width ${r.w} ~ ${width}`)
  const centre = (r.cap.left + r.cap.right) / 2
  assert.ok(Math.abs(centre - r.w / 2) <= 2, `capsule centred at ${r.w}: ${centre} vs ${r.w / 2} (${JSON.stringify(r)})`)
  assert.ok(r.left.right <= r.cap.left && r.cap.right <= r.right.left, `capsule clear of the sides: ${JSON.stringify(r)}`)
}

/** The desk line is on and painted in the active segment's fill. */
async function assertDeskLine(page: Page): Promise<void> {
  const line = await page.locator('#dock').evaluate(el => { const s = window.getComputedStyle(el, '::before'); return { bg: s.backgroundColor, h: s.height, content: s.content } })
  const fill = await page.locator('#desk-switch .seg.on').evaluate(el => window.getComputedStyle(el).backgroundColor)
  assert.equal(line.content, '""', 'the line is on')
  assert.equal(line.h, '2px')
  assert.equal(line.bg, fill, 'the line has the active desk colour')
}

test('app chrome: tokens, cards, toolbar and desk capsule (phase 4, slices 1 and 2)', async () => {
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

    // ---------- slice 2: toolbar, capsule, connection popover, theme menu, desk line ----------
    await toolbarChecks(page)
    // The preview's desks (docs/tether-preview.html), for the side-by-side screenshots.
    const PREVIEW: [string, number][] = [['Cliente A', 0], ['tether', 4], ['Atrium', 6], ['Pessoal', 1], ['Financeiro', 2]]
    await page.evaluate(([name, color]) => { const id = window.__tether.desks()[0]!.id; window.__tether.renameDesk(id, name); window.__tether.recolorDesk(id, color) }, PREVIEW[0]!)
    for (const [name, color] of PREVIEW.slice(1)) {
      await page.evaluate(([name, color]) => { const all = window.__tether.desks(); const id = window.__tether.createDesk('after', all[all.length - 1]!.id); window.__tether.renameDesk(id, name); window.__tether.recolorDesk(id, color) }, [name, color] as [string, number])
    }
    await page.evaluate(() => window.__tether.switchDesk(window.__tether.desks()[1]!.id))
    await sleep(300)
    await assertCentred(page, 1280)
    const st5 = await page.evaluate(() => window.__tether.switchState())
    assert.equal(st5.hidden.length, 0, 'five desks fit at 1280')
    await assertDeskLine(page)
    for (const scheme of ['dark', 'light'] as const) {
      await setTheme(page, scheme)
      await shot(app, `chrome-bar-${scheme}`)
    }

    // The theme icon menu switches the scheme.
    await page.click('#btn-theme')
    await page.waitForSelector('#theme-menu:not([hidden])')
    await page.click('#theme-menu li[data-theme="dark"]')
    await page.waitForFunction(() => (document.documentElement as { dataset: Record<string, string> }).dataset.theme === 'dark')
    assert.equal(await page.locator('#theme-menu li[data-theme="dark"]').getAttribute('aria-checked'), 'true')
    assert.equal(await page.locator('#app-menu li[data-theme="dark"]').getAttribute('aria-checked'), 'true', 'the ≡ radios follow')

    // The connection popover: on hover, pinned by a click, closed by Esc; pipe, pid and version from hello.
    await page.hover('#conn')
    await page.waitForSelector('#conn-pop', { state: 'visible' })
    const popText = await page.locator('#conn-pop').innerText()
    assert.ok(popText.includes(pipe), `popover shows the pipe: ${popText}`)
    assert.ok(popText.includes(String(daemonPid)), 'popover shows the pid')
    assert.match(await page.locator('#conn-version').innerText(), /^\d+\.\d+/, 'popover shows the version')
    assert.match(await page.locator('#conn-agents').innerText(), /3 rodando · 0 aguardando/)
    assert.equal(await page.locator('#conn-restart').innerText(), 'Reiniciar serviço')
    await page.click('#conn')
    await page.mouse.move(400, 300)
    await page.waitForSelector('#conn-pop', { state: 'visible' })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#conn-pop', { state: 'hidden' })

    // 10 desks at 900 px: the "+N" shows, the active desk stays visible, the capsule stays centred.
    await page.evaluate(() => { for (let i = 0; i < 5; i++) { const all = window.__tether.desks(); window.__tether.switchDesk(window.__tether.createDesk('after', all[all.length - 1]!.id)) } })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 800))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 900) <= 2)
    await sleep(400)
    const before = await page.evaluate(() => window.__tether.switchState())
    assert.ok(before.hidden.length > 0, `"+N" at 900 px: ${JSON.stringify(before)}`)
    assert.ok(before.visible.includes(before.active), 'the active desk is visible')
    assert.equal(await page.locator('#desk-switch .desk-more').innerText(), `+${before.hidden.length}`)
    await assertCentred(page, 900)
    // Picking in the "+N": the picked desk takes the place of the visible desk used longest ago; the others stay.
    // The desks were used in creation order, so the one used longest ago is the visible one created first,
    // except the preview's second desk ("tether"), used after the first five were created.
    const order = (await page.evaluate(() => window.__tether.desks())).map(d => d.id)
    const used = [order[0], order[2], order[3], order[4], order[1], ...order.slice(5)]
    const lru = used.find(id => before.visible.includes(id!) && id !== before.active)!
    const picked = before.hidden[0]!
    await page.click('#desk-switch .desk-more')
    await page.waitForSelector('#ctx-menu')
    const name = (await page.evaluate(() => window.__tether.desks())).find(d => d.id === picked)!.name
    await page.click(`#ctx-menu li:text-is("${name}")`)
    await page.waitForFunction(id => window.__tether.activeDesk() === id, picked)
    const after = await page.evaluate(() => window.__tether.switchState())
    // Names differ in width: a wider pick can push out more than one; those are still the ones used longest ago.
    const out = before.visible.length + 1 - after.visible.length
    assert.ok(out >= 1, `something left: ${JSON.stringify({ before, after })}`)
    const dropped = new Set(used.filter(id => before.visible.includes(id!) && id !== before.active).slice(0, out))
    assert.ok(dropped.has(lru))
    const want = order.filter(id => (before.visible.includes(id) && !dropped.has(id)) || id === picked)
    assert.deepEqual(after.visible, want, `MRU pick: ${JSON.stringify({ before, after, lru, picked })}`)
    await assertCentred(page, 900)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 1280) <= 2)
    await sleep(300)

    // The desk line: off through ≡, saved in settings.json, still off after a relaunch.
    await assertDeskLine(page)
    await page.click('#btn-menu')
    await page.click('#app-menu li[data-cmd="desk-line"]')
    await page.waitForFunction(() => !window.__tether.deskLine())
    assert.equal(await page.locator('#dock').evaluate(el => window.getComputedStyle(el, '::before').content), 'none', 'the line is gone')
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).ui?.deskLine, false, 'settings.json ui.deskLine')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.desks().length > 1)
    assert.equal(await page.evaluate(() => window.__tether.deskLine()), false, 'still off after relaunch')
    assert.equal(await page.locator('#app-menu li[data-cmd="desk-line"]').getAttribute('aria-checked'), 'false')
    await page.click('#btn-menu')
    await page.click('#app-menu li[data-cmd="desk-line"]')
    await page.waitForFunction(() => window.__tether.deskLine())
    await assertDeskLine(page)
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
