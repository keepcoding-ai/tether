// tetherd: owns one PTY per slot, keeps each slot's scrollback, launches agents through the adapters and
// watches <home>/slots/*.jsonl so every client sees the current binding. Speaks protocol.ts over a named
// pipe / unix socket (NDJSON). "Running" means: this process holds the PTY and it has not exited.
import { withTabEnv } from '../core/tab-env.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { AttentionState, attentionOptions, parseAttentionReport, parseTurnReports } from './attention.ts'
import { memoryChanged, sampleProcessTable, treeBytes } from './memory.ts'
import '../agents/load.ts'
import { agentChoices, agentRegistry, isAgentName } from '../agents/registry.ts'
import { shellAdapter } from '../agents/shell.ts'
import type { AgentAdapter, LaunchPlan } from '../agents/types.ts'
import type { AgentName, Binding, RunInfo, SlotMeta } from '../core/event.ts'
import { isSameProcess, pidExists, processStartTime } from '../core/liveness.ts'
import { canonicalDir, slotAttentionPath, slotEventsPath, slotMetaPath, slotPauseReportPath, slotPauseRequestPath, slotsDir } from '../core/paths.ts'
import { cliScript } from '../core/tab-env.ts'
import { RONDA_MCP_SERVER as RONDA_SERVER_NAME, RondaChannel, showsConfirm, type RondaChannelAgent } from './ronda-channel.ts'
import type { ChannelConfirm } from '../agents/registry.ts'
import { applyChange, buildChannelText, clearRonda, criterionStimulus, ENV_RONDA_TEST_SECONDS, flatText, readRonda, RondaError, writeRonda, type Ronda } from './ronda.ts'
import { applyReportLine, buildRequestText, buildResumeText, canTransition, newEntry, readPauseFile, transition, writePauseFile, type PauseBatch, type PauseEntry } from './pause.ts'
import { isProfileAgent, isUnsafe, ProfileError, ProfileStore, slotProfile, snapshotProfile, type Profile, type ProfileInput, type SlotProfile } from '../core/profile.ts'
import { clearRun, createSlot, currentBinding, listSlots, newSlotId, readEvents, readRun, readSlot, removeSlot, SLOT_ID_RE, writeRun, writeSlotMeta } from '../core/store.ts'
import { encode, guessId, LineParser } from './ndjson.ts'
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
} from './protocol.ts'
import { killTree, spawnPty, type PtyHandle } from './pty.ts'
import { Scrollback } from './scrollback.ts'
import { HostClient } from '../procd/client.ts'
import { procdPipePath } from '../procd/protocol.ts'
import { osUser, ProcManager, type GuardOptions } from './proc-manager.ts'
import { ProcError, WAIT_MAX_MS, type ProcAuthor, type ProcBy } from './procs.ts'

export const DAEMON_VERSION = '0.3.7'

/** How long a claude/soul slot may stay 'starting' without its start event before it counts as running anyway. */
const READY_FALLBACK_MS = 15_000
/** Period of the memory sample. One PowerShell process-table query for all slots costs ~0.9 s wall / ~0.9 s CPU on Windows (385 processes), so 60 s keeps it near 1.5 % of one core. */
export const MEMORY_INTERVAL_MS = 60_000
export { KILL_WAIT_CAP_MS, MIN_AGENT_AGE_MS }
/** Agent processes allowed in 'starting' at the same time (PRD RA8); the rest wait as 'queued'. */
export const MAX_STARTING = 3

/** Args appended to every launch of an agent by this daemon, from `TETHER_CLAUDE_ARGS` / `TETHER_SOUL_ARGS`
 *  (whitespace-separated). The app's dialog has no args field; this is how a dev/E2E run pins `--model haiku`. */
export function defaultAgentArgs(agent: AgentName, env: NodeJS.ProcessEnv = process.env): string[] {
  const name = agentRegistry.get(agent)?.envArgsVar ?? `TETHER_${agent.toUpperCase().replace(/-/g, '_')}_ARGS`
  const raw = env[name]?.trim()
  return raw ? raw.split(/\s+/) : []
}
const WATCH_DEBOUNCE_MS = 100
/** A subagent marker older than this no longer counts (its SubagentStop was lost: a crash, a kill). */
const BG_MAX_AGE_MS = 6 * 60 * 60_000
/** Pause resume: slots typed into at once, and the gap between the text and the Enter (else the TUI sees a paste). */
const PAUSE_RESUME_PARALLEL = 3
const PAUSE_RESUME_ENTER_DELAY_MS = 130
/** A due ronda re-checks a busy agent (or one whose channel is not connected) this often. */
const RONDA_RETRY_MS = 2_000
/** Screen kept while looking for the channel's start dialog (chars of raw output). */
const CONFIRM_SCREEN_MAX = 16_000
/** Gap between seeing the dialog and answering it (the TUI must have finished drawing and be reading keys). */
const CONFIRM_DELAY_MS = 400
const ENTER = String.fromCharCode(13)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

export interface DaemonOptions {
  home: string
  pipe: string
  log?: (msg: string) => void
  /** Called after a client's `shutdown` request has been honoured (PTYs killed, server closed). */
  onShutdown?: () => void
  /** Replaces an agent's adapter (tests: a fake that launches an inert process instead of the agent). */
  adapters?: Partial<Record<AgentName, AgentAdapter>>
  /** Daemon extensions' launch middlewares (TetherDaemon.launch.use), applied in order to every agent/shell plan. */
  transformPlan?: (plan: LaunchPlan, meta: SlotMeta) => LaunchPlan
  /** Slot lifecycle for daemon extensions (TetherDaemon.onSlot). */
  onSlot?: (kind: 'spawned' | 'exited' | 'bound' | 'removed', slot: SlotState) => void
  /** Overrides READY_FALLBACK_MS (tests). */
  readyFallbackMs?: number
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
}

