// The pad "Guias" (Tether Browser E10 + E11, design §5.2, §5.3, §12a), against the real app built with TETHER_TEST_EXTENSIONS=1
// (hidden window, private home and pipe, real tetherd, loopback only). Two real agents (inert "soul" slots) named Sonda and Beta, and a
// third owner nobody shows (its pane is gone: "encerrado"):
//   1. the list by agent (the order of the first tab), chips, address, who has each tab, the agent's last action in words;
//   2. "Ver guias do ‹agente›" in the agent pane's tab menu: the pad filtered to that agent, and "Mostrar todas";
//   3. a taken tab goes on top and the icon counts it; a tab taken to another desk keeps its owner and the pad says where it is;
//      a click goes where the tab is (its desk), a click on the agent focuses the agent's pane;
//   4. "Pausar todas as guias" / "Retomar todas", and the agent's own pause / resume (the held tab stays with the person);
//   5. the agent ends: "Fechar guias de agentes encerrados (n)" with the right count, only those;
//   6. the app reopens: the order by owner is kept;
//   7. "Fechar as guias do ‹agente›" and the ended ones again; the empty state.
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
import { daemonMain, launchHidden, pidAlive, rawCdp, root, sleep } from './browser-kit.ts'

type Row = { tabId: string; title: string; address: string; control: string; action: string; place: string }
type Btn = { action: string; text: string; disabled: boolean }
type PadView = {
  state: string; emptyText: string; offShown: boolean; controls: Btn[]; filter: string; withPerson: Row[]; withPersonHead: string
  groups: { slotId: string; ended: boolean; chip: string; count: string; buttons: Btn[]; rows: Row[] }[]
  badge: { count: number; attention: boolean; tooltip: string } | null
}
type Pane = { id: string; tabId?: string; owner?: string; chip: string; place?: string; control: string }
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
  }
  tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> }
}
type Tabs = {
  create(owner: string, url: string, ticket?: boolean): Promise<{ tabId: string }>
  control: { control(id: string): string }
  registry: { list(): { tabId: string; ownerSlotId: string }[] }
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brpad-${process.pid}`
const FAKE_SOUL = `"${process.execPath}" -e "setInterval(()=>{},1000)"`
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
      app!.evaluate(new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>
    const pad = async (): Promise<PadView> => (await win.evaluate(() => window.__tether.browserPad()))!
    const panes = (): Promise<Pane[]> => win.evaluate(() => window.__tether.browserPanes())
    const click = async (sel: string): Promise<void> => { await win.locator(`${PAD} ${sel}`).first().click() }
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
      [sonda, 'Sonda', '2', [a1, a2]], [beta, 'Beta', '1', [b1]], [GHOST, 'Agente encerrado', '1', [g1]],
    ], 'agents in the order of their first tab, each with its tabs')
    assert.equal(v.groups[2]!.ended, true)
    assert.equal(v.withPerson.length, 0)
    const r1 = v.groups[0]!.rows[0]!
    const port = new URL(site.base).port
    assert.equal(r1.address, `localhost:${port}/a1`)
    assert.equal(r1.control, 'Sonda usando')
    assert.equal(r1.action, 'sem ação agora')
    assert.equal(r1.place, '', 'a tab in the Browser desk says no place')
    assert.equal(v.groups[2]!.rows[0]!.control, 'Agente encerrado')
    assert.deepEqual(v.controls.map(b => [b.text, b.disabled]), [['Pausar todas as guias', false], ['Retomar todas', true], ['Fechar guias de agentes encerrados (1)', false]])
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
    await until('"digitando em localhost"', async () => (await pad()).groups[0]!.rows[0]!.action === `digitando em localhost:${port}`)
    await until('the sentence goes stale', async () => (await pad()).groups[0]!.rows[0]!.action === 'sem ação agora', 12_000)

    // ---- 2. "Ver guias do ‹agente›" in the agent pane's tab menu ----
    await win.locator('.tether-tab', { hasText: 'Sonda' }).first().click({ button: 'right' })
    await win.waitForSelector('#ctx-menu')
    const items = await win.locator('#ctx-menu li[role=menuitem]').allTextContents()
    assert.ok(items.includes('Ver guias do Sonda'), `the menu: ${items.join(' | ')}`)
    await win.click('#ctx-menu li:has-text("Ver guias do Sonda")')
    v = await until('filtered to Sonda', async () => { const x = await pad(); return x.filter === 'Guias do Sonda' ? x : undefined })
    assert.deepEqual(v.groups.map(g => g.slotId), [sonda])
    await click('[data-action="show-all"]')
    v = await until('all again', async () => { const x = await pad(); return x.filter === '' && x.groups.length === 3 ? x : undefined })

    // ---- 3. taken: on top, counted, moved to another desk ----
    await win.evaluate(id => window.__tether.browserClick(id, 'bar'), a1) // "Assumir o controle"
    await until('taken', async () => (await control(a1)) === 'user')
    v = await until('a1 on top', async () => { const x = await pad(); return x.withPerson.length === 1 ? x : undefined })
    assert.deepEqual(v.withPerson.map(r => [r.tabId, r.control, r.action]), [[a1, 'Com você', 'com você']])
    assert.equal(v.withPersonHead, 'Com você (1)')
    assert.deepEqual(v.groups[0]!.rows.map(r => r.tabId), [a2], 'the rest of the agent stays below')
    assert.equal(v.groups[0]!.count, '2')
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
    await click(`[data-section="agent"][data-agent="${beta}"] [data-action="focus-agent"]`)
    assert.equal(await win.evaluate(() => window.__tether.activeDesk()), d1, 'the click on the agent focuses its pane (its desk)')

    // ---- 4. pause all / resume all; the agent's own ----
    await click('[data-action="pause-all"]')
    await until('all paused but the held one', async () => (await control(a2)) === 'paused' && (await control(b1)) === 'paused' && (await control(a1)) === 'user')
    v = await until('rows say Pausada', async () => { const x = await pad(); return x.groups[1]!.rows[0]!.control === 'Pausada' ? x : undefined })
    assert.equal(v.groups[0]!.rows[0]!.control, 'Pausada')
    assert.equal(v.withPerson[0]!.control, 'Com você', 'pausing does not take the tab from her hands')
    await click('[data-action="resume-all"]')
    await until('all resumed', async () => (await control(a2)) === 'agent' && (await control(b1)) === 'agent')
    await click(`[data-section="agent"][data-agent="${beta}"] [data-action="pause-agent"]`)
    await until('Beta paused, Sonda not', async () => (await control(b1)) === 'paused' && (await control(a2)) === 'agent')
    v = await until('the button turns into "Retomar as guias do Beta"', async () => { const x = await pad(); return x.groups[1]!.buttons.some(b => b.text === 'Retomar as guias do Beta') ? x : undefined })
    assert.deepEqual(v.groups[1]!.buttons.map(b => b.text), ['Retomar as guias do Beta', 'Fechar as guias do Beta'])
    await click(`[data-section="agent"][data-agent="${beta}"] [data-action="resume-agent"]`)
    await until('Beta resumed', async () => (await control(b1)) === 'agent')

    // ---- 5. the agent ends; the app reopens ----
    void win.evaluate(id => window.tether.request({ t: 'stop', slotId: id }), beta)
    v = await until('"Beta encerrado" in the pad', async () => { const x = await pad(); return x.groups[1]!.chip === 'Beta encerrado' ? x : undefined }, 50_000)
    assert.equal(v.groups[1]!.rows[0]!.control, 'Beta encerrado')
    assert.equal(v.controls.find(b => b.action === 'close-ended')!.text, 'Fechar guias de agentes encerrados (2)', 'Beta and the gone owner')
    spy?.close(); spy = undefined

    // ---- 5. "Fechar guias de agentes encerrados (n)": the right count, only those ----
    await click('[data-action="close-ended"]')
    v = await until('only Sonda is left', async () => { const x = await pad(); return x.groups.length === 1 ? x : undefined })
    assert.deepEqual(v.groups.map(g => g.slotId), [sonda])
    assert.deepEqual(v.groups[0]!.rows.length + v.withPerson.length, 2)
    assert.equal(v.controls.some(b => b.action === 'close-ended'), false, 'no ended agent: no button')
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
    assert.deepEqual(v.groups.map(g => g.count), ['2', '2', '1'])
    assert.deepEqual(v.groups[1]!.rows.map(r => r.tabId), [x1, x2])
    assert.equal(v.groups[1]!.chip, 'Agente encerrado', 'an owner without a pane: "Agente encerrado" (design 7.3)')
    assert.equal((await panes()).find(p => p.tabId === a1)!.owner, sonda, "a1 is still Sonda's after the reopening")

    // ---- 7. close one agent's, then the rest ----
    await click('[data-section="agent"][data-agent="owner-x"] [data-action="close-agent"]')
    v = await until('owner-x gone', async () => { const x = await pad(); return x.groups.every(g => g.slotId !== 'owner-x') ? x : undefined })
    assert.equal((await panes()).length, 3)
    const ended = v.groups.filter(g => g.ended).reduce((n, g) => n + Number(g.count), 0)
    assert.equal(v.controls.find(b => b.action === 'close-ended')!.text, `Fechar guias de agentes encerrados (${ended})`)
    await click('[data-action="close-ended"]')
    await until('what remains is alive', async () => (await pad()).groups.every(g => !g.ended))
    for (const g of (await pad()).groups) await click(`[data-section="agent"][data-agent="${g.slotId}"] [data-action="close-agent"]`)
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
