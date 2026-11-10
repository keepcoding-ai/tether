// The browser handed to the agents of the panes (Tether Browser E8, design §3.2, §3.4, §10), as rules the daemon entry wires
// and the unit test drives. At every launch of an AI agent (never a plain shell), when the browser is served to agents:
//   - a NEW key of 192 bits (base64url) is written to `<home>/browser/keys/<slotId>.key` (the gatekeeper's KeyStore reads
//     that folder), replacing the one of a previous run; it is deleted when the agent exits, and the gate then drops the
//     live connection of that key within ~1 s;
//   - `<home>/browser/mcp/<slotId>.json` declares the MCP server `tether-browser`: `node server.mjs --adopt-endpoint-file
//     <endpoint.json> --adopt-key-file <key file> [--allow-evaluate]`. PATHS only: the key's text is in no file but its own,
//     no command line, no env, no log (so nothing depends on the CLI passing env to the MCP server);
//   - the agent's own `mcp.inject` adds that file as one more repeated `--mcp-config` (the bridge's stays; a repeated
//     server name is refused, never overwritten).
// Off (`extensions.browser.serveToAgents`, default off), a missing agent MCP support, a missing server or node, a name
// collision or a failed write: the plan is returned untouched (the same object) and nothing is left on disk.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpNameCollisionError } from '../../src/agents/mcp.ts'
import type { AgentContribution } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { slotMetaPath } from '../../src/core/paths.ts'
import { SLOT_ID_RE } from '../../src/core/store.ts'
import { slotOfKeyFile, validKeyShape } from './gate-rules.ts'
import { ensurePrivateDir } from './private-dir.ts'

/** The MCP server's name, the prefix of the agents' tools (`mcp__tether-browser__*`). Unique among the extensions' servers. */
export const MCP_SERVER_NAME = 'tether-browser'

export const browserDirOf = (home: string): string => join(home, 'browser')
export const keysDirOf = (home: string): string => join(browserDirOf(home), 'keys')
export const mcpDirOf = (home: string): string => join(browserDirOf(home), 'mcp')
export const endpointFileOf = (home: string): string => join(browserDirOf(home), 'endpoint.json')
export const keyFileOf = (home: string, slotId: string): string => join(keysDirOf(home), `${slotId}.key`)
export const mcpFileOf = (home: string, slotId: string): string => join(mcpDirOf(home), `${slotId}.json`)

/** 192 bits of the system's random source, base64url (32 characters). */
export const newKey = (): string => randomBytes(24).toString('base64url')

export interface BrowserMcpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>
}

/** The per-pane MCP file: paths and flags only, never the key's text. */
export function mcpConfigOf(o: { node: string; server: string; endpointFile: string; keyFile: string; evaluate: boolean }): BrowserMcpConfig {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: o.node,
        args: [o.server, '--adopt-endpoint-file', o.endpointFile, '--adopt-key-file', o.keyFile, ...(o.evaluate ? ['--allow-evaluate'] : [])],
      },
    },
  }
}

/** Writes `text` to `path` in one move (temp + rename) with owner-only mode (a no-op on Windows: the folder's DACL rules, private-dir.ts). */
function writeFileAtomic(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try { renameSync(tmp, path) } finally { rmSync(tmp, { force: true }) }
}

/** Removes the key and the MCP file of a slot. Never throws. */
export function releaseSlot(home: string, slotId: string): void {
  if (!SLOT_ID_RE.test(slotId)) return
  rmSync(keyFileOf(home, slotId), { force: true })
  rmSync(mcpFileOf(home, slotId), { force: true })
}

/**
 * At the start of the tetherd that owns the pipe no agent is alive (they die with the daemon): the key and the MCP file of a
 * slot that exists are left over from a daemon that was killed. Only files named after a slot of this home go (a key nobody's
 * slot owns is not ours to judge). Returns how many files went.
 */
export function sweepStale(home: string): number {
  let n = 0
  const sweep = (dir: string, slotOf: (name: string) => string | undefined): void => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { /* no folder */ }
    for (const f of names) {
      const slotId = slotOf(f)
      if (f.endsWith('.tmp') || (slotId !== undefined && existsSync(slotMetaPath(home, slotId)))) { rmSync(join(dir, f), { force: true }); n++ }
    }
  }
  sweep(keysDirOf(home), slotOfKeyFile)
  sweep(mcpDirOf(home), f => (f.endsWith('.json') ? f.slice(0, -5) : undefined))
  return n
}

export interface BrowserInjectDeps {
  home: string
  /** The agent contribution of a launch (TetherDaemon.agents.get); undefined = unknown agent, plan untouched. */
  agent(name: string): AgentContribution | undefined
  /** `extensions.browser.serveToAgents`, read at every launch (a change applies to the next start of an agent). */
  serve(): boolean
  /** `extensions.browser.evaluate`. */
  evaluate(): boolean
  /** The vendored `server.mjs`. */
  server: string
  /** The node that runs it (an absolute path), or undefined when there is none. */
  node(): string | undefined
  log(msg: string): void
  /** Injected in the unit test. */
  exists?(path: string): boolean
  key?(): string
}

/** The launch middleware (TetherDaemon.launch.use). Returns the plan given (same object) whenever nothing applies. */
export function createBrowserLaunchMiddleware(deps: BrowserInjectDeps): (plan: LaunchPlan, slot: SlotMeta) => LaunchPlan {
  const exists = deps.exists ?? existsSync
  const warned = new Set<string>()
  const warnOnce = (id: string, msg: string): void => { if (!warned.has(id)) { warned.add(id); deps.log(msg) } }
  return (plan, slot) => {
    if (slot.agent === 'shell' || !deps.serve()) return plan
    const agent = deps.agent(slot.agent)
    if (!agent?.mcp) return plan
    if (!SLOT_ID_RE.test(slot.slotId)) return plan
    if (!exists(deps.server)) { warnOnce('server', `${deps.server} ausente: agentes lançados sem o navegador`); return plan }
    const node = deps.node()
    if (!node) { warnOnce('node', 'node não encontrado: agentes lançados sem o navegador'); return plan }
    const keyFile = keyFileOf(deps.home, slot.slotId)
    const mcpFile = mcpFileOf(deps.home, slot.slotId)
    // The injection is pure: a refused name leaves the plan and the disk as they were.
    let out: LaunchPlan
    try { out = agent.mcp.inject(plan, mcpFile, [MCP_SERVER_NAME]) } catch (e) {
      if (e instanceof McpNameCollisionError) { deps.log(`slot ${slot.slotId}: ${e.message}; lançado sem o navegador`); return plan }
      throw e
    }
    try {
      const key = (deps.key ?? newKey)()
      if (!validKeyShape(key)) throw new Error('chave gerada com formato inválido')
      // M4: the folders are the owner's alone before a key lands in them (a home outside the profile inherits an open ACL).
      ensurePrivateDir(browserDirOf(deps.home))
      ensurePrivateDir(keysDirOf(deps.home))
      writeFileAtomic(mcpFile, JSON.stringify(mcpConfigOf({ node, server: deps.server, endpointFile: endpointFileOf(deps.home), keyFile, evaluate: deps.evaluate() }), null, 2) + '\n')
      writeFileAtomic(keyFile, `${key}\n`)
    } catch (e) {
      releaseSlot(deps.home, slot.slotId)
      deps.log(`slot ${slot.slotId}: não consegui preparar a chave do navegador (${e instanceof Error ? e.message : String(e)}); lançado sem o navegador`)
      return plan
    }
    return out
  }
}
