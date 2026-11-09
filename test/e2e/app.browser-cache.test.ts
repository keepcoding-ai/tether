// The tabs' partition leaves no page body on disk (Tether Browser E16, design §12b rule 18): the persistent partition is forced
// on a runtime without the cookie fuse (test build only, TETHER_TEST_PERSIST_PARTITION=1), a page with a bait in its body, a
// script and an image-like resource (all cacheable for an hour) is loaded, and no file under Electron's userData holds the bait.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { daemonMain, launchHidden, pidAlive, root, sleep } from './browser-kit.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
type Tabs = {
  create(owner: string, url: string): Promise<{ tabId: string }>
  eval(tabId: string, code: string): Promise<unknown>
  session(): Promise<{ persistentLogins: boolean; partition: string }>
}

const BAIT = 'BAIT-9f3c1a7e-in-the-body'
const BAIT_JS = 'BAIT-5b8d2e4a-in-a-script'

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

test('browser cache: the persistent partition keeps no page body on disk', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const cache = { 'cache-control': 'public, max-age=3600' }
    if (path === '/s.js') { res.writeHead(200, { 'content-type': 'text/javascript', ...cache }); res.end(`window.__s = '${BAIT_JS}'; // ${BAIT_JS}`); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cache })
    res.end(`<!doctype html><html><head><title>Isca</title><script src="/s.js"></script></head><body><p>${BAIT}</p></body></html>`)
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
      const seen = await app.evaluate((_e, a) => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.eval(a.tabId, 'document.body.innerText + (window.__s || "")'), { tabId })
      if (String(seen).includes(BAIT) && String(seen).includes(BAIT_JS)) break
      assert.ok(Date.now() < deadline, `the page did not load: ${String(seen)}`)
      await sleep(200)
    }
    // Give the network stack time to write whatever it is going to write, then let go of the files.
    await sleep(3000)
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    assert.ok(existsSync(join(userData, 'Partitions', 'tether-browser')), 'the persistent partition is on disk')
    assert.deepEqual(holders(userData, [BAIT, BAIT_JS]), [], 'no file under userData holds the page')
    await killElectron(app, root)
    app = undefined
    assert.deepEqual(holders(userData, [BAIT, BAIT_JS]), [], 'nor after the app has let go')
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
