// tetherd: owns one PTY per slot, keeps each slot's scrollback, launches agents through the adapters and
// watches <home>/slots/*.jsonl so every client sees the current binding. Speaks protocol.ts over a named
// pipe / unix socket (NDJSON). "Running" means: this process holds the PTY and it has not exited.
import { existsSync, mkdirSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { claudeAdapter } from '../agents/claude.ts'
import { shellAdapter } from '../agents/shell.ts'
import { soulAdapter } from '../agents/soul.ts'
import type { AgentAdapter, LaunchPlan } from '../agents/types.ts'
import type { AgentName, Binding, SlotMeta } from '../core/event.ts'
import { slotMetaPath, slotsDir } from '../core/paths.ts'
import { createSlot, currentBinding, listSlots, newSlotId, readEvents, readSlot, removeSlot, SLOT_ID_RE } from '../core/store.ts'
import { encode, guessId, LineParser } from './ndjson.ts'
import {
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
import { spawnPty, type PtyHandle } from './pty.ts'
import { Scrollback } from './scrollback.ts'

export const DAEMON_VERSION = '0.1.0'

/** How long a claude/soul slot may stay 'starting' without its start event before it counts as running anyway. */
const READY_FALLBACK_MS = 15_000
/** Agent processes allowed in 'starting' at the same time (PRD RA8); the rest wait as 'queued'. */
export const MAX_STARTING = 3
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
  /** Overrides READY_FALLBACK_MS (tests). */
  readyFallbackMs?: number
  /** How often a running Claude slot's title is polled from its transcript (tests shorten it). */
  titlePollMs?: number
}

export interface Daemon {
  readonly home: string
  readonly pipe: string
  readonly pid: number
  slots(): SlotState[]
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
  scrollback: Scrollback
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
  private readonly adapters: Record<AgentName, AgentAdapter>
  private readonly readyFallbackMs: number
  private readonly titlePollMs: number | undefined
  /** Slots waiting for a 'starting' seat, in request order. */
  private readonly queue: Slot[] = []
  private closing = false

  constructor(opts: DaemonOptions) {
    this.home = opts.home
    this.pipe = opts.pipe
    this.log = opts.log ?? (() => {})
    this.onShutdown = opts.onShutdown
    this.adapters = { claude: claudeAdapter, soul: soulAdapter, ...opts.adapters }
    this.readyFallbackMs = opts.readyFallbackMs ?? READY_FALLBACK_MS
    this.titlePollMs = opts.titlePollMs
    this.server = createServer((socket) => this.onConnection(socket))
  }

  async listen(): Promise<void> {
    mkdirSync(slotsDir(this.home), { recursive: true })
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
    return [...this.slotMap.values()].map(stateOf)
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.watcher?.close()
    for (const t of this.pending.values()) clearTimeout(t)
    this.queue.length = 0
    await Promise.all([...this.slotMap.values()].map((s) => this.stopSlot(s)))
    for (const c of this.clients) c.socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.log('closed')
  }

  // ---- slots ---------------------------------------------------------------------------------

  private load(meta: SlotMeta): Slot {
    const slot: Slot = {
      meta,
      status: 'exited',
      scrollback: new Scrollback(),
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
    if (slot.status === 'starting' && binding && slot.spawnedAt && binding.since >= slot.spawnedAt) this.setRunning(slot)
    if (broadcast) this.broadcastState(slot)
    this.unwatchTitle(slot) // the watch follows one binding; this one changed
    if (isAlive(slot)) this.watchTitle(slot)
    if (binding && !binding.title) {
      void this.adapters[binding.agent].title(binding).then((title) => {
        if (!title || slot.binding !== binding || slot.title === title) return
        slot.title = title
        this.broadcastState(slot)
      })
    }
  }

  /** The agent confirmed it is up (its start event arrived) or the fallback expired: frees a 'starting' seat. */
  private setRunning(slot: Slot): void {
    if (slot.readyTimer) clearTimeout(slot.readyTimer)
    slot.readyTimer = undefined
    slot.status = 'running'
    this.pump()
  }

  // ---- title watch (agents whose renames bypass the slot jsonl) --------------------------------

  private watchTitle(slot: Slot): void {
    const binding = slot.binding
    if (slot.stopTitleWatch || !binding || slot.meta.agent === 'shell') return
    const adapter = this.adapters[slot.meta.agent]
    if (!adapter.watchTitle) return
    const stop = adapter.watchTitle(binding, (title) => {
      if (slot.binding !== binding || slot.title === title) return
      slot.title = title
      this.broadcastState(slot)
    }, this.titlePollMs)
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
    const resume = this.resumeFor(slot, choice)
    if (resume) {
      // PRD C15: a resume of a session the agent no longer has must fail here, not inside the agent's TUI.
      const exists = await this.adapters[resume.agent].sessionExists(resume)
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
      throw this.fail(slot, 'spawn-failed', (e as Error).message)
    }
    slot.scrollback.clear()
    slot.error = undefined
    slot.spawnedAt = new Date().toISOString()
    try {
      slot.pty = spawnPty(plan, {
        cols: slot.cols,
        rows: slot.rows,
        onData: (data) => {
          slot.scrollback.push(data)
          for (const c of slot.attached) this.send(c, { t: 'data', slotId: meta.slotId, data })
        },
        onExit: (exit) => {
          this.log(`slot ${meta.slotId}: exited (code ${exit.exitCode})`)
          if (slot.readyTimer) clearTimeout(slot.readyTimer)
          slot.readyTimer = undefined
          slot.status = 'exited'
          this.unwatchTitle(slot)
          // PRD C18: an agent run that never reported its session (old version, hook removed, crashed before the
          // hook) leaves the binding unconfirmed: the next start must be an explicit choice, never a silent guess.
          this.refreshBinding(slot, false) // the hook's last line may land right before the exit
          if (meta.agent !== 'shell' && !this.reportedThisRun(slot)) {
            slot.status = 'unconfirmed'
            this.log(`slot ${meta.slotId}: no start event for this run; binding unconfirmed`)
          }
          this.broadcastState(slot)
          this.pump()
        },
      })
    } catch (e) {
      throw this.fail(slot, 'spawn-failed', (e as Error).message)
    }
    this.log(`slot ${meta.slotId}: spawned pid ${slot.pty.pid} (${meta.agent}${resume ? ', resume ' + resume.sessionId : ''})`)
    if (meta.agent === 'shell') slot.status = 'running'
    else {
      slot.status = 'starting'
      slot.readyTimer = setTimeout(() => {
        if (slot.status === 'starting') {
          this.setRunning(slot)
          this.broadcastState(slot)
        }
      }, this.readyFallbackMs)
      slot.readyTimer.unref()
    }
    this.broadcastState(slot)
    this.watchTitle(slot)
  }

  private planFor(meta: SlotMeta, resume: Binding | undefined): LaunchPlan {
    switch (meta.agent) {
      case 'shell':
        return shellAdapter.plan({ slot: meta, cwd: resume?.cwd })
      case 'claude':
      case 'soul':
        return this.adapters[meta.agent].plan({ slot: meta, home: this.home, resume, extraArgs: [] })
    }
  }

  /** A start event of the agent arrived at/after the last spawn (the binding describes what this run opened). */
  private reportedThisRun(slot: Slot): boolean {
    return slot.binding !== undefined && slot.spawnedAt !== undefined && slot.binding.since >= slot.spawnedAt
  }

  private fail(slot: Slot, code: ErrorCode, message: string): RequestError {
    slot.status = 'error'
    slot.error = { code, message }
    this.broadcastState(slot)
    return new RequestError(code, message)
  }

  private async stopSlot(slot: Slot): Promise<void> {
    this.dequeue(slot)
    this.unwatchTitle(slot)
    const pty = slot.pty
    if (!pty) return
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
    this.broadcast({ t: 'state', slot: stateOf(slot) })
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
      if (slot && typeof msg.data === 'string') slot.pty?.write(msg.data)
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
        return { t: 'ok', id, hello: { v: PROTOCOL_VERSION, pid: this.pid, version: DAEMON_VERSION } }
      case 'list':
        return { t: 'ok', id, slots: this.slots() }
      case 'create': {
        if (!isKind(req.kind)) throw new RequestError('bad-request', `tipo inválido: ${String(req.kind)}`)
        if (typeof req.cwd !== 'string' || !req.cwd) throw new RequestError('bad-request', 'cwd obrigatório')
        const meta: SlotMeta = {
          v: 1,
          slotId: newSlotId(this.home),
          agent: req.kind,
          cwd: req.cwd,
          args: Array.isArray(req.args) ? req.args.filter((a): a is string => typeof a === 'string') : [],
          createdAt: new Date().toISOString(),
        }
        if (typeof req.name === 'string' && req.name) meta.name = req.name
        createSlot(this.home, meta)
        const slot = this.load(meta)
        this.broadcastState(slot)
        if (req.start) await this.startSlot(slot, undefined)
        return { t: 'ok', id, slot: stateOf(slot) }
      }
      case 'start': {
        const slot = this.slot(req.slotId)
        await this.startSlot(slot, req.choice === 'new' || req.choice === 'resume' ? req.choice : undefined)
        return { t: 'ok', id, slot: stateOf(slot) }
      }
      case 'attach': {
        const slot = this.slot(req.slotId)
        client.attached.add(slot.meta.slotId)
        slot.attached.add(client)
        this.resize(slot, req.cols, req.rows)
        return { t: 'ok', id, slot: stateOf(slot), scrollback: slot.scrollback.text() }
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
        return { t: 'ok', id, slot: stateOf(slot) }
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
        return { t: 'ok', id, slot: stateOf(slot) }
      }
      case 'shutdown': {
        this.log('shutdown requested')
        setImmediate(() => void this.close().then(() => this.onShutdown?.()))
        return { t: 'ok', id }
      }
      default:
        throw new RequestError('bad-request', `mensagem desconhecida: ${String((req as { t?: unknown }).t)}`)
    }
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
        const m = /^([^.]+)\.(jsonl|json)$/.exec(filename)
        if (!m || !SLOT_ID_RE.test(m[1]!)) return
        this.schedule(m[1]!)
      })
      this.watcher.on('error', (e) => this.log(`watch error: ${e.message}`))
    } catch (e) {
      this.log(`cannot watch ${slotsDir(this.home)}: ${(e as Error).message}`)
    }
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
  return x === 'claude' || x === 'soul' || x === 'shell'
}

/** The slot's process is up (spawned and not exited). */
function isAlive(slot: Slot): boolean {
  return slot.pty !== undefined && slot.pty.exit === undefined
}

function stateOf(slot: Slot): SlotState {
  const s: SlotState = {
    slotId: slot.meta.slotId,
    kind: slot.meta.agent,
    cwd: slot.binding?.cwd ?? slot.meta.cwd,
    status: slot.status,
  }
  if (slot.meta.name) s.name = slot.meta.name
  if (slot.pty && !slot.pty.exit) s.pid = slot.pty.pid
  if (slot.binding) s.binding = slot.binding
  if (slot.title) s.title = slot.title
  if (slot.error) s.error = slot.error
  return s
}
