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
//   9. the theme icon menu, the connection popover (pipe, pid, version, agents, "Reiniciar o tetherd");
//  10. the desk colour line follows the active desk; the ≡ toggle turns it off and it stays off after a relaunch;
//  11. screenshots chrome-bar-{light,dark}.png with the preview's five desks.
// Slice 7 (polish and accessibility): the last test in this file: aria on the new controls, Tab order, arrows/Home/End/
// Enter/Esc and focus return in the theme menu, the connection popover, the capsule's "+N" and the tab strip's "+N"/"⋯",
// the roving tabindex of the capsule, the FLIP (none under reduced motion), the "+N" text colour, drawer frames as cards
// with the 8 px gap (also after a relaunch), screenshots chrome-a11y-{drawer,tabs}-{light,dark}.png.
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
  desks(): { id: string; name: string; color: string }[]
  activeDesk(): string
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  renameDesk(id: string, name: string): void
  recolorDesk(id: string, color: string): void
  switchState(): { visible: string[]; hidden: string[]; active: string }
  deskLine(): boolean
  drawer(): { open: boolean; panes: string[] }
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

/** A small PNG of the toolbar only (half size). */
async function shotBar(app: ElectronApplication, page: Page, name: string): Promise<void> {
  await page.mouse.move(400, 400)
  const r = (await rects(page, '#toolbar'))[0]!
  const b64 = await app.evaluate(async ({ BrowserWindow }, rect) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rect)
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  }, { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) })
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

/**
 * Slice 3: the capsule paints with the generated --x-{hue} variables, not with literal colours. A probe element
 * resolves each variable through the same engine, so the comparison is exact in any colour syntax.
 */
async function assertPaletteTokens(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  assert.equal(await page.evaluate(() => (document.documentElement as { dataset: Record<string, string> }).dataset.theme), scheme)
  const r = await page.evaluate(() => {
    const doc = document as unknown as { createElement(t: string): { style: Record<string, string> }; body: { append(e: unknown): void }; querySelectorAll(s: string): Iterable<{ dataset: Record<string, string>; classList: { contains(c: string): boolean } }> }
    const resolve = (prop: 'backgroundColor' | 'color', value: string): string => {
      const el = doc.createElement('i')
      el.style[prop === 'color' ? 'color' : 'background'] = value
      doc.body.append(el)
      const out = window.getComputedStyle(el)[prop] as string
      ;(el as unknown as { remove(): void }).remove()
      return out
    }
    const hues = window.__tether.desks().reduce<Record<string, string>>((m, d) => { m[d.id] = d.color; return m }, {})
    return Array.from(doc.querySelectorAll('#desk-switch .seg[data-desk]')).map(seg => {
      const hue = hues[seg.dataset.desk!]!
      const cs = window.getComputedStyle(seg)
      const name = window.getComputedStyle((seg as unknown as { querySelector(s: string): unknown }).querySelector('.seg-name'))
      return {
        desk: seg.dataset.desk!, hue, on: seg.classList.contains('on'),
        bg: cs.backgroundColor, color: cs.color, nameColor: name.color,
        fill: resolve('backgroundColor', `var(--x-${hue})`), fg: resolve('color', `var(--x-${hue}-foreground)`), text: resolve('color', `var(--x-${hue}-text)`),
        raw: ['', '-foreground', '-text'].map(k => window.getComputedStyle(document.documentElement).getPropertyValue(`--x-${hue}${k}`).trim()),
      }
    })
  })
  assert.ok(r.length >= 5, 'the capsule shows the desks')
  for (const x of r) {
    assert.ok(x.raw.every(v => v.length > 0), `${scheme} ${x.hue}: the three --x variables exist`)
    if (x.on) {
      assert.equal(x.bg, x.fill, `${scheme} ${x.hue}: the active segment fills with --x-${x.hue}`)
      assert.equal(x.color, x.fg, `${scheme} ${x.hue}: its text is --x-${x.hue}-foreground`)
    } else {
      assert.equal(x.nameColor, x.text, `${scheme} ${x.hue}: an inactive name is --x-${x.hue}-text`)
    }
  }
  assert.ok(r.some(x => x.on) && r.some(x => !x.on), 'both an active and an inactive segment were checked')
  // The attention badge keeps --x-alert (orange) with its own foreground.
  assert.ok((await token(page, '--x-alert')).startsWith('oklch('), `${scheme}: --x-alert`)
}

test('app chrome: tokens, cards, toolbar and desk capsule (phase 4, slices 1 to 3)', async () => {
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
    const PREVIEW: [string, string][] = [['Cliente A', 'blue'], ['tether', 'purple'], ['Atrium', 'pink'], ['Pessoal', 'green'], ['Financeiro', 'orange']]
    await page.evaluate(([name, color]) => { const id = window.__tether.desks()[0]!.id; window.__tether.renameDesk(id, name); window.__tether.recolorDesk(id, color) }, PREVIEW[0]!)
    for (const [name, color] of PREVIEW.slice(1)) {
      await page.evaluate(([name, color]) => { const all = window.__tether.desks(); const id = window.__tether.createDesk('after', all[all.length - 1]!.id); window.__tether.renameDesk(id, name); window.__tether.recolorDesk(id, color) }, [name, color] as [string, string])
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
      await assertPaletteTokens(page, scheme)
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
    assert.equal(await page.locator('#conn-restart').innerText(), 'Reiniciar o tetherd')
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

    // Slice 3: all 12 hues on the capsule (12 desks, one per hue), both schemes: tokens in use, picker offering 12,
    // and small captures of the toolbar for the side-by-side with docs/desk-switcher-options.html.
    await page.evaluate(() => { while (window.__tether.desks().length < 12) { const all = window.__tether.desks(); window.__tether.createDesk('after', all[all.length - 1]!.id) } })
    const HUES = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'purple', 'magenta', 'pink']
    await page.evaluate(hues => { window.__tether.desks().forEach((d, i) => window.__tether.recolorDesk(d.id, hues[i]!)) }, HUES)
    await page.evaluate(() => window.__tether.switchDesk(window.__tether.desks()[8]!.id)) // blue: a "-deep" fill
    await sleep(400)
    assert.deepEqual((await page.evaluate(() => window.__tether.desks())).map(d => d.color), HUES, 'one desk per hue')
    for (const scheme of ['dark', 'light'] as const) {
      await setTheme(page, scheme)
      await assertPaletteTokens(page, scheme)
      await shotBar(app, page, `chrome-palette-${scheme}`)
    }
    await page.evaluate(() => window.__tether.switchDesk(window.__tether.desks()[1]!.id)) // orange: the attention badge must still stand apart
    await sleep(300)
    await shotBar(app, page, 'chrome-palette-light-orange')
    await page.click('#desk-switch .seg.on', { button: 'right' })
    await page.click('#ctx-menu li:has-text("Cor…")')
    assert.equal(await page.locator('#desk-colors .swatch').count(), 12, 'the picker offers the 12 hues')
    assert.deepEqual(await page.locator('#desk-colors .swatch').evaluateAll(els => els.map(e => (e as unknown as { dataset: Record<string, string> }).dataset.color!)), HUES)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#desk-colors', { state: 'detached' })

    // The desk line: off through ≡, saved in settings.json, still off after a relaunch.
    await assertDeskLine(page)
    await page.click('#btn-menu')
    await page.click('#app-menu li[data-command="ui.desk-line"]')
    await page.waitForFunction(() => !window.__tether.deskLine())
    assert.equal(await page.locator('#dock').evaluate(el => window.getComputedStyle(el, '::before').content), 'none', 'the line is gone')
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).ui?.deskLine, false, 'settings.json ui.deskLine')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.desks().length > 1)
    assert.equal(await page.evaluate(() => window.__tether.deskLine()), false, 'still off after relaunch')
    assert.equal(await page.locator('#app-menu li[data-command="ui.desk-line"]').getAttribute('aria-checked'), 'false')
    await page.click('#btn-menu')
    await page.click('#app-menu li[data-command="ui.desk-line"]')
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

