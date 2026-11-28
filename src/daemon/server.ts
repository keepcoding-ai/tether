// tetherd: owns one PTY per slot, keeps each slot's scrollback, launches agents through the adapters and
// watches <home>/slots/*.jsonl so every client sees the current binding. Speaks protocol.ts over a named
// pipe / unix socket (NDJSON). "Running" means: this process holds the PTY and it has not exited.
import { withTabEnv } from '../core/tab-env.ts'
import { slotTitle } from '../../app/shared/agent-info.ts'
import type { SlotEventKind } from './ext-api.ts'
import { chmod, mkdir, readFile, stat as statAsync } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { AttentionState, attentionOptions, parseAttentionReport, parseSoulReports, type SoulReport } from './attention.ts'
import { memoryChanged, sampleProcessTable, treeBytes } from './memory.ts'
import '../agents/load.ts'
import { agentChoices, agentRegistry, isAgentName } from '../agents/registry.ts'
import { shellAdapter } from '../agents/shell.ts'
import type { AgentAdapter, LaunchPlan } from '../agents/types.ts'
import type { AgentName, Binding, RunInfo, SlotMeta, SlotWant, TetherEvent } from '../core/event.ts'
import { isSameProcess, pidExists, processStartTime } from '../core/liveness.ts'
import { canonicalDir, pausePath, slotAnswerPath, slotAttentionPath, slotEventsPath, slotMetaPath, slotPauseReportPath, slotPauseRequestPath, slotRondaPath, slotRunPath, slotsDir } from '../core/paths.ts'
import { cliScript } from '../core/tab-env.ts'
import { RONDA_MCP_SERVER as RONDA_SERVER_NAME, RondaChannel, showsConfirm, type RondaChannelAgent } from './ronda-channel.ts'
import type { ChannelConfirm } from '../agents/registry.ts'
import { applyChange, buildChannelText, criterionStimulus, ENV_RONDA_TEST_SECONDS, flatText, parseRonda, RondaError, type Ronda } from './ronda.ts'
import { applyReportLine, buildRequestText, buildResumeText, canTransition, newEntry, parsePauseFile, transition, type PauseBatch, type PauseEntry } from './pause.ts'
import { isProfileAgent, isUnsafe, ProfileError, ProfileStore, slotProfile, snapshotProfile, type Profile, type ProfileInput, type SlotProfile } from '../core/profile.ts'
import { readEventsFrom, scanSlotsAsync } from '../core/store-async.ts'
import { assertSlotId, currentBinding, parseEventLine, parseEvents, parseRunInfo, parseSlotMeta, randomSlotId, serializeMeta, serializeRun, SLOT_ID_RE, type EventsRead, type SlotsScan } from '../core/store-model.ts'
import { SlotStore } from '../core/slot-store.ts'
import { isAgentExecutor, setAgentExecutor } from '../agents/agent-exec.ts'
import { createExecutor, type Executor } from '../exec/executor.ts'
import { encode, guessId, LineParser } from './ndjson.ts'
import { forBroadcast } from './env-names.ts'
import { clientProof, daemonProof, discardKeyFile, fillKeyFile, folderIsPrivate, isNonce, newNonce, pipeKeyPath, prepareKeyFile, sameProof, servedHome, servePipeHome, unservePipeHome } from './pipe-key.ts'
import { isPortalCredential } from './handshake.ts'
import {
  KILL_WAIT_CAP_MS,
  MIN_AGENT_AGE_MS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type ErrorCode,
  type Reply,
  type Request,
  type SlotKind,
  type SlotState,
  type SlotStatus,
  type StopWhy,
} from './protocol.ts'
import { killTree, spawnPty, type PtyExit, type PtyHandle } from './pty.ts'
import { Scrollback } from './scrollback.ts'
import { HostClient } from '../procd/client.ts'
import { PanelHost, type PanelCallbacks } from './panel-host.ts'
import { PTYD_TARGET, ptydKeyHome, ptydPipePath } from '../ptyd/paths.ts'
import { UserSettings } from '../core/user-settings.ts'
import { treeValueAt } from '../../app/shared/settings-file.ts'
import { limiter, mapLimit } from '../core/limit.ts'
import { perf } from '../core/perf.ts'
import { ECHO_INCIDENT_MS, PROBE_TTL_MS, extendProbe, isSlow, parseProbe, stamp, type Probe } from '../core/perf-probe.ts'
import { busyWait, DEBUG_BLOCK_MAX_MS } from './debug-block.ts'
import { procdPipePath, type HostRun } from '../procd/protocol.ts'
import { osUser, ProcManager, type GuardOptions } from './proc-manager.ts'
import { ProcError, WAIT_MAX_MS, type ProcAuthor, type ProcBy } from './procs.ts'
import { DoorHost } from './door/host.ts'
import { typingOf } from './door/typing.ts'
import { DoorError, type DoorSeams, type InputMark, type InputOrigin, type SlotCreateInput, type SlotPort } from './door/port.ts'

export const DAEMON_VERSION = '0.3.8'

/** How long a claude/soul slot may stay 'starting' without its start event before it counts as running anyway. */
const READY_FALLBACK_MS = 15_000
/** Period of the memory sample. One PowerShell process-table query for all slots costs ~0.9 s wall / ~0.9 s CPU on Windows (385 processes), so 60 s keeps it near 1.5 % of one core. */
export const MEMORY_INTERVAL_MS = 60_000
export { KILL_WAIT_CAP_MS, MIN_AGENT_AGE_MS }
/** Agent processes allowed in 'starting' at the same time (PRD RA8); the rest wait as 'queued'. */
export const MAX_STARTING = 3
/** Boot relaunches of a `want: 'run'` slot in a row that did not prove healthy before the boot stops relaunching it. */
export const MAX_BOOT_TRIES = 3
/** A run that lived this long proved healthy (its slot's crash-loop count is cleared); checked at its exit, no timer. */
export const BOOT_HEALTHY_MS = 60_000
/** Keys held for a slot whose pty is not up yet (bytes); the excess is dropped and counted. */
export const INPUT_QUEUE_MAX_BYTES = 64 * 1024

/** Args appended to every launch of an agent by this daemon, from `TETHER_CLAUDE_ARGS` / `TETHER_SOUL_ARGS`
 *  (whitespace-separated). The app's dialog has no args field; this is how a dev/E2E run pins `--model haiku`. */
export function defaultAgentArgs(agent: AgentName, env: NodeJS.ProcessEnv = process.env): string[] {
  const name = agentRegistry.get(agent)?.envArgsVar ?? `TETHER_${agent.toUpperCase().replace(/-/g, '_')}_ARGS`
  const raw = env[name]?.trim()
  return raw ? raw.split(/\s+/) : []
}
const WATCH_DEBOUNCE_MS = 100
/** Boot: slots whose files load at once (each read is async; the sync fold of one slot is well under a millisecond). */
/** Pause between listening and the first slot load, so the clients that reconnect at once hear the loads as state broadcasts. */
const HYDRATE_GRACE_MS = 50
const HYDRATE_CONCURRENCY = 6
/** Boot: transcript lookups for titles in flight at once (each may list the projects directory). */
const TITLE_LOOKUPS = 4
/** A subagent marker older than this no longer counts (its SubagentStop was lost: a crash, a kill). */
const BG_MAX_AGE_MS = 6 * 60 * 60_000
/** Pause resume: slots typed into at once (the gap between the text and the Enter is the engine's typing). */
const PAUSE_RESUME_PARALLEL = 3
/** A due ronda re-checks a busy agent (or one whose channel is not connected) this often. */
const RONDA_RETRY_MS = 2_000
/** Screen kept while looking for the channel's start dialog (chars of raw output). */
const CONFIRM_SCREEN_MAX = 16_000
/** Gap between seeing the dialog and answering it (the TUI must have finished drawing and be reading keys). */
const CONFIRM_DELAY_MS = 400
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
/** How long a launch waits for a tether-ptyd it had to start. */
const PANEL_HOST_ENSURE_MS = 20_000
/** A connection that has not completed its hello by then is dropped (the clients send it at once; see onConnection). */
export const HELLO_TIMEOUT_MS = 10_000

/**
 * Whether NEW panes are launched in the terminal-pane host (tether-ptyd) instead of inside tetherd: TETHER_PANEL_HOST=1|0
 * in tetherd's environment wins, else `daemon.panelHost` in settings.json, else on. Read once, at boot (the settings tree is the
 * snapshot's, loaded before the daemon listens).
 */
export function panelHostEnabled(settings: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TETHER_PANEL_HOST?.trim()
  if (v === '1') return true
  if (v === '0') return false
  return treeValueAt(settings, 'daemon.panelHost') !== false
}

export interface DaemonOptions {
  home: string
  pipe: string
  log?: (msg: string) => void
  /** Called after a client's `shutdown` request has been honoured (PTYs killed, server closed). */
  onShutdown?: () => void
  /** Replaces an agent's adapter (tests: a fake that launches an inert process instead of the agent). */
  adapters?: Partial<Record<AgentName, AgentAdapter>>
  /** Daemon extensions' launch middlewares (TetherDaemon.launch.use), applied in order to every agent/shell plan. */
  transformPlan?: (plan: LaunchPlan, meta: SlotMeta, state?: SlotState) => LaunchPlan | Promise<LaunchPlan>
  /** Slot lifecycle for daemon extensions (TetherDaemon.onSlot). */
  onSlot?: (kind: SlotEventKind, slot: SlotState) => void
  /** Overrides READY_FALLBACK_MS (tests). */
  readyFallbackMs?: number
  /** Overrides HELLO_TIMEOUT_MS (tests). */
  helloTimeoutMs?: number
  /** How often a running Claude slot's title is polled from its transcript (tests shorten it). */
  titlePollMs?: number
  /** Overrides MIN_AGENT_AGE_MS (tests); 0 disables the young-agent guard. */
  minAgentAgeMs?: number
  /** Overrides KILL_WAIT_CAP_MS (tests). */
  killWaitCapMs?: number
  /** How often live slots' memory is sampled (default MEMORY_INTERVAL_MS); 0 turns the sampler off (tests). */
  memoryIntervalMs?: number
  /** Ronda intervals in seconds are accepted (tests); default: TETHER_RONDA_TEST_SECONDS=1 in the daemon's env. */
  rondaAllowSeconds?: boolean
  /** How often a due ronda re-checks a busy agent (default RONDA_RETRY_MS). */
  rondaRetryMs?: number
  /**
   * How the ronda's channel is offered to an agent (undefined = it has none). Default: the agent's contribution (`channel`
   * with `mcp.http`), except for agents whose adapter is overridden (test fakes speak no MCP unless the test says so here).
   */
  channelOf?: (agent: AgentName) => RondaChannelAgent | undefined
  /** tether-procd's pipe (default: procdPipePath of this daemon's pipe). */
  procdPipe?: string
  /** Connects to the process host (tests: one running in process, never launched). Default: HostClient, launching tether-procd detached. */
  connectProcHost?: (launch: boolean) => Promise<HostClient>
  /** How long a lost host connection is retried before its processes count as lost (default HOST_RECONNECT_MS). */
  procHostReconnectMs?: number
  /** Launch new panes in the terminal-pane host. Default: panelHostEnabled(settings), once the settings snapshot is loaded. */
  panelHost?: boolean
  /**
   * Connects to the terminal-pane host (tests: one running in process, never launched). `launch` false: undefined when no
   * host answers; true: launches it first when needed. Default: HostClient on ptydPipePath, launching tether-ptyd detached.
   */
  connectPanelHost?: (launch: boolean) => Promise<HostClient | undefined>
  /** Tests: told about every disk read the daemon makes to follow the slots' files (what was read, and for which slot). */
  fsProbe?: (op: FsProbeOp, slotId?: string) => void
  /**
   * Boot: `startDaemon` returns once the daemon listens (slots known by their meta, status and run), while each slot's events,
   * binding, title and ronda load in the background (`Daemon.hydrated()` settles when all are in). Default false: `startDaemon`
   * also waits for that, so a test sees the settled state; tetherd itself passes true.
   */
  backgroundBoot?: boolean
  /**
   * The process' executor (tetherd passes its own and closes it itself). Default: one of the daemon's own, inline unless
   * TETHER_EXECUTOR=worker, closed by `close`/`abandon`.
   */
  executor?: Executor
  /** tetherd's snapshots of profiles.json and settings.json, shared with its extension host. Default: the daemon's own, on its executor. */
  profileStore?: ProfileStore
  userSettings?: UserSettings
  /** The agent door (door/host.ts): the daemon attaches its SlotPort to it and calls its hooks. Default: a door of its own, inert. */
  door?: DoorSeams
}

/** The disk reads `fsProbe` reports: the boot scan of slots/, an events file (whole or from an offset), a slot's marker listing and stats, a run file, the hook's attention and pause reports, a start's folder check. */
export type FsProbeOp = 'slots:scan' | 'events:full' | 'events:tail' | 'markers:list' | 'markers:stat' | 'run:read' | 'ronda:read' | 'attention:read' | 'pause:read' | 'cwd:check'

export interface Daemon {
  readonly home: string
  readonly pipe: string
  readonly pid: number
  slots(): SlotState[]
  /** The server still accepts connections and is not closing (the state can be trusted). */
  listening(): boolean
  /** Settles when every slot known at boot has its events, binding, title and ronda loaded (a slot is also loaded on demand, ahead of this, when a request needs it). */
  hydrated(): Promise<void>
  /** Kills every PTY tree, drops the clients and closes the server. */
  close(): Promise<void>
  /** Tests: closes like a hard death would (server, clients, host connection) WITHOUT stopping any slot. */
  abandon(): Promise<void>
}

/** A reason as typed, flattened to one line; undefined when empty. */
function optText(v: unknown): string | undefined {
  const t = typeof v === 'string' ? flatText(v) : ''
  return t || undefined
}

/** The guard part of a stop / restart / forget: `waitMs` within 0..5 min, `force` a reason that is not empty. */
function guardOf(req: { waitMs?: unknown; force?: unknown }): GuardOptions {
  const g: GuardOptions = {}
  if (req.waitMs !== undefined) {
    if (typeof req.waitMs !== 'number' || !Number.isFinite(req.waitMs) || req.waitMs < 0) throw new RequestError('bad-request', 'waitMs inválido')
    if (req.waitMs > WAIT_MAX_MS) throw new RequestError('bad-request', 'espera longa demais: o máximo é 5m')
    g.waitMs = req.waitMs
  }
  if (req.force !== undefined) {
    const reason = optText(req.force)
    if (!reason) throw new RequestError('bad-request', 'forçar pede um motivo: --force "motivo" (ele chega a quem usa)')
    g.force = reason
  }
  if (g.force !== undefined && g.waitMs !== undefined) throw new RequestError('bad-request', 'escolha esperar (--wait) ou forçar (--force), não os dois')
  return g
}

/** A stop's `why`: absent is 'end' (the CLI, the door, clients from before it existed); anything else is refused. */
function stopWhyOf(v: unknown): StopWhy {
  if (v === undefined || v === 'end') return 'end'
  if (v === 'hibernate' || v === 'suspend') return v
  throw new RequestError('bad-request', 'why inválido: end, hibernate ou suspend')
}

class RequestError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

interface Slot {
  /** The tail of the last `paneExit` (the final events read, then the verdict and the broadcast); a stop answers after it. */
  exitTail?: Promise<void>
  meta: SlotMeta
  status: SlotStatus
  binding?: Binding
  title?: string
  error?: { code: ErrorCode; message: string }
  pty?: PtyHandle
  /** `pty` lives in the terminal-pane host (tether-ptyd), not in this process. */
  ptyHosted?: true
  /** A launch waiting for the terminal-pane host: holds the slot's 'starting' seat; a start or stop meanwhile waits for it. */
  launching?: Promise<void>
  /** ISO time of the last spawn; a start event at/after it confirms the agent is up. */
  spawnedAt?: string
  readyTimer?: NodeJS.Timeout
  /** The choice the queued start was asked with (status 'queued' only). */
  queuedChoice?: 'resume' | 'new'
  /** Stops the adapter's title watch (running claude slots). */
  stopTitleWatch?: () => void
  /** The text the pane's tab showed when the extensions last heard of the slot (slotTitle): a different one is a `changed`. */
  tabTitle?: string
  /** A `set-profile` restart in progress (waiting for the agent's minimum age, or relaunching). */
  restarting?: true
  /** A stop is waiting for the agent to be old enough to kill (see MIN_AGENT_AGE_MS). */
  stopping?: true
  /** Whether the CURRENT process was launched with --dangerously-skip-permissions (set at spawn). */
  runUnsafe?: boolean
  scrollback: Scrollback
  /** Finished / waiting for the user (see attention.ts); `attentionTimer` runs the idle heuristic. */
  attention: AttentionState
  /** Working set of the process tree in MB, from the last memory sample (live slots only). */
  memoryMB?: number
  attentionTimer?: NodeJS.Timeout
  /** ts of the last hook report applied (the file is rewritten per report; older ones are ignored). */
  attentionReportTs?: string
  /** Generation of the attention report read: a read that finishes after a newer one started is dropped. */
  attentionGen?: number
  /** Generation of the pause report read (see attentionGen). */
  pauseGen?: number
  /** A subagent-marker refresh in flight; names that change meanwhile wait in `bgCarry` for the next pass. */
  bgRunning?: true
  bgCarry?: Set<string>
  /**
   * The launch before its spawn (folder check, fresh config, plan, ronda file): it holds the slot's 'starting' seat. A stop
   * clears it (and releases its waiters) and the launch ends without spawning.
   */
  preLaunch?: PreLaunch
  /** A start of this slot in flight: a second one waits for it instead of launching again. */
  startPending?: Promise<void>
  /** The wake fallback after the last background subagent ended (see AttentionState.wakeDueAt). */
  wakeTimer?: NodeJS.Timeout
  /** What the slot's events file held when last read: the file is append-only, so only the appended bytes are read again. */
  events?: EventsView
  /** `turn` and `waiting` reports read but not yet applied (see applyTurnReports). */
  turnPending?: SoulReport[]
  /** The slot's boot load (events, binding, ronda) in flight or done; undefined until something asks for it. */
  hydrating?: Promise<void>
  /** An incremental read of the events file in flight; `pullAgain`: the file changed meanwhile, read once more. */
  pulling?: Promise<void>
  pullAgain?: true
  /** The slot's ronda (persisted in <home>/slots/<id>.ronda.json); `rondaDue`: its time came and it waits for an idle agent. */
  ronda?: Ronda
  rondaDue?: boolean
  /** Key->echo probe waiting for the slot's next output (one per slot; a newer one replaces it), with its write time. */
  probe?: { probe: Probe; at: number }
  rondaTimer?: NodeJS.Timeout
  /** Keys that arrived while the slot had no pty yet (see queueInput); written in order once it has one. */
  inputQueue?: { items: { data: string; probe?: unknown; arrive: number }[]; bytes: number; overflowed?: true }
  /** Bytes of input dropped because the queue was full (all runs of this daemon); logged once per slot. */
  inputDropped?: number
  /** Looking for the channel's start dialog: until it is answered once or the run reports its start. */
  confirmWatch?: { spec: ChannelConfirm; screen: string }
  attached: Set<Client>
  cols: number
  rows: number
}

/**
 * The part of a slot's events file the daemon keeps: the events from the last `start` on (all that `currentBinding` needs),
 * the timestamp of the very last one, and where the next read resumes (a byte offset on a line start).
 */
interface EventsView {
  resume: number
  kept: TetherEvent[]
  lastTs?: string
  /** The unterminated last line, read as an event when it parses (it counts until its newline arrives). */
  fragment: string
  transient?: TetherEvent
}

