// E2E of "Entregar a um agente…" (navegador da pessoa, N4): the app built with TETHER_TEST_EXTENSIONS=1, hidden window, private
// home and pipe, real tetherd, a stand-in soul agent ("Sonda") with its key to the gate. The person:
//   1. opens a tab of her own on a page with a field, after another page (so the tab has a history), and types in the field
//      without sending; the agent's connection (discovering targets) sees none of it;
//   2. gives the tab to Sonda from the tab's menu: the agent picker (the core's list), then the one-line question;
//   3. the agent gets a NEW tab at the same address, in the place of hers, and hers closes (out of the closed history): the field
//      is empty, there is no history (no way back to her page), the page does not slow down out of view, the tab is the agent's
//      (owner, control `agent`, the shield on);
//   4. the agent got `Target.targetCreated`, finds the tab in getTargets, reads the empty field and navigates the tab;
//   5. the pill carries Sonda's name, and she takes it back with "Assumir" (the tab stays Sonda's: no new way back).
// Screenshots go to BROWSER_GIVE_SHOTS (default test/e2e/artifacts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { FAKE_SOUL_CMD as FAKE_SOUL, daemonMain, inBrowser, launchHidden, pidAlive, rawCdp, root, sleep } from './browser-kit.ts'

type Pane = { id: string; tabId?: string; owner?: string; control: string; controlText: string; tone: string; actions: { pin: string; label: string }[] }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    slots(): SlotState[]
    openSlot(id: string): Promise<void>
    browserPanes(): Pane[]
    browserNewTab(url?: string): Promise<string | undefined>
    browserReveal(id: string): void
  }
  tether: { request(r: unknown): Promise<{ t: string; slot?: SlotState }> }
}
type Tabs = {
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[]; go(id: string, raw: string): Promise<string> }
  eval(tabId: string, code: string): Promise<unknown>
  type(tabId: string, text: string): void
  shield(tabId: string): boolean | undefined
  throttling(tabId: string): boolean | undefined
  control: { view(id: string): { why?: string; holder: string; paused: boolean } }
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brgive-${process.pid}`
const KEY = 'giveGIVEgiveGIVEgiveGIVEgiveGIVE1234'
const TYPED = 'codigo-nao-enviado-7731'
const shotsDir = process.env.BROWSER_GIVE_SHOTS ?? join(root, 'test', 'e2e', 'artifacts')

function servePages(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    res.writeHead(path === '/first.html' || path === '/form.html' || path === '/agent.html' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    if (path === '/first.html') return res.end('<!doctype html><title>Primeira</title><link rel="icon" href="data:,"><h1>FIRST</h1>')
    if (path === '/form.html') return res.end('<!doctype html><title>Formulário dela</title><link rel="icon" href="data:,"><h1 style="padding:24px">FORM</h1><form><input id="f" name="f" style="font-size:24px;margin:24px"></form>')
    if (path === '/agent.html') return res.end('<!doctype html><title>Página do agente</title><link rel="icon" href="data:,"><h1>AGENT-PAGE</h1>')
    return res.end('not found')
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

test('browser: the person gives her tab to an agent; it reloads clean first, the agent sees and drives it, she takes it back', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shotsDir, { recursive: true })
  const pages = await servePages()
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-brgive-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let agentWs: Awaited<ReturnType<typeof rawCdp>> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R, arg?: unknown): Promise<Awaited<R>> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`), arg) as Promise<Awaited<R>>
    const pageEval = (tabId: string, code: string): Promise<unknown> => B((t, a) => t.eval(a.id, a.code), { id: tabId, code })
    const pane = async (tabId: string): Promise<Pane | undefined> => (await win.evaluate(() => window.__tether.browserPanes())).find(p => p.tabId === tabId)
    const owner = async (tabId: string): Promise<string | undefined> => (await B(t => t.registry.list())).find(x => x.tabId === tabId)?.ownerSlotId
    const shot = async (name: string): Promise<void> => { await sleep(300); await win.screenshot({ path: join(shotsDir, `browser-person-give-${name}.png`) }) }

    // The agent: a stand-in soul with its key to the gate.
    const sonda = await win.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, home)
    await until('Sonda runs', async () => (await win.evaluate(() => window.__tether.slots())).find(s => s.slotId === sonda)?.status === 'running', 20_000)
    writeFileSync(join(keysDir, `${sonda}.key`), KEY)
    const gate = (await B(t => t.gate()))!
    assert.ok(gate, 'the gate is open')
    agentWs = await rawCdp(gate.port, KEY)
    assert.ok(!(await agentWs.call('Target.setDiscoverTargets', { discover: true })).error)

    // ---- 1. her tab: a first page, then the form; she types and does not send ----
    const mine = (await win.evaluate(u => window.__tether.browserNewTab(u), `${pages.base}/first.html`))!
    assert.ok(mine, 'her tab opened')
    await until('the first page', async () => (await pageEval(mine, 'document.body && document.body.innerText')) === 'FIRST', 20_000)
    assert.equal(await B((t, a) => t.registry.go(a.id, a.url), { id: mine, url: `${pages.base}/form.html` }), 'ok')
    await until('the form', async () => (await pageEval(mine, '!!document.getElementById("f") && document.readyState === "complete"')) === true, 20_000)
    assert.ok(Number(await pageEval(mine, 'history.length')) >= 2, 'the tab has pages behind')
    await pageEval(mine, 'document.getElementById("f").focus(); 1')
    await B((t, a) => t.type(a.id, a.text), { id: mine, text: TYPED })
    await until('her typing is in the field', async () => (await pageEval(mine, 'document.getElementById("f").value')) === TYPED)
    assert.equal(await B((t, id) => t.throttling(id), mine), true, 'her tab slows down out of view')
    assert.deepEqual((await agentWs.call('Target.getTargets')).result.targetInfos, [], 'the agent sees none of her tabs')
    const paneId = (await pane(mine))!.id
    await win.evaluate(id => window.__tether.browserReveal(id), paneId)

    // ---- 2. the tab's menu → "Entregar a um agente…" → the picker → the question ----
    await win.locator(`.tether-tab[data-slot="${paneId}"]`).click({ button: 'right' })
    await win.waitForSelector('#ctx-menu li')
    const menu = await win.locator('#ctx-menu li[role=menuitem]').allTextContents()
    assert.ok(menu[0]?.includes('Entregar a um agente…'), `first row of her tab's menu: ${menu.join(' | ')}`)
    await win.locator('#ctx-menu li', { hasText: 'Entregar a um agente…' }).click()
    const picker = win.locator('dialog.picker')
    await picker.waitFor()
    const row = picker.locator('li.pk-item', { hasText: 'Sonda' })
    await row.waitFor()
    assert.equal(await picker.locator('li.pk-item').count(), 1, 'the one live agent')
    await shot('picker')
    await row.click()
    const dlg = win.locator('dialog[data-dialog="browser.give-tab"]')
    await dlg.waitFor()
    assert.equal((await dlg.locator('h2').first().textContent())?.trim(), 'Entregar esta guia a Sonda?')
    assert.ok((await dlg.textContent())?.includes('A página recarrega e as contas em que você entrou ficam com ele.'))
    await shot('confirm')
    assert.equal(await owner(mine), 'person', 'nothing changed before her answer')
    await dlg.locator('button.choice[data-choice="give"]').click()

    // ---- 3. a new tab of Sonda's at the same address, in the place of hers; hers closed ----
    const theirs = (await until('Sonda\'s new tab', async () => (await B(t => t.registry.list())).find(x => x.ownerSlotId === sonda), 20_000)).tabId
    await until('her tab closed', async () => (await owner(mine)) === undefined && !(await pane(mine)))
    assert.notEqual(theirs, mine, 'a new tab: nothing of hers per tab exists in it')
    const theirPane = await until('the new tab\'s pane', () => pane(theirs))
    assert.equal(theirPane.id !== paneId, true)
    assert.equal(await pageEval(theirs, 'document.getElementById("f").value'), '', 'what she typed and did not send is not there')
    assert.equal(await pageEval(theirs, 'history.length'), 1, 'her pages behind are not there')
    const view = await B((t, id) => t.control.view(id), theirs)
    assert.equal(view.holder, 'agent')
    assert.equal(view.why, undefined)
    assert.equal(await B((t, id) => t.shield(id), theirs), true, 'the shield is on: the agent has it')
    assert.equal(await B((t, id) => t.throttling(id), theirs), false, 'an agent tab never slows down')
    await sleep(500)
    const closedFile = join(home, 'browser', 'closed-tabs.json')
    const closed = existsSync(closedFile) ? JSON.parse(readFileSync(closedFile, 'utf8')) as unknown : []
    assert.ok(!JSON.stringify(closed).includes(mine), 'her given tab is not in the closed history (it was given, not closed)')

    // ---- 4. the agent was told, sees the tab, reads it and drives it ----
    // The new tab is announced when it is created (on its blank page), and loads the address next.
    const created = await until('targetCreated for the agent', async () => agentWs!.events.find(e => e.method === 'Target.targetCreated'))
    const targetId = created.params.targetInfo.targetId as string
    const seen = await until('the tab at her address in the agent\'s getTargets', async () => {
      const list = (await agentWs!.call('Target.getTargets')).result.targetInfos as { targetId: string; url: string }[]
      return list.length === 1 && list[0]!.url.endsWith('/form.html') ? list : undefined
    })
    assert.deepEqual(seen.map(t => t.targetId), [targetId], 'the tab is in the agent\'s getTargets')
    const sid = (await agentWs.call('Target.attachToTarget', { targetId, flatten: true })).result.sessionId as string
    const read = await agentWs.call('Runtime.evaluate', { expression: 'document.getElementById("f").value', returnByValue: true }, sid)
    assert.equal(read.result?.result?.value, '', 'the agent reads an empty field')
    assert.ok(!JSON.stringify(agentWs.events).includes(TYPED), 'her typing is in no event the agent got')
    assert.ok(!(await agentWs.call('Page.navigate', { url: `${pages.base}/agent.html` }, sid)).error)
    await until('the agent navigated the tab', async () => (await pageEval(theirs, 'document.body && document.body.innerText')) === 'AGENT-PAGE', 20_000)

    // ---- 5. the pill says Sonda; "Assumir" takes it back, the tab stays Sonda's ----
    const given = await until('the pill carries Sonda', async () => { const p = await pane(theirs); return p && p.owner === sonda && p.controlText.startsWith('Sonda') ? p : undefined })
    assert.equal(given.control, 'agent')
    await win.mouse.move(5, 5)
    await shot('agent')
    await win.locator(`.br-web[data-tab="${theirs}"] .br-web-actions .ab-act[data-label="Assumir"]`).click()
    await until('taken back', async () => (await B((t, id) => t.control.view(id), theirs)).holder === 'user')
    assert.equal((await B((t, id) => t.control.view(id), theirs)).why, 'taken')
    assert.equal(await owner(theirs), sonda, 'the tab stays Sonda\'s')
    const taken = await until('the pill: with her', async () => { const p = await pane(theirs); return p && p.control === 'user' ? p : undefined })
    assert.match(taken.controlText, /^Com você/)
    await shot('taken')
  } finally {
    agentWs?.close()
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    pages.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
