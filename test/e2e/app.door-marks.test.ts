// E2E of the extensions' marks (agent door, slice R2) with the door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in this
// process on a private home and pipe, the real app on the same pipe, hidden window. No agent process, no LLM.
//   1. a menu row whose icon name the app does not have draws without an icon and does not take the menu down;
//   2. the seal shows on a common desk pill, the orange count does not change, and everything goes when the extension goes;
//   3. the emblem shows on the right of a terminal tab and of a note tab and follows the pane when it changes desk. With
//      TETHER_MARKS_PRINTS set to a folder, two prints (light and dark theme) go there.
//   4. (K1.2-K1.5) the struck seal and the seal the extension answers a click on; a set of emblems (a letter, a glyph, at most
//      three, a struck one); the line under a tab; the line in a panel's status bar. Taken away, the marks are today's again,
//      and everything goes with the extension. With TETHER_K1_PRINTS set to a folder, one print per seam (light theme).
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
  // The capsule is as wide as the toolbar lets it (the wider side twice, off the window), and the Gaveta, the system desks'
  // pills (Browser, Regência, Prova) and the "+" and "⋯" count as its chrome. In the default hidden window that leaves room for
  // the active desk and little more, so a second desk carrying a labeled seal drops into the "+N" and its pill is not in the
  // strip. The seal's own geometry is what these tests look at, so they get a window the pills fit in.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1800, 900) })
  await page.waitForFunction(() => document.documentElement.clientWidth >= 1700)
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

const pill = (page: Page, desk: string) => page.locator(`#desk-switch .seg[data-desk="${desk}"]`)
const tabOf = (page: Page, paneId: string) => page.locator(`.tether-tab[data-slot="${paneId}"]`)

