// Contract between tetherd (owns the PTYs) and its clients (the app, the CLI).
// Transport: a named pipe (Windows) / unix socket, newline-delimited JSON, one message per line.
// Terminal bytes travel as UTF-8 strings (node-pty emits strings).

import type { AgentName, Binding } from '../core/event.ts'
import type { PerfSnapshot } from '../core/perf.ts'
import type { Probe } from '../core/perf-probe.ts'
import type { Profile, ProfileInput } from '../core/profile.ts'
import type { PauseBatch } from './pause.ts'
import type { Ronda } from './ronda.ts'
import type { ProcBy, ProcEvent, ProcRecipe, ProcState } from './procs.ts'
import type { PortRow } from './ports.ts'

export type { PerfSnapshot, Probe, Profile, ProfileInput, PauseBatch, Ronda, ProcBy, ProcEvent, ProcRecipe, ProcState, PortRow }

export const PROTOCOL_VERSION = 1

/**
 * Youngest an agent may be when tether kills it (stop, forget, shutdown, `set-profile` restart): Claude counts
 * a session that dies before it finished starting as a boot strike (three strikes write `fullscreenAutoDisabled`
 * to ~/.claude.json and fullscreen stays off for the whole machine), the house rule is 11 s, and the agent starts
 * a little after the PTY spawn the age is measured from, hence one more second. Besides the age, a kill waits
 * for the agent's start report (the SessionStart hook: the agent finished starting), up to KILL_WAIT_CAP_MS.
 * A `stop` can therefore take that long to answer.
 */
export const MIN_AGENT_AGE_MS = 12_000
/** Longest a kill waits for a young agent before killing it anyway, so a shutdown can never hang. */
export const KILL_WAIT_CAP_MS = 30_000

/** Slot kinds: any registered agent (claude, soul, an extension's), plus a plain shell (no session; "resume" = new shell in the same folder). */
export type SlotKind = AgentName | 'shell'

/** `\\.\pipe\tether-<user>` on Windows, `<home>/tetherd.sock` elsewhere; TETHER_PIPE overrides. */
export function pipePath(home: string, user: string, platform: NodeJS.Platform = process.platform): string {
  if (process.env.TETHER_PIPE) return process.env.TETHER_PIPE
  return platform === 'win32' ? `\\\\.\\pipe\\tether-${user}` : `${home}/tetherd.sock`
}

export type SlotStatus =
  | 'running'      // process alive in a PTY
  | 'queued'       // waiting its turn in a batch resume (max 3 starting at once)
  | 'starting'     // process spawned, agent not ready/confirmed yet
  | 'exited'       // no process; can be started again (resume)
  | 'unconfirmed'  // no process and the binding is not confirmed: the user must choose before starting
  | 'error'        // cannot start: see `error`

export interface SlotState {
  slotId: string
  kind: SlotKind
  name?: string
  /** Folder of the current binding, else the slot's creation folder. */
  cwd: string
  /**
   * The folder the slot was created in (SlotMeta.cwd), fixed for the slot's life. `cwd` follows the binding, and Claude's
   * SessionStart hook reports the agent's working directory at that moment (after a `cd` and a /clear or a compaction it
   * is the subfolder), so the app's projects (F8) infer from this one. Absent on older daemons.
   */
  folder?: string
  status: SlotStatus
  pid?: number
  binding?: Binding
  /** Session title (binding.title) or undefined. */
  title?: string
  error?: { code: ErrorCode; message: string }
  /** The slot's launch profile (SlotMeta.profileId); `profileName` is its current name, absent when the profile is gone. */
  profileId?: string
  profileName?: string
  /** The launch carries --dangerously-skip-permissions (profile, slot or TETHER_*_ARGS): the UI shows a badge. */
  unsafe?: boolean
  /** A `set-profile` restart is under way: waiting for the agent's minimum age, or relaunching with the new profile. */
  restarting?: boolean
  /** The agent can be relaunched in place resuming its session (adapter `resumes`, alive, session reported this run, not restarting/stopping): the UI offers "Reiniciar agente". */
  canRestart?: boolean
  /** A stop is waiting for the agent to be old enough to kill (young Claudes are never killed; see MIN_AGENT_AGE_MS). */
  stopping?: boolean
  /**
   * The agent finished its turn ('done') or waits for the user ('waiting'): Claude's Stop/Notification hooks,
   * a heuristic for soul (output quiet after the user's turn, or BEL) and shells (BEL). Cleared by typing into
   * the slot or by `seen`. Absent on daemons older than 0.3.0.
   */
  attention?: 'done' | 'waiting'
  /** A turn is in progress (Claude: prompt submitted and not yet Stop; soul: Enter and output not yet quiet). Absent = idle. */
  turn?: 'busy'
  /**
   * Since when the slot has no turn in progress (ISO): the last busy→idle transition, launch or exit; for a slot that had
   * no turn since the daemon booted, the spawn time or the last event in its log. Absent while `turn` is 'busy'.
   * Absent on daemons older than 0.3.3.
   */
  idleSince?: string
  /** Background subagents still running for this agent (Claude); present only when more than zero. They keep `turn` busy. */
  background?: number
  /** Since when the current turn runs (ISO); present only while `turn` is 'busy'. Absent on daemons older than 0.3.4. */
  busySince?: string
  /**
   * When the session ended (ISO; status exited/error). Persisted in the slot's meta, so it survives a daemon restart;
   * for a slot ended before this field existed, the timestamp of its last logged event. Absent on daemons older than 0.3.4.
   */
  endedAt?: string
  /** Working-set memory in MB summed over the slot's whole process tree (agent/shell and children); live slots only, sampled about every 30 s. Absent on daemons older than 0.3.4. */
  memoryMB?: number
  /**
   * The slot's ronda (tether's nudge clock), when on. `due`: the time has come and tether waits for the agent to be idle.
   * `channel`: whether the agent's CLI is listening on the ronda's channel now ('listening') or not ('none': not running,
   * still starting, or launched without it); the ronda only reaches the agent through it. Absent on daemons older than 0.3.5
   * (`channel`: older than 0.3.7, which typed the nudge into the terminal).
   */
  ronda?: Ronda & { due?: boolean; channel?: 'listening' | 'none' }
}

