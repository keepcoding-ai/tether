// The Tether Bridge offered to the agents of the panes (F7 C3, design §1.1-d, §1.4, §2.2), as pure rules the daemon
// entry wires and the unit test drives:
//   - the MCP itself is the feature `bridge` (manifest.ts): tetherd composes it into the launch's share folder and the
//     agent's AgentContribution.share hands that to the CLI (src/daemon/ext-host.ts), with the switches of the feature
//     (profile > settings.json `agents.features.bridge` > on). A missing MCP file (the setup failed) is a feature with
//     no content: the agent launches without it;
//   - the launch middleware: while the feature is on for the launch, an AI agent (never a plain shell) that takes the
//     features (`share`) gets its identity for the bridge in the env: ATRIUM_BRIDGE_CLIENT_ID=tether:<slotId> and
//     ATRIUM_BRIDGE_CLIENT_NAME="<Agent> · <slot name or folder>". The MCP shell turns them into the X-Bridge-Client
//     headers (bridge A5); an older shell ignores them. Feature off, or an agent without `share`: the plan untouched;
//   - the release: when an agent slot exits, POST /clients/<id>/release on the bridge daemon (bearer = the home's api.key,
//     read at that moment and never logged), so the extension lets the agent's tabs go and folds its group (§1.4). Best
//     effort: a daemon that is down, slow or older than A6 (404) is a log line, never an error and never a wait of the slot.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentContribution } from '../../src/agents/registry.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { paneDisplayName } from '../../src/core/pane-name.ts'
import type { LaunchContext } from '../../src/daemon/ext-api.ts'
import { BRIDGE_FEATURE } from './manifest.ts'

export const ENV_CLIENT_ID = 'ATRIUM_BRIDGE_CLIENT_ID'
export const ENV_CLIENT_NAME = 'ATRIUM_BRIDGE_CLIENT_NAME'

/** The bridge's own rules for a client (chrome-extensions/bridge/shared/protocol.ts: CLIENT_ID_PATTERN, CLIENT_NAME_MAX). */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/
export const CLIENT_NAME_MAX = 80

/** `tether:<slotId>`: the agent's identity at the bridge, one per slot, stable across the slot's restarts. */
export const clientIdOf = (slotId: string): string => `tether:${slotId}`

/** "Claude · <slot name>" or "Claude · <folder name>", within the bridge's limit (the rule is shared: src/core/pane-name.ts). */
export const clientNameOf = (agent: string, slot: Pick<SlotMeta, 'name' | 'cwd'>): string => paneDisplayName(agent, slot, CLIENT_NAME_MAX)

export interface InjectDeps {
  /** The agent contribution of a launch (TetherDaemon.agents.get); undefined = unknown agent, plan untouched. */
  agent(name: string): AgentContribution | undefined
  log(msg: string): void
}

/**
 * The launch middleware (TetherDaemon.launch.use). Returns the plan given (same object) whenever nothing applies, so a
 * test and a reader can tell "untouched" from "rewritten".
 */
export function createLaunchMiddleware(deps: InjectDeps): (plan: LaunchPlan, slot: SlotMeta, ctx: LaunchContext) => LaunchPlan {
  return (plan, slot, ctx) => {
    if (slot.agent === 'shell') return plan
    if (!ctx.features.has(BRIDGE_FEATURE)) return plan
    const agent = deps.agent(slot.agent)
    if (!agent?.share) return plan
    const id = clientIdOf(slot.slotId)
    if (!CLIENT_ID_PATTERN.test(id)) { deps.log(`slot ${slot.slotId}: id de cliente inválido para o bridge; lançado sem identidade`); return plan }
    return { ...plan, env: { ...plan.env, [ENV_CLIENT_ID]: id, [ENV_CLIENT_NAME]: clientNameOf(slot.agent, slot) } }
  }
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
