// tetherd's side of background processes: the cards in memory, the connection to tether-procd, reconciliation
// with what the host and the run files say, the acts (start, stop, restart, forget), the declared uses that guard
// stop/restart/forget, the ports view, and the notices left to the panels that use a process. tetherd is the only
// writer of the history. It never restarts anything by itself, and kills only by pid + creation time (a process
// that the host lost but somehow survived), never by name.
import { userInfo } from 'node:os'
import { isSameProcess, pidExists, processStartTime } from '../core/liveness.ts'
import { HostClient, HostRequestError } from '../procd/client.ts'
import { readRunFile, type HostRun, type RunExit } from '../procd/protocol.ts'
import { relativeTime } from '../cli/format.ts'
import { sampleProcessTable } from './memory.ts'
import { leaveNotice, quoted } from './notices.ts'
import { buildPortRows, listListeners, ownerText, probePort, treeOwners, type PortRow } from './ports.ts'
import { LaunchError, planFor } from './proc-launch.ts'
import {
  actionText,
  appendProcEvent,
  authorText,
  checkName,
  clockTime,
  deriveState,
  hasEnded,
  INFO_EVENTS,
  inUseBoard,
  listCards,
  liveUses,
  normalizeRecipe,
  othersUses,
  pendingRequest,
  ProcError,
  PURPOSE_MAX,
  readAdopt,
  readProcEvents,
  readUses,
  recipeDiff,
  recipeOf,
  removeAdopt,
  removeProcFiles,
  replay,
  statusText,
  USE_DEFAULT,
  USE_MAX_MS,
  useKey,
  useView,
  writeAdopt,
  writeCard,
  writeUses,
  type AdoptFile,
  type GuardedAction,
  type ProcAuthor,
  type ProcBy,
  type ProcCard,
  type ProcEvent,
  type ProcRecipe,
  type ProcState,
  type ProcUse,
  type UseView,
} from './procs.ts'
import { flatText, formatInterval, parseInterval, RondaError } from './ronda.ts'
import type { DaemonMessage } from './protocol.ts'
import { killTree } from './pty.ts'

/** How long a lost host connection is retried (without launching) before its processes count as lost with it. */
export const HOST_RECONNECT_MS = 3_000
const PLAN_COLS = 120
const PLAN_ROWS = 30
/** A refused panel hears "free again" only within this window. */
const REFUSED_KEEP_MS = 30 * 60_000
/** After killing an adopted process: how long its death and its ports' release are awaited. */
const EXTERNAL_GONE_MS = 8_000
const NOTICE_PREFIX = '[tether] processos: '

/** How an act meets the uses of others: refuse (default), wait up to `waitMs`, or go ahead with a reason. */
export interface GuardOptions {
  waitMs?: number
  force?: string
}

export interface ProcManagerOptions {
  home: string
  log: (msg: string) => void
  broadcast: (msg: DaemonMessage) => void
  /** Pids tetherd must never adopt: every panel's agent or shell (its own pid and the host's are known here). */
  protectedPids?: () => number[]
  /** The portrait of whoever asks (tetherd knows its slots). */
  author: (by: ProcBy | undefined, client: string | undefined) => ProcAuthor
  /** Connects to the host; `launch` = start one when nothing answers (only a start does). */
  connectHost: (launch: boolean) => Promise<HostClient>
  /** Base environment of the processes (default: tetherd's). */
  env?: NodeJS.ProcessEnv
  reconnectMs?: number
  /** Use durations in seconds are accepted (tests; the same switch as the ronda's). */
  allowSeconds?: boolean
  /** Is this one of tetherd's slots? (a use of a panel forgotten while tetherd was down ends at boot). */
  slotExists?: (slotId: string) => boolean
  /** A process started: a memory sample soon would show it. */
  sampleSoon?: () => void
  /** Output of a process whose output someone watches (attachOutput). */
  onData?: (name: string, data: string) => void
}

interface Entry {
  card: ProcCard
  /** Identity of the adopted outside process while it lives (pid + creation time). */
  adopt?: AdoptFile
  events: ProcEvent[]
  stopping?: boolean
  /** The run someone looked at (clears attention). */
  seenRun?: number
  /** An exit the host announced before the spawn reply came back (a process that ends at once). */
  earlyExit?: { run: number; exit: RunExit }
  /** Declared uses (persisted in <name>.uses.json); expired ones are removed by the timer. */
  uses: ProcUse[]
  useTimer?: NodeJS.Timeout
  /** Acts waiting for the uses of others to end. */
  waiters: Set<() => void>
  /** Panels refused by uses: they hear when the process is free (slotId → when). */
  refused: Map<string, number>
  /** Declared ports probed for the last state. */
  listening?: Map<number, boolean>
  memoryMB?: number
  /** Guards out-of-order broadcasts (each emit probes the ports first). */
  emitSeq: number
}

export class ProcManager {
  private readonly home: string
  private readonly log: (msg: string) => void
  private readonly broadcast: (msg: DaemonMessage) => void
  private readonly author: ProcManagerOptions['author']
  private readonly connectHost: ProcManagerOptions['connectHost']
  private readonly env: NodeJS.ProcessEnv
  private readonly reconnectMs: number
  private readonly allowSeconds: boolean
  private readonly slotExists: ((slotId: string) => boolean) | undefined
  private readonly sampleSoon: (() => void) | undefined
  private readonly onData: ((name: string, data: string) => void) | undefined
  private readonly protectedPids: (() => number[]) | undefined
  /** Names whose output tetherd is attached to in the host (a new host connection attaches them again). */
  private readonly watched = new Set<string>()
  private readonly entries = new Map<string, Entry>()
  private readonly locks = new Map<string, Promise<void>>()
  private host: HostClient | undefined
  private connecting: Promise<HostClient | undefined> | undefined
  /** A shutdown of the host was asked: its close is expected, no reconnect wait. */
  private hostStopping = false
  private closing = false

