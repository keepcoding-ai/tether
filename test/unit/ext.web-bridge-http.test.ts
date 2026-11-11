// The Tether Bridge over HTTP (web-bridge/agents.ts, agents with mcp.http): a per-slot file with the route and a ${VAR}
// bearer (the key only in the plan env and the grant), the host's child running the stdio file's own command with its env and
// the slot's identity; soul and a host not listening keep the shared stdio file; the release revokes and removes the file.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { createLaunchMiddleware, ENV_BRIDGE_MCP_KEY, ENV_CLIENT_ID, releaseHttp } from '../../extensions/web-bridge/agents.ts'
import { httpMcpConfigPathOf, mcpConfigPathOf } from '../../extensions/web-bridge/paths.ts'
import { MCP_CONFIG_FLAG } from '../../src/agents/mcp.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { McpBackendSpec, McpSlotRoutes } from '../../src/daemon/mcp-http.ts'

const registry = new AgentRegistry()
new DaemonExtensionHost({ home: 'C:/unused', log: () => {}, agents: registry, extensions: daemonIndex.filter(e => e.manifest.id === 'claude' || e.manifest.id === 'soul') }).activate()

const NODE = 'C:/Program Files/nodejs/node.exe'
const KEY = 'K'.repeat(32)
const slotOf = (agent: SlotMeta['agent']): SlotMeta => ({ v: 1, slotId: 's1', agent, cwd: 'D:/w/proj', args: [], createdAt: '2026-11-10T00:00:00Z' } as SlotMeta)
const base = (): LaunchPlan => ({ command: 'agent.exe', args: ['--model', 'haiku'], cwd: 'D:/w/proj', env: { PATH: 'p' } })
const STDIO = { mcpServers: { 'tether-bridge': { command: 'node', args: ['C:/v/atrium-bridge.mjs', 'mcp'], env: { ATRIUM_BRIDGE_HOME: 'C:/h/bridge', ATRIUM_BRIDGE_PORT: '47831', ATRIUM_BRIDGE_SERVER_NAME: 'tether-bridge' } } } }

function setup(listening = true) {
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
  const mw = createLaunchMiddleware({ agent: n => registry.get(n), serve: () => true, configFile: mcpConfigPathOf(home), exists: existsSync, log: () => {}, http, httpConfigFile, node: () => NODE, key: () => KEY })
  return { home, mw, grants, revoked, http, httpConfigFile, done: () => rmSync(home, { recursive: true, force: true }) }
}

describe('web-bridge over HTTP', () => {
  test('claude: per-slot http file without the key, key in the env, the child runs the stdio command with its env and identity', () => {
    const t = setup()
    try {
      const out = t.mw(base(), slotOf('claude'))
      const file = httpMcpConfigPathOf(t.home, 's1')
      assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, file])
      const text = readFileSync(file, 'utf8')
      assert.deepEqual(JSON.parse(text), { mcpServers: { 'tether-bridge': { type: 'http', url: 'http://127.0.0.1:5555/mcp/s1', headers: { Authorization: `Bearer \${${ENV_BRIDGE_MCP_KEY}}` } } } })
      assert.equal(text.includes(KEY), false)
      assert.equal(out.env[ENV_BRIDGE_MCP_KEY], KEY)
      assert.equal(out.env[ENV_CLIENT_ID], 'tether:s1')
      const g = t.grants.get('s1')!
      assert.equal(g.key, KEY)
      assert.equal(g.spec.command, NODE)
      assert.deepEqual(g.spec.args, ['C:/v/atrium-bridge.mjs', 'mcp'])
      assert.equal(g.spec.env.ATRIUM_BRIDGE_HOME, 'C:/h/bridge')
      assert.equal(g.spec.env[ENV_CLIENT_ID], 'tether:s1')
      assert.equal(g.spec.env[ENV_BRIDGE_MCP_KEY], undefined)
      releaseHttp(t, 's1')
      assert.deepEqual(t.revoked, ['s1'])
      assert.equal(existsSync(file), false)
    } finally { t.done() }
  })

  test('fallback: soul, and claude while the host is not listening, get the shared stdio file; nothing granted', () => {
    for (const [agent, listening] of [['soul', true], ['claude', false]] as const) {
      const t = setup(listening)
      try {
        const out = t.mw(base(), slotOf(agent))
        assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, mcpConfigPathOf(t.home)], agent)
        assert.equal(out.env[ENV_BRIDGE_MCP_KEY], undefined)
        assert.equal(out.env[ENV_CLIENT_ID], 'tether:s1')
        assert.equal(t.grants.size, 0)
      } finally { t.done() }
    }
  })
})
