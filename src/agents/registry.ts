// The agent registry (F9 §4.8): every agent tether can launch in a slot (except the built-in 'shell') is a
// contribution a daemon extension registers through TetherDaemon.agents (claude and soul are the built-in extensions
// extensions/claude and extensions/soul, F9 slice 4). tetherd activates its extensions at startup; any other process
// (CLI, Electron main, doctor) gets them on its first read of the registry through the loader src/agents/load.ts sets. Same shape as the renderer's pane registry: register returns a disposable, a second
// registration of the same name is refused. Readers never lose a slot over an unknown name: they accept any
// non-empty string and ask the registry only when they need to launch (agent-unavailable otherwise).
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentName } from '../core/event.ts'
import type { Profile } from '../core/profile.ts'
import type { AttentionOptions } from '../daemon/attention.ts'
import type { AgentSkills } from './skills.ts'
import type { AgentAdapter, LaunchPlan } from './types.ts'

/** How this agent's CLI loads an MCP config file (`{ "mcpServers": {...} }`); absent = the agent takes no MCP servers. */
export interface AgentMcp {
  /**
   * `plan` with the servers of `configFile` added (a copy). The env those servers read is set by the caller on the plan.
   * Several extensions may inject into one plan (one repeated `--mcp-config` each, registration order). `servers` declares
   * the server names the file holds: a name already injected from another file throws McpNameCollisionError.
   */
  inject(plan: LaunchPlan, configFile: string, servers?: readonly string[]): LaunchPlan | Promise<LaunchPlan>
  /**
   * The CLI loads `{ "type": "http", "url", "headers" }` servers and expands `${VAR}` in their headers from its env
   * (httpMcpConfigOf). Then the extensions serve it from the daemon (src/daemon/mcp-http.ts) and the agent spawns no MCP
   * process; absent = the stdio files, as always.
   */
  http?: boolean
}

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
  /** MCP servers a daemon extension offers to every AI agent (F7 C3: the Tether Bridge) reach this agent through here. */
  mcp?: AgentMcp
  /**
   * How this agent takes the tether's skills (src/agents/skills.ts): its native format when it has one, else
   * `systemPromptSkills(<its system prompt flag>)`. Absent = the agent gets no skills.
   */
  skills?: AgentSkills
  /**
   * The CLI takes channel messages from an MCP server (Claude Code: `notifications/claude/channel`): the args that turn them
   * on for the server named `server`. Only with `mcp.http`: the daemon's ronda channel (src/daemon/ronda-channel.ts) is an
   * HTTP server. Absent = the agent has no channel and the ronda is unavailable to it.
   */
  channel?: (server: string) => string[]
  /**
   * The args that turn on the channels of SEVERAL servers in one launch (the ronda's and the agent door's `tether`).
   * Absent: the core joins the values of `channel(server)` under the first flag.
   */
  channels?: (servers: readonly string[]) => string[]
  /**
   * The plan with the agent door's channel turned on, for a CLI whose channel flag cannot simply go first or depends on the
   * rest of the command line (soul: its plan may start with the script node runs, and `--channels` is refused next to a remote
   * host). Undefined: this launch takes no channel. Without the ronda it wins over `channel`/`channels` for the door's channel;
   * the ronda's channel still needs `channel`.
   */
  channelPlan?: (plan: LaunchPlan, servers: readonly string[]) => LaunchPlan | undefined
  /**
   * How this CLI takes a typed and submitted text (agent door delivery through the terminal): the chunks to write, each
   * after its wait. Absent: the core's default (door/typing.ts).
   */
  typing?: { submit(text: string): { data: string; waitMs?: number }[] }
  /** The confirmation the CLI shows at start for those args, which the daemon answers only when it sees it exactly. */
  channelConfirm?: ChannelConfirm
}

/**
 * A start dialog the daemon may answer: only before the run's start report, only when every fragment is on screen (compared
 * without escape sequences and whitespace), and then it types `keys` once. A screen that does not match gets nothing.
 */
export interface ChannelConfirm {
  screen: string[]
  keys: string
}

/**
 * The args that turn on the channels of `servers` in one launch. With `channels`, the agent says; else the values of each
 * `channel(server)` go under the first server's flag (`--flag server:a server:b`: one flag, one start dialog; a repeated flag
 * is unproven). An args list of another flag is kept whole. No channel, or no server: [].
 */
export function channelArgsOf(agent: Pick<AgentContribution, 'channel' | 'channels'>, servers: readonly string[]): string[] {
  if (servers.length === 0) return []
  if (agent.channels) return agent.channels(servers)
  const channel = agent.channel
  if (!channel) return []
  const [first, ...rest] = servers.map((s) => channel(s))
  const flag = first![0]
  return [...first!, ...rest.flatMap((a) => (a[0] === flag ? a.slice(1) : a))]
}

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

export class AgentRegistry {
  private readonly byName = new Map<string, AgentContribution>()
  private loader: (() => void) | undefined
  private loaded = false

  /** Runs once, on the first read, unless someone already filled the registry (markLoaded). */
  setLoader(loader: () => void): void {
    this.loader = loader
  }

  /** The registry is being filled by a host of its own (tetherd's): the lazy loader never runs. */
  markLoaded(): void {
    this.loaded = true
  }

  private ensure(): void {
    if (this.loaded || !this.loader) return
    this.loaded = true
    this.loader()
  }

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
    this.ensure()
    return this.byName.get(name)
  }

  has(name: string): boolean {
    this.ensure()
    return this.byName.has(name)
  }

  /** In registration order (the daemon index's order: claude, soul, then the others): the order default profiles are listed in. */
  all(): AgentContribution[] {
    this.ensure()
    return [...this.byName.values()]
  }

  names(): string[] {
    this.ensure()
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
