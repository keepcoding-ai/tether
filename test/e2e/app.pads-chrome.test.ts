// E2E of the pads' chrome (hidden window, private home/pipe, real tetherd, shells only):
//   1. the side bars' icons: closed = Phosphor regular (outline), open = Phosphor fill, `aria-pressed`, no box (radius 0,
//      44px cell), the bar on the strip's outer edge (left bar on the left side bar, right bar on the right one) in --accent;
//   2. the gap: the explorer's card (left) and the desk pad's frame (right) are one --gap from the desks' cards, the same
//      as between two frames of the desk; their tops are level with the desks';
//   3. header absorption: no pad header row; the desk pad's frame "⋯" carries the pad's title and items ("Mover para a
//      barra esquerda" moves it, "Restaurar posição padrão" brings it back); its floating "⋯" is hidden while it has tabs;
//      the explorer's top bar "⋯" opens the pad's menu, with its own items, and "Fechar" closes it;
//      the icon's tooltip carries the pad's title with the desk's name.
// Screenshots light and dark in <atrium>/.tmp/tether-pads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  frameIds(): string[]
  activate(id: string): void
  togglePad(id: string): void
  sidebars(): { left: { strip: string[]; open?: string }; right: { strip: string[]; open?: string } } | undefined
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
}
type R = { left: number; right: number; top: number; bottom: number; width: number; height: number }
type El = { getBoundingClientRect(): R; title: string; textContent: string | null; dataset: Record<string, string>; querySelector(s: string): El | null; getAttribute(n: string): string | null }
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }
declare const document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> & Iterable<El>; documentElement: El & { dataset: Record<string, string> } }
declare const getComputedStyle: (el: El, pseudo?: string) => Record<string, string> & { getPropertyValue(n: string): string }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-pads-chrome-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const shots = process.env.TETHER_SHOTS ?? join(atriumTmp, 'tether-pads')
const DESK_PAD = 'frame-pads.desk'
const EXPLORER = 'explorer.files'

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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
  await sleep(300)
}

const icon = (pad: string): string => `.sb-icon[data-pad="${pad}"]`

/** What the strip shows for a pad's icon: its glyph, pressed state, cell size, radius, and the bar's side and colour. */
const iconState = (page: Page, pad: string) => page.evaluate(sel => {
  const b = document.querySelector(sel)!
  const cs = getComputedStyle(b)
  const bar = getComputedStyle(b, '::before')
  const r = b.getBoundingClientRect()
  return {
    glyph: b.querySelector('svg')?.dataset.icon, pressed: b.getAttribute('aria-pressed'), width: r.width, height: r.height,
    glyphSize: b.querySelector('svg')!.getBoundingClientRect().width, radius: cs.borderTopLeftRadius,
    bar: bar.content === 'none' || bar.content === '' ? undefined : { left: bar.left, right: bar.right, color: bar.backgroundColor },
    accent: (() => { const p = document.querySelector('#workbench')!; const t = getComputedStyle(p).getPropertyValue('--accent').trim(); return t })(),
    title: b.title,
  }
}, icon(pad))

const rects = (page: Page) => page.evaluate(() => {
  const r = (el: El): R => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }
  const desk = [...document.querySelectorAll('.desk-layer:not(.inactive) .frame-dock')].map(r).sort((a, b) => a.left - b.left)
  const pad = document.querySelector('#pads .pad.shown[data-pad="frame-pads.desk"] .frame-dock')
  const xp = document.querySelector('#pads .pad.shown[data-pad="explorer.files"] .xp')
  return { desk, pad: pad ? r(pad) : undefined, xp: xp ? r(xp) : undefined, gap: parseFloat(getComputedStyle(document.documentElement as unknown as El).getPropertyValue('--gap')) }
})

const visible = (page: Page, sel: string) => page.evaluate(s => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().width > 0 }, sel)

