// E2E of the person's own tab (navegador da pessoa, F1/N1): the app built with TETHER_TEST_EXTENSIONS=1, hidden window, private
// home and pipe, real tetherd, the local-network setting left at "ask". The person, with no agent behind:
//   1. opens a tab from the palette ("Navegador: nova guia"): it is hers (owner `person`, control `own`), the shield is off, the bar
//      shows the pill "Você" and the shared-logins line, and the address field is in focus;
//   2. types a local address (a page this test serves at http://localhost:<port>) and presses Enter: it loads with no question;
//      a `javascript:` address is refused in main and the field stays open, marked;
//   3. an agent's connection to the gate (its key in <home>/browser/keys) sees none of her tabs: not in getTargets, no attach, no
//      close; its own tab is all it sees;
//   4. Ctrl+T in the Browser desk opens another tab of hers; the pad lists hers first ("Suas guias");
//   5. her tab's × closes it with no dialog, and the closed history keeps it under "Você".
// Screenshots of the bar (the editable address, the pill, the line) go to BROWSER_PERSON_SHOTS (default test/e2e/artifacts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { FAKE_SOUL_CMD as FAKE_SOUL, daemonMain, inBrowser, launchHidden, pidAlive, rawCdp, root, sleep } from './browser-kit.ts'