/** One launch's pre-spawn phase: identity for cancellation; `done` settles when it ends (spawned, failed or cancelled). */
interface PreLaunch { done: Promise<void>; release(): void }

/** A live run of the terminal-pane host held for a slot at boot (see holdAdoptions); `release` frees the slot's `launching`. */
interface Adoption {
  slot: Slot
  run: HostRun
  prior: { status: SlotStatus; error?: { code: ErrorCode; message: string } }
  release(): void
}

interface Client {
  socket: Socket
  parser: LineParser
  attached: Set<string>
  /** Background processes whose output this client watches (proc-attach). */
  procsWatched: Set<string>
  /** From the hello: 'app' | 'cli' | 'test' | 'remote' ('remote' only with the portal's credential, else 'cli'). */
  kind?: string
  /** This connection's number in this tetherd (never reused): lets an extension answer only the connection that asked. */
  conn: number
  /** From the hello: reads hosted panes straight from tether-ptyd, so no `data` or scrollback of them goes to it. */
  direct?: true
  /** The hello was answered `ok` (its proof checked): only then does the client get events and answers to anything else. */
  greeted?: true
  /** The nonces of this connection's `auth`, waiting for the hello's proof (used once). */
  challenge?: { client: string; daemon: string }
  /** Close the connection once the reply in flight is written (a refused hello). */
  closeAfterReply?: true
  /** Drops the connection when the hello does not come (cleared by it). */
  helloTimer?: NodeJS.Timeout
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const d = new DaemonImpl(opts)
  await d.listen()
  if (!opts.backgroundBoot) await d.hydrated()
  return d
}

class DaemonImpl implements Daemon {
  readonly home: string
  readonly pipe: string
  readonly pid = process.pid
  private readonly log: (msg: string) => void
  private readonly onShutdown: (() => void) | undefined
  private readonly server: Server
  private readonly clients = new Set<Client>()
  private connSeq = 0
  private readonly slotMap = new Map<string, Slot>()
  private watcher: FSWatcher | undefined
  private readonly pending = new Map<string, NodeJS.Timeout>()
  /** The background load of the slots known at boot (see hydrateAll). */
  private booting: Promise<void> = Promise.resolve()
  private readonly titleLookups = limiter(TITLE_LOOKUPS)
  /** Slots whose events file changed since their debounce timer was armed (a change of the slot's .json alone needs no read). */
  private readonly eventsDirty = new Set<string>()
  /** Per slot, its subagent markers (`<slot>.bg.<id>` -> mtime) as the watcher reported them; a slot with no entry is unknown and gets listed once. */
  private readonly bgMarkers = new Map<string, Map<string, number>>()
  /** Marker files the watcher reported since the slot's last debounce. */
  private readonly bgTouched = new Map<string, Set<string>>()
  private readonly bgListing = new Map<string, Promise<Map<string, number>>>()
  private readonly fsProbe: ((op: FsProbeOp, slotId?: string) => void) | undefined
  /** The door to the disk: every file this daemon writes by itself goes through the store (memory first, the io lane behind). */
  private readonly executor: Executor
  private readonly ownExecutor: boolean
  private readonly store: SlotStore
  /** Slots forgotten by this daemon: none of their files is written again, and the watcher never adopts them back. */
  private readonly forgotten = new Set<string>()
  /** Slots whose run file this daemon wrote (dropping it then needs no read). */
  private readonly ownRuns = new Set<string>()
  /** Test overrides; everything else comes from the agent registry at the time of use. */
  private readonly adapterOverrides: Partial<Record<AgentName, AgentAdapter>>
  private readonly transformPlan: ((plan: LaunchPlan, meta: SlotMeta, state?: SlotState) => LaunchPlan | Promise<LaunchPlan>) | undefined
  private readonly onSlot: ((kind: SlotEventKind, slot: SlotState) => void) | undefined
  private readonly readyFallbackMs: number
  private readonly helloTimeoutMs: number
  /** The pipe key (pipe-key.ts), drawn and written once this daemon owns the pipe; `auth` waits for it. */
  private pipeKey: Promise<Buffer> = new Promise(() => {})
  private readonly minAgentAgeMs: number
  private readonly killWaitCapMs: number
  private readonly titlePollMs: number | undefined
  private readonly memoryIntervalMs: number
  private readonly rondaAllowSeconds: boolean
  private readonly rondaRetryMs: number
  private readonly channelOf: (agent: AgentName) => RondaChannelAgent | undefined
  /** The ronda's channel: the daemon's own MCP server, one route per slot. */
  private readonly rondaChannel: RondaChannel
  private memoryTimer: NodeJS.Timeout | undefined
  private memorySampling = false
  private memoryKick: NodeJS.Timeout | undefined
  /** <home>/profiles.json, re-read when it changes on disk (the CLI edits it while tetherd runs). */
  private readonly profileStore: ProfileStore
  /** settings.json, in memory like the profiles: reloaded by the executor, awaited fresh at every launch. */
  private readonly userSettings: UserSettings
  /** Slots waiting for a 'starting' seat, in request order. */
  private readonly queue: Slot[] = []
  private closing = false
  /** The pause batch (<home>/pause.json); a closed one is kept on disk but not here. */
  private batch: PauseBatch | undefined
  /** This process' OS start time: goes into every run file so a later tetherd can tell this one is gone. */
  private startedAt = new Date().toISOString()
  /** Background processes (tether proc): the model and the link to tether-procd. */
  private readonly procs: ProcManager
  /** Who watches each background process' output (one host attachment per name, shared). */
  private readonly procWatchers = new Map<string, Set<Client>>()
  /** New panes go to tether-ptyd (read once at boot; panes already running stay where they are). */
  private panelHostOn: boolean
  /** `DaemonOptions.panelHost` when given: the settings never override it. */
  private readonly panelHostForced: boolean | undefined
  private readonly connectPanelHost: (launch: boolean) => Promise<HostClient | undefined>
  /** The link to tether-ptyd, created at the first hosted launch. */
  private panelHost: PanelHost | undefined
  /** pid of the tether-ptyd last connected to (from its hello). */
  private panelHostPid: number | undefined
  /** The agent door's hooks (door/port.ts); no-ops while no door service is on. */
  private readonly door: DoorSeams

  constructor(opts: DaemonOptions) {
    this.home = opts.home
    this.pipe = opts.pipe
    const sink = opts.log
    this.log = sink ? (msg: string) => perf.timed('log', () => sink(msg)) : () => {}
    this.onShutdown = opts.onShutdown
    this.adapterOverrides = { ...opts.adapters }
    this.transformPlan = opts.transformPlan
    this.onSlot = opts.onSlot
    this.fsProbe = opts.fsProbe
    this.ownExecutor = opts.executor === undefined
    this.executor = opts.executor ?? createExecutor({ mode: process.env.TETHER_EXECUTOR === 'worker' ? 'worker' : 'inline', log: this.log })
    setAgentExecutor(this.executor) // the launch middlewares (skills) and the doctor's resolvers reach the adapters' operations through it
    this.store = new SlotStore(this.executor, { log: this.log })
    this.readyFallbackMs = opts.readyFallbackMs ?? READY_FALLBACK_MS
    this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    this.minAgentAgeMs = opts.minAgentAgeMs ?? MIN_AGENT_AGE_MS
    this.killWaitCapMs = opts.killWaitCapMs ?? KILL_WAIT_CAP_MS
    this.titlePollMs = opts.titlePollMs
    this.memoryIntervalMs = opts.memoryIntervalMs ?? MEMORY_INTERVAL_MS
    this.rondaAllowSeconds = opts.rondaAllowSeconds ?? process.env[ENV_RONDA_TEST_SECONDS] === '1'
    this.rondaRetryMs = opts.rondaRetryMs ?? RONDA_RETRY_MS
    this.channelOf = opts.channelOf ?? ((agent) => {
      if (this.adapterOverrides[agent]) return undefined
      const c = agentRegistry.get(agent)
      if (!c?.channel || !c.mcp?.http) return undefined
      return { args: c.channel(RONDA_SERVER_NAME), inject: c.mcp.inject, ...(c.channelConfirm ? { confirm: c.channelConfirm } : {}) }
    })
    this.rondaChannel = new RondaChannel({
      home: opts.home,
      log: this.log,
      store: this.store,
      onChange: (slotId) => {
        const slot = this.slotMap.get(slotId)
        if (!slot) return
        this.log(`slot ${slotId}: ronda channel ${this.rondaChannel.connected(slotId) ? 'listening' : 'closed'}`)
        this.broadcastState(slot)
      },
    })
    this.profileStore = opts.profileStore ?? new ProfileStore(opts.home, this.executor, this.log)
    this.profileStore.attachWriter({ put: (p, t) => this.store.put(p, t), flush: (p) => this.store.flush(p) })
    this.userSettings = opts.userSettings ?? new UserSettings(opts.home, this.executor, process.env, this.log)
    this.panelHostForced = opts.panelHost
    this.panelHostOn = opts.panelHost ?? panelHostEnabled(this.userSettings.get())
    // The hosts' keys live in the home of the host on that pipe: this daemon's, unless the host runs in this process with
    // its own home, or TETHER_PTYD_PIPE points at one that does (TETHER_PTYD_HOME: tests).
    const hostHome = (pipe: string): string => servedHome(pipe) ?? opts.home
    this.connectPanelHost = opts.connectPanelHost ?? ((launch) => {
      const pipe = ptydPipePath(opts.pipe, opts.home)
      const keyHome = servedHome(pipe) ?? ptydKeyHome(opts.home)
      return launch
        ? HostClient.ensure({ home: opts.home, keyHome, pipe, node: process.env.TETHER_NODE?.trim() || process.execPath, env: process.env, log: this.log }, PANEL_HOST_ENSURE_MS, PTYD_TARGET)
        : HostClient.tryOpen(pipe, 5_000, { home: keyHome })
    })
    this.server = createServer((socket) => this.onConnection(socket))
    const procdPipe = opts.procdPipe ?? procdPipePath(opts.pipe, opts.home)
    this.procs = new ProcManager({
      home: opts.home,
      exec: this.executor,
      store: this.store,
      log: this.log,
      broadcast: (msg) => this.broadcast(msg),
      author: (by, client) => this.procAuthor(by, client),
      connectHost: opts.connectProcHost ?? ((launch) => launch
        ? HostClient.ensure({ home: opts.home, keyHome: hostHome(procdPipe), pipe: procdPipe, node: process.env.TETHER_NODE?.trim() || process.execPath, env: process.env, log: this.log })
        : HostClient.open(procdPipe, 5_000, { home: hostHome(procdPipe) })),
      openLegacyHost: () => HostClient.open(procdPipe, 5_000, { home: hostHome(procdPipe), legacy: true }),
      ...(opts.procHostReconnectMs !== undefined ? { reconnectMs: opts.procHostReconnectMs } : {}),
      allowSeconds: this.rondaAllowSeconds,
      slotExists: (slotId) => this.slotMap.has(slotId),
      protectedPids: () => {
        const pids = [...this.slotMap.values()].filter((s) => s.pty && !s.pty.exit).map((s) => s.pty!.pid)
        if (this.panelHost?.connected && this.panelHostPid !== undefined) pids.push(this.panelHostPid)
        return pids
      },
      sampleSoon: () => this.kickMemory(),
      onData: (name, data) => { for (const c of this.procWatchers.get(name) ?? []) this.send(c, { t: 'proc-data', name, data }) },
    })
    this.door = opts.door ?? new DoorHost({ log: this.log })
    this.door.attach(this.slotPort())
  }

  /** The slot operations the agent door drives: the same methods the pipe's requests run. */
  private slotPort(): SlotPort {
    return {
      home: this.home,
      create: async ({ meta, ...input }) => this.stateOf(await this.createSlot(input, meta)),
      start: async (slotId, choice) => {
        const slot = this.slot(slotId)
        await this.manualStart(slot, choice)
        return this.stateOf(slot)
      },
      stop: (slotId) => this.stopById(slotId),
      restart: (slotId) => this.restartById(slotId),
      forget: (slotId) => this.forgetById(slotId),
      rename: (slotId, name) => this.renameById(slotId, name),
      write: (slotId, data, origin, mark) => {
        const slot = this.slot(slotId)
        if (!isAlive(slot) && !this.awaitsPty(slot)) throw new DoorError('door-no-pty', `o slot ${slotId} não tem processo rodando`)
        this.typeInto(slot, data, undefined, 0, origin, mark)
      },
      readScreen: (slotId, since) => {
        const slot = this.slot(slotId)
        const sb = slot.scrollback
        const r = since === undefined ? { data: sb.text(), reset: false } : sb.since(since)
        return { data: r.data, cols: slot.cols, rows: slot.rows, start: sb.start, end: sb.end, reset: r.reset }
      },
      stateOf: (slotId) => {
        const slot = this.slotMap.get(slotId)
        return slot ? this.stateOf(slot) : undefined
      },
      paintedAt: (slotId) => this.slotMap.get(slotId)?.attention.lastPaintAt,
      list: () => this.slots(),
      isAlive: (slotId) => {
        const slot = this.slotMap.get(slotId)
        return slot !== undefined && isAlive(slot)
      },
      meta: (slotId) => this.slotMap.get(slotId)?.meta,
      saveMeta: async (slotId) => {
        const slot = this.slot(slotId)
        this.saveMeta(slot.meta)
        await this.store.flush(slotMetaPath(this.home, slotId))
      },
      seen: (slotId) => {
        const slot = this.slot(slotId)
        if (slot.attention.seen(true)) this.broadcastState(slot) // the owner clears a pending request too
      },
      signal: (slotId, kind) => {
        const slot = this.slot(slotId)
        if (slot.attention.hook(kind)) this.broadcastState(slot)
      },
      broadcastState: (slotId) => this.broadcastState(this.slot(slotId)),
      broadcast: (event) => this.broadcast(event),
    }
  }

  /** The portrait of whoever asks for a process act: their slot when it is one of ours, else external (or the app). */
  private procAuthor(by: ProcBy | undefined, client: string | undefined): ProcAuthor {
    const label = typeof by?.as === 'string' && by.as.trim() ? by.as.trim() : undefined
    const user = typeof by?.user === 'string' && by.user ? by.user : osUser()
    if (!by && client === 'app') return { kind: 'app', ...(user ? { user } : {}) }
    const slotId = typeof by?.slotId === 'string' && by.slotId ? by.slotId : undefined
    const slot = slotId ? this.slotMap.get(slotId) : undefined
    const a: ProcAuthor = slot ? { kind: slot.meta.agent === 'shell' ? 'shell' : 'agent', slotId: slot.meta.slotId } : { kind: 'external', ...(slotId ? { slotId } : {}) }
    if (slot?.meta.name) a.name = slot.meta.name
    if (slot && slot.meta.agent !== 'shell') a.agent = slot.meta.agent
    if (slot?.binding?.sessionId) a.sessionId = slot.binding.sessionId
    if (user) a.user = user
    if (label) a.label = label
    return a
  }

