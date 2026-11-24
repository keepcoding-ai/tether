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
// Not served (`extensions.browser.serveToAgents`, per profile by default), a missing agent MCP support, a missing server or node, a name
// collision or a failed write: the plan is returned untouched (the same object) and nothing is left on disk.
//
// HTTP (an agent whose contribution says `mcp.http`, while the daemon's host listens): the MCP file declares
// `{ type: "http", url: http://127.0.0.1:<port>/mcp/<slotId>, headers: { Authorization: "Bearer ${TETHER_BROWSER_MCP_KEY}" } }`
// and the key goes in the plan's env under that name (the CLI expands it): the MCP file still holds no key. The same key is
// granted to the host for that slot, and the host runs the slot's server INSIDE the daemon (the vendored bundle as a library,
// with the same rewriting, mcp-texts.ts) for as long as the agent's run lives: no process for the browser, in the agent or in
// the daemon, and nothing is stopped for being idle. What the tool knows the tabs by is kept with the tabs (agent-tabs.ts).
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { httpMcpConfigOf, McpNameCollisionError, mcpHttpFor } from '../../src/agents/mcp.ts'
import type { AgentContribution } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { slotMetaPath } from '../../src/core/paths.ts'
import { SLOT_ID_RE } from '../../src/core/store-model.ts'
import type { McpBackend, McpSlotRoutes } from '../../src/daemon/mcp-http.ts'
import { slotOfKeyFile, validKeyShape } from './gate-rules.ts'
import { McpRewriter } from './mcp-texts.ts'
import { ensurePrivateDirAsync } from './private-dir-core.ts'
import type { DaemonIo } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'

/** The env var of the agent's CLI that carries the slot's key to the HTTP server's bearer (never in a file but the key file). */
export const ENV_BROWSER_MCP_KEY = 'TETHER_BROWSER_MCP_KEY'

/** What a slot's server inside the daemon is made of (the vendored bundle's `createTetherBrowserServer`). */
export interface BrowserBackendInput {
  endpointFile: string
  keyFile: string
  evaluate: boolean
  /** The environment the server reads instead of the daemon's own (the agent's launch env, without the bearer). */
  env: Record<string, string>
}

/** The daemon's HTTP host of the browser server (src/daemon/mcp-http.ts McpHttpHost), as the middleware uses it. */
export type BrowserHttpHost = McpSlotRoutes

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
export function mcpConfigOf(o: { node: string; server: string; proxy?: string; endpointFile: string; keyFile: string; evaluate: boolean }): BrowserMcpConfig {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: o.node,
        // With the proxy (mcp-proxy.mjs) the server is its first argument: it relays the server's stdio and corrects its texts.
        args: [...(o.proxy ? [o.proxy] : []), o.server, '--adopt-endpoint-file', o.endpointFile, '--adopt-key-file', o.keyFile, ...(o.evaluate ? ['--allow-evaluate'] : [])],
      },
    },
  }
}

/** Removes the key and the MCP file of a slot (through `io`: on tetherd's executor). Never throws. */
export async function releaseSlot(home: string, slotId: string, io: DaemonIo = fsIo): Promise<void> {
  if (!SLOT_ID_RE.test(slotId)) return
  await Promise.all([keyFileOf(home, slotId), mcpFileOf(home, slotId)].map(f => io.rm(f).catch(() => undefined)))
}

/**
 * At the start of the tetherd that owns the pipe no agent is alive (they die with the daemon): the key and the MCP file of a
 * slot that exists are left over from a daemon that was killed. Only files named after a slot of this home go (a key nobody's
 * slot owns is not ours to judge). Returns how many files went.
 */
export async function sweepStale(home: string, io: DaemonIo = fsIo): Promise<number> {
  // The sweep runs beside the loop, so an agent may launch while it works: a file written since the sweep began is a live
  // agent's, never leftover (a killed daemon's files are older than this start).
  const since = Date.now()
  let n = 0
  const sweep = async (dir: string, slotOf: (name: string) => string | undefined): Promise<void> => {
    let names: string[] = []
    try { names = (await io.readdir(dir)).map(d => d.name) } catch { /* no folder */ }
    for (const f of names) {
      const slotId = slotOf(f)
      if (f.endsWith('.tmp') || (slotId !== undefined && await io.exists(slotMetaPath(home, slotId)).catch(() => false))) {
        const fresh = await io.stat(join(dir, f)).then(st => st.mtimeMs >= since, () => false)
        if (fresh) continue
        await io.rm(join(dir, f)); n++
      }
    }
  }
  await sweep(keysDirOf(home), slotOfKeyFile)
  await sweep(mcpDirOf(home), f => (f.endsWith('.json') ? f.slice(0, -5) : undefined))
  return n
}