export type ErrorCode =
  | 'unknown-slot'
  | 'session-missing'   // the agent no longer has the bound session
  | 'cwd-missing'       // the slot's folder does not exist
  | 'already-open'      // the bound session is running in another slot
  | 'unconfirmed'       // start refused: binding not confirmed; resend with choice (set-profile: restart refused)
  | 'spawn-failed'
  | 'bad-request'
  | 'unknown-profile'   // create/profile-delete named a profile that does not exist
  | 'invalid-profile'   // profile-save refused: the message lists every problem (Portuguese)
  | 'pause-active'      // pause-start refused: a batch is already pausing/paused/resuming
  | 'no-pause'          // the request needs an active batch and there is none
  | 'ronda-criterion'   // ronda-off refused: the ronda has a stop criterion (message = the stimulus); resend with force
  | 'ronda-unavailable' // ronda-set refused: the slot's agent takes no channel (a shell, an agent without one); message = why
  | 'agent-unavailable' // the slot's agent is not registered (its extension is off or gone); the slot is kept
  | 'unknown-proc'      // no background process by that name
  | 'proc-running'      // proc-start of a name that runs (the message says who started it)
  | 'proc-not-stopped'  // proc-forget of a live process
  | 'proc-host'         // the process host is unavailable or speaks another protocol version (message: what to do)
  | 'bad-adopt'        // proc-adopt refused: nothing was touched (message: why and what to do)
  | 'proc-in-use'       // stop/restart/forget refused: others declared a use (message = the board: who, until when, what for, options)
  | 'port-busy'         // proc-start refused: a declared port listens already, or another live process declares it (message: who)

// --- client → daemon ------------------------------------------------------------------------
// Requests carry `id` (client-chosen) and get exactly one reply with the same `id` (`ok` or `error`).

