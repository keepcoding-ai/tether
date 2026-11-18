// A page that registers a service worker must not take the app down (Tether Browser E7b), against the app built with
// TETHER_TEST_EXTENSIONS=1 (hidden window, private home and pipe, real tetherd, loopback only).
//   1. the agent holds a page session with auto-attach on (waiting for the debugger, as Playwright does) and even asks for
//      service workers in its filter; the page calls `navigator.serviceWorker.register('/sw.js')`: it is registered and active,
//      the main process and every child stay up, and the worker is announced to nobody. Before E7b this crashed the main
//      (0xC0000005): the worker was auto-attached and the gate's `Target.detachFromTarget` of its session took the app down;
//   2. the agent's session still answers, and the agent leaving with the worker alive is harmless;
//   3. the next tab still opens and loads.
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
import { daemonMain, launchHidden, pidAlive, rawCdp, root, sleep, inBrowser } from './browser-kit.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
type Tabs = { create(owner: string, url: string): Promise<{ tabId: string }>; eval(tabId: string, code: string): Promise<unknown>; gate(): Promise<{ port: number } | null> }
const KEY = 'swswSWSWswswSWSWswswSWSWswswSWSW1234'

const pipe = `\\\\.\\pipe\\tether-brsw-${process.pid}`
const page = (title: string, body: string): string => `<!doctype html><title>${title}</title><link rel="icon" href="data:,">${body}`

function serve(): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits.push(path)
    if (path === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', () => {})")
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(path === '/next' ? 'Next' : 'SW', `<h1 id="h">${path}</h1>`))
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
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

test('browser service worker: a page that registers one does not take the app down', { timeout: 180_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const site = await serve()
  const home = mkdtempSync(join(tmpdir(), 'tether-brsw-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  mkdirSync(join(home, 'browser', 'keys'), { recursive: true })
  writeFileSync(join(home, 'browser', 'keys', 'sw-owner.key'), KEY)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    const stderr: string[] = []
    app.process().stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')))
    let exited: string | undefined
    app.process().once('exit', (code, signal) => { exited = `exit code ${code} signal ${signal}` })
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, a?: unknown): Promise<R> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>
    // What the main process sees of its children while the page registers.
    await T.evaluate(({ app: a }) => {
      const g = globalThis as { __swGone?: string[] }
      g.__swGone = []
      a.on('render-process-gone', (_e, _wc, d) => g.__swGone!.push(`render ${d.reason} ${d.exitCode}`))
      a.on('child-process-gone', (_e, d) => g.__swGone!.push(`child ${d.type} ${d.reason} ${d.exitCode}`))
    })

    const tabId = (await B((t, a) => t.create('sw-owner', a), `${site.base}/sw.html`)).tabId
    const hostEval = (code: string): Promise<unknown> => B((t, a) => t.eval(a.tabId, a.code), { tabId, code })
    await until('page loaded', async () => (await hostEval(`!!document.getElementById('h')`)) === true)
    // The agent, as Playwright attaches: a page session with auto-attach on and waiting for the debugger. This is what used to
    // crash the main: the worker was auto-attached and the gate's detach of its session took the process down (0xC0000005).
    const gate = (await B(t => t.gate()))!
    const cdp = await rawCdp(gate.port, KEY)
    const bs = (await cdp.call('Target.attachToBrowserTarget')).result.sessionId as string
    const target = (await cdp.call('Target.getTargets', {}, bs)).result.targetInfos[0].targetId as string
    const sid = (await cdp.call('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId as string
    assert.ok(!(await cdp.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid)).error)
    // A client's own filter asking for service workers changes nothing: the gate's filter replaces it.
    assert.ok(!(await cdp.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker' }, {}] }, sid)).error)

    const outcome = await Promise.race([
      hostEval(`navigator.serviceWorker.register('/sw.js').then(r => 'registered:' + r.scope, e => 'refused:' + e.name + ':' + e.message)`),
      sleep(10_000).then(() => 'no answer'),
    ]).catch((e: Error) => `eval failed: ${e.message}`)
    await sleep(2000)
    const alive = async (): Promise<boolean> => !exited && (await Promise.race([T.evaluate(() => true), sleep(5000).then(() => false)]).catch(() => false))
    const up = await alive()
    const gone = up ? await T.evaluate(() => (globalThis as { __swGone?: string[] }).__swGone ?? []) : []
    console.log(`register: ${String(outcome)}; app up: ${up}; ${exited ?? ''}; gone: ${JSON.stringify(gone)}; sw fetched: ${site.hits.includes('/sw.js')}`)
    if (!up) console.log(`electron stderr:\n${stderr.join('').slice(-6000)}`)
    assert.equal(up, true, 'the app is still up after the page registered a service worker')
    assert.match(String(outcome), /^(registered|refused):/, `the page got an answer: ${String(outcome)}`)
    assert.deepEqual(gone, [], 'no process of the app went away')
    assert.equal(String(outcome).startsWith('registered:'), true, 'the worker is allowed: the hand-off clears it (app.browser-control)')
    await until('the worker is active', async () => (await hostEval(`navigator.serviceWorker.getRegistrations().then(r => r.length === 1 && !!r[0].active)`)) === true)
    const announced = cdp.events.filter(e => e.method === 'Target.attachedToTarget').map(e => e.params?.targetInfo?.type)
    assert.deepEqual(announced, [], 'the service worker was not announced to the agent')
    // The agent's session still works, and the agent leaving (its page session detached with the worker alive) is harmless.
    assert.equal((await cdp.call('Runtime.evaluate', { expression: '6*7', returnByValue: true }, sid)).result?.result?.value, 42)
    cdp.close()
    await cdp.closed
    await sleep(1000)
    assert.equal(await alive(), true, 'the app is still up after the agent left')

    // The next tab opens and loads.
    const next = (await B((t, a) => t.create('sw-owner', a), `${site.base}/next`)).tabId
    await until('next tab loaded', async () => (await B((t, a) => t.eval(a.tabId, `document.title`), { tabId: next })) === 'Next')
    assert.equal(await win.evaluate(() => window.__tether.connection()?.connected), true, 'the window is still connected')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    site.server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
