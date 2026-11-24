// E2E of the manager of the panel pad (extension panel-pad-manager): the pad's second state, where the GUIDES the pad
// keeps are managed, grouped by their owner (the panel whose frame it is). Real tetherd on a private home/pipe, hidden
// window, CLAUDE* stripped.
//   1. two notes in A's frame, B with an empty frame: one group (A) with two cards, B not listed;
//   2. the card's bar and menu are the guide's (⋯ opens it by the button); a click only selects;
//   3. Focar guia (double click) brings A forward with the note active; Fechar guia closes that pane;
//   4. dragging a card to the desk's edge MOVES the guide: on the desk, out of the pad, the card and group gone;
//   5. another desk lists nothing of this one;
//   6. a closed owner is a "fechado" group with its guides, the filter counts them; Focar guia brings the owner back;
//      closing a panel by its × closes its frame too ("N guias da prancheta fechadas", Desfazer brings the frame back
//      under the closed owner); a panel that goes by itself leaves its frame loose ("ficou solto");
//      Fechar guia on the last guide of a closed owner removes its frame;
//   7. the keyboard and the switch; 8. affinity of desk-only screens.
// Screenshots in <atrium>/.tmp/panel-pad-manager.
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

type Group = { key: string; panel: string; name: string; state: string; loose: boolean; guides: { id: string; title: string; detail: string }[] }
type Manager = { filter: string; groups: Group[]; looseGuides: number; selected?: string }
type Tree = { loose: { key: string; empty: boolean }[] }
type LayoutJSON = { sidebars?: { pads: Record<string, unknown>; meta?: Record<string, { ownerLabel: string; deskId?: string; updatedAt: number }> } }
type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  focusablePanel(): string | undefined
  activatePanel(id: string): void
  panelIds(): string[]
  openNote(path: string): Promise<void>
  panelPadManager(): Manager[]
  panelFramesTree(): Tree
  panelFramesToast(): { text: string; action?: string } | undefined
  openPanelPadManager(filter?: string, key?: string): void
  panelPadManagerOn(): boolean
  layout(): LayoutJSON
  activeDesk(): string
  switchDesk(id: string): void
  createDesk(side: string, relativeTo: string): string
  frameLayout(frameId?: string): unknown
  frameIds(): string[]
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-ppm-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = join(existsSync(atriumTmp) ? atriumTmp : tmpdir(), 'panel-pad-manager')
const shots = tmpBase
const electronPath = require('electron') as string

const PANEL = 'frame-pads.panel'
const key = (panelId: string): string => `${PANEL}@${panelId}`
const shown = `#pads .pad.shown[data-pad="${PANEL}"]`
/** The manager as the e2e sees it: inside the pad on screen, never a tab on the desk. */
const inPad = `${shown} .pad-manager.pf-pane:not([hidden])`
const card = (paneId: string): string => `${inPad} .pf-row[data-pane="${paneId}"]`
const owner = (k: string): string => `${inPad} .pf-owner[data-key="${k}"]`

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

async function shell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id, { timeout: 20_000 })
  await page.evaluate(id => window.__tether.openSlot(id), id)
  await page.waitForFunction(id => window.__tether.focusablePanel() === id, id)
  return id
}

