// The browser handed to the agents of the panes (Tether Browser E8): the launch plan with and without the browser served,
// with and without evaluate, next to the bridge (two --mcp-config), a repeated server name refused, the key born at launch and
// gone at exit (temp home), and an MCP file that carries paths and never the key.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import {
  ENV_BROWSER_MCP_KEY, MCP_SERVER_NAME, createBrowserLaunchMiddleware, type BrowserBackendInput, type BrowserHttpHost, endpointFileOf, keyFileOf, keysDirOf, mcpConfigOf, mcpDirOf, mcpFileOf, newKey, releaseSlot, sweepStale,
} from '../../extensions/browser/agents.ts'
import { KeyStore } from '../../extensions/browser/gate-keys.ts'
import { validKeyShape } from '../../extensions/browser/gate-rules.ts'
import { MCP_CONFIG_FLAG } from '../../src/agents/mcp.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { McpBackendSpec } from '../../src/daemon/mcp-http.ts'

const registry = new AgentRegistry()
new DaemonExtensionHost({ home: 'C:/unused', log: () => {}, agents: registry, extensions: daemonIndex.filter(e => e.manifest.id === 'claude' || e.manifest.id === 'soul') }).activate()

const SERVER = 'C:/app/extensions/browser/vendor/tether-browser/server.mjs'
const NODE = 'C:/Program Files/nodejs/node.exe'
const BRIDGE = 'C:/home/mcp/tether-bridge.json'
const base = (): LaunchPlan => ({ command: 'agent.exe', args: ['--model', 'haiku'], cwd: 'D:/w', env: { PATH: 'p' } })
const slotOf = (agent: SlotMeta['agent'], slotId = 'abc123'): SlotMeta => ({ slotId, agent, cwd: 'D:/w', createdAt: '2026-11-09T00:00:00Z' } as SlotMeta)

const PROXY = 'C:/app/extensions/browser/mcp-proxy.mjs'

function setup(over: { serve?: boolean; evaluate?: boolean; node?: string | undefined; exists?: boolean; proxy?: string; existing?: string[]; http?: BrowserHttpHost; noBackend?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tether-bragents-'))
  const logs: string[] = []
  const made: BrowserBackendInput[] = []
  const mw = createBrowserLaunchMiddleware({
    home,
    agent: n => registry.get(n),
    serve: () => over.serve ?? true,
    evaluate: () => over.evaluate ?? false,
    server: SERVER,
    ...(over.proxy ? { proxy: over.proxy } : {}),
    ...(over.http ? { http: over.http } : {}),
    ...(over.http && !over.noBackend ? { backend: (input: BrowserBackendInput) => { made.push(input); return { connect: async () => undefined, close: async () => undefined } } } : {}),
    node: () => ('node' in over ? over.node : NODE),
    log: m => logs.push(m),
    exists: p => (over.existing ? over.existing.includes(p) : over.exists ?? true),
  })
  return { home, logs, mw, made, done: () => rmSync(home, { recursive: true, force: true }) }
}

for (const agent of ['claude', 'soul'] as const) {
  describe(`${agent}: the browser in the launch plan`, () => {
    test('served: one more --mcp-config, the key and the MCP file exist, the plan is a copy', () => {
      const t = setup()
      try {
        const plan = base()
        const out = t.mw(plan, slotOf(agent))
        assert.notEqual(out, plan)
        assert.deepEqual(plan, base(), 'the plan given is not mutated')
        assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, mcpFileOf(t.home, 'abc123')])
        assert.deepEqual(out.mcpServers, { [MCP_SERVER_NAME]: mcpFileOf(t.home, 'abc123') })
        assert.ok(validKeyShape(readFileSync(keyFileOf(t.home, 'abc123'), 'utf8').trim()))
        assert.ok(existsSync(mcpFileOf(t.home, 'abc123')))
      } finally { t.done() }
    })

    test('not served: the same plan object, nothing on disk', () => {
      const t = setup({ serve: false })
      try {
        const plan = base()
        assert.equal(t.mw(plan, slotOf(agent)), plan)
        assert.equal(existsSync(join(t.home, 'browser')), false)
      } finally { t.done() }
    })

    test('with the bridge: two --mcp-config, the bridge first, in injection order', () => {
      const t = setup()
      try {
        const withBridge = registry.get(agent)!.mcp!.inject(base(), BRIDGE, ['tether-bridge'])
        const out = t.mw(withBridge, slotOf(agent))
        assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, BRIDGE, MCP_CONFIG_FLAG, mcpFileOf(t.home, 'abc123')])
        assert.deepEqual(out.mcpServers, { 'tether-bridge': BRIDGE, [MCP_SERVER_NAME]: mcpFileOf(t.home, 'abc123') })
      } finally { t.done() }
    })

    test('a server of that name already injected: refused, plan untouched, nothing written', () => {
      const t = setup()
      try {
        const taken = registry.get(agent)!.mcp!.inject(base(), 'C:/other/x.json', [MCP_SERVER_NAME])
        assert.equal(t.mw(taken, slotOf(agent)), taken)
        assert.equal(existsSync(keyFileOf(t.home, 'abc123')), false)
        assert.equal(existsSync(mcpFileOf(t.home, 'abc123')), false)
        assert.ok(t.logs.some(l => l.includes(MCP_SERVER_NAME) && l.includes('recusado')))
      } finally { t.done() }
    })
  })
}