export type Request =
  | { t: 'hello'; id: number; v: number; client: 'app' | 'cli' | 'test' }
  | { t: 'list'; id: number }
  /** Performance ruler snapshot (pull only): loop-delay samples and incidents newer than `since` (wall-clock ms). Reply: `perf`. */
  | { t: 'perf'; id: number; since?: number }
  /** Test only (needs TETHER_TEST_BLOCK=1 in the daemon env): replies ok, then blocks the event loop for `ms` (max 30000). */
  | { t: 'debug-block'; id: number; ms: number }
  /** `profileId`: the launch profile (must be of `kind`); its args/env apply on every start, the slot keeps a snapshot. */
  | { t: 'create'; id: number; kind: SlotKind; cwd: string; name?: string; args?: string[]; start?: boolean; profileId?: string }
  /** Start the slot's process: resumes the binding; `choice: 'new'` starts a new session instead. */
  | { t: 'start'; id: number; slotId: string; choice?: 'resume' | 'new' }
  /** Subscribe to the slot's output. Reply carries the scrollback; then `data` events stream. */
  | { t: 'attach'; id: number; slotId: string; cols: number; rows: number }
  | { t: 'detach'; id: number; slotId: string }
  | { t: 'resize'; id: number; slotId: string; cols: number; rows: number }
  /** Kill the slot's process (the slot and its binding stay). */
  | { t: 'stop'; id: number; slotId: string }
  /** Stop and remove the slot from tether (agent session files are never touched). */
  | { t: 'forget'; id: number; slotId: string }
  | { t: 'rename-slot'; id: number; slotId: string; name: string }
  /** Ask the daemon to exit (tests / upgrades). Running agents die with it; they resume on next start. */
  | { t: 'shutdown'; id: number }
  /** The launch profiles (<home>/profiles.json). Reply: `profiles`, plus `problem` when the file had to be repaired. */
  | { t: 'profiles-list'; id: number }
  /** Create (no id) or edit (id) a profile. Reply: the saved `profile` and `warnings`; `invalid-profile` lists the errors. */
  | { t: 'profile-save'; id: number; profile: ProfileInput }
  /** Remove a profile; slots that use it keep their snapshot. */
  | { t: 'profile-delete'; id: number; profileId: string }
  /**
   * Change the slot's launch profile (`null` = none: the slot's own args only). The profile must be of the slot's
   * kind. The meta changes at once; the next start uses it. With `restart` and a live process: the process is
   * killed (an agent only after its minimum age) and the SAME session resumed with the new args — refused with
   * `unconfirmed` (nothing changed) when the running agent never reported its session, so no session is lost.
   */
  | { t: 'set-profile'; id: number; slotId: string; profileId: string | null; restart?: boolean }
  /**
   * Relaunch the slot's live agent in the same slot resuming the SAME session (killed only after its minimum age).
   * Agents only (adapter `resumes`); refused with `unconfirmed` (nothing touched) when the running agent never reported its session.
   */
  | { t: 'restart'; id: number; slotId: string }
  /** The user looked at the slot's pane (it got the focus): clears `attention`. Daemons before 0.3.0 answer bad-request. */
  | { t: 'seen'; id: number; slotId: string }
  /**
   * Politely ask agents to stop at a safe point (one batch at a time; `pause-active` otherwise). `slotIds`: those
   * slots; omitted = every slot whose agent is mid-turn (`turn === 'busy'`). Reply: `pause` (the new batch).
   */
  | { t: 'pause-start'; id: number; slotIds?: string[] }
  /** The current batch (`pause: null` when none). */
  | { t: 'pause-get'; id: number }
  /** Take one slot out of the batch (state removed; its request is deleted). */
  | { t: 'pause-remove'; id: number; slotId: string }
  /** Drop the whole batch: every request deleted, batch closed. Agents that already got it carry on as they wish. */
  | { t: 'pause-cancel'; id: number }
  /** Resume the stopped entries (all, or those of `slotIds`) through the PTY, 3 at a time. Reply: `pause` (state resuming). */
  | { t: 'pause-resume'; id: number; slotIds?: string[] }
  /**
   * Switch the slot's ronda on or reassemble it: `interval` (10m, 1h; undefined keeps, 20m when new), `nudge`/`criterion`
   * (undefined keeps, '' clears). One per slot. Reply: `ronda` and `rondaOutcome`.
   */
  | { t: 'ronda-set'; id: number; slotId: string; interval?: string; nudge?: string; criterion?: string }
  /** The slot's ronda (`ronda: null` when off). */
  | { t: 'ronda-get'; id: number; slotId: string }
  /** Switch the ronda off; with a criterion and no `force` → `ronda-criterion` (the stimulus). The UI always forces. */
  | { t: 'ronda-off'; id: number; slotId: string; force?: boolean }
  /** Background processes (tether proc). `by`: who asks (CLI); the app sends none and is "você (pelo app)". */
  | { t: 'proc-list'; id: number }
  /** The process and its last events. */
  | { t: 'proc-info'; id: number; name: string }
  /** Register (or change the recipe of a stopped one) and start; no recipe = the stored one. Reply: `proc` (status failed when it did not start). */
  /** `force`: start even when a declared port is busy (else `port-busy`). */
  | { t: 'proc-start'; id: number; name: string; recipe?: ProcRecipe; by?: ProcBy; force?: boolean }
  /**
   * Ctrl+C, the card's grace, then the tree. Answers once it stopped. stop / restart / forget meet the uses others
   * declared: refused with `proc-in-use` by default; `waitMs` holds the act until they end (at most 5 min);
   * `force` (the reason, not empty) goes ahead and records it.
   */
  | { t: 'proc-stop'; id: number; name: string; reason?: string; by?: ProcBy; waitMs?: number; force?: string }
  /** Stop and start again with the stored recipe; answers once the new run is up. */
  | { t: 'proc-restart'; id: number; name: string; reason?: string; by?: ProcBy; waitMs?: number; force?: string }
  /** Stopped only: card, history, run file, uses and logs go. */
  /** Bring a process that already runs outside tether into the board, with the COMPLETE recipe to restart it. Reply: `proc`. */
  | { t: 'proc-adopt'; id: number; name: string; pid: number; recipe: ProcRecipe; by?: ProcBy }
  | { t: 'proc-forget'; id: number; name: string; by?: ProcBy; waitMs?: number; force?: string }
  /** Declare (or renew) the caller's use: `duration` like '15m' (default 15m, at most 60m), `purpose` required. Reply: `proc`. */
  | { t: 'proc-use'; id: number; name: string; duration?: string; purpose: string; by?: ProcBy }
  /** End the caller's use. Reply: `proc`, `released` (false: there was none). */
  | { t: 'proc-release'; id: number; name: string; by?: ProcBy }
  /** The ports view: listening ports (managed or outside tether) and declared ones; `check`: that port only. */
  | { t: 'proc-ports'; id: number; check?: number }
  /** Someone looked: clears `attention`. */
  | { t: 'proc-seen'; id: number; name: string }
  /**
   * Watch a process' output (read only: no request writes to a process). Reply: `scrollback` of its current run, absent
   * when the host holds no run of it; then `proc-data` events go to THIS client. Asking again gives a fresh scrollback.
   */
  | { t: 'proc-attach'; id: number; name: string }
  | { t: 'proc-detach'; id: number; name: string }
  /** The host's state (`host: null` when none answers). */
  | { t: 'proc-host'; id: number }
  /** Ask the host to exit; refused with live processes unless `force` (they are stopped, recorded as asked by `by`). */
  | { t: 'proc-host-stop'; id: number; force?: boolean; by?: ProcBy }