export interface Daemon {
  readonly home: string
  readonly pipe: string
  readonly pid: number
  slots(): SlotState[]
  /** The server still accepts connections and is not closing (the state can be trusted). */
  listening(): boolean
  /** Kills every PTY tree, drops the clients and closes the server. */
  close(): Promise<void>
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

class RequestError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

interface Slot {
  meta: SlotMeta
  status: SlotStatus
  binding?: Binding
  title?: string
  error?: { code: ErrorCode; message: string }
  pty?: PtyHandle
  /** ISO time of the last spawn; a start event at/after it confirms the agent is up. */
  spawnedAt?: string
  readyTimer?: NodeJS.Timeout
  /** The choice the queued start was asked with (status 'queued' only). */
  queuedChoice?: 'resume' | 'new'
  /** Stops the adapter's title watch (running claude slots). */
  stopTitleWatch?: () => void
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
  /** The wake fallback after the last background subagent ended (see AttentionState.wakeDueAt). */
  wakeTimer?: NodeJS.Timeout
  /** How many `turn` lines of the events file were already applied (the file is append-only and spans runs). */
  turnLinesSeen?: number
  /** The slot's ronda (persisted in <home>/slots/<id>.ronda.json); `rondaDue`: its time came and it waits for an idle agent. */
  ronda?: Ronda
  rondaDue?: boolean
  rondaTimer?: NodeJS.Timeout
  /** Looking for the channel's start dialog: until it is answered once or the run reports its start. */
  confirmWatch?: { spec: ChannelConfirm; screen: string }
  attached: Set<Client>
  cols: number
  rows: number
}

interface Client {
  socket: Socket
  parser: LineParser
  attached: Set<string>
  /** Background processes whose output this client watches (proc-attach). */
  procsWatched: Set<string>
  /** From the hello: 'app' | 'cli' | 'test'. */
  kind?: string
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const d = new DaemonImpl(opts)
  await d.listen()
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
  private readonly slotMap = new Map<string, Slot>()
  private watcher: FSWatcher | undefined
  private readonly pending = new Map<string, NodeJS.Timeout>()
  /** Test overrides; everything else comes from the agent registry at the time of use. */
  private readonly adapterOverrides: Partial<Record<AgentName, AgentAdapter>>
  private readonly transformPlan: ((plan: LaunchPlan, meta: SlotMeta) => LaunchPlan) | undefined
  private readonly onSlot: ((kind: 'spawned' | 'exited' | 'bound' | 'removed', slot: SlotState) => void) | undefined
  private readonly readyFallbackMs: number
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

  constructor(opts: DaemonOptions) {
    this.home = opts.home
    this.pipe = opts.pipe
    this.log = opts.log ?? (() => {})
    this.onShutdown = opts.onShutdown
    this.adapterOverrides = { ...opts.adapters }
    this.transformPlan = opts.transformPlan
    this.onSlot = opts.onSlot
    this.readyFallbackMs = opts.readyFallbackMs ?? READY_FALLBACK_MS
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
      onChange: (slotId) => {
        const slot = this.slotMap.get(slotId)
        if (!slot) return
        this.log(`slot ${slotId}: ronda channel ${this.rondaChannel.connected(slotId) ? 'listening' : 'closed'}`)
        this.broadcastState(slot)
      },
    })
    this.profileStore = new ProfileStore(opts.home)
    this.server = createServer((socket) => this.onConnection(socket))
    const procdPipe = opts.procdPipe ?? procdPipePath(opts.pipe, opts.home)
    this.procs = new ProcManager({
      home: opts.home,
      log: this.log,
      broadcast: (msg) => this.broadcast(msg),
      author: (by, client) => this.procAuthor(by, client),
      connectHost: opts.connectProcHost ?? ((launch) => launch
        ? HostClient.ensure({ home: opts.home, pipe: procdPipe, node: process.env.TETHER_NODE?.trim() || process.execPath, env: process.env, log: this.log })
        : HostClient.open(procdPipe)),
      ...(opts.procHostReconnectMs !== undefined ? { reconnectMs: opts.procHostReconnectMs } : {}),
      allowSeconds: this.rondaAllowSeconds,
      slotExists: (slotId) => this.slotMap.has(slotId),
      protectedPids: () => [...this.slotMap.values()].filter((s) => s.pty && !s.pty.exit).map((s) => s.pty!.pid),
      sampleSoon: () => this.kickMemory(),
      onData: (name, data) => { for (const c of this.procWatchers.get(name) ?? []) this.send(c, { t: 'proc-data', name, data }) },
    })
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
    mkdirSync(slotsDir(this.home), { recursive: true })
    this.startedAt = (await processStartTime(process.pid)) ?? this.startedAt
    await this.reapOrphans()
    const profiles = this.profileStore.read()
    if (profiles.problem) this.log(`profiles: ${profiles.problem}`)
    for (const meta of listSlots(this.home)) this.load(meta)
    this.loadPause()
    await this.procs.init()
    this.startWatching()
    if (process.platform !== 'win32' && existsSync(this.pipe)) rmSync(this.pipe, { force: true })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.pipe, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.server.on('error', (e) => this.log(`server error: ${e.message}`))
    // Only the owner of the pipe serves the channel (a loser of the race never gets here).
    try { this.log(`ronda channel served on 127.0.0.1:${await this.rondaChannel.listen()}`) }
    catch (e) { this.log(`ronda channel not served (${(e as Error).message}); the ronda is unavailable this run`) }
    if (this.memoryIntervalMs > 0) {
      this.memoryTimer = setInterval(() => void this.sampleMemory(), this.memoryIntervalMs)
      this.memoryTimer.unref()
    }
    this.log(`listening on ${this.pipe} (${this.slotMap.size} slots)`)
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

