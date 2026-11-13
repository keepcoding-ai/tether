// E2E of the browser's crash isolation (tether-browser-isolado), app built with TETHER_TEST_EXTENSIONS=1.
// Hidden window, private home/pipe, real tetherd, CLAUDE* stripped; the pages come from a loopback server of the test.
//   1. a tab whose renderer dies shows the crash state; the other tab and the tether stay fine;
//   2. "Reabrir" brings the tab back (same id, new surface) and its debugger answers again;
//   3. a tab whose page hangs (input not answered) shows the crash state too, and "Reabrir" brings it back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Pane = { id: string; tabId?: string; state?: string; title: string }
type Hooks = { connection(): { connected: boolean; pid?: number } | undefined; browserPanes(): Pane[]; browserReveal(id: string): void }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-brcrash-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>P${path}</title></head><body><h1>${path}</h1></body></html>`)
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  try { await page.waitForSelector('#conn.on', { timeout: 30_000 }) } catch (e) { await killElectron(app, root).catch(() => {}); throw e }
  return { app, page }
}

/** Runs `body` (the source of a function of the test registry `t` and the argument `a`) in Electron main. */
const inMain = (app: ElectronApplication, body: string, a: Record<string, unknown> = {}): Promise<unknown> =>
  app.evaluate((_e, x) => (new Function('t', 'a', `return (async () => { ${x.body} })()`))((globalThis as Record<string, unknown>).__browserTabs, x.a), { body, a })
const panes = (page: Page): Promise<Pane[]> => page.evaluate(() => window.__tether.browserPanes())
const stateOf = async (page: Page, tabId: string): Promise<string | undefined> => (await panes(page)).find(p => p.tabId === tabId)?.state
const titleOf = (app: ElectronApplication, id: string): Promise<unknown> => inMain(app, 'return t.eval(a.id, "document.title")', { id })

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

async function reopen(page: Page, tabId: string): Promise<void> {
  const pane = (await panes(page)).find(p => p.tabId === tabId)!
  await page.evaluate(id => window.__tether.browserReveal(id), pane.id)
  await page.click(`.br-web[data-tab="${tabId}"] [data-role="crash"] button`)
}

test('browser crash isolation: renderer gone and hung tabs show the crash state; Reabrir brings them back', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const server = await serve()
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = mkdtempSync(join(tmpdir(), 'tether-brcrash-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const create = async (url: string): Promise<string> => (await inMain(app!, 'return (await t.create("owner-a", a.url)).tabId', { url })) as string
    const a = await create(`${base}/a`)
    const b = await create(`${base}/b`)
    await until('both live', async () => [await stateOf(page, a), await stateOf(page, b)], v => v[0] === 'live' && v[1] === 'live')
    await until('both loaded', async () => [await titleOf(app!, a), await titleOf(app!, b)], v => v[0] === 'P/a' && v[1] === 'P/b')

    // ---- 1. renderer gone: only that tab ----
    console.log('step 1')
    const surfaceBefore = await inMain(app, 'return t.registry.get(a.id).surfaceId', { id: a })
    await inMain(app, 't.crashRenderer(a.id)', { id: a })
    await until('a crashed', () => stateOf(page, a), v => v === 'crashed')
    assert.equal(await stateOf(page, b), 'live', 'the other tab is untouched')
    assert.equal(await titleOf(app, b), 'P/b', 'the other tab answers')
    assert.equal(await page.evaluate(() => 1 + 1), 2, 'the interface answers')

    // ---- 2. Reabrir ----
    console.log('step 2')
    await reopen(page, a)
    await until('a live again', () => stateOf(page, a), v => v === 'live')
    const after = await inMain(app, 'return t.registry.get(a.id)', { id: a }) as { surfaceId: string; crashed?: string } | undefined
    assert.ok(after && !after.crashed && after.surfaceId !== surfaceBefore, 'same tab, new surface')
    await until('a reloaded', () => titleOf(app!, a), v => v === 'P/a')
    assert.equal(await inMain(app, 'await t.allowOnce(a.id, a.url); return t.cdpNavigate(a.id, a.url)', { id: a, url: `${base}/a2` }), '', 'its debugger answers')
    await until('a navigated', () => titleOf(app!, a), v => v === 'P/a2')

    // ---- 3. hung page ----
    console.log('step 3')
    await inMain(app, 't.hangRenderer(a.id, 120000)', { id: b })
    await sleep(500)
    // Chromium calls a renderer unresponsive when it leaves input unanswered: the test pokes it until it says so.
    await until('b hung', async () => {
      await inMain(app!, 'const wc = t.registry.webContents(a.id); if (wc && !wc.isDestroyed()) { wc.sendInputEvent({ type: "mouseDown", x: 10, y: 10, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: 10, y: 10, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "keyDown", keyCode: "a" }) }', { id: b })
      return stateOf(page, b)
    }, v => v === 'crashed', 90_000)
    assert.equal(await stateOf(page, a), 'live', 'the other tab is untouched')
    await reopen(page, b)
    await until('b live again', () => stateOf(page, b), v => v === 'live', 20_000)
    await until('b reloaded', () => titleOf(app!, b), v => v === 'P/b')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d).catch(() => {})
    server.close()
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
