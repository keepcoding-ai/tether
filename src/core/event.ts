// Contracts shared by the core, the agent adapters and the CLI.
// One event = one JSON line in <home>/slots/<slotId>.jsonl (append-only).

export type AgentName = 'claude' | 'soul'

/**
 * What happened to the slot's session:
 * - start:  a session became the active one of the slot (new, resume, continue, clear, compact, fork, branch, new...)
 * - rename: the active session got a title (id unchanged)
 * - end:    the agent said the session ended (unreliable on kill; liveness comes from the PID, not from this)
 */
export type EventKind = 'start' | 'rename' | 'end'

/** Exactly how to reopen a session: run `<agent> ...args` in `cwd`, with `env` added. */
export interface ResumeRecipe {
  cwd: string
  args: string[]
  env?: Record<string, string>
}

export interface TetherEvent {
  v: 1
  /** ISO timestamp. */
  ts: string
  slotId: string
  agent: AgentName
  kind: EventKind
  /** The agent's own word for why (claude: startup|resume|clear|compact|fork, reason on end; soul: startup|resume|continue|new|clear|branch|fork|rename|end). */
  source: string
  sessionId: string
  title?: string
  cwd?: string
  /** Present on `start`: how to resume this session later. */
  resume?: ResumeRecipe
  /** The agent's raw payload, kept for debugging. */
  raw?: unknown
}

/** The slot's identity, written once at creation: <home>/slots/<slotId>.json */
export interface SlotMeta {
  v: 1
  slotId: string
  name?: string
  /** 'shell' = plain shell slot (no session, never emits events). */
  agent: AgentName | 'shell'
  /** Folder the slot was created in. The binding's cwd wins once there is one. */
  cwd: string
  /** Extra agent args given at creation (e.g. soul's -a/-H). Kept for new sessions of this slot. */
  args: string[]
  createdAt: string
  /** The launch profile (core/profile.ts) applied, as it is now, on every start. Absent on slots created without one. */
  profileId?: string
  /** Snapshot of the profile's launch args/env from its last run: used when the profile no longer exists. */
  profileArgs?: string[]
  profileEnv?: Record<string, string>
}

/** Who is running the slot right now: <home>/slots/<slotId>.run.json (written by the launcher). */
export interface RunInfo {
  /** The tether launcher process. */
  pid: number
  /** The agent process (child of the launcher). */
  agentPid?: number
  /** Process start time as reported by the OS, to tell a reused PID apart. */
  startedAt: string
  /** The agent's own start time (tetherd records it so a later tetherd can prove an orphan is this very process). */
  agentStartedAt?: string
  /** Who wrote it: tetherd (pid = the daemon) or absent = a CLI `--here` launcher. Only tetherd's own runs are ever reaped. */
  by?: 'tetherd'
}

/** The slot's current session, derived from its events. */
export interface Binding {
  slotId: string
  agent: AgentName
  sessionId: string
  cwd: string
  resume?: ResumeRecipe
  title?: string
  /** ts of the `start` event that made this the active session. */
  since: string
  /** true when it came from an agent event; false when inferred (never resume an unconfirmed binding silently). */
  confirmed: boolean
  /** The last event seen for this session was `end`. */
  ended: boolean
}
