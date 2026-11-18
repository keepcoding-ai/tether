// F7 C3: the Tether Bridge reaches the agents through the launch middleware of the web-bridge daemon extension, with the
// committed daemon index (claude, soul, web-bridge) activated in a host of its own: every AI agent plan gains
// `--mcp-config <TETHER_HOME>/mcp/tether-bridge.json` (through AgentContribution.mcp.inject) and its identity in the env;
// a shell plan, an agent without `mcp`, `serveToAgents: false` and a missing MCP file leave the plan untouched (the same
// object). The release on exit is a POST to the bridge daemon that tolerates every answer and never carries the key in a log.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { BridgeIdentities, CLIENT_ID_PATTERN, CLIENT_NAME_MAX, cleanName, clientIdOf, clientNameOf, createLaunchMiddleware, ENV_CLIENT_ID, ENV_CLIENT_NAME, releaseClient } from '../../extensions/web-bridge/agents.ts'
import { serveToAgents } from '../../extensions/web-bridge/daemon.ts'
import { mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { MCP_CONFIG_FLAG, withMcpConfigFlag } from '../../src/agents/mcp.ts'
import { AgentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

const meta = (agent: SlotMeta['agent'], extra: Partial<SlotMeta> = {}): SlotMeta => ({ v: 1, slotId: 'a1b2c3d4', agent, cwd: 'D:\\work\\proj', args: [], createdAt: '2026-11-06T00:00:00.000Z', ...extra })
const plan = (): LaunchPlan => ({ command: 'agent.exe', args: ['--settings', 'x.json', '--model', 'haiku'], cwd: 'D:\\work\\proj', env: { PATH: 'p', TETHER_SLOT_ID: 'a1b2c3d4' } })

describe('web-bridge launch middleware (F7 C3)', () => {
  let home: string
  let host: DaemonExtensionHost
  const logs: string[] = []
  const mcpFile = (): string => mcpConfigPathOf(home)

  before(() => {
    home = tempHome()
    // Only the bridge and the agents it serves: another extension's launch middleware (skills' --plugin-dir) is not this test's.
    host = new DaemonExtensionHost({ home, log: m => logs.push(m), agents: new AgentRegistry(), extensions: daemonIndex.filter(e => ['claude', 'soul', 'web-bridge'].includes(e.manifest.id)) })
    host.activate()
    assert.deepEqual(host.activated, ['claude', 'soul', 'web-bridge'])
    mkdirSync(join(home, 'mcp'), { recursive: true })
    writeFileSync(mcpFile(), '{"mcpServers":{}}\n')
  })
  after(async () => { host.dispose(); await removeHome(home) })

  test('claude and soul plans gain --mcp-config LAST and the identity env; the rest of the plan is kept', async () => {
    for (const agent of ['claude', 'soul'] as const) {
      const input = plan()
      const out = await host.transformPlan(input, meta(agent, { name: 'Pesquisa' }))
      assert.notEqual(out, input, `${agent}: rewritten`)
      assert.deepEqual(out.args, [...input.args, MCP_CONFIG_FLAG, mcpFile()], `${agent}: flag appended after the slot's own args`)
      assert.equal(out.env[ENV_CLIENT_ID], 'tether:a1b2c3d4')
      assert.equal(out.env[ENV_CLIENT_NAME], 'Pesquisa', `${agent}: the tab's text, nothing else`)
      assert.equal(out.env.PATH, 'p'); assert.equal(out.env.TETHER_SLOT_ID, 'a1b2c3d4')
      assert.equal(out.command, input.command); assert.equal(out.cwd, input.cwd)
      assert.deepEqual(input, plan(), `${agent}: the plan given is never mutated`)
    }
  })

  test('a shell plan is the same object', async () => {
    const input = plan()
    assert.equal(await host.transformPlan(input, meta('shell')), input)
  })

  test('serveToAgents: false (settings.json extensions.web-bridge) leaves the plan untouched; back on, rewritten again', async () => {
    const settings = join(home, 'settings.json')
    writeFileSync(settings, JSON.stringify({ extensions: { 'web-bridge': { serveToAgents: false } } }))
    const input = plan()
    assert.equal(await host.transformPlan(input, meta('claude')), input)
    writeFileSync(settings, JSON.stringify({ extensions: { 'web-bridge': { serveToAgents: 'garbage' } } }))
    assert.notEqual(await host.transformPlan(input, meta('claude')), input, 'an invalid value reads as the default (on)')
    writeFileSync(settings, '{}')
    assert.notEqual(await host.transformPlan(input, meta('claude')), input)
  })

  test('serveToAgents() reads the app\'s layout of settings.json and defaults to on', async () => {
    const api = (raw: unknown) => ({ settings: { get: <T>(key: string): T | undefined => (key === 'extensions' ? (raw as T) : undefined) } })
    assert.equal(serveToAgents(api(undefined)), true)
    assert.equal(serveToAgents(api({ 'web-bridge': { serveToAgents: false } })), false)
    assert.equal(serveToAgents(api({ 'web-bridge': { serveToAgents: true } })), true)
    assert.equal(serveToAgents(api({ disabled: ['note'] })), true)
  })
})

describe('createLaunchMiddleware rules', () => {
  const claude: AgentContribution = { name: 'claude', adapter: { name: 'claude' } as AgentContribution['adapter'], attention: { idle: false, bel: false }, defaultProfiles: () => [], reservedArgs: {}, mcp: { inject: withMcpConfigFlag } }
  const bare: AgentContribution = { ...claude, name: 'bare', mcp: undefined }
  const make = (over: Partial<Parameters<typeof createLaunchMiddleware>[0]> = {}) => {
    const logs: string[] = []
    const mw = createLaunchMiddleware({ agent: n => (n === 'claude' ? claude : n === 'bare' ? bare : undefined), serve: () => true, configFile: 'C:\\h\\mcp\\tether-bridge.json', exists: () => true, log: m => logs.push(m), ...over })
    return { mw, logs }
  }

  test('an agent without mcp, an unknown agent and serve() false: the same object', async () => {
    const input = plan()
    assert.equal(await make().mw(input, meta('bare')), input)
    assert.equal(await make().mw(input, meta('codex')), input)
    assert.equal(await make({ serve: () => false }).mw(input, meta('claude')), input)
  })

  test('a missing MCP file: untouched, logged once until it is back', async () => {
    let there = false
    const { mw, logs } = make({ exists: () => there })
    const input = plan()
    assert.equal(await mw(input, meta('claude')), input)
    assert.equal(await mw(input, meta('claude')), input)
    assert.equal(logs.length, 1); assert.match(logs[0]!, /ausente/)
    there = true
    assert.notEqual(await mw(input, meta('claude')), input)
    there = false
    assert.equal(await mw(input, meta('claude')), input)
    assert.equal(logs.length, 2, 'warned again after the file came and went')
  })

  test('identity: the id follows the bridge pattern; the name is the text of the pane\'s tab (name, else title, else folder), within the limit', async () => {
    assert.match(clientIdOf('a1b2c3d4'), CLIENT_ID_PATTERN)
    assert.equal(clientNameOf({ name: '  Pesquisa ', title: 'kai-thinking', cwd: 'D:\\x\\y' }), 'Pesquisa', 'the name the person gave wins')
    assert.equal(clientNameOf({ title: 'kai-thinking', cwd: 'D:\\x\\atrium' }), 'kai-thinking', 'then the session title')
    assert.equal(clientNameOf({ cwd: 'D:\\work\\proj\\' }), 'proj', 'then the folder')
    assert.equal(clientNameOf({ cwd: '/home/g/app' }), 'app')
    assert.equal(clientNameOf({ name: '\u202ekai\u200b-thinking\u0007 x', cwd: 'D:\\x' }), 'kai-thinking x', 'bidi, zero-width and control characters never reach the browser')
    assert.equal(clientNameOf({ name: '\u200b \u202e', cwd: 'D:\\x\\atrium' }), 'atrium', 'a name that cleans to nothing falls back to the folder')
    assert.equal(cleanName(' a \t b\r\n c '), 'a b c')
    const ids = new BridgeIdentities()
    const long = ids.nameFor('s1', 'x'.repeat(200))
    assert.equal(long.length, CLIENT_NAME_MAX); assert.ok(long.endsWith('…'))
    assert.equal([...ids.nameFor('s2', '😀'.repeat(100))].length, CLIENT_NAME_MAX, 'cut by character, never inside a surrogate pair')
    const out = await make().mw(plan(), meta('claude', { name: 'Pesquisa' }))
    assert.equal(out.env[ENV_CLIENT_NAME], 'Pesquisa')
  })

  test('the launch takes the tab\'s text from the slot\'s state (a resumed session\'s title); without it, the meta', async () => {
    const { mw } = make()
    const state = { slotId: 'a1b2c3d4', kind: 'claude', cwd: 'D:\\work\\atrium', folder: 'D:\\work\\atrium', status: 'starting', title: 'kai-thinking' } as const
    assert.equal((await mw(plan(), meta('claude'), state)).env[ENV_CLIENT_NAME], 'kai-thinking')
    assert.equal((await make().mw(plan(), meta('claude'))).env[ENV_CLIENT_NAME], 'proj', 'no state: the folder of the meta')
  })

  test('two running agents with the same tab text: the first keeps it, the next is numbered; nobody is renumbered', async () => {
    const identities = new BridgeIdentities()
    const { mw } = make({ identities })
    const launch = async (slotId: string, cwd: string) => (await mw(plan(), meta('claude', { slotId, cwd }), { slotId, kind: 'claude', cwd, folder: cwd, status: 'starting' })).env[ENV_CLIENT_NAME]
    assert.equal(await launch('s1', 'D:\\a\\atrium'), 'atrium')
    assert.equal(await launch('s2', 'D:\\b\\atrium'), 'atrium 2')
    assert.equal(await launch('s3', 'D:\\c\\Atrium'), 'Atrium 3', 'case does not make a different name for the person')
    assert.equal(await launch('s1', 'D:\\a\\atrium'), 'atrium', 'a relaunch with the same text keeps its name')
    identities.drop('s1')
    assert.equal(identities.nameOf('s2'), 'atrium 2', 'the first one ending does not renumber the others')
    assert.equal(await launch('s4', 'D:\\d\\atrium'), 'atrium', 'the plain name is free again')
    assert.equal(identities.nameFor('s2', 'kai'), 'kai', 'renamed: the new text, plain')
    assert.equal(identities.nameFor('s3', 'Atrium'), 'Atrium 3', 'same text: same name')
  })
})

describe('releaseClient (slot exit → POST /clients/<id>/release)', () => {
  let home: string
  let server: Server
  let port: number
  let status = 200
  const seen: Array<{ method?: string; url?: string; auth?: string }> = []
  const KEY = 'k-secret-0123456789abcdef'

  before(async () => {
    home = tempHome()
    mkdirSync(join(home, 'bridge'), { recursive: true })
    writeFileSync(join(home, 'bridge', 'api.key'), `${KEY}\n`)
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization })
      res.writeHead(status, { 'content-type': 'application/json' }).end(status === 200 ? '{"ok":true}' : '{"error":"NOT_FOUND"}')
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
  })
  after(async () => { await new Promise<void>(r => server.close(() => r())); await removeHome(home) })

  test('200: released, with the bearer from api.key and the id in the path; the log never shows the key', async () => {
    const logs: string[] = []
    const r = await releaseClient({ port, bridgeHome: join(home, 'bridge'), log: m => logs.push(m) }, 'tether:a1b2c3d4')
    assert.equal(r, 'released')
    assert.deepEqual(seen.at(-1), { method: 'POST', url: '/clients/tether%3Aa1b2c3d4/release', auth: `Bearer ${KEY}` })
    assert.equal(logs.length, 1); assert.ok(!logs.join('\n').includes(KEY))
  })

  test('404 (a daemon older than the route): rejected, one log line, no throw', async () => {
    status = 404
    const logs: string[] = []
    assert.equal(await releaseClient({ port, bridgeHome: join(home, 'bridge'), log: m => logs.push(m) }, 'tether:a1b2c3d4'), 'rejected')
    assert.match(logs[0]!, /respondeu 404/)
    status = 200
  })

  test('nothing listening: unreachable; no api.key: no-key; neither throws', async () => {
    const closed = createServer(); await new Promise<void>(r => closed.listen(0, '127.0.0.1', () => r()))
    const dead = (closed.address() as { port: number }).port
    await new Promise<void>(r => closed.close(() => r()))
    const logs: string[] = []
    assert.equal(await releaseClient({ port: dead, bridgeHome: join(home, 'bridge'), log: m => logs.push(m), timeoutMs: 2_000 }, 'tether:a1b2c3d4'), 'unreachable')
    assert.equal(await releaseClient({ port, bridgeHome: join(home, 'nowhere'), log: m => logs.push(m) }, 'tether:a1b2c3d4'), 'no-key')
    assert.equal(seen.filter(s => s.url?.includes('a1b2c3d4')).length, 2, 'no request without a key')
  })
})
