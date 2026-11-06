// E2E of the Tether Bridge reaching an agent (F7 slice C3), with REAL Claude Code (haiku) in a PRIVATE tetherd (temp home,
// unique pipe, TETHER_BRIDGE_PORT on a free port, so the tetherd warms a REAL vendored bridge daemon of its own): a claude
// slot is launched with `--mcp-config <home>/mcp/tether-bridge.json` and the identity env on its command line, the agent
// calls `mcp__tether-bridge__list_browsers` and gets the daemon's answer (NO_BROWSER_CONNECTED: nothing is paired in this
// home, which is exactly what proves the wiring daemon → MCP shell → bridge daemon), and on /exit the tetherd posts the
// release of the slot's client to the bridge daemon (route /clients/:id/release of the vendored bundle: 200, "abas soltas").
// Kills go through test/kill.ts (pid + identity). The person's tetherd, %LOCALAPPDATA%\tether, port 47831 and
// ~/.atrium-bridge are never touched. Run: npm run test:e2e (or node --test test/e2e/web-bridge-agent.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV_CLIENT_ID, ENV_CLIENT_NAME } from '../../extensions/web-bridge/agents.ts'
import { bridgeHomeOf, mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { openSlot, pidAlive } from './daemon-driver.ts'
import { aliveProcs, type Proc, type Terminal } from './harness.ts'

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

test('a claude slot in a private tetherd gets the Tether Bridge MCP, calls list_browsers, and its exit releases the client', { timeout: 300_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-wb-agent-'))
  const home = join(base, 'home'); mkdirSync(home)
  const work = join(base, 'work'); mkdirSync(work)
  const pipe = `\\\\.\\pipe\\tether-wb-agent-${process.pid}`
  const port = await freePort()
  // Launched from inside a Claude session: every CLAUDE* variable goes (the child would skip its transcript otherwise).
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k)) env[k] = v
  env.TETHER_BRIDGE_PORT = String(port)
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
    const { slot } = await client.request({ t: 'create', kind: 'claude', cwd: work, name: 'Ponte', args: ['--model', 'haiku', '--allowedTools', 'mcp__tether-bridge__list_browsers'] })
    const slotId = slot!.slotId
    term = await openSlot(client, slotId, { log: logDir ? join(logDir, `web-bridge-agent-${Date.now()}.jsonl`) : undefined })
    trees.push(await term.tree())
    const self = (await term.tree()).find(p => p.pid === term!.pid)
    assert.ok(self?.cmd, `the claude process has a command line (tree: ${JSON.stringify(trees[0])})`)
    assert.ok(self!.cmd!.includes(`--mcp-config ${mcpPath}`) || self!.cmd!.includes(`--mcp-config "${mcpPath}"`), `--mcp-config <mcp file> on the command line: ${self!.cmd}`)
    assert.ok(/--session-id [0-9a-f-]{36}/.test(self!.cmd!), 'the tether\'s own args are still there')

    // 3. The agent calls the bridge tool. No browser is paired in this home: the daemon answers NO_BROWSER_CONNECTED (or an
    //    empty list), and that answer on screen, in the form asked for, is the whole chain working (agent → MCP shell →
    //    bridge daemon of this home).
    await term.type('Chame a ferramenta mcp__tether-bridge__list_browsers agora. Responda apenas uma linha, no formato navegadores=<quantidade devolvida>, ou erro=<código> se a ferramenta falhar.')
    await term.waitIdle({ timeout: 180_000 })
    const screen = term.screen()
    assert.match(screen, /navegadores\s*=\s*0|erro\s*=\s*NO_BROWSER_CONNECTED/i, `the bridge's answer reached the agent\n--- screen ---\n${screen}`)

    // 4. /exit: the slot exits and the tetherd posts the release of tether:<slotId>; the vendored daemon (A6 and later) has
    //    the route and answers 200, which the tetherd logs as "abas soltas no bridge".
    await term.exit()
    await waitUntil(() => /\[web-bridge\] release de tether:[0-9a-f]+: (abas soltas no bridge|o daemon do bridge respondeu \d+)/.test(tetherdLog()), 30_000, 'the release line in tetherd.log', tetherdLog)
    const log = tetherdLog()
    assert.ok(log.includes(`release de tether:${slotId}: abas soltas no bridge`), `the daemon answered the release with 200\n${log}`)
    assert.ok(!log.includes(apiKey), 'api key leaked into tetherd.log')
    assert.ok(!log.includes(ENV_CLIENT_ID) && !log.includes(ENV_CLIENT_NAME), 'the plan env is not dumped into the log')
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
    for (let i = 0; i < 10; i++) { try { rmSync(base, { recursive: true, force: true }); break } catch { await sleep(500) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the test')
  }
})
