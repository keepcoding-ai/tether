// tetherd's side of background processes: the cards in memory, the connection to tether-procd, reconciliation
// with what the host and the run files say, and the acts (start, stop, restart, forget). tetherd is the only writer
// of the history. It never restarts anything by itself, and kills only by pid + creation time (a process that the
// host lost but somehow survived), never by name.
import { userInfo } from 'node:os'
import { isSameProcess } from '../core/liveness.ts'
import { HostClient, HostRequestError } from '../procd/client.ts'
import { readRunFile, type HostRun, type RunExit } from '../procd/protocol.ts'
import { relativeTime } from '../cli/format.ts'
import { LaunchError, planFor } from './proc-launch.ts'
import {
  appendProcEvent,
  authorText,
  checkName,
  deriveState,
  hasEnded,
  INFO_EVENTS,
  listCards,
  normalizeRecipe,
  pendingRequest,
  ProcError,
  readProcEvents,
  recipeDiff,
  recipeOf,
  removeProcFiles,
  replay,
  writeCard,
  type ProcAuthor,
  type ProcBy,
  type ProcCard,
  type ProcEvent,
  type ProcRecipe,
  type ProcState,
} from './procs.ts'
import type { DaemonMessage } from './protocol.ts'
import { killTree } from './pty.ts'

/** How long a lost host connection is retried (without launching) before its processes count as lost with it. */
export const HOST_RECONNECT_MS = 3_000
const PLAN_COLS = 120
const PLAN_ROWS = 30

export interface ProcManagerOptions {
  home: string
  log: (msg: string) => void
  broadcast: (msg: DaemonMessage) => void
  /** The portrait of whoever asks (tetherd knows its slots). */
  author: (by: ProcBy | undefined, client: string | undefined) => ProcAuthor
  /** Connects to the host; `launch` = start one when nothing answers (only a start does). */
  connectHost: (launch: boolean) => Promise<HostClient>
  /** Base environment of the processes (default: tetherd's). */
  env?: NodeJS.ProcessEnv
  reconnectMs?: number
}

interface Entry {
  card: ProcCard
  events: ProcEvent[]
  stopping?: boolean
  /** The run someone looked at (clears attention). */
  seenRun?: number
  /** An exit the host announced before the spawn reply came back (a process that ends at once). */
  earlyExit?: { run: number; exit: RunExit }
}

