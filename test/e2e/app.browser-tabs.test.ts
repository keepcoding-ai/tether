// E2E of the tab registry and the `web` pane (Tether Browser E2), with the app built with TETHER_TEST_EXTENSIONS=1 (the
// browser's main side then hands its registry to the test as `globalThis.__browserTabs`, standing in for the gatekeeper).
// Hidden window, private home/pipe, real tetherd, CLAUDE* stripped; the pages come from a loopback server of the test.
//   1. two owners' tabs are born in the Browser desk without becoming active or switching desk, grouped by owner;
//   2. the frame shows the real title and address (from main);
//   3. a popup becomes a tab of the same owner; camera and notifications are refused; file: is refused (create and navigation);
//   4. relaunch: the tabs come back not loaded and load when shown; the address with a credential was not saved nor reloaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Pane = { id: string; tabId?: string; owner?: string; state?: string; title: string; url: string; stateText: string; group: string[]; front: boolean; place?: string }
type Hooks = { activeDesk(): string; desks(): { id: string }[]; connection(): { connected: boolean; pid?: number } | undefined; browserPanes(): Pane[]; browserReveal(id: string): void }
declare const window: { __tether: Hooks }
type Tabs = {
  create(owner: string, url: string): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[] }
  session(): Promise<{ persistentLogins: boolean; partition: string }>
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-brtabs-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const title = path === '/a' ? 'Página A' : path === '/b' ? 'Página B' : path === '/c' ? 'Página C' : 'Outra'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`)
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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  try { await page.waitForSelector('#conn.on', { timeout: 30_000 }) } catch (e) { await killElectron(app, root).catch(() => {}); throw e }
  return { app, page }
}

const panes = (page: Page): Promise<Pane[]> => page.evaluate(() => window.__tether.browserPanes())
const byTab = async (page: Page, tabId: string): Promise<Pane> => (await panes(page)).find(p => p.tabId === tabId)!
const create = (app: ElectronApplication, owner: string, url: string): Promise<string> =>
  app.evaluate(async (_e, a) => (await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.create(a.owner, a.url)).tabId, { owner, url })
const evalIn = (app: ElectronApplication, tabId: string, code: string): Promise<unknown> =>
  app.evaluate((_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(a.tabId, a.code), { tabId, code })
const mainTabs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list().map(t => ({ tabId: t.tabId, owner: t.ownerSlotId, url: t.url })))

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

test('browser tabs: born behind and grouped, real frame, popup, permissions, schemes, relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const server = await serve()
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = mkdtempSync(join(tmpdir(), 'tether-brtabs-'))
  // The tabs here are the agent's requests for 127.0.0.1 (the test's server): granted without the question (E4), which app.browser-net proves.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const [d1] = await page.evaluate(() => window.__tether.desks().map(d => d.id)) as [string]

    // Rule 19: the dev runtime (node_modules' electron.exe) has the cookie fuse off: the partition is in memory.
    const ses = await app.evaluate(async () => { const s = await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.session(); return { persistentLogins: s.persistentLogins, partition: s.partition } })
    assert.deepEqual(ses, { persistentLogins: false, partition: 'tether-browser' })

    // ---- 1. born behind, grouped by owner ----
    console.log('step 1')
    const a1 = await create(app, 'owner-a', `${base}/a`)
    const b1 = await create(app, 'owner-b', `${base}/b`)
    const a2 = await create(app, 'owner-a', `${base}/c`)
    await until('three panes', () => panes(page), v => v.length === 3)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), d1, 'no desk switch')
    const p = await panes(page)
    for (const x of p) assert.equal(x.place, 'Browser')
    assert.deepEqual((await byTab(page, a1)).group, [`web:${a1}`, `web:${a2}`, `web:${b1}`], 'owner-a\'s tabs together, owner-b after')
    assert.equal((await byTab(page, a1)).front, true, 'the first tab of an empty frame is its only tab')
    assert.equal((await byTab(page, a2)).front, false, 'a new tab enters behind')
    assert.equal((await byTab(page, b1)).front, false)

    // ---- 2. the frame: real title and address ----
    console.log('step 2')
    for (const [id, title, path] of [[a1, 'Página A', '/a'], [b1, 'Página B', '/b'], [a2, 'Página C', '/c']] as const) {
      const x = await until(`title of ${path}`, () => byTab(page, id), v => v.title === title)
      assert.equal(x.url, `${base}${path}`)
      assert.equal(x.state, 'live')
    }

    // ---- 3. popup, permissions, schemes ----
    console.log('step 3')
    await evalIn(app, b1, `window.open('${base}/b?pop=1'); 1`)
    const withPopup = await until('popup tab', () => mainTabs(app!), v => v.length === 4)
    const pop = withPopup.find(t => t.url.includes('pop=1'))!
    assert.equal(pop.owner, 'owner-b', 'the popup is a tab of the same owner')
    await until('popup pane', () => panes(page), v => v.length === 4)
    assert.deepEqual((await byTab(page, a1)).group, [`web:${a1}`, `web:${a2}`, `web:${b1}`, `web:${pop.tabId}`])
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), d1)

    assert.equal(await evalIn(app, a1, `navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', e => e.name)`), 'NotAllowedError')
    assert.equal(await evalIn(app, a1, `Notification.requestPermission()`), 'denied')
    assert.equal(await evalIn(app, a1, `navigator.permissions.query({ name: 'geolocation' }).then(s => s.state)`), 'denied')

    await assert.rejects(create(app, 'owner-a', 'file:///C:/Windows/win.ini'), /http/)
    await evalIn(app, a1, `location.href = 'file:///C:/Windows/win.ini'; 1`).catch(() => {})
    await sleep(500)
    assert.equal(await evalIn(app, a1, 'location.href'), `${base}/a`, 'file: navigation refused')
    assert.equal((await mainTabs(app)).length, 4)

    // A tab whose address carries a credential.
    const cred = await create(app, 'owner-a', `${base}/a?token=SEGREDO123`)
    await until('cred pane', () => panes(page), v => v.length === 5)
    await sleep(1500) // the layout's debounced save
    const file = readFileSync(join(home, 'layout.json'), 'utf8')
    assert.ok(!file.includes('SEGREDO123'), 'the credential address is not written')
    assert.ok(file.includes(`web:${a1}`) && file.includes(`${base}/a`))

    // ---- 4. relaunch ----
    console.log('step 4')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    const back = await until('panes back', () => panes(page), v => v.length === 5)
    assert.deepEqual(await mainTabs(app), [], 'nothing loads on its own')
    for (const x of back) {
      if (x.tabId === cred) { assert.equal(x.state, 'no-address'); assert.equal(x.url, '') }
      else { assert.equal(x.state, 'not-loaded', x.tabId); assert.equal(x.stateText, 'Não carregada desde que o tether reabriu') }
    }
    assert.equal((await byTab(page, a1)).title, 'Página A', 'the saved title shows while not loaded')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), d1)

    await page.evaluate(id => window.__tether.browserReveal(id), `web:${a1}`)
    const loaded = await until('a1 loads when shown', () => byTab(page, a1), v => v.state === 'live' && v.title === 'Página A')
    assert.equal(loaded.url, `${base}/a`)
    assert.deepEqual((await mainTabs(app)).map(t => [t.tabId, t.owner]), [[a1, 'owner-a']], 'same id and owner; only the shown one')

    await page.evaluate(id => window.__tether.browserReveal(id), `web:${cred}`)
    await sleep(800)
    assert.equal((await byTab(page, cred)).state, 'no-address', 'the credential tab is not reloaded')
    assert.equal((await mainTabs(app)).length, 1)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    server.close()
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
