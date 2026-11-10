// The tabs' partition leaves no page body on disk (Tether Browser E16, design §12b rule 18): the persistent partition is forced
// on a runtime without the cookie fuse (test build only, TETHER_TEST_PERSIST_PARTITION=1), a page with a bait in its body, a
// script and an image-like resource (all cacheable for an hour) is loaded, and no file under Electron's userData holds the bait.
// Review N-M2: the page also stores baits in IndexedDB, localStorage and CacheStorage and sets a cookie; after the app quits
// (a real quit, which clears the page storages) no file of the partition holds a storage bait, and the cookie is still there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, killOwned, type Owned } from '../kill.ts'
import { claimElectron, killElectron } from './electron.ts'
import { daemonMain, launchHidden, pidAlive, root, sleep } from './browser-kit.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
type Tabs = {
  create(owner: string, url: string): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  session(): Promise<{ persistentLogins: boolean; partition: string }>
}

const BAIT = 'BAIT-9f3c1a7e-in-the-body'
const BAIT_JS = 'BAIT-5b8d2e4a-in-a-script'
const BAIT_IDB = 'BAIT-1d6a0c3f-in-indexeddb'
const BAIT_LS = 'BAIT-7e2b9d14-in-localstorage'
const BAIT_CACHE = 'BAIT-4c8f3a20-in-cachestorage'
const COOKIE = 'COOKIE-BAIT-a5e19f07'
/** A bait as JavaScript that builds it (so the full text is never in the page source, nor in a code cache of it). */
const split = (b: string): string => "'" + b.slice(0, 10) + "' + '" + b.slice(10) + "'"
/** What the page stores for itself: IndexedDB, localStorage, CacheStorage, and a persistent cookie; window.__stored when done. */
const STORE = `
  document.cookie = 'tb=' + ${split(COOKIE)} + '; max-age=86400; path=/'
  localStorage.setItem('k', ${split(BAIT_LS)})
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open('isca', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('s')
    r.onerror = () => rej(r.error)
    r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put(${split(BAIT_IDB)}, 'k'); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) }
  })
  const cache = caches.open('isca').then(c => c.put('/isca', new Response(${split(BAIT_CACHE)})))
  Promise.all([idb, cache]).then(() => { window.__stored = 'ok' }, e => { window.__stored = 'error: ' + e })
`

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try { if (statSync(p).isDirectory()) out.push(...filesUnder(p)); else out.push(p) } catch { /* locked or gone */ }
  }
  return out
}
const holders = (dir: string, needles: string[]): string[] => filesUnder(dir).filter(f => {
  let data: Buffer
  try { data = readFileSync(f) } catch { return false }
  return needles.some(n => data.includes(Buffer.from(n, 'utf8')) || data.includes(Buffer.from(n, 'utf16le')))
})

test('browser cache: the persistent partition keeps no page body on disk, nor what pages stored once the app quits', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const cache = { 'cache-control': 'public, max-age=3600' }
    if (path === '/s.js') { res.writeHead(200, { 'content-type': 'text/javascript', ...cache }); res.end(`window.__s = '${BAIT_JS}'; // ${BAIT_JS}`); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cache })
    res.end(`<!doctype html><html><head><title>Isca</title><script src="/s.js"></script></head><body><p>${BAIT}</p><script>${STORE}</script></body></html>`)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = mkdtempSync(join(tmpdir(), 'tether-brcache-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const daemons: Owned[] = []
  let app: Awaited<ReturnType<typeof launchHidden>>['app'] | undefined
  process.env.TETHER_TEST_PERSIST_PARTITION = '1'
  try {
    const launched = await launchHidden(home, `\\\\.\\pipe\\tether-brcache-${process.pid}`)
    app = launched.app
    daemons.push(await claim((await launched.page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const ses = await app.evaluate(async () => { const s = await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.session(); return { persistentLogins: s.persistentLogins, partition: s.partition } })
    assert.deepEqual(ses, { persistentLogins: true, partition: 'persist:tether-browser' })

    const tabId = await app.evaluate(async (_e, url) => (await (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.create('owner-a', url)).tabId, `${base}/p`)
    const deadline = Date.now() + 15_000
    for (;;) {
      const seen = await app.evaluate((_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(a.tabId, 'document.body.innerText + (window.__s || "") + " " + (window.__stored || "")'), { tabId })
      assert.ok(!String(seen).includes('error:'), String(seen))
      if (String(seen).includes(BAIT) && String(seen).includes(BAIT_JS) && String(seen).endsWith(' ok')) break
      assert.ok(Date.now() < deadline, `the page did not load: ${String(seen)}`)
      await sleep(200)
    }
    // Give the network stack time to write whatever it is going to write, then let go of the files.
    await sleep(3000)
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    assert.ok(existsSync(join(userData, 'Partitions', 'tether-browser')), 'the persistent partition is on disk')
    assert.deepEqual(holders(userData, [BAIT, BAIT_JS]), [], 'no file under userData holds the page')
    const partitionDir = join(userData, 'Partitions', 'tether-browser')
    console.log(`storage baits on disk while running: ${holders(partitionDir, [BAIT_IDB, BAIT_LS, BAIT_CACHE]).length} file(s)`)

    // N-M2: a real quit (it clears the page storages before it lets go); the main and its helpers leave.
    const main = await claimElectron(app, root)
    const launcher = app.process()
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 50) }).catch(() => {})
    for (let i = 0; i < 60 && pidAlive(main.pid); i++) await sleep(250)
    assert.equal(pidAlive(main.pid), false, 'the app quit')
    for (let i = 0; i < 40 && launcher.exitCode === null; i++) await sleep(250)
    await sleep(4000) // the helpers (network service) close their files
    app = undefined
    assert.deepEqual(holders(userData, [BAIT, BAIT_JS]), [], 'nor after the app has let go')
    assert.deepEqual(holders(partitionDir, [BAIT_IDB, BAIT_LS, BAIT_CACHE]), [], 'nothing a page stored is left in the partition')
    assert.ok(holders(partitionDir, [COOKIE]).some(f => /Cookies$/.test(f)), 'the cookie is still there (the login survives)')
  } catch (e) {
    try { console.error(readFileSync(join(home, 'tether-app.log'), 'utf8').slice(-3000)); console.error(readdirSync(home).join(',')); console.error(readFileSync(join(home, 'tetherd.log'), 'utf8').slice(-2000)) } catch { /* no log */ }
    throw e
  } finally {
    delete process.env.TETHER_TEST_PERSIST_PARTITION
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    server.close()
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
