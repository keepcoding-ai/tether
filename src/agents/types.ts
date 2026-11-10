import type { AgentName, Binding, SlotMeta } from '../core/event.ts'
import type { ProfileLaunch } from '../core/profile.ts'

/** Where to look for the agent's own files (claude: the slot's CLAUDE_CONFIG_DIR comes from its profile env). */
export interface LookupOptions {
  env?: Record<string, string>
}

/** What the launcher runs: the full command, already decided by the adapter. */
export interface LaunchPlan {
  command: string
  args: string[]
  cwd: string
  /** The COMPLETE environment for the child (the adapter starts from process.env and cleans what it must). */
  env: Record<string, string>
  /** MCP server names already injected into this plan, name -> config file (bookkeeping for collision checks; absent until a declared injection). */
  mcpServers?: Record<string, string>
}

export interface PlanInput {
  slot: SlotMeta
  /** TETHER_HOME in use (goes to the child so the reporter writes to the same place). */
  home: string
  /** Resume this session; absent = start a new one. */
  resume?: Binding
  /** Args typed by the user for this launch only. */
  extraArgs: string[]
  /** The slot's launch profile (args before the slot's own, env on top of the adapter's cleaned env). */
  profile?: ProfileLaunch
}

export interface AgentAdapter {
  name: AgentName
  plan(input: PlanInput): LaunchPlan
  /** Does the agent still have this session? 'unknown' when it cannot be told locally (e.g. soul over -H). */
  sessionExists(binding: Binding, opts?: LookupOptions): Promise<boolean | 'unknown'>
  /** The session's current title, if the agent keeps one where we can read it. */
  title(binding: Binding, opts?: LookupOptions): Promise<string | undefined>
  /**
   * Follows the title while the session runs, for agents whose renames do not reach the slot's jsonl
   * (Claude writes them to the transcript). `onTitle` fires on every change; the returned function stops it.
   */
  watchTitle?(binding: Binding, onTitle: (title: string) => void, intervalMs?: number, opts?: LookupOptions): () => void
}

/** Env vars the launcher sets for every slot (adapters add their own). */
export const ENV_SLOT = 'TETHER_SLOT_ID'
export const ENV_HOME = 'TETHER_HOME'
/** The kind of agent in the pane (`claude`, `soul`…): each adapter sets its own name, so skills can tell their platform. */
export const ENV_AGENT = 'TETHER_AGENT'