async function menuHas(page: Page, label: string): Promise<void> {
  await page.locator('#ctx-menu li', { hasText: label }).first().waitFor({ state: 'visible' })
}

test('pads chrome: activity-bar icons, one --gap to the desks, content that absorbs the pad header', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'tether-pads-chrome-'))
  const work = mkdtempSync(join(tmpBase, 'tether-pads-chrome-work-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme: 'light' }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // Two frames on the desk: the gap between them is the reference.
    const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), work)
    const a = reply.slot!.slotId
    await page.evaluate(id => window.__tether.openSlot(id), a)
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', a, { timeout: 20_000 })
    await page.evaluate(id => window.__tether.activate(id), a)
    await page.locator(`.panel[data-slot-id="${a}"] .panel-term`).click()
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await page.waitForFunction(() => window.__tether.frameIds().length === 2)

    // ---- 1. icons, closed ----
    console.log('step 1')
    for (const pad of [DESK_PAD, EXPLORER]) {
      const s = await iconState(page, pad)
      assert.equal(s.pressed, 'false')
      assert.ok(s.glyph && !s.glyph.endsWith('-fill'), `${pad} closed: regular weight (${s.glyph})`)
      assert.equal(s.bar, undefined, `${pad} closed: no bar`)
      assert.equal(s.radius, '0px', 'no rounded box')
      assert.equal(Math.round(s.width), 44); assert.equal(Math.round(s.height), 44); assert.equal(Math.round(s.glyphSize), 24)
    }
    await page.screenshot({ path: join(shots, 'icons-closed-light.png') })

    // Pads closed: the desk's outermost frame touches the icon strip on each side, so icon-to-frame = icon-to-window-edge.
    const c = await page.evaluate(({ e, d }) => {
      const gl = (sel: string): R => document.querySelector(sel)!.querySelector('svg')!.getBoundingClientRect()
      const L = gl(e), Rr = gl(d)
      const fr = Array.from(document.querySelectorAll('#dock .frame-dock')).map(f => f.getBoundingClientRect())
      const win = (globalThis as unknown as { innerWidth: number }).innerWidth
      return {
        leftEdge: L.left, leftFrame: Math.min(...fr.map(r => r.left)) - L.right,
        rightEdge: win - Rr.right, rightFrame: Rr.left - Math.max(...fr.map(r => r.right)),
      }
    }, { e: `#sidebar-left ${icon(EXPLORER)}`, d: `#sidebar-right ${icon(DESK_PAD)}` })
    console.log(JSON.stringify({ deskIconMargins: c }))
    assert.ok(Math.abs(c.leftFrame - c.leftEdge) <= 0.5, `pads closed, left: icon to desk frame = icon to window edge (${c.leftFrame} vs ${c.leftEdge})`)
    assert.ok(Math.abs(c.rightFrame - c.rightEdge) <= 0.5, `pads closed, right: icon to desk frame = icon to window edge (${c.rightFrame} vs ${c.rightEdge})`)
    await page.screenshot({ path: join(atriumTmp, 'tether-desk-edge.png') })

    // ---- open both (explorer left, desk pad right) ----
    await page.click(`#sidebar-left ${icon(EXPLORER)}`)
    await page.click(`#sidebar-right ${icon(DESK_PAD)}`)
    await page.waitForFunction(() => { const s = window.__tether.sidebars(); return s?.left.open === 'explorer.files' && s?.right.open === 'frame-pads.desk' })
    await page.waitForFunction(() => window.__tether.padFrames().some(p => p.pad === 'frame-pads.desk' && p.shown && p.panes.length === 1))
    await sleep(300)
    const accentRgb = await page.evaluate(() => { const d = document.querySelector('#workbench')!; return getComputedStyle(d).getPropertyValue('--accent') })
    for (const [pad, side] of [[EXPLORER, 'left'], [DESK_PAD, 'right']] as const) {
      const s = await iconState(page, pad)
      assert.equal(s.pressed, 'true')
      assert.ok(s.glyph?.endsWith('-fill'), `${pad} open: fill weight (${s.glyph})`)
      assert.ok(s.bar, `${pad} open: a bar`)
      assert.equal(side === 'left' ? s.bar!.left : s.bar!.right, '0px', `${pad}: the bar on the outer edge (${side})`)
      assert.equal(side === 'left' ? s.bar!.right : s.bar!.left, `${Math.round(s.width) - 2}px`, `${pad}: a 2px bar, only on that edge`)
      assert.ok(accentRgb.trim().length > 0)
    }
    const deskTip = (await iconState(page, DESK_PAD)).title
    assert.match(deskTip, /^Prancheta da mesa · /, `the icon tooltip carries the pad title with the desk (${deskTip})`)

    // ---- 2. the gap ----
    console.log('step 2')
    const g = await rects(page)
    assert.equal(g.desk.length, 2)
    const between = g.desk[1]!.left - g.desk[0]!.right
    const right = g.pad!.left - g.desk[1]!.right
    const left = g.desk[0]!.left - g.xp!.right
    console.log(JSON.stringify({ gapToken: g.gap, between, padRight: right, explorerLeft: left }))
    assert.ok(Math.abs(between - g.gap) <= 0.5, `between frames = --gap (${between} vs ${g.gap})`)
    assert.ok(Math.abs(right - between) <= 0.5, `desk pad ↔ desk = between frames (${right} vs ${between})`)
    assert.ok(Math.abs(left - between) <= 0.5, `explorer ↔ desk = between frames (${left} vs ${between})`)
    assert.ok(Math.abs(g.pad!.top - g.desk[0]!.top) <= 0.5, `pad card top level with the desk's (${g.pad!.top} vs ${g.desk[0]!.top})`)
    assert.ok(Math.abs(g.xp!.top - g.desk[0]!.top) <= 0.5, `explorer card top level with the desk's (${g.xp!.top} vs ${g.desk[0]!.top})`)

    // The pad's card touches the icon strip: icon-to-card = icon-to-window-edge (the glyph is centred in its cell).
    const m = await page.evaluate(({ e, d }) => {
      const gl = (sel: string): R => document.querySelector(sel)!.querySelector('svg')!.getBoundingClientRect()
      const L = gl(e), Rr = gl(d)
      const xp = document.querySelector('#pads .pad.shown[data-pad="explorer.files"] .xp')!.getBoundingClientRect()
      const pf = document.querySelector('#pads .pad.shown[data-pad="frame-pads.desk"] .frame-dock')!.getBoundingClientRect()
      const win = (globalThis as unknown as { innerWidth: number }).innerWidth
      return { leftEdge: L.left, leftFrame: xp.left - L.right, rightEdge: win - Rr.right, rightFrame: Rr.left - pf.right }
    }, { e: `#sidebar-left ${icon(EXPLORER)}`, d: `#sidebar-right ${icon(DESK_PAD)}` })
    console.log(JSON.stringify({ iconMargins: m }))
    assert.ok(Math.abs(m.leftFrame - m.leftEdge) <= 0.5, `left: icon to frame = icon to window edge (${m.leftFrame} vs ${m.leftEdge})`)
    assert.ok(Math.abs(m.rightFrame - m.rightEdge) <= 0.5, `right: icon to frame = icon to window edge (${m.rightFrame} vs ${m.rightEdge})`)
    await page.screenshot({ path: join(atriumTmp, 'tether-pad-margin.png') })

    // ---- 3. header absorbed ----
    console.log('step 3')
    assert.equal(await page.evaluate(() => document.querySelectorAll('#pads .pad .pad-head').length), 0, 'no pad header row')
    assert.equal(await visible(page, `.pad.shown[data-pad="${DESK_PAD}"] .pad-float .pad-more`), false, 'desk pad with tabs: no floating ⋯')
    assert.equal(await visible(page, `.pad.shown[data-pad="${EXPLORER}"] .pad-float .pad-more`), false, 'explorer: no floating ⋯ (its own top bar hosts it)')
    assert.equal(await page.locator(`.pad.shown[data-pad="${EXPLORER}"] .xp-topbar-title`).textContent(), 'Explorador de Projeto')
    assert.equal(await page.locator(`.pad.shown[data-pad="${EXPLORER}"] .xp-topbar .xp-open`).getAttribute('title'), 'Abrir pasta…')
    await page.screenshot({ path: join(shots, 'pads-open-light.png') })

    // The desk pad's frame "⋯": the pane's items, then the pad's title and items.
    await page.click(`.pad.shown[data-pad="${DESK_PAD}"] .tab-act[data-action="pane-menu"]`)
    await page.locator('#ctx-menu li.hd').waitFor()
    const heading = await page.locator('#ctx-menu li.hd').textContent()
    assert.match(heading ?? '', /^Prancheta da mesa · /)
    await menuHas(page, 'Fechar Prancheta da mesa')
    await page.screenshot({ path: join(shots, 'desk-pad-menu-light.png') })
    await page.locator('#ctx-menu li', { hasText: 'Mover para a barra esquerda' }).click()
    await page.waitForFunction(() => window.__tether.sidebars()?.left.open === 'frame-pads.desk')
    // On the left now: the bar follows the side.
    const moved = await iconState(page, DESK_PAD)
    assert.equal(moved.bar?.left, '0px', 'moved to the left: the bar on the left edge')
    const gl = await rects(page)
    assert.ok(Math.abs((gl.desk[0]!.left - gl.pad!.right) - between) <= 0.5, `desk pad on the left ↔ desk = between frames (${gl.desk[0]!.left - gl.pad!.right})`)
    await page.click(`.pad.shown[data-pad="${DESK_PAD}"] .tab-act[data-action="pane-menu"]`)
    await page.locator('#ctx-menu li', { hasText: 'Restaurar posição padrão' }).click()
    await page.waitForFunction(() => window.__tether.sidebars()?.right.open === 'frame-pads.desk')

    // The explorer's top bar "⋯" (its empty state: no project yet, or its tree): the pad's menu with the explorer's items.
    await page.click(`#sidebar-left ${icon(EXPLORER)}`)
    await page.waitForFunction(() => window.__tether.sidebars()?.left.open === 'explorer.files')
    await page.click(`.pad.shown[data-pad="${EXPLORER}"] .xp-topbar .xp-more`)
    await menuHas(page, 'Seguir o agente ativo')
    await menuHas(page, 'Mover para a barra direita')
    await page.screenshot({ path: join(shots, 'explorer-menu-light.png') })
    await page.locator('#ctx-menu li', { hasText: 'Fechar Explorador' }).click()
    await page.waitForFunction(() => !window.__tether.sidebars()?.left.open)

    // ---- dark ----
    await page.click(`#sidebar-left ${icon(EXPLORER)}`)
    await page.waitForFunction(() => window.__tether.sidebars()?.left.open === 'explorer.files')
    await setTheme(page, 'dark')
    await page.screenshot({ path: join(shots, 'pads-open-dark.png') })
    await page.click(`.pad.shown[data-pad="${DESK_PAD}"] .tab-act[data-action="pane-menu"]`)
    await page.locator('#ctx-menu li.hd').waitFor()
    await page.screenshot({ path: join(shots, 'desk-pad-menu-dark.png') })
    await page.keyboard.press('Escape')
    await page.click(`#sidebar-right ${icon(DESK_PAD)}`)
    await page.mouse.move(20, 400)
    await page.hover(`#sidebar-right ${icon(DESK_PAD)}`)
    await page.screenshot({ path: join(shots, 'icons-hover-dark.png') })
    const d = await iconState(page, DESK_PAD)
    assert.ok(d.glyph && !d.glyph.endsWith('-fill'), 'closed again: regular')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
