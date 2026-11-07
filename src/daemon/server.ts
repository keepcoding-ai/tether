// tetherd: owns one PTY per slot, keeps each slot's scrollback, launches agents through the adapters and
// watches <home>/slots/*.jsonl so every client sees the current binding. Speaks protocol.ts over a named
// pipe / unix socket (NDJSON). "Running" means: this process holds the PTY and it has not exited.
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { AttentionState, attentionOptions, parseAttentionReport } from './attention.ts'
import '../agents/load.ts'
import { agentChoices, agentRegistry, isAgentName } from '../agents/registry.ts'
import { shellAdapter } from '../agents/shell.ts'
import type { AgentAdapter, LaunchPlan } from '../agents/types.ts'
import type { AgentName, Binding, RunInfo, SlotMeta } from '../core/event.ts'
import { isSameProcess, pidExists, processStartTime } from '../core/liveness.ts'
import { canonicalDir, slotAttentionPath, slotMetaPath, slotsDir } from '../core/paths.ts'
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

export const DAEMON_VERSION = '0.3.1'

/** How long a claude/soul slot may stay 'starting' without its start event before it counts as running anyway. */
const READY_FALLBACK_MS = 15_000
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
  onSlot?: (kind: 'spawned' | 'exited' | 'bound', slot: SlotState) => void
  /** Overrides READY_FALLBACK_MS (tests). */
  readyFallbackMs?: number
  /** How often a running Claude slot's title is polled from its transcript (tests shorten it). */
  titlePollMs?: number
  /** Overrides MIN_AGENT_AGE_MS (tests); 0 disables the young-agent guard. */
  minAgentAgeMs?: number
  /** Overrides KILL_WAIT_CAP_MS (tests). */
  killWaitCapMs?: number
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
  attentionTimer?: NodeJS.Timeout
  /** ts of the last hook report applied (the file is rewritten per report; older ones are ignored). */
  attentionReportTs?: string
  attached: Set<Client>
  cols: number
  rows: number
}

interface Client {
  socket: Socket
  parser: LineParser
  attached: Set<string>
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
  private readonly onSlot: ((kind: 'spawned' | 'exited' | 'bound', slot: SlotState) => void) | undefined
  private readonly readyFallbackMs: number
  private readonly minAgentAgeMs: number
  private readonly killWaitCapMs: number
  private readonly titlePollMs: number | undefined
  /** <home>/profiles.json, re-read when it changes on disk (the CLI edits it while tetherd runs). */
  private readonly profileStore: ProfileStore
  /** Slots waiting for a 'starting' seat, in request order. */
  private readonly queue: Slot[] = []
  private closing = false
  /** This process' OS start time: goes into every run file so a later tetherd can tell this one is gone. */
  private startedAt = new Date().toISOString()

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
    this.profileStore = new ProfileStore(opts.home)
    this.server = createServer((socket) => this.onConnection(socket))
  }

  async listen(): Promise<void> {
    mkdirSync(slotsDir(this.home), { recursive: true })
    this.startedAt = (await processStartTime(process.pid)) ?? this.startedAt
    await this.reapOrphans()
    const profiles = this.profileStore.read()
    if (profiles.problem) this.log(`profiles: ${profiles.problem}`)
    for (const meta of listSlots(this.home)) this.load(meta)
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
    if (slot.attention.value) s.attention = slot.attention.value
    return s
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
      this.log(`slot ${slot.meta.slotId}: restarting pid ${pty.pid} with profile ${slot.meta.profileId ?? '(none)'}`)
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
    this.queue.length = 0
    // Every slot is stopped in parallel (each waits for its own agent to be old enough) while the event files
    // are still watched: a young Claude's start report must be seen to let its kill go ahead.
    await Promise.all([...this.slotMap.values()].map((s) => this.stopSlot(s)))
    this.watcher?.close()
    for (const t of this.pending.values()) clearTimeout(t)
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

  private emitSlot(kind: 'spawned' | 'exited' | 'bound', slot: Slot): void {
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
    slot.scrollback.clear()
    slot.attention.reset()
    slot.error = undefined
    slot.spawnedAt = new Date().toISOString()
    slot.runUnsafe = isUnsafe(plan.args)
    try {
      slot.pty = spawnPty(plan, {
        cols: slot.cols,
        rows: slot.rows,
        onData: (data) => {
          slot.scrollback.push(data)
          if (slot.attention.output(data, Date.now())) this.broadcastState(slot)
          this.scheduleAttention(slot)
          for (const c of slot.attached) this.send(c, { t: 'data', slotId: meta.slotId, data })
        },
        onExit: (exit) => {
          this.log(`slot ${meta.slotId}: exited (code ${exit.exitCode})`)
          this.forgetRun(meta.slotId)
          if (slot.readyTimer) clearTimeout(slot.readyTimer)
          slot.readyTimer = undefined
          slot.status = 'exited'
          slot.attention.reset()
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
    return this.transformPlan ? this.transformPlan(plan, meta) : plan
  }

  /** A start event of the agent arrived at/after the last spawn (the binding describes what this run opened). */
  private reportedThisRun(slot: Slot): boolean {
    return slot.binding !== undefined && slot.spawnedAt !== undefined && slot.binding.since >= slot.spawnedAt
  }

  private fail(slot: Slot, code: ErrorCode, message: string): RequestError {
    slot.status = 'error'
    slot.error = { code, message }
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
    const client: Client = { socket, parser: new LineParser(), attached: new Set() }
    this.clients.add(client)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const line of client.parser.push(chunk)) void this.onLine(client, line.value, line.raw)
    })
    socket.on('error', (e) => this.log(`client error: ${e.message}`))
    socket.on('close', () => {
      this.clients.delete(client)
      for (const id of client.attached) this.slotMap.get(id)?.attached.delete(client)
    })
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
        for (const c of slot.attached) c.attached.delete(slot.meta.slotId)
        removeSlot(this.home, slot.meta.slotId)
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

  /** Debounces per slot: the hook writes a line and the editor/CLI may write more right after. */
  private schedule(slotId: string): void {
    const prev = this.pending.get(slotId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.pending.delete(slotId)
      const slot = this.slotMap.get(slotId)
      if (slot) {
        this.refreshBinding(slot)
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
