// E2E of the ownership in "Painéis da mesa" (tether for agents, slice U4): the card of a guide shows what the tab shows (the
// emblems of the extension, the diamond of an attention that waits for the owner, the line "quem comanda · última ação"), its bar
// shows the pinned items of the tab's menu, and the three lines of the menus the app could not feed before: the guide that waits
// for its owner (5), the guide that asks for permission after its owner ended (6), and "Fechar as guias que <dono> abriu (N)…" on
// the pill of an owner that ended. A tetherd in this process on a private home and pipe with the real for-agents daemon side, the
// real app on the same pipe, hidden window. Fake agents in a .cjs that only stay alive: no LLM. The guides sit in the panel pad of
// the Atrium's own pane, where the manager lists them. Nothing here activates a pane or switches the visible desk.
// With TETHER_U4_PRINTS set to a folder, the manager (light and dark) and the menus of states 5 and 6 go there.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { agentHue } from '../../app/shared/agent-color.ts'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { wire } from '../../extensions/for-agents/daemon.ts'
import { EXT_ID, manifest } from '../../extensions/for-agents/manifest.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Card = {
  id: string; title: string; detail: string; line: string; routed: string | null; underline: string | null
  emblems: { cls: string; text: string; title: string }[]
  bar: { label: string; pin: string; hidden: boolean }[]
}
type Manager = { filter: string; groups: { key: string; name: string; guides: Card[] }[] }
type Hooks = {
  activeDesk(): string
  activeId(): string | undefined
  currentPane(): string | undefined
  switchDesk(id: string): void
  renameDesk(id: string, name: string): void
  openSlot(id: string): Promise<void>
  openSlotInPad(slotId: string, padId: string): void
  panelIds(): string[]
  forAgentsRun(id: string, arg?: unknown): Promise<string>
  slots(): { slotId: string }[]
  padFrames(): { pad: string; panes: string[] }[]
  disposeExtension(id: string): void
  openPanelPadManager(filter?: string, key?: string): void
  panelPadManager(): Manager[]
}
declare const window: { __tether: Hooks; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')
const PANEL = 'frame-pads.panel'

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

/** A menu's own rows as text: '—' a separator, '# …' a heading. */
const rowsOf = (page: Page): Promise<string[]> => page.locator('#ctx-menu > li').evaluateAll(lis => lis.map(li => {
  if (li.classList.contains('sep')) return '—'
  if (li.classList.contains('hd')) return `# ${li.textContent ?? ''}`
  return [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim()
}))

test('for-agents in "Painéis da mesa": the card shows the marks, the bar the pins; menus 5 and 6; close what the owner opened', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  writeFileSync(join(home, 'stay.cjs'), STAY)
  const fake: AgentAdapter = {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      return { command: process.execPath, args: [join(home, 'stay.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  }
  const door = new DoorHost({ log: m => logs.push(m) })
  const entry: ExtensionEntry<TetherDaemon> = { manifest, activate: api => wire(api).disposables }
  const host = new DaemonExtensionHost({ home, log: m => logs.push(m), door, extensions: [entry] })
  host.activate()
  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 500, minAgentAgeMs: 0, adapters: { soul: fake }, door,
    transformPlan: host.transformPlan, onSlot: host.emitSlot, log: m => logs.push(m),
  })
  await door.releaseInactive(host.activated)
  host.emitStarted()
  const api = door.apiFor(EXT_ID, new DisposableStore())
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    page.on('console', m => { if (m.type() === 'error') console.log(m.type(), m.text()) })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1600, 900) })
    await page.waitForFunction(() => window.innerWidth >= 1500)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    // Nobody is looking: no attention is seen while the panes open (the page says its window has no focus).
    await page.evaluate(() => { document.hasFocus = () => false })

    // ---- layout: desk 1 "kai-aware" (the Atrium's pane and the guides in its panel pad), desk 2 "bancada" (an owner that ended) ----
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const D1 = 'desk-1', D2 = 'desk-2'
    await page.evaluate(() => { window.__tether.renameDesk('desk-1', 'kai-aware'); window.__tether.renameDesk('desk-2', 'bancada') })
    const slot = async (name: string, onBehalfOf?: string): Promise<string> => (await api.slots.create({ kind: 'soul', cwd: home, name, ...(onBehalfOf ? { onBehalfOf } : {}) })).slotId
    const A = await slot('Atrium'), C1 = await slot('soul · testes'), G = await slot('codex · conferência'), K = await slot('Kai')
    const T1 = await slot('browser · admin'), P = await slot('soul · pausada'), X = await slot('codex · migração'), PLAIN = await slot('soul comum')
    for (const id of [A, C1, G, K, T1, P, X, PLAIN]) await waitUntil(() => api.slots.get(id)?.status === 'running', 30_000, `running ${id}`)
    const O1 = await slot('soul · aberta 1', A), O2 = await slot('soul · aberta 2', A)
    for (const id of [O1, O2]) await waitUntil(() => api.slots.get(id)?.status === 'running', 30_000, `running ${id}`)
    assert.deepEqual(api.slots.get(O1)?.createdBy, { ext: EXT_ID, slotId: A }, 'the daemon says who opened it')

    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    for (const id of [O1, O2]) { await page.evaluate(id => window.__tether.openSlot(id), id); await page.locator(`.tether-tab[data-slot="${id}"]`).waitFor() }
    await page.evaluate(id => window.__tether.switchDesk(id), D1)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    // Kai only needs a pane so the app knows its name (the letter of an owner is the initial of its tab's name).
    for (const id of [K, A]) { await page.evaluate(id => window.__tether.openSlot(id), id); await page.locator(`.tether-tab[data-slot="${id}"]`).waitFor() }
    await page.locator(`.tether-tab[data-slot="${A}"]`).click()
    await waitUntil(() => (api.desks.map()?.desks.length ?? 0) >= 2, 20_000, 'desk map')

    // The guides live in the panel pad of the Atrium's pane (the pad of the focused panel): that is what the manager lists.
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    const guides = [C1, G, T1, P, X, PLAIN]
    for (const id of guides) {
      await page.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id), id)
      await page.evaluate(([id, pad]) => window.__tether.openSlotInPad(id!, pad!), [id, PANEL])
      await page.waitForFunction(id => window.__tether.padFrames().some(f => f.pad === 'frame-pads.panel' && f.panes.includes(id!)), id)
    }
    const K_NAMES = { A: 'Atrium', K: 'Kai' }
    const T = new Date(2026, 10, 21, 14, 2).toISOString()
    const own = (owner: string, extra: Record<string, unknown> = {}) => ({ owner, since: T, givenBy: 'user', ...extra })
    // The desk is given to the Atrium: the guides of her panel pad inherit it (C1, T1, P, PLAIN); G was given to Kai; X's owner ended.
    await api.objects.set('desk', D1, 'owner', own(A))
    await api.objects.set('pane', C1, 'last', { by: A, verb: 'send', at: T })
    await api.objects.set('pane', G, 'owner', own(K))
    await api.objects.set('pane', T1, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: T })
    await api.objects.set('pane', P, 'hand', { with: 'user', why: 'paused', by: 'gesture', since: T })
    await api.objects.set('pane', X, 'owner', own(A, { ended: { at: T, name: K_NAMES.A } }))
    await api.objects.set('desk', D2, 'owner', own(A, { ended: { at: T, name: K_NAMES.A } }))
    // The Atrium waits on C1 (the daemon routes it to her through the desk), the person waits on X (its owner ended: nobody routes it).
    await waitUntil(() => api.attention.routeOf(C1) === A, 15_000, `the reconciler routed C1 to the Atrium by the desk (route ${api.attention.routeOf(C1)}, held ${JSON.stringify(api.slots.get(C1)?.held)})`)
    api.attention.signal(C1, 'waiting')
    api.attention.signal(X, 'waiting')
    await waitUntil(() => api.slots.get(C1)?.attentionFor?.slotId === A && api.slots.get(X)?.attention === 'waiting', 15_000, `attentions (${JSON.stringify([api.slots.get(C1)?.attentionFor, api.slots.get(X)?.attention])})`)

    const state = () => page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), current: window.__tether.currentPane() }))
    const before = await state()
    await page.evaluate(() => window.__tether.openPanelPadManager('all'))
    const inPad = `#pads .pad.shown[data-pad="${PANEL}"] .pad-manager.pf-pane:not([hidden])`
    const card = (id: string): string => `${inPad} .pf-row[data-pane="${id}"]`
    await page.waitForSelector(card(PLAIN))
    const cards = async (): Promise<Map<string, Card>> => new Map(((await page.evaluate(() => window.__tether.panelPadManager()))[0]?.groups ?? []).flatMap(g => g.guides).map(c => [c.id, c]))
    // The hue and the clock come from the app: wait for the first draw that has the diamond.
    await page.waitForSelector(`${card(C1)} .attn.routed`)
    const cs = await cards()

    // ---- 1. the card, with the desk ownership (the guides live in a panel pad): emblems, diamond, underline, line ----
    const c1 = cs.get(C1)!
    assert.deepEqual(c1.emblems, [], 'C1 inherits from the desk: no letter of its own, as on the tab')
    assert.equal(c1.underline, String(agentHue(A)), 'C1: the thin line in the owner hue, as under the tab')
    assert.equal(c1.routed, String(agentHue(A)), 'C1: the diamond in the owner hue')
    assert.match(c1.detail, /^espera a Atrium · permissão \d\d:\d\d$/, 'C1: what it waits for, and since when')
    assert.match(c1.line, /^.+ · Atrium pela mesa · enviou pedido \d\d:\d\d$/, `C1: the folder, then "quem comanda · última ação": ${c1.line}`)
    assert.equal(await page.locator(`${card(C1)} .pf-r-head .attn.routed`).evaluate(el => getComputedStyle(el).transform !== 'none'), true, 'the mark is a diamond')
    const g = cs.get(G)!
    assert.deepEqual(g.emblems.map(e => [e.text, e.title]), [['K', 'Dono: Kai'], ['', 'Atrium vê']], 'G: given to Kai; the desk owner only sees (the eye)')
    assert.deepEqual([g.routed, g.underline, g.line], [null, null, 'Kai'], 'G: no diamond, no underline (Kai commands it), who commands')
    const t1 = cs.get(T1)!
    assert.deepEqual(t1.emblems.map(e => e.title), ['Com você: Atrium só volta a comandar quando você devolver'], 'T1: the hand')
    assert.equal(t1.line, 'com você')
    assert.equal(t1.underline, null, 'the underline goes while the hand is with the person')
    const p = cs.get(P)!
    assert.deepEqual(p.emblems.map(e => e.title), ['Pausada: Atrium não age aqui até você retomar'], 'P: paused')
    const x = cs.get(X)!
    assert.deepEqual(x.emblems.map(e => [e.cls, e.text]), [['hued letter struck', 'A']], 'X: the struck letter of the owner that ended')
    assert.equal(x.routed, null, 'X waits for the person, not for an owner: no diamond')
    assert.equal(await page.locator(`${inPad} .pf-owner .ext-emblem, ${inPad} .pf-owner .attn.routed`).count(), 0, 'the owner header has none of it')

    // ---- 2. the bar: the pins of the menu, per state ----
    const pinned = (c: Card): string[] => c.bar.filter(b => !b.hidden).map(b => `${b.pin}:${b.label}`)
    assert.deepEqual(pinned(c1).filter(l => l.startsWith('icon:')).slice(0, 3), ['icon:Ir para Atrium', 'icon:Tomar e responder eu', 'icon:Pausar Atrium nesta guia'], 'C1: "Ir para", Tomar and Pausar as icons')
    assert.deepEqual(pinned(c1).filter(l => !l.startsWith('icon:')), ['primary:Focar guia', 'primary:Fechar guia'], 'C1: with no highlight the bar keeps its two primaries, as today')
    assert.deepEqual(pinned(g).filter(l => l.startsWith('icon:')).slice(0, 3), ['icon:Tomar', 'icon:Pausar Kai nesta guia', 'icon:Ir para Kai'], 'G: the same, in their quiet words')
    assert.deepEqual(pinned(t1).filter(l => !l.startsWith('icon:')), ['highlight:Devolver a Atrium', 'primary:Focar guia'], 'T1: "Devolver a Atrium" is the one with text and accent, and takes the place of "Fechar guia"')
    const hl = page.locator(`${card(T1)} .pf-act.pin-highlight`), ic = page.locator(`${card(T1)} .pf-act.pin-icon`).first()
    assert.notEqual(await hl.evaluate(b => getComputedStyle(b).color), await ic.evaluate(b => getComputedStyle(b).color), 'the highlight has the accent colour')
    assert.equal(await page.locator(`${inPad} .pf-act.pin-highlight`).count(), 1, 'it is the only one with accent')
    assert.deepEqual(pinned(p).filter(l => !l.startsWith('icon:') && !l.startsWith('more')), ['primary:Focar guia', 'primary:Fechar guia'])
    assert.ok(pinned(p).includes('icon:Retomar Atrium nesta guia'), `P: "Retomar" (a primary of the extension) reaches the bar as an icon: ${JSON.stringify(pinned(p))}`)
    assert.equal(await page.locator(`${inPad} .pf-r-bar`).count(), 6, 'one bar per card, no other bar')
    assert.equal(await page.locator(`${inPad} .pf-chip`).count(), 2, 'the filter chips are the two it had: no chip of ownership')
    assert.deepEqual(await state(), before, 'drawing the manager activated nothing and kept the desk')

    // ---- prints: the manager, light and dark ----
    const dir = process.env.TETHER_U4_PRINTS
    if (dir) mkdirSync(dir, { recursive: true })
    const shotManager = async (scheme: 'light' | 'dark'): Promise<void> => {
      if (!dir) return
      await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme)
      await page.waitForTimeout(400)
      await page.locator(inPad).screenshot({ path: join(dir, `u4-gestor-${scheme}.png`) })
    }
    await shotManager('light'); await shotManager('dark')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })

    // ---- 3. menu (5): the guide that waits for its owner, opened from the card's ⋯ (the same menu as the tab's) ----
    const openFromCard = async (id: string): Promise<string[]> => {
      await page.locator(`${card(id)} .pf-act.more`).click()
      await page.waitForSelector('#ctx-menu li')
      return rowsOf(page)
    }
    const closeMenu = async (): Promise<void> => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('ctx-menu')) }
    const shotMenu = async (name: string): Promise<void> => {
      if (!dir) return
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme)
        await page.waitForTimeout(250)
        const m = (await page.locator('#ctx-menu').boundingBox())!, c = (await page.locator(inPad).boundingBox())!
        const x0 = Math.max(0, Math.min(m.x, c.x) - 10), y0 = Math.max(0, Math.min(m.y, c.y) - 10)
        await page.screenshot({ path: join(dir, `u4-${name}-${scheme}.png`), clip: { x: x0, y: y0, width: Math.max(m.x + m.width, c.x + c.width) + 10 - x0, height: Math.min(900 - y0, Math.max(m.y + m.height, c.y + c.height) + 10 - y0) } })
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    }
    const m5 = await openFromCard(C1)
    const at = m5.findIndex(r => r.startsWith('# Espera Atrium: pediu permissão às '))
    assert.ok(at >= 0, `(5) the line that says what it waits for: ${JSON.stringify(m5)}`)
    assert.match(m5[at]!, /^# Espera Atrium: pediu permissão às \d\d:\d\d$/)
    assert.deepEqual(m5.slice(at + 1, at + 3), ['Ir para Atrium', 'Tomar e responder eu'], '(5) "Ir para" and "Tomar e responder eu" first')
    await shotMenu('menu-estado-5')
    await closeMenu()

    // ---- 4. menu (6): the guide that asks for permission after its owner ended ----
    const m6 = await openFromCard(X)
    const at6 = m6.indexOf('# Atrium encerrou · voltou para você · pede permissão')
    assert.ok(at6 >= 0, `(6) the owner ended and it asks: ${JSON.stringify(m6)}`)
    assert.deepEqual(m6.slice(at6, at6 + 3), ['# Atrium encerrou · voltou para você · pede permissão', '# (responde-se na própria guia, como hoje)', 'Dar esta guia a um agente…'])
    await shotMenu('menu-estado-6')
    await closeMenu()
    const m6b = await openFromCard(T1)
    assert.ok(m6b.some(r => r === 'Devolver a Atrium'), `the taken guide offers "Devolver a Atrium" in its menu: ${JSON.stringify(m6b)}`)
    await closeMenu()

    // ---- 5. the picker of "dar a um agente": the row's letter, the initial of the name, in the agent's hue ----
    void page.evaluate(id => window.__tether.forAgentsRun('for-agents.give', { kind: 'pane', id }), PLAIN)
    const picker = page.locator('dialog.picker')
    await picker.locator('li.pk-item').first().waitFor()
    const letters = await picker.locator('li.pk-item').evaluateAll(lis => lis.map(li => ({ name: li.querySelector('.pk-label')?.textContent ?? '', letter: li.querySelector('.pk-icon.letter')?.textContent ?? '', hue: (li as HTMLElement).style.getPropertyValue('--pk-hue') })))
    assert.ok(letters.length >= 2 && letters.every(l => l.letter === l.name[0]!.toUpperCase() && l.hue !== ''), `every row has its letter and its hue: ${JSON.stringify(letters)}`)
    assert.equal(await picker.locator('li.pk-item .pk-icon svg').count(), 0, 'the letter takes the place of the glyph')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.picker[open]'))
    assert.deepEqual(await state(), before, 'the menus and the picker activated nothing')

    // ---- 6. the pill of the owner that ended: "Fechar as guias que Atrium abriu (N)…" ----
    const pill2 = page.locator(`#desk-switch .seg[data-desk="${D2}"]`)
    await pill2.locator('.desk-seal.struck').waitFor()
    const openPill = async (): Promise<string[]> => { await pill2.click({ button: 'right' }); await page.waitForSelector('#ctx-menu li'); return rowsOf(page) }
    const pillRows = await openPill()
    const endedRows = ['# Atrium encerrou às 14:02 · as guias voltaram para você', 'Fechar as guias que Atrium abriu (2)…', 'Dar a mesa a um agente…', 'Ficar com a mesa (tira o selo)']
    assert.deepEqual(pillRows.slice(pillRows.indexOf(endedRows[0]!), pillRows.indexOf(endedRows[0]!) + 4), endedRows, 'the third row of the preview, with the count')
    await closeMenu()
    const ask = (choice: string) => page.locator(`dialog.ask[data-dialog="for-agents.close-opened"] button.choice[data-choice="${choice}"]`)
    const choose = async (label: string): Promise<void> => {
      await pill2.click({ button: 'right' })
      await page.locator('#ctx-menu > li', { hasText: label }).click()
      await page.locator('dialog.ask[data-dialog="for-agents.close-opened"]').waitFor()
    }
    await choose('Fechar as guias que Atrium abriu')
    assert.match(await page.locator('dialog.ask[data-dialog="for-agents.close-opened"]').innerText(), /Fechar as 2 guias que Atrium abriu/)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.ask[open]'))
    assert.deepEqual([O1, O2].map(id => api.slots.get(id)?.status), ['running', 'running'], 'cancel closes nothing')
    await choose('Fechar as guias que Atrium abriu')
    await ask('close').click()
    await page.waitForFunction(ids => ids.every(id => !window.__tether.panelIds().includes(id)), [O1, O2])
    assert.deepEqual([O1, O2].map(id => api.slots.get(id)?.status), ['running', 'running'], '"Fechar as guias": the panes go, the agents keep running without a pane')
    assert.equal(api.slots.get(PLAIN)?.status, 'running', 'what nobody opened is untouched')
    const left = await openPill()
    assert.ok(!left.some(r => r.startsWith('Fechar as guias que')), `with none left the row is gone: ${JSON.stringify(left)}`)
    await closeMenu()
    // Stop and close: a guide the Atrium opens now.
    const O3 = await slot('soul · aberta 3', A)
    await waitUntil(() => api.slots.get(O3)?.status === 'running', 30_000, 'O3 running')
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.evaluate(id => window.__tether.openSlot(id), O3)
    await page.locator(`.tether-tab[data-slot="${O3}"]`).waitFor()
    await page.evaluate(id => window.__tether.switchDesk(id), D1)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    await choose('Fechar as guias que Atrium abriu')
    await ask('stop').click()
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), O3)
    await waitUntil(() => api.slots.get(O3)?.status !== 'running', 15_000, 'O3 stopped')
    assert.equal(api.slots.get(O3)?.status !== 'running', true, '"Parar e fechar": the agent is stopped too')

    // ---- 7. without the extension the card is what it always was ----
    // (The diamond is the core's: it follows `attentionFor`, which tetherd keeps while its own side of the extension routes; this
    // test turns off the app's side only, so the diamond and what it says stay, and everything the extension drew goes.)
    await page.evaluate(() => window.__tether.disposeExtension('for-agents'))
    await page.waitForFunction(() => document.querySelectorAll('.pf-row .ext-emblem').length === 0)
    const bare = await cards()
    for (const id of guides) assert.equal(bare.get(id)!.emblems.length, 0, `${id}: no emblem without the extension`)
    for (const id of guides.filter(id => id !== C1)) assert.equal(bare.get(id)!.line, '', `${id}: no line of the status bar without the extension`)
    assert.ok(!/ · Atrium · /.test(bare.get(C1)!.line) && !bare.get(C1)!.line.includes('enviou pedido'), `C1: the line keeps only the folder (the diamond's own, kept while tetherd routes): ${bare.get(C1)!.line}`)
    assert.equal(bare.get(C1)!.bar.some(b => /Tomar|Pausar|Devolver/.test(b.label)), false, 'back to the pane own bar')
    for (const id of guides) assert.deepEqual(bare.get(id)!.bar.filter(b => b.pin !== 'icon').map(b => [b.pin, b.label]), [['primary', 'Focar guia'], ['primary', 'Fechar guia']], `${id}: with no extension that pins a highlight the bar is today's`)
    for (const id of guides) assert.equal(bare.get(id)!.underline, null, `${id}: no underline without the extension`)
    assert.deepEqual(bare.get(PLAIN)!.bar.map(b => [b.pin, b.label]), (await cards()).get(PLAIN)!.bar.map(b => [b.pin, b.label]))
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-25).join('\n')}`)
    throw e
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
