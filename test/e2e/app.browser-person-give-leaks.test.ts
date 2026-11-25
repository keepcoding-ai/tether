// Temper (security gate, navegador da pessoa N4): what of her tab survives "Entregar a um agente…" and reaches the agent. The
// clean give reloads the page and drops the history; this probes what a reload keeps on the same tab:
//   - sessionStorage (per tab: the agents' own tabs never share it), window.name, history.state of the current entry;
//   - a page that is the result of a POST she sent (a login, a payment): does the reload send the POST again?
// It also checks that a key file named after the person (`person.key`) does not open the gate.
// Each finding is printed (TEMPER:) and asserted as the safe behaviour, so a red here is a finding, not a broken test.
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
import { FAKE_SOUL_CMD as FAKE_SOUL, daemonMain, inBrowser, launchHidden, pidAlive, rawCdp, root, sleep } from './browser-kit.ts'

type Pane = { id: string; tabId?: string }
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
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[] }
  eval(tabId: string, code: string): Promise<unknown>
  gate(): Promise<{ port: number } | null>
}

const pipe = `\\\\.\\pipe\\tether-brleak-${process.pid}`
const KEY = 'leakLEAKleakLEAKleakLEAKleakLEAK5678'
const PERSON_KEY = 'persPERSpersPERSpersPERSpersPERS9999'
const SS = 'ss-rascunho-dela-4411'
const WN = 'wn-dela-5522'
const HS = 'hs-dela-6633'
const POSTED = 'senha-postada-7744'

function servePages(): Promise<{ server: Server; base: string; posts: string[] }> {
  const posts: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (req.method === 'POST' && path === '/done') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        posts.push(body)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Feito</title><link rel="icon" href="data:,"><h1>DONE</h1>')
      })
      return
    }
    if (path === '/form.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><title>Login</title><link rel="icon" href="data:,"><form method="post" action="/done"><input name="pw" id="pw"></form>')
    }
    res.writeHead(404); res.end('not found')
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://localhost:${(server.address() as AddressInfo).port}`, posts })))
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

