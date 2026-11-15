// The pad "Guias" (Tether Browser E10 + E11, design §5.2, §5.3, §12a), against the real app built with TETHER_TEST_EXTENSIONS=1
// (hidden window, private home and pipe, real tetherd, loopback only). Two real agents (inert "soul" slots) named Sonda and Beta, and a
// third owner nobody shows (its pane is gone: "encerrado"):
//   1. the list by section (with you / with the agents / ended agents), chips, address, ONE state sentence per row, the header's
//      pinned actions ("Pausar todas as guias" / "Retomar todas"), nothing loose in the content;
//   2. "Ver guias do ‹agente›" in the agent pane's tab menu: the pad filtered to that agent, and "Mostrar todas";
//   3. a taken tab goes on top and the icon counts it; a tab taken to another desk keeps its owner and the pad says where it is;
//      a click goes where the tab is (its desk), a click on the agent focuses the agent's pane;
//   4. "Pausar todas as guias" / "Retomar todas", and the agent's own pause / resume (the held tab stays with the person);
//   5. the agent ends: the ended section appears with "Fechar todas", which closes only its tabs;
//   6. the app reopens: the order by owner is kept;
//   7. "Fechar as guias do ‹agente›" and the ended ones again; the empty state.
// E12: an agent that lives with its pane closed is still "usando" and its tabs are not "encerrados" (the slot's life decides, not the
// open panes); a tab restored and not loaded yet can be paused and resumed (the state waits in main and applies when it loads).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { FAKE_SOUL_CMD as FAKE_SOUL, daemonMain, launchHidden, pidAlive, rawCdp, root, sleep, inBrowser } from './browser-kit.ts'

type Act = { pin: string; label: string }
type Row = { tabId: string; title: string; address: string; control: string; state: string; place: string; actions: Act[] }
type PadView = {
  state: string; emptyText: string; offShown: boolean; filter: string; noneOfAgent: boolean; withPerson: Row[]; withPersonHead: string
  sections: string[]; activeHead: string; endedHead: string; endedActions: Act[]; buttonsInContent: string[]
  groups: { slotId: string; ended: boolean; chip: string; count: string; actions: Act[]; rows: Row[] }[]
  badge: { count: number; attention: boolean; tooltip: string } | null
}
type Pane = { id: string; tabId?: string; owner?: string; chip: string; place?: string; control: string; controlText: string; action: string; state?: string }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    slots(): SlotState[]
    openSlot(id: string): Promise<void>
    desks(): { id: string }[]
    activeDesk(): string
    createDesk(where: string, ref: string): Promise<string>
    switchDesk(id: string): void
    movePaneToDesk(id: string, deskId: string): void
    browserPanes(): Pane[]
    browserPad(): PadView | undefined
    browserPadOpen(): void
    browserClick(tabId: string, where: string): void
    browserReveal(id: string): void
    detachPane(slotId: string): void
  }
  tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> }
}
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  control: { control(id: string): string; pause(id: string): void }
  registry: { list(): { tabId: string; ownerSlotId: string }[] }
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brpad-${process.pid}`
const PAD = '[data-pad="browser.tabs"]'

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Página ${path.slice(1)}</title><body><h1>${path}</h1><input id=i>`)
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

