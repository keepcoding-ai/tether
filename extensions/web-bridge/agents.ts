// The Tether Bridge offered to the agents of the panes (F7 C3, design §1.1-d, §1.4, §2.2), as pure rules the daemon
// entry wires and the unit test drives:
//   - the launch middleware: every AI agent launch (never a plain shell) gets the --mcp-config file C2 wrote
//     (<TETHER_HOME>/mcp/tether-bridge.json) through the agent's own AgentContribution.mcp.inject, plus its identity for
//     the bridge in the env: ATRIUM_BRIDGE_CLIENT_ID=tether:<slotId> and ATRIUM_BRIDGE_CLIENT_NAME="<Agent> · <slot name
//     or folder>". The MCP shell turns them into the X-Bridge-Client headers (bridge A5); an older shell ignores them.
//     The switch `extensions.web-bridge.serveToAgents` (D8, default on) leaves the plan untouched when off, and so does a
//     missing MCP file (the setup failed: no half-wired agent) or an agent without `mcp` (it would not know the flag);
//   - the release: when an agent slot exits, POST /clients/<id>/release on the bridge daemon (bearer = the home's api.key,
//     read at that moment and never logged), so the extension lets the agent's tabs go and folds its group (§1.4). Best
//     effort: a daemon that is down, slow or older than A6 (404) is a log line, never an error and never a wait of the slot.
//   - HTTP (an agent whose contribution says `mcp.http`, while the daemon's host listens): the agent gets a per-slot file
//     <TETHER_HOME>/mcp/tether-bridge/<slotId>.json, `{ type: "http", url: /mcp/<slotId>, Bearer ${TETHER_BRIDGE_MCP_KEY} }`,
//     and a fresh key in its env under that name (the CLI expands it; the key exists only in memory and in that env). The
//     host runs the slot's MCP shell INSIDE the daemon (the vendored bundle as a library, with the env of the stdio file and
//     the slot's identity) for as long as the agent's run lives: no process for the bridge, in the agent or in the daemon.
//     The upload authorizations are kept with the slot (grant-store.ts), not in the shell's memory.
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { httpMcpConfigOf } from '../../src/agents/mcp.ts'
import type { AgentContribution } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { SLOT_ID_RE } from '../../src/core/store.ts'
import type { McpBackend, McpSlotRoutes } from '../../src/daemon/mcp-http.ts'
import { writeFileAtomic } from './bridge-home.ts'
import { BridgeMcpRewriter } from './mcp-texts.ts'
import { MCP_SERVER_NAME } from './paths.ts'

export const ENV_CLIENT_ID = 'ATRIUM_BRIDGE_CLIENT_ID'
export const ENV_CLIENT_NAME = 'ATRIUM_BRIDGE_CLIENT_NAME'
/** The env var of the agent's CLI that carries the slot's bearer for the bridge over HTTP. */
export const ENV_BRIDGE_MCP_KEY = 'TETHER_BRIDGE_MCP_KEY'
/** What a slot's bridge shell inside the daemon is made of (the vendored bundle's `createBridgeMcp`). */
export interface BridgeBackendInput {
  slotId: string
  /** The environment the shell reads instead of the daemon's own: the stdio file's env, the agent's launch env and the slot's identity. */
  env: Record<string, string>
  /** The node that starts the bridge daemon when it does not answer. */
  node: string
}

