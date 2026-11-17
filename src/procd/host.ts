// tether-procd's core, startable in process (tests): owns one PTY per running background process, keeps its raw
// output (Scrollback) and a clean log on disk, records pid / start time / exit in <home>/procs/<name>.run.json and
// tells its clients. It decides nothing: tetherd sends ready plans and asks to stop. Small on purpose: if this
// process dies, every process it hosts dies with it (ConPTY closes with its owner).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { processStartTime } from '../core/liveness.ts'
import { procLogPath, procLogsDir } from '../core/paths.ts'
import { encode, guessId, LineParser } from '../daemon/ndjson.ts'
import { killTree, spawnPty, type PtyHandle } from '../daemon/pty.ts'
import { Scrollback } from '../daemon/scrollback.ts'
import { makeLineCleaner, type LineCleaner } from './log-clean.ts'
import {
  PROCD_PROTOCOL_VERSION,
  PROCD_VERSION,
  writeRunFile,
  type HostErrorCode,
  type HostCap,
  type HostEvent,
  type HostNotice,
  type HostReply,
  type HostRequest,
  type HostRun,
  type RunExit,
} from './protocol.ts'

/** Without a live process for this long the host leaves (TETHER_PROCD_IDLE_MS overrides). */
export const PROCD_IDLE_MS = 5 * 60_000
/** A log file above this keeps its newer half. */
export const LOG_MAX_BYTES = 20 * 1024 * 1024
/** Logs of this many runs are kept per process. */
export const LOG_RUNS_KEPT = 5
/** The last line of output that did not end in a newline is written after this much quiet. */
const LOG_IDLE_FLUSH_MS = 1_000
/** After `release`, the run is declared ended if the pty did not report an exit by itself. */
const RELEASE_EXIT_MS = 1_500
const SCROLLBACK_CHARS = 256 * 1024

export interface HostOptions {
  home: string
  pipe: string
  log?: (msg: string) => void
  idleMs?: number
  /** Called when the host should leave: idle, or a `shutdown` was honoured. */
  onExit?: (reason: string) => void
  logMaxBytes?: number
  /** Default true. False: no clean log, no run.json, no process start-time lookup (terminal panes). */
  persist?: boolean
}

const CAPS: HostCap[] = ['write', 'offsets', 'lag']

export class HostError extends Error {
  readonly code: HostErrorCode
  constructor(code: HostErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** One run's clean log: <home>/procs/<name>/logs/run-<n>.log, ISO UTC time + space + text per line. */
class RunLog {
  private fd: number | undefined
  private bytes = 0
  private readonly cleaner: LineCleaner = makeLineCleaner()
  private idle: NodeJS.Timeout | undefined
  private readonly path: string
  private readonly maxBytes: number
  private readonly log: (msg: string) => void

  constructor(home: string, name: string, run: number, maxBytes: number, log: (msg: string) => void) {
    this.path = procLogPath(home, name, run)
    this.maxBytes = maxBytes
    this.log = log
    const dir = procLogsDir(home, name)
    mkdirSync(dir, { recursive: true })
    // Only the newest LOG_RUNS_KEPT runs keep their log (this one included).
    for (const f of readdirSync(dir)) {
      const m = /^run-(\d+)\.log$/.exec(f)
      if (m && Number(m[1]) <= run - LOG_RUNS_KEPT) rmSync(`${dir}/${f}`, { force: true })
    }
    this.fd = openSync(this.path, 'a')
  }

  push(data: string): void {
    this.write(this.cleaner.push(data))
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.write(this.cleaner.flush()), LOG_IDLE_FLUSH_MS)
    this.idle.unref()
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle)
    this.write(this.cleaner.flush())
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
  }

  private write(lines: string[]): void {
    if (!lines.length || this.fd === undefined) return
    const ts = new Date().toISOString()
    const text = lines.map((l) => `${ts} ${l}\n`).join('')
    try {
      this.bytes += writeSync(this.fd, text)
      if (this.bytes > this.maxBytes) this.halve()
    } catch (e) {
      this.log(`log ${this.path}: ${(e as Error).message}`)
    }
  }

