// Features at launch (src/daemon/ext-host.ts), with the committed daemon index (claude, soul, web-bridge) activated in a
// host of its own: the Tether Bridge is the feature `bridge` (on by default), whose content is the folder web-bridge
// provides (<home>/web-bridge/share/mcps/tether-bridge/mcp.json). An AI agent plan with the feature on gets the composed
// <home>/share/bridge/ through its contribution (claude: `--mcp-config <share>/claude.mcp.json`, plus `--plugin-dir
// <share>/claude-plugin` when there are skills; soul: `-S <share>/soul` and `--mcp-config <share>/soul.mcp.json`) and its
// identity for the bridge in the env; off (profile > settings.json `agents.features.bridge` > default, the old
// `extensions.web-bridge.serveToAgents` still read through the migration), a shell plan, or a feature with no content
// leave the plan untouched. A static feature (`share` folder of an extension) composes the same way, and an extension may
// only provide its own feature. The release on exit is a POST to the bridge daemon that tolerates every answer and never
// carries the key in a log.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { CLIENT_ID_PATTERN, CLIENT_NAME_MAX, clientIdOf, clientNameOf, createLaunchMiddleware, ENV_CLIENT_ID, ENV_CLIENT_NAME, releaseClient } from '../../extensions/web-bridge/agents.ts'
import { mcpConfigOf, writeMcpConfig } from '../../extensions/web-bridge/bridge-home.ts'
import { bridgeShareDirOf, legacyMcpConfigPathOf, mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import { CLAUDE_MCP_FILE, CLAUDE_PLUGIN_DIR, PLUGIN_DIR_FLAG } from '../../src/agents/claude-plugin.ts'
import { AgentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { cleanShares, shareRootOf } from '../../src/daemon/share.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

const meta = (agent: SlotMeta['agent'], extra: Partial<SlotMeta> = {}): SlotMeta => ({ v: 1, slotId: 'a1b2c3d4', agent, cwd: 'D:\\work\\proj', args: [], createdAt: '2026-11-06T00:00:00.000Z', ...extra })
const plan = (): LaunchPlan => ({ command: 'agent.exe', args: ['--settings', 'x.json', '--model', 'haiku'], cwd: 'D:\\work\\proj', env: { PATH: 'p', TETHER_SLOT_ID: 'a1b2c3d4' } })
const on = (features: string[]) => ({ features: new Set(features) })

describe('the bridge feature at launch', () => {
  let home: string
  let host: DaemonExtensionHost
  const logs: string[] = []
  const settings = (): string => join(home, 'settings.json')
  const composed = (): string => join(shareRootOf(home), 'bridge')

  before(() => {
    home = tempHome()
    host = new DaemonExtensionHost({ home, log: m => logs.push(m), agents: new AgentRegistry(), extensions: daemonIndex })
    host.activate()
    assert.deepEqual(host.activated, ['claude', 'soul', 'faults', 'web-bridge'])
    assert.deepEqual(host.features.map(f => [f.id, f.ext]), [['faults', 'faults'], ['bridge', 'web-bridge']])
    // What the setup writes at start (bridge-home.ts), plus a pre-feature file it must remove.
    mkdirSync(join(home, 'mcp'), { recursive: true })
    writeFileSync(legacyMcpConfigPathOf(home), '{}')
    writeMcpConfig(home, mcpConfigOf(join(home, 'bridge'), 'C:\\v\\atrium-bridge.mjs', 47999))
  })
  after(async () => { host.dispose(); cleanShares(home); await removeHome(home) })

  test('the setup wrote the feature folder (stdio, keyed by the server) and removed the old <home>/mcp file', () => {
    const spec = JSON.parse(readFileSync(mcpConfigPathOf(home), 'utf8')) as { mcpServers: Record<string, { type: string; command: string; env: Record<string, string> }> }
    assert.deepEqual(Object.keys(spec.mcpServers), ['tether-bridge'])
    assert.equal(spec.mcpServers['tether-bridge']!.type, 'stdio')
    assert.equal(spec.mcpServers['tether-bridge']!.env.ATRIUM_BRIDGE_PORT, '47999')
    assert.equal(mcpConfigPathOf(home), join(bridgeShareDirOf(home), 'mcps', 'tether-bridge', 'mcp.json'))
    assert.ok(!existsSync(legacyMcpConfigPathOf(home)) && !existsSync(join(home, 'mcp')))
  })

  test('claude: --mcp-config <share>/bridge/claude.mcp.json LAST and the identity env; no plugin (the bridge has no skill)', () => {
    const input = plan()
    const out = host.transformPlan(input, meta('claude', { name: 'Pesquisa' }))
    assert.deepEqual(out.args, [...input.args, '--mcp-config', join(composed(), CLAUDE_MCP_FILE)])
    assert.ok(!out.args.includes(PLUGIN_DIR_FLAG) && !existsSync(join(composed(), CLAUDE_PLUGIN_DIR)))
    assert.equal(out.env[ENV_CLIENT_ID], 'tether:a1b2c3d4')
    assert.equal(out.env[ENV_CLIENT_NAME], 'Claude · Pesquisa')
    assert.equal(out.env.PATH, 'p'); assert.equal(out.command, input.command); assert.equal(out.cwd, input.cwd)
    assert.deepEqual(input, plan(), 'the plan given is never mutated')
    assert.ok(existsSync(join(composed(), 'mcps', 'tether-bridge', 'mcp.json')))
    const merged = JSON.parse(readFileSync(join(composed(), CLAUDE_MCP_FILE), 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(merged.mcpServers), ['tether-bridge'], 'the server keeps its own name: tools mcp__tether-bridge__*')
  })

  test('soul: -S <share>/bridge/soul and --mcp-config <share>/bridge/soul.mcp.json, and the identity env', () => {
    const out = host.transformPlan(plan(), meta('soul', { name: 'Pesquisa' }))
    assert.deepEqual(out.args, [...plan().args, '-S', join(composed(), 'soul'), '--mcp-config', join(composed(), 'soul.mcp.json')])
    const servers = JSON.parse(readFileSync(join(composed(), 'soul.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(servers.mcpServers), ['tether-bridge'])
    assert.equal(out.env[ENV_CLIENT_NAME], 'Soul · Pesquisa')
  })

  test('a shell plan is the same object', () => {
    const input = plan()
    assert.equal(host.transformPlan(input, meta('shell')), input)
  })

  test('profile features.bridge=false: the same object (no plugin, no MCP, no identity), whatever the general switch says', () => {
    const input = plan()
    assert.equal(host.transformPlan(input, meta('claude'), { profileFeatures: { bridge: false } }), input)
    assert.equal(host.transformPlan(input, meta('soul'), { profileFeatures: { bridge: false } }), input)
  })

  test('general switch off: untouched, unless the profile turns it on; the old serveToAgents still counts until migrated', () => {
    const input = plan()
    writeFileSync(settings(), JSON.stringify({ agents: { features: { bridge: false } } }))
    assert.equal(host.transformPlan(input, meta('claude')), input)
    assert.ok(host.transformPlan(input, meta('claude'), { profileFeatures: { bridge: true } }).args.includes('--mcp-config'), 'the profile wins')
    writeFileSync(settings(), JSON.stringify({ agents: { features: { bridge: 'garbage' } } }))
    assert.notEqual(host.transformPlan(input, meta('claude')), input, 'an invalid value reads as the default (on)')
    writeFileSync(settings(), JSON.stringify({ extensions: { 'web-bridge': { serveToAgents: false } } }))
    assert.equal(host.transformPlan(input, meta('claude')), input, 'the old key, read through the migration')
    writeFileSync(settings(), '{}')
    assert.notEqual(host.transformPlan(input, meta('claude')), input)
  })

  test('no MCP file (a failed setup): launched untouched (no plugin, no identity), said once until it is back', () => {
    const file = mcpConfigPathOf(home)
    const saved = readFileSync(file)
    rmSync(join(bridgeShareDirOf(home), 'mcps'), { recursive: true }) // a plain folder of files, no link
    const before = logs.length
    const input = plan()
    assert.equal(host.transformPlan(input, meta('claude')), input, 'no plugin and no bridge identity: the same object')
    assert.ok(!host.transformPlan(plan(), meta('claude')).args.includes('--mcp-config'))
    assert.equal(logs.slice(before).filter(l => /feature bridge: sem conteúdo/.test(l)).length, 1)
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, saved)
    assert.ok(host.transformPlan(plan(), meta('claude')).args.includes('--mcp-config'))
  })
})

describe('a static feature and the rules of provide', () => {
  test('a feature with a `share` folder inside extensions/<id>/ composes with the bridge; the composed folder is named by the set', async () => {
    const home = tempHome()
    const extensionsDir = join(home, 'exts')
    mkdirSync(join(extensionsDir, 'faults', 'share', 'skills', 'tether-faults'), { recursive: true })
    writeFileSync(join(extensionsDir, 'faults', 'share', 'skills', 'tether-faults', 'SKILL.md'), '---\nname: tether-faults\n---\n')
    const host = new DaemonExtensionHost({ home, log: () => {}, agents: new AgentRegistry(), extensions: daemonIndex, extensionsDir })
    host.activate()
    writeMcpConfig(home, mcpConfigOf(join(home, 'bridge'), 'C:\\v\\b.mjs', 1))
    try {
      assert.ok(!host.transformPlan(plan(), meta('soul')).args.includes(join(shareRootOf(home), 'bridge+faults')), 'faults is off by default')
      const out = host.transformPlan(plan(), meta('soul'), { profileFeatures: { faults: true } })
      const dir = join(shareRootOf(home), 'bridge+faults')
      assert.deepEqual(out.args.slice(-4), ['-S', join(dir, 'soul'), '--mcp-config', join(dir, 'soul.mcp.json')])
      assert.ok(existsSync(join(dir, 'skills', 'tether-faults', 'SKILL.md')))
      assert.ok(existsSync(join(dir, 'soul', 'skills', 'tether-faults', 'SKILL.md')), "the soul's view holds a copy of the skill")
      assert.ok(existsSync(join(dir, 'mcps', 'tether-bridge', 'mcp.json')))
      const claude = host.transformPlan(plan(), meta('claude'), { profileFeatures: { faults: true, bridge: false } })
      assert.deepEqual(claude.args.slice(-2), [PLUGIN_DIR_FLAG, join(shareRootOf(home), 'faults', CLAUDE_PLUGIN_DIR)], 'skills only: the plugin, no --mcp-config')
      const both = host.transformPlan(plan(), meta('claude'), { profileFeatures: { faults: true } })
      assert.deepEqual(both.args.slice(-4), [PLUGIN_DIR_FLAG, join(dir, CLAUDE_PLUGIN_DIR), '--mcp-config', join(dir, CLAUDE_MCP_FILE)])
      assert.ok(existsSync(join(shareRootOf(home), 'faults', CLAUDE_PLUGIN_DIR, 'skills', 'tether-faults', 'SKILL.md')))
      assert.equal(claude.env[ENV_CLIENT_ID], undefined, 'no bridge, no bridge identity')
    } finally { host.dispose(); cleanShares(home); await removeHome(home) }
  })

  test('an extension may only provide its own feature', () => {
    const home = tempHome()
    let error = ''
    const thief: ExtensionEntry<TetherDaemon> = {
      manifest: { id: 'thief', version: '0.0.1', displayName: 'T', hosts: ['daemon'] },
      activate: api => { try { api.features.provide('bridge', () => home) } catch (e) { error = (e as Error).message } return [] },
    }
    const host = new DaemonExtensionHost({ home, log: () => {}, agents: new AgentRegistry(), extensions: [...daemonIndex, thief] })
    host.activate()
    host.dispose()
    assert.match(error, /não é declarada pela extensão thief/)
    void removeHome(home)
  })

  test('a disabled extension declares nothing', () => {
    const home = tempHome()
    const host = new DaemonExtensionHost({ home, log: () => {}, agents: new AgentRegistry(), extensions: daemonIndex, disabled: ['web-bridge', 'faults'] })
    host.activate()
    assert.deepEqual(host.features, [])
    const input = plan()
    assert.equal(host.transformPlan(input, meta('claude')), input)
    host.dispose()
    void removeHome(home)
  })
})

describe('createLaunchMiddleware rules', () => {
  const share = { inject: (p: LaunchPlan) => p }
  const claude: AgentContribution = { name: 'claude', adapter: { name: 'claude' } as AgentContribution['adapter'], attention: { idle: false, bel: false }, defaultProfiles: () => [], reservedArgs: {}, share }
  const bare: AgentContribution = { ...claude, name: 'bare', share: undefined }
  const make = () => {
    const logs: string[] = []
    const mw = createLaunchMiddleware({ agent: n => (n === 'claude' ? claude : n === 'bare' ? bare : undefined), log: m => logs.push(m) })
    return { mw, logs }
  }

  test('an agent without share, an unknown agent and the feature off: the same object', () => {
    const input = plan()
    assert.equal(make().mw(input, meta('bare'), on(['bridge'])), input)
    assert.equal(make().mw(input, meta('codex'), on(['bridge'])), input)
    assert.equal(make().mw(input, meta('claude'), on([])), input)
    assert.equal(make().mw(input, meta('shell'), on(['bridge'])), input)
  })

  test('identity: the id follows the bridge pattern; the name takes the slot name, else the folder, within the limit', () => {
    assert.match(clientIdOf('a1b2c3d4'), CLIENT_ID_PATTERN)
    assert.equal(clientNameOf('claude', { name: '  Pesquisa ', cwd: 'D:\\x\\y' }), 'Claude · Pesquisa')
    assert.equal(clientNameOf('soul', { cwd: 'D:\\work\\proj\\' }), 'Soul · proj')
    assert.equal(clientNameOf('claude', { cwd: '/home/g/app' }), 'Claude · app')
    const long = clientNameOf('claude', { name: 'x'.repeat(200), cwd: 'D:\\' })
    assert.equal(long.length, CLIENT_NAME_MAX); assert.ok(long.endsWith('…'))
    const out = make().mw(plan(), meta('claude', { name: 'Pesquisa' }), on(['bridge']))
    assert.equal(out.env[ENV_CLIENT_NAME], 'Claude · Pesquisa')
    assert.deepEqual(out.args, plan().args, 'the middleware only adds the identity; the MCP goes through the share folder')
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
