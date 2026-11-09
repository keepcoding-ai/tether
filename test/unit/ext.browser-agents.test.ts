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
  MCP_SERVER_NAME, createBrowserLaunchMiddleware, endpointFileOf, keyFileOf, keysDirOf, mcpConfigOf, mcpDirOf, mcpFileOf, newKey, releaseSlot, sweepStale,
} from '../../extensions/browser/agents.ts'
import { KeyStore } from '../../extensions/browser/gate-keys.ts'
import { validKeyShape } from '../../extensions/browser/gate-rules.ts'
import { MCP_CONFIG_FLAG } from '../../src/agents/mcp.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'

const registry = new AgentRegistry()
new DaemonExtensionHost({ home: 'C:/unused', log: () => {}, agents: registry, extensions: daemonIndex.filter(e => e.manifest.id === 'claude' || e.manifest.id === 'soul') }).activate()

const SERVER = 'C:/app/extensions/browser/vendor/tether-browser/server.mjs'
const NODE = 'C:/Program Files/nodejs/node.exe'
const BRIDGE = 'C:/home/mcp/tether-bridge.json'
const base = (): LaunchPlan => ({ command: 'agent.exe', args: ['--model', 'haiku'], cwd: 'D:/w', env: { PATH: 'p' } })
const slotOf = (agent: SlotMeta['agent'], slotId = 'abc123'): SlotMeta => ({ slotId, agent, cwd: 'D:/w', createdAt: '2026-11-09T00:00:00Z' } as SlotMeta)

function setup(over: { serve?: boolean; evaluate?: boolean; node?: string | undefined; exists?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tether-bragents-'))
  const logs: string[] = []
  const mw = createBrowserLaunchMiddleware({
    home,
    agent: n => registry.get(n),
    serve: () => over.serve ?? true,
    evaluate: () => over.evaluate ?? false,
    server: SERVER,
    node: () => ('node' in over ? over.node : NODE),
    log: m => logs.push(m),
    exists: () => over.exists ?? true,
  })
  return { home, logs, mw, done: () => rmSync(home, { recursive: true, force: true }) }
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

  test('sweepStale clears the keys and MCP files a killed tetherd left, and nothing else', () => {
    const t = setup()
    try {
      t.mw(base(), slotOf('claude', 'one'))
      t.mw(base(), slotOf('soul', 'two'))
      writeFileSync(join(t.home, 'browser', 'endpoint.json'), '{}')
      assert.equal(sweepStale(t.home), 4)
      assert.deepEqual(readdirSync(keysDirOf(t.home)), [])
      assert.deepEqual(readdirSync(mcpDirOf(t.home)), [])
      assert.ok(existsSync(join(t.home, 'browser', 'endpoint.json')))
      assert.equal(sweepStale(join(t.home, 'nowhere')), 0)
    } finally { t.done() }
  })
})