describe('the browser launch middleware: when it stays out', () => {
  test('a plain shell is never served', () => {
    const t = setup()
    try { const p = base(); assert.equal(t.mw(p, slotOf('shell')), p); assert.equal(existsSync(join(t.home, 'browser')), false) } finally { t.done() }
  })
  test('an unknown agent, a missing server and a missing node leave the plan alone', () => {
    for (const [what, t, agent] of [['unknown agent', setup(), 'nope'], ['no server', setup({ exists: false }), 'claude'], ['no node', setup({ node: undefined }), 'claude']] as const) {
      try {
        const p = base()
        assert.equal(t.mw(p, slotOf(agent as SlotMeta['agent'])), p, what)
        assert.equal(existsSync(keyFileOf(t.home, 'abc123')), false, what)
      } finally { t.done() }
    }
  })
  test('a slot id that is not a safe file name is never served', () => {
    const t = setup()
    try { const p = base(); assert.equal(t.mw(p, slotOf('claude', '..\\evil')), p) } finally { t.done() }
  })
})

describe('the MCP file: paths and flags, never the key', () => {
  const read = (home: string): { command: string; args: string[] } => JSON.parse(readFileSync(mcpFileOf(home, 'abc123'), 'utf8')).mcpServers[MCP_SERVER_NAME]

  test('without evaluate', () => {
    const t = setup()
    try {
      const out = t.mw(base(), slotOf('claude'))
      assert.ok(out.args.includes(mcpFileOf(t.home, 'abc123')))
      assert.deepEqual(JSON.parse(readFileSync(mcpFileOf(t.home, 'abc123'), 'utf8')), {
        mcpServers: { [MCP_SERVER_NAME]: { command: NODE, args: [SERVER, '--adopt-endpoint-file', endpointFileOf(t.home), '--adopt-key-file', keyFileOf(t.home, 'abc123')] } },
      })
    } finally { t.done() }
  })
  // V2b: the vendored server's texts are corrected by a stdio proxy (mcp-proxy.mjs) that runs the server as its first argument.
  test('with the proxy: node runs the proxy, which gets the server and its arguments', () => {
    const t = setup({ proxy: PROXY, evaluate: true })
    try {
      t.mw(base(), slotOf('claude'))
      assert.deepEqual(read(t.home).args, [PROXY, SERVER, '--adopt-endpoint-file', endpointFileOf(t.home), '--adopt-key-file', keyFileOf(t.home, 'abc123'), '--allow-evaluate'])
    } finally { t.done() }
  })
  test('a proxy that is missing from disk leaves the server running bare (the agent still gets the browser)', () => {
    const t = setup({ proxy: PROXY, existing: [SERVER] })
    try {
      t.mw(base(), slotOf('claude'))
      assert.equal(read(t.home).args[0], SERVER)
    } finally { t.done() }
  })
  test('with evaluate: --allow-evaluate, last', () => {
    const t = setup({ evaluate: true })
    try {
      t.mw(base(), slotOf('soul'))
      assert.equal(read(t.home).args.at(-1), '--allow-evaluate')
      assert.equal(read(t.home).args.filter(a => a === '--allow-evaluate').length, 1)
    } finally { t.done() }
  })
  test('the key text is in no MCP file, plan (args or env) or log line', () => {
    const KEY = 'K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3'
    const home = mkdtempSync(join(tmpdir(), 'tether-bragents-'))
    const logs: string[] = []
    try {
      const mw = createBrowserLaunchMiddleware({ home, agent: n => registry.get(n), serve: () => true, evaluate: () => true, server: SERVER, node: () => NODE, log: m => logs.push(m), exists: () => true, key: () => KEY })
      const out = mw(base(), slotOf('claude'))
      assert.equal(readFileSync(keyFileOf(home, 'abc123'), 'utf8').trim(), KEY)
      assert.ok(!readFileSync(mcpFileOf(home, 'abc123'), 'utf8').includes(KEY))
      assert.ok(!JSON.stringify(out).includes(KEY))
      assert.ok(!logs.join('\n').includes(KEY))
      assert.ok(!JSON.stringify(mcpConfigOf({ node: NODE, server: SERVER, endpointFile: 'e', keyFile: 'k', evaluate: true })).includes(KEY))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('the key: born at launch, new at every launch, gone at exit', () => {
  test('32 characters of base64url, different every time', () => {
    const a = newKey(); const b = newKey()
    assert.match(a, /^[A-Za-z0-9_-]{32}$/)
    assert.notEqual(a, b)
  })

  test('a launch replaces the key of the previous run; the gate reads it, then stops knowing it after the release', () => {
    const t = setup()
    try {
      t.mw(base(), slotOf('claude'))
      const first = readFileSync(keyFileOf(t.home, 'abc123'), 'utf8').trim()
      const gate = new KeyStore(keysDirOf(t.home), 0)
      assert.equal(gate.owner(first), 'abc123')
      t.mw(base(), slotOf('claude'))
      const second = readFileSync(keyFileOf(t.home, 'abc123'), 'utf8').trim()
      assert.notEqual(first, second)
      assert.equal(gate.valid('abc123', first), false, 'the old run\'s key no longer opens the gate')
      assert.equal(gate.valid('abc123', second), true)
      releaseSlot(t.home, 'abc123')
      assert.equal(existsSync(keyFileOf(t.home, 'abc123')), false)
      assert.equal(existsSync(mcpFileOf(t.home, 'abc123')), false)
      assert.equal(gate.owner(second), undefined)
      releaseSlot(t.home, 'abc123') // twice is fine
    } finally { t.done() }
  })

  test('two slots have two keys and releasing one leaves the other', () => {
    const t = setup()
    try {
      t.mw(base(), slotOf('claude', 'one'))
      t.mw(base(), slotOf('soul', 'two'))
      releaseSlot(t.home, 'one')
      assert.equal(existsSync(keyFileOf(t.home, 'one')), false)
      assert.equal(existsSync(keyFileOf(t.home, 'two')), true)
    } finally { t.done() }
  })

  test('a failed write leaves no key and no MCP file, and the plan as it was', () => {
    const t = setup()
    try {
      mkdirSync(join(t.home, 'browser'), { recursive: true })
      writeFileSync(join(t.home, 'browser', 'keys'), 'a file where the folder should be')
      const p = base()
      assert.equal(t.mw(p, slotOf('claude')), p)
      assert.equal(existsSync(mcpFileOf(t.home, 'abc123')), false)
      assert.ok(t.logs.some(l => l.includes('não consegui preparar a chave')))
    } finally { t.done() }
  })

  test('sweepStale clears the keys and MCP files a killed tetherd left for the slots of this home, and nothing else', async () => {
    const t = setup()
    try {
      mkdirSync(join(t.home, 'slots'), { recursive: true })
      for (const id of ['one', 'two']) writeFileSync(join(t.home, 'slots', id + '.json'), '{}')
      t.mw(base(), slotOf('claude', 'one'))
      t.mw(base(), slotOf('soul', 'two'))
      t.mw(base(), slotOf('soul', 'stranger')) // no slot of that name: not ours to judge
      writeFileSync(join(t.home, 'browser', 'endpoint.json'), '{}')
      await new Promise(r => setTimeout(r, 20)) // the files above are older than the sweep
      assert.equal(await sweepStale(t.home), 4)
      assert.deepEqual(readdirSync(keysDirOf(t.home)), ['stranger.key'])
      assert.deepEqual(readdirSync(mcpDirOf(t.home)), ['stranger.json'])
      assert.ok(existsSync(join(t.home, 'browser', 'endpoint.json')))
      assert.equal(await sweepStale(join(t.home, 'nowhere')), 0)
    } finally { t.done() }
  })
})

describe('the browser over HTTP (agents with mcp.http)', () => {
  const fakeHost = (listening = true) => {
    const grants = new Map<string, { key: string; spec: McpBackendSpec }>()
    const revoked: string[] = []
    const http: BrowserHttpHost = {
      urlOf: id => (listening ? `http://127.0.0.1:4321/mcp/${id}` : undefined),
      grant: (id, key, spec) => { grants.set(id, { key, spec }) },
      revoke: id => { revoked.push(id); grants.delete(id) },
    }
    return { http, grants, revoked }
  }

  test('claude: the MCP file is { type: http, url, ${VAR} bearer }, the key is in the plan env and granted, never in the file', () => {
    const h = fakeHost()
    const t = setup({ http: h.http, evaluate: true })
    try {
      const out = t.mw(base(), slotOf('claude'))
      assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, mcpFileOf(t.home, 'abc123')])
      const text = readFileSync(mcpFileOf(t.home, 'abc123'), 'utf8')
      assert.deepEqual(JSON.parse(text), { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: 'http://127.0.0.1:4321/mcp/abc123', headers: { Authorization: `Bearer \${${ENV_BROWSER_MCP_KEY}}` } } } })
      const key = out.env[ENV_BROWSER_MCP_KEY]!
      assert.ok(validKeyShape(key))
      assert.equal(text.includes(key), false, 'the key is not in the MCP file')
      assert.equal(readFileSync(keyFileOf(t.home, 'abc123'), 'utf8').trim(), key, 'the gate reads the same key')
      const g = h.grants.get('abc123')!
      assert.equal(g.key, key)
      assert.equal(t.made.length, 0, 'no server is made before the agent initializes')
      void g.spec.create()
      assert.equal(t.made.length, 1)
      const input = t.made[0]!
      assert.equal(input.endpointFile, endpointFileOf(t.home))
      assert.equal(input.keyFile, keyFileOf(t.home, 'abc123'), 'the server reads the slot\'s key file, as the stdio server did')
      assert.equal(input.evaluate, true)
      assert.equal(input.env.PATH, base().env.PATH, 'the server reads the agent\'s launch env')
      assert.equal(input.env[ENV_BROWSER_MCP_KEY], undefined, 'the server does not get the bearer')
      assert.equal('command' in g.spec, false, 'no process is described: the server runs inside the daemon')
      assert.ok(g.spec.rewriter, 'the texts are corrected in the HTTP path')
    } finally { t.done() }
  })

  test('fallback: soul (no mcp.http), claude while the host is not listening, and claude without the library keep the stdio file; nothing is granted', () => {
    for (const [agent, listening, noBackend] of [['soul', true, false], ['claude', false, false], ['claude', true, true]] as const) {
      const h = fakeHost(listening)
      const t = setup({ http: h.http, noBackend })
      try {
        const out = t.mw(base(), slotOf(agent))
        const cfg = JSON.parse(readFileSync(mcpFileOf(t.home, 'abc123'), 'utf8'))
        assert.equal(cfg.mcpServers[MCP_SERVER_NAME].command, NODE, `${agent}: stdio`)
        assert.equal(out.env[ENV_BROWSER_MCP_KEY], undefined)
        assert.equal(h.grants.size, 0)
      } finally { t.done() }
    }
  })

  test('a failed write revokes the grant and leaves the plan untouched', () => {
    const h = fakeHost()
    const t = setup({ http: h.http })
    try {
      mkdirSync(join(t.home, 'browser'), { recursive: true })
      writeFileSync(join(t.home, 'browser', 'keys'), 'a file where the folder should be')
      const p = base()
      assert.equal(t.mw(p, slotOf('claude')), p)
      assert.equal(h.grants.size, 0)
      assert.deepEqual(h.revoked, ['abc123'])
    } finally { t.done() }
  })
})