  /** Timestamp of the slot's last logged event: the best idle-since for a slot that had no turn since the daemon booted. */
  private lastEventTs(slot: Slot): string | undefined {
    const events = readEvents(this.home, slot.meta.slotId)
    return events.length ? events[events.length - 1]!.ts : undefined
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
    if (slot.pty && !slot.pty.exit) s.pid = slot.pty.pid
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
    if (slot.attention.turn === 'busy') {
      s.turn = 'busy'
      if (slot.attention.busySince) s.busySince = slot.attention.busySince
      if (slot.attention.background > 0) s.background = slot.attention.background
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
    return s
  }

  /** A fresh slot should not wait a whole interval for its first reading: one sample a few seconds after a spawn (coalesced). */
  private kickMemory(): void {
    if (this.memoryIntervalMs <= 0 || this.memoryKick) return
    this.memoryKick = setTimeout(() => { this.memoryKick = undefined; void this.sampleMemory() }, Math.min(5_000, this.memoryIntervalMs))
    this.memoryKick.unref()
  }

  /** One process-table query for every live slot and background process; broadcasts those whose memory moved enough. Never overlaps itself. */
  private async sampleMemory(): Promise<void> {
    if (this.memorySampling || this.closing) return
    const live = [...this.slotMap.values()].filter((s) => s.pty && !s.pty.exit)
    const procRoots = this.procs.liveRoots()
    if (!live.length && !procRoots.length) return
    this.memorySampling = true
    try {
      await this.procs.observeExternals()
      const sums = treeBytes(await sampleProcessTable(), [...live.map((s) => s.pty!.pid), ...procRoots.map((r) => r.pid)])
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
    if (changed) writeSlotMeta(this.home, meta)
    this.broadcastState(slot)
    return changed
  }

  /** Puts the profile fields back as they were (a refused restart undoes the assignment). */
  private restoreProfileFields(slot: Slot, saved: Pick<SlotMeta, 'profileId' | 'profileArgs' | 'profileEnv'>): void {
    const { meta } = slot
    if (saved.profileId === undefined) delete meta.profileId; else meta.profileId = saved.profileId
    if (saved.profileArgs === undefined) delete meta.profileArgs; else meta.profileArgs = saved.profileArgs
    if (saved.profileEnv === undefined) delete meta.profileEnv; else meta.profileEnv = saved.profileEnv
    try { writeSlotMeta(this.home, meta) } catch (e) { this.log(`slot ${meta.slotId}: cannot restore the profile fields: ${(e as Error).message}`) }
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
    for (const slot of this.slotMap.values()) if (slot.meta.profileId) this.broadcast({ t: 'state', slot: this.stateOf(slot, profiles) })
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
    try { writeRun(this.home, slot.meta.slotId, run) } catch (e) { this.log(`slot ${slot.meta.slotId}: cannot write run file: ${(e as Error).message}`) }
  }

  /** Drops the slot's run file when it is this daemon's (a CLI `--here` launcher's file is left alone). */
  private forgetRun(slotId: string): void {
    const run = readRun(this.home, slotId)
    if (run && run.by === 'tetherd') clearRun(this.home, slotId)
  }

  /**
   * A tetherd that died hard (killed, crashed) may leave its agents alive when ConPTY does not take them down.
   * Each slot's run file names the agent by pid AND start time: a process that matches both is provably the one
   * that tetherd launched and is killed with its tree; a pid that now belongs to something else is never touched.
   * Runs whose owning tetherd is still alive (same pid and start time) are left alone.
   */
  private async reapOrphans(): Promise<void> {
    for (const meta of listSlots(this.home)) {
      const id = meta.slotId
      const run = readRun(this.home, id)
      if (!run || run.by !== 'tetherd' || run.pid === this.pid) continue
      if (run.agentPid === undefined || run.agentStartedAt === undefined) { clearRun(this.home, id); continue }
      if (await isSameProcess(run.pid, run.startedAt)) {
        this.log(`slot ${id}: run owned by live tetherd pid ${run.pid}; leaving it`)
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
      clearRun(this.home, id)
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.memoryTimer) clearInterval(this.memoryTimer)
    if (this.memoryKick) clearTimeout(this.memoryKick)
    for (const s of this.slotMap.values()) if (s.rondaTimer) clearTimeout(s.rondaTimer)
    this.queue.length = 0
    // Background processes live in tether-procd and outlive this daemon: only the connection to it closes.
    this.procs.close()
    // Every slot is stopped in parallel (each waits for its own agent to be old enough) while the event files
    // are still watched: a young Claude's start report must be seen to let its kill go ahead.
    await Promise.all([...this.slotMap.values()].map((s) => this.stopSlot(s)))
    this.watcher?.close()
    for (const t of this.pending.values()) clearTimeout(t)
    await this.rondaChannel.close()
    for (const c of this.clients) c.socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
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

  private emitSlot(kind: 'spawned' | 'exited' | 'bound' | 'removed', slot: Slot): void {
    if (!this.onSlot) return
    try { this.onSlot(kind, this.stateOf(slot)) } catch (e) { this.log(`onSlot listener failed: ${(e as Error).message}`) }
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
    this.refreshBinding(slot, false)
    const ronda = readRonda(this.home, meta.slotId)
    if (ronda) { slot.ronda = ronda; this.armRonda(slot) }
    return slot
  }

  private slot(slotId: unknown): Slot {
    const s = typeof slotId === 'string' ? this.slotMap.get(slotId) : undefined
    if (!s) throw new RequestError('unknown-slot', `slot desconhecido: ${String(slotId)}`)
    return s
  }

  /** Re-reads the slot's events; broadcasts `state` when binding or title changed. */
  private refreshBinding(slot: Slot, broadcast = true): void {
    const binding = currentBinding(readEvents(this.home, slot.meta.slotId), slot.meta)
    const changed = JSON.stringify(binding) !== JSON.stringify(slot.binding)
    if (!changed) return
    slot.binding = binding
    slot.title = binding?.title
    if (slot.status === 'starting' && binding && slot.spawnedAt && binding.since >= slot.spawnedAt) this.setRunning(slot) // broadcasts
    else if (broadcast) this.broadcastState(slot)
    this.unwatchTitle(slot) // the watch follows one binding; this one changed
    if (isAlive(slot)) this.watchTitle(slot)
    this.emitSlot('bound', slot)
    const titleAdapter = binding && !binding.title ? this.adapterOf(binding.agent) : undefined
    if (binding && titleAdapter) {
      void titleAdapter.title(binding, this.lookupOf(slot)).then((title) => {
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
    const stop = adapter.watchTitle(binding, (title) => {
      if (slot.binding !== binding || slot.title === title) return
      slot.title = title
      this.broadcastState(slot)
    }, this.titlePollMs, this.lookupOf(slot))
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
    const cwd = resume ? resume.cwd : meta.cwd
    if (!existsSync(cwd)) throw this.fail(slot, 'cwd-missing', `a pasta não existe: ${cwd}`)
    if (resume) {
      for (const other of this.slotMap.values()) {
        if (other !== slot && other.pty && !other.pty.exit && other.binding?.sessionId === resume.sessionId) {
          throw new RequestError('already-open', `a sessão já está aberta no slot ${other.meta.slotId}`)
        }
      }
    }
    return resume
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
  private async startSlot(slot: Slot, choice: 'resume' | 'new' | undefined): Promise<void> {
    if (slot.pty && !slot.pty.exit) return // idempotent: already up
    if (slot.status === 'queued') return // already waiting its turn
    const unavailable = this.unavailableError(slot.meta)
    if (unavailable) throw this.fail(slot, unavailable.code, unavailable.message)
    const resume = this.resumeFor(slot, choice)
    if (resume) {
      // PRD C15: a resume of a session the agent no longer has must fail here, not inside the agent's TUI.
      const exists = await (this.adapterOf(resume.agent)?.sessionExists(resume, this.lookupOf(slot)) ?? 'unknown')
      if (exists === false) throw this.fail(slot, 'session-missing', `a sessão ${resume.sessionId} não existe mais no ${resume.agent}`)
      if (slot.pty && !slot.pty.exit) return // another request started it while we checked
    }
    if (slot.meta.agent !== 'shell' && this.startingCount() >= MAX_STARTING) {
      slot.status = 'queued'
      slot.error = undefined
      slot.queuedChoice = choice
      this.queue.push(slot)
      this.log(`slot ${slot.meta.slotId}: queued (${this.queue.length} waiting)`)
      this.broadcastState(slot)
      return
    }
    this.launch(slot, resume)
  }

  /** Launches queued slots while seats are free. A start that fails now is reported through the slot's state. */
  private pump(): void {
    while (this.queue.length > 0 && this.startingCount() < MAX_STARTING) {
      const slot = this.queue.shift()!
      if (slot.status !== 'queued') continue
      const choice = slot.queuedChoice
      slot.queuedChoice = undefined
      try {
        this.launch(slot, this.resumeFor(slot, choice))
      } catch (e) {
        if (slot.status === 'queued') {
          const err = e instanceof RequestError ? e : new RequestError('spawn-failed', (e as Error).message)
          this.fail(slot, err.code, err.message)
        }
      }
    }
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

  private launch(slot: Slot, resume: Binding | undefined): void {
    const { meta } = slot
    let plan: LaunchPlan
    try {
      plan = this.planFor(meta, resume)
    } catch (e) {
      throw this.fail(slot, e instanceof RequestError ? e.code : 'spawn-failed', (e as Error).message)
    }
    // The ronda's channel, offered at every launch of an agent that takes one (a new key per run).
    const channel = meta.agent === 'shell' ? undefined : this.channelOf(meta.agent)
    const offer = this.rondaChannel.prepare(plan, meta.slotId, channel)
    plan = offer.plan
    slot.confirmWatch = offer.offered && channel?.confirm ? { spec: channel.confirm, screen: '' } : undefined
    slot.scrollback.clear()
    slot.attention.reset()
    this.clearBackground(meta.slotId)
    slot.error = undefined
    slot.memoryMB = undefined
    if (meta.endedAt) {
      delete meta.endedAt
      try { writeSlotMeta(this.home, meta) } catch (e) { this.log(`slot ${meta.slotId}: cannot clear endedAt: ${(e as Error).message}`) }
    }
    slot.spawnedAt = new Date().toISOString()
    slot.runUnsafe = isUnsafe(plan.args)
    try {
      slot.pty = spawnPty(plan, {
        cols: slot.cols,
        rows: slot.rows,
        onData: (data) => {
          slot.scrollback.push(data)
          if (slot.confirmWatch) this.watchConfirm(slot, data)
          if (slot.attention.output(data, Date.now())) this.broadcastState(slot)
          this.scheduleAttention(slot)
          for (const c of slot.attached) this.send(c, { t: 'data', slotId: meta.slotId, data })
        },
        onExit: (exit) => {
          this.log(`slot ${meta.slotId}: exited (code ${exit.exitCode})`)
          this.forgetRun(meta.slotId)
          this.rondaChannel.revoke(meta.slotId)
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
          // PRD C18: an agent run that never reported its session (old version, hook removed, crashed before the
          // hook) leaves the binding unconfirmed: the next start must be an explicit choice, never a silent guess.
          this.refreshBinding(slot, false) // the hook's last line may land right before the exit
          if (meta.agent !== 'shell' && !this.reportedThisRun(slot)) {
            slot.status = 'unconfirmed'
            this.log(`slot ${meta.slotId}: no start event for this run; binding unconfirmed`)
          }
          this.broadcastState(slot)
          this.emitSlot('exited', slot)
          // The panel's agent left: its process uses end. A restart in place (restartSlot, set-profile) and tetherd
          // closing are not leaving.
          if (!slot.restarting && !this.closing) this.procs.slotGone(meta.slotId)
          this.pump()
        },
      })
    } catch (e) {
      throw this.fail(slot, 'spawn-failed', (e as Error).message)
    }
    this.log(`slot ${meta.slotId}: spawned pid ${slot.pty.pid} (${meta.agent}${resume ? ', resume ' + resume.sessionId : ''})`)
    void this.recordRun(slot, slot.pty)
    if (meta.agent === 'shell') slot.status = 'running'
    else {
      slot.status = 'starting'
      slot.readyTimer = setTimeout(() => {
        if (slot.status === 'starting') this.setRunning(slot)
      }, this.readyFallbackMs)
      slot.readyTimer.unref()
    }
    this.broadcastState(slot)
    this.watchTitle(slot)
    this.kickMemory()
    this.emitSlot('spawned', slot)
  }

  /**
   * The plan applies the slot's profile AS IT IS NOW (an edit takes effect on the next start) and refreshes the
   * slot's snapshot of it, so a profile deleted later still launches the slot the way it last ran.
   */
  private planFor(meta: SlotMeta, resume: Binding | undefined): LaunchPlan {
    const profiles = this.profileStore.profiles()
    const current = profiles.find((p) => p.id === meta.profileId)
    if (current && snapshotProfile(meta, current)) {
      try { writeSlotMeta(this.home, meta) } catch (e) { this.log(`slot ${meta.slotId}: cannot refresh the profile snapshot: ${(e as Error).message}`) }
    }
    const profile = this.profileOf(meta, profiles).launch
    let plan: LaunchPlan
    if (meta.agent === 'shell') plan = shellAdapter.plan({ slot: meta, cwd: resume?.cwd, profile })
    else {
      const adapter = this.adapterOf(meta.agent)
      if (!adapter) throw new RequestError('agent-unavailable', `o agente ${meta.agent} não está disponível`)
      plan = adapter.plan({ slot: meta, home: this.home, resume, extraArgs: defaultAgentArgs(meta.agent), profile })
    }
    plan = withTabEnv(plan, meta)
    return this.transformPlan ? this.transformPlan(plan, meta) : plan
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
    setTimeout(() => {
      if (slot.pty !== pty || !isAlive(slot) || this.reportedThisRun(slot)) return
      pty?.write(w.spec.keys)
    }, CONFIRM_DELAY_MS).unref()
  }

  /** A start event of the agent arrived at/after the last spawn (the binding describes what this run opened). */
  private reportedThisRun(slot: Slot): boolean {
    return slot.binding !== undefined && slot.spawnedAt !== undefined && slot.binding.since >= slot.spawnedAt
  }

  /** Records when the run ended (in the meta, so a restarted daemon still knows). */
  private markEnded(slot: Slot): void {
    slot.meta.endedAt = new Date().toISOString()
    try { writeSlotMeta(this.home, slot.meta) } catch (e) { this.log(`slot ${slot.meta.slotId}: cannot record endedAt: ${(e as Error).message}`) }
  }

  private fail(slot: Slot, code: ErrorCode, message: string): RequestError {
    slot.status = 'error'
    slot.error = { code, message }
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
    const pty = slot.pty
    if (!pty) {
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
  }

  // ---- connections ---------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    const client: Client = { socket, parser: new LineParser(), attached: new Set(), procsWatched: new Set() }
    this.clients.add(client)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const line of client.parser.push(chunk)) void this.onLine(client, line.value, line.raw)
    })
    socket.on('error', (e) => this.log(`client error: ${e.message}`))
    socket.on('close', () => {
      this.clients.delete(client)
      for (const id of client.attached) this.slotMap.get(id)?.attached.delete(client)
      for (const name of client.procsWatched) this.unwatchProc(client, name)
    })
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

  private broadcast(msg: DaemonMessage): void {
    for (const c of this.clients) this.send(c, msg)
  }

  private broadcastState(slot: Slot): void {
    this.broadcast({ t: 'state', slot: this.stateOf(slot) })
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
    if (msg.t === 'input') {
      const slot = typeof msg.slotId === 'string' ? this.slotMap.get(msg.slotId) : undefined
      if (slot && typeof msg.data === 'string') {
        slot.pty?.write(msg.data)
        if (slot.attention.input(msg.data)) this.broadcastState(slot)
      }
      return
    }
    const id = (msg as { id?: unknown }).id
    if (typeof id !== 'number') return // not a request we can answer
    let reply: Reply
    try {
      reply = await this.handle(client, msg as Request)
    } catch (e) {
      const err = e instanceof RequestError ? e : new RequestError('bad-request', (e as Error).message)
      reply = { t: 'error', id, code: err.code, message: err.message }
    }
    this.send(client, reply)
  }

  private async handle(client: Client, req: Request): Promise<Reply> {
    const { id } = req
    switch (req.t) {
      case 'hello':
        if (typeof req.client === 'string') client.kind = req.client
        return { t: 'ok', id, hello: { v: PROTOCOL_VERSION, pid: this.pid, version: DAEMON_VERSION, exec: process.execPath } }
      case 'list':
        return { t: 'ok', id, slots: this.slots() }
      case 'create': {
        if (!isKind(req.kind)) throw new RequestError('bad-request', `tipo inválido: ${String(req.kind)}`)
        if (req.kind !== 'shell' && !this.adapterOf(req.kind)) throw new RequestError('bad-request', `tipo inválido: ${req.kind} (use ${agentChoices()})`)
        if (typeof req.cwd !== 'string' || !req.cwd) throw new RequestError('bad-request', 'cwd obrigatório')
        const meta: SlotMeta = {
          v: 1,
          slotId: newSlotId(this.home),
          agent: req.kind,
          cwd: canonicalDir(req.cwd),
          args: Array.isArray(req.args) ? req.args.filter((a): a is string => typeof a === 'string') : [],
          createdAt: new Date().toISOString(),
        }
        if (typeof req.name === 'string' && req.name) meta.name = req.name
        if (req.profileId !== undefined) {
          const profile = this.requireProfile(req.profileId)
          if (profile.agent !== req.kind) throw new RequestError('bad-request', `o perfil "${profile.name}" é de ${profile.agent}, não de ${req.kind}`)
          snapshotProfile(meta, profile)
        }
        createSlot(this.home, meta)
        const slot = this.load(meta)
        this.broadcastState(slot)
        if (req.start) await this.startSlot(slot, undefined)
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'start': {
        const slot = this.slot(req.slotId)
        await this.startSlot(slot, req.choice === 'new' || req.choice === 'resume' ? req.choice : undefined)
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'attach': {
        const slot = this.slot(req.slotId)
        client.attached.add(slot.meta.slotId)
        slot.attached.add(client)
        this.resize(slot, req.cols, req.rows)
        return { t: 'ok', id, slot: this.stateOf(slot), scrollback: slot.scrollback.text() }
      }
      case 'seen': {
        const slot = this.slot(req.slotId)
        if (slot.attention.seen()) this.broadcastState(slot)
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
      case 'stop': {
        const slot = this.slot(req.slotId)
        await this.stopSlot(slot)
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'forget': {
        const slot = this.slot(req.slotId)
        await this.stopSlot(slot)
        this.slotMap.delete(slot.meta.slotId)
        this.rondaChannel.revoke(slot.meta.slotId)
        if (slot.rondaTimer) clearTimeout(slot.rondaTimer)
        slot.ronda = undefined
        for (const c of slot.attached) c.attached.delete(slot.meta.slotId)
        removeSlot(this.home, slot.meta.slotId)
        // The slot is gone for good (its pane was closed): extensions drop what they kept with it.
        this.emitSlot('removed', slot)
        this.procs.slotGone(slot.meta.slotId)
        this.broadcast({ t: 'removed', slotId: slot.meta.slotId })
        return { t: 'ok', id }
      }
      case 'rename-slot': {
        const slot = this.slot(req.slotId)
        if (typeof req.name !== 'string') throw new RequestError('bad-request', 'nome obrigatório')
        if (req.name) slot.meta.name = req.name
        else delete slot.meta.name
        writeFileSync(slotMetaPath(this.home, slot.meta.slotId), JSON.stringify(slot.meta, null, 2) + '\n')
        this.broadcastState(slot)
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'shutdown': {
        this.log('shutdown requested')
        setImmediate(() => void this.close().then(() => this.onShutdown?.()))
        return { t: 'ok', id }
      }
      case 'profiles-list': {
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
        this.log(`profile ${saved.profile.id} saved (${saved.profile.agent} "${saved.profile.name}")`)
        this.broadcastProfiles()
        return { t: 'ok', id, profile: saved.profile, warnings: saved.warnings }
      }
      case 'profile-delete': {
        const profile = this.requireProfile(req.profileId)
        this.profileStore.delete(profile.id)
        this.log(`profile ${profile.id} deleted`)
        this.broadcastProfiles()
        return { t: 'ok', id }
      }
      case 'pause-start':
        return { t: 'ok', id, pause: this.pauseStart(req.slotIds) }
      case 'pause-get':
        return { t: 'ok', id, pause: this.batch ?? null }
      case 'pause-remove':
        return { t: 'ok', id, pause: this.pauseRemove(req.slotId) }
      case 'pause-cancel':
        return { t: 'ok', id, pause: this.pauseCancel() }
      case 'pause-resume':
        return { t: 'ok', id, pause: this.pauseResume(req.slotIds) }
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
          writeRonda(this.home, slot.meta.slotId, r.ronda)
          this.log(`slot ${slot.meta.slotId}: ronda ${r.outcome} (${r.ronda.intervalMs} ms${r.ronda.criterion ? ', com critério' : ''})`)
          this.armRonda(slot)
          this.broadcastState(slot)
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
        return { t: 'ok', id, ronda: null, rondaOutcome: 'off' }
      }
      case 'restart': {
        const slot = this.slot(req.slotId)
        if (!this.adapterOf(slot.meta.agent)?.resumes) throw new RequestError('bad-request', `o ${slot.meta.agent} não retoma sessão: não há como reiniciar o slot ${slot.meta.slotId}`)
        if (!isAlive(slot)) throw new RequestError('bad-request', `o slot ${slot.meta.slotId} não está rodando`)
        // Same early refusal as set-profile: nothing is touched when the agent never reported its session.
        if (slot.status === 'running' && !this.reportedThisRun(slot)) {
          throw new RequestError('unconfirmed', `o ${slot.meta.agent} deste slot não registrou a sessão desta execução: reiniciar agora poderia perder a conversa`)
        }
        await this.restartSlot(slot)
        return { t: 'ok', id, slot: this.stateOf(slot) }
      }
      case 'set-profile': {
        const slot = this.slot(req.slotId)
        if (req.profileId !== null && typeof req.profileId !== 'string') throw new RequestError('bad-request', 'profileId obrigatório (ou null para nenhum perfil)')
        const profile = req.profileId === null ? undefined : this.requireProfile(req.profileId)
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
            throw e
          }
        }
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
      default:
        throw new RequestError('bad-request', `mensagem desconhecida: ${String((req as { t?: unknown }).t)}`)
    }
  }

  private requireProfile(profileId: unknown): Profile {
    const p = typeof profileId === 'string' ? this.profileStore.profiles().find((x) => x.id === profileId) : undefined
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
      this.watcher = watch(slotsDir(this.home), (_event, filename) => {
        if (typeof filename !== 'string') return
        const pr = /^([^.]+)\.pause\.jsonl$/.exec(filename)
        if (pr && SLOT_ID_RE.test(pr[1]!)) { this.schedulePauseReport(pr[1]!); return }
        const bg = /^([^.]+)\.bg\./.exec(filename)
        if (bg && SLOT_ID_RE.test(bg[1]!)) { this.scheduleBackground(bg[1]!); return }
        const a = /^([^.]+)\.attention$/.exec(filename)
        if (a && SLOT_ID_RE.test(a[1]!)) { this.scheduleAttentionReport(a[1]!); return }
        const m = /^([^.]+)\.(jsonl|json)$/.exec(filename)
        if (!m || !SLOT_ID_RE.test(m[1]!)) return
        this.schedule(m[1]!)
      })
      this.watcher.on('error', (e) => this.log(`watch error: ${e.message}`))
    } catch (e) {
      this.log(`cannot watch ${slotsDir(this.home)}: ${(e as Error).message}`)
    }
  }

  /** Debounces the subagent markers per slot (<slot>.bg.<agentId>, written and removed by Claude's Subagent hooks). */
  private scheduleBackground(slotId: string): void {
    const key = `${slotId}.bg`
    const prev = this.pending.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.pending.delete(key)
      const slot = this.slotMap.get(slotId)
      if (slot) this.applyBackground(slot)
    }, WATCH_DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /** Counts the slot's live subagent markers: written in this run and younger than BG_MAX_AGE_MS (a lost Stop must not pin it). */
  private applyBackground(slot: Slot): void {
    if (!isAlive(slot)) return
    const dir = slotsDir(this.home)
    const prefix = `${slot.meta.slotId}.bg.`
    const since = slot.spawnedAt ? Date.parse(slot.spawnedAt) : 0
    const now = Date.now()
    let n = 0
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue
        try {
          const m = statSync(join(dir, name)).mtimeMs
          if (m >= since - 1000 && now - m < BG_MAX_AGE_MS) n++
        } catch { /* removed meanwhile */ }
      }
    } catch { return }
    if (slot.attention.setBackground(n, now)) this.broadcastState(slot)
    this.scheduleWake(slot)
  }

  /** Arms the wake fallback: the last subagent ended and the agent must finish its turn within WAKE_MS, or it counts as done. */
  private scheduleWake(slot: Slot): void {
    if (slot.wakeTimer) { clearTimeout(slot.wakeTimer); slot.wakeTimer = undefined }
    const due = slot.attention.wakeDueAt()
    if (due === undefined) return
    slot.wakeTimer = setTimeout(() => {
      slot.wakeTimer = undefined
      if (slot.attention.wakeExpired(Date.now())) this.broadcastState(slot)
    }, Math.max(50, due - Date.now()))
    slot.wakeTimer.unref()
  }

  /** Removes the slot's subagent markers (a launch or exit: whatever ran belonged to the old process). */
  private clearBackground(slotId: string): void {
    const dir = slotsDir(this.home)
    try {
      for (const name of readdirSync(dir)) if (name.startsWith(`${slotId}.bg.`)) { try { unlinkSync(join(dir, name)) } catch { /* gone */ } }
    } catch { /* no dir */ }
  }

  /** Debounces the hook's attention file per slot (the write may be seen as several change events). */
  private scheduleAttentionReport(slotId: string): void {
    const key = `${slotId}.attention`
    const prev = this.pending.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.pending.delete(key)
      const slot = this.slotMap.get(slotId)
      if (slot) this.applyAttentionReport(slot)
    }, WATCH_DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /** Applies the hook's last report when it is new and belongs to the current run of a live process. */
  private applyAttentionReport(slot: Slot): void {
    let text: string
    try { text = readFileSync(slotAttentionPath(this.home, slot.meta.slotId), 'utf8') } catch { return }
    const report = parseAttentionReport(text)
    if (!report || (slot.attentionReportTs && report.ts <= slot.attentionReportTs)) return
    slot.attentionReportTs = report.ts
    if (!isAlive(slot) || (slot.spawnedAt && report.ts < slot.spawnedAt)) return
    if (slot.attention.hook(report.kind)) this.broadcastState(slot)
    this.scheduleWake(slot)
  }

  /**
   * The soul's `turn` events (busy|idle, in the slot's events file next to start/rename/end): applied in order, only the
   * ones written by the current run of a live process. They feed the attention turn, replacing the Enter / quiet heuristic.
   */
  private applyTurnReports(slot: Slot): void {
    let text: string
    try { text = readFileSync(slotEventsPath(this.home, slot.meta.slotId), 'utf8') } catch { return }
    const reports = parseTurnReports(text)
    const seen = slot.turnLinesSeen ?? 0
    if (reports.length <= seen) return
    slot.turnLinesSeen = reports.length
    if (!isAlive(slot)) return
    let changed = false
    for (const report of reports.slice(seen)) {
      if (slot.spawnedAt && report.ts < slot.spawnedAt) continue
      if (slot.attention.signal(report.state)) changed = true
    }
    if (changed) this.broadcastState(slot)
  }

  /** Arms the idle heuristic's timer (soul) for the slot's next due time. */
  private scheduleAttention(slot: Slot): void {
    const due = slot.attention.dueAt()
    if (due === undefined || slot.attentionTimer) return
    slot.attentionTimer = setTimeout(() => {
      slot.attentionTimer = undefined
      if (slot.attention.poll(Date.now())) this.broadcastState(slot)
      else this.scheduleAttention(slot)
    }, Math.max(50, due - Date.now()))
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
    slot.rondaTimer = setTimeout(() => { slot.rondaTimer = undefined; this.rondaTick(slot) }, Math.min(wait, 2 ** 31 - 1))
    slot.rondaTimer.unref()
  }

  private rondaTick(slot: Slot): void {
    const ronda = slot.ronda
    if (!ronda || this.closing || this.slotMap.get(slot.meta.slotId) !== slot) return
    if (!slot.rondaDue && Date.now() < Date.parse(ronda.nextAt)) { this.armRonda(slot); return }
    const blocker = this.rondaBlocker(slot)
    if (blocker !== undefined || !this.rondaChannel.send(slot.meta.slotId, buildChannelText(ronda))) {
      if (!slot.rondaDue) { slot.rondaDue = true; this.log(`slot ${slot.meta.slotId}: ronda due, waiting (${blocker ?? 'no-channel'})`); this.broadcastState(slot) }
      this.armRonda(slot)
      return
    }
    slot.ronda = { ...ronda, lastAt: new Date().toISOString(), nextAt: new Date(Date.now() + ronda.intervalMs).toISOString() }
    slot.rondaDue = false
    try { writeRonda(this.home, slot.meta.slotId, slot.ronda) } catch (e) { this.log(`ronda: cannot save ${slot.meta.slotId}: ${(e as Error).message}`) }
    this.log(`slot ${slot.meta.slotId}: ronda sent through the channel`)
    this.armRonda(slot)
    this.broadcastState(slot)
  }

  private rondaOff(slot: Slot): void {
    if (slot.rondaTimer) clearTimeout(slot.rondaTimer)
    slot.rondaTimer = undefined
    slot.ronda = undefined
    slot.rondaDue = false
    clearRonda(this.home, slot.meta.slotId)
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
    // Text and Enter in separate chunks: the Claude TUI takes a burst as a paste and would not submit it.
    slot.pty?.write(buildResumeText(entry.note))
    await sleep(PAUSE_RESUME_ENTER_DELAY_MS)
    if (isAlive(slot)) {
      slot.pty?.write(ENTER)
      if (slot.attention.input(ENTER)) this.broadcastState(slot)
    }
    batch.entries[idx] = transition(batch.entries[idx]!, 'resumed', now())
    this.savePause()
  }

  /** Atomic (temp + rename): the hook may read the file at any moment. */
  private writePauseRequest(batch: PauseBatch, entry: PauseEntry): void {
    try {
      const path = slotPauseRequestPath(this.home, entry.slotId)
      const cli = `node "${cliScript().replaceAll('\\', '/')}"`
      mkdirSync(slotsDir(this.home), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ batchId: batch.id, text: buildRequestText(cli) }) + '\n')
      renameSync(tmp, path)
    } catch (e) { this.log(`pause: cannot write the request of ${entry.slotId}: ${(e as Error).message}`) }
  }

  private clearPauseRequest(slotId: string): void {
    rmSync(slotPauseRequestPath(this.home, slotId), { force: true })
  }

  /** Persists and tells every client. */
  private savePause(): void {
    const batch = this.batch
    if (!batch) return
    try { writePauseFile(this.home, batch) } catch (e) { this.log(`pause: cannot write pause.json: ${(e as Error).message}`) }
    this.broadcast({ t: 'pause', batch })
  }

  private loadPause(): void {
    const batch = readPauseFile(this.home)
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
    const t = setTimeout(() => {
      this.pending.delete(key)
      this.applyPauseReports(slotId)
    }, WATCH_DEBOUNCE_MS)
    this.pending.set(key, t)
  }

  /**
   * Folds the slot's report file into its entry. The whole file is replayed each time: applyReportLine ignores lines
   * of other batches, older than the entry, or that no longer apply, so replaying is idempotent.
   */
  private applyPauseReports(slotId: string): void {
    const batch = this.batch
    if (!batch || batch.state === 'closed') return
    const idx = batch.entries.findIndex((e) => e.slotId === slotId)
    if (idx < 0) return
    let text: string
    try { text = readFileSync(slotPauseReportPath(this.home, slotId), 'utf8') } catch { return }
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
  private schedule(slotId: string): void {
    const prev = this.pending.get(slotId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.pending.delete(slotId)
      const slot = this.slotMap.get(slotId)
      if (slot) {
        this.refreshBinding(slot)
        this.applyTurnReports(slot)
        return
      }
      // A slot created by another process (the CLI): adopt it.
      const meta = readSlot(this.home, slotId)
      if (meta) this.broadcastState(this.load(meta))
    }, WATCH_DEBOUNCE_MS)
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