  constructor(opts: ProcManagerOptions) {
    this.home = opts.home
    this.log = opts.log
    this.broadcast = opts.broadcast
    this.author = opts.author
    this.connectHost = opts.connectHost
    this.env = opts.env ?? process.env
    this.reconnectMs = opts.reconnectMs ?? HOST_RECONNECT_MS
    this.allowSeconds = opts.allowSeconds ?? false
    this.slotExists = opts.slotExists
    this.sampleSoon = opts.sampleSoon
    this.onData = opts.onData
    this.protectedPids = opts.protectedPids
  }

  /** Loads the cards; with any, only TRIES the host (never launches it) and reconciles. */
  async init(): Promise<void> {
    for (const card of listCards(this.home)) {
      const e = newEntry(card, readProcEvents(this.home, card.name))
      e.uses = readUses(this.home, card.name)
      this.entries.set(card.name, e)
      // Uses of panels that no longer exist end now; the ones that ran out while tetherd was down expire at their time.
      const gone = e.uses.filter((u) => u.by.slotId && u.key.startsWith('slot:') && this.slotExists && !this.slotExists(u.by.slotId))
      for (const u of gone) this.append(e, { kind: 'use-released', by: u.by, cause: 'panel-gone' })
      if (gone.length) e.uses = e.uses.filter((u) => !gone.includes(u))
      this.expireUses(e)
    }
    for (const e of this.entries.values()) {
      if (!isExternalLive(e)) continue
      e.adopt = readAdopt(this.home, e.card.name)
      await this.checkExternal(e, true)
    }
    if (!this.entries.size) return
    const host = await this.retryConnect(1_000)
    await this.reconcile(host ? (await host.request({ t: 'list' })).runs ?? [] : [], host !== undefined)
  }

  close(): void {
    this.closing = true
    for (const e of this.entries.values()) {
      if (e.useTimer) clearTimeout(e.useTimer)
      for (const w of e.waiters) w()
    }
    this.host?.close()
    this.host = undefined
  }

  async list(): Promise<ProcState[]> {
    const all = [...this.entries.values()].sort((a, b) => a.card.name.localeCompare(b.card.name))
    await Promise.all(all.map((e) => this.checkExternal(e)))
    await Promise.all(all.map((e) => this.probe(e)))
    return all.map((e) => this.state(e))
  }

  /** Live processes (the CLI says how many keep running when tetherd restarts). */
  liveCount(): number {
    return [...this.entries.values()].filter(isLive).length
  }

  async info(name: string): Promise<{ proc: ProcState; events: ProcEvent[] }> {
    const e = this.require(name)
    await this.checkExternal(e)
    await this.probe(e)
    return { proc: this.state(e), events: e.events.slice(-INFO_EVENTS) }
  }

  /**
   * Starts relaying the process' output (onData) and returns what the host holds of its current run, or undefined when
   * the host has no run of it in memory (stopped before this host, or no host). Asking again gives a fresh scrollback.
   * Read only: there is no way to write to a process.
   */
  async attachOutput(name: string): Promise<string | undefined> {
    this.require(name)
    this.watched.add(name)
    const host = await this.connect(false)
    if (!host) return undefined
    try {
      return (await host.request({ t: 'attach', name })).scrollback ?? ''
    } catch (err) {
      if (err instanceof HostRequestError && err.code === 'unknown-run') return undefined
      throw err
    }
  }

  /** Stops relaying the process' output (the last watcher left). */
  detachOutput(name: string): void {
    this.watched.delete(name)
    this.host?.request({ t: 'detach', name }).catch(() => { /* the run may be gone */ })
  }

  /** pid and name of every live process (the memory sample's roots, the ports' owners). */
  liveRoots(): { pid: number; name: string }[] {
    const out: { pid: number; name: string }[] = []
    for (const e of this.entries.values()) {
      const pid = isLive(e) ? replay(e.events).started?.pid : undefined
      if (typeof pid === 'number') out.push({ pid, name: e.card.name })
    }
    return out
  }