test('browser pad: list by agent, filter, taken on top, moved tab, pause, reopen, close', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const site = await serve()
  const home = mkdtempSync(join(tmpdir(), 'tether-brpad-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let spy: Awaited<ReturnType<typeof rawCdp>> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, a?: unknown): Promise<R> =>
      inBrowser(app!, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>
    const pad = async (): Promise<PadView> => (await win.evaluate(() => window.__tether.browserPad()))!
    const panes = (): Promise<Pane[]> => win.evaluate(() => window.__tether.browserPanes())
    const click = async (sel: string): Promise<void> => { await win.locator(`${PAD} ${sel}`).first().click() }
    /** The pad header's pinned actions (the core's bar over the content). */
    const header = (): Promise<Act[]> => win.locator(`${PAD} .pad-head .ab-act[data-label]`).evaluateAll(els => els.map(e => ({ pin: (e as HTMLElement).dataset.pin ?? '', label: (e as HTMLElement).dataset.label ?? '' })))
    const headerClick = async (label: string): Promise<void> => { await win.locator(`${PAD} .pad-head .ab-act[data-label="${label}"]`).click() }
    /** One action of an object's bar: its pinned button when there is one, else through the bar's "⋯" menu. */
    const act = async (container: string, label: string): Promise<void> => {
      const base = win.locator(`${PAD} ${container}`).first()
      const direct = base.locator(`.ab-act[data-label="${label}"]:not([hidden])`).first()
      if (await direct.count()) { await direct.click(); return }
      await base.locator('.ab-more').first().click()
      await win.click(`#ctx-menu li:has-text("${label}")`)
    }
    const shotsDir = process.env.TETHER_E2E_SHOTS
    const shot = async (name: string): Promise<void> => {
      if (!shotsDir) return
      mkdirSync(shotsDir, { recursive: true })
      await sleep(400)
      const b64 = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(b64, 'base64'))
    }
    const control = (id: string): Promise<string> => B((t, a) => t.control.control(a), id)
    const [d1] = await win.evaluate(() => window.__tether.desks().map(d => d.id)) as [string]

    const agent = async (name: string): Promise<string> => {
      const slot = await win.evaluate(async a => {
        const r = await window.tether.request({ t: 'create', kind: 'soul', cwd: a.cwd, name: a.name, start: true })
        await window.__tether.openSlot(r.slot!.slotId)
        return r.slot!.slotId
      }, { cwd: home, name })
      await until(`${name} runs`, async () => (await win.evaluate(() => window.__tether.slots())).find(s => s.slotId === slot)?.status === 'running', 20_000)
      return slot
    }
    const sonda = await agent('Sonda')
    const beta = await agent('Beta')
    const GHOST = 'ghost-owner'
    const mk = async (owner: string, path: string): Promise<string> => (await B((t, a) => t.create(a.owner, a.url), { owner, url: `${site.base}${path}` })).tabId
    const a1 = await mk(sonda, '/a1')
    const b1 = await mk(beta, '/b1')
    const a2 = await mk(sonda, '/a2')
    const g1 = await mk(GHOST, '/g1')
    await until('four panes', async () => (await panes()).length === 4)
    await win.evaluate(() => window.__tether.browserPadOpen())
    await win.waitForSelector(`#pads ${PAD} .br-pad-list`)

    // ---- 1. the list by agent ----
    let v = await until('four rows', async () => { const x = await pad(); return x.groups.reduce((n, g) => n + g.rows.length, 0) === 4 ? x : undefined })
    assert.deepEqual(v.groups.map(g => [g.slotId, g.chip, g.count, g.rows.map(r => r.tabId)]), [
      [sonda, 'Sonda', '2', [a1, a2]], [beta, 'Beta', '1', [b1]], [GHOST, 'Agente', '1', [g1]],
    ], 'agents in the order of their first tab, each with its tabs; the ended one by its short name alone')
    assert.deepEqual(v.sections, ['active', 'ended'], 'no tab with the person: no such section')
    assert.equal(v.activeHead, 'Com os agentes')
    assert.equal(v.endedHead, 'De agentes encerrados (1)')
    assert.deepEqual(v.endedActions, [{ pin: 'primary', label: 'Fechar todas' }], 'the section bar: one pinned item')
    assert.equal(v.groups[2]!.ended, true)
    assert.equal(v.withPerson.length, 0)
    const r1 = v.groups[0]!.rows[0]!
    const port = new URL(site.base).port
    assert.equal(r1.address, `localhost:${port}/a1`)
    assert.equal(r1.state, 'sem ação agora')
    assert.equal(r1.place, '', 'a tab in the Browser desk says no place')
    assert.equal(v.groups[2]!.rows[0]!.state, '', 'an ended section has no state sentence')
    const endedBtns = win.locator(`${PAD} [data-ended="true"] .br-pad-row .br-pad-foot .ab-act[data-label]`)
    assert.deepEqual(await endedBtns.evaluateAll(els => els.map(e => (e as HTMLElement).dataset.label)), ['Fechar guia'], 'the ended row pins only the close')
    assert.equal(await endedBtns.first().isVisible(), true, 'the close button of the ended row is visible, not hidden')
    const clipped = await win.locator(`${PAD} [data-ended="true"] .br-pad-row .action-bar`).evaluateAll(bs => bs.filter(b => b.scrollWidth > b.clientWidth + 1).length)
    assert.equal(clipped, 0, 'the ended row bar shows both buttons, nothing clipped')
    assert.deepEqual(await header(), [{ pin: 'primary', label: 'Pausar todas as guias' }], 'there is something to brake: the header pins "Pausar todas as guias"')
    assert.equal(await win.locator(`${PAD} .pad-head [data-label="Pausar todas as guias"]`).getAttribute('data-pin'), 'primary')
    assert.deepEqual(v.buttonsInContent, [], 'no loose button in the content')
    assert.equal(await win.locator(`${PAD} .br-pad >> text="Sair de todas as contas"`).count(), 0, '"Sair de todas as contas" is not in the content')
    assert.equal(await win.locator(`${PAD} .br-pad [data-action="logout-all"], ${PAD} .br-pad [data-role="control"], ${PAD} .br-pad .br-pad-who`).count(), 0)
    assert.equal(await win.locator(`${PAD} .br-pad-row`).evaluateAll(rows => rows.filter(r => r.querySelectorAll('[data-role="state"]').length > 1).length), 0, 'a row says its state once')
    await win.locator(`${PAD} .pad-head .ab-more`).click()
    await win.waitForSelector('#ctx-menu')
    const panelMenu = await win.locator('#ctx-menu li[role=menuitem]').allTextContents()
    assert.ok(panelMenu.some(t => t.includes('Sair de todas as contas')), `the panel menu: ${panelMenu.join(' | ')}`)
    await win.keyboard.press('Escape')
    await win.waitForSelector('#ctx-menu', { state: 'detached' })
    assert.equal(v.badge, null, 'nobody holds a tab: no number on the icon')
    await until('titles', async () => (await pad()).groups[0]!.rows[0]!.title === 'Página a1')

    // the agent's last action, in words (the gatekeeper's activity)
    const gate = (await B(t => t.gate()))!
    const KEY = 'padPADpadPADpadPADpadPADpadPAD12345'
    writeFileSync(join(keysDir, `${sonda}.key`), KEY)
    spy = await rawCdp(gate.port, KEY)
    const bs = (await spy.call('Target.attachToBrowserTarget')).result.sessionId as string
    const targets = (await spy.call('Target.getTargets', {}, bs)).result.targetInfos as { targetId: string; url: string }[]
    const t1 = targets.find(t => t.url.endsWith('/a1'))!
    const sid = (await spy.call('Target.attachToTarget', { targetId: t1.targetId, flatten: true })).result.sessionId as string
    await spy.call('Input.insertText', { text: 'x' }, sid)
    await until('"digitando em localhost"', async () => (await pad()).groups[0]!.rows[0]!.state === `digitando em localhost:${port}`)
    await until('the sentence goes stale', async () => (await pad()).groups[0]!.rows[0]!.state === 'sem ação agora', 12_000)

    // ---- 2. "Ver guias do ‹agente›" in the agent pane's tab menu ----
    await win.locator('.tether-tab', { hasText: 'Sonda' }).first().click({ button: 'right' })
    await win.waitForSelector('#ctx-menu')
    const items = await win.locator('#ctx-menu li[role=menuitem]').allTextContents()
    assert.ok(items.includes('Ver guias do Sonda'), `the menu: ${items.join(' | ')}`)
    await win.click('#ctx-menu li:has-text("Ver guias do Sonda")')
    v = await until('filtered to Sonda', async () => { const x = await pad(); return x.filter === 'Só as guias do Sonda' ? x : undefined })
    assert.deepEqual(v.groups.map(g => g.slotId), [sonda])
    assert.deepEqual(v.buttonsInContent, [], 'the filter line has no button: "Mostrar todas" is in the header')
    assert.ok((await header()).some(h => h.label === 'Mostrar todas' && h.pin === 'primary'))
    await headerClick('Mostrar todas')
    v = await until('all again', async () => { const x = await pad(); return x.filter === '' && x.groups.length === 3 ? x : undefined })

    // ---- 3. taken: on top, counted, moved to another desk ----
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), a1) // "Assumir o controle"
    await until('taken', async () => (await control(a1)) === 'user')
    v = await until('a1 on top', async () => { const x = await pad(); return x.withPerson.length === 1 ? x : undefined })
    assert.deepEqual(v.withPerson.map(r => [r.tabId, r.state]), [[a1, 'com você, do Sonda']])
    assert.ok(v.withPerson[0]!.actions.some(a => a.pin === 'highlight' && a.label === 'Devolver ao Sonda'), 'the row bar highlights the hand back')
    assert.deepEqual(v.withPerson[0]!.actions.filter(x => x.pin).map(x => x.label), ['Devolver ao Sonda', 'Fechar guia'], 'held by the person: the brake is not pinned')
    assert.deepEqual(v.sections, ['user', 'active', 'ended'])
    assert.equal(v.withPersonHead, 'Com você (1)')
    assert.deepEqual(v.groups[0]!.rows.map(r => r.tabId), [a2], 'the rest of the agent stays below')
    assert.equal(v.groups[0]!.count, '1', 'the group counts its own rows')
    await shot('1-com-voce-e-agentes')
    await until('the icon counts it', async () => (await pad()).badge?.count === 1)
    assert.equal((await pad()).badge!.attention, false, 'a take is not a help request')
    assert.equal(await win.locator(`.sb-icon${PAD} .sb-badge`).textContent(), '1')

    const d2 = await win.evaluate(d => window.__tether.createDesk('after', d), d1)
    await win.evaluate(([id, to]) => window.__tether.movePaneToDesk(id, to), [`web:${a1}`, d2] as const)
    v = await until('the pad knows where a1 is', async () => { const x = await pad(); const r = x.withPerson[0]; return r?.place && r.place !== '' ? x : undefined })
    assert.match(v.withPerson[0]!.place, /^Em .+/)
    const moved = (await panes()).find(p => p.tabId === a1)!
    assert.equal(moved.owner, sonda, 'the owner follows the tab')
    assert.equal(moved.chip, 'Sonda', 'and the chip')
    await win.evaluate(d => window.__tether.switchDesk(d), d1)
    await click(`[data-tab="${a1}"] [data-action="open-tab"]`)
    await until('a click on the tab goes to its desk', async () => (await win.evaluate(() => window.__tether.activeDesk())) === d2)
    await win.evaluate(d => window.__tether.switchDesk(d), d1)
    await click(`[data-tab="${b1}"] [data-action="open-tab"]`)
    const there = await until('a click on b1 goes to the Browser desk', async () => { const d = await win.evaluate(() => window.__tether.activeDesk()); return d !== d1 && d !== d2 ? d : undefined })
    console.log(`browser desk id: ${there}`)
    await win.evaluate(d => window.__tether.switchDesk(d), d1)
    await click(`.br-pad-group[data-agent="${beta}"] [data-action="focus-agent"]`)
    assert.equal(await win.evaluate(() => window.__tether.activeDesk()), d1, 'the click on the agent focuses its pane (its desk)')

    // ---- 4. pause all / resume all; the agent's own ----
    await headerClick('Pausar todas as guias')
    await until('all paused but the held one', async () => (await control(a2)) === 'paused' && (await control(b1)) === 'paused' && (await control(a1)) === 'user')
    v = await until('rows say pausada', async () => { const x = await pad(); return x.groups[1]!.rows[0]!.state === 'pausada' ? x : undefined })
    assert.equal(v.groups[0]!.rows[0]!.state, 'pausada')
    assert.equal(v.withPerson[0]!.state, 'com você, do Sonda', 'pausing does not take the tab from her hands')
    const paused = await until('the header offers "Retomar todas" highlighted', async () => { const h = await header(); return h.find(a => a.label === 'Retomar todas' && a.pin === 'highlight') ? h : undefined })
    assert.equal(await win.locator(`${PAD} .pad-head [data-label="Retomar todas"]`).getAttribute('data-pin'), 'highlight', JSON.stringify(paused))
    await shot('2-guia-pausada')
    await headerClick('Retomar todas')
    await until('all resumed', async () => (await control(a2)) === 'agent' && (await control(b1)) === 'agent')
    await act(`[data-agent="${beta}"]`, 'Pausar as guias do Beta')
    await until('Beta paused, Sonda not', async () => (await control(b1)) === 'paused' && (await control(a2)) === 'agent')
    v = await until('the bar turns into "Retomar as guias do Beta"', async () => { const x = await pad(); return x.groups[1]!.actions.some(b => b.label === 'Retomar as guias do Beta') ? x : undefined })
    assert.deepEqual(v.groups[1]!.actions, [{ pin: 'icon', label: 'Retomar as guias do Beta' }])
    await act(`[data-agent="${beta}"]`, 'Retomar as guias do Beta')
    await until('Beta resumed', async () => (await control(b1)) === 'agent')

    // ---- 4b. E12: the pane of a LIVE agent is closed; its tabs are not "encerradas" ----
    await win.evaluate(id => window.__tether.detachPane(id), sonda)
    await until('the pane of Sonda is gone', async () => (await win.locator(`.tether-tab[data-slot="${sonda}"]`).count()) === 0)
    v = await until('Sonda stays alive in the pad', async () => { const x = await pad(); return x.groups[0]!.slotId === sonda && x.groups[0]!.chip === 'Sonda' ? x : undefined })
    assert.equal(v.groups[0]!.ended, false, 'a closed pane does not end a live agent')
    assert.equal(v.groups[0]!.rows[0]!.state, 'sem ação agora')
    assert.equal(v.endedHead, 'De agentes encerrados (1)', 'only the gone owner counts, not Sonda')
    assert.equal((await panes()).find(p => p.tabId === a2)!.controlText, 'Sonda usando', "the tab's own bar agrees")
    await win.evaluate(id => window.__tether.openSlot(id), sonda)
    await until('the pane of Sonda is back', async () => (await win.locator(`.tether-tab[data-slot="${sonda}"]`).count()) === 1)

    // ---- 5. the agent ends; the app reopens ----
    void win.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), beta)
    v = await until('Beta in the ended section', async () => { const x = await pad(); return x.groups.find(g => g.slotId === beta)?.ended ? x : undefined }, 50_000)
    const betaGroup = v.groups.find(g => g.slotId === beta)!
    assert.equal(betaGroup.chip, 'Beta', 'the ended section says it: the chip is the short name alone')
    assert.equal(betaGroup.rows[0]!.state, '')
    assert.equal(v.endedHead, 'De agentes encerrados (2)', 'Beta and the gone owner')
    assert.deepEqual(v.endedActions, [{ pin: 'primary', label: 'Fechar todas' }])
    await shot('3-agente-encerrado')
    spy?.close(); spy = undefined

    // ---- 5. "Fechar todas" of the ended section: only its tabs ----
    await act('[data-section="ended"]', 'Fechar todas')
    v = await until('only Sonda is left', async () => { const x = await pad(); return x.groups.length === 1 ? x : undefined })
    assert.deepEqual(v.groups.map(g => g.slotId), [sonda])
    assert.deepEqual(v.groups[0]!.rows.length + v.withPerson.length, 2)
    assert.equal(v.sections.includes('ended'), false, 'no ended agent: no section')
    assert.deepEqual((await B(t => t.registry.list())).map(t => t.tabId).sort(), [a1, a2].sort(), 'main closed the tabs too')

    // ---- 6. the app reopens: the order by owner is kept ----
    const x1 = await mk('owner-x', '/x1')
    const y1 = await mk('owner-y', '/y1')
    const x2 = await mk('owner-x', '/x2')
    v = await until('five rows', async () => { const x = await pad(); return x.groups.reduce((n, g) => n + g.rows.length, 0) + x.withPerson.length === 5 ? x : undefined })
    assert.deepEqual(v.groups.map(g => g.slotId), [sonda, 'owner-x', 'owner-y'])
    await sleep(1500) // the layout's debounced save
    await killElectron(app, root)
    app = undefined
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    await win.evaluate(() => window.__tether.browserPadOpen())
    await win.waitForSelector(`#pads ${PAD} .br-pad-list`)
    v = await until('the pad after reopening', async () => { const x = await pad(); return x.groups.reduce((n, g) => n + g.rows.length, 0) + x.withPerson.length === 5 ? x : undefined })
    assert.deepEqual(v.groups.map(g => g.slotId), [sonda, 'owner-x', 'owner-y'], 'the order by owner is kept')
    assert.deepEqual(v.groups.map(g => g.count), v.groups.map(g => String(g.rows.length)))
    assert.deepEqual(v.groups[1]!.rows.map(r => r.tabId), [x1, x2])
    assert.equal(v.groups[1]!.ended, true, 'an owner without a pane is ended (design 7.3)')
    assert.equal(v.groups[1]!.chip, 'Agente')
    assert.equal((await panes()).find(p => p.tabId === a1)!.owner, sonda, "a1 is still Sonda's after the reopening")

    // ---- 6b. E12: a restored tab that is not loaded yet can be paused and resumed ----
    const unloaded = (await panes()).find(p => p.tabId === a2)!
    assert.equal(unloaded.state, 'not-loaded', 'a2 came back from layout.json without loading')
    // Sonda's slot runs again in the reopened app: its tabs are with the agents and the header offers the brake (main's list reaches the browser process after its hello).
    v = await until('a live agent is not ended after the reopening', async () => { const x = await pad(); return x.groups[0]!.slotId === sonda && !x.groups[0]!.ended ? x : undefined })
    assert.equal(v.endedHead, 'De agentes encerrados (3)', 'only the gone owners x and y')
    await until('the header offers the brake', async () => (await header()).some(h => h.label === 'Pausar todas as guias'))
    await headerClick('Pausar todas as guias')
    await until('the unloaded tab is paused in main', async () => (await control(a2)) === 'paused')
    await until('and its bar says so', async () => { const p = (await panes()).find(q => q.tabId === a2)!; return p.controlText === 'Pausada' && p.action === 'Retomar' && p.state === 'not-loaded' })
    v = await until('the pad row is paused', async () => { const x = await pad(); return x.groups.find(g => g.slotId === sonda)!.rows.find(r => r.tabId === a2)?.control === 'paused' ? x : undefined })
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), a2) // "Retomar" on the unloaded tab
    await until('resumed while not loaded', async () => (await control(a2)) === 'agent')
    await B((t, id) => t.control.pause(id), a2)
    await until('paused again', async () => (await control(a2)) === 'paused')
    await win.evaluate(id => window.__tether.browserReveal(id), `web:${a2}`)
    await until('the tab loads when shown', async () => (await panes()).find(p => p.tabId === a2)!.state === 'live')
    assert.equal(await control(a2), 'paused', 'and it is born paused')
    assert.equal((await panes()).find(p => p.tabId === a2)!.controlText, 'Pausada')
    await headerClick('Retomar todas')
    await until('all resumed', async () => (await control(a2)) === 'agent' && (await control(a1)) !== 'paused')

    // ---- 7. close one agent's, then the rest ----
    await act('[data-agent="owner-x"]', 'Fechar as guias do Agente')
    v = await until('owner-x gone', async () => { const x = await pad(); return x.groups.every(g => g.slotId !== 'owner-x') ? x : undefined })
    assert.equal((await panes()).length, 3)
    const ended = v.groups.filter(g => g.ended).reduce((n, g) => n + g.rows.length, 0)
    assert.equal(v.endedHead, `De agentes encerrados (${ended})`)
    await act('[data-section="ended"]', 'Fechar todas')
    await until('what remains is alive', async () => (await pad()).groups.every(g => !g.ended))
    for (const g of (await pad()).groups) await act(`[data-agent="${g.slotId}"]`, `Fechar as guias do ${g.chip}`)
    v = await until('the empty state', async () => { const x = await pad(); return x.state === 'empty' ? x : undefined })
    assert.equal(v.emptyText, 'Nenhuma guia aberta. Quando um agente abrir uma, ela aparece aqui.')
    assert.equal(v.badge, null)
    assert.equal((await panes()).length, 0)
    void y1
  } finally {
    spy?.close()
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    site.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