type Pane = {
  id: string; tabId?: string; owner?: string; url: string; control: string; controlText: string; tone: string; chip: string; person: boolean; own: boolean
  notices: { kind: string; text: string }[]; actions: { pin: string; label: string }[]; nav: Record<string, boolean>
  addressField: { editing: boolean; value: string; invalid: boolean; editable: boolean }
  tab?: { owner: string }
}
type PadRow = { tabId: string; title: string }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    palette(): { open: boolean; shown: string[] }
    browserPanes(): Pane[]
    browserPad(): { mine: PadRow[]; mineHead: string; sections: string[] } | undefined
    browserPadOpen(): void
    browserReveal(id: string): void
    browserNewTabOn(url: string | undefined, deskId: string): Promise<{ ok: boolean; tabId?: string; why?: string }>
    browserNewTabFor(slotId: string, deskId: string): Promise<{ ok: boolean; tabId?: string; why?: string }>
    slots(): { slotId: string; status: string }[]
    openSlot(id: string): Promise<void>
    activeDesk(): string
    switchDesk(id: string): void
    desks(): { id: string; panes: string[] }[]
  }
  tether: { request(r: unknown): Promise<{ slot?: { slotId: string } }> }
}
type Tabs = {
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[]; surface(id: string): { debugger: { send(m: string): Promise<unknown> } } | undefined }
  eval(tabId: string, code: string): Promise<unknown>
  shield(tabId: string): boolean | undefined
  control: { view(id: string): { why?: string; holder: string; paused: boolean } }
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brperson-${process.pid}`
const KEY_A = 'aaaaAAAAbbbbBBBBccccCCCCddddDDDDpppp'
const shotsDir = process.env.BROWSER_PERSON_SHOTS ?? join(root, 'test', 'e2e', 'artifacts')

function servePages(): Promise<{ server: Server; base: string; hits: Record<string, number> }> {
  const hits: Record<string, number> = {}
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits[path] = (hits[path] ?? 0) + 1
    if (path === '/mine.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><title>Página dela</title><link rel="icon" href="data:,"><h1 style="padding:24px">PERSON-PAGE</h1>')
    }
    if (path === '/agent.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><title>Página do agente</title><link rel="icon" href="data:,"><h1>AGENT-PAGE</h1>')
    }
    res.writeHead(404).end('not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
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

test('browser: the person opens, types and closes a tab of her own; no agent sees it', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shotsDir, { recursive: true })
  const pages = await servePages()
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-brperson-'))
  // The local network stays at "ask": her typed address must open with no question.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'ask' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  writeFileSync(join(keysDir, 'agent-a.key'), KEY_A)
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const tabs = (): Promise<{ tabId: string; ownerSlotId: string; url: string }[]> => inBrowser(T, () => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list())
    const panes = (): Promise<Pane[]> => win.evaluate(() => window.__tether.browserPanes())
    const pane = async (tabId: string): Promise<Pane | undefined> => (await panes()).find(p => p.tabId === tabId)
    const dialogs = (): Promise<string[]> => win.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(d => (d as HTMLElement).dataset.dialog ?? '?'))
    const shot = async (name: string): Promise<void> => { await win.mouse.move(5, 5); await sleep(300); await win.screenshot({ path: join(shotsDir, `browser-person-${name}.png`) }) }

    // ---- 1. the palette opens a tab of hers ----
    await win.keyboard.press('Control+Shift+P')
    await win.waitForFunction(() => window.__tether.palette().open)
    await win.keyboard.type('nova guia')
    await win.waitForFunction(() => window.__tether.palette().shown[0] === 'browser.new-tab')
    await win.keyboard.press('Enter')
    const mine = await until('her tab in main', async () => (await tabs()).find(t => t.ownerSlotId === 'person'))
    assert.equal(mine.url, 'about:blank')
    const first = await until('her pane, its field in focus', async () => { const p = await pane(mine.tabId); return p?.addressField.editing ? p : undefined })
    assert.equal(first.owner, 'person')
    assert.equal(first.own, true)
    assert.equal(first.tone, 'own')
    assert.equal(first.controlText, 'Você')
    assert.equal(first.person, true, 'the pill carries the person mark (fixed colour)')
    assert.deepEqual(first.notices.map(n => [n.kind, n.text]), [['logins', 'Contas em que você entrar aqui ficam disponíveis aos agentes.']])
    assert.deepEqual(first.actions.filter(a => a.pin), [], 'nothing to hand back, pause or clean on the bar')
    assert.equal(first.addressField.value, '', 'the blank page leaves the field empty')
    assert.equal(await win.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.role), 'address-input', 'the field has the focus')
    const view = await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.control.view(id), mine.tabId)
    assert.equal(view.why, 'own')
    assert.equal(view.holder, 'user')
    assert.equal(await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.shield(id), mine.tabId), false, 'the shield is off: the page is hers')

    // ---- 2. she types a local address and presses Enter: it loads, no question ----
    const target = `${pages.base}/mine.html`
    await win.keyboard.type(target)
    await shot('typing')
    await win.keyboard.press('Enter')
    await until('the page loaded', async () => (await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(id, 'document.body && document.body.innerText'), mine.tabId)) === 'PERSON-PAGE', 20_000)
    assert.equal(pages.hits['/mine.html'], 1)
    assert.deepEqual(await dialogs(), [], 'no local-network question (typing it is her consent)')
    const loaded = await until('the bar shows the address', async () => { const p = await pane(mine.tabId); return p && p.url === target && !p.addressField.editing ? p : undefined })
    assert.equal(loaded.nav.reload, true, 'her history buttons answer')
    await shot('loaded')
    // A `javascript:` address is refused in main: the field stays open, marked, and the page stays.
    await win.click(`.br-web[data-tab="${mine.tabId}"] .br-web-url`)
    await until('field open again', async () => (await pane(mine.tabId))?.addressField.editing)
    await win.keyboard.press('Control+A')
    await win.keyboard.type('javascript:document.title="x"')
    await win.keyboard.press('Enter')
    const refused = await until('refused, marked', async () => { const p = await pane(mine.tabId); return p?.addressField.invalid ? p : undefined })
    assert.equal(refused.addressField.editing, true)
    assert.equal(await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(id, 'document.title'), mine.tabId), 'Página dela')
    // Esc gives the current address back and closes the field.
    await win.keyboard.press('Escape')
    await until('field closed by Esc', async () => { const p = await pane(mine.tabId); return p && !p.addressField.editing && p.url === target })

    // ---- 3. an agent sees none of her tabs ----
    const gate = await inBrowser(T, () => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.gate())
    assert.ok(gate, 'the gate is open')
    const mineTarget = await inBrowser(T, async (_e, id) => ((await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.surface(id)!.debugger.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId, mine.tabId)
    const a = await rawCdp(gate.port, KEY_A)
    assert.deepEqual((await a.call('Target.getTargets')).result.targetInfos, [], 'the agent sees none of her tabs')
    assert.ok((await a.call('Target.attachToTarget', { targetId: mineTarget, flatten: true })).error, 'the agent cannot attach to her tab')
    assert.ok((await a.call('Target.getTargetInfo', { targetId: mineTarget })).error, 'the agent cannot read her tab\'s info')
    assert.ok((await a.call('Target.closeTarget', { targetId: mineTarget })).error, 'the agent cannot close her tab')
    const created = await a.call('Target.createTarget', { url: `${pages.base}/agent.html` })
    assert.ok(created.result?.targetId, `the agent opens its own tab (${JSON.stringify(created.error ?? '')})`)
    const seen = (await a.call('Target.getTargets')).result.targetInfos as { targetId: string }[]
    assert.deepEqual(seen.map(t => t.targetId), [created.result.targetId], 'its own tab is all it sees')
    a.close()
    assert.ok((await tabs()).some(t => t.tabId === mine.tabId), 'her tab is still open')

    // ---- 4. Ctrl+T in the Browser desk: another tab of hers; the pad lists hers first ----
    await win.keyboard.press('Control+T')
    const second = await until('Ctrl+T opened a tab of hers', async () => (await tabs()).find(t => t.ownerSlotId === 'person' && t.tabId !== mine.tabId))
    await until('its field in focus', async () => (await pane(second.tabId))?.addressField.editing)
    await win.keyboard.press('Escape')
    await win.evaluate(() => window.__tether.browserPadOpen())
    const pad = await until('the pad with her section', async () => { const p = await win.evaluate(() => window.__tether.browserPad()); return p && p.mine.length === 2 ? p : undefined })
    assert.equal(pad.sections[0], 'mine', '"Suas guias" first')
    assert.equal(pad.mineHead, 'Suas guias (2)')
    await win.evaluate(id => window.__tether.browserReveal(id), first.id)
    await sleep(300)
    await shot('pad')

    // ---- 5. her tab's × closes it, no dialog; the closed history keeps "Você" ----
    await win.click(`.tether-tab[data-slot="${first.id}"] .close`)
    await until('her tab gone from main', async () => !(await tabs()).some(t => t.tabId === mine.tabId))
    assert.deepEqual(await dialogs(), [], 'closed with no question')
    const closedOwner = await until('the closed history row', async () => win.evaluate(() => {
      const box = document.querySelector('[data-section="closed"] .br-pad-group')
      return box?.querySelector('.br-pad-dagent')?.textContent ?? ''
    }))
    assert.equal(closedOwner, 'Você')

    // ---- 6. the Regency's feed: a tab on ANOTHER desk, hers or an agent's, with no desk switch ----
    const here = await win.evaluate(() => window.__tether.activeDesk())
    await win.keyboard.press('Control+Shift+N')
    await win.waitForFunction(h => window.__tether.activeDesk() !== h, here)
    const other = await win.evaluate(() => window.__tether.activeDesk())
    await win.evaluate(h => window.__tether.switchDesk(h), here)
    await win.waitForFunction(h => window.__tether.activeDesk() === h, here)
    const panesOf = (deskId: string): Promise<string[]> => win.evaluate(d => window.__tether.desks().find(x => x.id === d)?.panes ?? [], deskId)
    const hersOn = await win.evaluate(async d => window.__tether.browserNewTabOn(undefined, d), other)
    assert.equal(hersOn.ok, true, `her tab on the other desk (${hersOn.why ?? ''})`)
    assert.equal((await tabs()).find(t => t.tabId === hersOn.tabId)?.ownerSlotId, 'person')
    assert.ok((await panesOf(other)).some(id => id.includes(hersOn.tabId!)), 'its pane is on the other desk')
    assert.equal(await win.evaluate(() => window.__tether.activeDesk()), here, 'the person was not moved')
    assert.equal((await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.control.view(id), hersOn.tabId!)).holder, 'user')
    // For an agent: born its own, the shield up.
    const sonda = await win.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, home)
    await until('Sonda runs', async () => (await win.evaluate(() => window.__tether.slots())).find(s => s.slotId === sonda)?.status === 'running', 20_000)
    const forAgent = await win.evaluate(async a => window.__tether.browserNewTabFor(a.s, a.d), { s: sonda, d: other })
    assert.equal(forAgent.ok, true, `the agent's tab (${forAgent.why ?? ''})`)
    assert.equal((await tabs()).find(t => t.tabId === forAgent.tabId)?.ownerSlotId, sonda, 'born the agent\'s')
    const agentView = await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.control.view(id), forAgent.tabId!)
    assert.equal(agentView.holder, 'agent')
    assert.equal(await inBrowser(T, (_e, id) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.shield(id), forAgent.tabId!), true, 'the shield is up')
    assert.ok((await panesOf(other)).some(id => id.includes(forAgent.tabId!)), 'its pane is on the other desk')
    assert.equal(await win.evaluate(() => window.__tether.activeDesk()), here, 'still where she was')
    // An agent that is not there: refused, nothing left open.
    const count = (await tabs()).length
    const ghost = await win.evaluate(async d => window.__tether.browserNewTabFor('deadbeef', d), other)
    assert.deepEqual([ghost.ok, ghost.why], [false, 'no-agent'])
    assert.equal((await tabs()).length, count, 'no tab left behind')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    pages.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
