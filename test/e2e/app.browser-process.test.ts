// E2E of the browser process (tether-browser-isolado): the tabs live in a process of their own, started by the app.
// Hidden window, private home/pipe, real tetherd, CLAUDE* stripped; the pages come from a loopback server of the test; the
// agent is a key in <home>/browser/keys and a raw CDP client on the gatekeeper.
//   1. the browser process is not the app's; killing it (taskkill /F) leaves the app alive and answering, every tab in the crash
//      state, the agent's connection closed and the endpoint gone;
//   2. "Reabrir" starts it again and brings the tabs back; the gatekeeper has a new endpoint and the agent's CDP works again;
//   3. a second crash within 5 minutes with the same tab on screen: that tab comes back paused (explained), the others reopen;
//      its own Reabrir loads it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { daemonMain, launchHidden, pidAlive, rawCdp, root, sleep } from './browser-kit.ts'

type Pane = { id: string; tabId?: string; state?: string }
type Hooks = { connection(): { connected: boolean; pid?: number } | undefined; browserPanes(): Pane[]; browserReveal(id: string): void }
declare const window: { __tether: Hooks }

const pipe = `\\\\.\\pipe\\tether-brproc-${process.pid}`
const KEY = 'pppPPPPqqqqQQQQrrrrRRRRssssSSSStttt'

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>P${path}</title></head><body><h1>${path}</h1></body></html>`)
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

const run = (app: ElectronApplication, body: string, a: Record<string, unknown> = {}): Promise<unknown> =>
  app.evaluate((_e, x) => ((globalThis as Record<string, unknown>).__browserRun as (src: string, a: unknown) => Promise<unknown>)(`async (t, a) => { ${x.body} }`, x.a), { body, a })
const childPid = (app: ElectronApplication): Promise<number | undefined> =>
  app.evaluate(() => ((globalThis as Record<string, unknown>).__browserProcess as { pid(): number | undefined } | undefined)?.pid())
const panes = (page: Page): Promise<Pane[]> => page.evaluate(() => window.__tether.browserPanes())
const stateOf = async (page: Page, tabId: string): Promise<string | undefined> => (await panes(page)).find(p => p.tabId === tabId)?.state
const crashText = (page: Page, tabId: string): Promise<string> => page.evaluate(id => document.querySelector(`.br-web[data-tab="${id}"] .br-web-crash-text`)?.textContent ?? '', tabId)
const titleOf = (app: ElectronApplication, id: string): Promise<unknown> => run(app, 'return t.eval(a.id, "document.title")', { id })

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let v = await fn()
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timeout: ${what}: ${JSON.stringify(v)}`)
    await sleep(150)
    v = await fn()
  }
  return v
}

async function reveal(page: Page, tabId: string): Promise<void> {
  const pane = (await panes(page)).find(p => p.tabId === tabId)!
  await page.evaluate(id => window.__tether.browserReveal(id), pane.id)
}
async function reopen(page: Page, tabId: string): Promise<void> {
  await reveal(page, tabId)
  await page.click(`.br-web[data-tab="${tabId}"] [data-role="crash"] button`)
}
function killBrowser(pid: number): void {
  // The browser process is this test's: the app it launched started it (its pid read from that app).
  const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8' })
  assert.equal(r.status, 0, `taskkill: ${r.stderr}`)
}