  /** The periodic sample's chance to notice that an adopted process vanished. */
  async observeExternals(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.checkExternal(e)))
  }

  /** The memory sample's sums (bytes per root pid); a process whose reading moved enough is broadcast. */
  setMemory(sums: Map<number, number>, changed: (prev: number | undefined, next: number) => boolean): void {
    for (const e of this.entries.values()) {
      const pid = isLive(e) ? replay(e.events).started?.pid : undefined
      const bytes = typeof pid === 'number' ? sums.get(pid) : undefined
      if (bytes === undefined) continue
      const mb = Math.round(bytes / 1048576)
      if (changed(e.memoryMB, mb)) { e.memoryMB = mb; this.emit(e) }
    }
  }

  /** The ports view (`check`: that port only). */
  async ports(check?: number): Promise<PortRow[]> {
    if (check !== undefined && (!Number.isInteger(check) || check <= 0 || check > 65535)) throw new ProcError('bad-request', `porta inválida: ${check}`)
    const declared = [...this.entries.values()].map((e) => ({ name: e.card.name, status: this.state(e).status, ports: e.card.ports }))
    if (check !== undefined) {
      const listening = await probePort(check)
      const own = declared.filter((d) => d.ports.includes(check)).map((d) => ({ ...d, ports: [check] }))
      const rows = listening ? await this.portRows(own) : buildPortRows([], [], new Map(), own)
      const row = rows.find((r) => r.port === check)
      // The probe is the authority: a listener the table missed (another user's, a race) is still "busy".
      if (listening && !row?.listening) return [{ port: check, listening: true, ...(row?.declaredBy ? { declaredBy: row.declaredBy } : {}) }]
      return row ? [row] : []
    }
    return this.portRows(declared)
  }

  seen(name: string): void {
    const e = this.require(name)
    const run = replay(e.events).started?.run
    if (run !== undefined && e.seenRun !== run) {
      e.seenRun = run
      this.emit(e)
    }
  }

  start(name: string, recipe: ProcRecipe | undefined, by: ProcBy | undefined, client: string | undefined, force = false): Promise<ProcState> {
    checkName(name)
    return this.locked(name, async () => {
      const author = this.author(by, client)
      let e = this.entries.get(name)
      if (e && isLive(e)) throw new ProcError('proc-running', this.runningMessage(e))
      if (!e && !recipe) throw new ProcError('unknown-proc', `não há processo ${name}; para registrar, passe o comando: tether proc start ${name} -- <comando…>`)
      const fields = recipe ? normalizeRecipe(recipe) : undefined
      if (!force) {
        const busy = await this.portConflict(name, fields?.ports ?? e!.card.ports)
        if (busy) throw new ProcError('port-busy', `não iniciei ${name}: ${busy}. Escolha outra porta (tether proc ports mostra quem ouve onde), pare quem ocupa, ou inicie mesmo assim com --force`)
      }
      if (fields) {
        if (!e) {
          const card: ProcCard = { v: 1, name, ...fields, registeredBy: author, createdAt: new Date().toISOString() }
          writeCard(this.home, card)
          e = newEntry(card, [])
          this.entries.set(name, e)
          this.append(e, { kind: 'registered', by: author })
        } else {
          const diff = recipeDiff(recipeOf(e.card), fields)
          if (diff) {
            const card: ProcCard = { ...e.card, ...fields }
            if (fields.description === undefined) delete card.description
            writeCard(this.home, card)
            e.card = card
            this.append(e, { kind: 'recipe-changed', by: author, before: diff.before, after: diff.after })
          }
        }
      }
      await this.launch(e!, author)
      return this.state(e!)
    })
  }

  stop(name: string, reason: string | undefined, by: ProcBy | undefined, client: string | undefined, guard: GuardOptions = {}): Promise<ProcState> {
    return this.locked(name, async () => {
      const e = this.require(name)
      if (!isLive(e)) return this.state(e)
      const author = this.author(by, client)
      const over = await this.guard(e, 'stop', author, guard)
      const run = replay(e.events).started!.run!
      const why = reason ?? guard.force
      this.append(e, { kind: 'stop-requested', by: author, run, ...(why ? { reason: why } : {}) })
      if (e.adopt) await this.stopExternal(e, run)
      else await this.stopRun(e, run)
      this.tellUsers(e, author, `${e.card.name} foi parado por ${authorText(author)}${over ? ', à força sobre o seu uso' : ''}${why ? `, motivo: ${quoted(why)}` : ''}. O tether não o sobe de novo sozinho`)
      return this.state(e)
    })
  }

  restart(name: string, reason: string | undefined, by: ProcBy | undefined, client: string | undefined, guard: GuardOptions = {}): Promise<ProcState> {
    return this.locked(name, async () => {
      const e = this.require(name)
      const author = this.author(by, client)
      const over = await this.guard(e, 'restart', author, guard)
      const why = reason ?? guard.force
      if (isLive(e)) {
        const run = replay(e.events).started!.run!
        this.append(e, { kind: 'restart-requested', by: author, run, ...(why ? { reason: why } : {}) })
        if (e.adopt) {
          await this.stopExternal(e, run)
          await this.waitPortsFree(e.card.ports)
        } else await this.stopRun(e, run)
      }
      await this.launch(e, author)
      const s = this.state(e)
      this.tellUsers(e, author, `${e.card.name} foi reiniciado por ${authorText(author)}${over ? ', à força sobre o seu uso' : ''}${why ? `, motivo: ${quoted(why)}` : ''}; ${s.status === 'running' ? `execução nova: pid ${s.pid}` : `não subiu: ${s.error ?? statusText(s)}`}. Seu uso continua valendo`)
      return s
    })
  }

  /** Returns a note when something is worth telling (an adopted process keeps running). */
  forget(name: string, by?: ProcBy, client?: string, guard: GuardOptions = {}): Promise<string | undefined> {
    return this.locked(name, async () => {
      const e = this.require(name)
      const left = isExternalLive(e) ? replay(e.events).started?.pid : undefined
      if (isLive(e) && left === undefined) throw new ProcError('proc-not-stopped', `${name} está rodando; pare antes: tether proc stop ${name}`)
      const author = this.author(by, client)
      await this.guard(e, 'forget', author, guard)
      this.tellUsers(e, author, `${name} foi esquecido por ${authorText(author)}${guard.force ? `, motivo: ${quoted(guard.force)}` : ''}; seu uso acabou com ele`)
      try { await this.host?.request({ t: 'forget', name }) } catch { /* the host may not know it */ }
      if (e.useTimer) clearTimeout(e.useTimer)
      removeProcFiles(this.home, name)
      this.entries.delete(name)
      this.log(`proc ${name}: forgotten`)
      this.broadcast({ t: 'proc-removed', name })
      return left === undefined ? undefined : `${name} saiu do quadro; o processo externo (pid ${left}) segue rodando, intocado`
    })
  }

  /** Declares (or renews) the caller's use: default 15m, at most 60m, a purpose is required. */
  use(name: string, duration: string | undefined, purpose: string | undefined, by: ProcBy | undefined, client: string | undefined): ProcState {
    const e = this.require(name)
    let ms: number
    try { ms = parseInterval(duration ?? USE_DEFAULT, this.allowSeconds) } catch (err) {
      if (err instanceof RondaError) throw new ProcError('bad-request', `prazo inválido: ${err.message.replace(/^intervalo inválido: /, '')}`)
      throw err
    }
    if (ms > USE_MAX_MS) throw new ProcError('bad-request', `prazo longo demais: o máximo é ${formatInterval(USE_MAX_MS)}; declare de novo antes de vencer para renovar`)
    let text = flatText(purpose)
    if (!text) throw new ProcError('bad-request', `diga para quê: tether proc use ${name} [tempo] "para quê"`)
    if (text.length > PURPOSE_MAX) text = text.slice(0, PURPOSE_MAX).trimEnd() + '…'
    const author = this.author(by, client)
    const key = useKey(author)
    const now = new Date()
    const use: ProcUse = { key, by: author, until: new Date(now.getTime() + ms).toISOString(), purpose: text, declaredAt: now.toISOString() }
    e.uses = [...e.uses.filter((u) => u.key !== key), use]
    this.append(e, { kind: 'use-declared', by: author, until: use.until, purpose: text })
    this.usesChanged(e)
    return this.state(e)
  }

  /** Ends the caller's use (no use: nothing changes). */
  release(name: string, by: ProcBy | undefined, client: string | undefined): { proc: ProcState; released: boolean } {
    const e = this.require(name)
    const author = this.author(by, client)
    const key = useKey(author)
    const mine = e.uses.find((u) => u.key === key)
    if (!mine) return { proc: this.state(e), released: false }
    e.uses = e.uses.filter((u) => u !== mine)
    this.append(e, { kind: 'use-released', by: author, cause: 'released' })
    this.usesChanged(e)
    return { proc: this.state(e), released: true }
  }

  /**
   * A panel left for good (its agent exited, or it was forgotten): its uses end. Not called when the agent restarts
   * in place, nor when tetherd itself closes.
   */
  slotGone(slotId: string): void {
    const key = `slot:${slotId}`
    for (const e of this.entries.values()) {
      e.refused.delete(slotId)
      const mine = e.uses.filter((u) => u.key === key)
      if (!mine.length) continue
      e.uses = e.uses.filter((u) => u.key !== key)
      for (const u of mine) this.append(e, { kind: 'use-released', by: u.by, cause: 'panel-gone' })
      this.usesChanged(e)
    }
  }

  async hostStatus(): Promise<{ pid: number; version: string; startedAt: string; live: number } | null> {
    const host = await this.connect(false)
    if (!host) return null
    const runs = (await host.request({ t: 'list' })).runs ?? []
    return { pid: host.hello.pid, version: host.hello.version, startedAt: host.hello.startedAt, live: runs.filter((r) => !r.exit).length }
  }

  async hostStop(force: boolean, by: ProcBy | undefined, client: string | undefined): Promise<void> {
    const host = await this.connect(false)
    if (!host) return
    const runs = (await host.request({ t: 'list' })).runs ?? []
    const live = runs.filter((r) => !r.exit)
    if (live.length && !force) {
      throw new ProcError('proc-host', `o anfitrião tem ${live.length} processo(s) rodando (${live.map((r) => r.name).join(', ')}); pare-os antes ou use --force (eles param)`)
    }
    const author = this.author(by, client)
    for (const r of live) {
      const e = this.entries.get(r.name)
      if (e && isLive(e) && replay(e.events).started?.run === r.run) this.append(e, { kind: 'stop-requested', by: author, run: r.run, reason: 'anfitrião encerrado à força' })
    }
    this.hostStopping = true
    const closed = new Promise<void>((resolve) => { if (host.isClosed) resolve(); else host.once('close', () => resolve()) })
    try {
      await host.request({ t: 'shutdown', force })
    } catch (err) {
      this.hostStopping = false
      throw new ProcError('proc-host', `o anfitrião recusou: ${(err as Error).message}`)
    }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 10_000))])
  }

  // ---- internals -----------------------------------------------------------------------------

  private require(name: string): Entry {
    const e = this.entries.get(name)
    if (!e) throw new ProcError('unknown-proc', `não há processo ${name} (veja: tether proc ls)`)
    return e
  }

  private state(e: Entry): ProcState {
    const s = deriveState(e.card, e.events, { runFile: readRunFile(this.home, e.card.name), ...(e.stopping ? { stopping: true } : {}), ...(e.adopt ? { adoptedStartedAt: e.adopt.startedAt } : {}), ...(e.seenRun !== undefined ? { seenRun: e.seenRun } : {}) })
    if (e.card.ports.length) s.ports = e.card.ports.map((port) => ({ port, listening: e.listening?.get(port) ?? false }))
    if (e.memoryMB !== undefined && (s.status === 'running' || s.status === 'stopping')) s.memoryMB = e.memoryMB
    const uses = liveUses(e.uses)
    if (uses.length) s.uses = uses.map(useView)
    return s
  }

  /** Probes the declared ports (cheap: a refused localhost connect takes ~1 ms). */
  private async probe(e: Entry): Promise<void> {
    if (!e.card.ports.length) { e.listening = undefined; return }
    const results = await Promise.all(e.card.ports.map(async (p) => [p, await probePort(p)] as const))
    e.listening = new Map(results)
  }

  /** Broadcasts the state with freshly probed ports; a newer emit that finishes first wins. */
  private emit(e: Entry): void {
    const seq = ++e.emitSeq
    void this.probe(e).catch(() => undefined).then(() => {
      if (seq === e.emitSeq && this.entries.get(e.card.name) === e) this.broadcast({ t: 'proc', proc: this.state(e) })
    })
  }

  private append(e: Entry, ev: Omit<ProcEvent, 'v' | 'ts'>): void {
    const full: ProcEvent = { v: 1, ts: new Date().toISOString(), ...ev }
    try { appendProcEvent(this.home, e.card.name, full) } catch (err) { this.log(`proc ${e.card.name}: cannot append history: ${(err as Error).message}`) }
    e.events.push(full)
    this.emit(e)
    if (full.kind === 'ended' && full.cause === 'own') {
      this.tellUsers(e, undefined, `${e.card.name} encerrou sozinho às ${clockTime(full.at ?? full.ts)}${typeof full.code === 'number' ? ` com código ${full.code}` : ''}; o tether não o sobe de novo sozinho. Veja: tether proc logs ${e.card.name}`)
    } else if (full.kind === 'ended' && full.cause === 'external') {
      this.tellUsers(e, undefined, `${e.card.name}: o processo externo adotado (pid ${full.pid}) não existe mais; código de saída desconhecido; o tether não o sobe de novo sozinho (tether proc restart ${e.card.name} sobe a receita)`)
    } else if (full.kind === 'ended' && full.cause === 'host') {
      this.tellUsers(e, undefined, `${e.card.name} caiu com o anfitrião de processos às ${clockTime(full.at ?? full.ts)}; o tether não o sobe de novo sozinho. Veja: tether proc logs ${e.card.name}`)
    }
  }

  // ---- uses and notices ----------------------------------------------------------------------

  /**
   * Leaves a notice to every panel with a use in force on the process, except `except`'s own. Panels of soul get the
   * line in the file too, but nobody reads it yet: soul's client lives in another repository (soul-cli).
   */
  private tellUsers(e: Entry, except: ProcAuthor | undefined, text: string): void {
    const skip = except ? useKey(except) : undefined
    for (const u of liveUses(e.uses)) {
      if (u.key === skip || !u.key.startsWith('slot:') || !u.by.slotId) continue
      this.notice(u.by.slotId, text)
    }
  }

  private notice(slotId: string, text: string): void {
    try { leaveNotice(this.home, slotId, NOTICE_PREFIX + text) } catch (err) { this.log(`notice to ${slotId} failed: ${(err as Error).message}`) }
  }

  /**
   * The uses of others decide an act: none → go; `force` → go and record over whose use; `waitMs` → hold the act
   * until they end (one notice at the start of the wait); else refuse with the board. Returns the uses forced over.
   */
  private async guard(e: Entry, action: GuardedAction, author: ProcAuthor, opts: GuardOptions): Promise<UseView[] | undefined> {
    const key = useKey(author)
    const others = othersUses(e.uses, key)
    if (!others.length) return undefined
    const views = others.map(useView)
    if (author.slotId) e.refused.delete(author.slotId)
    if (opts.force !== undefined) {
      this.append(e, { kind: 'forced', by: author, action, reason: opts.force, over: views })
      return views
    }
    const wanted = (u: ProcUse): string => `${authorText(author)} quer ${actionText(action)} ${e.card.name}; seu uso vai até ${clockTime(u.until)}; libere antes se puder (tether proc release ${e.card.name})`
    for (const u of others) if (u.key.startsWith('slot:') && u.by.slotId) this.notice(u.by.slotId, wanted(u))
    if (opts.waitMs !== undefined) {
      const t0 = Date.now()
      if (await this.waitFree(e, key, opts.waitMs)) return undefined
      return this.refuse(e, action, author, othersUses(e.uses, key).map(useView), Date.now() - t0)
    }
    return this.refuse(e, action, author, views)
  }

  private refuse(e: Entry, action: GuardedAction, author: ProcAuthor, uses: UseView[], waitedMs?: number): never {
    this.append(e, { kind: 'refused-in-use', by: author, action, uses })
    if ((author.kind === 'agent' || author.kind === 'shell') && author.slotId) e.refused.set(author.slotId, Date.now())
    throw new ProcError('proc-in-use', inUseBoard(e.card.name, action, uses, waitedMs))
  }

  /** Resolves true once no use of others is in force, false when `ms` runs out first. */
  private async waitFree(e: Entry, key: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    for (;;) {
      if (!othersUses(e.uses, key).length) return true
      const left = deadline - Date.now()
      if (left <= 0 || this.closing) return false
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); e.waiters.delete(done); resolve() }
        const timer = setTimeout(done, left)
        e.waiters.add(done)
      })
    }
  }

  /** After any change of the uses: persist, re-arm the expiry timer, wake the waiting acts, tell refused panels. */
  private usesChanged(e: Entry): void {
    try { writeUses(this.home, e.card.name, e.uses) } catch (err) { this.log(`proc ${e.card.name}: cannot write uses: ${(err as Error).message}`) }
    if (e.useTimer) clearTimeout(e.useTimer)
    e.useTimer = undefined
    if (e.uses.length && !this.closing) {
      const next = Math.min(...e.uses.map((u) => Date.parse(u.until)))
      e.useTimer = setTimeout(() => this.expireUses(e), Math.max(0, next - Date.now()) + 50)
      e.useTimer.unref()
    }
    for (const w of [...e.waiters]) w()
    const now = Date.now()
    for (const [slotId, at] of e.refused) {
      if (now - at > REFUSED_KEEP_MS) { e.refused.delete(slotId); continue }
      if (othersUses(e.uses, `slot:${slotId}`, now).length) continue
      e.refused.delete(slotId)
      this.notice(slotId, `${e.card.name} ficou livre: ninguém mais declara uso dele`)
    }
    this.emit(e)
  }

  /** Uses past their time end as `use-expired` at that time; their panels hear it. */
  private expireUses(e: Entry): void {
    if (this.entries.get(e.card.name) !== e) return
    const now = Date.now()
    const over = e.uses.filter((u) => Date.parse(u.until) <= now)
    e.uses = e.uses.filter((u) => !over.includes(u))
    for (const u of over) {
      this.append(e, { kind: 'use-expired', by: u.by, until: u.until })
      if (u.key.startsWith('slot:') && u.by.slotId) {
        this.notice(u.by.slotId, `seu uso de ${e.card.name} venceu às ${clockTime(u.until)} (para quê: ${quoted(u.purpose)}); se ainda precisa, declare de novo: tether proc use ${e.card.name} 15m "para quê"`)
      }
    }
    if (over.length || e.uses.length) this.usesChanged(e)
  }

  // ---- ports ---------------------------------------------------------------------------------

  /** Why the declared ports cannot be taken now: another live managed process declares one, or something listens. */
  private async portConflict(name: string, ports: number[]): Promise<string | undefined> {
    for (const port of ports) {
      const other = [...this.entries.values()].find((x) => x.card.name !== name && isLive(x) && x.card.ports.includes(port))
      if (other) return `a porta ${port} é declarada por ${other.card.name}, que está rodando (iniciado por ${authorText(replay(other.events).started?.by)})`
    }
    for (const port of ports) {
      if (!(await probePort(port))) continue
      const row = (await this.portRows([])).find((r) => r.port === port)
      return `a porta ${port} já está ocupada${row?.listening ? ` por ${ownerText(row)}` : ''}`
    }
    return undefined
  }

  /** Listeners + process table + managed trees → the rows (owner lookup fails soft: the row says "?"). */
  private async portRows(declared: { name: string; status: ProcState['status']; ports: number[] }[]): Promise<PortRow[]> {
    const [listeners, table] = await Promise.all([
      listListeners().catch((err) => { this.log(`ports: listener table failed: ${(err as Error).message}`); return [] }),
      sampleProcessTable().catch((err) => { this.log(`ports: process table failed: ${(err as Error).message}`); return [] }),
    ])
    return buildPortRows(listeners, table, treeOwners(table, this.liveRoots()), declared)
  }

  private runningMessage(e: Entry): string {
    const s = this.state(e)
    if (s.external) return `${e.card.name} roda fora do tether (pid ${s.pid ?? '?'}, adotado por ${authorText(s.startedBy)}); use restart para o tether assumir: tether proc restart ${e.card.name}`
    const cmd = [e.card.command, ...e.card.args].join(' ')
    return `${e.card.name} já está rodando: pid ${s.pid ?? '?'}, iniciado por ${authorText(s.startedBy)} ${relativeTime(s.startedAt)} (${cmd}, em ${e.card.cwd}). ` +
      `Para usar outro comando, pare antes (tether proc stop ${e.card.name}) ou escolha outro nome; para recomeçar com a mesma receita: tether proc restart ${e.card.name}`
  }

  /** One act at a time per name (a second start waits and then sees the first one running). */
  private async locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.then(() => {}, () => {})
    this.locks.set(name, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(name) === tail) this.locks.delete(name)
    }
  }

  private async launch(e: Entry, author: ProcAuthor): Promise<void> {
    const name = e.card.name
    const run = replay(e.events).lastRun + 1
    let plan
    try {
      plan = planFor(e.card, this.env)
    } catch (err) {
      if (!(err instanceof LaunchError)) throw err
      this.append(e, { kind: 'start-failed', by: author, run, message: err.message })
      return
    }
    const host = await this.connect(true)
    if (!host) throw new ProcError('proc-host', 'o anfitrião de processos não está disponível (veja tether-procd.log na pasta do tether)')
    let reply
    try {
      reply = await host.request({ t: 'spawn', name, run, plan, cols: PLAN_COLS, rows: PLAN_ROWS, home: this.home })
    } catch (err) {
      if (err instanceof HostRequestError && err.code === 'spawn-failed') {
        this.append(e, { kind: 'start-failed', by: author, run, message: `não consegui iniciar ${plan.command}: ${err.message}` })
        return
      }
      if (err instanceof HostRequestError && err.code === 'already-running') throw new ProcError('proc-running', err.message)
      throw new ProcError('proc-host', `o anfitrião falhou ao iniciar: ${(err as Error).message}`)
    }
    e.memoryMB = undefined
    this.append(e, { kind: 'started', by: author, run, pid: reply.pid! })
    this.log(`proc ${name}: run ${run} started pid ${reply.pid} by ${authorText(author)}`)
    this.sampleSoon?.()
    const early = e.earlyExit
    if (early?.run === run) {
      e.earlyExit = undefined
      this.recordEnd(e, run, early.exit)
    }
  }

  /**
   * Brings a process that already runs outside tether into the board. Only with the complete recipe (so tether can
   * restart it). The process is identified by pid + creation time and left running; nothing here looks it up by name.
   */
  adoptExternal(name: string, pid: number, recipe: ProcRecipe | undefined, by: ProcBy | undefined, client: string | undefined): Promise<ProcState> {
    checkName(name)
    return this.locked(name, async () => {
      const author = this.author(by, client)
      if (this.entries.has(name)) throw new ProcError('bad-adopt', `já existe um processo ${name} no quadro; escolha outro nome`)
      if (!recipe || typeof recipe.command !== 'string' || !recipe.command.trim()) {
        throw new ProcError('bad-adopt', 'a adoção exige a receita completa (comando, pasta e variáveis) para o tether poder reiniciar o processo: tether proc adopt <nome> --pid N [opções] -- <comando…>')
      }
      const fields = normalizeRecipe(recipe)
      if (!Number.isInteger(pid) || pid <= 0 || !pidExists(pid)) throw new ProcError('bad-adopt', `o pid ${pid} não existe; confira o processo e tente de novo`)
      await this.refuseUnsafe(pid)
      const clash = [...this.entries.values()].find((x) => isLive(x) && x.card.ports.some((p) => fields.ports.includes(p)))
      if (clash) throw new ProcError('bad-adopt', `a porta ${fields.ports.find((p) => clash.card.ports.includes(p))} já é declarada por ${clash.card.name}, que está rodando; use outra porta ou pare ${clash.card.name} antes`)
      const startedAt = await processStartTime(pid)
      if (startedAt === undefined) throw new ProcError('bad-adopt', `não consegui ler a identidade do pid ${pid} (hora de criação); sem ela não adoto`)
      const card: ProcCard = { v: 1, name, ...fields, registeredBy: author, createdAt: new Date().toISOString() }
      const adopt: AdoptFile = { v: 1, pid, startedAt, adoptedAt: new Date().toISOString() }
      writeCard(this.home, card)
      writeAdopt(this.home, name, adopt)
      const e = newEntry(card, [])
      e.adopt = adopt
      this.entries.set(name, e)
      this.append(e, { kind: 'registered', by: author })
      this.append(e, { kind: 'adopted', by: author, run: 1, pid })
      this.log(`proc ${name}: adopted external pid ${pid} by ${authorText(author)}`)
      this.sampleSoon?.()
      return this.state(e)
    })
  }

  /** The reasons not to adopt `pid`, with what to do; nothing is touched. */
  private async refuseUnsafe(pid: number): Promise<void> {
    const table = await sampleProcessTable().catch((err) => { throw new ProcError('bad-adopt', `não consegui ler a tabela de processos (${(err as Error).message}); tente de novo`) })
    const guarded = new Map<number, string>([[process.pid, 'o tetherd']])
    if (this.host && !this.host.isClosed) guarded.set(this.host.hello.pid, 'o anfitrião de processos')
    for (const p of this.protectedPids?.() ?? []) guarded.set(p, 'o agente ou shell de um painel deste tether')
    const tree = (rootPid: number): Set<number> => {
      const seen = new Set<number>()
      const stack = [rootPid]
      while (stack.length) {
        const x = stack.pop()!
        if (seen.has(x)) continue
        seen.add(x)
        for (const r of table) if (r.ppid === x && r.pid !== x) stack.push(r.pid)
      }
      return seen
    }
    const mine = tree(pid)
    for (const [p, what] of guarded) {
      if (!mine.has(p)) continue
      throw new ProcError('bad-adopt', p === pid
        ? `o pid ${pid} é ${what}; adote o processo de fundo que você quer gerir, não ele`
        : `a árvore do pid ${pid} contém ${what} (pid ${p}); parar o adotado mataria o tether. Adote o processo filho que você quer, não o pai`)
    }
    for (const r of this.liveRoots()) {
      if (tree(r.pid).has(pid)) throw new ProcError('bad-adopt', `o pid ${pid} já está na árvore de ${r.name} (pid ${r.pid}), que o tether gere; não precisa adotar`)
      if (mine.has(r.pid)) throw new ProcError('bad-adopt', `a árvore do pid ${pid} contém ${r.name} (pid ${r.pid}), que já está no quadro; parar o adotado mataria os dois`)
    }
  }

  /**
   * An adopted process that is not the recorded one anymore (gone, or its pid was reused) ends as `external`: tether
   * never kills it then. A name with an act in progress is skipped (its own act decides), except at boot.
   */
  private async checkExternal(e: Entry, boot = false): Promise<void> {
    const ad = e.adopt
    if (!ad && !(boot && isExternalLive(e))) return
    if (!boot && this.locks.has(e.card.name)) return
    if (ad && await isSameProcess(ad.pid, ad.startedAt)) return
    if (!boot && (this.locks.has(e.card.name) || e.adopt !== ad)) return
    this.endExternal(e)
  }

  private endExternal(e: Entry): void {
    const r = replay(e.events)
    if (!r.started || r.ended) return
    const pid = e.adopt?.pid ?? r.started.pid
    e.adopt = undefined
    removeAdopt(this.home, e.card.name)
    this.append(e, { kind: 'ended', run: r.started.run!, ...(pid !== undefined ? { pid } : {}), at: new Date().toISOString(), cause: 'external' })
    this.log(`proc ${e.card.name}: adopted pid ${pid} is gone; ended (external)`)
  }

  /** Stops the adopted process by pid, only while it is still the recorded one; no Ctrl+C (there is no terminal). */
  private async stopExternal(e: Entry, run: number): Promise<void> {
    const ad = e.adopt!
    e.stopping = true
    this.emit(e)
    try {
      if (await isSameProcess(ad.pid, ad.startedAt)) {
        await killTree(ad.pid)
        const deadline = Date.now() + EXTERNAL_GONE_MS
        while (pidExists(ad.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
        e.adopt = undefined
        removeAdopt(this.home, e.card.name)
        this.append(e, { kind: 'ended', run, pid: ad.pid, at: new Date().toISOString(), cause: 'requested' })
      } else {
        this.endExternal(e)
      }
    } finally {
      e.stopping = false
      this.emit(e)
    }
  }

  /** Waits (with a ceiling) for the declared ports to be released after an adopted process was killed. */
  private async waitPortsFree(ports: number[]): Promise<void> {
    const deadline = Date.now() + EXTERNAL_GONE_MS
    while (Date.now() < deadline) {
      const busy = await Promise.all(ports.map((p) => probePort(p)))
      if (!busy.some(Boolean)) return
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  private async stopRun(e: Entry, run: number): Promise<void> {
    const host = await this.connect(false)
    if (!host) throw new ProcError('proc-host', `o anfitrião não responde; ${e.card.name} provavelmente caiu com ele (veja tether proc ls)`)
    e.stopping = true
    this.emit(e)
    try {
      const reply = await host.request({ t: 'stop', name: e.card.name, graceMs: e.card.stopGraceMs })
      if (reply.exit) this.recordEnd(e, run, reply.exit)
    } catch (err) {
      throw new ProcError('proc-host', `o anfitrião falhou ao parar ${e.card.name}: ${(err as Error).message}`)
    } finally {
      e.stopping = false
      this.emit(e)
    }
  }

  /** The run ended (host event, stop reply, or run.json): `requested` when a stop/restart was pending, else `own`. */
  private recordEnd(e: Entry, run: number, exit: RunExit): void {
    if (hasEnded(e.events, run)) return
    if (replay(e.events).started?.run !== run) {
      e.earlyExit = { run, exit }
      return
    }
    const cause = pendingRequest(e.events, run) ? 'requested' : 'own'
    this.append(e, { kind: 'ended', run, code: exit.code, at: exit.at, cause })
    this.log(`proc ${e.card.name}: run ${run} ended (${cause}, code ${exit.code}, at ${exit.at})`)
  }

  private onExit(name: string, run: number, exit: RunExit): void {
    const e = this.entries.get(name)
    if (e) this.recordEnd(e, run, exit)
  }

  // ---- host connection -----------------------------------------------------------------------

  /** The connected host; or a new connection (launching one when `launch`). Undefined when none answers (and !launch). */
  private async connect(launch: boolean): Promise<HostClient | undefined> {
    if (this.host && !this.host.isClosed) return this.host
    if (this.connecting && !launch) return this.connecting
    const attempt = (async () => {
      try {
        const c = await this.connectHost(launch)
        this.adopt(c)
        return c
      } catch (err) {
        if (err instanceof HostRequestError && err.code === 'version') {
          throw new ProcError('proc-host', `${err.message}. Pare o anfitrião antigo (tether proc host stop, com --force se houver processos) e tente de novo`)
        }
        if (launch) throw new ProcError('proc-host', `não consegui falar com o anfitrião de processos: ${(err as Error).message}`)
        return undefined
      }
    })()
    this.connecting = attempt
    try {
      return await attempt
    } finally {
      if (this.connecting === attempt) this.connecting = undefined
    }
  }

  private adopt(c: HostClient): void {
    this.host = c
    this.hostStopping = false
    c.on('exit', (name, run, exit) => this.onExit(name, run, exit))
    c.on('data', (name, data) => { if (this.watched.has(name)) this.onData?.(name, data) })
    c.on('close', () => void this.onHostClose(c))
    for (const name of this.watched) c.request({ t: 'attach', name }).catch(() => { /* no run of it in this host */ })
    this.log(`proc host: connected to pid ${c.hello.pid} (${c.hello.version})`)
  }

  private async retryConnect(windowMs: number): Promise<HostClient | undefined> {
    const deadline = Date.now() + windowMs
    for (;;) {
      try {
        const c = await this.connect(false)
        if (c) return c
      } catch (err) {
        this.log(`proc host: ${(err as Error).message}`)
        return undefined
      }
      if (Date.now() >= deadline || this.closing) return undefined
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  private async onHostClose(c: HostClient): Promise<void> {
    if (this.host !== c || this.closing) return
    this.host = undefined
    const expected = this.hostStopping
    this.log(`proc host: connection to pid ${c.hello.pid} closed${expected ? ' (shutdown asked)' : ''}`)
    const again = expected ? undefined : await this.retryConnect(this.reconnectMs)
    if (this.closing) return
    try {
      await this.reconcile(again ? (await again.request({ t: 'list' })).runs ?? [] : [], again !== undefined)
    } catch (err) {
      this.log(`proc host: reconcile after close failed: ${(err as Error).message}`)
    }
  }

  /**
   * For every process whose latest run has no `ended`: run.json with an exit → `ended` at that real time;
   * listed alive by the host → running; otherwise the host that ran it is gone, and so is the process (it dies
   * with its host): `ended` cause host. A host that still exists (pid + creation time) but does not answer is
   * left alone (no verdict on a guess). A survivor matching pid + creation time is killed with its tree.
   */
  private async reconcile(runs: HostRun[], hostAnswered: boolean): Promise<void> {
    for (const e of this.entries.values()) {
      const r = replay(e.events)
      if (!r.started || r.ended) continue
      if (r.started.kind === 'adopted') continue
      const run = r.started.run!
      const name = e.card.name
      const file = readRunFile(this.home, name)
      if (file?.run === run && file.exit) { this.recordEnd(e, run, file.exit); continue }
      const listed = runs.find((x) => x.name === name && x.run === run)
      if (listed?.exit) { this.recordEnd(e, run, listed.exit); continue }
      if (listed) continue
      if (!hostAnswered && file && await isSameProcess(file.hostPid, file.hostStartedAt)) {
        this.log(`proc ${name}: host pid ${file.hostPid} is alive but does not answer; leaving run ${run} as running`)
        continue
      }
      if (file?.run === run && await isSameProcess(file.pid, file.startedAt)) {
        await killTree(file.pid)
        this.log(`proc ${name}: run ${run} pid ${file.pid} outlived its host; killed by identity`)
      }
      if (hasEnded(e.events, run)) continue
      this.append(e, { kind: 'ended', run, at: new Date().toISOString(), cause: 'host' })
      this.log(`proc ${name}: run ${run} lost with its host`)
    }
  }
}

function newEntry(card: ProcCard, events: ProcEvent[]): Entry {
  return { card, events, uses: [], waiters: new Set(), refused: new Map(), emitSeq: 0 }
}

/** Live and adopted from outside (no host run behind it). */
function isExternalLive(e: Entry): boolean {
  const r = replay(e.events)
  return r.started?.kind === 'adopted' && r.ended === undefined
}

function isLive(e: Entry): boolean {
  const r = replay(e.events)
  return r.started !== undefined && r.ended === undefined && !r.failed
}

/** The OS user, for authors of requests that carry none. */
export function osUser(): string | undefined {
  try { return userInfo().username } catch { return undefined }
}
