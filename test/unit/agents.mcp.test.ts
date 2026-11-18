// The MCP part of the launch plan (slice N4): several extensions inject one config file each into the same agent plan; the
// result is one repeated `--mcp-config <file>` per file (the only form soul reads), in injection order, always after the
// slot's own args. One file keeps the command line it always had; a server name taken by another file is refused.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { MCP_CONFIG_FLAG, McpNameCollisionError, withMcpConfigFlag } from '../../src/agents/mcp.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'

const base = (): LaunchPlan => ({ command: 'agent.exe', args: ['--settings', 'x.json', '--model', 'haiku'], cwd: 'D:\w', env: { PATH: 'p' } })
const A = 'C:/h/mcp/a.json'
const B = 'C:/h/mcp/b.json'

const registry = new AgentRegistry()
const host = new DaemonExtensionHost({ home: 'C:/unused', log: () => {}, agents: registry, extensions: daemonIndex.filter(e => e.manifest.id === 'claude' || e.manifest.id === 'soul') })
host.activate()

for (const agent of ['claude', 'soul']) {
  describe(`${agent}: MCP files in the launch plan`, () => {
    // claude and soul inject synchronously (the contract also allows a promise, which codex's file read needs).
    const inject = registry.get(agent)!.mcp!.inject as (plan: LaunchPlan, file: string, servers?: readonly string[]) => LaunchPlan

    test('no file: the plan is not touched', () => {
      const p = base()
      assert.deepEqual(p.args, base().args)
      assert.equal(p.mcpServers, undefined)
    })

    test('one file: the command line is the same as before (flag + file last), with or without declared servers', () => {
      const want = [...base().args, MCP_CONFIG_FLAG, A]
      assert.deepEqual(inject(base(), A).args, want)
      assert.deepEqual(inject(base(), A, ['alpha']).args, want)
    })

    test('two files: the flag is repeated once per file, in injection order, after the slot args', () => {
      const out = inject(inject(base(), A, ['alpha']), B, ['beta'])
      assert.deepEqual(out.args, [...base().args, MCP_CONFIG_FLAG, A, MCP_CONFIG_FLAG, B])
      assert.deepEqual(out.mcpServers, { alpha: A, beta: B })
      const flipped = inject(inject(base(), B, ['beta']), A, ['alpha'])
      assert.deepEqual(flipped.args.slice(-4), [MCP_CONFIG_FLAG, B, MCP_CONFIG_FLAG, A])
    })

    test('a server name taken by another file is refused with a clear error; the plan given is not mutated', () => {
      const first = inject(base(), A, ['alpha', 'shared'])
      const snapshot = JSON.stringify(first)
      assert.throws(() => inject(first, B, ['beta', 'shared']), (e: unknown) => e instanceof McpNameCollisionError && /"shared".*a\.json.*b\.json/.test(e.message))
      assert.equal(JSON.stringify(first), snapshot)
    })

    test('the same file injected twice with the same names is not a collision', () => {
      assert.doesNotThrow(() => inject(inject(base(), A, ['alpha']), A, ['alpha']))
    })

    test('files without declared names are never checked (older callers)', () => {
      assert.doesNotThrow(() => inject(inject(base(), A), B, ['alpha']))
    })
  })
}

test('withMcpConfigFlag is the injector of both agents', () => {
  for (const a of ['claude', 'soul']) assert.equal(registry.get(a)!.mcp!.inject, withMcpConfigFlag)
})
