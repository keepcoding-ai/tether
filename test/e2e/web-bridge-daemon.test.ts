// E2E of the web-bridge daemon host (F7 slice C2): a PRIVATE tetherd (temp home, unique pipe, TETHER_BRIDGE_PORT on a free
// port) activates the web-bridge extension at startup and, with no action of anyone: the bridge home gets config.json
// (at that port, brand, the vendored build's id pinned, the package's capabilities seeded) and api.key, NO extension
// folder (that is the install flow's, C1), the feature folder's <home>/web-bridge/share/mcps/tether-bridge/mcp.json exists
// with paths and env only (stdio), the REAL vendored
// bridge daemon answers /health on the port, and no secret (pairing token, api key) appears in tetherd.log or in the MCP file.
// Every kill goes through test/kill.ts (pid + identity): the bridge daemon by its daemon.pid only if its command line names
// the vendored bundle; the tetherd by `shutdown`. The person's tetherd, %LOCALAPPDATA%\tether and ~/.atrium-bridge are never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import { bridgeHomeOf, extensionDirOf, mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { claim, killOwned, type Owned } from '../kill.ts'

const root = resolve(import.meta.dirname, '..', '..')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const vendorDir = join(root, 'extensions', 'web-bridge', 'vendor')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
  })
}
async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(250)
  }
}
const health = (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)

test('a private tetherd activates web-bridge: installation, MCP file and the bridge daemon answering, no secret in the log', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-wb-daemon-'))
  const pipe = `\\\\.\\pipe\\tether-wb-daemon-${process.pid}`
  const port = await freePort()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_BRIDGE_PORT = String(port)
  const owned: Owned[] = []
  let client: DaemonClient | undefined
  let tetherd: Owned | undefined
  try {
    client = await DaemonClient.connect({ home, pipe, client: 'test', env, startTimeoutMs: 30_000 })
    tetherd = await claim(client.hello.pid, { cmdIncludes: daemonMain, what: 'tetherd' })

    // 1. The daemon host did its work (often before the hello handshake even completes): the MCP file, then the daemon
    //    answering on the test port. Its daemon.pid is claimed FIRST, so a failing assertion below never leaks the process.
    const mcpPath = mcpConfigPathOf(home)
    const bridgeHome = bridgeHomeOf(home)
    await waitUntil(() => existsSync(mcpPath), 30_000, `${mcpPath}`)
    await waitUntil(() => health(port), 30_000, `/health on port ${port}`)
    await waitUntil(() => existsSync(join(bridgeHome, 'daemon.pid')), 10_000, 'daemon.pid')
    const bridgePid = Number(readFileSync(join(bridgeHome, 'daemon.pid'), 'utf8').trim())
    assert.ok(bridgePid && pidAlive(bridgePid), 'daemon.pid names a live process')
    owned.push(await claim(bridgePid, { cmdIncludes: 'atrium-bridge.mjs', what: 'bridge daemon' }))

    const info = JSON.parse(readFileSync(join(vendorDir, 'build-info.json'), 'utf8')) as { extensionId: string; brand: { capabilities: Record<string, unknown> } }
    const config = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { port: number; pairingToken: string; extensionIds: string[]; brand?: { name: string; hostId?: string }; capabilities?: Record<string, unknown> }
    assert.equal(config.port, port)
    assert.deepEqual(config.extensionIds, [info.extensionId])
    assert.equal(config.brand?.name, 'Tether')
    assert.equal(config.brand?.hostId, 'studio.codr.tether')
    assert.deepEqual(config.capabilities, info.brand.capabilities, 'the package defaults (brand/brand.json) seeded')
    assert.equal(config.capabilities?.evaluate, 'own-tabs')
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()
    assert.ok(apiKey.length >= 16, 'api.key present')
    assert.ok(!existsSync(extensionDirOf(home)), 'the extension folder is born in the install flow, never at startup')

    // 2. The MCP file: command, bundle, env; nothing else.
    const mcpText = readFileSync(mcpPath, 'utf8')
    assert.deepEqual(JSON.parse(mcpText), {
      mcpServers: { 'tether-bridge': { type: 'stdio', command: 'node', args: [join(vendorDir, 'atrium-bridge.mjs'), 'mcp'], env: { ATRIUM_BRIDGE_HOME: bridgeHome, ATRIUM_BRIDGE_PORT: String(port), ATRIUM_BRIDGE_SERVER_NAME: 'tether-bridge' } } },
    })

    // 3. The real daemon, started by tetherd, is the one on the port: the api.key of this home opens it.
    const browsers = await fetch(`http://127.0.0.1:${port}/browsers`, { headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(browsers.status, 200, 'the api.key of the home opens the daemon of the home')

    // 4. The log tells the story, without a secret in it.
    const log = readFileSync(join(home, 'tetherd.log'), 'utf8')
    assert.ok(log.includes('[web-bridge] instalação do bridge criada'), log)
    assert.ok(log.includes(`[web-bridge] capabilities semeadas do pacote: ${Object.keys(info.brand.capabilities).join(', ')}`), log)
    assert.ok(log.includes(`${join('mcps', 'tether-bridge', 'mcp.json')} gravado`), log)
    assert.ok(log.includes('[web-bridge] daemon do bridge iniciado'), log)
    for (const text of [log, mcpText]) {
      assert.ok(!text.includes(config.pairingToken), 'pairing token leaked')
      assert.ok(!text.includes(apiKey), 'api key leaked')
    }
  } finally {
    for (const p of owned) await killOwned(p)
    if (client && tetherd) {
      try { await client.request({ t: 'shutdown' }) } catch { /* already gone */ }
      const deadline = Date.now() + 20_000
      while (pidAlive(tetherd.pid) && Date.now() < deadline) await sleep(100)
      if (pidAlive(tetherd.pid)) await killOwned(tetherd, { tree: true })
      client.close()
    }
    for (let i = 0; i < 10; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(500) } }
  }
})