export interface BrowserInjectDeps {
  home: string
  /** The agent contribution of a launch (TetherDaemon.agents.get); undefined = unknown agent, plan untouched. */
  agent(name: string): AgentContribution | undefined
  /** Whether this launch gets the browser (`extensions.browser.serveToAgents` and the slot's profile), read at every launch (a change applies to the next start of an agent). */
  serve(slot: SlotMeta): boolean
  /** `extensions.browser.evaluate`. */
  evaluate(): boolean
  /** The vendored `server.mjs`. */
  server: string
  /** The stdio proxy that runs the server and corrects what it tells the agent (mcp-proxy.mjs); without it (or when missing) the server runs bare. */
  proxy?: string
  /** The node that runs it (an absolute path), or undefined when there is none. */
  node(): string | undefined | Promise<string | undefined>
  log(msg: string): void
  /** The daemon's HTTP host, for agents with `mcp.http`; with it, `backend`. */
  http?: BrowserHttpHost
  /** Makes the slot's server inside the daemon (daemon.ts: the vendored bundle, imported once). Absent: the stdio path. */
  backend?(input: BrowserBackendInput): McpBackend | Promise<McpBackend>
  /** The disk (`api.io`). Default: node's async file API (unit tests, CLI). */
  io?: DaemonIo
  /** Injected in the unit test. */
  exists?(path: string): boolean | Promise<boolean>
  key?(): string
}

/**
 * The launch middleware (TetherDaemon.launch.use). Returns the plan given (same object) whenever nothing applies. The key and the MCP
 * file are written through `io` and awaited: they are on disk when the promise resolves, before the agent is spawned.
 */
export function createBrowserLaunchMiddleware(deps: BrowserInjectDeps): (plan: LaunchPlan, slot: SlotMeta) => Promise<LaunchPlan> {
  const io = deps.io ?? fsIo
  const exists = deps.exists ?? ((p: string) => io.exists(p))
  const warned = new Set<string>()
  const warnOnce = (id: string, msg: string): void => { if (!warned.has(id)) { warned.add(id); deps.log(msg) } }
  return async (plan, slot) => {
    if (slot.agent === 'shell' || !deps.serve(slot)) return plan
    const agent = deps.agent(slot.agent)
    if (!agent?.mcp) return plan
    if (!SLOT_ID_RE.test(slot.slotId)) return plan
    if (!await exists(deps.server)) { warnOnce('server', `${deps.server} ausente: agentes lançados sem o navegador`); return plan }
    const node = await deps.node()
    if (!node) { warnOnce('node', 'node não encontrado: agentes lançados sem o navegador'); return plan }
    const keyFile = keyFileOf(deps.home, slot.slotId)
    const mcpFile = mcpFileOf(deps.home, slot.slotId)
    // The injection is pure: a refused name leaves the plan and the disk as they were.
    let out: LaunchPlan
    try { out = await agent.mcp.inject(plan, mcpFile, [MCP_SERVER_NAME]) } catch (e) {
      if (e instanceof McpNameCollisionError) { deps.log(`slot ${slot.slotId}: ${e.message}; lançado sem o navegador`); return plan }
      throw e
    }
    const backend = deps.backend
    const url = mcpHttpFor(agent.mcp, plan) && backend ? deps.http?.urlOf(slot.slotId) : undefined
    try {
      const key = (deps.key ?? newKey)()
      if (!validKeyShape(key)) throw new Error('chave gerada com formato inválido')
      const evaluate = deps.evaluate()
      // M4: the folders are the owner's alone before a key lands in them (a home outside the profile inherits an open ACL).
      await ensurePrivateDirAsync(browserDirOf(deps.home))
      await ensurePrivateDirAsync(keysDirOf(deps.home))
      if (url && deps.http && backend) {
        await io.writeTextAtomic(mcpFile, JSON.stringify(httpMcpConfigOf(MCP_SERVER_NAME, url, ENV_BROWSER_MCP_KEY), null, 2) + '\n')
        await io.writeTextAtomic(keyFile, `${key}\n`)
        const { [ENV_BROWSER_MCP_KEY]: _, ...childEnv } = out.env
        deps.http.grant(slot.slotId, key, {
          create: () => backend({ endpointFile: endpointFileOf(deps.home), keyFile, evaluate, env: childEnv }),
          rewriter: () => new McpRewriter({ evaluate }),
        })
        return { ...out, env: { ...out.env, [ENV_BROWSER_MCP_KEY]: key } }
      }
      const proxy = deps.proxy && await exists(deps.proxy) ? deps.proxy : undefined
      await io.writeTextAtomic(mcpFile, JSON.stringify(mcpConfigOf({ node, server: deps.server, ...(proxy ? { proxy } : {}), endpointFile: endpointFileOf(deps.home), keyFile, evaluate }), null, 2) + '\n')
      await io.writeTextAtomic(keyFile, `${key}\n`)
    } catch (e) {
      deps.http?.revoke(slot.slotId)
      await releaseSlot(deps.home, slot.slotId, io)
      deps.log(`slot ${slot.slotId}: não consegui preparar a chave do navegador (${e instanceof Error ? e.message : String(e)}); lançado sem o navegador`)
      return plan
    }
    return out
  }
}
