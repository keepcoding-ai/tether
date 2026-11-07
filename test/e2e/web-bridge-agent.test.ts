// E2E of the Tether Bridge reaching an agent (F7 slice C3), with REAL Claude Code (haiku) in a PRIVATE tetherd (temp home,
// unique pipe, TETHER_BRIDGE_PORT on a free port, so the tetherd warms a REAL vendored bridge daemon of its own). The bridge
// is the feature `bridge` (on by default): a claude slot is launched with `--mcp-config <home>/share/bridge/claude.mcp.json`
// (the composed folder's mcps/tether-bridge/mcp.json merged; no --plugin-dir: the bridge brings no skill), the agent calls
// `mcp__tether-bridge__list_browsers` (the tool name unchanged: its transcript names exactly that tool) and gets
// the daemon's answer (NO_BROWSER_CONNECTED: nothing is paired in this home, which is exactly what proves the wiring
// daemon → MCP shell → bridge daemon), and on /exit the tetherd posts the release of the slot's client to the bridge daemon
// (route /clients/:id/release of the vendored bundle: 200, "abas soltas"). A second slot, of a profile with
// `features.bridge = false`, launches with neither --plugin-dir nor --mcp-config. A soul slot (a stub CLI, TETHER_SOUL_CMD:
// only its command line counts) gets `-S <home>/share/bridge/soul` and `--mcp-config <home>/share/bridge/soul.mcp.json`.
// Kills go through test/kill.ts (pid + identity). The person's tetherd, %LOCALAPPDATA%\tether, port 47831 and
// ~/.atrium-bridge are never touched. Run: npm run test:e2e (or node --test test/e2e/web-bridge-agent.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV_CLIENT_ID, ENV_CLIENT_NAME } from '../../extensions/web-bridge/agents.ts'
import { bridgeHomeOf, mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { findTranscript } from '../../src/agents/claude.ts'
import { CLAUDE_MCP_FILE } from '../../src/agents/claude-plugin.ts'
import { cleanShares, shareRootOf } from '../../src/daemon/share.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { openSlot, pidAlive } from './daemon-driver.ts'
import { aliveProcs, processTree, type Proc, type Terminal } from './harness.ts'

const root = resolve(import.meta.dirname, '..', '..')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const logDir = process.env.E2E_LOG_DIR
if (logDir) mkdirSync(logDir, { recursive: true })

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
  })
}
async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string, diag?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}${diag ? `\n${diag()}` : ''}`)
    await sleep(250)
  }
}
const health = (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)

const TOOL = 'mcp__tether-bridge__list_browsers'

test('a claude slot in a private tetherd gets the Tether Bridge MCP, calls list_browsers, and its exit releases the client', { timeout: 300_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-wb-agent-'))
  const home = join(base, 'home'); mkdirSync(home)
  const work = join(base, 'work'); mkdirSync(work)
  const pipe = `\\\\.\\pipe\\tether-wb-agent-${process.pid}`
  const port = await freePort()
  // Launched from inside a Claude session: every CLAUDE* variable goes (the child would skip its transcript otherwise).
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_BRIDGE_PORT = String(port)
  // The soul slot of step 6 runs a stub script (no model, no server; the args after the script are its own): only its
  // command line matters.
  const stub = join(base, 'soul-stub.mjs')
  writeFileSync(stub, 'setInterval(() => {}, 1000)\n')
  env.TETHER_SOUL_CMD = `"${process.execPath}" "${stub}"`
  const owned: Owned[] = []
  const trees: Proc[][] = []
  let client: DaemonClient | undefined
  let tetherd: Owned | undefined
  let term: Terminal | undefined
  const tetherdLog = (): string => (existsSync(join(home, 'tetherd.log')) ? readFileSync(join(home, 'tetherd.log'), 'utf8') : '')
  try {
    client = await DaemonClient.connect({ home, pipe, client: 'test', env, startTimeoutMs: 30_000 })
    tetherd = await claim(client.hello.pid, { cmdIncludes: daemonMain, what: 'tetherd' })

    // 1. C2's ground: the MCP file and the real bridge daemon on the test port (its pid claimed before any assertion).
    const mcpPath = mcpConfigPathOf(home)
    const bridgeHome = bridgeHomeOf(home)
    await waitUntil(() => existsSync(mcpPath), 30_000, mcpPath, tetherdLog)
    await waitUntil(() => health(port), 30_000, `/health on port ${port}`, tetherdLog)
    await waitUntil(() => existsSync(join(bridgeHome, 'daemon.pid')), 10_000, 'daemon.pid')
    const bridgePid = Number(readFileSync(join(bridgeHome, 'daemon.pid'), 'utf8').trim())
    owned.push(await claim(bridgePid, { cmdIncludes: 'atrium-bridge.mjs', what: 'bridge daemon' }))
    const apiKey = readFileSync(join(bridgeHome, 'api.key'), 'utf8').trim()

    // 2. A real Claude (haiku) in a slot. The one tool it needs is pre-allowed, so no permission dialog stands between the
    //    prompt and the bridge's answer.
    const { slot } = await client.request({ t: 'create', kind: 'claude', cwd: work, name: 'Ponte', args: ['--model', 'haiku', '--allowedTools', TOOL] })
    const slotId = slot!.slotId
    term = await openSlot(client, slotId, { log: logDir ? join(logDir, `web-bridge-agent-${Date.now()}.jsonl`) : undefined })
    trees.push(await term.tree())
    const self = (await term.tree()).find(p => p.pid === term!.pid)
    assert.ok(self?.cmd, `the claude process has a command line (tree: ${JSON.stringify(trees[0])})`)
    const composed = join(shareRootOf(home), 'bridge')
    const claudeMcp = join(composed, CLAUDE_MCP_FILE)
    assert.ok(self!.cmd!.includes(`--mcp-config ${claudeMcp}`) || self!.cmd!.includes(`--mcp-config "${claudeMcp}"`), `--mcp-config <composed>/claude.mcp.json on the command line: ${self!.cmd}`)
    assert.ok(!self!.cmd!.includes('--plugin-dir'), 'no skill in the bridge feature: no plugin')
    const sessionId = /--session-id ([0-9a-f-]{36})/.exec(self!.cmd!)?.[1]
    assert.ok(sessionId, 'the tether\'s own args are still there')
    assert.equal(readFileSync(join(composed, 'mcps', 'tether-bridge', 'mcp.json'), 'utf8'), readFileSync(mcpPath, 'utf8'), 'the composed folder carries the feature\'s MCP')
    const merged = JSON.parse(readFileSync(claudeMcp, 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(merged.mcpServers), ['tether-bridge'])

    // 3. The agent calls the bridge tool. No browser is paired in this home: the daemon answers NO_BROWSER_CONNECTED (or an
    //    empty list), and that answer on screen, in the form asked for, is the whole chain working (agent → MCP shell →
    //    bridge daemon of this home).
    await term.type(`Chame a ferramenta ${TOOL} agora. Responda apenas uma linha, no formato navegadores=<quantidade devolvida>, ou erro=<código> se a ferramenta falhar.`)
    await term.waitIdle({ timeout: 180_000 })
    const screen = term.screen()
    assert.match(screen, /navegadores\s*=\s*0|erro\s*=\s*NO_BROWSER_CONNECTED/i, `the bridge's answer reached the agent\n--- screen ---\n${screen}`)
    // The tool the agent called, by its name in the transcript: unchanged, `mcp__tether-bridge__list_browsers`.
    const transcript = findTranscript({ sessionId: sessionId!, cwd: work })
    assert.ok(transcript, `the session's transcript (${sessionId})`)
    const called = [...readFileSync(transcript!, 'utf8').matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]+)"/g)].map(m => m[1])
    assert.ok(called.includes(TOOL), `the tool called is ${TOOL} (called: ${called.join(', ') || 'none'})`)
    assert.ok(!called.some(n => n!.startsWith('mcp__plugin_')), 'no plugin-namespaced tool')

    // 4. /exit: the slot exits and the tetherd posts the release of tether:<slotId>; the vendored daemon (A6 and later) has
    //    the route and answers 200, which the tetherd logs as "abas soltas no bridge".
    await term.exit()
    await waitUntil(() => /\[web-bridge\] release de tether:[0-9a-f]+: (abas soltas no bridge|o daemon do bridge respondeu \d+)/.test(tetherdLog()), 30_000, 'the release line in tetherd.log', tetherdLog)
    const log = tetherdLog()
    assert.ok(log.includes(`release de tether:${slotId}: abas soltas no bridge`), `the daemon answered the release with 200\n${log}`)
    assert.ok(!log.includes(apiKey), 'api key leaked into tetherd.log')
    assert.ok(!log.includes(ENV_CLIENT_ID) && !log.includes(ENV_CLIENT_NAME), 'the plan env is not dumped into the log')
    term.dispose(); term = undefined

    // 5. A profile with the feature off: the same claude launches with no plugin and no MCP config.
    const { profile } = await client.request({ t: 'profile-save', profile: { name: 'Claude sem ponte', agent: 'claude', args: [], features: { bridge: false } } })
    const off = await client.request({ t: 'create', kind: 'claude', cwd: work, name: 'Sem ponte', profileId: profile!.id, args: ['--model', 'haiku'] })
    term = await openSlot(client, off.slot!.slotId)
    trees.push(await term.tree())
    const offCmd = (await term.tree()).find(p => p.pid === term!.pid)?.cmd ?? ''
    assert.ok(offCmd.includes('--session-id'), `the claude command line: ${offCmd}`)
    assert.ok(!offCmd.includes('--plugin-dir') && !offCmd.includes('--mcp-config'), `features.bridge=false: no plugin, no MCP (${offCmd})`)
    await term.kill(); term.dispose(); term = undefined

    // 6. A soul slot (default profile, the feature inherited on): the soul's view of the same composed folder.
    //    The stub draws no TUI: started straight, its command line read from the process tree.
    const soul = await client.request({ t: 'create', kind: 'soul', cwd: work, name: 'Alma', start: true })
    const soulPid = soul.slot!.pid!
    assert.ok(soulPid, 'the stub soul has a pid')
    const soulTree = await processTree(soulPid)
    trees.push(soulTree)
    const soulCmd = soulTree.find(p => p.pid === soulPid)?.cmd ?? ''
    const has = (flag: string, value: string): boolean => soulCmd.includes(`${flag} ${value}`) || soulCmd.includes(`${flag} "${value}"`)
    assert.ok(has('-S', join(composed, 'soul')), `-S <composed>/soul on the soul's command line: ${soulCmd}`)
    assert.ok(has('--mcp-config', join(composed, 'soul.mcp.json')), `--mcp-config <composed>/soul.mcp.json: ${soulCmd}`)
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(join(composed, 'soul.mcp.json'), 'utf8')) as { mcpServers: object }).mcpServers), ['tether-bridge'])
    await client.request({ t: 'stop', slotId: soul.slot!.slotId })
  } finally {
    if (term) { try { if (term.alive) await term.kill() } catch { /* already gone */ } term.dispose() }
    for (const p of owned) await killOwned(p)
    if (client && tetherd) {
      try { await client.request({ t: 'shutdown' }) } catch { /* already gone */ }
      const deadline = Date.now() + 20_000
      while (pidAlive(tetherd.pid) && Date.now() < deadline) await sleep(100)
      if (pidAlive(tetherd.pid)) await killOwned(tetherd, { tree: true })
      client.close()
    }
    const left = await aliveProcs(trees.flat())
    cleanShares(home) // the composed folders' links go first, one by one, never followed
    for (let i = 0; i < 10; i++) { try { rmSync(base, { recursive: true, force: true }); break } catch { await sleep(500) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the test')
  }
})