/** Closes a pane through its tab's close button, keeping its process ("detach"). */
async function closePane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`#dock .tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

const manager = async (page: Page): Promise<Manager | undefined> => (await page.evaluate(() => window.__tether.panelPadManager()))[0]
const managerOn = async (page: Page): Promise<boolean> => page.evaluate(() => window.__tether.panelPadManagerOn())
/** The pad to the manager (on Todos) unless it is there already. */
async function ensureManager(page: Page): Promise<void> {
  if (!(await managerOn(page))) await page.evaluate(() => window.__tether.openPanelPadManager('all'))
  await page.waitForSelector(inPad)
}
/** The panes saved in a panel's pad (layout.json's state of `frame-pads.panel@<panel>`). */
const padHas = async (page: Page, panelId: string, paneId: string): Promise<boolean> =>
  page.evaluate(([k, id]) => JSON.stringify(window.__tether.layout().sidebars?.pads[k!] ?? null).includes(`"${id}"`), [key(panelId), paneId])
/** How many groups the desk's frame has. */
const groups = async (page: Page): Promise<number> => page.evaluate(() => window.__tether.frameIds().reduce((n, id) => n + (JSON.stringify(window.__tether.frameLayout(id)).match(/"type":"leaf"/g) ?? []).length, 0))

/** The card's foot bar, exactly: [Focar guia] [Fechar guia] as primaries, then 🔗 ↗ as icons, the ⋯ last. */
async function barShape(page: Page, paneId: string): Promise<void> {
  const acts = await page.locator(`${card(paneId)} .pf-r-bar > button`).evaluateAll(bs => bs.map(b => ({ pin: (b as HTMLElement).dataset.pin ?? (b.classList.contains('more') ? 'more' : ''), label: (b as HTMLElement).dataset.label ?? '' })))
  assert.deepEqual(acts, [
    { pin: 'primary', label: 'Focar guia' },
    { pin: 'primary', label: 'Fechar guia' },
    { pin: 'icon', label: 'Copiar link do painel' },
    { pin: 'icon', label: 'Mover…' },
    { pin: 'more', label: '' },
  ], `the bar's shape: ${JSON.stringify(acts)}`)
  assert.deepEqual(await page.locator(`${card(paneId)} .pf-act.pin-primary span`).allInnerTexts(), ['Focar guia', 'Fechar guia'])
  const bg = await page.locator(`${card(paneId)} .pf-act.pin-primary`).evaluateAll(bs => bs.map(b => getComputedStyle(b).backgroundColor))
  const iconBg = await page.locator(`${card(paneId)} .pf-act.pin-icon`).first().evaluate(b => getComputedStyle(b).backgroundColor)
  assert.ok(bg.every(c => c === iconBg), `primaries drawn like the other buttons: ${JSON.stringify(bg)} vs ${iconBg}`)
  const bar = (await page.locator(`${card(paneId)} .pf-r-bar`).boundingBox())!, head = (await page.locator(`${card(paneId)} .pf-r-head`).boundingBox())!
  assert.ok(bar.y > head.y, "the bar is at the card's foot")
  assert.equal(await page.locator(`${inPad} .pf-owner .pf-act`).count(), 0, 'a group header has no actions')
}