  /** Keeps the newer half, cut at a line boundary. */
  private halve(): void {
    closeSync(this.fd!)
    const all = readFileSync(this.path, 'utf8')
    let keep = all.slice(Math.floor(all.length / 2))
    const nl = keep.indexOf('\n')
    keep = nl >= 0 ? keep.slice(nl + 1) : keep
    writeFileSync(this.path, keep)
    this.bytes = Buffer.byteLength(keep)
    this.fd = openSync(this.path, 'a')
  }
}

interface Run extends HostRun {
  pty: PtyHandle
  scrollback: Scrollback
  log: RunLog | undefined
  /** Ends the run once (the pty's exit, or the release fallback). */
  finish: (code: number) => Promise<void>
  finished?: boolean
  attached: Set<Socket>
  /** Resolves with the exit once the process ended and run.json says so. */
  ended: Promise<RunExit>
  stopping?: Promise<RunExit>
}

export class ProcHost {
  readonly pid = process.pid
  startedAt = new Date().toISOString()
  private readonly home: string
  private readonly pipe: string
  private readonly log: (msg: string) => void
  private readonly idleMs: number
  private readonly onExit: (reason: string) => void
  private readonly logMaxBytes: number
  private readonly persist: boolean
  private readonly server: Server
  private readonly clients = new Set<Socket>()
  private readonly runs = new Map<string, Run>()
  private idleTimer: NodeJS.Timeout | undefined
  private closing = false

  constructor(opts: HostOptions) {
    this.home = opts.home
    this.pipe = opts.pipe
    this.log = opts.log ?? (() => {})
    this.idleMs = opts.idleMs ?? PROCD_IDLE_MS
    this.onExit = opts.onExit ?? (() => {})
    this.logMaxBytes = opts.logMaxBytes ?? LOG_MAX_BYTES
    this.persist = opts.persist ?? true
    this.server = createServer((socket) => this.onConnection(socket))
  }