export class ProcManager {
  private readonly home: string
  private readonly log: (msg: string) => void
  private readonly broadcast: (msg: DaemonMessage) => void
  private readonly author: ProcManagerOptions['author']
  private readonly connectHost: ProcManagerOptions['connectHost']
  private readonly env: NodeJS.ProcessEnv
  private readonly reconnectMs: number
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
  }

  /** Loads the cards; with any, only TRIES the host (never launches it) and reconciles. */
  async init(): Promise<void> {
    for (const card of listCards(this.home)) this.entries.set(card.name, { card, events: readProcEvents(this.home, card.name) })
    if (!this.entries.size) return
    const host = await this.retryConnect(1_000)
    await this.reconcile(host ? (await host.request({ t: 'list' })).runs ?? [] : [], host !== undefined)
  }

  close(): void {
    this.closing = true
    this.host?.close()
    this.host = undefined
  }

  list(): ProcState[] {
    return [...this.entries.values()].sort((a, b) => a.card.name.localeCompare(b.card.name)).map((e) => this.state(e))
  }

  /** Live processes (the CLI says how many keep running when tetherd restarts). */
  liveCount(): number {
    return [...this.entries.values()].filter(isLive).length
  }

  info(name: string): { proc: ProcState; events: ProcEvent[] } {
    const e = this.require(name)
    return { proc: this.state(e), events: e.events.slice(-INFO_EVENTS) }
  }

  seen(name: string): void {
    const e = this.require(name)
    const run = replay(e.events).started?.run
    if (run !== undefined && e.seenRun !== run) {
      e.seenRun = run
      this.emit(e)
    }
  }

  start(name: string, recipe: ProcRecipe | undefined, by: ProcBy | undefined, client: string | undefined): Promise<ProcState> {
    checkName(name)
    return this.locked(name, async () => {
      const author = this.author(by, client)
      let e = this.entries.get(name)
      if (e && isLive(e)) throw new ProcError('proc-running', this.runningMessage(e))
      if (!e && !recipe) throw new ProcError('unknown-proc', `não há processo ${name}; para registrar, passe o comando: tether proc start ${name} -- <comando…>`)
      if (recipe) {
        const fields = normalizeRecipe(recipe)
        if (!e) {
          const card: ProcCard = { v: 1, name, ...fields, registeredBy: author, createdAt: new Date().toISOString() }
          writeCard(this.home, card)
          e = { card, events: [] }
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

  stop(name: string, reason: string | undefined, by: ProcBy | undefined, client: string | undefined): Promise<ProcState> {
    return this.locked(name, async () => {
      const e = this.require(name)
      if (!isLive(e)) return this.state(e)
      const run = replay(e.events).started!.run!
      this.append(e, { kind: 'stop-requested', by: this.author(by, client), run, ...(reason ? { reason } : {}) })
      await this.stopRun(e, run)
      return this.state(e)
    })
  }

  restart(name: string, reason: string | undefined, by: ProcBy | undefined, client: string | undefined): Promise<ProcState> {
    return this.locked(name, async () => {
      const e = this.require(name)
      const author = this.author(by, client)
      if (isLive(e)) {
        const run = replay(e.events).started!.run!
        this.append(e, { kind: 'restart-requested', by: author, run, ...(reason ? { reason } : {}) })
        await this.stopRun(e, run)
      }
      await this.launch(e, author)
      return this.state(e)
    })
  }

  forget(name: string): Promise<void> {
    return this.locked(name, async () => {
      const e = this.require(name)
      if (isLive(e)) throw new ProcError('proc-not-stopped', `${name} está rodando; pare antes: tether proc stop ${name}`)
      try { await this.host?.request({ t: 'forget', name }) } catch { /* the host may not know it */ }
      removeProcFiles(this.home, name)
      this.entries.delete(name)
      this.log(`proc ${name}: forgotten`)
      this.broadcast({ t: 'proc-removed', name })
    })
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
    return deriveState(e.card, e.events, { runFile: readRunFile(this.home, e.card.name), ...(e.stopping ? { stopping: true } : {}), ...(e.seenRun !== undefined ? { seenRun: e.seenRun } : {}) })
  }

  private emit(e: Entry): void {
    this.broadcast({ t: 'proc', proc: this.state(e) })
  }

  private append(e: Entry, ev: Omit<ProcEvent, 'v' | 'ts'>): void {
    const full: ProcEvent = { v: 1, ts: new Date().toISOString(), ...ev }
    try { appendProcEvent(this.home, e.card.name, full) } catch (err) { this.log(`proc ${e.card.name}: cannot append history: ${(err as Error).message}`) }
    e.events.push(full)
    this.emit(e)
  }

  private runningMessage(e: Entry): string {
    const s = this.state(e)
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
    this.append(e, { kind: 'started', by: author, run, pid: reply.pid! })
    this.log(`proc ${name}: run ${run} started pid ${reply.pid} by ${authorText(author)}`)
    const early = e.earlyExit
    if (early?.run === run) {
      e.earlyExit = undefined
      this.recordEnd(e, run, early.exit)
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
    c.on('close', () => void this.onHostClose(c))
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

function isLive(e: Entry): boolean {
  const r = replay(e.events)
  return r.started !== undefined && r.ended === undefined && !r.failed
}

/** The OS user, for authors of requests that carry none. */
export function osUser(): string | undefined {
  try { return userInfo().username } catch { return undefined }
}