/** The ⋯ opens the guide's menu by the button (not at the window's corner); returns its items. */
async function menuNearButton(page: Page, paneId: string, shot: string): Promise<string[]> {
  await ensureManager(page)
  const more = page.locator(`${card(paneId)} .pf-act.more`)
  const b = (await more.boundingBox())!
  await more.click()
  await page.waitForSelector('#ctx-menu')
  const mb = (await page.locator('#ctx-menu').boundingBox())!
  const its = await page.locator('#ctx-menu li[role="menuitem"]').allInnerTexts()
  await page.screenshot({ path: join(shots, shot) })
  const dx = Math.max(0, mb.x - (b.x + b.width), b.x - (mb.x + mb.width)), dy = Math.max(0, mb.y - (b.y + b.height), b.y - (mb.y + mb.height))
  assert.ok(dx < 40 && dy < 40, `menu by the ⋯: button ${JSON.stringify(b)} menu ${JSON.stringify(mb)}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('#ctx-menu', { state: 'detached', timeout: 2_000 })
  return its
}

/** A note opened into the panel pad on screen (its frame clicked first); returns its pane id. */
async function noteInPad(page: Page, path: string): Promise<string> {
  const before = (await page.evaluate(() => window.__tether.padFrames())).flatMap(f => f.panes)
  await page.click(`${shown} .frame-dock`)
  await page.evaluate(p => window.__tether.openNote(p), path)
  await page.waitForFunction(b => window.__tether.padFrames().some(f => f.pad === 'frame-pads.panel' && f.shown && f.panes.some(p => p.startsWith('note:') && !b.includes(p))), before)
  return (await page.evaluate(() => window.__tether.padFrames())).filter(f => f.pad === 'frame-pads.panel' && f.shown).flatMap(f => f.panes).find(p => p.startsWith('note:') && !before.includes(p))!
}

test("panel pad manager: the pad's guides grouped by owner; focus, close, move by drag, closed owners", { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(tmpBase, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer'] } }))
  const note1 = join(home, 'lembrete.md'), note2 = join(home, 'outra.md'), note3 = join(home, 'de-b.md')
  writeFileSync(note1, 'lembrar do bug do cwd\n')
  writeFileSync(note2, 'segunda nota\n')
  writeFileSync(note3, 'nota de B\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. two notes in A's frame; B's frame empty ----
    const a = await shell(page)
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForSelector(`${shown}[data-panel="${a}"] .empty-panel`)
    const n1 = await noteInPad(page, note1)
    const n2 = await noteInPad(page, note2)
    assert.ok(await padHas(page, a, n1) && await padHas(page, a, n2), "both notes are in A's frame")
    const b = await shell(page)
    await page.waitForSelector(`${shown}[data-panel="${b}"] .empty-panel`)
    await ensureManager(page)
    await page.waitForSelector(card(n2))
    let m = (await manager(page))!
    assert.deepEqual(m.groups.map(g => [g.key, g.guides.map(x => x.id)]), [[key(a), [n1, n2]]], `one group (A) with two cards; B's empty frame is not listed: ${JSON.stringify(m.groups)}`)
    assert.ok(m.groups[0]!.state.startsWith('terminal') && !m.groups[0]!.loose, m.groups[0]!.state)
    assert.ok(m.groups[0]!.guides[0]!.detail.endsWith('lembrete.md'), `the card's detail is the file: ${m.groups[0]!.guides[0]!.detail}`)
    assert.equal(await page.locator(`${inPad} .pf-owner[role="option"]`).count(), 0, 'a group header is not selectable')
    await page.screenshot({ path: join(shots, '1-gestor-por-guia.png') })

    // ---- 2. the guide's bar and menu; a click only selects ----
    await barShape(page, n1)
    await page.screenshot({ path: join(shots, '2a-barra-guia.png'), clip: (await page.locator(`${card(n1)} .pf-r-bar`).boundingBox())! })
    const its = await menuNearButton(page, n1, '2b-menu-guia.png')
    assert.ok(its[0]?.includes('Focar guia') && its[1]?.includes('Fechar guia'), `the guide's menu, Focar/Fechar guia first: ${JSON.stringify(its)}`)
    for (const t of ['Mover', 'Copiar link do painel']) assert.ok(its.some(i => i.includes(t)), `the note's menu has "${t}": ${JSON.stringify(its)}`)
    assert.ok(!its.some(i => i.includes('Trazer de volta')), "nothing of the owner's menu")
    await page.locator(card(n1)).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    assert.ok((await page.locator('#ctx-menu li[role="menuitem"]').allInnerTexts())[0]?.includes('Focar guia'), 'right-click: the same menu')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached', timeout: 2_000 })
    await page.click(`${card(n2)} .pf-r-head`)
    await sleep(300)
    assert.equal(await page.evaluate(() => window.__tether.focusablePanel()), b, 'a click does not change the focused panel')
    assert.equal((await manager(page))!.selected, n2, 'a click selects the card')
    await page.keyboard.press('ArrowUp')
    await page.waitForFunction(id => window.__tether.panelPadManager()[0]?.selected === id, n1)

    // ---- 3. Focar guia brings A with the note; Fechar guia closes the pane ----
    await page.dblclick(`${card(n1)} .pf-r-head`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, a, { timeout: 5_000 })
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })
    await page.waitForFunction(() => !!document.querySelector('#pads .pad.shown .dv-tab.dv-active-tab')?.textContent?.includes('lembrete'), undefined, { timeout: 5_000 })
    await page.screenshot({ path: join(shots, '3a-focar-guia.png') })
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await ensureManager(page)
    await page.click(`${card(n2)} .pf-act.pin-primary[data-label="Fechar guia"]`)
    await page.waitForSelector(card(n2), { state: 'detached', timeout: 5_000 })
    for (let i = 0; i < 30 && await padHas(page, a, n2); i++) await sleep(100)
    assert.ok(!(await padHas(page, a, n2)), 'the closed guide left the pad')
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(n2), 'and is nowhere')
    await page.screenshot({ path: join(shots, '3b-fechar-guia.png') })

    // ---- 4. dragging the card to the desk's right edge MOVES the guide ----
    await ensureManager(page)
    const before = await groups(page)
    const target = page.locator('#dock .dv-dockview').first()
    const box = (await target.boundingBox())!
    await page.locator(card(n1)).dragTo(target, { targetPosition: { x: box.width - 12, y: box.height / 2 } })
    for (let i = 0; i < 50 && (await groups(page)) <= before; i++) await sleep(100)
    await page.screenshot({ path: join(shots, '4-arrastado.png') })
    assert.ok((await groups(page)) > before, `the desk got a new group from the card (${before} → ${await groups(page)})`)
    assert.ok((await page.evaluate(() => window.__tether.panelIds())).includes(n1), 'the note is on the desk')
    assert.ok(!(await page.evaluate(() => window.__tether.padFrames())).some(f => f.panes.includes(n1)), 'the note is in no pad')
    for (let i = 0; i < 30 && await padHas(page, a, n1); i++) await sleep(100)
    assert.ok(!(await padHas(page, a, n1)), "the note left A's saved frame")
    await ensureManager(page)
    await page.waitForFunction(() => (window.__tether.panelPadManager()[0]?.groups.length ?? -1) === 0, undefined, { timeout: 5_000 })
    await page.screenshot({ path: join(shots, '4b-gestor-vazio.png') })

    // ---- 5. another desk lists nothing of this one ----
    const d1 = await page.evaluate(() => window.__tether.activeDesk())
    const d2 = await page.evaluate(d => window.__tether.createDesk('after', d), d1)
    await page.evaluate(d => window.__tether.switchDesk(d), d2)
    await page.evaluate(() => window.__tether.openPanelPadManager('all'))
    await page.waitForFunction(() => (window.__tether.panelPadManager()[0]?.groups.length ?? 0) === 0, undefined, { timeout: 5_000 })
    await page.evaluate(d => window.__tether.switchDesk(d), d1)

    // ---- 6. a closed owner: a "fechado" group with its guides ----
    await page.click(`#dock .tether-tab[data-slot="${b}"]`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, b)
    await page.waitForSelector(`${shown}[data-panel="${b}"]`)
    if (await managerOn(page)) await page.click(`${shown} .tab-act[data-action="frames-manager"]`)
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn())
    const n3 = await noteInPad(page, note3)
    // The person closes B by its ×: its frame goes along, with "Desfazer".
    await closePane(page, b)
    await page.waitForFunction(() => window.__tether.panelFramesToast()?.text === '1 guia da prancheta fechada', undefined, { timeout: 5_000 })
    assert.equal((await page.evaluate(() => window.__tether.panelFramesToast()))?.action, 'Desfazer')
    assert.equal((await page.evaluate(() => window.__tether.panelFramesTree())).loose.length, 0, "B's frame closed with it")
    assert.ok(!(await page.evaluate(k => k in (window.__tether.layout().sidebars?.pads ?? {}), key(b))), "B's frame left the layout")
    await page.screenshot({ path: join(shots, '6-guias-fechadas-toast.png') })
    // Desfazer: only the frame comes back, under the closed owner; B stays closed and nothing new is told.
    await page.click('.pf-toast .pf-toast-action')
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 1, undefined, { timeout: 5_000 })
    await sleep(400)
    assert.equal(await page.evaluate(() => window.__tether.panelFramesToast()), undefined, 'the undo tells nothing new')
    assert.equal((await page.evaluate(() => window.__tether.panelFramesTree())).loose.length, 1, 'the undo is not closed again')
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(b), 'B stays closed')
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await page.evaluate(() => window.__tether.openPanelPadManager('all'))
    await page.waitForSelector(card(n3))
    m = (await manager(page))!
    const gb = m.groups.find(g => g.key === key(b))!
    assert.ok(gb && gb.loose && gb.state === 'terminal · fechado', `B is a closed group: ${JSON.stringify(m.groups)}`)
    assert.deepEqual(gb.guides.map(x => x.id), [n3])
    assert.equal(m.looseGuides, 1, "the filter counts the closed owners' guides")
    assert.equal(await page.locator(`${inPad} .pf-chip[data-filter="loose"]`).innerText(), 'De painéis fechados (1)')
    assert.equal(await page.locator(`${inPad} .pf-chip[data-filter="all"]`).innerText(), 'Todas')
    await barShape(page, n3)
    // Same card, unselected, read as a closed owner's and as an open owner's: the backgrounds differ.
    const [closedBg, openBg, selectedBg] = await page.evaluate(sel => {
      const r = document.querySelector<HTMLElement>(sel)!, was = r.getAttribute('aria-selected')!
      r.setAttribute('aria-selected', 'false')
      const c = getComputedStyle(r).backgroundColor
      r.classList.remove('closed-owner'); const o = getComputedStyle(r).backgroundColor
      r.classList.add('closed-owner'); r.setAttribute('aria-selected', was)
      return [c, o, was === 'true' ? getComputedStyle(r).backgroundColor : c]
    }, card(n3))
    assert.notEqual(closedBg, openBg, `a closed owner's card has its own background: ${closedBg} vs ${openBg}`)
    assert.equal(selectedBg, closedBg, 'a selected closed-owner card keeps the beige background')
    await page.screenshot({ path: join(shots, '6a-dono-fechado.png') })
    await page.click(`${inPad} .pf-chip[data-filter="loose"]`)
    await page.waitForFunction(() => window.__tether.panelPadManager()[0]?.filter === 'loose')
    const its3 = await menuNearButton(page, n3, '6b-menu-guia-dono-fechado.png')
    assert.ok(its3[0]?.includes('Focar guia'), `a closed owner's guide has its own menu: ${JSON.stringify(its3)}`)
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).includes(b), 'the menu brings nothing back')
    // Focar guia: the owner comes back (only a live panel's frame can be shown) with the guide active.
    await page.click(`${card(n3)} .pf-act.pin-primary[data-label="Focar guia"]`)
    await page.waitForFunction(id => window.__tether.focusablePanel() === id, b, { timeout: 10_000 })
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 0)
    assert.ok(await padHas(page, b, n3), "the guide is in B's frame, B is back")
    await page.screenshot({ path: join(shots, '6c-focar-guia-dono-fechado.png') })
    // Fechar guia on the last guide of a closed owner: its frame goes. B goes by itself this time (the daemon drops
    // it, nobody closes it): its frame stays loose and the old toast is shown.
    await page.evaluate(id => window.tether.request({ t: 'forget', slotId: id }), b)
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), b)
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 1, undefined, { timeout: 5_000 })
    await page.waitForFunction(() => window.__tether.panelFramesToast()?.text === 'O quadro da prancheta ficou solto', undefined, { timeout: 5_000 })
    assert.equal((await page.evaluate(() => window.__tether.panelFramesToast()))?.action, 'Ver')
    await page.screenshot({ path: join(shots, '6-queda-sozinha-solto.png') })
    await page.evaluate(() => window.__tether.openPanelPadManager('loose'))
    await page.waitForSelector(card(n3))
    await page.click(`${card(n3)} .pf-act.pin-primary[data-label="Fechar guia"]`)
    await page.waitForSelector(owner(key(b)), { state: 'detached', timeout: 5_000 })
    await page.waitForFunction(() => window.__tether.panelFramesTree().loose.length === 0, undefined, { timeout: 5_000 })
    assert.ok(!(await page.evaluate(k => k in (window.__tether.layout().sidebars?.pads ?? {}), key(b))), "B's frame is gone")
    await page.screenshot({ path: join(shots, '6d-ultima-guia-fechada.png') })

    // B is closed: a new shell for the keyboard part.
    const c = await shell(page)
    // ---- 7. the keyboard and the switch ----
    await page.evaluate(id => window.__tether.activatePanel(id), c)
    if (await managerOn(page)) await page.click(`${shown} .tab-act[data-action="frames-manager"]`)
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn())
    await page.locator(`.panel[data-slot-id="${c}"] .xterm-screen`).click()
    await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
    await page.keyboard.press('Control+Shift+M')
    await page.waitForFunction(() => window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })
    await page.locator(`${inPad} .pf-list`).focus()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })
    await page.click(`${shown}[data-panel="${c}"] .tab-act[data-action="frames-manager"]`)
    await page.waitForSelector(`${shown}[data-panel="${c}"] .pad-manager.pf-pane:not([hidden])`, { state: 'visible' })
    const barBox = (await page.locator(`${shown}[data-panel="${c}"] .dv-tabs-and-actions-container:visible`).first().boundingBox())!
    const mgrBox = (await page.locator(inPad).boundingBox())!
    await page.screenshot({ path: join(shots, '8-botao-fixo.png') })
    assert.ok(await page.locator('.toolbar, #toolbar, #topbar, header').first().isVisible().catch(() => true), 'the top bar stays')
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.scrollTop > 0 && !e.closest('.pf-list, .xterm')).map(e => e.id || e.className).join(',')), '', 'nothing outside the list was scrolled')
    assert.ok(Math.abs(mgrBox.y - (barBox.y + barBox.height)) <= 1, `the manager starts where the tab bar ends (${mgrBox.y} vs ${barBox.y}+${barBox.height})`)
    await page.click(`${shown}[data-panel="${c}"] .tab-act[data-action="frames-manager"]`)
    await page.waitForFunction(() => !window.__tether.panelPadManagerOn(), undefined, { timeout: 5_000 })

    // ---- 8. affinity: the settings opened with the pad in focus land on the desk ----
    await page.click(`${shown}[data-panel="${c}"] .frame-dock`)
    await page.keyboard.press('Control+,')
    // The page opens in the peek card; its "Abrir nesta mesa" puts it in a tab, which is where the affinity counts.
    await page.waitForSelector('#peek .st-pane')
    await page.click('#peek .peek-open')
    await page.waitForFunction(() => window.__tether.panelIds().some(id => id.startsWith('settings:')), undefined, { timeout: 5_000 })
    assert.ok(!(await page.evaluate(() => window.__tether.padFrames())).some(f => f.panes.some(p => p.startsWith('settings:'))), 'the settings are not inside a pad')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
