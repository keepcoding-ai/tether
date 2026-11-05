// The agent registry (F9 §4.8): every agent tether can launch in a slot (except the built-in 'shell') is a
// contribution registered here, by the core's built-ins (builtin.ts) or by a daemon extension through
// TetherDaemon.agents. Same shape as the renderer's pane registry: register returns a disposable, a second
// registration of the same name is refused. Readers never lose a slot over an unknown name: they accept any
// non-empty string and ask the registry only when they need to launch (agent-unavailable otherwise).
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentName } from '../core/event.ts'
import type { Profile } from '../core/profile.ts'
import type { AttentionOptions } from '../daemon/attention.ts'
import type { AgentAdapter } from './types.ts'

export interface AgentContribution {
  /** What goes in SlotMeta.agent / TetherEvent.agent: lowercase, never 'shell'. */
  name: AgentName
  adapter: AgentAdapter
  /** How the daemon reads "done"/"waiting" from this agent's output (attention.ts). */
  attention: AttentionOptions
  /** Profiles this agent brings to a fresh profiles.json. */
  defaultProfiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Profile[]
  /** Args tether decides per launch (flag -> why, in Portuguese); a profile must not carry them. */
  reservedArgs: Record<string, string>
  /** Env var with args appended to every launch by the daemon (dev/E2E: `--model haiku`). */
  envArgsVar?: string
}

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

export class AgentRegistry {
  private readonly byName = new Map<string, AgentContribution>()

  register(agent: AgentContribution): IDisposable {
    if (!AGENT_NAME_RE.test(agent.name) || agent.name === 'shell') throw new Error(`nome de agente inválido: ${JSON.stringify(agent.name)}`)
    if (this.byName.has(agent.name)) throw new Error(`o agente ${agent.name} já está registrado`)
    if (agent.adapter.name !== agent.name) throw new Error(`o adaptador do agente ${agent.name} se chama ${agent.adapter.name}`)
    this.byName.set(agent.name, agent)
    return toDisposable(() => {
      if (this.byName.get(agent.name) === agent) this.byName.delete(agent.name)
    })
  }

  get(name: string): AgentContribution | undefined {
    return this.byName.get(name)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  /** In registration order (the built-ins first): the order default profiles are listed in. */
  all(): AgentContribution[] {
    return [...this.byName.values()]
  }

  names(): string[] {
    return [...this.byName.keys()]
  }
}

/** The process-wide registry (tetherd, the CLI, the doctor). */
export const agentRegistry = new AgentRegistry()

/** Shape check used by every reader of persisted state: any plausible name, registered or not. */
export function isAgentName(x: unknown): x is AgentName {
  return typeof x === 'string' && x !== 'shell' && AGENT_NAME_RE.test(x)
}

/** "use claude, soul ou shell", from what is registered now. */
export function agentChoices(withShell = true): string {
  const names = [...agentRegistry.names(), ...(withShell ? ['shell'] : [])]
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ou ${names[names.length - 1]}`
}