/**
 * Fire-and-forget (no reply): keystrokes. `probe` (optional) times the key->echo path: the client's stamps so far
 * (epoch ms with fraction, see core/perf-probe.ts); tetherd appends arrive + write and hangs it on the slot's next `data`.
 */
export type Notice = { t: 'input'; slotId: string; data: string; probe?: Probe }

export type ClientMessage = Request | Notice

// --- daemon → client ------------------------------------------------------------------------

export type Reply =
  | {
      t: 'ok'
      id: number
      /** `exec`: the executable the daemon runs as (tetherd.exe, or the plain node when the copy failed). */
      hello?: { v: number; pid: number; version: string; exec?: string }
      slots?: SlotState[]
      /** perf. */
      perf?: PerfSnapshot
      slot?: SlotState
      scrollback?: string
      profiles?: Profile[]
      profile?: Profile
      /** profile-save: things worth telling the user that did not block the save. */
      warnings?: string[]
      /** profiles-list: the file was unusable and repaired (backup kept), or had entries that were skipped. */
      problem?: string
      /** pause-start / pause-get: the batch (null = none). */
      pause?: PauseBatch | null
      /** ronda-set / ronda-get / ronda-off: the slot's ronda (null = off). */
      ronda?: (Ronda & { due?: boolean; channel?: 'listening' | 'none' }) | null
      rondaOutcome?: 'created' | 'updated' | 'unchanged' | 'off' | 'was-off'
      /** proc-list. */
      procs?: ProcState[]
      /** proc-info / proc-start / proc-stop / proc-restart. */
      proc?: ProcState
      /** proc-info: the last events, oldest first. */
      events?: ProcEvent[]
      /** proc-ports. */
      ports?: PortRow[]
      /** proc-forget: something worth telling the caller (an adopted process was left running). */
      note?: string
      /** proc-release: whether the caller had a use. */
      released?: boolean
      /** proc-host: null when no host answers. */
      host?: { pid: number; version: string; startedAt: string; live: number } | null
    }
  | { t: 'error'; id: number; code: ErrorCode; message: string }

export type Event =
  /**
   * Output of an attached slot. `probe`: the first `data` after a probed input carries its stamps plus tetherd's three
   * (arrive, write, out); a newer probe replaces a pending one, and one pending for over 5 s is dropped.
   */
  | { t: 'data'; slotId: string; data: string; probe?: Probe }
  /** Any change of a slot (status, binding, title, pid). Sent to every client. */
  | { t: 'state'; slot: SlotState }
  | { t: 'removed'; slotId: string }
  /** The profile list changed (save/delete through any client). Sent to every client. */
  | { t: 'profiles'; profiles: Profile[] }
  /** The pause batch changed (any state or entry). Sent to every client. */
  | { t: 'pause'; batch: PauseBatch }
  /** A background process changed (any client). */
  | { t: 'proc'; proc: ProcState }
  | { t: 'proc-removed'; name: string }
  /** Output of a process this client attached to (proc-attach). */
  | { t: 'proc-data'; name: string; data: string }

export type DaemonMessage = Reply | Event