/** The stdio entry of the bridge's --mcp-config (bridge-home.ts mcpConfigOf): its server name, args and env. */
export function readStdioEntry(configFile: string): { name: string; args: string[]; env: Record<string, string> } | undefined {
  try {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8')) as { mcpServers?: Record<string, { args?: unknown; env?: unknown }> }
    const [name, e] = Object.entries(cfg.mcpServers ?? {})[0] ?? []
    if (!name || !e || !Array.isArray(e.args) || !e.args.every(a => typeof a === 'string')) return undefined
    const env = typeof e.env === 'object' && e.env !== null ? Object.fromEntries(Object.entries(e.env).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
    return { name, args: e.args as string[], env }
  } catch { return undefined }
}

/** The bridge's own rules for a client (chrome-extensions/bridge/shared/protocol.ts: CLIENT_ID_PATTERN, CLIENT_NAME_MAX). */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/
export const CLIENT_NAME_MAX = 80

/** `tether:<slotId>`: the agent's identity at the bridge, one per slot, stable across the slot's restarts. */
export const clientIdOf = (slotId: string): string => `tether:${slotId}`

/** "Claude · <slot name>" or "Claude · <folder name>", within the bridge's limit. */
export function clientNameOf(agent: string, slot: Pick<SlotMeta, 'name' | 'cwd'>): string {
  const who = agent.charAt(0).toUpperCase() + agent.slice(1)
  const where = slot.name?.trim() || basename(slot.cwd.replace(/[\\/]+$/, '')) || slot.cwd
  const name = `${who} · ${where}`
  return name.length > CLIENT_NAME_MAX ? `${name.slice(0, CLIENT_NAME_MAX - 1)}…` : name
}

export interface InjectDeps {
  /** The agent contribution of a launch (TetherDaemon.agents.get); undefined = unknown agent, plan untouched. */
  agent(name: string): AgentContribution | undefined
  /** `extensions.web-bridge.serveToAgents`, read at every launch (a setting changed in the app applies to the next start). */
  serve(): boolean
  /** <TETHER_HOME>/mcp/tether-bridge.json. */
  configFile: string
  /** Whether that file is there now (the setup writes it at start; a failed setup leaves none). */
  exists(path: string): boolean
  log(msg: string): void
  /** The daemon's HTTP host, for agents with `mcp.http`; with it, `httpConfigFile` and `node`. */
  http?: McpSlotRoutes
  /** <TETHER_HOME>/mcp/tether-bridge/<slotId>.json (paths.ts httpMcpConfigPathOf). */
  httpConfigFile?(slotId: string): string
  /** The node that starts the bridge daemon (an absolute path), or undefined: then the stdio path. */
  node?(): string | undefined
  /** Makes the slot's shell inside the daemon (daemon.ts: the vendored bundle, imported once). Absent: the stdio path. */
  backend?(input: BridgeBackendInput): McpBackend | Promise<McpBackend>
  /** Injected in the unit test. */
  key?(): string
}

/** The slot's bridge over HTTP ends: the key stops working, the slot's shell is closed, the per-slot file goes. Never throws. */
export function releaseHttp(deps: Pick<InjectDeps, 'http' | 'httpConfigFile'>, slotId: string): void {
  deps.http?.revoke(slotId)
  if (deps.httpConfigFile && SLOT_ID_RE.test(slotId)) rmSync(deps.httpConfigFile(slotId), { force: true })
}

/**
 * The launch middleware (TetherDaemon.launch.use). Returns the plan given (same object) whenever nothing applies, so a
 * test and a reader can tell "untouched" from "rewritten".
 */
export function createLaunchMiddleware(deps: InjectDeps): (plan: LaunchPlan, slot: SlotMeta) => LaunchPlan {
  let warnedMissing = false
  return (plan, slot) => {
    if (slot.agent === 'shell') return plan
    if (!deps.serve()) return plan
    const agent = deps.agent(slot.agent)
    if (!agent?.mcp) return plan
    if (!deps.exists(deps.configFile)) {
      if (!warnedMissing) { warnedMissing = true; deps.log(`${deps.configFile} ausente: agentes lançados sem o bridge até o próximo início do tetherd`) }
      return plan
    }
    warnedMissing = false
    const id = clientIdOf(slot.slotId)
    if (!CLIENT_ID_PATTERN.test(id)) { deps.log(`slot ${slot.slotId}: id de cliente inválido para o bridge; lançado sem identidade`); return agent.mcp.inject(plan, deps.configFile, [MCP_SERVER_NAME]) }
    const identity = { [ENV_CLIENT_ID]: id, [ENV_CLIENT_NAME]: clientNameOf(slot.agent, slot) }
    const viaHttp = agent.mcp.http ? injectHttp(deps, agent, plan, slot, identity) : undefined
    if (viaHttp) return viaHttp
    const out = agent.mcp.inject(plan, deps.configFile, [MCP_SERVER_NAME])
    return { ...out, env: { ...out.env, ...identity } }
  }
}

/** The HTTP injection, or undefined when it does not apply (no host listening, no node, an unreadable stdio file, a failed write). */
function injectHttp(deps: InjectDeps, agent: AgentContribution, plan: LaunchPlan, slot: SlotMeta, identity: Record<string, string>): LaunchPlan | undefined {
  const url = deps.http?.urlOf(slot.slotId)
  const backend = deps.backend
  if (!url || !deps.http || !backend || !deps.httpConfigFile || !SLOT_ID_RE.test(slot.slotId)) return undefined
  const node = deps.node?.()
  const entry = readStdioEntry(deps.configFile)
  if (!node || !entry) return undefined
  const file = deps.httpConfigFile(slot.slotId)
  // A name collision throws here, before anything is written or granted (the launch host logs it, as for the stdio file).
  const out = agent.mcp!.inject(plan, file, [MCP_SERVER_NAME])
  const key = (deps.key ?? (() => randomBytes(24).toString('base64url')))()
  try {
    writeFileAtomic(file, JSON.stringify(httpMcpConfigOf(entry.name, url, ENV_BRIDGE_MCP_KEY), null, 2) + '\n')
  } catch (e) {
    deps.log(`slot ${slot.slotId}: não consegui gravar o MCP HTTP do bridge (${e instanceof Error ? e.message : String(e)}); vai por stdio`)
    return undefined
  }
  const { [ENV_BRIDGE_MCP_KEY]: _, ...env } = { ...out.env, ...entry.env, ...identity }
  // The server's instructions name the tether's screen by its real labels (mcp-texts.ts).
  deps.http.grant(slot.slotId, key, { create: () => backend({ slotId: slot.slotId, env, node }), rewriter: () => new BridgeMcpRewriter() })
  return { ...out, env: { ...out.env, ...identity, [ENV_BRIDGE_MCP_KEY]: key } }
}

export interface ReleaseDeps {
  port: number
  /** <TETHER_HOME>/bridge: api.key is read from here at each call (the key may have been rotated). */
  bridgeHome: string
  log(msg: string): void
  /** Injected in the unit test. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export type ReleaseOutcome = 'released' | 'rejected' | 'unreachable' | 'no-key'

/** POST /clients/<id>/release, best effort: never throws, never logs the key. */
export async function releaseClient(deps: ReleaseDeps, clientId: string): Promise<ReleaseOutcome> {
  let key: string
  try { key = readFileSync(join(deps.bridgeHome, 'api.key'), 'utf8').trim() } catch { deps.log(`release de ${clientId} pulado: api.key ausente em ${deps.bridgeHome}`); return 'no-key' }
  if (!key) { deps.log(`release de ${clientId} pulado: api.key vazia`); return 'no-key' }
  const doFetch = deps.fetch ?? fetch
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 5_000)
  try {
    const r = await doFetch(`http://127.0.0.1:${deps.port}/clients/${encodeURIComponent(clientId)}/release`, {
      method: 'POST', signal: ctl.signal, headers: { authorization: `Bearer ${key}`, connection: 'close' },
    })
    await r.arrayBuffer().catch(() => undefined)
    if (r.ok) { deps.log(`release de ${clientId}: abas soltas no bridge`); return 'released' }
    // 404: a daemon older than the release route (the vendored bundle predates bridge A6); 401: a key out of step. Both are the daemon's to fix.
    deps.log(`release de ${clientId}: o daemon do bridge respondeu ${r.status}`)
    return 'rejected'
  } catch {
    deps.log(`release de ${clientId}: daemon do bridge sem resposta na porta ${deps.port}`)
    return 'unreachable'
  } finally { clearTimeout(t) }
}
