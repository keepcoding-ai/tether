// E2E of the inventory pad (tether for agents, slice U3): "O que <dono> pode · <mesa>" opened from the pill and from the tab (with the
// pane's line open), the desk's lines, the panes that differ with "herdar", the panes of another owner, "Ligar tudo", a desk with
// no owner offering to give, and that turning a line off writes the right `inventory` and makes the verb answer `off` (the
// daemon's own check, with the terminal conductor). Opening the pad activates no pane and switches no desk. A tetherd in this
// process on a private home and pipe with the real for-agents daemon side; the real app on the same pipe, hidden window.
// Fake agents in a .cjs that only stay alive: no LLM. With TETHER_U3_PRINTS set to a folder, the pad goes there in light and dark.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { terminalConductor } from '../../extensions/conductor-terminal/conductor.ts'
import { conductorRegistry } from '../../extensions/for-agents/conductor-api.ts'
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
  forAgentsRun(id: string, arg?: unknown): Promise<string>
}
declare const window: { __tether: Hooks; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')
const PAD = 'for-agents.inventory'

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

test('for-agents inventory pad: desk and pane lines, "herdar", other owners, "Ligar tudo", a desk with no owner; off makes the verb answer off', { timeout: 600_000 }, async () => {
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
  const unregister = conductorRegistry.register(terminalConductor)
  const door = new DoorHost({ log: m => logs.push(m) })
  let fa: ReturnType<typeof wire>['forAgents'] | undefined
  const entry: ExtensionEntry<TetherDaemon> = { manifest, activate: api => { const w = wire(api); fa = w.forAgents; return w.disposables } }
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

    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    const D1 = 'desk-1', D2 = 'desk-2'
    await page.evaluate(() => { window.__tether.renameDesk('desk-1', 'kai-aware'); window.__tether.renameDesk('desk-2', 'geral') })
    const slot = async (name: string): Promise<string> => (await api.slots.create({ kind: 'soul', cwd: home, name })).slotId
    const A = await slot('Atrium'), C1 = await slot('soul · testes'), C2 = await slot('soul · outra'), C3 = await slot('soul · terceira')
    const G = await slot('codex · conferência'), K = await slot('kai · Claude'), PLAIN = await slot('soul comum')
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await page.evaluate(id => window.__tether.openSlot(id), PLAIN)
    await page.evaluate(id => window.__tether.switchDesk(id), D1)
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    for (const id of [A, C1, C2, C3, G, K]) { await page.evaluate(id => window.__tether.openSlot(id), id); await page.locator(`.tether-tab[data-slot="${id}"]`).waitFor() }
    await page.locator(`.tether-tab[data-slot="${A}"]`).click()
    await waitUntil(() => (api.desks.map()?.desks.length ?? 0) >= 2, 20_000, 'desk map')

    const tab = (id: string) => page.locator(`.tether-tab[data-slot="${id}"]`)
    const pill = (d: string) => page.locator(`#desk-switch .seg[data-desk="${d}"]`)
    const state = () => page.evaluate(() => ({ desk: window.__tether.activeDesk(), active: window.__tether.activeId(), current: window.__tether.currentPane() }))
    const pad = page.locator(`#pads .pad.shown[data-pad="${PAD}"] .fa-inv`)
    const title = () => pad.locator('.fa-inv-title').innerText()
    const line = (key: string) => pad.locator(`[data-key="${key}"]`)
    const sections = () => pad.locator('.fa-sec').allTextContents()
    const titleIs = (t: string) => page.waitForFunction(x => document.querySelector('.fa-inv-title')?.textContent === x, t)
    const dir = process.env.TETHER_U3_PRINTS
    if (dir) mkdirSync(dir, { recursive: true })
    const shot = async (name: string): Promise<void> => {
      if (!dir) return
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
        await page.waitForTimeout(250)
        await pad.screenshot({ path: join(dir, `u3-${name}-${theme}.png`) })
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    }
    const obj = <T>(kind: 'desk' | 'pane', id: string, key: string): T | undefined => api.objects.get<T>(kind, id, key)
    const stored = (kind: 'desk' | 'pane', id: string): string | undefined => { const v = obj(kind, id, 'inventory'); return v === undefined ? undefined : JSON.stringify(v) }
    const until = (fn: () => boolean, what: string): Promise<void> => waitUntil(fn, 15_000, what)
    /** The verb as the owner's agent runs it (the MCP exit): the answer's error code, or undefined when it ran. */
    const verb = async (name: string, args: Record<string, unknown>): Promise<string | undefined> => {
      const e = door.verbs.find('agents', name)
      assert.ok(e, `verb ${name}`)
      const r = await door.verbs.run(e, { slotId: A, state: api.slots.get(A)!, via: 'mcp', proven: true }, args)
      return (r.data as { error?: string } | undefined)?.error
    }
    /** `interrupt` answers `off` when the line is off; with it on the check passes and the answer is the conductor's (not `off`). */
    const interrupt = (id: string): Promise<string | undefined> => verb('interrupt', { guia: id })
    const choose = async (label: string): Promise<void> => {
      const before = await state()
      await page.locator('#ctx-menu > li', { hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).click()
      await page.waitForTimeout(200)
      assert.deepEqual(await state(), before, `"${label}" neither activated a pane nor changed the desk`)
    }

    // ---- 0. the desk of the preview: Atrium owns kai-aware; G is Kai's, K is Kai's own ("de si") ----
    const store = fa!.store
    await store.giveDesk(D1, A)
    await store.givePane(G, K, 'user')
    await store.givePane(K, K, 'user')
    await waitUntil(() => api.slots.get(C1)?.held?.by === A, 20_000, 'the desk commands its panes')
    for (const id of [C1, C2, C3]) assert.notEqual(await interrupt(id), 'off', `interrupt on ${id} before any limit`)

    // ---- 1. by the pill: "O que Atrium pode aqui…" ----
    const start = await state()
    await pill(D1).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await choose('O que Atrium pode aqui…')
    await pad.waitFor()
    assert.equal(await title(), 'O que Atrium pode · kai-aware')
    assert.deepEqual(await state(), start, 'opening the pad from the pill changed nothing')
    assert.deepEqual(await sections(), ['A mesa · vale para toda guia que Atrium comanda aqui', 'Guias desta mesa com outro dono'])
    assert.deepEqual(await pad.locator('.fa-row[data-line^="desk:"] .fa-grow').allInnerTexts(), [
      'Enviar pedido e corrigir em curso', 'Interromper', 'Responder pedido de permissão', 'Rodar comandos do CLI (/compact…)', 'Digitar texto na guia', 'Teclar',
      'Abrir e fechar guias nesta mesa', 'Dar e revogar guias desta mesa',
    ])
    assert.equal(await pad.locator('.fa-row[data-line^="desk:"] .fa-tg.on').count(), 8, 'born with everything on')
    const others = await pad.locator('.fa-other').allInnerTexts()
    assert.match(others[0]!, /codex · conferência · de kai · Claude · tudo ligado\s*abrir o de kai · Claude/)
    assert.match(others[1]!, /kai · Claude · de kai · Claude, de si · tudo ligado\s*abrir o de kai · Claude/)
    assert.equal(await pad.locator('.ab-act[data-label="Ligar tudo"]').isDisabled(), true, 'nothing stored: "Ligar tudo" has nothing to do')
    assert.equal(await pad.locator('.ab-act[data-label="Ir para Atrium"]').count(), 1)
    await shot('mesa')

    // ---- 2. a desk line off: the data, and the verb answers off for every pane of the desk ----
    await line('desk:interrupt').click()
    await until(() => stored('desk', D1) === '{"interrupt":false}', 'desk.<id>.inventory = { interrupt: false }')
    await page.waitForFunction(() => document.querySelector('.fa-inv [data-key="desk:interrupt"]')?.getAttribute('aria-checked') === 'false')
    assert.equal(await line('desk:interrupt').innerText(), 'desligado')
    for (const id of [C1, C2, C3]) assert.equal(await interrupt(id), 'off', `interrupt answers off on ${id}`)
    assert.notEqual(await verb('send', { guia: C1, text: 'x' }), 'off', 'the other lines stay on')
    await line('desk:give-revoke').click()
    await until(() => stored('desk', D1) === '{"interrupt":false,"give-revoke":false}', 'a desk-only line stored beside it')
    assert.equal(await verb('give', { guia: C1, to: 'ninguem' }), 'off', 'give answers off when the desk turned it off')
    await line('desk:give-revoke').click()
    await until(() => stored('desk', D1) === '{"interrupt":false}', 'turned on again: the key goes, only what is off stays')
    assert.equal(await verb('give', { guia: C1, to: 'ninguem' }), 'unknown-agent', 'on again: the check passes and the verb goes on')
    await page.waitForFunction(() => !(document.querySelector('.fa-inv .ab-act[data-label="Ligar tudo"]') as HTMLButtonElement | null)?.disabled)

    // ---- 3. by the tab: the pane's line opens, three states, "herdar" ----
    const beforeTab = await state()
    await tab(C1).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    const rows = await page.locator('#ctx-menu > li').allInnerTexts()
    assert.ok(rows.some(r => r.trim() === 'O que Atrium pode nesta guia…'), `the tab's menu offers the pane's inventory (${rows.join(' | ')})`)
    // The right click on a tab may activate it; what must hold is that the pad's opening adds nothing to that.
    const afterRight = await state()
    await choose('O que Atrium pode nesta guia…')
    await page.waitForFunction(() => document.querySelector('.fa-inv [data-key="pane:send"]') !== null)
    assert.deepEqual(await state(), afterRight, 'opening from the tab activated nothing')
    void beforeTab
    assert.deepEqual(await sections(), ['A mesa · vale para toda guia que Atrium comanda aqui', 'Esta guia · soul · testes', 'Guias desta mesa com outro dono'])
    assert.equal(await line('pane:interrupt').innerText(), 'como a mesa · desligado')
    assert.equal(await line('pane:interrupt').getAttribute('data-state'), 'desk')
    assert.equal(await line('pane:send').innerText(), 'como a mesa · ligado')
    assert.match(await pad.locator('.fa-note').innerText(), /Atrium a comanda pela mesa/)
    await shot('guia')
    await line('pane:interrupt').click()
    await until(() => stored('pane', C1) === '{"interrupt":true}', 'pane.<id>.inventory = { interrupt: true }: "ligado aqui" against a desk that is off')
    await page.waitForFunction(() => document.querySelector('.fa-inv [data-key="pane:interrupt"]')?.textContent === 'ligado aqui')
    assert.notEqual(await interrupt(C1), 'off', 'on here beats the desk: the check passes (whatever the turn then says)')
    assert.equal(await interrupt(C2), 'off', 'the other panes follow the desk')
    await line('pane:answer').click()
    await until(() => stored('pane', C1) === '{"interrupt":true,"answer":false}', '"desligado aqui" on a line the desk has on')
    assert.equal(await verb('answer', { guia: C1, choice: 'yes' }), 'off')
    assert.notEqual(await verb('answer', { guia: C2, choice: 'yes' }), 'off', 'only that pane')
    assert.deepEqual(await state(), afterRight, 'no click of the pad activated a pane')
    await line('pane:answer:inherit').click()
    await until(() => stored('pane', C1) === '{"interrupt":true}', '"herdar" deletes the key')
    assert.notEqual(await verb('answer', { guia: C1, choice: 'yes' }), 'off')

    // ---- 4. the panes that differ, with "herdar", from the desk's view ----
    await page.evaluate(d => window.__tether.forAgentsRun('for-agents.inventory', { kind: 'desk', id: d }), D1)
    await line(`exc:${C1}:interrupt`).waitFor()
    assert.deepEqual(await sections(), ['A mesa · vale para toda guia que Atrium comanda aqui', 'Guias que diferem da mesa', 'Guias desta mesa com outro dono'])
    assert.match(await pad.locator('.fa-row[data-line^="exc:"]').first().innerText(), /soul · testes · Interromper\s*ligado aqui\s*herdar/)
    assert.match(await pad.innerText(), /As outras 2 guias que Atrium comanda seguem a mesa\./)
    await shot('difere')
    await line(`exc:${C1}:interrupt:inherit`).click()
    await until(() => stored('pane', C1) === undefined, 'herdar: the pane has no inventory left')
    assert.equal(await interrupt(C1), 'off')

    // ---- 5. another owner's pane: "abrir o de Kai" opens that pane's line, without bringing it forward ----
    const beforeOpen = await state()
    await line(`other:${G}:open`).click()
    await line('pane:send').waitFor()
    assert.match(await pad.locator('.fa-note').innerText(), /Dada a kai · Claude/)
    assert.deepEqual(await state(), beforeOpen, '"abrir o de Kai" activated nothing')

    // ---- 6. "Ligar tudo" clears the desk and every pane of it ----
    await api.objects.set('pane', C2, 'inventory', { send: false })
    await api.objects.set('pane', G, 'inventory', { keys: false })
    await page.evaluate(d => window.__tether.forAgentsRun('for-agents.inventory', { kind: 'desk', id: d }), D1)
    await page.waitForFunction(() => { const b = document.querySelector('.fa-inv .ab-act[data-label="Ligar tudo"]') as HTMLButtonElement | null; return !!b && !b.disabled })
    await pad.locator('.ab-act[data-label="Ligar tudo"]').click()
    await until(() => stored('desk', D1) === undefined && stored('pane', C2) === undefined && stored('pane', G) === undefined, 'everything back to the born state')
    for (const id of [C1, C2, C3]) assert.notEqual(await interrupt(id), 'off', `${id} is on again`)
    await page.waitForFunction(() => document.querySelectorAll('.fa-inv .fa-row[data-line^="desk:"] .fa-tg.on').length === 8)
    assert.equal(await pad.locator('.ab-act[data-label="Ligar tudo"]').isDisabled(), true)

    // ---- 7. a desk with no owner (not the one on screen): the message and the way to give; nothing switches ----
    const beforeFree = await state()
    await page.evaluate(() => window.__tether.forAgentsRun('for-agents.inventory', { kind: 'desk', id: 'desk-2' }))
    await titleIs('O que um agente pode · geral')
    assert.equal(await pad.locator('.fa-inv-free p').innerText(), 'Esta mesa não foi dada a ninguém.')
    assert.equal(await pad.locator('.fa-inv-free .fa-link').innerText(), 'Dar a mesa a um agente…')
    assert.equal(await pad.locator('.fa-row[data-line^="desk:"]').count(), 0, 'nothing stored: no lines under the message')
    assert.deepEqual(await state(), beforeFree, 'the pad of another desk did not switch desks')
    await shot('sem-dono')
    await pad.locator('.fa-inv-free .fa-link').click()
    await page.locator('dialog.picker input').waitFor({ state: 'visible' })
    assert.equal(await page.locator('dialog.picker .pk-title').innerText(), 'Dar a mesa geral a…')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.picker[open]'))
    assert.equal(obj('desk', D2, 'owner'), undefined, 'cancelling the picker gave nothing')

    // ---- 8. with nothing pointed, it follows the desk on screen ----
    await page.evaluate(() => window.__tether.forAgentsRun('for-agents.inventory'))
    await titleIs('O que Atrium pode · kai-aware')
    await page.evaluate(id => window.__tether.switchDesk(id), D2)
    await titleIs('O que um agente pode · geral')
    assert.equal(await page.locator('.attn.done, .attn.waiting, .attn.attention').count(), 0, 'nothing of the pad counts in the orange')
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-25).join('\n')}`)
    throw e
  } finally {
    unregister.dispose()
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
})
