// E2E of the browser handed to the agents (Tether Browser E8), in a PRIVATE tetherd (temp home, unique pipe, no window): a
// stand-in for the soul (TETHER_SOUL_CMD) records the command line it was launched with.
//   - `extensions.browser.serveToAgents` on (and `evaluate` on): the launch carries the bridge's --mcp-config and the
//     browser's, the key exists while the agent lives, its text is in no command line or log, the MCP file holds paths only,
//     and key and MCP file are gone when the agent exits;
//   - off (the default): no --mcp-config of the browser, no key, no file, no `browser` folder at all.
// Run: node --test test/e2e/browser-agents.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyFileOf, mcpFileOf, MCP_SERVER_NAME } from '../../extensions/browser/agents.ts'
import { mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, what: string, diag?: () => string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}${diag ? `\n${diag()}` : ''}`)
    await sleep(100)
  }
}

/** One tetherd, one soul slot launched with the stand-in; returns what the agent saw and what was on disk while it lived and after. */
async function run(settings: object | undefined) {
  const base = mkdtempSync(join(tmpdir(), 'tether-bragent-'))
  const home = join(base, 'home'); mkdirSync(home)
  const work = join(base, 'work'); mkdirSync(work)
  const argvFile = join(base, 'argv.json')
  const stub = join(base, 'soul-stub.mjs')
  writeFileSync(stub, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  if (settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  const previous = process.env.TETHER_SOUL_CMD
  process.env.TETHER_SOUL_CMD = `"${process.execPath}" "${stub}"`
  // The bridge's file is planted: the web-bridge setup rewrites it with the same content shape (or leaves it when its vendor is not whole), and either way the launch carries it.
  const bridgeFile = mcpConfigPathOf(home)
  mkdirSync(join(home, 'mcp'), { recursive: true })
  writeFileSync(bridgeFile, JSON.stringify({ mcpServers: { 'tether-bridge': { command: 'node', args: ['x'], env: {} } } }))
  const suite = new SuiteDaemon(home, `\\\\.\\pipe\\tether-bragent-${process.pid}-${Date.now()}`)
  let agent: Owned | undefined
  try {
    await suite.connect()
    const { slot } = await suite.client.request({ t: 'create', kind: 'soul', cwd: work, args: [] })
    const slotId = slot!.slotId
    await suite.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    const started = await suite.client.request({ t: 'start', slotId })
    agent = await claim(started.slot!.pid!, { cmdIncludes: stub, what: 'soul stub' })
    await waitFor(() => existsSync(argvFile), 20_000, 'the stub to record its command line', () => suite.log())
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
    const flags = argv.flatMap((a, i) => (a === '--mcp-config' ? [argv[i + 1]!] : []))
    const during = {
      key: existsSync(keyFileOf(home, slotId)) ? readFileSync(keyFileOf(home, slotId), 'utf8').trim() : undefined,
      mcp: existsSync(mcpFileOf(home, slotId)) ? readFileSync(mcpFileOf(home, slotId), 'utf8') : undefined,
      browserDir: existsSync(join(home, 'browser')),
    }
    await suite.client.request({ t: 'stop', slotId })
    await waitFor(() => !pidAlive(agent!.pid), 20_000, 'the agent to exit', () => suite.log())
    await sleep(500) // the exit event reaches the extensions right after the process is gone
    const after = { key: existsSync(keyFileOf(home, slotId)), mcp: existsSync(mcpFileOf(home, slotId)) }
    return { home, slotId, argv, flags, bridgeFile, during, after, log: suite.log() }
  } finally {
    if (agent) await killOwned(agent)
    try { await suite.shutdown() } catch (e) { console.error(String(e)) }
    if (previous === undefined) delete process.env.TETHER_SOUL_CMD; else process.env.TETHER_SOUL_CMD = previous
    for (let i = 0; i < 10; i++) { try { rmSync(base, { recursive: true, force: true }); break } catch { await sleep(500) } }
  }
}

test('serveToAgents on: the launch carries the bridge and the browser, the key lives with the agent and goes with it', { timeout: 180_000 }, async () => {
  const r = await run({ extensions: { browser: { serveToAgents: true, evaluate: true } } })
  assert.deepEqual(r.flags, [r.bridgeFile, mcpFileOf(r.home, r.slotId)], 'two --mcp-config: the bridge, then the browser')
  assert.ok(r.during.key && /^[A-Za-z0-9_-]{32}$/.test(r.during.key), 'a 192-bit base64url key exists while the agent lives')
  const server = JSON.parse(r.during.mcp!).mcpServers[MCP_SERVER_NAME]
  assert.equal(server.args.at(-1), '--allow-evaluate')
  assert.ok(server.args.includes('--adopt-endpoint-file') && server.args.includes('--adopt-key-file'))
  assert.ok(!r.during.mcp!.includes(r.during.key), 'the MCP file holds paths, not the key')
  assert.ok(!r.argv.join(' ').includes(r.during.key), 'the key is not on the command line')
  assert.ok(!r.log.includes(r.during.key), 'the key is not in tetherd.log')
  assert.equal(r.after.key, false, 'the key is gone when the agent exits')
  assert.equal(r.after.mcp, false, 'the MCP file is gone when the agent exits')
})

test('serveToAgents off (the default): no browser flag, no key, no file, no folder', { timeout: 180_000 }, async () => {
  const r = await run(undefined)
  assert.deepEqual(r.flags, [r.bridgeFile], 'only the bridge')
  assert.equal(r.during.key, undefined)
  assert.equal(r.during.mcp, undefined)
  assert.equal(r.during.browserDir, false, 'nothing of the browser on disk (the gate is Electron main\'s, not running here)')
})