// Slice 4 (the pane tab strip, PLAN.md "Fatia 4"): 9 tabs in one narrow frame. The "+N", the status-bar toggle
// and "⋯" sit fixed at the strip's right end; the active tab is never hidden; picking in the "+N" puts the tab
// in place of the visible tab used longest ago (moveTo) and the others stay; the toggle follows Ctrl+Shift+H and
// does not move "⋯"; "⋯" holds "Renomear…"; screenshots chrome-tabs-{light,dark}.png of the strip.
test('app chrome: pane tab strip, "+N" by recent use, status-bar toggle, "⋯" (phase 4, slice 4)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-chrome-tabs-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    for (let i = 0; i < 9; i++) await createShell(page, root)
    assert.equal(await page.evaluate(() => window.__tether.frameIds().length), 1, 'one frame, nine tabs')

    type Strip = { order: string[]; hidden: string[]; more: string; active: string | undefined; head: Rect; actions: Rect; dots: Rect; pressed: string | null }
    const strip = (): Promise<Strip> => page.evaluate(() => {
      const d = document as unknown as { querySelector(s: string): HTMLLike | null; querySelectorAll(s: string): ArrayLike<HTMLLike> }
      type HTMLLike = { getBoundingClientRect(): Rect; classList: { contains(c: string): boolean }; querySelector(s: string): HTMLLike | null; dataset: Record<string, string>; hidden: boolean; textContent: string | null; getAttribute(n: string): string | null }
      type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
      const r = (e: HTMLLike | null): Rect => { const b = e!.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } }
      const tabs = Array.from(d.querySelectorAll('.dv-tabs-container > .dv-tab'))
      const more = d.querySelector('.tab-actions .tab-more')!
      return {
        order: tabs.map(t => t.querySelector('[data-slot]')!.dataset.slot!),
        hidden: tabs.filter(t => t.classList.contains('tab-hidden')).map(t => t.querySelector('[data-slot]')!.dataset.slot!),
        more: more.hidden ? '' : (more.textContent ?? ''),
        active: window.__tether.activeId(),
        head: r(d.querySelector('.dv-tabs-and-actions-container')),
        actions: r(d.querySelector('.tab-actions')),
        dots: r(d.querySelector('.tab-actions [data-action="pane-menu"]')),
        pressed: d.querySelector('.tab-actions [data-action="status-bar"]')!.getAttribute('aria-pressed'),
      }
    })

    // Wide: all nine fit (they shrink), no "+N"; the actions end at the strip's right edge.
    await sleep(300)
    let s = await strip()
    assert.equal(s.order.length, 9)
    assert.ok(Math.abs(s.actions.right - s.head.right) <= 1, `actions fixed at the right: ${JSON.stringify(s)}`)
    assert.ok(Math.abs(s.head.height - 32) <= 1, `strip height 32: ${s.head.height}`)

    // Narrow: "+N" appears with the count, the active tab stays visible, the actions stay at the right edge.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(700, 700))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 700) <= 2)
    await sleep(400)
    s = await strip()
    assert.ok(s.hidden.length > 0, `"+N" at 700 px: ${JSON.stringify(s)}`)
    assert.equal(s.more, `+${s.hidden.length}`)
    assert.ok(!s.hidden.includes(s.active!), 'the active tab is visible')
    assert.ok(Math.abs(s.actions.right - s.head.right) <= 1, 'actions still at the right edge')

    // Use the visible tabs, all but the first: the first one becomes the one used longest ago.
    const visible = s.order.filter(id => !s.hidden.includes(id))
    for (const id of visible.slice(1)) { await page.evaluate(id => window.__tether.activate(id), id); await page.waitForFunction(id => window.__tether.activeId() === id, id) }
    await sleep(200)
    s = await strip()
    const lru = visible[0]!
    const lruIndex = s.order.indexOf(lru)
    const picked = s.hidden[0]!
    const dotsBefore = s.dots
    await page.click('.tab-actions .tab-more')
    await page.waitForSelector('#ctx-menu')
    assert.equal(await page.locator('#ctx-menu li[role=menuitem]').count(), s.hidden.length, 'the "+N" lists the hidden tabs')
    await page.locator('#ctx-menu li[role=menuitem]').first().click()
    await page.waitForFunction(id => window.__tether.activeId() === id, picked)
    await sleep(300)
    const after = await strip()
    assert.ok(!after.hidden.includes(picked), 'the picked tab shows')
    assert.ok(after.hidden.includes(lru), `the tab used longest ago left: ${JSON.stringify({ s, after, lru, picked })}`)
    assert.equal(after.order.indexOf(picked), lruIndex, 'the picked tab took its place (moveTo)')
    for (const id of visible.slice(1)) assert.ok(!after.hidden.includes(id), `the others stay: ${id}`)
    assert.ok(Math.abs(after.dots.left - dotsBefore.left) <= 1, '"⋯" did not move')

    // The status-bar toggle: opens the active pane's header, "⋯" stays in place; Ctrl+Shift+H closes it.
    const panelOpen = (id: string) => page.evaluate(id => (document.querySelector(`.panel[data-slot-id="${id}"]`) as unknown as { dataset: Record<string, string> }).dataset.details, id)
    assert.equal(after.pressed, 'false')
    await page.click('.tab-actions [data-action="status-bar"]')
    await page.waitForFunction(id => (document.querySelector(`.panel[data-slot-id="${id}"]`) as unknown as { dataset: Record<string, string> }).dataset.details === 'true', picked)
    let t = await strip()
    assert.equal(t.pressed, 'true')
    assert.ok(Math.abs(t.dots.left - dotsBefore.left) <= 1, '"⋯" stays in place with the toggle on')
    await page.locator(`.panel[data-slot-id="${picked}"] .panel-term`).click()
    await page.keyboard.press('Control+Shift+H')
    await page.waitForFunction(id => (document.querySelector(`.panel[data-slot-id="${id}"]`) as unknown as { dataset: Record<string, string> }).dataset.details === 'false', picked)
    t = await strip()
    assert.equal(t.pressed, 'false')
    assert.equal(await panelOpen(picked), 'false')

    // "⋯": the pane menu, grouped, with "Renomear…" (inline rename on the tab).
    await page.click('.tab-actions [data-action="pane-menu"]')
    await page.waitForSelector('#ctx-menu')
    const items = await page.locator('#ctx-menu li[role=menuitem]').allTextContents()
    for (const want of ['Novo painel…', 'Renomear…', 'Trocar perfil…', 'Mostrar barra de status', 'Mover…', 'Fechar painel…']) assert.ok(items.includes(want), `"⋯" has ${want}: ${JSON.stringify(items)}`)
    assert.ok(!items.some(i => /Reiniciar/.test(i)), 'no "Reiniciar sessão"')
    assert.ok(await page.locator('#ctx-menu li.sep').count() >= 3, 'grouped')
    await page.click('#ctx-menu li:text-is("Renomear…")')
    await page.waitForSelector('.tether-tab input.rename')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.tether-tab input.rename', { state: 'detached' })

    // Screenshots of the strip, light and dark, to compare with the preview's .tabs/.tr/.tmore.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 600))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 900) <= 2)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      const h = (await strip()).head
      const b64 = await app.evaluate(async ({ BrowserWindow }, rect) => {
        const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rect)
        return img.toPNG().toString('base64')
      }, { x: Math.floor(h.left), y: Math.floor(h.top), width: Math.ceil(h.width), height: Math.ceil(h.height) + 1 })
      writeFileSync(join(artifacts, `chrome-tabs-${scheme}.png`), Buffer.from(b64, 'base64'))
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

