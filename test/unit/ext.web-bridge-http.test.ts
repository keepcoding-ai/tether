// The Tether Bridge over HTTP (web-bridge/agents.ts, agents with mcp.http): a per-slot file with the route and a ${VAR}
// bearer (the key only in the plan env and the grant), the host's child running the stdio file's own command with its env and
// the slot's identity; soul and a host not listening keep the shared stdio file; the release revokes and removes the file.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { type BridgeBackendInput, BridgeIdentities, createLaunchMiddleware, ENV_BRIDGE_MCP_KEY, ENV_CLIENT_ID, ENV_CLIENT_NAME, releaseHttp } from '../../extensions/web-bridge/agents.ts'
import { createBridgeBackends } from '../../extensions/web-bridge/daemon.ts'
import { dropGrants, grantsFileOf, grantStoreOf } from '../../extensions/web-bridge/grant-store.ts'
import { httpMcpConfigPathOf, mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { MCP_CONFIG_FLAG } from '../../src/agents/mcp.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { McpBackendSpec, McpSlotRoutes } from '../../src/daemon/mcp-http.ts'

const registry = new AgentRegistry()
new DaemonExtensionHost({ home: 'C:/unused', log: () => {}, agents: registry, extensions: daemonIndex.filter(e => e.manifest.id === 'claude' || e.manifest.id === 'soul') }).activate()

const NODE = 'C:/Program Files/nodejs/node.exe'
const KEY = 'K'.repeat(32)
const slotOf = (agent: SlotMeta['agent']): SlotMeta => ({ v: 1, slotId: 's1', agent, cwd: 'D:/w/proj', args: [], createdAt: '2026-11-10T00:00:00Z' } as SlotMeta)
const base = (): LaunchPlan => ({ command: 'agent.exe', args: ['--model', 'haiku'], cwd: 'D:/w/proj', env: { PATH: 'p' } })
const STDIO = { mcpServers: { 'tether-bridge': { command: 'node', args: ['C:/v/atrium-bridge.mjs', 'mcp'], env: { ATRIUM_BRIDGE_HOME: 'C:/h/bridge', ATRIUM_BRIDGE_PORT: '47831', ATRIUM_BRIDGE_SERVER_NAME: 'tether-bridge' } } } }

function setup(listening = true, withBackend = true, identities?: BridgeIdentities) {
  const home = mkdtempSync(join(tmpdir(), 'tether-brhttp-'))
  mkdirSync(join(home, 'mcp'), { recursive: true })
  writeFileSync(mcpConfigPathOf(home), JSON.stringify(STDIO))
  const grants = new Map<string, { key: string; spec: McpBackendSpec }>()
  const revoked: string[] = []
  const http: McpSlotRoutes = {
    urlOf: id => (listening ? `http://127.0.0.1:5555/mcp/${id}` : undefined),
    grant: (id, key, spec) => { grants.set(id, { key, spec }) },
    revoke: id => { revoked.push(id); grants.delete(id) },
  }
  const httpConfigFile = (id: string) => httpMcpConfigPathOf(home, id)
  const made: BridgeBackendInput[] = []
  const backend = (input: BridgeBackendInput) => { made.push(input); return { connect: async () => undefined, close: async () => undefined } }
  const mw = createLaunchMiddleware({ agent: n => registry.get(n), serve: () => true, configFile: mcpConfigPathOf(home), exists: existsSync, log: () => {}, http, httpConfigFile, node: () => NODE, key: () => KEY, ...(withBackend ? { backend } : {}), ...(identities ? { identities } : {}) })
  return { home, mw, grants, revoked, made, http, httpConfigFile, done: () => rmSync(home, { recursive: true, force: true }) }
}

describe('web-bridge over HTTP', () => {
  test('claude: per-slot http file without the key, key in the env, the child runs the stdio command with its env and identity', async () => {
    const t = setup()
    try {
      const out = await t.mw(base(), slotOf('claude'))
      const file = httpMcpConfigPathOf(t.home, 's1')
      assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, file])
      const text = readFileSync(file, 'utf8')
      assert.deepEqual(JSON.parse(text), { mcpServers: { 'tether-bridge': { type: 'http', url: 'http://127.0.0.1:5555/mcp/s1', headers: { Authorization: `Bearer \${${ENV_BRIDGE_MCP_KEY}}` } } } })
      assert.equal(text.includes(KEY), false)
      assert.equal(out.env[ENV_BRIDGE_MCP_KEY], KEY)
      assert.equal(out.env[ENV_CLIENT_ID], 'tether:s1')
      const g = t.grants.get('s1')!
      assert.equal(g.key, KEY)
      assert.equal(t.made.length, 0, 'no shell is made before the agent initializes')
      void g.spec.create()
      const input = t.made[0]!
      assert.equal(input.slotId, 's1')
      assert.equal(input.node, NODE)
      assert.equal(input.env.ATRIUM_BRIDGE_HOME, 'C:/h/bridge', 'the stdio file\'s env')
      assert.equal(input.env.ATRIUM_BRIDGE_PORT, '47831')
      assert.equal(input.env.ATRIUM_BRIDGE_SERVER_NAME, 'tether-bridge')
      assert.equal(input.env[ENV_CLIENT_ID], 'tether:s1', 'the slot\'s identity')
      assert.equal(input.env.PATH, 'p', 'the agent\'s launch env')
      assert.equal(input.env[ENV_BRIDGE_MCP_KEY], undefined)
      assert.equal('command' in g.spec, false, 'no process is described: the shell runs inside the daemon')
      await releaseHttp(t, 's1')
      assert.deepEqual(t.revoked, ['s1'])
      assert.equal(existsSync(file), false)
    } finally { t.done() }
  })

  test('a renamed tab renames the running agent: the env its shells read at every request takes the new name; soul keeps the launch name', async () => {
    const identities = new BridgeIdentities()
    const t = setup(true, true, identities)
    try {
      const state = (over: Partial<SlotState> = {}): SlotState => ({ slotId: 's1', kind: 'claude', cwd: 'D:/w/atrium', folder: 'D:/w/atrium', status: 'running', ...over })
      const out = await t.mw(base(), slotOf('claude'), state({ title: 'kai-thinking' }))
      assert.equal(out.env[ENV_CLIENT_NAME], 'kai-thinking', 'the tab\'s text at launch')
      void t.grants.get('s1')!.spec.create()
      void t.grants.get('s1')!.spec.create()
      const [first, second] = t.made
      assert.equal(first!.env, second!.env, 'every shell of the run shares one env object')
      identities.follow(state({ title: 'kai-thinking', name: 'pesquisa' }))
      assert.equal(first!.env[ENV_CLIENT_NAME], 'pesquisa', 'renamed without a relaunch')
      identities.follow(state({ title: 'kai-thinking' }))
      assert.equal(first!.env[ENV_CLIENT_NAME], 'kai-thinking', 'the name cleared: the title again')
      identities.drop('s1')
      identities.follow(state({ name: 'after the end' }))
      assert.equal(first!.env[ENV_CLIENT_NAME], 'kai-thinking', 'an ended run is not touched')
      // soul (stdio): named at launch, an event changes nothing (it has no shell inside the daemon)
      const soul = await t.mw(base(), { ...slotOf('soul'), slotId: 's2' }, state({ slotId: 's2', kind: 'soul', title: 'soul-env' }))
      assert.equal(soul.env[ENV_CLIENT_NAME], 'soul-env')
      identities.follow(state({ slotId: 's2', kind: 'soul', name: 'other' }))
      assert.equal(identities.nameOf('s2'), 'soul-env')
    } finally { t.done() }
  })

  test('fallback: soul, and claude while the host is not listening, get the shared stdio file; nothing granted', async () => {
    for (const [agent, listening, withBackend] of [['soul', true, true], ['claude', false, true], ['claude', true, false]] as const) {
      const t = setup(listening, withBackend)
      try {
        const out = await t.mw(base(), slotOf(agent))
        assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, mcpConfigPathOf(t.home)], agent)
        assert.equal(out.env[ENV_BRIDGE_MCP_KEY], undefined)
        assert.equal(out.env[ENV_CLIENT_ID], 'tether:s1')
        assert.equal(t.grants.size, 0)
      } finally { t.done() }
    }
  })

  test('the upload authorizations are kept with the slot: saved, read back by a new store, dropped with the slot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tether-brgrants-'))
    try {
      const store = await grantStoreOf(home, 's1')
      assert.deepEqual(store.load(), [], 'no file: nothing authorized')
      const grant = { folder: 'C:/Users/x/Downloads/send', origin: 'https://portal.example', grantedAt: '2026-11-11T00:00:00.000Z', via: 'WebAllowUploads' }
      store.save([grant])
      await store.flush()
      assert.deepEqual(JSON.parse(readFileSync(grantsFileOf(home, 's1'), 'utf8')), { v: 1, grants: [grant] })
      assert.deepEqual((await grantStoreOf(home, 's1')).load(), [grant], 'a new server of the same slot gets them back')
      assert.deepEqual((await grantStoreOf(home, 's2')).load(), [], 'another slot does not')
      writeFileSync(grantsFileOf(home, 's2'), 'not json')
      assert.deepEqual((await grantStoreOf(home, 's2')).load(), [], 'a broken file is nothing authorized')
      store.save([])
      await store.flush()
      assert.equal(existsSync(grantsFileOf(home, 's1')), false, 'the last one revoked: no file')
      store.save([grant])
      await store.flush()
      await dropGrants(home, 's1')
      assert.equal(existsSync(grantsFileOf(home, 's1')), false, 'the slot was forgotten')
      await assert.rejects(() => grantStoreOf(home, '../x'))
      assert.match(store.lifetime, /panel/)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('the shells inside the daemon: one import of the bundle, a shell per slot with its own env and store, a bundle that is not whole is never loaded', async () => {
    const vendorDir = join(import.meta.dirname, '..', '..', 'extensions', 'web-bridge', 'vendor')
    const created: Array<{ env: Record<string, string | undefined>; daemonEntry: string; node?: string; grantStore?: unknown; stderr?: boolean }> = []
    let imports = 0
    let warmups = 0
    const make = createBridgeBackends({
      vendorDir,
      grants: slotId => ({ lifetime: slotId, load: () => [], save: () => undefined }),
      importBundle: async () => { imports++; return { createBridgeMcp: (o: typeof created[number]) => { created.push(o); return { connect: async () => undefined, warmup: () => { warmups++ }, close: async () => undefined } } } },
    })
    await make({ slotId: 'a', env: { ATRIUM_BRIDGE_CLIENT_ID: 'tether:a' }, node: NODE })
    await make({ slotId: 'b', env: { ATRIUM_BRIDGE_CLIENT_ID: 'tether:b' }, node: NODE })
    assert.equal(imports, 1)
    assert.equal(warmups, 2)
    assert.deepEqual(created.map(c => c.env.ATRIUM_BRIDGE_CLIENT_ID), ['tether:a', 'tether:b'])
    assert.deepEqual(created.map(c => (c.grantStore as { lifetime: string }).lifetime), ['a', 'b'])
    assert.equal(created[0]!.daemonEntry, join(vendorDir, 'atrium-bridge.mjs'))
    assert.equal(created[0]!.node, NODE)
    assert.equal(created[0]!.stderr, false)
    const broken = createBridgeBackends({ vendorDir: join(tmpdir(), 'no-such-vendor'), grants: () => ({ lifetime: '', load: () => [], save: () => undefined }), importBundle: async () => { throw new Error('must not import') } })
    await assert.rejects(broken({ slotId: 'a', env: {}, node: NODE }), /manifesto/)
  })
})