test('browser process: killed, the app stays up and the tabs crash; Reabrir restores them; two crashes pause the tab', { timeout: 400_000, skip: process.platform !== 'win32' }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const server = await serve()
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = mkdtempSync(join(tmpdir(), 'tether-brproc-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  mkdirSync(join(home, 'browser', 'keys'), { recursive: true })
  writeFileSync(join(home, 'browser', 'keys', 'agent-a.key'), KEY)
  const endpointFile = join(home, 'browser', 'endpoint.json')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launchHidden(home, pipe))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const mainPid = await app.evaluate(() => process.pid)
    await until('browser process up', () => childPid(app!), v => typeof v === 'number')
    const pid1 = (await childPid(app))!
    assert.notEqual(pid1, mainPid, 'the browser is a process of its own')
    const create = async (url: string): Promise<string> => (await run(app!, 'return (await t.create("agent-a", a.url)).tabId', { url })) as string
    const a = await create(`${base}/a`)
    const b = await create(`${base}/b`)
    await until('both loaded', async () => [await titleOf(app!, a), await titleOf(app!, b)], v => v[0] === 'P/a' && v[1] === 'P/b')
    await reveal(page, a)
    const port1 = JSON.parse(readFileSync(endpointFile, 'utf8')).port as number
    const agent = await rawCdp(port1, KEY)
    assert.equal((await agent.call('Target.getTargets')).result.targetInfos.length, 2, 'the agent sees its two tabs')

    // ---- 1. kill the browser process ----
    console.log('step 1')
    killBrowser(pid1)
    await until('tabs crashed', async () => [await stateOf(page, a), await stateOf(page, b)], v => v[0] === 'crashed' && v[1] === 'crashed')
    assert.equal(await crashText(page, a), 'O navegador parou')
    assert.ok(pidAlive(mainPid), 'the app is alive')
    assert.equal(await page.evaluate(() => 2 + 2), 4, 'the interface answers')
    assert.equal(await app.evaluate(() => process.pid), mainPid, 'the app main answers')
    await Promise.race([agent.closed, sleep(10_000).then(() => { throw new Error('the agent connection did not close') })])
    await until('endpoint gone', async () => existsSync(endpointFile), v => !v)

    // ---- 2. Reabrir ----
    console.log('step 2')
    await reopen(page, a)
    await until('tabs back', async () => [await stateOf(page, a), await stateOf(page, b)], v => v[0] === 'live' && v[1] === 'live', 40_000)
    const pid2 = (await childPid(app))!
    assert.ok(pid2 && pid2 !== pid1, 'a new browser process')
    await until('pages loaded', async () => [await titleOf(app!, a), await titleOf(app!, b)], v => v[0] === 'P/a' && v[1] === 'P/b')
    await until('new endpoint', async () => existsSync(endpointFile), v => v)
    const port2 = JSON.parse(readFileSync(endpointFile, 'utf8')).port as number
    const agent2 = await rawCdp(port2, KEY)
    const targets = (await agent2.call('Target.getTargets')).result.targetInfos as { targetId: string }[]
    assert.equal(targets.length, 2, 'the agent sees its tabs again')
    const session = (await agent2.call('Target.attachToTarget', { targetId: targets[0]!.targetId, flatten: true })).result.sessionId as string
    assert.match((await agent2.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session)).result.result.value, /^P\/[ab]$/, 'agent CDP works')
    agent2.close()

    // ---- 3. second crash with the same tab on screen ----
    console.log('step 3')
    await reveal(page, a)
    await sleep(500)
    killBrowser(pid2)
    await until('tabs crashed again', async () => [await stateOf(page, a), await stateOf(page, b)], v => v[0] === 'crashed' && v[1] === 'crashed')
    assert.match(await crashText(page, a), /^Pausada/, 'the tab on screen in both crashes is paused')
    await reveal(page, b)
    assert.equal(await crashText(page, b), 'O navegador parou', 'the tab behind it was not on screen: it reopens with the rest')
    await reopen(page, b)
    await until('b back', () => stateOf(page, b), v => v === 'live', 40_000)
    await sleep(1000)
    assert.equal(await stateOf(page, a), 'crashed', 'the paused tab stays down')
    assert.equal(await run(app, 'return t.registry.get(a.id) ? "open" : "none"', { id: a }), 'none', 'not loaded')
    await reopen(page, a)
    await until('a back', () => stateOf(page, a), v => v === 'live', 20_000)
    await until('a loaded', () => titleOf(app!, a), v => v === 'P/a')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d).catch(() => {})
    server.close()
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