// Slice 5 (the pane status bar, PLAN.md "Fatia 5"): collapsed by default and 26px open; state as icons only
// (dot, bell), information as text only (profile, folder in mono with an ellipsis), icon+text only for "sem
// restrições"; three icon-only actions pinned right with tooltips ("Trocar perfil…", "Abrir pasta no Explorer",
// "Copiar pasta"); "Copiar pasta" and "Abrir pasta no Explorer" are also in the "⋯" menu; situations show while
// the bar is collapsed; `shell:open-path` refuses a missing path and a file. Screenshots chrome-status-{light,dark}.png.
test('app chrome: pane status bar (phase 4, slice 5)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-chrome-status-'))
  const work = join(home, 'trabalho-com-um-nome-de-pasta-bem-comprido-para-forcar-as-reticencias-na-barra-de-status')
  mkdirSync(work, { recursive: true })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await createShell(page, work)
    const shellId = (await page.evaluate(() => window.__tether.panelIds()))[0]!
    await page.waitForFunction(id => (window as unknown as Win).__tether.slots().find(s => s.slotId === id)?.status === 'running', shellId, { timeout: 30_000 })
    const bar = page.locator(`.panel[data-slot-id="${shellId}"] .status-bar`)
    type Win = { tether: { writeClipboard(t: string): void; readClipboard(): Promise<string>; openPath(p: string): Promise<{ ok: boolean }>; request(r: unknown): Promise<{ t: string; message?: string; slot?: { slotId: string } }> }; __tether: { openSlot(id: string): void; slots(): { slotId: string; status: string; unsafe?: boolean }[] } }
    type Dom = { querySelector(s: string): { clientHeight: number } | null }
    const detailsH = (id: string) => page.evaluate(id => (document as unknown as Dom).querySelector(`.panel[data-slot-id="${id}"] .panel-details`)!.clientHeight, id)
    const waitBar = (id: string) => page.waitForFunction(id => (document as unknown as Dom).querySelector(`.panel[data-slot-id="${id}"] .panel-details`)!.clientHeight === 26, id)
    const writeClip = (text: string) => page.evaluate(text => (window as unknown as Win).tether.writeClipboard(text), text)
    const clipIs = (text: string) => page.waitForFunction(text => (window as unknown as Win).tether.readClipboard().then(t => t === text), text)
    const openPath = (path: string) => page.evaluate(path => (window as unknown as Win).tether.openPath(path), path)
    const toggle = '.dv-right-actions-container [data-action="status-bar"]'

    // Collapsed by default; the toggle opens it at 26px.
    assert.equal(await detailsH(shellId), 0, 'collapsed by default')
    await page.click(toggle)
    await waitBar(shellId)

    // State as an icon only: the dot has no text, its tooltip says "rodando".
    const dot = bar.locator('.status')
    assert.equal((await dot.textContent())!.trim(), '', 'the state dot has no text')
    assert.equal(await dot.locator('svg').count(), 1, 'the state dot is an icon')
    assert.equal(await dot.getAttribute('title'), 'rodando')
    assert.equal(await bar.locator('.bell').isVisible(), false, 'no bell without attention')
    // Information as text only: the profile name and the folder in mono with an ellipsis.
    const prof = bar.locator('.info-profile')
    assert.equal(await prof.locator('svg').count(), 0, 'the profile is text only')
    assert.ok((await prof.textContent())!.length > 0)
    const cwd = bar.locator('.info-cwd')
    assert.equal(await cwd.textContent(), work)
    const cwdStyle = await cwd.evaluate(el => { const c = window.getComputedStyle(el); return { ff: c.fontFamily, to: c.textOverflow } })
    assert.match(cwdStyle.ff ?? '', /Cascadia|Consolas|mono/i, 'the folder is mono')
    assert.equal(cwdStyle.to, 'ellipsis')
    assert.equal(await bar.locator('.unsafe').isVisible(), false, '"sem restrições" only on unsafe profiles')

    // Pinned icon-only actions on the right, each with a tooltip.
    const want: Array<[string, string]> = [['switch-profile', 'Trocar perfil'], ['open-folder', 'Abrir pasta no Explorer'], ['copy-folder', 'Copiar pasta']]
    const cwdBox = (await cwd.boundingBox())!
    let prevLeft = cwdBox.x + cwdBox.width
    for (const [action, tip] of want) {
      const b = bar.locator(`[data-action="${action}"]`)
      assert.equal(((await b.textContent()) ?? '').trim(), '', `${action} is icon only`)
      assert.match((await b.getAttribute('title'))!, new RegExp(tip))
      const box = (await b.boundingBox())!
      assert.ok(box.x >= prevLeft - 1, `${action} sits to the right of the information`)
      prevLeft = box.x
    }
    const barBox = (await bar.boundingBox())!
    const lastBox = (await bar.locator('[data-action="copy-folder"]').boundingBox())!
    assert.ok(barBox.x + barBox.width - (lastBox.x + lastBox.width) <= 8, 'the actions are pinned at the right end')

    // "Copiar pasta" puts the folder in the clipboard (the action and the "⋯" entry).
    await writeClip('antes')
    await bar.locator('[data-action="copy-folder"]').click()
    await clipIs(work)
    await writeClip('antes')
    await page.click('.tab-actions [data-action="pane-menu"]')
    await page.waitForSelector('#ctx-menu')
    const items = await page.locator('#ctx-menu li[role=menuitem]').allTextContents()
    assert.ok(items.includes('Abrir pasta no Explorer'), `"⋯" has "Abrir pasta no Explorer": ${JSON.stringify(items)}`)
    await page.click('#ctx-menu li:text-is("Copiar pasta")')
    await clipIs(work)

    // shell:open-path only opens an existing directory (the valid case would open Explorer: not exercised here).
    const missing = await openPath(join(home, 'nao-existe'))
    assert.equal(missing.ok, false, 'a missing path is refused')
    writeFileSync(join(work, 'arquivo.txt'), 'x')
    const file = await openPath(join(work, 'arquivo.txt'))
    assert.equal(file.ok, false, 'a file is refused (it would be launched, not shown)')
    assert.equal((await openPath('')).ok, false, 'an empty path is refused')

    // "sem restrições": icon + text, warn tone, only on the unsafe profile. The slot is not started (situations on a
    // collapsed pane are covered by app.pane-details).
    const created = await page.evaluate(cwd => (window as unknown as Win).tether.request({ t: 'create', kind: 'claude', cwd, profileId: 'claude-dev' }), work)
    assert.equal(created.t, 'ok', `create: ${created.message}`)
    const unsafeId = created.slot!.slotId
    await page.evaluate(id => (window as unknown as Win).__tether.openSlot(id), unsafeId)
    await page.waitForSelector(`.panel[data-slot-id="${unsafeId}"]`)
    await page.evaluate(id => window.__tether.activate(id), unsafeId)
    await page.waitForFunction(id => (window as unknown as Win).__tether.slots().find(s => s.slotId === id)?.unsafe === true, unsafeId)
    assert.equal(await detailsH(unsafeId), 0, 'the new pane starts collapsed')
    await page.click(toggle)
    await waitBar(unsafeId)
    const ubar = page.locator(`.panel[data-slot-id="${unsafeId}"] .status-bar`)
    const badge = ubar.locator('.unsafe')
    assert.ok(await badge.isVisible(), '"sem restrições" shows')
    assert.equal((await badge.textContent())!.trim(), 'sem restrições')
    assert.equal(await badge.locator('svg').count(), 1, 'icon + text')
    const bg = await badge.evaluate(el => window.getComputedStyle(el).backgroundColor)
    assert.notEqual(bg, 'rgba(0, 0, 0, 0)', 'warn-tinted background')

    // Screenshots of the shell pane's bar, light and dark, to compare with the preview's .stb.
    await page.evaluate(id => window.__tether.activate(id), shellId)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 600))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 900) <= 2)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      const r = (await bar.boundingBox())!
      const b64 = await app.evaluate(async ({ BrowserWindow }, rect) => {
        const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rect)
        return img.toPNG().toString('base64')
      }, { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) })
      writeFileSync(join(artifacts, `chrome-status-${scheme}.png`), Buffer.from(b64, 'base64'))
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