test('door marks: the desk seal and the tab emblem', { timeout: 300_000 }, async () => {
  await withApp(async (page, home) => {
    // door.css is linked by the page itself (index.html): the geometry below and the prints are the real ones.
    assert.ok(await page.evaluate(() => [...document.styleSheets].some(sheet => (sheet.href ?? '').endsWith('door/door.css'))), 'index.html links door.css')
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
    assert.equal(await pill(page, 'desk-2').locator('.desk-seal .nm').count(), 0, 'no label: the glyph alone')
    const bareWidth = (await pill(page, 'desk-2').locator('.desk-seal').boundingBox())!.width

    // A label sits beside the glyph, wider than the bare seal, and a long one is cut at a fixed width.
    await probe(page, 'seal', 'desk-2', { icon: 'puzzle-piece', hue, label: 'Atrium', tooltip: 'Dona: Atrium' })
    await pill(page, 'desk-2').locator('.desk-seal .nm').waitFor()
    assert.equal(await pill(page, 'desk-2').locator('.desk-seal .nm').innerText(), 'Atrium')
    assert.ok((await pill(page, 'desk-2').locator('.desk-seal').boundingBox())!.width > bareWidth, 'the labeled seal is wider than the bare one')
    await probe(page, 'seal', 'desk-2', { icon: 'puzzle-piece', hue, label: 'Um nome de dono muito, muito mais comprido do que cabe na pílula', tooltip: 'Dona: longa' })
    await page.waitForFunction(() => document.querySelector('#desk-switch .seg[data-desk="desk-2"] .desk-seal .nm')?.textContent?.startsWith('Um nome'))
    const cut = await pill(page, 'desk-2').locator('.desk-seal').evaluate(el => ({ w: el.getBoundingClientRect().width, nm: el.querySelector('.nm')!.scrollWidth > el.querySelector('.nm')!.clientWidth }))
    assert.ok(cut.w <= 150.5, `a long label does not push the other pills (seal ${cut.w}px)`)
    assert.ok(cut.nm, 'the long label is cut')
    await probe(page, 'seal', 'desk-2', { icon: 'puzzle-piece', hue, label: 'Atrium', tooltip: 'Dona: Atrium' })
    await page.waitForFunction(() => document.querySelector('#desk-switch .seg[data-desk="desk-2"] .desk-seal .nm')?.textContent === 'Atrium')

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

    // ---- the prints: light and dark, the strip (desk-2 with the label, desk-1 without) and the tabs ----
    await probe(page, 'seal', 'desk-1', { icon: 'puzzle-piece', hue: agentHue('claude-2'), tooltip: 'Sem rótulo' })
    await pill(page, 'desk-1').locator('.desk-seal').waitFor()
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

/** What a pill, a tab and a status bar show of the extensions, as text: equal strings mean the same marks. */
const marksOf = (page: Page, desk: string, paneId: string): Promise<string> => page.evaluate(({ desk, paneId }) => {
  const pill = document.querySelector(`#desk-switch .seg[data-desk="${desk}"]`)
  const tab = document.querySelector<HTMLElement>(`.tether-tab[data-slot="${paneId}"]`)
  const bar = document.querySelector<HTMLElement>(`.panel[data-slot-id="${paneId}"] .status-bar`)
  const box = tab?.querySelector<HTMLElement>('.ext-emblems')
  return JSON.stringify({
    seals: [...(pill?.querySelectorAll('.desk-seal') ?? [])].map(s => s.outerHTML),
    tabLine: tab?.classList.contains('ext-line') ?? null, tabHue: tab?.style.getPropertyValue('--line-hue') ?? null,
    emblems: box?.innerHTML ?? null, emblemsHidden: box?.hidden ?? null,
    head: bar ? [...bar.children].filter(c => !(c as HTMLElement).hidden).map(c => c.className) : null,
  })
}, { desk, paneId })

type Box = { x: number; y: number; width: number; height: number }

test('door marks K1.2-K1.5: struck and clickable seal, emblem sets, the tab line and the status bar line', { timeout: 300_000 }, async () => {
  await withApp(async (page, home) => {
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    const create = (name: string): Promise<string> => page.evaluate(async ({ cwd, name }) => (await window.tether.request({ t: 'create', kind: 'shell', cwd, name, start: false })).slot!.slotId, { cwd: home, name })
    const ownerTab = await create('Atrium · Claude')
    const commanded = await create('soul · bancada')
    const given = await create('codex · conferência')
    await page.waitForTimeout(500)
    for (const id of [ownerTab, commanded, given]) await page.evaluate(id => window.__tether.openSlot(id), id)
    for (const id of [ownerTab, commanded, given]) await tabOf(page, id).waitFor()
    // The status bar of the pane the line goes in, shown (it starts hidden).
    await tabOf(page, given).click()
    await tabOf(page, given).click({ button: 'right' })
    await page.locator('#ctx-menu li', { hasText: 'Mostrar barra de status' }).click()
    const bar = page.locator(`.panel[data-slot-id="${given}"] .status-bar`)
    await bar.waitFor()
    const hueA = agentHue('claude-1')
    const hueK = agentHue('claude-2')
    const before = { d1: await marksOf(page, 'desk-1', commanded), d2: await marksOf(page, 'desk-2', given) }
    const dir = process.env.TETHER_K1_PRINTS
    if (dir) { mkdirSync(dir, { recursive: true }); await page.evaluate(() => { document.documentElement.dataset.theme = 'light' }) }
    const shot = async (name: string, boxes: Array<Box | null>): Promise<void> => {
      if (!dir) return
      await page.waitForTimeout(250)
      const bs = boxes.filter((b): b is Box => b !== null)
      const x = Math.max(0, Math.min(...bs.map(b => b.x)) - 10), y = Math.max(0, Math.min(...bs.map(b => b.y)) - 10)
      const right = Math.max(...bs.map(b => b.x + b.width)) + 10, bottom = Math.max(...bs.map(b => b.y + b.height)) + 10
      await page.screenshot({ path: join(dir, name), clip: { x, y, width: right - x, height: bottom - y } })
    }

    // ---- K1.2: the seal on a pill, struck, and a click the extension answers ----
    await probe(page, 'sealState', 'desk-1', { icon: 'puzzle-piece', hue: hueA, label: 'Atrium', tooltip: 'Dona: Atrium · clique: ir para Atrium', clickable: true })
    await probe(page, 'sealState', 'desk-2', { icon: 'puzzle-piece', hue: hueK, label: 'Kai', tooltip: 'Kai encerrou às 13:40', variant: 'struck' })
    await pill(page, 'desk-2').locator('.desk-seal.struck').waitFor()
    const struck = await pill(page, 'desk-2').locator('.desk-seal').evaluate(el => ({ outline: getComputedStyle(el).outlineStyle, line: getComputedStyle(el.querySelector('.nm')!).textDecorationLine, bg: getComputedStyle(el).backgroundColor }))
    assert.equal(struck.outline, 'dashed', 'the struck seal is dashed')
    assert.equal(struck.line, 'line-through', 'and its name struck through')
    assert.equal(struck.bg, 'rgba(0, 0, 0, 0)', 'without fill')
    assert.equal(await pill(page, 'desk-1').locator('.desk-seal.struck').count(), 0, 'solid is the default')
    await pill(page, 'desk-2').locator('.desk-seal').click()
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    assert.deepEqual(await probe<string[]>(page, 'sealClicks'), [], 'a seal without onActivate is the pill: it shows its desk')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    // On desk-2 seen from desk-1: the click is the extension's and the visible desk does not change.
    await probe(page, 'sealState', 'desk-2', { icon: 'puzzle-piece', hue: hueK, label: 'Kai', tooltip: 'Kai encerrou às 13:40', variant: 'struck', clickable: true })
    await pill(page, 'desk-2').locator('.desk-seal.act').waitFor()
    await pill(page, 'desk-2').locator('.desk-seal').click()
    await page.waitForTimeout(200)
    assert.deepEqual(await probe<string[]>(page, 'sealClicks'), ['desk-2'], 'the click reached the extension')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), 'desk-1', 'and the visible desk did not change')
    await shot('k1.2-selo-cheio-e-riscado-light.png', [await page.locator('#desk-switch').boundingBox()])

    // ---- K1.3: a set of emblems (a letter, a glyph), cut at three; a struck one ----
    await probe(page, 'emblemSet', given, [
      { icon: '', label: 'Kai', hue: hueK, tooltip: 'Dada a Kai' },
      { icon: 'eye', hue: hueA, tooltip: 'Atrium vê' },
      { icon: 'tag', tooltip: 'terceiro' },
      { icon: 'tag', tooltip: 'quarto (cai)' },
    ])
    await tabOf(page, given).locator('.ext-emblem').nth(2).waitFor()
    const set = await tabOf(page, given).locator('.ext-emblems > .ext-emblem').evaluateAll(els => els.map(e => ({ cls: e.className, text: e.textContent, svg: e.querySelectorAll('svg').length, title: e.getAttribute('title') })))
    assert.equal(set.length, 3, 'three at most')
    assert.deepEqual(set.map(e => e.title), ['Dada a Kai', 'Atrium vê', 'terceiro'], 'in the order given')
    assert.ok(set[0]!.cls.includes('letter') && set[0]!.text === 'K' && set[0]!.svg === 0, 'the letter, alone')
    assert.equal(set[1]!.svg, 1, 'the glyph')
    await probe(page, 'emblem', ownerTab, { icon: 'star', hue: hueA, tooltip: 'Dona da mesa' })
    await probe(page, 'emblemSet', commanded, [{ icon: '', label: 'K', hue: hueK, tooltip: 'Kai encerrou', variant: 'struck' }])
    await tabOf(page, commanded).locator('.ext-emblem.struck').waitFor()
    assert.equal(await tabOf(page, commanded).locator('.ext-emblem.struck').evaluate(el => getComputedStyle(el).outlineStyle), 'dashed')
    await shot('k1.3-emblemas-light.png', [await tabOf(page, ownerTab).boundingBox(), await tabOf(page, given).boundingBox()])
    await probe(page, 'emblemSet', commanded, undefined)

    // ---- K1.4: the thin line under a commanded tab ----
    await probe(page, 'tabLine', commanded, hueA)
    await page.waitForFunction(id => document.querySelector(`.tether-tab[data-slot="${id}"]`)?.classList.contains('ext-line') === true, commanded)
    const line = await tabOf(page, commanded).evaluate(el => ({ hue: (el as HTMLElement).style.getPropertyValue('--line-hue'), shadow: getComputedStyle(el).boxShadow }))
    assert.equal(line.hue, String(hueA))
    assert.match(line.shadow, /inset/, `the line is drawn (${line.shadow})`)
    assert.equal(await tabOf(page, given).evaluate(el => el.classList.contains('ext-line')), false, 'only on that tab')
    // It follows the pane to another desk and back.
    await page.evaluate(id => { window.__tether.movePaneToDesk(id, 'desk-2'); window.__tether.switchDesk('desk-2') }, commanded)
    await page.waitForFunction(id => window.__tether.activeDesk() === 'desk-2' && document.querySelector(`.tether-tab[data-slot="${id}"]`)?.classList.contains('ext-line') === true, commanded)
    await page.evaluate(id => { window.__tether.movePaneToDesk(id, 'desk-1'); window.__tether.switchDesk('desk-1') }, commanded)
    await page.waitForFunction(id => window.__tether.activeDesk() === 'desk-1' && document.querySelector(`.tether-tab[data-slot="${id}"]`)?.classList.contains('ext-line') === true, commanded)
    await tabOf(page, given).click()
    await shot('k1.4-sublinhado-light.png', [await tabOf(page, ownerTab).boundingBox(), await tabOf(page, given).boundingBox(), await tabOf(page, commanded).boundingBox()])

    // ---- K1.5: the status bar line, its ▾ opening the tab menu by it, read back for a manager ----
    assert.equal(await bar.locator('.ext-head').evaluate(el => (el as HTMLElement).hidden), true, 'hidden while empty')
    await probe(page, 'headItem', given, { icon: 'puzzle-piece', hue: hueA, text: 'Atrium pela mesa · enviou pedido 14:02', tooltip: 'Quem comanda e a última coisa que fez', menu: true })
    const item = bar.locator('.ext-head > .ext-head-item')
    await item.waitFor()
    assert.equal(await item.locator('.tx').innerText(), 'Atrium pela mesa · enviou pedido 14:02')
    assert.equal(await item.locator('svg.caret').count(), 1, 'a caret when it opens something')
    const order = await bar.evaluate(el => [...el.children].map(c => c.className.split(' ')[0]))
    assert.ok(order.indexOf('ext-head') > order.indexOf('ronda') && order.indexOf('ext-head') < order.indexOf('sp'), `after the core's marks, before the actions (${order.join(' ')})`)
    assert.deepEqual(await probe(page, 'headItems', given), [{ text: 'Atrium pela mesa · enviou pedido 14:02', hue: hueA, clickable: true }])
    assert.deepEqual(await probe(page, 'headItems', commanded), [], 'none on another pane')
    await shot('k1.5-barra-de-status-light.png', [await bar.boundingBox()])
    await item.click()
    await page.waitForSelector('#ctx-menu li')
    assert.deepEqual(await probe<string[]>(page, 'headClicks'), [given])
    await page.keyboard.press('Escape')
    await probe(page, 'headItem', given, { icon: 'puzzle-piece', text: 'com você · antes: Atrium, pela mesa', tooltip: 'Tomada por você' })
    await page.waitForFunction(id => document.querySelector(`.panel[data-slot-id="${id}"] .ext-head-item .tx`)?.textContent === 'com você · antes: Atrium, pela mesa', given)
    assert.equal(await bar.locator('.ext-head-item svg.caret').count(), 0, 'no caret without a click')
    assert.equal(await bar.locator('span.ext-head-item').count(), 1, 'plain text, not a button')

    // ---- taken away: the marks are today's again; then everything goes with the extension ----
    await probe(page, 'sealState', 'desk-1', undefined)
    await probe(page, 'sealState', 'desk-2', undefined)
    await probe(page, 'emblem', ownerTab, undefined)
    await probe(page, 'emblemSet', given, [])
    await probe(page, 'tabLine', commanded, undefined)
    await probe(page, 'headItem', given, undefined)
    await page.waitForTimeout(300)
    assert.equal(await marksOf(page, 'desk-1', commanded), before.d1, 'pill and tab as before')
    assert.equal(await marksOf(page, 'desk-2', given), before.d2, 'pill, tab and status bar as before')
    await probe(page, 'sealState', 'desk-2', { icon: 'puzzle-piece', label: 'Kai', tooltip: 'x', variant: 'struck', clickable: true })
    await probe(page, 'emblemSet', given, [{ icon: '', label: 'K', tooltip: 'x' }])
    await probe(page, 'tabLine', given, hueA)
    await probe(page, 'headItem', given, { icon: 'puzzle-piece', text: 'linha', tooltip: '' })
    await bar.locator('.ext-head-item').waitFor()
    await page.evaluate(() => window.__tether.disposeExtension('door-probe'))
    await page.waitForFunction(() => document.querySelectorAll('.ext-emblem, .desk-seal, .ext-line, .ext-head-item').length === 0)
    assert.equal(await marksOf(page, 'desk-2', given), before.d2, 'nothing of the extension after it went')
  })
})