  async listen(): Promise<void> {
    if (this.persist) this.startedAt = (await processStartTime(process.pid)) ?? this.startedAt
    if (process.platform !== 'win32' && existsSync(this.pipe)) rmSync(this.pipe, { force: true })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.pipe, () => { this.server.off('error', reject); resolve() })
    })
    this.server.on('error', (e) => this.log(`server error: ${e.message}`))
    this.armIdle()
    this.log(`listening on ${this.pipe}`)
  }

  live(): HostRun[] {
    return [...this.runs.values()].filter((r) => !r.exit).map(publicRun)
  }

  /** Kills every live process tree, drops the clients and closes the server. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    await Promise.all([...this.runs.values()].filter((r) => !r.exit).map((r) => r.pty.kill()))
    for (const c of this.clients) c.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.log('closed')
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.closing || this.live().length) return
    this.idleTimer = setTimeout(() => {
      if (!this.live().length) this.onExit(`idle for ${this.idleMs} ms`)
    }, this.idleMs)
    this.idleTimer.unref()
  }

  // ---- connections ---------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    const parser = new LineParser()
    this.clients.add(socket)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const line of parser.push(chunk)) void this.onLine(socket, line.value, line.raw)
    })
    socket.on('error', () => { /* surfaces as close */ })
    socket.on('close', () => {
      this.clients.delete(socket)
      for (const r of this.runs.values()) r.attached.delete(socket)
    })
  }

  private send(socket: Socket, msg: HostReply | HostEvent): void {
    if (!socket.destroyed && socket.writable) socket.write(encode(msg))
  }

  private async onLine(socket: Socket, value: Record<string, unknown> | undefined, raw: string): Promise<void> {
    if (!value) {
      const id = guessId(raw)
      if (id !== undefined) this.send(socket, { t: 'error', id, code: 'bad-request', message: 'linha não é JSON válido' })
      return
    }
    if (value.t === 'write') { this.onWrite(value as unknown as HostNotice); return }
    const req = value as unknown as HostRequest
    if (typeof req.id !== 'number') return
    let reply: HostReply
    try {
      reply = await this.handle(socket, req)
    } catch (e) {
      const err = e instanceof HostError ? e : new HostError('bad-request', (e as Error).message)
      reply = { t: 'error', id: req.id, code: err.code, message: err.message }
    }
    this.send(socket, reply)
  }

  private onWrite(n: HostNotice): void {
    const r = typeof n.name === 'string' ? this.runs.get(n.name) : undefined
    if (r && !r.exit && typeof n.data === 'string') r.pty.write(n.data)
  }

  private run(name: unknown): Run {
    const r = typeof name === 'string' ? this.runs.get(name) : undefined
    if (!r) throw new HostError('unknown-run', `nenhuma execução de ${String(name)} neste anfitrião`)
    return r
  }

  private async handle(socket: Socket, req: HostRequest): Promise<HostReply> {
    const { id } = req
    switch (req.t) {
      case 'hello':
        if (req.v !== PROCD_PROTOCOL_VERSION) throw new HostError('version', `anfitrião fala a versão ${PROCD_PROTOCOL_VERSION} do protocolo, o cliente a ${String(req.v)}`)
        return { t: 'ok', id, hello: { v: PROCD_PROTOCOL_VERSION, caps: CAPS, pid: this.pid, version: PROCD_VERSION, startedAt: this.startedAt } }
      case 'spawn': {
        const started = await this.spawn(req)
        return { t: 'ok', id, pid: started.pid, startedAt: started.startedAt }
      }
      case 'stop':
        return { t: 'ok', id, exit: await this.stop(this.run(req.name), req.graceMs) }
      case 'list':
        return { t: 'ok', id, runs: [...this.runs.values()].map(publicRun) }
      case 'attach': {
        const r = this.run(req.name)
        r.attached.add(socket)
        const epoch = r.spawnedAt
        const sb = req.from !== undefined && req.epoch === epoch ? r.scrollback.since(req.from) : { data: r.scrollback.text(), off: r.scrollback.end }
        return { t: 'ok', id, scrollback: sb.data, off: sb.off, epoch }
      }
      case 'release': {
        const r = this.run(req.name)
        r.pty.release()
        // A released console may never report an exit: end the run ourselves after a short wait.
        if (!r.exit) setTimeout(() => void r.finish(-1), RELEASE_EXIT_MS).unref()
        return { t: 'ok', id }
      }
      case 'detach':
        this.run(req.name).attached.delete(socket)
        return { t: 'ok', id }
      case 'resize':
        this.run(req.name).pty.resize(req.cols, req.rows)
        return { t: 'ok', id }
      case 'forget': {
        const r = this.runs.get(req.name)
        if (r && !r.exit) throw new HostError('already-running', `${req.name} ainda está rodando`)
        this.runs.delete(req.name)
        return { t: 'ok', id }
      }
      case 'shutdown': {
        const live = this.live()
        if (live.length && !req.force) throw new HostError('busy', `processos vivos: ${live.map((r) => r.name).join(', ')}`)
        this.log(`shutdown requested${req.force ? ' (force)' : ''}; ${live.length} live`)
        await Promise.all([...this.runs.values()].filter((r) => !r.exit).map((r) => r.pty.kill()))
        setImmediate(() => void this.close().then(() => this.onExit('shutdown request')))
        return { t: 'ok', id }
      }
      default:
        throw new HostError('bad-request', `mensagem desconhecida: ${String((req as { t?: unknown }).t)}`)
    }
  }

  // ---- runs ----------------------------------------------------------------------------------

  private async spawn(req: Extract<HostRequest, { t: 'spawn' }>): Promise<HostRun> {
    if (typeof req.name !== 'string' || typeof req.run !== 'number' || !req.plan) throw new HostError('bad-request', 'spawn sem name/run/plan')
    const prev = this.runs.get(req.name)
    if (prev && !prev.exit) throw new HostError('already-running', `${req.name} já roda neste anfitrião (pid ${prev.pid})`)
    const home = req.home
    const spawnedAt = new Date().toISOString()
    const log = this.persist ? new RunLog(home, req.name, req.run, this.logMaxBytes, this.log) : undefined
    let resolveEnded!: (e: RunExit) => void
    const ended = new Promise<RunExit>((r) => { resolveEnded = r })
    let run: Run | undefined
    let identity: Promise<string> | undefined
    const scrollback = new Scrollback(SCROLLBACK_CHARS)
    let pty: PtyHandle
    const finish = (code: number): Promise<void> => this.onRunExit(req.name, home, () => run, identity, log, code, resolveEnded)
    try {
      pty = spawnPty(req.plan, {
        cols: req.cols > 0 ? req.cols : 120,
        rows: req.rows > 0 ? req.rows : 30,
        onData: (data) => {
          scrollback.push(data)
          log?.push(data)
          if (run) for (const s of run.attached) this.send(s, { t: 'data', name: req.name, off: scrollback.end, data })
        },
        onExit: (e) => void finish(e.exitCode),
      })
    } catch (e) {
      log?.close()
      throw new HostError('spawn-failed', (e as Error).message)
    }
    identity = this.persist ? processStartTime(pty.pid).then((t) => t ?? spawnedAt) : Promise.resolve(spawnedAt)
    const startedAt = await identity
    run = { name: req.name, run: req.run, pid: pty.pid, startedAt, spawnedAt, pty, scrollback, log, finish, attached: new Set(), ended }
    if (pty.exit) run.exit = { code: pty.exit.exitCode, at: new Date().toISOString() }
    this.runs.set(req.name, run)
    if (!run.exit) this.writeRun(home, run)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.log(`spawned ${req.name} run ${req.run} pid ${pty.pid}: ${req.plan.command}`)
    return publicRun(run)
  }

  /** run.json gets the exit BEFORE any client hears of it; with no client connected it is written all the same. */
  private async onRunExit(name: string, home: string, current: () => Run | undefined, identity: Promise<string> | undefined, log: RunLog | undefined, code: number, done: (e: RunExit) => void): Promise<void> {
    const exit: RunExit = { code, at: new Date().toISOString() }
    log?.close()
    await identity
    // Let output already read from the console reach the clients before the exit does.
    if (!this.persist) await new Promise<void>((r) => setImmediate(r))
    const run = current()
    if (!run || run.finished) return
    run.finished = true
    run.exit = exit
    this.writeRun(home, run)
    this.log(`${name} run ${run.run} pid ${run.pid} ended with code ${code}`)
    done(exit)
    for (const c of this.clients) this.send(c, { t: 'exit', name, run: run.run, exit })
    this.armIdle()
  }

  private writeRun(home: string, run: Run): void {
    if (!this.persist) return
    try {
      writeRunFile(home, { v: 1, ...publicRun(run), hostPid: this.pid, hostStartedAt: this.startedAt })
    } catch (e) {
      this.log(`run file of ${run.name}: ${(e as Error).message}`)
    }
  }

  /** Ctrl+C (the console's own stop signal), wait up to graceMs, then the whole tree by pid. */
  private stop(run: Run, graceMs: number): Promise<RunExit> {
    if (run.exit) return Promise.resolve(run.exit)
    run.stopping ??= (async () => {
      run.pty.write('\x03')
      let timer: NodeJS.Timeout | undefined
      const gentle = await Promise.race([run.ended.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), Math.max(0, graceMs)) })])
      clearTimeout(timer)
      if (!gentle) {
        this.log(`${run.name} pid ${run.pid} did not end in ${graceMs} ms after Ctrl+C; killing the tree`)
        await killTree(run.pid)
        await run.pty.kill()
      }
      return run.ended
    })()
    return run.stopping
  }
}

function publicRun(r: Run): HostRun {
  return { name: r.name, run: r.run, pid: r.pid, startedAt: r.startedAt, spawnedAt: r.spawnedAt, ...(r.exit ? { exit: r.exit } : {}) }
}