// Slice 6 (the drawer as a full-window card, PLAN.md "Fatia 6"): the card sits 16 px from every edge, over the
// toolbar, with no backdrop; its own slim bar has the toolbar's height, icon-only "Novo painel"/"Duplicar" on the
// left, the pressed "Gaveta" pill on the true centre and the X on the right; the pill, the X, Esc and the 16 px
// margin close it; the cards behind fade while it is open (opacity < 1) and are back to 1 after; when the last
// pane leaves, the invitation shows. Screenshots chrome-drawer-{light,dark}.png and chrome-drawer-empty-dark.png.
test('app chrome: the drawer is a full-window card with its own bar and an empty state (phase 4, slice 6)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-chrome-drawer-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await createShell(page, root)
    await sleep(500)

    const opacityBehind = () => page.locator('.desk-set .frame-dock').first().evaluate(el => Number(window.getComputedStyle(el).opacity))
    const drawerOpen = (open: boolean) => page.waitForFunction(o => (window.getComputedStyle(document.querySelector('#drawer')).visibility === 'visible') === o, open)
    const drawerIsOpen = () => page.evaluate(() => window.__tether.drawer().open)
    assert.equal(await opacityBehind(), 1)

    await page.keyboard.press('Control+Backquote')
    await drawerOpen(true)
    await page.waitForFunction(() => document.querySelectorAll('.drawer .tether-tab').length === 1) // the quick shell
    await sleep(500) // the 160 ms entrance and the fade behind are done

    // The card: 16 px from every edge, over the toolbar (which has the same height as the bar).
    const card = (await rects(page, '.drawer-card'))[0]!
    const vp = { width: await page.evaluate(() => window.innerWidth), height: await page.evaluate(() => (window as unknown as { innerHeight: number }).innerHeight) }
    assert.deepEqual([card.left, card.top, vp.width - card.right, vp.height - card.bottom], [16, 16, 16, 16])
    const bar = (await rects(page, '.drawer-bar'))[0]!
    const toolbar = (await rects(page, '#toolbar'))[0]!
    assert.ok(Math.abs(bar.height - toolbar.height) <= 1, `the bar is the toolbar's height: ${bar.height} vs ${toolbar.height}`)
    assert.equal(await page.evaluate(() => window.getComputedStyle(document.querySelector('.drawer-card')).boxShadow !== 'none'), true, 'the card is elevated')
    assert.equal(await page.locator('.drawer-backdrop').count(), 0, 'no backdrop')

    // The bar: icon-only buttons with labels, the pressed pill on the window's true centre, the X on the right.
    for (const id of ['drawer-new', 'drawer-duplicate', 'drawer-close']) {
      assert.ok(await page.locator(`#${id}`).getAttribute('aria-label'), `${id} has an aria-label`)
      assert.equal(((await page.locator(`#${id}`).textContent()) ?? '').trim(), '', `${id} is icon-only`)
    }
    assert.equal(await page.locator('.drawer-bar .db-left button').count(), 2)
    assert.equal(await page.locator('#drawer-pill').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('#drawer-pill').getAttribute('title'), 'Fechar gaveta (Esc)')
    assert.equal(((await page.locator('#drawer-pill').textContent()) ?? '').trim(), 'Gaveta')
    const pill = (await rects(page, '.drawer-bar .db-mid'))[0]!
    assert.ok(Math.abs((pill.left + pill.right) / 2 - vp.width / 2) <= 2, `the pill is centred: ${(pill.left + pill.right) / 2} vs ${vp.width / 2}`)
    const x = (await rects(page, '#drawer-close'))[0]!
    assert.ok(x.right <= card.right && card.right - x.right <= 12, 'the X is at the right end')
    assert.equal(await page.locator('.drawer-head, .drawer-note').count(), 0, 'the old header and its note are gone')

    // The cards behind fade while it is open; the drawer's own cards do not.
    assert.ok(await opacityBehind() < 1, 'the cards behind are faded')
    assert.equal(await page.locator('.drawer .frame-dock').first().evaluate(el => Number(window.getComputedStyle(el).opacity)), 1, 'the drawer\'s own cards are not')

    // Light and dark shots (compare with the preview's .dcard/.dbar/.ddesk).
    for (const scheme of ['light', 'dark'] as const) {
      await page.keyboard.press('Control+Backquote')
      await drawerOpen(false)
      await setTheme(page, scheme)
      await page.keyboard.press('Control+Backquote')
      await drawerOpen(true)
      await page.mouse.move(400, 400)
      await sleep(600)
      await shot(app, `chrome-drawer-${scheme}`)
    }

    // Closing: the pill, the X, the 16 px margin; the cards behind are back to full.
    for (const how of ['pill', 'x', 'margin'] as const) {
      if (how === 'pill') await page.click('#drawer-pill')
      else if (how === 'x') await page.click('#drawer-close')
      else await page.mouse.click(8, 400)
      await drawerOpen(false)
      await sleep(300)
      assert.equal(await opacityBehind(), 1, `${how}: the cards behind are back to full`)
      assert.equal(await drawerIsOpen(), false)
      await page.keyboard.press('Control+Backquote')
      await drawerOpen(true)
      await sleep(250)
    }
    await page.mouse.click(600, 400) // a click inside the card does not close it
    await sleep(300)
    assert.equal(await drawerIsOpen(), true)

    // The empty state: closing the last pane keeps the drawer open and shows the invitation.
    await page.locator('.drawer .tether-tab').first().hover()
    await page.locator('.drawer .tether-tab .close').first().click()
    await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
    await page.waitForSelector('.drawer[data-empty="true"] .drawer-empty .de-btn')
    assert.equal(await drawerIsOpen(), true)
    assert.deepEqual(await page.locator('.drawer-empty .de-btn').allTextContents(), ['Novo painel…Ctrl+Shift+T', 'Terminal rápidoCtrl+`'])
    await sleep(400) // the theme is still dark from the shots above
    await shot(app, 'chrome-drawer-empty-dark')
    await page.click('#drawer-empty-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    assert.equal(await drawerIsOpen(), true, 'the chooser\'s Esc was the chooser\'s')
    await page.click('#drawer-empty-quick')
    await page.waitForFunction(() => document.querySelectorAll('.drawer .tether-tab').length === 1)
    await page.waitForSelector('.drawer[data-empty="false"]')
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

// Slice 7 (polish and accessibility, PLAN.md "Fatia 7"): aria on the new controls (capsule tabs, the "+N" buttons,
// theme menu, connection popover, tab-strip actions, status bar, drawer pill); Tab order bar -> capsule -> right side;
// arrows, Home/End, Enter, Esc and the focus coming back in the theme menu, the capsule's "+N", the tab strip's "+N"
// and "⋯" and the connection popover; the capsule's tabs on a roving tabindex; the FLIP reorder (320 ms, none under
// prefers-reduced-motion); and the drawer's frames as cards on the desk surface with the --gap around and between them,
// also after a relaunch. Screenshots chrome-a11y-{drawer,tabs}-{light,dark}.png, small.
test('app chrome: aria, keyboard in the new menus, focus return, FLIP, drawer frames as cards (phase 4, slice 7)', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-chrome-a11y-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  // DOM probes as strings: the file's `document` type is narrow on purpose.
  const probe = <T>(page: Page, expr: string): Promise<T> => page.evaluate(`(() => { ${expr} })()`) as Promise<T>
  const focusId = (page: Page): Promise<string> => probe(page, `const e = document.activeElement; if (!e) return ''; return e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + (e.getAttribute('class') || '').split(' ').join('.')`)
  const attr = (page: Page, sel: string, name: string): Promise<string | null> => probe(page, `return document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? null`)
  const press = (page: Page, key: string) => page.keyboard.press(key)
  const focusedDesk = (page: Page): Promise<string | undefined> => probe(page, `return document.activeElement?.dataset?.desk`)
  const menuItems = (page: Page): Promise<string[]> => probe(page, `return [...document.querySelectorAll('#ctx-menu li[role=menuitem]')].map(l => l.textContent)`)
  const focusedItem = (page: Page): Promise<string> => probe(page, `return document.activeElement?.closest('#ctx-menu') ? document.activeElement.textContent : ''`)
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await createShell(page, root)
    await sleep(400)

    // ---- aria on the new controls ----
    assert.equal(await attr(page, '#desk-switch .desk-segs', 'role'), 'tablist')
    assert.equal(await attr(page, '#desk-switch .seg[data-desk]', 'role'), 'tab')
    assert.equal(await attr(page, '#desk-switch .seg.on', 'aria-selected'), 'true')
    assert.equal(await attr(page, '#desk-switch .seg.on', 'tabindex'), '0', 'roving tabindex: the active tab is the Tab stop')
    assert.equal(await attr(page, '#btn-theme', 'aria-haspopup'), 'menu')
    assert.equal(await attr(page, '#btn-theme', 'aria-expanded'), 'false')
    assert.equal(await attr(page, '#btn-theme', 'aria-controls'), 'theme-menu')
    assert.equal(await attr(page, '#theme-menu', 'role'), 'menu')
    assert.equal(await attr(page, '#conn', 'aria-haspopup'), 'dialog')
    assert.equal(await attr(page, '#conn', 'aria-expanded'), 'false')
    assert.equal(await attr(page, '#conn', 'aria-controls'), 'conn-pop')
    assert.equal(await attr(page, '#btn-drawer', 'aria-controls'), 'drawer')
    assert.equal(await attr(page, '#btn-drawer', 'aria-expanded'), 'false')
    assert.equal(await attr(page, '.tab-actions [data-action="status-bar"]', 'aria-pressed'), 'false')
    assert.equal(await attr(page, '.tab-actions [data-action="pane-menu"]', 'aria-haspopup'), 'menu')
    assert.equal(await attr(page, '.tab-actions [data-action="pane-menu"]', 'aria-expanded'), 'false')
    assert.equal(await attr(page, '.status-bar', 'role'), 'group')
    assert.equal(await attr(page, '.status-bar', 'aria-label'), 'Barra de status')
    assert.equal(await attr(page, '#drawer-pill', 'aria-pressed'), 'true')
    // Every control without text carries a name.
    assert.deepEqual(await probe<string[]>(page, `return [...document.querySelectorAll('button')].filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby')).map(b => b.id || b.className)`), [], 'every icon-only button has an aria-label')

    // ---- Tab order: bar -> capsule (the pill, then the active tab) -> right side ----
    await page.locator('#btn-closed').focus()
    const stops: string[] = []
    for (let i = 0; i < 3; i++) { await press(page, 'Tab'); stops.push(await focusId(page)) }
    assert.equal(stops[0], '#btn-drawer')
    assert.match(stops[1]!, /^div\.seg\.on$/, `the active capsule tab is a Tab stop: ${JSON.stringify(stops)}`)
    assert.equal(stops[2], '#conn')

    // ---- Theme menu: keys and focus return ----
    await page.locator('#btn-theme').focus()
    await press(page, 'Enter')
    await page.waitForSelector('#theme-menu:not([hidden])')
    assert.equal(await attr(page, '#btn-theme', 'aria-expanded'), 'true')
    assert.equal(await probe<string>(page, `return document.activeElement.closest('#theme-menu') ? document.activeElement.dataset.theme : ''`) !== '', true, 'focus goes into the menu')
    await press(page, 'End')
    assert.equal(await probe(page, `return document.activeElement.dataset.theme`), 'dark')
    await press(page, 'Home')
    assert.equal(await probe(page, `return document.activeElement.dataset.theme`), 'light')
    await press(page, 'ArrowUp')
    assert.equal(await probe(page, `return document.activeElement.dataset.theme`), 'dark', 'arrows wrap')
    await press(page, 'Escape')
    await page.waitForSelector('#theme-menu', { state: 'hidden' })
    assert.equal(await attr(page, '#btn-theme', 'aria-expanded'), 'false')
    assert.equal(await focusId(page), '#btn-theme', 'Esc returns the focus to the button')
    await press(page, 'Enter')
    await page.waitForSelector('#theme-menu:not([hidden])')
    await press(page, 'Home')
    await press(page, 'Enter') // light
    await page.waitForFunction(() => (document.documentElement as unknown as { dataset: Record<string, string> }).dataset.theme === 'light')
    await page.waitForSelector('#theme-menu', { state: 'hidden' })
    assert.equal(await focusId(page), '#btn-theme', 'a keyboard pick returns the focus to the button')

    // ---- Connection popover: open by key, Tab inside, Esc returns ----
    await page.locator('#conn').focus()
    await press(page, 'Enter')
    await page.waitForSelector('#conn-wrap.pinned')
    assert.equal(await attr(page, '#conn', 'aria-expanded'), 'true')
    await press(page, 'Tab')
    assert.equal(await focusId(page), '#conn-restart')
    await press(page, 'Escape')
    await page.waitForSelector('#conn-wrap.pinned', { state: 'detached' })
    assert.equal(await attr(page, '#conn', 'aria-expanded'), 'false')
    assert.equal(await focusId(page), '#conn', 'Esc returns the focus to the connection button')

    // ---- Capsule: 10 desks at 900 px, roving tabindex, "+N" ----
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 700))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 900) <= 2)
    for (let i = 0; i < 9; i++) await page.evaluate(() => window.__tether.createDesk('after'))
    await page.waitForFunction(() => window.__tether.switchState().hidden.length > 0)
    await sleep(400)
    const order = await probe<string[]>(page, `return [...document.querySelectorAll('#desk-switch .seg[data-desk]')].map(s => s.dataset.desk)`)
    assert.ok(order.length >= 2, 'at least two visible tabs')
    await page.locator('#desk-switch .seg.on').focus()
    const startAt = order.indexOf((await focusedDesk(page))!)
    await press(page, 'Home')
    assert.equal(await focusedDesk(page), order[0])
    await press(page, 'End')
    assert.equal(await focusedDesk(page), order[order.length - 1])
    await press(page, 'ArrowRight')
    assert.equal(await focusedDesk(page), order[0], 'arrows wrap')
    await press(page, 'ArrowRight')
    assert.equal(await focusedDesk(page), order[1])
    assert.equal(await probe(page, `return document.activeElement.tabIndex`), 0, 'roving: the focused tab is the Tab stop')
    assert.ok(startAt >= 0)
    await press(page, 'Enter')
    await page.waitForFunction(id => window.__tether.activeDesk() === id, order[1]!)
    await sleep(300)

    // The "+N": Down opens, Home/End/arrows, Esc returns; Enter picks and the FLIP runs (not under reduced motion).
    const more = '#desk-switch .desk-more'
    await probe(page, `window.__flip = 0; const o = Element.prototype.animate; Element.prototype.animate = function (k, opt) { if (Array.isArray(k) && k.some(f => f.transform && f.transform !== 'none')) window.__flip++; return o.call(this, k, opt) }`)
    const hiddenBefore = await page.evaluate(() => window.__tether.switchState().hidden)
    assert.ok(hiddenBefore.length >= 2, `at least two hidden desks: ${hiddenBefore.length}`)
    await page.locator(more).focus()
    assert.equal(await attr(page, more, 'aria-expanded'), 'false')
    await press(page, 'ArrowDown')
    await page.waitForSelector('#ctx-menu')
    assert.equal(await attr(page, more, 'aria-expanded'), 'true')
    assert.equal((await menuItems(page)).length, hiddenBefore.length)
    const items = await menuItems(page)
    assert.equal(await focusedItem(page), items[0], 'the first entry is focused')
    await press(page, 'End')
    assert.equal(await focusedItem(page), items[items.length - 1])
    await press(page, 'Home')
    assert.equal(await focusedItem(page), items[0])
    await press(page, 'ArrowUp')
    assert.equal(await focusedItem(page), items[items.length - 1], 'arrows wrap')
    await press(page, 'Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    assert.equal(await attr(page, more, 'aria-expanded'), 'false')
    assert.match(await focusId(page), /desk-more/, 'Esc returns the focus to the "+N"')
    await press(page, 'Enter')
    await page.waitForSelector('#ctx-menu')
    await press(page, 'Enter') // picks the first hidden desk
    await page.waitForFunction(id => window.__tether.activeDesk() === id, hiddenBefore[0]!)
    await sleep(500)
    assert.ok(await probe<number>(page, `return window.__flip`) > 0, 'the capsule animated the reorder (FLIP)')
    // Reduced motion: the same kind of pick, no animation.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await probe(page, `window.__flip = 0`)
    const hiddenNow = await page.evaluate(() => window.__tether.switchState().hidden)
    await page.locator(more).focus()
    await press(page, 'ArrowDown')
    await page.waitForSelector('#ctx-menu')
    await press(page, 'End')
    await press(page, 'Enter')
    await page.waitForFunction(id => window.__tether.activeDesk() === id, hiddenNow[hiddenNow.length - 1]!)
    await sleep(500)
    assert.equal(await probe(page, `return window.__flip`), 0, 'no FLIP under prefers-reduced-motion')
    await page.emulateMedia({ reducedMotion: null })
    // The ring is visible on a focused capsule tab.
    await page.locator('#desk-switch .seg.on').focus()
    await press(page, 'ArrowRight')
    assert.notEqual(await probe(page, `return getComputedStyle(document.activeElement).outlineStyle`), 'none', 'a focus ring on the capsule tab')

    // ---- Tab strip: "+N" and "⋯" ----
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(600, 700))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 600) <= 2)
    for (let i = 0; i < 10; i++) await createShell(page, root)
    await page.waitForFunction(() => { const m = document.querySelector('.desk-layer:not(.inactive) .tab-actions .tab-more') as unknown as { hidden: boolean } | null; return !!m && !m.hidden })
    await sleep(400)
    const tmore = '.desk-layer:not(.inactive) .tab-actions .tab-more'
    assert.equal(await attr(page, tmore, 'aria-haspopup'), 'menu')
    assert.equal(await attr(page, tmore, 'aria-expanded'), 'false')
    assert.match((await attr(page, tmore, 'aria-label')) ?? '', /abas? escondidas?/)
    await page.locator(tmore).focus()
    await press(page, 'ArrowDown')
    await page.waitForSelector('#ctx-menu')
    assert.equal(await attr(page, tmore, 'aria-expanded'), 'true')
    const titems = await menuItems(page)
    await press(page, 'End')
    assert.equal(await focusedItem(page), titems[titems.length - 1])
    await press(page, 'Home')
    assert.equal(await focusedItem(page), titems[0])
    await press(page, 'Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    assert.equal(await attr(page, tmore, 'aria-expanded'), 'false')
    assert.match(await focusId(page), /tab-more/, 'Esc returns the focus to the strip\'s "+N"')
    const dots = '.desk-layer:not(.inactive) .tab-actions [data-action="pane-menu"]'
    await page.locator(dots).focus()
    await press(page, 'ArrowDown')
    await page.waitForSelector('#ctx-menu')
    assert.equal(await attr(page, dots, 'aria-expanded'), 'true')
    await press(page, 'Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    assert.equal(await attr(page, dots, 'aria-expanded'), 'false')
    assert.equal(await probe(page, `return document.activeElement.dataset.action`), 'pane-menu', 'Esc returns the focus to "⋯"')
    assert.notEqual(await probe(page, `return getComputedStyle(document.activeElement).outlineStyle`), 'none', 'a focus ring on the strip button')
    // The "+N" text is the neutral dim token (not a tint): its computed colour is --fg-dim, and it is 12px/600.
    const dim = await token(page, '--fg-dim')
    const tc = await probe<{ color: string; size: string; weight: string; will: string }>(page, `const s = getComputedStyle(document.querySelector('.desk-layer:not(.inactive) .tab-actions .tab-more')); return { color: s.color, size: s.fontSize, weight: s.fontWeight, will: s.willChange }`)
    const rgb = await probe<string>(page, `const d = document.createElement('i'); d.style.color = ${JSON.stringify(dim)}; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c`)
    assert.equal(tc.color, rgb, '"+N" colour is --fg-dim')
    assert.equal(tc.size, '12px'); assert.equal(tc.weight, '600'); assert.equal(tc.will, 'transform')
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      const h = (await rects(page, '.desk-layer:not(.inactive) .dv-tabs-and-actions-container'))[0]!
      const b64 = await app.evaluate(async ({ BrowserWindow }, rect) => {
        const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rect)
        return img.toPNG().toString('base64')
      }, { x: Math.floor(h.left), y: Math.floor(h.top), width: Math.ceil(h.width), height: Math.ceil(h.height) + 1 })
      writeFileSync(join(artifacts, `chrome-a11y-tabs-${scheme}.png`), Buffer.from(b64, 'base64'))
      // The "+N" glyphs are grey, not tinted: the average chroma of its non-background pixels stays low (it was ~50-60
      // with the coloured LCD anti-aliasing fringes, which read as a purple/green tint).
      const m = (await rects(page, tmore))[0]!
      const chroma = await app.evaluate(async ({ BrowserWindow }, rect) => {
        const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rect)
        const bm = img.toBitmap(); const { width, height } = img.getSize()
        const bg = [bm[2]!, bm[1]!, bm[0]!]
        let n = 0, sum = 0
        for (let i = 0; i < width * height; i++) {
          const r = bm[i * 4 + 2]!, g = bm[i * 4 + 1]!, b = bm[i * 4]!
          if (Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(b - bg[2]!) < 30) continue
          n++; sum += Math.max(r, g, b) - Math.min(r, g, b)
        }
        return { n, avg: n ? sum / n : 0 }
      }, { x: Math.floor(m.left), y: Math.floor(m.top), width: Math.ceil(m.width), height: Math.ceil(m.height) })
      assert.ok(chroma.n > 0 && chroma.avg < 25, `${scheme}: the "+N" text is neutral grey: ${JSON.stringify(chroma)}`)
    }

    // ---- Drawer: frames are cards on the desk surface, --gap (8 px) around and between them ----
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 1280) <= 2)
    // Two frames in the drawer: a second frame on its desk by the hooks (level 'desk'), then both frames moved into the drawer.
    const ids0 = await page.evaluate(() => window.__tether.panelIds())
    await page.evaluate(id => (window as unknown as { __tether: { duplicate(id: string, d: string, l: string): void } }).__tether.duplicate(id, 'right', 'desk'), ids0[0]!)
    await page.waitForFunction(n => window.__tether.panelIds().length === n + 1, ids0.length)
    const ids1 = await page.evaluate(() => window.__tether.panelIds())
    const second = ids1.find(i => !ids0.includes(i))!
    for (const id of [ids0[0]!, second]) {
      await page.evaluate(id => (window as unknown as { __tether: { moveFrameToDrawer(id: string): void } }).__tether.moveFrameToDrawer(id), id)
      await page.waitForFunction(id => (window as unknown as { __tether: { inDrawer(id: string): boolean } }).__tether.inDrawer(id), id)
    }
    const gaps = async (): Promise<void> => {
      const body = (await rects(page, '.drawer-body'))[0]!
      const bar = (await rects(page, '.drawer-bar'))[0]!
      const docks = await rects(page, '.drawer .frame-dock')
      assert.equal(docks.length, 2, 'two frames in the drawer')
      const near = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) <= 1.5, `${what}: ${a} vs ${b}`)
      near(Math.min(...docks.map(d => d.left)) - body.left, 8, 'left gap')
      near(body.right - Math.max(...docks.map(d => d.right)), 8, 'right gap')
      near(Math.min(...docks.map(d => d.top)) - bar.bottom, 8, 'top gap under the bar')
      near(body.bottom - Math.max(...docks.map(d => d.bottom)), 8, 'bottom gap')
      const [a, b] = [...docks].sort((p, q) => p.left - q.left || p.top - q.top) as [Rect, Rect]
      const between = Math.max(b.left - a.right, b.top - a.bottom)
      near(between, 8, 'gap between the frames')
      const s = await probe<{ radius: string; border: string; frame: string; deskBg: string; bodyBg: string }>(page, `const d = document.querySelector('.drawer .frame-dock'); const c = getComputedStyle(d); return { radius: c.borderTopLeftRadius, border: c.borderTopWidth, frame: c.backgroundColor, deskBg: getComputedStyle(document.querySelector('.drawer-desk')).backgroundColor, bodyBg: getComputedStyle(document.querySelector('.drawer-card')).backgroundColor }`)
      assert.equal(s.radius, '10px', 'cards are rounded')
      assert.equal(s.border, '1px')
      assert.notEqual(s.frame, s.deskBg, 'the card is not the surface it sits on')
      assert.equal(s.deskBg, s.bodyBg, 'the surface is the desk colour')
    }
    const drawerOpen = (open: boolean) => page.waitForFunction(o => (window.getComputedStyle(document.querySelector('#drawer')).visibility === 'visible') === o, open)
    await press(page, 'Control+Backquote')
    await drawerOpen(true)
    await sleep(600)
    assert.equal(await attr(page, '#btn-drawer', 'aria-expanded'), 'true')
    await gaps()
    for (const scheme of ['light', 'dark'] as const) {
      await press(page, 'Control+Backquote'); await drawerOpen(false)
      await setTheme(page, scheme)
      await press(page, 'Control+Backquote'); await drawerOpen(true)
      await page.mouse.move(640, 790)
      await sleep(600)
      await shot(app, `chrome-a11y-drawer-${scheme}`)
    }
    await sleep(900) // debounced save

    // After a relaunch the restored drawer has the same geometry.
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => (window as unknown as { __tether: { drawer(): { panes: string[] } } }).__tether.drawer().panes.length >= 2)
    await press(page, 'Control+Backquote')
    await drawerOpen(true)
    await sleep(600)
    await gaps()
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