test('temper: her tab given to an agent keeps nothing of hers per tab, and no POST is sent again', {
  timeout: 300_000,
}, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const pages = await servePages()
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-brleak-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let agentWs: Awaited<ReturnType<typeof rawCdp>> | undefined
  const findings: string[] = []
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R, arg?: unknown): Promise<Awaited<R>> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`), arg) as Promise<Awaited<R>>
    const pageEval = (tabId: string, code: string): Promise<unknown> => B((t, a) => t.eval(a.id, a.code), { id: tabId, code })
    const owner = async (tabId: string): Promise<string | undefined> => (await B(t => t.registry.list())).find(x => x.tabId === tabId)?.ownerSlotId

    const sonda = await win.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, home)
    await until('Sonda runs', async () => (await win.evaluate(() => window.__tether.slots())).find(s => s.slotId === sonda)?.status === 'running', 20_000)
    writeFileSync(join(keysDir, `${sonda}.key`), KEY)
    writeFileSync(join(keysDir, 'person.key'), PERSON_KEY)
    const gate = (await B(t => t.gate()))!
    assert.ok(gate, 'the gate is open')

    // ---- a key named after the person does not open the gate ----
    await sleep(1500)
    let personConn: Awaited<ReturnType<typeof rawCdp>> | undefined
    try { personConn = await rawCdp(gate.port, PERSON_KEY) } catch { personConn = undefined }
    let personTargets: unknown = 'refused'
    if (personConn) {
      const r = await personConn.call('Target.getTargets', {}, undefined, 3000)
      personTargets = r.error ? `error: ${r.error.message}` : r.result.targetInfos
      personConn.close()
    }
    console.log(`TEMPER: person.key connection -> ${JSON.stringify(personTargets)}`)
    if (personTargets !== 'refused') findings.push(`a person.key connection was served (${JSON.stringify(personTargets)})`)

    agentWs = await rawCdp(gate.port, KEY)
    assert.ok(!(await agentWs.call('Target.setDiscoverTargets', { discover: true })).error)

    // ---- her tab: a login form posted, then per-tab state on the result page ----
    const mine = (await win.evaluate(u => window.__tether.browserNewTab(u), `${pages.base}/form.html`))!
    await until('the form', async () => (await pageEval(mine, '!!document.getElementById("pw") && document.readyState === "complete"')) === true, 20_000)
    if (personConn) {
      // the person key connected: does it see her tab now?
      const again = await rawCdp(gate.port, PERSON_KEY).catch(() => undefined)
      const r = again ? await again.call('Target.getTargets', {}, undefined, 3000) : undefined
      again?.close()
      console.log(`TEMPER: person.key sees with her tab open -> ${JSON.stringify(r?.result?.targetInfos ?? r?.error ?? 'refused')}`)
      if (r?.result?.targetInfos?.length) findings.push('person.key sees her tabs')
    }
    await pageEval(mine, `document.getElementById("pw").value = ${JSON.stringify(POSTED)}; document.forms[0].submit(); 1`)
    await until('the POST result', async () => (await pageEval(mine, 'document.body && document.body.innerText')) === 'DONE', 20_000)
    assert.equal(pages.posts.length, 1)
    await pageEval(mine, `sessionStorage.setItem("draft", ${JSON.stringify(SS)}); window.name = ${JSON.stringify(WN)}; history.replaceState({ d: ${JSON.stringify(HS)} }, ""); 1`)

    // ---- give it to Sonda through the tab's menu ----
    const paneId = (await win.evaluate(() => window.__tether.browserPanes())).find(p => p.tabId === mine)!.id
    await win.evaluate(id => window.__tether.browserReveal(id), paneId)
    await win.locator(`.tether-tab[data-slot="${paneId}"]`).click({ button: 'right' })
    await win.waitForSelector('#ctx-menu li')
    await win.locator('#ctx-menu li', { hasText: 'Entregar a um agente…' }).click()
    const picker = win.locator('dialog.picker')
    await picker.waitFor()
    await picker.locator('li.pk-item', { hasText: 'Sonda' }).click()
    const dlg = win.locator('dialog[data-dialog="browser.give-tab"]')
    await dlg.waitFor()
    const t0 = Date.now()
    await dlg.locator('button.choice[data-choice="give"]').click()
    // The give hands Sonda a new tab at the same address and closes hers.
    await until('Sonda has the tab and hers is closed', async () => (await owner(mine)) === undefined && (await B(t => t.registry.list())).some(x => x.ownerSlotId === sonda), 30_000)
    console.log(`TEMPER: give took ${Date.now() - t0} ms`)

    // ---- what the agent reads ----
    const created = await until('targetCreated', async () => agentWs!.events.find(e => e.method === 'Target.targetCreated'))
    const sid = (await agentWs.call('Target.attachToTarget', { targetId: created.params.targetInfo.targetId, flatten: true })).result.sessionId as string
    const read = await agentWs.call('Runtime.evaluate', {
      expression: 'JSON.stringify({ ss: sessionStorage.getItem("draft"), wn: window.name, hs: history.state, url: location.href, body: document.body && document.body.innerText, len: history.length })',
      returnByValue: true,
    }, sid)
    const seen = JSON.parse(String(read.result?.result?.value ?? '{}'))
    console.log(`TEMPER: agent reads ${JSON.stringify(seen)}; POSTs at the server: ${pages.posts.length} ${JSON.stringify(pages.posts)}`)
    if (seen.ss === SS) findings.push('sessionStorage survives the give')
    if (seen.wn === WN) findings.push('window.name survives the give')
    if (JSON.stringify(seen.hs ?? null).includes(HS)) findings.push('history.state survives the give')
    if (pages.posts.length > 1) findings.push(`the reload sent her POST again (${pages.posts.length} POSTs)`)
    if (String(seen.body ?? '').includes('DONE') && pages.posts.length > 1) findings.push('the agent sees the answer to her re-sent POST')
    console.log(`TEMPER findings: ${JSON.stringify(findings)}`)
    assert.deepEqual(findings, [], 'nothing of hers per tab reaches the agent')
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
