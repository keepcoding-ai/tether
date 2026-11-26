// E2E of the gestures of ownership (tether for agents, slice U2): the menus of the pill and of the tab, the picker and the dialogs
// of giving ("Voltar" included), revoking, taking and giving back, pausing and resuming in the three scopes, "Ir para", and the
// commands with an argument. A tetherd in this process on a private home and pipe, with the real for-agents daemon side (the
// reconciler) activated by the daemon's extension host; the real app on the same pipe, hidden window. Fake agents in a .cjs
// that only stay alive: no LLM. Each gesture is read twice: the write in `objects` and, through the daemon, the `held` of the
// pane in the state of the slot. No gesture activates a pane or changes the visible desk (but "Ir para", which is a request to go).
// With TETHER_U2_PRINTS set to a folder, the menus (each state), the picker and the dialogs go there in the light theme.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
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

type Hooks = {
  activeDesk(): string
  activeId(): string | undefined
  currentPane(): string | undefined
  switchDesk(id: string): void
  renameDesk(id: string, name: string): void
  openSlot(id: string): Promise<void>
  openNote(path: string): Promise<void>
  forAgentsRun(id: string, arg?: unknown): Promise<string>
  ext: Record<string, Record<string, unknown>>
}
declare const window: { __tether: Hooks; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')

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

/** A menu's own rows as text: '—' a separator, '# …' a heading, a pin shows nothing (the pins are read apart). */
const rowsOf = (page: Page): Promise<string[]> => page.locator('#ctx-menu > li').evaluateAll(lis => lis.map(li => {
  if (li.classList.contains('sep')) return '—'
  if (li.classList.contains('hd')) return `# ${li.textContent ?? ''}`
  return [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim()
}))
const sliceAt = (rows: string[], expected: string[]): string[] => { const at = rows.indexOf(expected[0]!); return at < 0 ? rows : rows.slice(at, at + expected.length) }

test('for-agents gestures: menus by state, giving with the picker and the dialog, taking, pausing, revoking, "Ir para", commands', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
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

    // ---- layout: kai-aware (the desk that will be given) and geral ----
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const D1 = 'desk-1', D2 = 'desk-2'
    await page.evaluate(() => { window.__tether.renameDesk('desk-1', 'kai-aware'); window.__tether.renameDesk('desk-2', 'geral') })
    const slot = async (name: string): Promise<string> => (await api.slots.create({ kind: 'soul', cwd: home, name })).slotId
    const A = await slot('Atrium'), C1 = await slot('soul · bancada'), C2 = await slot('soul · outra'), G = await slot('codex · conferência')
    const K = await slot('Kai'), PLAIN = await slot('soul comum')
    const notePath = join(home, 'notas.md')
    writeFileSync(notePath, '# notas\n')
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.evaluate(id => window.__tether.openSlot(id), PLAIN)
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.evaluate(id => window.__tether.switchDesk(id), D1)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    for (const id of [A, C1, C2, G, K]) { await page.evaluate(id => window.__tether.openSlot(id), id); await page.locator(`.tether-tab[data-slot="${id}"]`).waitFor() }
    await page.locator(`.tether-tab[data-slot="${A}"]`).click()
    // The daemon has the desk map from the app: the desks are there for the reconciler.
    await waitUntil(() => (api.desks.map()?.desks.length ?? 0) >= 2, 20_000, 'desk map')

    const tab = (id: string) => page.locator(`.tether-tab[data-slot="${id}"]`)
    const pill = (d: string) => page.locator(`#desk-switch .seg[data-desk="${d}"]`)
    const state = () => page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), current: window.__tether.currentPane() }))
    const closeMenu = async (): Promise<void> => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('ctx-menu')) }
    const dir = process.env.TETHER_U2_PRINTS
    if (dir) mkdirSync(dir, { recursive: true })
    const shot = async (name: string, selector: string, also?: string): Promise<void> => {
      if (!dir) return
      await page.waitForTimeout(250)
      const boxes = [await page.locator(selector).first().boundingBox(), ...(also ? [await page.locator(also).first().boundingBox()] : [])].filter((b): b is NonNullable<typeof b> => b !== null)
      const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - 10), y = Math.max(0, Math.min(...boxes.map(b => b.y)) - 10)
      await page.screenshot({ path: join(dir, `u2-${name}-light.png`), clip: { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) + 10 - x, height: Math.max(...boxes.map(b => b.y + b.height)) + 10 - y } })
    }
    const openPill = async (d: string): Promise<string[]> => { await pill(d).click({ button: 'right' }); await page.waitForSelector('#ctx-menu li'); return rowsOf(page) }
    const openTab = async (id: string): Promise<string[]> => { await tab(id).click({ button: 'right' }); await page.waitForSelector('#ctx-menu li'); return rowsOf(page) }
    /** Clicks a row of the open menu by its exact text. The gesture must change neither the active pane nor the visible desk. */
    const choose = async (label: string, keepsView = true): Promise<void> => {
      const before = await state()
      await page.locator('#ctx-menu > li', { hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).click()
      if (keepsView) { await page.waitForTimeout(150); assert.deepEqual(await state(), before, `"${label}" did not activate a pane nor change the desk`) }
    }
    const pillStrip = '#desk-switch'

    const obj = <T>(kind: 'desk' | 'pane', id: string, key: string): T | undefined => api.objects.get<T>(kind, id, key)
    const heldBy = (id: string): string | undefined => { const h = api.slots.get(id)?.held; return h ? `${h.ext}:${h.by}` : undefined }
    const routeOf = (id: string): string | undefined => api.attention.routeOf(id)
    const until = (fn: () => boolean, what: string): Promise<void> => waitUntil(fn, 15_000, what)
    const byA = `${EXT_ID}:${A}`, byK = `${EXT_ID}:${K}`
    const picker = page.locator('dialog.picker')
    const pickerRows = (): Promise<string[]> => picker.locator('li.pk-item .pk-label').allInnerTexts()
    const pickRow = (name: string) => picker.locator('li.pk-item').filter({ has: page.locator('.pk-label', { hasText: new RegExp(`^${name}$`) }) })
    const askDialog = (situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"]`)
    const answer = async (situation: string, choice: string): Promise<void> => { await page.locator(`dialog.ask[data-dialog="${situation}"] button.choice[data-choice="${choice}"]`).click() }

    // ---- 1. give the desk by the pill: picker, dialog, "Voltar", picker again, dialog, "Dar a mesa" ----
    const common = await openPill(D1)
    assert.ok(common.includes('Dar a mesa a um agente…'), `the common desk offers giving (${common.join(' | ')})`)
    assert.ok(!common.some(l => /Pausar|Assumir o comando|Tirar a mesa|Revogar/.test(l)), 'and nothing else of ownership')
    await shot('pilula-mesa-comum', '#ctx-menu', pillStrip)
    const noView = await state()
    await choose('Dar a mesa a um agente…')
    await picker.locator('input').waitFor({ state: 'visible' })
    assert.equal(await picker.locator('.pk-title').innerText(), 'Dar a mesa kai-aware a…')
    assert.deepEqual((await pickerRows()).sort(), ['Atrium', 'Kai', 'codex · conferência', 'soul · bancada', 'soul · outra', 'soul comum'].sort(), 'every live agent, and only the agents (no note)')
    assert.deepEqual(await picker.locator('li.pk-group').allTextContents(), ['Nesta mesa', 'Outras mesas'])
    await shot('seletor', 'dialog.picker')
    await pickRow('Atrium').click()
    await askDialog('for-agents.give-desk').waitFor()
    assert.equal(await askDialog('for-agents.give-desk').locator('h2, .ask-title').first().innerText(), 'Dar a mesa kai-aware a Atrium')
    const text = await askDialog('for-agents.give-desk').innerText()
    assert.match(text, /Atrium passa a comandar as 4 guias desta mesa como você comanda\./)
    assert.match(text, /Atrium mora em outra mesa|Tudo começa ligado/)
    await shot('dialogo-dar-a-mesa', 'dialog.ask[open]')
    await answer('for-agents.give-desk', 'back')
    await picker.locator('input').waitFor({ state: 'visible' })
    assert.equal(await picker.locator('.pk-title').innerText(), 'Dar a mesa kai-aware a…', '"Voltar" reopens the picker')
    assert.equal(obj('desk', D1, 'owner'), undefined, 'nothing was written by going back')
    await pickRow('Atrium').click()
    await askDialog('for-agents.give-desk').waitFor()
    await answer('for-agents.give-desk', 'give')
    await until(() => obj('desk', D1, 'owner') !== undefined, 'the desk owner written')
    const given = obj<{ owner: string; givenBy: string; since: string }>('desk', D1, 'owner')!
    assert.deepEqual([given.owner, given.givenBy, typeof given.since], [A, 'user', 'string'], 'desk.<id>.owner = { owner, since, givenBy: user }')
    await until(() => [C1, C2, G, K].every(id => heldBy(id) === byA), 'the four panes held by Atrium')
    // ownPanePort: a live owner's own pane with no commander is held by itself, with no route (it is never commanded).
    assert.equal(heldBy(A), byA, 'the owner\'s own pane is held by its owner')
    assert.equal(routeOf(A), undefined, 'the owner\'s own pane has no route')
    assert.deepEqual(await state(), noView, 'giving the desk activated nothing')

    // ---- 2. the pill menu, state by state, and the gestures of the desk ----
    const active = await openPill(D1)
    const activeRows = ['# Dono: Atrium · comanda 4 guias', 'Ir para Atrium', 'Pausar Atrium nesta mesa', 'Assumir o comando da mesa', 'O que Atrium pode aqui…', 'Dar a mesa a outro agente…', 'Tirar a mesa de Atrium…']
    assert.deepEqual(sliceAt(active, activeRows), activeRows)
    assert.ok(active.indexOf('Tirar a mesa de Atrium…') < Math.max(active.indexOf('Hibernar mesa'), 0) || !active.includes('Hibernar mesa'), 'the group comes before "Hibernar mesa"')
    await shot('pilula-ativa', '#ctx-menu', pillStrip)
    await choose('Pausar Atrium nesta mesa')
    await until(() => obj<{ why: string; by: string }>('desk', D1, 'hand')?.why === 'paused', 'desk paused')
    assert.equal(obj<{ by: string }>('desk', D1, 'hand')!.by, 'gesture')
    await until(() => [C1, C2, G, K].every(id => heldBy(id) === undefined && !routeOf(id)), 'paused: nothing held, nothing routed (a pause does not interrupt the turn: that is a gesture apart)')
    const paused = await openPill(D1)
    const pausedRows = ['# Dono: Atrium · pausada nesta mesa desde', 'Retomar Atrium nesta mesa', 'Ir para Atrium', 'Assumir o comando da mesa', 'O que Atrium pode aqui…', 'Dar a mesa a outro agente…', 'Tirar a mesa de Atrium…']
    assert.match(paused.find(l => l.startsWith('# Dono'))!, /^# Dono: Atrium · pausada nesta mesa desde \d\d:\d\d$/)
    assert.deepEqual(sliceAt(paused, pausedRows.map(l => (l.startsWith('# Dono') ? paused.find(p => p.startsWith('# Dono'))! : l))).slice(1), pausedRows.slice(1))
    await shot('pilula-pausada', '#ctx-menu', pillStrip)
    await choose('Retomar Atrium nesta mesa')
    await until(() => obj('desk', D1, 'hand') === undefined && [C1, C2, G, K].every(id => heldBy(id) === byA), 'resumed: held again')
    await openPill(D1)
    await choose('Assumir o comando da mesa')
    await until(() => obj<{ why: string }>('desk', D1, 'hand')?.why === 'taken' && [C1, C2, G, K].every(id => heldBy(id) === undefined), 'desk taken')
    const taken = await openPill(D1)
    const takenRows = ['# Dono: Atrium · a mesa está com você', 'Devolver a mesa a Atrium', 'O que Atrium pode aqui…', 'Tirar a mesa de Atrium…']
    assert.deepEqual(sliceAt(taken, takenRows), takenRows)
    await shot('pilula-tomada', '#ctx-menu', pillStrip)
    await choose('Devolver a mesa a Atrium')
    await until(() => obj('desk', D1, 'hand') === undefined && [C1, C2, G, K].every(id => heldBy(id) === byA), 'given back: held again')
    // Taking the desk takes only what the desk commands (F7): a pane given to another stays.
    // (checked in section 3, once there is one)

    // ---- 3. the tab menu, state by state ----
    const commanded = await openTab(C1)
    const commandedRows = ['# Comandada por Atrium, pela mesa', 'Assumir o comando', 'Pausar Atrium nesta guia', 'Dar esta guia a outro agente…', 'O que Atrium pode nesta guia…']
    assert.deepEqual(commanded.slice(0, 5), commandedRows)
    await shot('aba-comandada', '#ctx-menu', `.tether-tab[data-slot="${C1}"]`)
    await closeMenu()

    // Give G to Kai by the tab: the picker does not offer the commander, the dialog says what happens.
    await openTab(G)
    await choose('Dar esta guia a outro agente…')
    await picker.locator('input').waitFor({ state: 'visible' })
    assert.equal(await picker.locator('.pk-title').innerText(), 'Dar a guia codex · conferência a…')
    assert.ok(!(await pickerRows()).includes('Atrium'), 'the commander is not offered again')
    assert.ok((await pickerRows()).includes('Kai'))
    await pickRow('Kai').click()
    const gd = askDialog('for-agents.give-pane')
    await gd.waitFor()
    assert.equal(await gd.locator('h2, .ask-title').first().innerText(), 'Dar a guia codex · conferência a Kai')
    assert.match(await gd.innerText(), /Hoje ela é comandada por Atrium, pela mesa\. Dada a Kai, Kai comanda e Atrium só vê\./)
    await shot('dialogo-dar-a-guia', 'dialog.ask[open]')
    await answer('for-agents.give-pane', 'give')
    await until(() => obj<{ owner: string }>('pane', G, 'owner')?.owner === K, 'pane given')
    assert.deepEqual([obj<{ givenBy: string }>('pane', G, 'owner')!.givenBy], ['user'])
    await until(() => heldBy(G) === byK && routeOf(G) === K, 'the pane given to Kai is held by Kai and routed to Kai')
    assert.equal(heldBy(C1), byA, 'the others stay with Atrium')
    const givenMenu = await openTab(G)
    const givenRows = ['# Dada a Kai · Atrium vê', 'Assumir o comando', 'Pausar Kai nesta guia', 'Ir para Kai', 'Dar a outro agente…', 'Voltar para a mesa (revoga Kai)', 'O que Kai pode nesta guia…']
    assert.deepEqual(givenMenu.slice(0, 7), givenRows)
    await shot('aba-dada', '#ctx-menu', `.tether-tab[data-slot="${G}"]`)
    await choose('Voltar para a mesa (revoga Kai)')
    await until(() => obj('pane', G, 'owner') === undefined && heldBy(G) === byA && routeOf(G) === A, 'revoked: back to the desk\'s owner')
    // Back to Kai, for the next states.
    await openTab(G); await choose('Dar esta guia a outro agente…')
    await pickRow('Kai').click()
    await answer('for-agents.give-pane', 'give')
    await until(() => heldBy(G) === byK, 'given again')

    // F7: taking the desk takes what the desk commands, not the pane that is Kai's.
    await openPill(D1); await choose('Assumir o comando da mesa')
    await until(() => [C1, C2, K].every(id => heldBy(id) === undefined) && heldBy(G) === byK, 'taking the desk leaves Kai\'s pane alone')
    await openPill(D1); await choose('Devolver a mesa a Atrium')
    await until(() => [C1, C2, K].every(id => heldBy(id) === byA), 'given back')

    // "De si": Kai's own pane, offered in the picker as "ela mesma".
    await openTab(K)
    await choose('Dar esta guia a outro agente…')
    await picker.locator('input').waitFor({ state: 'visible' })
    assert.match(await pickRow('Kai').first().innerText(), /ela mesma: de si/)
    await pickRow('Kai').first().click()
    const sd = askDialog('for-agents.give-pane-self')
    await sd.waitFor()
    assert.equal(await sd.locator('h2, .ask-title').first().innerText(), 'Dar a guia Kai ao próprio Kai')
    await shot('dialogo-de-si', 'dialog.ask[open]')
    await answer('for-agents.give-pane-self', 'give')
    await until(() => obj<{ owner: string }>('pane', K, 'owner')?.owner === K && heldBy(K) === byK, 'the own pane is held by Kai')
    assert.equal(routeOf(K), undefined, 'the own pane has no route: its request goes to the person')
    const selfMenu = await openTab(K)
    assert.deepEqual(selfMenu.slice(0, 5), ['# É dono de 1 guia em kai-aware', 'Pausar Kai em tudo', 'O que é de Kai', '—', '# Dada a Kai, que roda nela (comanda a si mesmo)'])
    assert.deepEqual(selfMenu.slice(5, 8), ['Pausar Kai em si mesmo', 'O que Kai pode em si…', 'Revogar (volta para a mesa)'])
    await shot('aba-propria', '#ctx-menu', `.tether-tab[data-slot="${K}"]`)
    await closeMenu()

    // Take, give back, pause, resume on a pane.
    await openTab(C1); await choose('Assumir o comando')
    await until(() => obj<{ why: string }>('pane', C1, 'hand')?.why === 'taken' && heldBy(C1) === undefined && !routeOf(C1), 'pane taken')
    const takenPane = await openTab(C1)
    assert.deepEqual(takenPane.slice(0, 4), ['# Com você · antes: Atrium, pela mesa', 'Devolver a Atrium', 'Dar a outro agente…', 'O que Atrium pode nesta guia…'])
    await shot('aba-tomada', '#ctx-menu', `.tether-tab[data-slot="${C1}"]`)
    await choose('Devolver a Atrium')
    await until(() => obj('pane', C1, 'hand') === undefined && heldBy(C1) === byA, 'pane given back')
    await openTab(C1); await choose('Pausar Atrium nesta guia')
    await until(() => obj<{ why: string }>('pane', C1, 'hand')?.why === 'paused' && heldBy(C1) === undefined, 'pane paused')
    const pausedPane = await openTab(C1)
    assert.match(pausedPane[0]!, /^# Pausada às \d\d:\d\d · Atrium não age aqui até você retomar$/)
    assert.deepEqual(pausedPane.slice(1, 4), ['Retomar Atrium nesta guia', 'Dar a outro agente…', 'O que Atrium pode nesta guia…'])
    await shot('aba-pausada', '#ctx-menu', `.tether-tab[data-slot="${C1}"]`)
    await choose('Retomar Atrium nesta guia')
    await until(() => obj('pane', C1, 'hand') === undefined && heldBy(C1) === byA, 'pane resumed')
    assert.equal(heldBy(C2), byA, 'the other pane was never touched')

    // The owner's tab: what is theirs, and "em tudo".
    const ownerMenu = await openTab(A)
    assert.deepEqual(ownerMenu.slice(0, 5), ['# É dono de 1 mesa (kai-aware)', 'Pausar Atrium em tudo', 'O que é de Atrium', '—', 'Dar esta guia a um agente…'])
    await page.locator('#ctx-menu > li.sub', { hasText: 'O que é de Atrium' }).click()
    await page.locator('#ctx-menu ul.submenu:not([hidden])').waitFor()
    await shot('aba-do-dono-submenu', '#ctx-menu', '#ctx-menu ul.submenu:not([hidden])')
    await closeMenu()
    await openTab(A); await choose('Pausar Atrium em tudo')
    await until(() => obj('pane', A, 'frozen') !== undefined && [C1, C2].every(id => heldBy(id) === undefined) && heldBy(G) === byK, 'paused everywhere: Atrium\'s panes go to the person, Kai\'s stay')
    assert.deepEqual((await openTab(A)).slice(0, 2), ['# Pausada em tudo desde ' + (await rowsOf(page))[0]!.slice(-5), 'Retomar Atrium em tudo'])
    await shot('aba-do-dono-pausada', '#ctx-menu', `.tether-tab[data-slot="${A}"]`)
    await choose('Retomar Atrium em tudo')
    await until(() => obj('pane', A, 'frozen') === undefined && [C1, C2].every(id => heldBy(id) === byA), 'resumed everywhere')

    // ---- 4. "Ir para" (the one gesture that goes): from another desk to the owner's pane ----
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await openPill(D1)
    await choose('Ir para Atrium', false)
    await page.waitForFunction(([d, a]) => window.__tether.activeDesk() === d && window.__tether.activeId() === a, [D1, A] as const)

    // ---- 5. the commands: an argument acts there and skips the picker and the dialog ----
    const run = (id: string, arg?: unknown): Promise<string> => page.evaluate(({ id, arg }) => window.__tether.forAgentsRun(id, arg), { id, arg })
    const view = await state()
    assert.equal(await run('for-agents.give', { kind: 'pane', id: C2, to: K }), 'ran')
    await until(() => obj<{ owner: string }>('pane', C2, 'owner')?.owner === K && heldBy(C2) === byK, 'given by command')
    assert.equal(await page.locator('dialog.picker[open], dialog.ask[open]').count(), 0, 'no picker and no dialog for a command with `to`')
    await run('for-agents.take', { kind: 'pane', id: C2 })
    await until(() => heldBy(C2) === undefined, 'taken by command')
    await run('for-agents.return', { kind: 'pane', id: C2 })
    await until(() => heldBy(C2) === byK, 'returned by command')
    await run('for-agents.pause', { kind: 'pane', id: K, scope: 'all' })
    await until(() => heldBy(G) === undefined && heldBy(C2) === undefined, 'paused everywhere of Kai by command')
    await run('for-agents.resume', { kind: 'pane', id: K, scope: 'all' })
    await until(() => heldBy(G) === byK, 'resumed')
    await run('for-agents.revoke', { kind: 'pane', id: C2 })
    await until(() => obj('pane', C2, 'owner') === undefined && heldBy(C2) === byA, 'revoked by command')
    assert.deepEqual(await state(), view, 'the commands activated nothing')
    // Without an argument it opens the picker for the active pane.
    await page.evaluate(() => { void window.__tether.forAgentsRun('for-agents.give') })
    await picker.locator('input').waitFor({ state: 'visible' })
    assert.equal(await picker.locator('.pk-title').innerText(), 'Dar a guia Atrium a…')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.picker[open]'))

    // ---- 6. revoking the desk: the declared dialog, cancel changes nothing ----
    await openPill(D1)
    await choose('Tirar a mesa de Atrium…')
    const rd = askDialog('for-agents.revoke-desk')
    await rd.waitFor()
    assert.equal(await rd.locator('h2, .ask-title').first().innerText(), 'Tirar a mesa kai-aware de Atrium')
    assert.match(await rd.innerText(), /As 2 guias que Atrium comanda voltam para você\. As 2 guias de outros agentes continuam deles\./)
    await shot('dialogo-revogar-a-mesa', 'dialog.ask[open]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.ask[open]'))
    assert.ok(obj('desk', D1, 'owner') !== undefined, 'cancel revokes nothing')
    await openPill(D1); await choose('Tirar a mesa de Atrium…')
    await rd.waitFor()
    await answer('for-agents.revoke-desk', 'revoke')
    await until(() => obj('desk', D1, 'owner') === undefined && [C1, C2].every(id => heldBy(id) === undefined) && heldBy(G) === byK, 'revoked: the desk\'s panes go back to the person, Kai\'s stay')

    // ---- 7. the owner ended: the pill and the tab ----
    const T = new Date(2026, 10, 21, 13, 40).toISOString()
    await api.objects.set('desk', D1, 'owner', { owner: A, since: T, givenBy: 'user', ended: { at: T, name: 'Atrium' } })
    await api.objects.set('pane', PLAIN, 'owner', { owner: K, since: T, givenBy: 'user', ended: { at: T, name: 'Kai' } })
    await pill(D1).locator('.desk-seal.struck').waitFor()
    const ended = await openPill(D1)
    const endedRows = ['# Atrium encerrou às 13:40 · as guias voltaram para você', 'Dar a mesa a um agente…', 'Ficar com a mesa (tira o selo)']
    assert.deepEqual(sliceAt(ended, endedRows), endedRows, 'no guia was opened by Atrium here, so the row of the guias it opened is not drawn (the manager E2E covers it)')
    await shot('pilula-encerrou', '#ctx-menu', pillStrip)
    await choose('Ficar com a mesa (tira o selo)')
    await until(() => obj('desk', D1, 'owner') === undefined, 'the struck mark taken away')
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const endedTab = await openTab(PLAIN)
    assert.deepEqual(endedTab.slice(0, 3), ['# Kai encerrou · voltou para você', 'Dar esta guia a um agente…', 'Ficar com a guia (tira a marca)'])
    await shot('aba-encerrou', '#ctx-menu', `.tether-tab[data-slot="${PLAIN}"]`)
    await closeMenu()
    await api.objects.set('pane', PLAIN, 'owner', undefined)
    const plain = await openTab(PLAIN)
    assert.deepEqual(plain.slice(0, 1), ['Dar esta guia a um agente…'])
    await shot('aba-comum', '#ctx-menu', `.tether-tab[data-slot="${PLAIN}"]`)
    await closeMenu()
    assert.equal(await page.locator('.attn.done, .attn.waiting, .attn.attention').count(), 0, 'nothing of the gestures counts in the orange')
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-25).join('\n')}`)
    throw e
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await door.mcp.close().catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