  /** Runs a process act, turning the model's refusals into replies. */
  private async procAct<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ProcError) throw new RequestError(e.code, e.message)
      throw e
    }
  }

  async listen(): Promise<void> {
    await mkdir(slotsDir(this.home), { recursive: true })
    // First of all: a key that cannot be private stops the boot here, before anything is watched, reaped or served.
    const staged = await prepareKeyFile(this.home, pipeKeyPath(this.home), this.log)
    try {
      await this.boot(staged)
    } catch (e) {
      await discardKeyFile(staged)
      throw e
    }
  }

  /** The boot once the key file is staged (`staged`): what listen does after prepareKeyFile. */
  private async boot(staged: string): Promise<void> {
    this.startedAt = (await processStartTime(process.pid)) ?? this.startedAt
    this.fsProbe?.('slots:scan')
    const scan = await scanSlotsAsync(this.home)
    const metas = scan.metas
    // Panes a previous tetherd left alive in tether-ptyd: listed now (read only), so the reaper spares them, and adopted
    // once this daemon owns the pipe (a loser of the race never touches them).
    const hostRuns = metas.length > 0 ? await this.hostRunsAtBoot() : undefined
    const ownedElsewhere = await perf.timedAsync('boot:reap', () => this.reapOrphans(new Set((hostRuns ?? []).map((r) => r.pid)), scan))
    await Promise.all([this.profileStore.fresh(), this.userSettings.fresh()])
    if (this.panelHostForced === undefined) this.panelHostOn = panelHostEnabled(this.userSettings.get())
    this.profileStore.start()
    this.userSettings.start()
    const profiles = this.profileStore.read()
    if (profiles.problem) this.log(`profiles: ${profiles.problem}`)
    perf.timed('boot:load', () => { for (const meta of metas) this.load(meta) })
    await this.seedMarkers(scan)
    this.dropDeadTemps(scan.names)
    // These two reads go before the slots' files are queued: the io lane is FIFO, and listening must not wait behind the hydration.
    await this.loadPause()
    if (process.platform !== 'win32' && await this.executor.run('exists', [this.pipe]).catch(() => false)) await this.executor.run('rm', [this.pipe]).catch(() => null)
    const adoptions = this.holdAdoptions(hostRuns ?? [], ownedElsewhere)
    // The procs' own files go first for the same reason: queued behind 200 slots, init (and so listening) would wait for the whole hydration.
    await this.procs.init()
    // Boot barrier: what the boot rewrote (reaped run files, the pause requests of listening entries) is on disk before serving.
    await this.store.flush()
    perf.start()
    this.startWatching()
    // Unix: the socket lives in the home; only the user may enter it (the socket itself is made 0600 below).
    if (process.platform !== 'win32') await chmod(this.home, 0o700).catch((e: Error) => this.log(`home: could not make it private (${e.message})`))
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.pipe, () => {
          this.server.off('error', reject)
          resolve()
        })
      })
      if (process.platform !== 'win32') await chmod(this.pipe, 0o600)
      // Only the owner of the pipe draws the key: a tetherd that lost the race never replaces the winner's.
      this.pipeKey = fillKeyFile(pipeKeyPath(this.home), staged)
      await this.pipeKey
      servePipeHome(this.pipe, this.home)
      // An open home is not refused (the key file carries its own checked ACL), but what else it holds (profiles.json with
      // its values) is as open as the folder. Said once per boot, by the tetherd that won the pipe and serves (a loser exits
      // with its own last line), off the boot's path.
      void folderIsPrivate(this.home).then((p) => { if (!p) this.log(`home: ${this.home} is not private to the user; other accounts of the machine may read what it holds (profiles, recipes)`) })
    } catch (e) {
      for (const a of adoptions) a.release()
      if (this.server.listening) this.server.close()
      throw e
    }
    this.server.on('error', (e) => this.log(`server error: ${e.message}`))
    // Hydration starts once the pipe is served, so the clients that connect first hear the loaded bindings.
    const hydration = this.hydrateAll(adoptions.map((a) => a.slot), metas)
    this.booting = hydration
    await perf.timedAsync('boot:adopt', () => Promise.all(adoptions.map((a) => this.adoptSlot(a))))
    if (adoptions.length > 0) this.pump()
    // Slots meant to run that nothing brought back (no adoption, no other tetherd): relaunched through the queue, off the
    // boot's path. `hydrated()` settles once each of them is launched, queued or left alone.
    const relaunch = this.relaunchAtBoot(metas, ownedElsewhere)
    this.booting = Promise.all([hydration, relaunch]).then(() => undefined)
    // Only the owner of the pipe serves the channel (a loser of the race never gets here).
    try { this.log(`ronda channel served on 127.0.0.1:${await this.rondaChannel.listen()}`) }
    catch (e) { this.log(`ronda channel not served (${(e as Error).message}); the ronda is unavailable this run`) }
    if (this.memoryIntervalMs > 0) {
      this.memoryTimer = setInterval(perf.wrap('timer:memory', () => void this.sampleMemory()), this.memoryIntervalMs)
      this.memoryTimer.unref()
    }
    this.log(`listening on ${this.pipe} (${this.slotMap.size} slots)`)
    if (this.panelHostOn) this.log('new panes launch in the terminal-pane host (tether-ptyd)')
  }

  hydrated(): Promise<void> {
    return this.booting
  }

  slots(): SlotState[] {
    const profiles = this.profileStore.profiles()
    return [...this.slotMap.values()].map((s) => this.stateOf(s, profiles))
  }

  // ---- profiles --------------------------------------------------------------------------------

  /** The slot's profile as it applies now (current profile, else the snapshot). */
  private profileOf(meta: SlotMeta, profiles = this.profileStore.profiles()): SlotProfile {
    return slotProfile(meta, profiles)
  }

  /** Where the adapter looks for the slot's session files (the profile may point Claude at another CLAUDE_CONFIG_DIR). */
  private lookupOf(slot: Slot): { env?: Record<string, string> } {
    const env = this.profileOf(slot.meta).launch?.env
    return env ? { env } : {}
  }

  /** Timestamp of the slot's last logged event (kept in memory by foldEvents): the best idle-since for a slot that had no turn since the daemon booted. */
  private lastEventTs(slot: Slot): string | undefined {
    return slot.events?.transient?.ts ?? slot.events?.lastTs
  }

  private stateOf(slot: Slot, profiles = this.profileStore.profiles()): SlotState {
    const s: SlotState = {
      slotId: slot.meta.slotId,
      kind: slot.meta.agent,
      cwd: slot.binding?.cwd ?? slot.meta.cwd,
      folder: slot.meta.cwd,
      status: slot.status,
    }
    if (slot.meta.name) s.name = slot.meta.name
    if (slot.pty && !slot.pty.exit) {
      s.pid = slot.pty.pid
      if (slot.ptyHosted) s.ptyHost = true
    }
    if (slot.binding) s.binding = slot.binding
    if (slot.title) s.title = slot.title
    if (slot.error) s.error = slot.error
    const profile = this.profileOf(slot.meta, profiles)
    if (profile.id) s.profileId = profile.id
    if (profile.name) s.profileName = profile.name
    const extra = slot.meta.agent === 'shell' ? [] : defaultAgentArgs(slot.meta.agent)
    // While a process runs, the badge describes THAT launch (a profile switched "for the next start" does not
    // make a Claude that still skips permissions look safe); otherwise it describes what the next start gets.
    const unsafe = isAlive(slot) && slot.runUnsafe !== undefined ? slot.runUnsafe : isUnsafe([...(profile.launch?.args ?? []), ...slot.meta.args, ...extra])
    if (unsafe) s.unsafe = true
    if (slot.restarting) s.restarting = true
    if (slot.stopping) s.stopping = true
    if (this.adapterOf(slot.meta.agent)?.resumes && isAlive(slot) && this.reportedThisRun(slot) && !slot.restarting && !slot.stopping) s.canRestart = true
    if (slot.attention.value) s.attention = slot.attention.value
    if (slot.attention.pending) s.attentionHeld = true
    if (slot.attention.turn === 'busy') {
      s.turn = 'busy'
      if (slot.attention.busySince) s.busySince = slot.attention.busySince
      if (slot.attention.background > 0) s.background = slot.attention.background
      if (slot.attention.delegating) s.delegating = true
    }
    else {
      const idleSince = slot.attention.idleSince ?? slot.spawnedAt ?? this.lastEventTs(slot)
      if (idleSince) s.idleSince = idleSince
    }
    if (slot.status === 'exited' || slot.status === 'error' || slot.status === 'unconfirmed') {
      const endedAt = slot.meta.endedAt ?? this.lastEventTs(slot)
      if (endedAt) s.endedAt = endedAt
    } else if (slot.memoryMB !== undefined) s.memoryMB = slot.memoryMB
    if (slot.ronda) s.ronda = { ...slot.ronda, ...(slot.rondaDue ? { due: true } : {}), channel: this.rondaChannel.connected(slot.meta.slotId) ? 'listening' : 'none' }
    // The agent door's meta fields, mirrored only when set: a slot the door never touched reads exactly as before.
    if (slot.meta.createdBy) s.createdBy = slot.meta.createdBy
    if (slot.meta.paneRequest) s.paneRequest = slot.meta.paneRequest
    if (slot.meta.held) s.held = slot.meta.held
    if (slot.meta.want) s.want = slot.meta.want
    this.door.decorate(slot.meta, s)
    return s
  }

  /** A fresh slot should not wait a whole interval for its first reading: one sample a few seconds after a spawn (coalesced). */
  private kickMemory(): void {
    if (this.memoryIntervalMs <= 0 || this.memoryKick) return
    this.memoryKick = setTimeout(perf.wrap('timer:memory-kick', () => { this.memoryKick = undefined; void this.sampleMemory() }), Math.min(5_000, this.memoryIntervalMs))
    this.memoryKick.unref()
  }

  /** One process-table query for every live slot and background process; broadcasts those whose memory moved enough. Never overlaps itself. */
  private async sampleMemory(): Promise<void> {
    if (this.memorySampling || this.closing) return
    const live = [...this.slotMap.values()].filter((s) => s.pty && !s.pty.exit)
    const procRoots = this.procs.liveRoots()
    if (!live.length && !procRoots.length) return
    this.memorySampling = true
    // The pids are taken before the first await: a stop may clear `slot.pty` while the sample runs.
    const livePids = live.map((s) => s.pty!.pid)
    try {
      await this.procs.observeExternals()
      const sums = treeBytes(await sampleProcessTable(), [...livePids, ...procRoots.map((r) => r.pid)])
      this.procs.setMemory(sums, memoryChanged)
      for (const slot of live) {
        if (!slot.pty || slot.pty.exit) continue
        const bytes = sums.get(slot.pty.pid)
        if (bytes === undefined) continue
        const mb = Math.round(bytes / 1048576)
        if (memoryChanged(slot.memoryMB, mb)) {
          slot.memoryMB = mb
          this.broadcastState(slot)
        }
      }
    } catch (e) {
      this.log(`memory sample failed: ${(e as Error).message}`)
    } finally {
      this.memorySampling = false
    }
  }

  /**
   * Points the slot at another profile (or none) and rewrites its meta: the id plus a fresh snapshot of the
   * profile's launch, or no profile fields at all. The next start applies it (planFor). Returns true when
   * something changed.
   */
  private assignProfile(slot: Slot, profile: Profile | undefined): boolean {
    const { meta } = slot
    let changed: boolean
    if (profile) changed = snapshotProfile(meta, profile)
    else {
      changed = meta.profileId !== undefined || meta.profileArgs !== undefined || meta.profileEnv !== undefined
      delete meta.profileId
      delete meta.profileArgs
      delete meta.profileEnv
    }
    if (changed) this.saveMeta(meta)
    this.broadcastState(slot)
    return changed
  }

  /** Puts the profile fields back as they were (a refused restart undoes the assignment). */
  private restoreProfileFields(slot: Slot, saved: Pick<SlotMeta, 'profileId' | 'profileArgs' | 'profileEnv'>): void {
    const { meta } = slot
    if (saved.profileId === undefined) delete meta.profileId; else meta.profileId = saved.profileId
    if (saved.profileArgs === undefined) delete meta.profileArgs; else meta.profileArgs = saved.profileArgs
    if (saved.profileEnv === undefined) delete meta.profileEnv; else meta.profileEnv = saved.profileEnv
    this.saveMeta(meta)
    this.broadcastState(slot)
  }

  /**
   * Relaunches a live slot so the new profile's args take effect, resuming the SAME session: waits until the
   * agent may be killed (awaitKillable: never kill a young Claude), requires the running agent to have
   * reported its session (else `unconfirmed`: the restart would have to guess, and a guess can lose the
   * conversation), kills the PTY tree, then starts the slot with its confirmed binding. A slot that exits by
   * itself meanwhile is left exited: its next start already uses the new profile.
   */
  private async restartSlot(slot: Slot): Promise<void> {
    const pty = slot.pty
    if (!pty || pty.exit) return
    if (slot.restarting) throw new RequestError('bad-request', `o slot ${slot.meta.slotId} já está reiniciando`)
    slot.restarting = true
    this.broadcastState(slot)
    try {
      if (slot.meta.agent !== 'shell') {
        await this.awaitKillable(slot, pty)
        if (slot.pty !== pty || pty.exit) return // exited by itself: the next start uses the new profile
        if (!this.reportedThisRun(slot)) {
          throw new RequestError('unconfirmed', `o ${slot.meta.agent} deste slot não registrou a sessão desta execução: reiniciar agora poderia perder a conversa. Troque o perfil na próxima abertura, ou encerre o slot e escolha a sessão ao iniciar`)
        }
      }
      this.log(`slot ${slot.meta.slotId}: restarting pid ${pty.pid} (profile ${slot.meta.profileId ?? '(none)'})`)
      await this.stopSlot(slot)
      await this.startSlot(slot, slot.meta.agent === 'shell' ? undefined : 'resume')
    } finally {
      slot.restarting = undefined
      this.broadcastState(slot)
    }
  }

  /** Every slot that uses the profile gets a fresh state (its name / unsafe badge may have changed). */
  private broadcastProfiles(): void {
    const profiles = this.profileStore.profiles()
    this.broadcast({ t: 'profiles', profiles })
    for (const slot of this.slotMap.values()) {
      if (!slot.meta.profileId) continue
      const state = this.stateOf(slot, profiles)
      this.broadcast({ t: 'state', slot: state })
      this.door.stateChanged(state)
    }
  }

  listening(): boolean {
    return this.server.listening && !this.closing
  }

  // ---- run files: who runs each slot, so a later tetherd can reap what this one leaves behind ----------

  /** Records the agent's identity (pid + OS start time) once it is known; nothing is written if it already exited. */
  private async recordRun(slot: Slot, pty: PtyHandle): Promise<void> {
    const agentStartedAt = await processStartTime(pty.pid)
    if (agentStartedAt === undefined || slot.pty !== pty || pty.exit) return
    const run: RunInfo = { pid: this.pid, startedAt: this.startedAt, agentPid: pty.pid, agentStartedAt, by: 'tetherd' }
    const slotId = slot.meta.slotId
    if (this.forgotten.has(slotId)) return
    this.ownRuns.add(slotId)
    this.store.put(slotRunPath(this.home, slotId), serializeRun(run))
  }

  /** Drops the slot's run file when it is this daemon's (a CLI `--here` launcher's file is left alone). */
  private forgetRun(slotId: string): void {
    if (this.ownRuns.delete(slotId)) { this.store.remove(slotRunPath(this.home, slotId)); return }
    // Not written by this daemon (a previous tetherd's): the file tells whose it is. Read by the executor; a run this daemon
    // wrote meanwhile (a relaunch of the slot) is its own and stays.
    void this.executor.run('readText', [slotRunPath(this.home, slotId)]).then(parseRunInfo, () => undefined).then((run) => {
      if (run && run.by === 'tetherd' && !this.ownRuns.has(slotId)) this.store.remove(slotRunPath(this.home, slotId))
    })
  }

  // ---- slot files: memory is the truth, the store puts it on disk behind the loop ------------------

  /** Queues the slot's meta. Never for a forgotten slot (a late write must not bring its file back). */
  private saveMeta(meta: SlotMeta): void {
    if (this.forgotten.has(meta.slotId)) return
    perf.timed('store:slot-write', () => this.store.put(slotMetaPath(this.home, meta.slotId), serializeMeta(meta)))
  }

  /** Queues the slot's ronda, or its removal when the slot has none. */
  private saveRonda(slot: Slot): void {
    const id = slot.meta.slotId
    if (this.forgotten.has(id)) return
    const path = slotRondaPath(this.home, id)
    if (slot.ronda) perf.timed('store:ronda-write', () => this.store.put(path, JSON.stringify(slot.ronda, null, 2) + '\n'))
    else this.store.remove(path)
  }

  /** Forgets the slot's files (tether's own, never the agent's session): queued behind their writes, awaited as a barrier. */
  private async removeSlotFiles(slotId: string): Promise<void> {
    this.forgotten.add(slotId)
    this.ownRuns.delete(slotId)
    const paths = [slotMetaPath(this.home, slotId), slotEventsPath(this.home, slotId), slotRunPath(this.home, slotId), slotAttentionPath(this.home, slotId), slotAnswerPath(this.home, slotId), slotRondaPath(this.home, slotId)]
    for (const p of paths) this.store.remove(p)
    await Promise.all(paths.map((p) => this.store.flush(p)))
  }

  /**
   * An atomic write cut short by a hard death leaves its temp file (`<file>.<pid>.<n>.tmp`, or `<file>.<pid>.tmp` from the CLI)
   * behind. Removed at boot when its writer is gone; a live writer's temp is left alone (its rename is still coming).
   */
  private dropDeadTemps(names: string[]): void {
    for (const name of names) {
      const m = /\.(\d+)(?:\.\d+)?\.tmp$/.exec(name)
      if (!m || pidExists(Number(m[1]))) continue
      this.executor.run('rm', [join(slotsDir(this.home), name)]).catch(() => { /* gone */ })
    }
  }

  /** A fresh slot id: unique among the slots this daemon knows (memory, not the disk) and never one it forgot. */
  private newSlotId(): string {
    for (let i = 0; i < 100; i++) {
      const id = randomSlotId()
      if (!this.slotMap.has(id) && !this.forgotten.has(id)) return id
    }
    throw new Error('could not find a free slot id')
  }

  /** A meta the watcher reported for a slot this daemon does not know (the CLI created it): read off the loop and adopted. */
  private async adoptForeign(slotId: string): Promise<void> {
    const path = slotMetaPath(this.home, slotId)
    let text: string
    try { text = await readFile(path, 'utf8') } catch { return }
    if (this.closing || this.slotMap.has(slotId) || this.forgotten.has(slotId) || this.store.isEcho(path, text)) return
    const meta = parseSlotMeta(text, slotId)
    if (!meta) return
    const adopted = this.load(meta)
    this.broadcastState(adopted)
    void this.hydrate(adopted)
  }

  /**
   * A tetherd that died hard (killed, crashed) may leave its agents alive when ConPTY does not take them down.
   * Each slot's run file names the agent by pid AND start time: a process that matches both is provably the one
   * that tetherd launched and is killed with its tree; a pid that now belongs to something else is never touched.
   * Runs whose owning tetherd is still alive (same pid and start time) are left alone; their slots are returned, so they
   * are not adopted either. Runs the terminal-pane host holds (`hostHeld`, by agent pid) are spared for adoption.
   */
  private async reapOrphans(hostHeld: ReadonlySet<number>, scan: SlotsScan): Promise<Set<string>> {
    const ownedElsewhere = new Set<string>()
    const withRun = new Set(scan.names.filter((n) => n.endsWith('.run.json')).map((n) => n.slice(0, -'.run.json'.length)))
    for (const meta of scan.metas) {
      const id = meta.slotId
      if (!withRun.has(id)) continue
      this.fsProbe?.('run:read', id)
      const run = await this.executor.run('readText', [slotRunPath(this.home, id)]).then(parseRunInfo, () => undefined)
      if (!run || run.by !== 'tetherd' || run.pid === this.pid) continue
      if (run.agentPid === undefined || run.agentStartedAt === undefined) { this.store.remove(slotRunPath(this.home, id)); continue }
      if (await isSameProcess(run.pid, run.startedAt)) {
        this.log(`slot ${id}: run owned by live tetherd pid ${run.pid}; leaving it`)
        ownedElsewhere.add(id)
        continue
      }
      // The terminal-pane host still holds it: adopted after boot, never reaped (its run file is rewritten then).
      if (hostHeld.has(run.agentPid)) {
        this.log(`slot ${id}: pid ${run.agentPid} of dead tetherd pid ${run.pid} is held by the terminal-pane host; adopting, not reaping`)
        continue
      }
      if (await isSameProcess(run.agentPid, run.agentStartedAt)) {
        await killTree(run.agentPid)
        this.log(`slot ${id}: reaped orphan pid ${run.agentPid} (started ${run.agentStartedAt}) left by tetherd pid ${run.pid}`)
      } else if (pidExists(run.agentPid)) {
        this.log(`slot ${id}: pid ${run.agentPid} is not the agent tetherd pid ${run.pid} launched (start time differs); not touched`)
      } else {
        this.log(`slot ${id}: agent pid ${run.agentPid} of dead tetherd pid ${run.pid} is already gone`)
      }
      this.store.remove(slotRunPath(this.home, id))
    }
    return ownedElsewhere
  }

  // ---- adoption: panes a previous tetherd left alive in the terminal-pane host -----------------------

  /** The host's live runs, when one answers (never launched for this); undefined otherwise. */
  private async hostRunsAtBoot(): Promise<HostRun[] | undefined> {
    try {
      return await this.panels().list()
    } catch (e) {
      this.log(`terminal-pane host: cannot list its runs (${(e as Error).message}); nothing adopted`)
      return undefined
    }
  }

  /**
   * Each live run named after one of our slots is held for adoption: the slot shows 'starting' and `launching` makes a
   * start or stop wait for the adoption, so nothing launches a second agent meanwhile. A run named after no slot is left
   * running (it is not ours to kill) and logged; so is the run of a slot another live tetherd owns (`ownedElsewhere`).
   */
  private holdAdoptions(runs: HostRun[], ownedElsewhere: ReadonlySet<string>): Adoption[] {
    const held: Adoption[] = []
    for (const run of runs) {
      const slot = this.slotMap.get(run.name)
      if (!slot) {
        this.log(`terminal-pane host runs pid ${run.pid} as "${run.name}", which is no slot of this home; left running`)
        continue
      }
      if (ownedElsewhere.has(run.name)) {
        this.log(`slot ${run.name}: pid ${run.pid} in the terminal-pane host belongs to another live tetherd; not adopted`)
        continue
      }
      if (slot.launching) continue // a second live run of the same name: adopt() takes the first
      const prior = { status: slot.status, error: slot.error }
      let done!: () => void
      slot.launching = new Promise<void>((r) => { done = r })
      slot.status = 'starting'
      slot.error = undefined
      let released = false
      held.push({
        slot,
        run,
        prior,
        release: () => {
          if (released) return
          released = true
          slot.launching = undefined
          done()
        },
      })
    }
    return held
  }

  /**
   * Adopts the run the host holds for the slot: a remote handle, `running`, the host's spawn time (the kill guard measures
   * age from it), the host's ring as scrollback and a fresh run file naming this daemon. Attention, ronda and the agent's
   * MCP channels are not rebuilt here. A run that ended before the attach leaves the slot as it was loaded.
   */
  private async adoptSlot(a: Adoption): Promise<void> {
    const { slot } = a
    const { meta } = slot
    let mine: PtyHandle | undefined
    let ended = false
    // Output that arrives before adopt() returns follows the ring it returns: held until the ring is in.
    let early: string[] | undefined = []
    let ring: string | undefined
    try {
      slot.scrollback.clear()
      const adopted = await this.panels().adopt(meta.slotId, {
        onData: perf.wrap('pane:data', (data: string) => { if (early) early.push(data); else this.paneData(slot, data, true) }),
        onExit: (exit) => {
          ended = true
          if (slot.pty !== undefined && mine !== undefined && slot.pty !== mine) return
          this.paneExit(slot, exit)
        },
        onReset: (text) => {
          if (early) { early = []; ring = text; return }
          slot.scrollback.clear()
          slot.scrollback.push(text)
        },
      })
      if (!adopted) {
        this.log(`slot ${meta.slotId}: the terminal-pane host's run (pid ${a.run.pid}) ended before it was adopted`)
        if (!ended) { slot.status = a.prior.status; slot.error = a.prior.error }
        this.dropInput(slot)
        this.forgetRun(meta.slotId)
        return
      }
      mine = adopted.handle
      slot.scrollback.push(ring ?? adopted.scrollback)
      const pending = early
      early = undefined
      if (ended) return // its exit already came through onExit
      slot.pty = mine
      slot.ptyHosted = true
      this.flushInput(slot)
      slot.spawnedAt = adopted.spawnedAt
      slot.status = 'running'
      slot.error = undefined
      if (meta.endedAt || meta.want !== 'run') {
        delete meta.endedAt
        meta.want = 'run'
        this.saveMeta(meta)
      }
      this.log(`slot ${meta.slotId}: adopted pid ${mine.pid} from the terminal-pane host (spawned ${adopted.spawnedAt})`)
      void this.recordRun(slot, mine)
      this.broadcastState(slot)
      for (const data of pending) this.paneData(slot, data, true)
      this.watchTitle(slot)
      this.kickMemory()
    } catch (e) {
      this.log(`slot ${meta.slotId}: adopting pid ${a.run.pid} failed (${(e as Error).message}); left running in the host`)
      if (!ended && slot.pty === undefined) { slot.status = a.prior.status; slot.error = a.prior.error }
      if (slot.pty === undefined) this.dropInput(slot)
    } finally {
      a.release()
      if (slot.status !== 'starting') this.broadcastState(slot)
    }
  }

  async close(): Promise<void> {
    await this.teardown(true)
  }

  /**
   * Tests: what a hard death leaves behind. Server, clients, watchers and the host connection close like in `close`, but
   * no slot is stopped: hosted panes keep running in tether-ptyd (and in-process ones in this process).
   */
  async abandon(): Promise<void> {
    await this.teardown(false)
  }

  private async teardown(stopSlots: boolean): Promise<void> {
    if (this.closing) return
    this.closing = true
    perf.stop()
    if (this.memoryTimer) clearInterval(this.memoryTimer)
    if (this.memoryKick) clearTimeout(this.memoryKick)
    for (const s of this.slotMap.values()) if (s.rondaTimer) clearTimeout(s.rondaTimer)
    this.queue.length = 0
    // Background processes live in tether-procd and outlive this daemon: only the connection to it closes.
    this.procs.close()
    // Every slot is stopped in parallel (each waits for its own agent to be old enough) while the event files
    // are still watched: a young Claude's start report must be seen to let its kill go ahead.
    if (stopSlots) await Promise.all([...this.slotMap.values()].map((s) => this.stopSlot(s)))
    else {
      for (const s of this.slotMap.values()) {
        for (const t of [s.readyTimer, s.attentionTimer, s.wakeTimer]) if (t) clearTimeout(t)
        this.clearBackground(s.meta.slotId)
        this.unwatchTitle(s)
      }
    }
    this.watcher?.close()
    this.profileStore.stop()
    this.userSettings.stop()
    this.eventsDirty.clear()
    for (const t of this.pending.values()) clearTimeout(t)
    await this.rondaChannel.close()
    this.panelHost?.close() // the host outlives tetherd: only the connection closes
    for (const c of this.clients) c.socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    unservePipeHome(this.pipe, this.home)
    // What is queued for the disk lands before `closed` (a hard death loses only this queue). The executor is closed here
    // only when it is the daemon's own; tetherd's main closes the process' one after the log is flushed.
    await this.store.drain()
    await this.executor.drain()
    if (isAgentExecutor(this.executor)) setAgentExecutor(undefined)
    if (this.ownExecutor) await this.executor.close()
    this.log('closed')
  }

  // ---- slots ---------------------------------------------------------------------------------

  /** The agent's adapter, or undefined when the agent is not registered (its extension is off or gone). */
  private adapterOf(agent: AgentName): AgentAdapter | undefined {
    return this.adapterOverrides[agent] ?? agentRegistry.get(agent)?.adapter
  }

  private unavailableError(meta: SlotMeta): { code: ErrorCode; message: string } | undefined {
    if (meta.agent === 'shell' || this.adapterOf(meta.agent)) return undefined
    return { code: 'agent-unavailable', message: `o agente ${meta.agent} não está disponível (extensão desativada ou ausente); o slot continua guardado` }
  }

  private emitSlot(kind: SlotEventKind, slot: Slot, state = this.stateOf(slot)): void {
    if (!this.onSlot) return
    if (slot.meta.agent !== 'shell') slot.tabTitle = slotTitle(state)
    try { this.onSlot(kind, state) } catch (e) { this.log(`onSlot listener failed: ${(e as Error).message}`) }
  }

  /**
   * The text of the pane's tab (slot name, else session title, else folder) changed since the extensions last heard of the
   * slot: they get a `changed` (the web-bridge renames the agent at the bridge). Every path that changes it (rename, title
   * read or polled, new binding) broadcasts the state, so this one check covers them; the first sight of a slot is no change.
   */
  private noteTabTitle(slot: Slot, state: SlotState): void {
    if (!this.onSlot || slot.meta.agent === 'shell') return
    const title = slotTitle(state)
    if (slot.tabTitle === undefined) { slot.tabTitle = title; return }
    if (slot.tabTitle !== title) this.emitSlot('changed', slot, state)
  }

  private load(meta: SlotMeta): Slot {
    const unavailable = this.unavailableError(meta)
    const slot: Slot = {
      meta,
      status: unavailable ? 'error' : 'exited',
      ...(unavailable ? { error: unavailable } : {}),
      scrollback: new Scrollback(),
      attention: new AttentionState(attentionOptions(meta.agent)),
      attached: new Set(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    }
    this.slotMap.set(meta.slotId, slot)
    return slot
  }

  /**
   * Loads what the slot's files hold beyond its meta: the events (binding, last event time), the title and the ronda. The boot
   * does not wait for it: until it lands the slot's state lacks those fields (nothing is guessed), and clients get the state
   * again when it changes. One call per slot; a request that needs the binding awaits it.
   */
  private hydrate(slot: Slot): Promise<void> {
    slot.hydrating ??= this.hydrateNow(slot).catch((e: Error) => this.log(`slot ${slot.meta.slotId}: cannot load its files: ${e.message}`))
    return slot.hydrating
  }

  private async hydrateNow(slot: Slot): Promise<void> {
    const slotId = slot.meta.slotId
    const before = JSON.stringify(this.stateOf(slot))
    await this.pullEvents(slot, false)
    this.fsProbe?.('ronda:read', slotId)
    const ronda = await this.executor.run('readText', [slotRondaPath(this.home, slotId)]).then(parseRonda, () => undefined)
    if (this.slotMap.get(slotId) !== slot) return
    if (ronda && !slot.ronda) { slot.ronda = ronda; this.armRonda(slot) }
    if (JSON.stringify(this.stateOf(slot)) !== before) this.broadcastState(slot)
  }

  /** Loads every known slot's files in the background: the live (adopted) ones first, then the newest, a few at a time. */
  private async hydrateAll(live: Slot[], metas: SlotMeta[]): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_GRACE_MS)) // the clients that connect as the boot ends are there for the first loads
    const order = [...live]
    const seen = new Set(live)
    for (let i = metas.length - 1; i >= 0; i--) {
      const slot = this.slotMap.get(metas[i]!.slotId)
      if (slot && !seen.has(slot)) order.push(slot)
    }
    await perf.timedAsync('boot:hydrate', () => mapLimit(order, HYDRATE_CONCURRENCY, async (slot) => {
      await this.hydrate(slot)
      await new Promise<void>((resolve) => setImmediate(resolve)) // the loop serves its clients between slots
    }))
  }

  /**
   * Boot: every slot whose intent is 'run' and that is not up (not adopted, not owned by another live tetherd) is started
   * again, one after another in a stable order (creation time, then id), through the start queue (MAX_STARTING). An agent
   * resumes only a CONFIRMED binding; without one it is left 'unconfirmed' for the user to choose (a guess can lose the
   * conversation). A shell starts anew. A slot relaunched MAX_BOOT_TRIES times in a row without a healthy run is left
   * exited. Legacy slots (no `want`) are never relaunched. A failing launch fails only its slot.
   */
  private async relaunchAtBoot(metas: SlotMeta[], ownedElsewhere: ReadonlySet<string>): Promise<void> {
    const order = metas
      .filter((m) => m.want === 'run' && !ownedElsewhere.has(m.slotId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    for (const m of order) {
      if (this.closing) return
      const slot = this.slotMap.get(m.slotId)
      if (!slot || slot.meta.want !== 'run' || this.unavailableError(slot.meta)) continue
      try {
        await this.hydrate(slot) // the binding to resume comes from the events file
        if (this.closing || this.slotMap.get(m.slotId) !== slot || slot.meta.want !== 'run') continue
        if (isAlive(slot) || slot.preLaunch || slot.launching || slot.startPending || slot.status !== 'exited') continue // up, or a client started it first
        const { meta } = slot
        let choice: 'resume' | undefined
        if (meta.agent !== 'shell') {
          if (!slot.binding?.confirmed) {
            slot.status = 'unconfirmed'
            this.log(`slot ${meta.slotId}: meant to run, but its binding is not confirmed; not relaunched (the user chooses)`)
            this.broadcastState(slot)
            continue
          }
          choice = 'resume'
        }
        const tries = meta.bootTries ?? 0
        if (tries >= MAX_BOOT_TRIES) {
          this.log(`slot ${meta.slotId}: relaunched ${tries} boots in a row without a healthy run; not relaunched (a manual start resets it)`)
          continue
        }
        meta.bootTries = tries + 1
        this.saveMeta(meta)
        await this.store.flush(slotMetaPath(this.home, meta.slotId)) // the try is on disk before the launch (a crash in it counts)
        if (this.closing || this.slotMap.get(m.slotId) !== slot) continue
        this.log(`slot ${meta.slotId}: relaunching at boot (${choice ? 'resume ' + slot.binding!.sessionId : 'new shell'}, try ${meta.bootTries})`)
        this.startSlot(slot, choice).catch((e: Error) => this.log(`slot ${meta.slotId}: boot relaunch failed: ${e.message}`))
      } catch (e) {
        this.log(`slot ${m.slotId}: boot relaunch failed: ${(e as Error).message}`)
      }
    }
  }

  /** A start asked by a client or the door: an exited slot started by hand clears its crash-loop count first. */
  private async manualStart(slot: Slot, choice: 'resume' | 'new' | undefined): Promise<void> {
    if (slot.meta.bootTries !== undefined && !isAlive(slot) && !slot.preLaunch && !slot.launching && !slot.startPending && slot.status !== 'queued' && slot.status !== 'starting') {
      delete slot.meta.bootTries
      this.saveMeta(slot.meta)
    }
    await this.startSlot(slot, choice)
  }

  /** Records the slot's intent (meta.want); true when it changed (the meta is queued for the disk). */
  private setWant(slot: Slot, want: SlotWant): boolean {
    if (slot.meta.want === want) return false
    slot.meta.want = want
    this.saveMeta(slot.meta)
    return true
  }

  /** The run proved healthy (it reported its session, or lived BOOT_HEALTHY_MS): the crash-loop count starts over. */
  private clearBootTries(slot: Slot): void {
    if (slot.meta.bootTries === undefined) return
    delete slot.meta.bootTries
    this.saveMeta(slot.meta)
  }

  private slot(slotId: unknown): Slot {
    const s = typeof slotId === 'string' ? this.slotMap.get(slotId) : undefined
    if (!s) throw new RequestError('unknown-slot', `slot desconhecido: ${String(slotId)}`)
    return s
  }

  /**
   * Folds a read of the events file into the slot's view; false when nothing new arrived. Only the events from the last
   * `start` on are kept (`currentBinding` looks at nothing older); a read that starts at 0 means the file was rewritten.
   */
  private foldEvents(slot: Slot, r: EventsRead): boolean {
    let v = slot.events
    if (r.start === 0 || !v) {
      v = slot.events = { resume: 0, kept: [], fragment: '' }
      slot.turnPending = undefined
    } else if (r.complete === '' && r.fragment === v.fragment) return false
    const added = parseEvents(r.complete)
    if (added.length) {
      v.lastTs = added[added.length - 1]!.ts
      v.kept = v.kept.concat(added)
      for (let i = v.kept.length - 1; i > 0; i--) if (v.kept[i]!.kind === 'start') { v.kept = v.kept.slice(i); break }
    }
    const turns = parseSoulReports(r.complete)
    if (turns.length) slot.turnPending = (slot.turnPending ?? []).concat(turns)
    v.resume = r.resume
    v.fragment = r.fragment
    const transient = r.fragment ? parseEventLine(r.fragment) : undefined
    if (transient) v.transient = transient
    else delete v.transient
    return true
  }

  /**
   * The same read, off the event loop, from where the last one stopped: the debounced watcher path. A synchronous refresh
   * that lands meanwhile moves the offset, and the read that lost the race is dropped and repeated.
   */
  private pullEvents(slot: Slot, broadcast = true): Promise<void> {
    if (slot.pulling) { slot.pullAgain = true; return slot.pulling }
    const slotId = slot.meta.slotId
    const run = async (): Promise<void> => {
      do {
        slot.pullAgain = undefined
        const from = slot.events?.resume ?? 0
        this.fsProbe?.(from === 0 ? 'events:full' : 'events:tail', slotId)
        const r = await readEventsFrom(this.home, slotId, from)
        if (this.slotMap.get(slotId) !== slot) return
        if ((slot.events?.resume ?? 0) !== from) { slot.pullAgain = true; continue }
        if (this.foldEvents(slot, r)) {
          this.applyBinding(slot, broadcast)
          this.applyTurnReports(slot)
        }
      } while (slot.pullAgain)
    }
    const p: Promise<void> = run().catch((e: Error) => this.log(`slot ${slotId}: cannot read the events file: ${e.message}`)).finally(() => { if (slot.pulling === p) slot.pulling = undefined })
    slot.pulling = p
    return p
  }

  /** Derives the binding from the kept events; broadcasts `state` when binding or title changed. */
  private applyBinding(slot: Slot, broadcast: boolean): void {
    const v = slot.events
    const binding = currentBinding(v?.transient ? [...v.kept, v.transient] : (v?.kept ?? []), slot.meta)
    const changed = JSON.stringify(binding) !== JSON.stringify(slot.binding)
    if (!changed) return
    slot.binding = binding
    slot.title = binding?.title
    if (slot.meta.bootTries !== undefined && isAlive(slot) && this.reportedThisRun(slot)) this.clearBootTries(slot) // a healthy run
    if (slot.status === 'starting' && binding && slot.spawnedAt && binding.since >= slot.spawnedAt) this.setRunning(slot) // broadcasts
    else if (broadcast) this.broadcastState(slot)
    this.unwatchTitle(slot) // the watch follows one binding; this one changed
    if (isAlive(slot)) this.watchTitle(slot)
    this.emitSlot('bound', slot)
    const titleAdapter = binding && !binding.title ? this.adapterOf(binding.agent) : undefined
    if (binding && titleAdapter) {
      void this.titleLookups(() => titleAdapter.title(binding, this.lookupOf(slot))).then((title) => {
        if (!title || slot.binding !== binding || slot.title === title) return
        slot.title = title
        this.broadcastState(slot)
      })
    }
  }

  /**
   * The agent confirmed it is up (its start event arrived) or the fallback expired: frees a 'starting' seat.
   * The slot's `running` state goes out BEFORE the queue is pumped, or clients would see the next slot's
   * `starting` first and count MAX_STARTING + 1 in 'starting' for a moment.
   */
  private setRunning(slot: Slot): void {
    if (slot.readyTimer) clearTimeout(slot.readyTimer)
    slot.readyTimer = undefined
    slot.status = 'running'
    this.broadcastState(slot)
    this.pump()
  }

  // ---- title watch (agents whose renames bypass the slot jsonl) --------------------------------

  private watchTitle(slot: Slot): void {
    const binding = slot.binding
    if (slot.stopTitleWatch || !binding || slot.meta.agent === 'shell') return
    const adapter = this.adapterOf(slot.meta.agent)
    if (!adapter?.watchTitle) return
    const stop = adapter.watchTitle(binding, perf.wrap('watch:title', (title: string) => {
      if (slot.binding !== binding || slot.title === title) return
      slot.title = title
      this.broadcastState(slot)
    }), this.titlePollMs, this.lookupOf(slot))
    slot.stopTitleWatch = (): void => {
      slot.stopTitleWatch = undefined
      stop()
    }
  }

  private unwatchTitle(slot: Slot): void {
    slot.stopTitleWatch?.()
  }

  // ---- starting, queueing, stopping ----------------------------------------------------------

  /** Validates the start and returns the binding to resume (undefined = new session). */
  private resumeFor(slot: Slot, choice: 'resume' | 'new' | undefined): Binding | undefined {
    const { meta } = slot
    const resume = choice === 'new' ? undefined : slot.binding
    if ((slot.status === 'unconfirmed' || (resume && !resume.confirmed)) && !choice) {
      throw new RequestError('unconfirmed', 'vínculo não confirmado: escolha retomar ou iniciar nova sessão')
    }
    if (resume) {
      for (const other of this.slotMap.values()) {
        if (other !== slot && (other.preLaunch || other.launching || (other.pty && !other.pty.exit)) && other.binding?.sessionId === resume.sessionId) {
          throw new RequestError('already-open', `a sessão já está aberta no slot ${other.meta.slotId}`)
        }
      }
    }
    return resume
  }

  /** The folder the start runs in, or undefined when it exists (checked by the executor, never in the loop). */
  private async missingCwd(slot: Slot, resume: Binding | undefined): Promise<string | undefined> {
    const cwd = resume ? resume.cwd : slot.meta.cwd
    this.fsProbe?.('cwd:check', slot.meta.slotId)
    // An executor failure is not a missing folder: the spawn itself will say what is wrong.
    return (await this.executor.run('exists', [cwd]).catch(() => true)) ? undefined : cwd
  }

  /** Read through a method so a check made before an await is not narrowed away. */
  private isQueued(slot: Slot): boolean {
    return slot.status === 'queued'
  }

  private preLaunchOf(slot: Slot): PreLaunch | undefined {
    return slot.preLaunch
  }

  private startingCount(): number {
    let n = 0
    for (const s of this.slotMap.values()) if (s.status === 'starting') n++
    return n
  }

  /**
   * Starts the slot now, or queues it when MAX_STARTING agents are already 'starting' (a layout being
   * restored launches many at once). Shell slots never queue: they are up as soon as they spawn.
   */
  private startSlot(slot: Slot, choice: 'resume' | 'new' | undefined): Promise<void> {
    // Concurrent starts of one slot share the first one's outcome (the folder check and the hydration are awaits now).
    if (slot.startPending) return slot.startPending
    const p: Promise<void> = this.startSlotNow(slot, choice).finally(() => { if (slot.startPending === p) slot.startPending = undefined })
    slot.startPending = p
    return p
  }

  private async startSlotNow(slot: Slot, choice: 'resume' | 'new' | undefined): Promise<void> {
    if (slot.preLaunch) { await slot.preLaunch.done; return } // idempotent: already being launched
    if (slot.launching) { await slot.launching; return }
    if (slot.pty && !slot.pty.exit) return // idempotent: already up
    if (slot.status === 'queued') return // already waiting its turn
    await this.hydrate(slot) // the binding to resume comes from the events file
    const pre = this.preLaunchOf(slot) // read through a method: the check above would narrow it away
    if (pre) { await pre.done; return }
    if (slot.launching) { await slot.launching; return }
    if (slot.pty && !slot.pty.exit) return
    if (this.isQueued(slot)) return
    const unavailable = this.unavailableError(slot.meta)
    if (unavailable) throw this.fail(slot, unavailable.code, unavailable.message)
    this.resumeFor(slot, choice) // a start that cannot be made is refused before it takes a seat or a queue place
    if (slot.meta.agent !== 'shell' && this.startingCount() >= MAX_STARTING) {
      slot.status = 'queued'
      slot.error = undefined
      slot.queuedChoice = choice
      this.queue.push(slot)
      this.log(`slot ${slot.meta.slotId}: queued (${this.queue.length} waiting)`)
      this.broadcastState(slot)
      return
    }
    await this.seatAndLaunch(slot, choice)
  }

  /**
   * Takes the slot's 'starting' seat NOW, synchronously (the caller saw it free), and only then runs the launch's awaits:
   * folder check, fresh config, session check, plan, ronda file, spawn. A burst of starts therefore never counts more than
   * MAX_STARTING in 'starting'. The seat is taken silently (clients hear 'starting' once, with the pid). A stop meanwhile
   * cancels (stopSlot); a failure goes to the slot's error state. Either way the seat frees and the queue is pumped.
   */
  private async seatAndLaunch(slot: Slot, choice: 'resume' | 'new' | undefined): Promise<void> {
    let release!: () => void
    const pre: PreLaunch = { done: new Promise<void>((r) => { release = r }), release: () => release() }
    slot.preLaunch = pre
    slot.status = 'starting'
    try {
      // A stop releases `pre` at once: the start answers then, without waiting for a plan that may still be pending
      // (the launch ends by itself when it comes, spawning nothing; it never rejects once cancelled).
      const launching = this.launch(slot, choice, pre)
      launching.catch(() => { /* raced below */ })
      await Promise.race([launching, pre.done])
    } catch (e) {
      // launch fails the slot itself; anything else (a refused resume, an unexpected error) still must free the seat
      if (slot.preLaunch === pre && slot.status === 'starting' && !slot.pty && !slot.launching) {
        const err = e instanceof RequestError ? e : new RequestError('spawn-failed', (e as Error).message)
        slot.preLaunch = undefined
        throw this.fail(slot, err.code, err.message)
      }
      throw e
    } finally {
      if (slot.preLaunch === pre) slot.preLaunch = undefined
      pre.release()
      this.pump() // a seat may be free again (failure, cancel); a no-op otherwise
    }
  }

  /** The newest profiles and settings, awaited before a plan is made (the snapshots may lag the file by a watcher tick). */
  private async freshLaunchConfig(): Promise<void> {
    await Promise.all([this.profileStore.fresh(), this.userSettings.fresh()])
  }

  /** Launches queued slots while seats are free. A start that fails now is reported through the slot's state. */
  private pump(): void {
    perf.timed('pump', () => this.pumpQueue())
  }

  private pumpQueue(): void {
    while (this.queue.length > 0 && this.startingCount() < MAX_STARTING) {
      const slot = this.queue.shift()!
      if (slot.status !== 'queued') continue
      const choice = slot.queuedChoice
      slot.queuedChoice = undefined
      try {
        this.resumeFor(slot, choice)
      } catch (e) {
        const err = e instanceof RequestError ? e : new RequestError('spawn-failed', (e as Error).message)
        this.fail(slot, err.code, err.message)
        continue
      }
      // The seat is taken synchronously (the next turn of this loop counts it); the outcome is reported through the slot's state.
      this.seatAndLaunch(slot, choice).catch(() => { /* failed or cancelled: the slot says so */ })
    }
  }

  /** A launch failure while the launch still holds its seat: the seat goes with the error state. */
  private failLaunch(slot: Slot, pre: PreLaunch, code: ErrorCode, message: string): RequestError {
    if (slot.preLaunch === pre) slot.preLaunch = undefined
    return this.fail(slot, code, message)
  }

  /** Takes the slot out of the queue (stop/forget while waiting). */
  private dequeue(slot: Slot): void {
    const i = this.queue.indexOf(slot)
    if (i >= 0) this.queue.splice(i, 1)
    if (slot.status === 'queued') {
      slot.status = 'exited'
      slot.queuedChoice = undefined
      this.broadcastState(slot)
    }
  }

  /**
   * Launches the slot's process. In process (spawnPty) everything happens before this returns. In the terminal-pane host the
   * slot turns 'starting' (its seat counted) BEFORE the host is awaited, and `launching` makes a start or stop meanwhile
   * wait for the handle. The callbacks are the same either way; output may arrive before the handle does.
   */
  private async launch(slot: Slot, choice: 'resume' | 'new' | undefined, pre: PreLaunch): Promise<void> {
    const { meta } = slot
    // Every await below may end with the launch cancelled (a stop cleared `preLaunch`): then nothing more happens.
    const cancelled = (): boolean => slot.preLaunch !== pre
    let resume = this.resumeFor(slot, choice)
    const [missing] = await Promise.all([this.missingCwd(slot, resume), this.freshLaunchConfig()])
    if (cancelled()) return
    if (missing !== undefined) throw this.failLaunch(slot, pre, 'cwd-missing', `a pasta não existe: ${missing}`)
    resume = this.resumeFor(slot, choice) // what the wait may have changed (another slot opened the session)
    if (resume) {
      // PRD C15: a resume of a session the agent no longer has must fail here, not inside the agent's TUI.
      const exists = await (this.adapterOf(resume.agent)?.sessionExists(resume, this.lookupOf(slot)) ?? 'unknown')
      if (cancelled()) return
      if (exists === false) throw this.failLaunch(slot, pre, 'session-missing', `a sessão ${resume.sessionId} não existe mais no ${resume.agent}`)
    }
    let plan: LaunchPlan
    try {
      plan = await this.planFor(slot, resume)
    } catch (e) {
      if (cancelled()) return
      throw this.failLaunch(slot, pre, e instanceof RequestError ? e.code : 'spawn-failed', (e as Error).message)
    }
    if (cancelled()) return
    // The ronda's channel, offered at every launch of an agent that takes one (a new key per run); its MCP file is on disk
    // when this resolves (the CLI reads it as it starts).
    const channel = meta.agent === 'shell' ? undefined : this.channelOf(meta.agent)
    const offer = await this.rondaChannel.prepare(plan, meta.slotId, channel)
    // The agent door's offer, after the ronda's (it may add its own server to the plan); awaited only when it is a promise.
    let grant = cancelled() ? undefined : this.door.prepareLaunch(offer.plan, {
      meta,
      agent: meta.agent === 'shell' ? undefined : agentRegistry.get(meta.agent),
      channel,
      rondaOffered: offer.offered,
    })
    if (grant instanceof Promise) grant = await grant
    if (cancelled() || !grant) {
      if (offer.offered) this.rondaChannel.revoke(meta.slotId, offer.run) // only this grant: a newer launch keeps its own
      grant?.revoke()
      return
    }
    // From here the spawn holds the seat (no await before it in process; `launching` in the host): a stop waits for it.
    slot.preLaunch = undefined
    plan = grant.plan
    // The start dialog of the channel flag, whether the ronda's (alone or joined by the door's) or the door's alone.
    const confirm = channel?.confirm ?? (meta.agent === 'shell' ? undefined : agentRegistry.get(meta.agent)?.channelConfirm)
    slot.confirmWatch = (offer.offered || grant.channel) && confirm ? { spec: confirm, screen: '' } : undefined
    slot.scrollback.clear()
    slot.attention.reset()
    this.clearBackground(meta.slotId)
    slot.error = undefined
    slot.memoryMB = undefined
    // A launch that happens means the slot is meant to run (whoever asked: a client, the door, the boot).
    if (meta.endedAt || meta.want !== 'run') {
      delete meta.endedAt
      meta.want = 'run'
      this.saveMeta(meta)
    }
    slot.spawnedAt = new Date().toISOString()
    slot.runUnsafe = isUnsafe(plan.args)
    const hosted = this.panelHostOn
    let ended = false
    let mine: PtyHandle | undefined
    const callbacks: PanelCallbacks = {
      onData: perf.wrap('pane:data', (data: string) => this.paneData(slot, data, hosted)),
      onExit: (exit) => {
        ended = true
        // A hosted run that is no longer the slot's (it ended after a relaunch) changes nothing.
        if (hosted && slot.pty !== undefined && mine !== undefined && slot.pty !== mine) return
        this.paneExit(slot, exit)
      },
    }
    if (!hosted) {
      try {
        mine = spawnPty(plan, { cols: slot.cols, rows: slot.rows, onData: callbacks.onData, onExit: callbacks.onExit })
      } catch (e) {
        throw this.fail(slot, 'spawn-failed', (e as Error).message)
      }
      slot.pty = mine
      slot.ptyHosted = undefined
      this.flushInput(slot)
    } else {
      // The seat is taken now (startingCount, pump) but not announced: clients hear 'starting' once, with the pid, as before.
      slot.status = 'starting'
      let done!: () => void
      slot.launching = new Promise<void>((r) => { done = r })
      const { cols, rows } = slot
      try {
        mine = await this.panels().spawn(meta.slotId, plan, {
          cols,
          rows,
          ...callbacks,
          // The host's ring no longer continues what the slot has: start the scrollback over from it.
          onReset: (text) => {
            slot.scrollback.clear()
            slot.scrollback.push(text)
          },
        })
        slot.pty = mine
        slot.ptyHosted = true
        if (!ended) this.flushInput(slot)
      } catch (e) {
        const err = this.fail(slot, 'spawn-failed', `não foi possível abrir o terminal no anfitrião de terminais (tether-ptyd): ${(e as Error).message}`)
        this.pump() // the 'starting' seat it held is free again
        throw err
      } finally {
        slot.launching = undefined
        done()
      }
      if (slot.cols !== cols || slot.rows !== rows) mine.resize(slot.cols, slot.rows)
      if (ended) { // it ended before its handle came back: onExit already reported it
        this.log(`slot ${meta.slotId}: pid ${mine.pid} ended before its launch finished`)
        return
      }
    }
    this.log(`slot ${meta.slotId}: spawned pid ${mine.pid} (${meta.agent}${hosted ? ', host' : ''}${resume ? ', resume ' + resume.sessionId : ''})`)
    void this.recordRun(slot, mine)
    if (meta.agent === 'shell') slot.status = 'running'
    else {
      slot.status = 'starting'
      slot.readyTimer = setTimeout(perf.wrap('timer:ready', () => {
        if (slot.status === 'starting') this.setRunning(slot)
      }), this.readyFallbackMs)
      slot.readyTimer.unref()
    }
    this.broadcastState(slot)
    this.watchTitle(slot)
    this.kickMemory()
    this.emitSlot('spawned', slot)
  }

  /** Output of the slot's pane (in process or hosted): scrollback, attention, then the attached clients (a direct client reads a hosted pane from the host). */
  private paneData(slot: Slot, data: string, hosted: boolean): void {
    slot.scrollback.push(data)
    let probe: Probe | undefined
    if (slot.probe) probe = this.takeProbe(slot)
    if (slot.confirmWatch) this.watchConfirm(slot, data)
    if (slot.attention.output(data, Date.now())) this.broadcastState(slot)
    this.scheduleAttention(slot)
    const slotId = slot.meta.slotId
    for (const c of slot.attached) {
      if (hosted && c.direct) continue
      this.send(c, probe ? { t: 'data', slotId, data, probe } : { t: 'data', slotId, data })
    }
  }

  /** The slot's current process ended (the caller already checked it is the slot's run). */
  private paneExit(slot: Slot, exit: PtyExit): void {
    const { meta } = slot
    this.dropInput(slot)
    this.log(`slot ${meta.slotId}: exited (code ${exit.exitCode})`)
    this.forgetRun(meta.slotId)
    this.rondaChannel.revoke(meta.slotId)
    this.door.exited(meta.slotId)
    slot.confirmWatch = undefined
    if (slot.readyTimer) clearTimeout(slot.readyTimer)
    slot.readyTimer = undefined
    slot.status = 'exited'
    slot.memoryMB = undefined
    slot.attention.reset()
    this.clearBackground(meta.slotId)
    if (slot.wakeTimer) { clearTimeout(slot.wakeTimer); slot.wakeTimer = undefined }
    this.markEnded(slot)
    if (slot.attentionTimer) clearTimeout(slot.attentionTimer)
    this.unwatchTitle(slot)
    // The hook's last line may land right before the exit: the events file is read once more (off the loop) before the verdict.
    const tail: Promise<void> = this.pullEvents(slot, false).then(() => this.finishExit(slot)).catch((e: Error) => this.log(`slot ${slot.meta.slotId}: exit handling failed: ${e.message}`)).finally(() => { if (slot.exitTail === tail) slot.exitTail = undefined })
    slot.exitTail = tail
  }

  /** The tail of `paneExit`, once the events file has been read for the last time of this run. */
  private finishExit(slot: Slot): void {
    const { meta } = slot
    // PRD C18: an agent run that never reported its session (old version, hook removed, crashed before the
    // hook) leaves the binding unconfirmed: the next start must be an explicit choice, never a silent guess.
    // A relaunch that began meanwhile owns the status now.
    if (slot.status === 'exited' && meta.agent !== 'shell' && !this.reportedThisRun(slot)) {
      slot.status = 'unconfirmed'
      this.log(`slot ${meta.slotId}: no start event for this run; binding unconfirmed`)
    }
    // Crash-loop guard: a run that reported its session or lived long enough was healthy (measured at its exit, no timer).
    if (meta.bootTries !== undefined && (this.reportedThisRun(slot) || (slot.spawnedAt !== undefined && Date.now() - Date.parse(slot.spawnedAt) >= BOOT_HEALTHY_MS))) this.clearBootTries(slot)
    this.broadcastState(slot)
    this.emitSlot('exited', slot)
    // The panel's agent left: its process uses end. A restart in place (restartSlot, set-profile) and tetherd
    // closing are not leaving.
    if (!slot.restarting && !this.closing) this.procs.slotGone(meta.slotId)
    this.pump()
  }

  /** The link to tether-ptyd (created once; it reconnects, and relaunches the host, at the next spawn after a drop). */
  private panels(): PanelHost {
    this.panelHost ??= new PanelHost({
      log: this.log,
      connector: {
        tryOpen: () => this.openPanelHost(false),
        ensure: async () => {
          const c = await this.openPanelHost(true)
          if (!c) throw new Error('o anfitrião de terminais não respondeu')
          return c
        },
      },
    })
    return this.panelHost
  }

  private async openPanelHost(launch: boolean): Promise<HostClient | undefined> {
    const c = await this.connectPanelHost(launch)
    if (c) this.panelHostPid = c.hello.pid
    return c
  }

  /**
   * The plan applies the slot's profile AS IT IS NOW (an edit takes effect on the next start) and refreshes the
   * slot's snapshot of it, so a profile deleted later still launches the slot the way it last ran.
   */
  private async planFor(slot: Slot, resume: Binding | undefined): Promise<LaunchPlan> {
    const { meta } = slot
    const profiles = this.profileStore.profiles()
    const current = profiles.find((p) => p.id === meta.profileId)
    if (current && snapshotProfile(meta, current)) {
      this.saveMeta(meta)
    }
    const profile = this.profileOf(meta, profiles).launch
    let plan: LaunchPlan
    if (meta.agent === 'shell') plan = await shellAdapter.plan({ slot: meta, cwd: resume?.cwd, profile, exec: this.executor })
    else {
      const adapter = this.adapterOf(meta.agent)
      if (!adapter) throw new RequestError('agent-unavailable', `o agente ${meta.agent} não está disponível`)
      plan = await adapter.plan({ slot: meta, home: this.home, resume, extraArgs: defaultAgentArgs(meta.agent), profile, exec: this.executor })
    }
    plan = withTabEnv(plan, meta)
    return this.transformPlan ? await this.transformPlan(plan, meta, this.stateOf(slot)) : plan
  }

  /**
   * The channel's start dialog (Claude Code asks to confirm `--dangerously-load-development-channels`): answered once, only
   * while this run has not reported its start, only when the screen shows exactly the dialog the agent described. Anything
   * else gets no key: the slot shows what the agent shows.
   */
  private watchConfirm(slot: Slot, data: string): void {
    const w = slot.confirmWatch!
    if (this.reportedThisRun(slot)) { slot.confirmWatch = undefined; return }
    w.screen = (w.screen + data).slice(-CONFIRM_SCREEN_MAX)
    if (!showsConfirm(w.screen, w.spec)) return
    slot.confirmWatch = undefined
    const pty = slot.pty
    this.log(`slot ${slot.meta.slotId}: channel confirmation recognized; answering`)
    setTimeout(perf.wrap('timer:confirm', () => {
      if (slot.pty !== pty || !isAlive(slot) || this.reportedThisRun(slot)) return
      pty?.write(w.spec.keys)
    }), CONFIRM_DELAY_MS).unref()
  }

  /** A start event of the agent arrived at/after the last spawn (the binding describes what this run opened). */
  private reportedThisRun(slot: Slot): boolean {
    return slot.binding !== undefined && slot.spawnedAt !== undefined && slot.binding.since >= slot.spawnedAt
  }

  /** Records when the run ended (in the meta, so a restarted daemon still knows). */
  private markEnded(slot: Slot): void {
    slot.meta.endedAt = new Date().toISOString()
    this.saveMeta(slot.meta)
  }

  private fail(slot: Slot, code: ErrorCode, message: string): RequestError {
    slot.status = 'error'
    slot.error = { code, message }
    this.dropInput(slot)
    this.markEnded(slot)
    this.log(`slot ${slot.meta.slotId}: ${code}: ${message}`)
    this.broadcastState(slot)
    return new RequestError(code, message)
  }

  /** Agents whose young death counts against the user (Claude's boot strikes); shells are killed at once. */
  private guardsAge(slot: Slot): boolean {
    return slot.meta.agent !== 'shell' && this.minAgentAgeMs > 0
  }

  /**
   * The one wait before any kill of an agent: returns once the process is at least minAgentAgeMs old AND has
   * reported this run (its start event was seen: the agent finished starting); or when the process is gone; or
   * after killWaitCapMs, so a stop can never hang. The ready fallback does NOT release the kill: on a loaded
   * machine Claude takes longer than READY_FALLBACK_MS to report, and killing it then is the boot strike this
   * wait exists to prevent. Polls: the report arrives through the file watcher, which already updates the slot.
   */
  private async awaitKillable(slot: Slot, pty: PtyHandle, onWait?: () => void): Promise<void> {
    if (!this.guardsAge(slot)) return
    const ageDeadline = (slot.spawnedAt ? Date.parse(slot.spawnedAt) : 0) + this.minAgentAgeMs
    const cap = Date.now() + this.killWaitCapMs
    let waiting = false
    while (slot.pty === pty && !pty.exit) {
      const now = Date.now()
      if (now >= ageDeadline && this.reportedThisRun(slot)) return
      if (now >= cap) {
        this.log(`slot ${slot.meta.slotId}: pid ${pty.pid} still not safe to kill after ${this.killWaitCapMs} ms; killing anyway`)
        return
      }
      if (!waiting) {
        waiting = true
        this.log(`slot ${slot.meta.slotId}: pid ${pty.pid} is too young to kill (${now - (ageDeadline - this.minAgentAgeMs)} ms, ${slot.status}); waiting`)
        onWait?.()
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** Stops the slot's process: dequeues it, waits until its agent may be killed, then kills the PTY tree. */
  private async stopSlot(slot: Slot): Promise<void> {
    this.dequeue(slot)
    if (slot.preLaunch) { // still before its spawn (checks, plan, ronda file): the launch will not happen
      const pre = slot.preLaunch
      slot.preLaunch = undefined
      pre.release()
      if (slot.status === 'starting' && !slot.pty && !slot.launching) {
        slot.status = 'exited'
        this.broadcastState(slot)
        this.pump()
      }
    }
    if (slot.launching) await slot.launching // stop what the host is spawning, not nothing
    const pty = slot.pty
    if (!pty) {
      this.dropInput(slot)
      this.unwatchTitle(slot)
      return
    }
    if (!pty.exit) {
      // The first stop flags the slot `stopping` while it waits (clients show it); a second one joins the wait.
      const first = !slot.stopping
      try {
        await this.awaitKillable(slot, pty, first ? () => { slot.stopping = true; this.broadcastState(slot) } : undefined)
      } finally {
        if (first && slot.stopping) {
          slot.stopping = undefined
          this.broadcastState(slot)
        }
      }
    }
    if (slot.pty !== pty) return // exited by itself and started again meanwhile: that run was not asked to stop
    this.unwatchTitle(slot)
    await pty.kill()
    if (slot.pty === pty) slot.pty = undefined
    await slot.exitTail // the verdict of the run that just ended (unconfirmed or not) is what the stop answers with
  }

  // ---- connections ---------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    const client: Client = { socket, parser: new LineParser(), attached: new Set(), procsWatched: new Set(), conn: ++this.connSeq }
    this.clients.add(client)
    // The pipe can be opened by other accounts of the machine (Windows gives Everyone read on a named pipe Node creates):
    // a connection that never says hello is dropped. The check runs on the next turn of the loop, after the poll phase, so a
    // hello already read but not yet handled (the loop was busy) is not lost to the timer.
    client.helloTimer = setTimeout(() => setImmediate(() => {
      if (client.greeted || socket.destroyed) return
      this.log(`client dropped: no hello in ${this.helloTimeoutMs} ms`)
      socket.destroy()
    }), this.helloTimeoutMs)
    client.helloTimer.unref()
    socket.setEncoding('utf8')
    socket.on('data', perf.wrap('net:client-data', (chunk: string) => {
      for (const line of client.parser.push(chunk)) void this.onLine(client, line.value, line.raw)
    }))
    socket.on('error', (e) => this.log(`client error: ${e.message}`))
    socket.on('close', () => {
      clearTimeout(client.helloTimer)
      this.clients.delete(client)
      for (const id of client.attached) this.slotMap.get(id)?.attached.delete(client)
      for (const name of client.procsWatched) this.unwatchProc(client, name)
    })
  }

  /** The slot has no pty yet but is about to: reserved by a launch (host spawn in flight) or by the boot's adoption. */
  private awaitsPty(slot: Slot): boolean {
    return !slot.pty && (slot.status === 'starting' || slot.launching !== undefined)
  }

  /** Writes input to the slot's pty, or holds it (bounded) while the pty is still coming; an exited or stopped slot drops it as before. */
  private writeInput(slot: Slot, data: string, probe: unknown, arrive: number): void {
    if (this.awaitsPty(slot)) { this.queueInput(slot, data, probe, arrive); return }
    if (probe) this.writeProbed(slot, data, probe, arrive)
    else slot.pty?.write(data)
  }

  /** Keystrokes for the slot: to its pty (writeInput), to its attention, and to the agent door with who typed them. */
  private typeInto(slot: Slot, data: string, probe: unknown, arrive: number, origin: InputOrigin, mark?: InputMark): void {
    this.writeInput(slot, data, probe, arrive)
    if (slot.attention.input(data)) this.broadcastState(slot)
    this.door.input(slot.meta.slotId, data, origin, mark)
  }

  private queueInput(slot: Slot, data: string, probe: unknown, arrive: number): void {
    const q = (slot.inputQueue ??= { items: [], bytes: 0 })
    const size = Buffer.byteLength(data)
    // Once something is dropped, nothing later is kept: a gap in the middle of the typed text would write garbage.
    if (q.overflowed || q.bytes + size > INPUT_QUEUE_MAX_BYTES) {
      if (slot.inputDropped === undefined) this.log(`slot ${slot.meta.slotId}: input queue full (${INPUT_QUEUE_MAX_BYTES} bytes) while the terminal is not ready; dropping the excess`)
      slot.inputDropped = (slot.inputDropped ?? 0) + size
      q.overflowed = true
      return
    }
    q.items.push({ data, probe, arrive })
    q.bytes += size
  }

  /** The pty just became the slot's: writes what waited for it, in order, before any newer input can. */
  private flushInput(slot: Slot): void {
    const q = slot.inputQueue
    slot.inputQueue = undefined
    if (!q || !slot.pty) return
    for (const it of q.items) {
      if (it.probe) this.writeProbed(slot, it.data, it.probe, it.arrive)
      else slot.pty.write(it.data)
    }
  }

  /** The run the queued input was meant for is not coming (launch failed, slot stopped, exited or removed). */
  private dropInput(slot: Slot): void {
    slot.inputQueue = undefined
  }

  /** Input with a probe: stamps arrival and the PTY write, and leaves the probe pending for the slot's next output. */
  private writeProbed(slot: Slot, data: string, raw: unknown, arrive: number): void {
    const probe = parseProbe(raw)
    if (!probe || !slot.pty) { slot.pty?.write(data); return }
    slot.pty.write(data)
    const written = extendProbe(extendProbe(probe, arrive), stamp())
    slot.probe = { probe: written, at: Date.now() }
  }

  /** The pending probe leaving with an output: its `out` stamp is added; a slow one raises the `key-echo` incident. */
  private takeProbe(slot: Slot): Probe | undefined {
    const pending = slot.probe!
    slot.probe = undefined
    if (Date.now() - pending.at > PROBE_TTL_MS) return undefined
    const probe = extendProbe(pending.probe)
    if (isSlow(probe, ECHO_INCIDENT_MS)) perf.incident('key-echo', { slotId: slot.meta.slotId, seq: probe.seq, t: probe.t })
    return probe
  }

  /** The client no longer watches the process' output; the host attachment goes with the last watcher. */
  private unwatchProc(client: Client, name: string): void {
    client.procsWatched.delete(name)
    const set = this.procWatchers.get(name)
    if (!set?.delete(client) || set.size) return
    this.procWatchers.delete(name)
    this.procs.detachOutput(name)
  }

  private send(client: Client, msg: DaemonMessage): void {
    if (client.socket.destroyed || !client.socket.writable) return
    client.socket.write(encode(msg))
  }

  /**
   * Events go only to clients that completed the hello: a connection that did not is nobody's. And never with a value of an
   * environment variable (env-names.ts).
   */
  private broadcast(msg: DaemonMessage): void {
    const out = forBroadcast(msg)
    for (const c of this.clients) if (c.greeted) this.send(c, out)
  }

  private broadcastState(slot: Slot): void {
    const state = this.stateOf(slot)
    this.broadcast({ t: 'state', slot: state })
    this.noteTabTitle(slot, state)
    this.door.stateChanged(state)
    // A due ronda goes as soon as the agent turns idle, not at the next retry.
    if (slot.rondaDue && this.rondaBlocker(slot) === undefined) setImmediate(() => this.rondaTick(slot))
  }

  private async onLine(client: Client, value: Record<string, unknown> | undefined, raw: string): Promise<void> {
    if (!value) {
      const id = guessId(raw)
      if (id !== undefined) this.send(client, { t: 'error', id, code: 'bad-request', message: 'linha não é JSON válido' })
      return
    }
    const msg = value as Partial<ClientMessage>
    if (!client.greeted && msg.t !== 'auth' && msg.t !== 'hello') {
      // Before the hello nothing is done: keystrokes are dropped, any other request is refused.
      const id = (msg as { id?: unknown }).id
      if (typeof id === 'number') this.send(client, { t: 'error', id, code: 'auth-required', message: 'identifique-se primeiro (hello)' })
      return
    }
    if (msg.t === 'input') {
      const arrive = msg.probe ? stamp() : 0 // line received: the first daemon stamp
      const slot = typeof msg.slotId === 'string' ? this.slotMap.get(msg.slotId) : undefined
      if (slot && typeof msg.data === 'string') this.typeInto(slot, msg.data, msg.probe, arrive, 'user')
      return
    }
    if (msg.t === 'typed') {
      // Already written to the pane in the host by a direct client: only the attention hears it, the PTY is not touched.
      const slot = typeof msg.slotId === 'string' ? this.slotMap.get(msg.slotId) : undefined
      if (slot && typeof msg.data === 'string') {
        if (slot.attention.input(msg.data)) this.broadcastState(slot)
        this.door.input(slot.meta.slotId, msg.data, 'user')
      }
      return
    }
    const id = (msg as { id?: unknown }).id
    if (typeof id !== 'number') return // not a request we can answer
    let reply: Reply
    try {
      // `req:<t>` is the synchronous part (to the first await); `req:<t>:wall` the clock time until the answer is ready.
      const label = `req:${String(msg.t)}`
      reply = await perf.timedAsync(`${label}:wall`, () => perf.timed(label, () => this.handle(client, msg as Request)))
    } catch (e) {
      const err = e instanceof RequestError ? e : e instanceof DoorError ? new RequestError(e.code, e.message) : new RequestError('bad-request', (e as Error).message)
      reply = { t: 'error', id, code: err.code, message: err.message }
    }
    this.send(client, reply)
    if (client.closeAfterReply) client.socket.end()
  }

  /** `auth`: the first step of the handshake (pipe-key.ts). Answers before the hello; never twice for a greeted client. */
  private async auth(client: Client, req: Extract<Request, { t: 'auth' }>): Promise<Reply> {
    if (client.greeted) throw new RequestError('bad-request', 'conexão já identificada')
    if (!isNonce(req.nonce)) throw new RequestError('bad-request', 'nonce inválido (64 dígitos hexadecimais)')
    const key = await this.pipeKey
    const daemon = newNonce()
    client.challenge = { client: req.nonce, daemon }
    return { t: 'ok', id: req.id, auth: { nonce: daemon, proof: daemonProof(key, req.nonce, daemon) } }
  }

  /** The hello's proof, once per connection; a refusal closes the connection after its reply. */
  private async checkHello(client: Client, req: Extract<Request, { t: 'hello' }>): Promise<void> {
    if (client.greeted) return
    const challenge = client.challenge
    client.challenge = undefined
    if (req.proof === undefined || !challenge) {
      client.closeAfterReply = true
      this.log(`client refused: hello without proof (${String(req.client)}, protocol ${String(req.v)})`)
      throw new RequestError('auth-required', `este tetherd (versão ${DAEMON_VERSION}) só atende quem prova ser o mesmo usuário, e este cliente é de uma versão anterior do tether: atualize o tether e abra de novo o app ou o terminal`)
    }
    if (!sameProof(req.proof, clientProof(await this.pipeKey, challenge.client, challenge.daemon))) {
      client.closeAfterReply = true
      this.log(`client refused: the hello's proof does not match (${String(req.client)})`)
      throw new RequestError('auth-failed', 'a identificação não confere com a chave deste tetherd')
    }
  }

  private async handle(client: Client, req: Request): Promise<Reply> {
    const { id } = req
    switch (req.t) {
      case 'auth':
        return await this.auth(client, req)
      case 'hello':
        await this.checkHello(client, req)
        if (typeof req.client === 'string') {
          // The portal's label needs the portal's credential (M-5): without it the connection is a plain cli.
          client.kind = req.client === 'remote' && !isPortalCredential(this.home, req.cred) ? 'cli' : req.client
          if (req.client === 'remote' && client.kind !== 'remote') this.log('client: a hello as remote without the portal credential; treated as cli')
        }
        if (req.direct === true) client.direct = true
        client.greeted = true
        clearTimeout(client.helloTimer)
        return { t: 'ok', id, hello: { v: PROTOCOL_VERSION, pid: this.pid, version: DAEMON_VERSION, exec: process.execPath, ...(client.kind ? { client: client.kind } : {}) } }
      case 'list':
        return { t: 'ok', id, slots: this.slots() }
      case 'perf':
        return { t: 'ok', id, perf: perf.snapshot(typeof req.since === 'number' ? req.since : 0) }
      case 'debug-block': {
        if (process.env.TETHER_TEST_BLOCK !== '1') throw new RequestError('bad-request', 'debug-block indisponível')
        const ms = req.ms
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > DEBUG_BLOCK_MAX_MS) throw new RequestError('bad-request', `ms inválido (0 < ms <= ${DEBUG_BLOCK_MAX_MS})`)
        setImmediate(perf.wrap('req:debug-block', () => {
          perf.incident('debug-block', { ms })
          busyWait(ms)
        }))
        return { t: 'ok', id }
      }
      case 'create': {
        // `desk` (optional): the pane is asked into that desk; a request without it is exactly as before.
        if (req.desk === undefined) return { t: 'ok', id, slot: this.stateOf(await this.createSlot(req)) }
        if (typeof req.desk !== 'string' || !req.desk) throw new RequestError('bad-request', 'desk inválido')
        if (req.slotId !== undefined && (typeof req.slotId !== 'string' || !req.slotId || (req.key !== undefined && typeof req.key !== 'string'))) throw new RequestError('bad-request', 'identidade inválida')
        const asker = req.slotId !== undefined ? { slotId: req.slotId, ...(req.key !== undefined ? { key: req.key } : {}) } : undefined
        const paneRequest = this.door.deskRequest ? this.door.deskRequest(req.desk, asker) : { deskId: req.desk }
        return { t: 'ok', id, slot: this.stateOf(await this.createSlot(req, { paneRequest })) }
      }
      case 'start': {
        const slot = this.slot(req.slotId)
        await this.manualStart(slot, req.choice === 'new' || req.choice === 'resume' ? req.choice : undefined)
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'attach': {
        const slot = this.slot(req.slotId)
        client.attached.add(slot.meta.slotId)
        slot.attached.add(client)
        this.resize(slot, req.cols, req.rows)
        // A direct client takes a hosted pane's scrollback from the host's ring, as it takes its output.
        if (client.direct && slot.ptyHosted && slot.pty && !slot.pty.exit) return { t: 'ok', id, slot: this.stateOf(slot) }
        return { t: 'ok', id, slot: this.stateOf(slot), scrollback: slot.scrollback.text() }
      }
      case 'seen': {
        const slot = this.slot(req.slotId)
        // Attention rerouted to a live owner is the owner's to clear (`attention.seen`): a pipe client's `seen` leaves it alone.
        if (this.stateOf(slot).attentionFor) return { t: 'ok', id }
        if (slot.attention.seen()) this.broadcastState(slot)
        return { t: 'ok', id }
      }
      case 'unseen': {
        const slot = this.slot(req.slotId)
        if (this.stateOf(slot).attentionFor) return { t: 'ok', id }
        if (req.off ? slot.attention.seen(true) : slot.attention.defer()) this.broadcastState(slot)
        return { t: 'ok', id }
      }
      case 'detach': {
        const slot = this.slot(req.slotId)
        client.attached.delete(slot.meta.slotId)
        slot.attached.delete(client)
        return { t: 'ok', id }
      }
      case 'resize': {
        const slot = this.slot(req.slotId)
        this.resize(slot, req.cols, req.rows)
        return { t: 'ok', id }
      }
      case 'stop':
        return { t: 'ok', id, slot: await this.stopById(req.slotId, stopWhyOf(req.why)) }
      case 'set-want': {
        const slot = this.slot(req.slotId)
        if (req.want !== 'asleep' && req.want !== 'suspended') throw new RequestError('bad-request', 'want inválido: asleep ou suspended')
        if (this.setWant(slot, req.want)) {
          await this.store.flush(slotMetaPath(this.home, slot.meta.slotId))
          this.broadcastState(slot)
        }
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'forget':
        await this.forgetById(req.slotId)
        return { t: 'ok', id }
      case 'rename-slot':
        return { t: 'ok', id, slot: await this.renameById(req.slotId, req.name) }
      case 'shutdown': {
        this.log('shutdown requested')
        setImmediate(() => void this.close().then(() => this.onShutdown?.()))
        return { t: 'ok', id }
      }
      case 'profiles-list': {
        await this.profileStore.fresh() // an answer to the person: whatever the CLI wrote a moment ago is in it
        const read = this.profileStore.read()
        return { t: 'ok', id, profiles: read.profiles, ...(read.problem ? { problem: read.problem } : {}) }
      }
      case 'profile-save': {
        const input = req.profile as Partial<ProfileInput> | undefined
        if (!input || typeof input !== 'object') throw new RequestError('bad-request', 'perfil obrigatório')
        if (!isProfileAgent(input.agent)) throw new RequestError('invalid-profile', `agente inválido: ${String(input.agent)} (use ${agentChoices()})`)
        let saved: { profile: Profile; warnings: string[] }
        try {
          saved = this.profileStore.save({ ...input, agent: input.agent, name: String(input.name ?? ''), args: Array.isArray(input.args) ? input.args : [] })
        } catch (e) {
          if (e instanceof ProfileError) throw new RequestError('invalid-profile', e.message)
          throw e
        }
        await this.profileStore.flush()
        this.log(`profile ${saved.profile.id} saved (${saved.profile.agent} "${saved.profile.name}")`)
        this.broadcastProfiles()
        return { t: 'ok', id, profile: saved.profile, warnings: saved.warnings }
      }
      case 'profile-delete': {
        const profile = await this.requireProfile(req.profileId)
        this.profileStore.delete(profile.id)
        await this.profileStore.flush()
        this.log(`profile ${profile.id} deleted`)
        this.broadcastProfiles()
        return { t: 'ok', id }
      }
      case 'pause-start':
        { const pause = this.pauseStart(req.slotIds); await this.flushPause(); return { t: 'ok', id, pause } }
      case 'pause-get':
        return { t: 'ok', id, pause: this.batch ?? null }
      case 'pause-remove':
        { const pause = this.pauseRemove(req.slotId); await this.flushPause(); return { t: 'ok', id, pause } }
      case 'pause-cancel':
        { const pause = this.pauseCancel(); await this.flushPause(); return { t: 'ok', id, pause } }
      case 'pause-resume':
        { const pause = this.pauseResume(req.slotIds); await this.flushPause(); return { t: 'ok', id, pause } }
      case 'ronda-set': {
        const slot = this.slot(req.slotId)
        const unavailable = this.rondaUnavailable(slot)
        if (unavailable) throw new RequestError('ronda-unavailable', unavailable)
        for (const k of ['interval', 'nudge', 'criterion'] as const) {
          if (req[k] !== undefined && typeof req[k] !== 'string') throw new RequestError('bad-request', `${k} deve ser texto`)
        }
        let r: ReturnType<typeof applyChange>
        try {
          r = applyChange(slot.ronda, { ...(req.interval !== undefined ? { interval: req.interval } : {}), ...(req.nudge !== undefined ? { nudge: req.nudge } : {}), ...(req.criterion !== undefined ? { criterion: req.criterion } : {}) }, Date.now(), this.rondaAllowSeconds)
        } catch (e) {
          if (e instanceof RondaError) throw new RequestError('bad-request', e.message)
          throw e
        }
        if (r.outcome !== 'unchanged') {
          if (r.outcome === 'created' || r.ronda.nextAt !== slot.ronda?.nextAt) slot.rondaDue = false
          slot.ronda = r.ronda
          this.saveRonda(slot)
          this.log(`slot ${slot.meta.slotId}: ronda ${r.outcome} (${r.ronda.intervalMs} ms${r.ronda.criterion ? ', com critério' : ''})`)
          this.armRonda(slot)
          this.broadcastState(slot)
          await this.store.flush(slotRondaPath(this.home, slot.meta.slotId)) // barrier: on disk before the reply
        }
        return { t: 'ok', id, ronda: this.stateOf(slot).ronda ?? null, rondaOutcome: r.outcome }
      }
      case 'ronda-get': {
        const slot = this.slot(req.slotId)
        return { t: 'ok', id, ronda: this.stateOf(slot).ronda ?? null }
      }
      case 'ronda-off': {
        const slot = this.slot(req.slotId)
        if (!slot.ronda) return { t: 'ok', id, ronda: null, rondaOutcome: 'was-off' }
        if (slot.ronda.criterion && req.force !== true) throw new RequestError('ronda-criterion', criterionStimulus(slot.ronda.criterion))
        this.rondaOff(slot)
        await this.store.flush(slotRondaPath(this.home, slot.meta.slotId)) // barrier: removed before the reply
        return { t: 'ok', id, ronda: null, rondaOutcome: 'off' }
      }
      case 'restart':
        return { t: 'ok', id, slot: await this.restartById(req.slotId) }
      case 'set-profile': {
        const slot = this.slot(req.slotId)
        if (req.profileId !== null && typeof req.profileId !== 'string') throw new RequestError('bad-request', 'profileId obrigatório (ou null para nenhum perfil)')
        const profile = req.profileId === null ? undefined : await this.requireProfile(req.profileId)
        if (profile && profile.agent !== slot.meta.agent) throw new RequestError('bad-request', `o perfil "${profile.name}" é de ${profile.agent}, não de ${slot.meta.agent}`)
        const live = isAlive(slot)
        // The refusal comes before anything is written: a slot whose agent never reported is left exactly as it was.
        if (req.restart && live && slot.meta.agent !== 'shell' && slot.status === 'running' && !this.reportedThisRun(slot)) {
          throw new RequestError('unconfirmed', `o ${slot.meta.agent} deste slot não registrou a sessão desta execução: reiniciar agora poderia perder a conversa. Troque o perfil na próxima abertura, ou encerre o slot e escolha a sessão ao iniciar`)
        }
        const before = { profileId: slot.meta.profileId, profileArgs: slot.meta.profileArgs, profileEnv: slot.meta.profileEnv }
        const changed = this.assignProfile(slot, profile)
        this.log(`slot ${slot.meta.slotId}: profile ${profile ? profile.id : '(none)'}${changed ? '' : ' (unchanged)'}${req.restart && live ? ', restarting' : ''}`)
        if (req.restart && live) {
          try {
            await this.restartSlot(slot)
          } catch (e) {
            // A refusal (the agent turned out not to have reported) leaves the slot as it was, like the pre-flight one.
            if (e instanceof RequestError && e.code === 'unconfirmed' && changed) this.restoreProfileFields(slot, before)
            await this.store.flush(slotMetaPath(this.home, slot.meta.slotId))
            throw e
          }
        }
        await this.store.flush(slotMetaPath(this.home, slot.meta.slotId)) // barrier: the profile is on disk before the reply
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'proc-list':
        return { t: 'ok', id, procs: await this.procs.list() }
      case 'proc-info': {
        const { proc, events } = await this.procAct(() => this.procs.info(req.name))
        return { t: 'ok', id, proc, events }
      }
      case 'proc-start':
        return { t: 'ok', id, proc: await this.procAct(() => this.procs.start(req.name, req.recipe, req.by, client.kind, req.force === true)) }
      case 'proc-stop':
        return { t: 'ok', id, proc: await this.procAct(() => this.procs.stop(req.name, optText(req.reason), req.by, client.kind, guardOf(req))) }
      case 'proc-restart':
        return { t: 'ok', id, proc: await this.procAct(() => this.procs.restart(req.name, optText(req.reason), req.by, client.kind, guardOf(req))) }
      case 'proc-use':
        return { t: 'ok', id, proc: await this.procAct(() => this.procs.use(req.name, typeof req.duration === 'string' ? req.duration : undefined, typeof req.purpose === 'string' ? req.purpose : undefined, req.by, client.kind)) }
      case 'proc-release': {
        const r = await this.procAct(() => this.procs.release(req.name, req.by, client.kind))
        return { t: 'ok', id, proc: r.proc, released: r.released }
      }
      case 'proc-ports':
        return { t: 'ok', id, ports: await this.procAct(() => this.procs.ports(req.check)) }
      case 'proc-adopt':
        return { t: 'ok', id, proc: await this.procAct(() => this.procs.adoptExternal(String(req.name), Number(req.pid), req.recipe, req.by, client.kind)) }
      case 'proc-forget': {
        const note = await this.procAct(() => this.procs.forget(req.name, req.by, client.kind, guardOf(req)))
        return { t: 'ok', id, ...(note ? { note } : {}) }
      }
      case 'proc-seen':
        await this.procAct(() => this.procs.seen(req.name))
        return { t: 'ok', id }
      case 'proc-attach': {
        // Watching before the host answers: output that follows the scrollback may arrive in the same read as the reply.
        const name = String(req.name)
        const known = client.procsWatched.has(name)
        client.procsWatched.add(name)
        let set = this.procWatchers.get(name)
        if (!set) this.procWatchers.set(name, set = new Set())
        set.add(client)
        let scrollback: string | undefined
        try {
          scrollback = await this.procAct(() => this.procs.attachOutput(name))
        } catch (e) {
          if (!known) this.unwatchProc(client, name)
          throw e
        }
        if (client.socket.destroyed) this.unwatchProc(client, name)
        return { t: 'ok', id, ...(scrollback !== undefined ? { scrollback } : {}) }
      }
      case 'proc-detach':
        this.unwatchProc(client, req.name)
        return { t: 'ok', id }
      case 'proc-host':
        return { t: 'ok', id, host: await this.procAct(() => this.procs.hostStatus()) }
      case 'proc-host-stop':
        await this.procAct(() => this.procs.hostStop(req.force === true, req.by, client.kind))
        return { t: 'ok', id }
      default: {
        // Request types the core does not answer itself go to the agent door's registry (door/host.ts).
        const t = String((req as { t?: unknown }).t)
        const handler = this.door.requestHandler(t)
        if (!handler) throw new RequestError('bad-request', `mensagem desconhecida: ${t}`)
        const body = await handler(req as unknown as { t: string; id: number } & Record<string, unknown>, { client: client.kind, conn: client.conn })
        return { ...body, t: 'ok', id }
      }
    }
  }

  // ---- slot operations: one body for the pipe's requests and the agent door's SlotPort ------------

  /** `door`: the agent door's meta fields, passed by its SlotPort only (never read from a pipe request). */
  private async createSlot(req: Omit<SlotCreateInput, 'kind' | 'meta'> & { kind: unknown }, door?: SlotCreateInput['meta']): Promise<Slot> {
    if (!isKind(req.kind)) throw new RequestError('bad-request', `tipo inválido: ${String(req.kind)}`)
    if (req.kind !== 'shell' && !this.adapterOf(req.kind)) throw new RequestError('bad-request', `tipo inválido: ${req.kind} (use ${agentChoices()})`)
    if (typeof req.cwd !== 'string' || !req.cwd) throw new RequestError('bad-request', 'cwd obrigatório')
    // Before the id is drawn: nothing awaits between the new slot's id and its entry in the map.
    const profile = req.profileId !== undefined ? await this.requireProfile(req.profileId) : undefined
    const cwd = await canonicalDir(req.cwd)
    const meta: SlotMeta = {
      v: 1,
      slotId: this.newSlotId(),
      agent: req.kind,
      cwd,
      args: Array.isArray(req.args) ? req.args.filter((a): a is string => typeof a === 'string') : [],
      createdAt: new Date().toISOString(),
    }
    if (typeof req.name === 'string' && req.name) meta.name = req.name
    if (profile) {
      if (profile.agent !== req.kind) throw new RequestError('bad-request', `o perfil "${profile.name}" é de ${profile.agent}, não de ${req.kind}`)
      snapshotProfile(meta, profile)
    }
    // The agent door's fields: on disk with the rest, before the reply.
    if (door) Object.assign(meta, door)
    assertSlotId(meta.slotId)
    const slot = this.load(meta)
    slot.hydrating = Promise.resolve() // brand new: no files yet
    this.saveMeta(meta)
    this.broadcastState(slot)
    await this.store.flush(slotMetaPath(this.home, meta.slotId)) // barrier: on disk before the reply (and before any launch)
    if (req.start) await this.startSlot(slot, undefined)
    return slot
  }

  /** A stop asked by a client or the door: the intent `why` leaves is on disk before the kill (a crash meanwhile keeps it). */
  private async stopById(slotId: unknown, why: StopWhy = 'end'): Promise<SlotState> {
    const slot = this.slot(slotId)
    const want: SlotWant = why === 'hibernate' ? 'asleep' : why === 'suspend' ? 'suspended' : 'ended'
    if (this.setWant(slot, want)) {
      await this.store.flush(slotMetaPath(this.home, slot.meta.slotId))
      if (!isAlive(slot)) this.broadcastState(slot) // a live one is broadcast by its exit
    }
    await this.stopSlot(slot)
    // A launch that reached its spawn during the flush wrote 'run'; this stop killed it, so the stop's intent stands.
    if (!isAlive(slot) && this.setWant(slot, want)) this.broadcastState(slot)
    return this.stateOf(slot)
  }

  private async restartById(slotId: unknown): Promise<SlotState> {
    const slot = this.slot(slotId)
    if (!this.adapterOf(slot.meta.agent)?.resumes) throw new RequestError('bad-request', `o ${slot.meta.agent} não retoma sessão: não há como reiniciar o slot ${slot.meta.slotId}`)
    if (!isAlive(slot)) throw new RequestError('bad-request', `o slot ${slot.meta.slotId} não está rodando`)
    // Same early refusal as set-profile: nothing is touched when the agent never reported its session.
    if (slot.status === 'running' && !this.reportedThisRun(slot)) {
      throw new RequestError('unconfirmed', `o ${slot.meta.agent} deste slot não registrou a sessão desta execução: reiniciar agora poderia perder a conversa`)
    }
    await this.restartSlot(slot)
    return this.stateOf(slot)
  }

  private async forgetById(slotId: unknown): Promise<void> {
    const slot = this.slot(slotId)
    await this.stopSlot(slot)
    this.slotMap.delete(slot.meta.slotId)
    this.bgMarkers.delete(slot.meta.slotId)
    this.dropInput(slot)
    this.rondaChannel.revoke(slot.meta.slotId)
    const gone = this.door.forgotten(slot.meta.slotId)
    if (gone) await gone
    if (slot.rondaTimer) clearTimeout(slot.rondaTimer)
    slot.ronda = undefined
    for (const c of slot.attached) c.attached.delete(slot.meta.slotId)
    await this.removeSlotFiles(slot.meta.slotId) // barrier: the files are gone before the reply
    // The slot is gone for good (its pane was closed): extensions drop what they kept with it.
    this.emitSlot('removed', slot)
    this.procs.slotGone(slot.meta.slotId)
    this.broadcast({ t: 'removed', slotId: slot.meta.slotId })
  }

  private async renameById(slotId: unknown, name: unknown): Promise<SlotState> {
    const slot = this.slot(slotId)
    if (typeof name !== 'string') throw new RequestError('bad-request', 'nome obrigatório')
    if (name) slot.meta.name = name
    else delete slot.meta.name
    this.saveMeta(slot.meta)
    this.broadcastState(slot)
    await this.store.flush(slotMetaPath(this.home, slot.meta.slotId)) // barrier: renamed on disk before the reply
    return this.stateOf(slot)
  }

  /** A profile the memory does not know is looked up again on disk before the request fails (the CLI may have just written it). */
  private async requireProfile(profileId: unknown): Promise<Profile> {
    const byId = (list: Profile[]): Profile | undefined => (typeof profileId === 'string' ? list.find((x) => x.id === profileId) : undefined)
    const p = byId(this.profileStore.profiles()) ?? byId(await this.profileStore.fresh())
    if (!p) throw new RequestError('unknown-profile', `perfil desconhecido: ${String(profileId)}`)
    return p
  }

  private resize(slot: Slot, cols: unknown, rows: unknown): void {
    if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1) return
    slot.cols = Math.floor(cols)
    slot.rows = Math.floor(rows)
    slot.pty?.resize(slot.cols, slot.rows)
  }

  // ---- watching the event files --------------------------------------------------------------

  private startWatching(): void {
    try {
      this.watcher = watch(slotsDir(this.home), perf.wrap('watch:slots', (_event, filename: string | null) => {
        if (!this.watcher) return
        if (typeof filename !== 'string') { this.watchGone(); return } // a vanished folder reports no name
        const pr = /^([^.]+)\.pause\.jsonl$/.exec(filename)
        if (pr && SLOT_ID_RE.test(pr[1]!)) { this.schedulePauseReport(pr[1]!); return }
        const bg = /^([^.]+)\.bg\./.exec(filename)
        if (bg && SLOT_ID_RE.test(bg[1]!)) { this.scheduleBackground(bg[1]!, filename); return }
        const a = /^([^.]+)\.attention$/.exec(filename)
        if (a && SLOT_ID_RE.test(a[1]!)) { this.scheduleAttentionReport(a[1]!); return }
        const m = /^([^.]+)\.(jsonl|json)$/.exec(filename)
        if (!m || !SLOT_ID_RE.test(m[1]!)) {
          // A vanished folder reports itself by its absolute path (a string test, no disk): only then is the folder looked at, asynchronously.
          if (isAbsolute(filename)) this.watchGone()
          return
        }
        this.schedule(m[1]!, m[2] === 'jsonl')
      }))
      this.watcher.on('error', (e) => {
        this.log(`watch error: ${e.message}`)
        this.watchGone()
        this.bgMarkers.clear() // events may have been lost: the markers are listed again on next use
      })
    } catch (e) {
      this.log(`cannot watch ${slotsDir(this.home)}: ${(e as Error).message}`)
    }
  }

  /**
   * The slots folder vanished under the watcher (the home was deleted): on Windows the watch then fires without stopping and
   * spins a core. Stop it, say so once, and let the daemon go: a tetherd without its home has nothing left to serve.
   */
  private watchGone(): void {
    if (!this.watcher || this.goneChecking) return
    this.goneChecking = true
    const dir = slotsDir(this.home)
    // Asynchronous on purpose: only the rare nameless event or watcher error gets here, never the hot per-file path.
    void statAsync(dir).then(() => undefined, () => 'gone' as const).then((gone) => {
      this.goneChecking = false
      if (gone !== 'gone' || !this.watcher) return
      this.watcher.close()
      this.watcher = undefined
      this.log(`slots folder gone (${dir}): watcher stopped`)
      setImmediate(() => void this.close().then(() => this.onShutdown?.()))
    })
  }
  private goneChecking = false

  /** Debounces the subagent markers per slot (<slot>.bg.<agentId>, written and removed by Claude's Subagent hooks). */
  private scheduleBackground(slotId: string, file: string): void {
    const key = `${slotId}.bg`
    const touched = this.bgTouched.get(slotId)
    if (touched) touched.add(file)
    else this.bgTouched.set(slotId, new Set([file]))
    const prev = this.pending.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(perf.wrap('timer:background', () => {
      this.pending.delete(key)
      const files = this.bgTouched.get(slotId)
      this.bgTouched.delete(slotId)
      const slot = this.slotMap.get(slotId)
      if (slot) this.applyBackground(slot, files)
    }), WATCH_DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /**
   * Counts the slot's live subagent markers: written in this run and younger than BG_MAX_AGE_MS (a lost Stop must not pin it).
   * The stats go through the executor; one refresh per slot at a time, and the names that change meanwhile wait for the next
   * pass (nothing is dropped, and a stat that finishes late never overwrites a newer one).
   */
  private applyBackground(slot: Slot, touched?: Set<string>): void {
    if (slot.bgRunning) {
      if (touched?.size) { slot.bgCarry ??= new Set(); for (const f of touched) slot.bgCarry.add(f) }
      return
    }
    slot.bgRunning = true
    const slotId = slot.meta.slotId
    void (async () => {
      let names = touched
      try {
        for (;;) {
          const markers = await this.markersOf(slotId, names)
          if (this.slotMap.get(slotId) !== slot) return
          if (isAlive(slot)) {
            const since = slot.spawnedAt ? Date.parse(slot.spawnedAt) : 0
            const now = Date.now()
            let n = 0
            for (const m of markers.values()) if (m >= since - 1000 && now - m < BG_MAX_AGE_MS) n++
            if (slot.attention.setBackground(n, now)) this.broadcastState(slot)
            this.scheduleWake(slot)
          }
          names = slot.bgCarry
          slot.bgCarry = undefined
          if (names === undefined) break
        }
      } catch (e) {
        this.log(`slot ${slotId}: cannot refresh its subagent markers: ${(e as Error).message}`)
      } finally {
        slot.bgRunning = undefined
      }
    })()
  }

  /** Arms the wake fallback: the last subagent ended and the agent must finish its turn within WAKE_MS, or it counts as done. */
  private scheduleWake(slot: Slot): void {
    if (slot.wakeTimer) { clearTimeout(slot.wakeTimer); slot.wakeTimer = undefined }
    const due = slot.attention.wakeDueAt()
    if (due === undefined) return
    slot.wakeTimer = setTimeout(perf.wrap('timer:wake', () => {
      slot.wakeTimer = undefined
      if (slot.attention.wakeExpired(Date.now())) this.broadcastState(slot)
    }), Math.max(50, due - Date.now()))
    slot.wakeTimer.unref()
  }

  /**
   * The slot's subagent markers with their mtimes, from memory: the boot scan seeded it and the watcher's events (the files it
   * names, `touched`) keep it current, one executor stat per file. A slot the memory does not know is listed from disk once
   * (concurrent callers share the listing).
   */
  private async markersOf(slotId: string, touched?: Set<string>): Promise<Map<string, number>> {
    const dir = slotsDir(this.home)
    const known = this.bgMarkers.get(slotId)
    if (known) {
      const names = [...(touched ?? [])]
      if (names.length) this.fsProbe?.('markers:stat', slotId)
      const mtimes = await Promise.all(names.map((name) => this.markerMtime(name)))
      if (this.bgMarkers.get(slotId) !== known) return this.markersOf(slotId, touched) // forgotten or reset meanwhile: start over
      names.forEach((name, i) => {
        const m = mtimes[i]
        if (m === undefined) known.delete(name) // removed
        else known.set(name, m)
      })
      return known
    }
    const inFlight = this.bgListing.get(slotId)
    if (inFlight) return inFlight
    this.fsProbe?.('markers:list', slotId)
    const listing = (async (): Promise<Map<string, number>> => {
      const listed = new Map<string, number>()
      const prefix = `${slotId}.bg.`
      try {
        const entries = await this.executor.run('readdir', [dir])
        const names = entries.map((e) => e.name).filter((name) => name.startsWith(prefix))
        const mtimes = await Promise.all(names.map((name) => this.markerMtime(name)))
        names.forEach((name, i) => { const m = mtimes[i]; if (m !== undefined) listed.set(name, m) })
      } catch { /* no dir */ }
      if (this.slotMap.has(slotId)) this.bgMarkers.set(slotId, listed)
      return listed
    })().finally(() => { this.bgListing.delete(slotId) })
    this.bgListing.set(slotId, listing)
    return listing
  }

  /** A marker file's mtime; undefined when it is gone. */
  private markerMtime(name: string): Promise<number | undefined> {
    return this.executor.run('stat', [join(slotsDir(this.home), name)]).then((st) => st.mtimeMs, () => undefined)
  }

  /** Fills the marker memory from the boot scan: every slot known, with the markers already on disk. */
  private async seedMarkers(scan: SlotsScan): Promise<void> {
    const found: { markers: Map<string, number>; name: string }[] = []
    for (const meta of scan.metas) this.bgMarkers.set(meta.slotId, new Map())
    for (const name of scan.names) {
      const m = /^([^.]+)\.bg\./.exec(name)
      const markers = m ? this.bgMarkers.get(m[1]!) : undefined
      if (markers) found.push({ markers, name })
    }
    const mtimes = await Promise.all(found.map((f) => this.markerMtime(f.name)))
    found.forEach((f, i) => { const mtime = mtimes[i]; if (mtime !== undefined) f.markers.set(f.name, mtime) })
  }

  /** Removes the slot's subagent markers (a launch or exit: whatever ran belonged to the old process). */
  private clearBackground(slotId: string): void {
    // Straight to the executor, not the store: marker names are one per subagent (the store keeps state per path) and the
    // daemon never writes a marker, so there is nothing to order them behind.
    const remove = (name: string): void => {
      this.executor.run('rm', [join(slotsDir(this.home), name)]).catch((e: Error) => this.log(`slot ${slotId}: cannot remove marker ${name}: ${e.message}`))
    }
    const known = this.bgMarkers.get(slotId)
    if (known) {
      for (const name of known.keys()) remove(name)
      known.clear()
      return
    }
    // Not in memory: list them first. Only what already existed goes; a marker the new run writes meanwhile stays.
    const cutoff = Date.now()
    void this.markersOf(slotId).then((markers) => {
      for (const [name, mtime] of [...markers]) if (mtime <= cutoff) { remove(name); markers.delete(name) }
    })
  }

  /** Debounces the hook's attention file per slot (the write may be seen as several change events). */
  private scheduleAttentionReport(slotId: string): void {
    const key = `${slotId}.attention`
    const prev = this.pending.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(perf.wrap('timer:attention-report', () => {
      this.pending.delete(key)
      const slot = this.slotMap.get(slotId)
      if (slot) this.applyAttentionReport(slot)
    }), WATCH_DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /**
   * Applies the hook's last report when it is new and belongs to the current run of a live process. The file is read by the
   * executor; a read that finishes after a newer one started is dropped (the newer one saw the later text).
   */
  private applyAttentionReport(slot: Slot): void {
    const slotId = slot.meta.slotId
    const gen = slot.attentionGen = (slot.attentionGen ?? 0) + 1
    this.fsProbe?.('attention:read', slotId)
    void this.executor.run('readText', [slotAttentionPath(this.home, slotId)]).then((text) => {
      if (slot.attentionGen !== gen || this.slotMap.get(slotId) !== slot) return
      const report = parseAttentionReport(text)
      if (!report || (slot.attentionReportTs && report.ts <= slot.attentionReportTs)) return
      slot.attentionReportTs = report.ts
      if (!isAlive(slot) || (slot.spawnedAt && report.ts < slot.spawnedAt)) return
      if (slot.attention.hook(report.kind, report.reason)) this.broadcastState(slot)
      this.scheduleWake(slot)
    }, () => undefined) // no file (yet): nothing to apply
  }

  /**
   * The soul's `turn` events (busy|idle, in the slot's events file next to start/rename/end): applied in order, only the
   * ones written by the current run of a live process. They feed the attention turn, replacing the Enter / quiet heuristic.
   */
  private applyTurnReports(slot: Slot): void {
    const reports = slot.turnPending
    if (!reports?.length) return
    slot.turnPending = undefined
    if (!isAlive(slot)) return
    let changed = false
    for (const report of reports) {
      if (slot.spawnedAt && report.ts < slot.spawnedAt) continue
      const moved = report.kind === 'turn' ? slot.attention.signal(report.state) : slot.attention.waitSignal(report.state, report.reason)
      if (moved) changed = true
    }
    if (changed) this.broadcastState(slot)
  }

  /** Arms the idle heuristic's timer (soul) for the slot's next due time. */
  private scheduleAttention(slot: Slot): void {
    const due = slot.attention.dueAt()
    if (due === undefined || slot.attentionTimer) return
    slot.attentionTimer = setTimeout(perf.wrap('timer:attention', () => {
      slot.attentionTimer = undefined
      if (slot.attention.poll(Date.now())) this.broadcastState(slot)
      else this.scheduleAttention(slot)
    }), Math.max(50, due - Date.now()))
    slot.attentionTimer.unref()
  }

  // ---- ronda ------------------------------------------------------------------------------------

  /**
   * Why a due ronda cannot be sent now; undefined = go. It goes through the channel, never the terminal, so the user's
   * typing is no concern: only a running agent whose channel is connected, not in a turn (a nudge mid-turn would only queue
   * behind the work it asks about), and not in a polite pause.
   */
  private rondaBlocker(slot: Slot): string | undefined {
    if (slot.meta.agent === 'shell') return 'shell'
    if (!isAlive(slot) || slot.status !== 'running') return 'not-running'
    if (slot.restarting || slot.stopping) return 'restarting'
    if (!this.rondaChannel.connected(slot.meta.slotId)) return 'no-channel'
    // Claude: a permission prompt keeps the turn busy; the idle prompt (Notification after a finished turn) does not.
    if (slot.attention.turn === 'busy') return 'busy'
    // An extension reserved the window for a command of its own (the delivery's claim): the nudge waits for it and its settle.
    if (this.door.claimed?.(slot.meta.slotId)) return 'claimed'
    const pause = this.batch?.entries.find((e) => e.slotId === slot.meta.slotId)
    if (this.batch && this.batch.state !== 'closed' && pause && pause.state !== 'removed' && pause.state !== 'resumed' && pause.state !== 'resume-skipped') return 'paused'
    return undefined
  }

  /** Why the ronda cannot be switched on in this slot at all (an agent with no channel); undefined = it can. */
  private rondaUnavailable(slot: Slot): string | undefined {
    if (slot.meta.agent === 'shell') return 'a ronda não está disponível num terminal sem agente: ela acorda um agente por um canal dele, e um shell não tem canal.'
    if (!this.channelOf(slot.meta.agent)) return `a ronda não está disponível para o agente ${slot.meta.agent}: ele não recebe mensagens por canal, e o tether não digita no terminal.`
    return undefined
  }

  /** (Re)arms the slot's ronda timer: at nextAt, or a retry while it is due. */
  private armRonda(slot: Slot): void {
    if (slot.rondaTimer) clearTimeout(slot.rondaTimer)
    slot.rondaTimer = undefined
    if (!slot.ronda || this.closing) return
    const wait = slot.rondaDue ? this.rondaRetryMs : Math.max(0, Date.parse(slot.ronda.nextAt) - Date.now())
    slot.rondaTimer = setTimeout(perf.wrap('timer:ronda', () => { slot.rondaTimer = undefined; this.rondaTick(slot) }), Math.min(wait, 2 ** 31 - 1))
    slot.rondaTimer.unref()
  }

  private rondaTick(slot: Slot): void {
    const ronda = slot.ronda
    if (!ronda || this.closing || this.slotMap.get(slot.meta.slotId) !== slot) return
    if (!slot.rondaDue && Date.now() < Date.parse(ronda.nextAt)) { this.armRonda(slot); return }
    const blocker = this.rondaBlocker(slot)
    // A pane the app suspended to save resources is resumed for its ronda; the nudge goes once the agent is up and listening.
    if (blocker === 'not-running') this.door.resumeSuspended?.(slot.meta.slotId, 'ronda')
    if (blocker !== undefined || !this.rondaChannel.send(slot.meta.slotId, buildChannelText(ronda))) {
      if (!slot.rondaDue) { slot.rondaDue = true; this.log(`slot ${slot.meta.slotId}: ronda due, waiting (${blocker ?? 'no-channel'})`); this.broadcastState(slot) }
      this.armRonda(slot)
      return
    }
    slot.ronda = { ...ronda, lastAt: new Date().toISOString(), nextAt: new Date(Date.now() + ronda.intervalMs).toISOString() }
    slot.rondaDue = false
    this.saveRonda(slot)
    this.log(`slot ${slot.meta.slotId}: ronda sent through the channel`)
    this.armRonda(slot)
    this.broadcastState(slot)
  }

  private rondaOff(slot: Slot): void {
    if (slot.rondaTimer) clearTimeout(slot.rondaTimer)
    slot.rondaTimer = undefined
    slot.ronda = undefined
    slot.rondaDue = false
    this.saveRonda(slot)
    this.log(`slot ${slot.meta.slotId}: ronda off`)
    this.broadcastState(slot)
  }

  // ---- polite pause ----------------------------------------------------------------------------

  /** Entries still waiting for the agent (the request file stays until they are out of these states). */
  private static readonly PAUSE_LIVE: ReadonlySet<string> = new Set(['queued', 'listening', 'delivered', 'preparing'])

  private pauseStart(slotIds: unknown): PauseBatch {
    if (this.batch && this.batch.state !== 'closed') throw new RequestError('pause-active', 'já existe uma pausa em andamento')
    if (slotIds !== undefined && (!Array.isArray(slotIds) || slotIds.some((x) => typeof x !== 'string'))) throw new RequestError('bad-request', 'slotIds deve ser uma lista de ids')
    const chosen: Slot[] = slotIds === undefined
      ? [...this.slotMap.values()].filter((s) => s.attention.turn === 'busy' && isAlive(s))
      : [...new Set(slotIds as string[])].map((x) => this.slot(x))
    if (chosen.length === 0) throw new RequestError('bad-request', 'nenhum agente em andamento para pausar')
    const now = new Date().toISOString()
    const batch: PauseBatch = {
      v: 1,
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: now,
      state: 'pausing',
      entries: chosen.map((s) => {
        const e = newEntry(s.meta.slotId, s.meta.agent, now, s.binding?.sessionId)
        return transition(e, 'listening', now)
      }),
    }
    this.batch = batch
    for (const e of batch.entries) this.writePauseRequest(batch, e)
    this.savePause()
    this.log(`pause ${batch.id}: ${batch.entries.length} slot(s)`)
    return batch
  }

  /** Takes one slot out of the batch. */
  private pauseRemove(slotId: unknown): PauseBatch {
    const batch = this.activeBatch()
    const idx = batch.entries.findIndex((e) => e.slotId === slotId)
    if (idx < 0) throw new RequestError('unknown-slot', `slot fora do lote: ${String(slotId)}`)
    const entry = batch.entries[idx]!
    if (!canTransition(entry.state, 'removed')) throw new RequestError('bad-request', `o slot ${entry.slotId} já está em "${entry.state}" e não sai mais do lote`)
    batch.entries[idx] = transition(entry, 'removed', new Date().toISOString())
    this.clearPauseRequest(entry.slotId)
    this.settlePause(batch)
    const closed = this.closeIfSpent(batch)
    this.savePause()
    if (closed) this.batch = undefined
    return batch
  }

  /** Drops the batch. Agents that already got the request carry on as they see fit; there is just no resume. */
  private pauseCancel(): PauseBatch {
    const batch = this.activeBatch()
    for (const e of batch.entries) this.clearPauseRequest(e.slotId)
    batch.state = 'closed'
    this.savePause()
    this.batch = undefined
    this.log(`pause ${batch.id}: cancelled`)
    return batch
  }

  private activeBatch(): PauseBatch {
    if (!this.batch || this.batch.state === 'closed') throw new RequestError('no-pause', 'não há pausa em andamento')
    return this.batch
  }

  /** The batch is spent when nothing is awaited and nothing is left to resume. */
  private closeIfSpent(batch: PauseBatch): boolean {
    const pending = batch.entries.some((e) => DaemonImpl.PAUSE_LIVE.has(e.state) || e.state === 'stopped' || e.state === 'stopped-silent')
    if (!pending) batch.state = 'closed'
    return !pending
  }

  /** In-flight resumes, so two requests never type into the same slot twice. */
  private readonly resuming = new Set<string>()

  private pauseResume(slotIds: unknown): PauseBatch {
    const batch = this.activeBatch()
    if (slotIds !== undefined && (!Array.isArray(slotIds) || slotIds.some((x) => typeof x !== 'string'))) throw new RequestError('bad-request', 'slotIds deve ser uma lista de ids')
    const only = slotIds === undefined ? undefined : new Set(slotIds as string[])
    const targets = batch.entries
      .filter((e) => (e.state === 'stopped' || e.state === 'stopped-silent') && (!only || only.has(e.slotId)) && !this.resuming.has(e.slotId))
      .map((e) => e.slotId)
    if (targets.length === 0) throw new RequestError('bad-request', 'nenhum agente parado para retomar')
    for (const id of targets) this.resuming.add(id)
    if (batch.state === 'paused') batch.state = 'resuming'
    this.savePause()
    void this.runResume(batch, targets)
    return batch
  }

  /** 3 at a time. A failure on one slot never stops the others. */
  private async runResume(batch: PauseBatch, slotIds: string[]): Promise<void> {
    try {
      for (let i = 0; i < slotIds.length; i += PAUSE_RESUME_PARALLEL) {
        if (this.batch !== batch || batch.state === 'closed') return
        await Promise.all(slotIds.slice(i, i + PAUSE_RESUME_PARALLEL).map((id) =>
          this.resumeOne(batch, id).catch((e: Error) => this.log(`pause: resume of ${id} failed: ${e.message}`))))
      }
    } finally {
      for (const id of slotIds) this.resuming.delete(id)
      if (this.batch === batch && batch.state !== 'closed') {
        const closed = this.closeIfSpent(batch)
        if (!closed && batch.state === 'resuming' && this.resuming.size === 0) batch.state = 'paused'
        this.savePause()
        if (closed) this.batch = undefined
      }
    }
  }

  private async resumeOne(batch: PauseBatch, slotId: string): Promise<void> {
    const idx = batch.entries.findIndex((e) => e.slotId === slotId)
    const entry = batch.entries[idx]
    if (!entry || (entry.state !== 'stopped' && entry.state !== 'stopped-silent')) return
    const slot = this.slotMap.get(slotId)
    const skip = !slot ? 'o slot não existe mais'
      : !isAlive(slot) ? 'o processo do slot não está rodando'
      : slot.attention.turn === 'busy' ? 'o agente está ocupado com outro turno'
      : slot.attention.value === 'waiting' ? 'o agente está esperando uma resposta sua'
      : undefined
    const now = (): string => new Date().toISOString()
    if (skip || !slot) {
      batch.entries[idx] = transition(entry, 'resume-skipped', now(), { skipReason: skip ?? 'slot indisponível' })
      this.savePause()
      return
    }
    // Typed as the engine types (door/typing.ts: text and Enter in separate chunks, the engine's wait between them), and told
    // to the door at each write: the delivery's interlock sees it, so a delivery never lands between the text and the Enter.
    const agent = slot.meta.agent === 'shell' ? undefined : agentRegistry.get(slot.meta.agent)
    const chunks = typingOf(agent).submit(buildResumeText(entry.note))
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      if (chunk.waitMs && chunk.waitMs > 0) await sleep(chunk.waitMs)
      if (i > 0 && !isAlive(slot)) break
      slot.pty?.write(chunk.data)
      if (i > 0 && slot.attention.input(chunk.data)) this.broadcastState(slot)
      this.door.input(slotId, chunk.data, 'agent')
    }
    batch.entries[idx] = transition(batch.entries[idx]!, 'resumed', now())
    this.savePause()
  }

  /** Atomic (temp + rename): the hook may read the file at any moment. */
  private writePauseRequest(batch: PauseBatch, entry: PauseEntry): void {
    const cli = `node "${cliScript().replaceAll('\\', '/')}"`
    this.store.put(slotPauseRequestPath(this.home, entry.slotId), JSON.stringify({ batchId: batch.id, text: buildRequestText(cli) }) + '\n')
  }

  private clearPauseRequest(slotId: string): void {
    this.store.remove(slotPauseRequestPath(this.home, slotId))
  }

  /** Persists and tells every client. */
  private savePause(): void {
    const batch = this.batch
    if (!batch) return
    perf.timed('store:pause-write', () => this.store.put(pausePath(this.home), JSON.stringify(batch, null, 2) + '\n'))
    this.broadcast({ t: 'pause', batch })
  }

  /** Barrier of the pause requests: pause.json and the request files are on disk before the reply. */
  private async flushPause(): Promise<void> {
    const paths = [pausePath(this.home), ...(this.batch?.entries ?? []).map((e) => slotPauseRequestPath(this.home, e.slotId))]
    await Promise.all(paths.map((p) => this.store.flush(p)))
  }

  private async loadPause(): Promise<void> {
    const batch = await this.executor.run('readText', [pausePath(this.home)]).then(parsePauseFile, () => undefined)
    if (!batch || batch.state === 'closed') return
    this.batch = batch
    // The request file may be gone or stale after a crash: entries still listening get it again.
    for (const e of batch.entries) if (e.state === 'listening') this.writePauseRequest(batch, e)
    this.log(`pause ${batch.id}: reloaded (${batch.state})`)
  }

  private schedulePauseReport(slotId: string): void {
    const key = `${slotId}.pause.jsonl`
    const prev = this.pending.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(perf.wrap('timer:pause-report', () => {
      this.pending.delete(key)
      this.applyPauseReports(slotId)
    }), WATCH_DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /**
   * Reads the slot's report file (executor) and folds it into its entry; a read that finishes after a newer one started is
   * dropped. The whole file is replayed each time: applyReportLine ignores lines of other batches, older than the entry, or
   * that no longer apply, so replaying is idempotent.
   */
  private applyPauseReports(slotId: string): void {
    const slot = this.slotMap.get(slotId)
    if (!slot || !this.batch || this.batch.state === 'closed' || !this.batch.entries.some((e) => e.slotId === slotId)) return
    const gen = slot.pauseGen = (slot.pauseGen ?? 0) + 1
    this.fsProbe?.('pause:read', slotId)
    void this.executor.run('readText', [slotPauseReportPath(this.home, slotId)]).then((text) => {
      if (slot.pauseGen !== gen) return
      this.foldPauseReport(slotId, text)
    }, () => undefined) // no report file: nothing to fold
  }

  private foldPauseReport(slotId: string, text: string): void {
    const batch = this.batch // the batch and the entry are looked up again: they may have moved while the file was read
    if (!batch || batch.state === 'closed') return
    const idx = batch.entries.findIndex((e) => e.slotId === slotId)
    if (idx < 0) return
    const before = batch.entries[idx]!
    let entry = before
    // One transition per broadcast, so clients see delivered, preparing, stopped in order even when the lines arrive together.
    const steps: PauseEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const next = applyReportLine(entry, line, batch.id)
      if (next !== entry) { entry = next; steps.push(next) }
    }
    if (steps.length === 0) return
    for (const step of steps) {
      batch.entries[idx] = step
      this.settlePause(batch)
      this.savePause()
    }
    if (!DaemonImpl.PAUSE_LIVE.has(entry.state)) this.clearPauseRequest(slotId)
  }

  /** The batch is 'paused' once no entry is still being waited for. */
  private settlePause(batch: PauseBatch): void {
    if (batch.state === 'pausing' && !batch.entries.some((e) => DaemonImpl.PAUSE_LIVE.has(e.state))) batch.state = 'paused'
  }

  /** Debounces per slot: the hook writes a line and the editor/CLI may write more right after. */
  private schedule(slotId: string, eventsChanged: boolean): void {
    if (eventsChanged) this.eventsDirty.add(slotId)
    const prev = this.pending.get(slotId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(perf.wrap('timer:slot-events', () => {
      this.pending.delete(slotId)
      const dirty = this.eventsDirty.delete(slotId)
      const slot = this.slotMap.get(slotId)
      if (slot) {
        if (dirty) void this.pullEvents(slot)
        return
      }
      // A slot created by another process (the CLI): adopt it. Never one this daemon forgot (a late event of its own removal),
      // and never on its own echo (the text it last wrote there).
      if (this.forgotten.has(slotId)) return
      void this.adoptForeign(slotId)
    }), WATCH_DEBOUNCE_MS)
    this.pending.set(slotId, t)
  }
}

function isKind(x: unknown): x is SlotKind {
  return x === 'shell' || isAgentName(x)
}

/** The slot's process is up (spawned and not exited). */
function isAlive(slot: Slot): boolean {
  return slot.pty !== undefined && slot.pty.exit === undefined
}
