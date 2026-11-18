// Executor: the coordinator's door to blocking work. `run(op, args)` sends a request from the closed table to one of
// two worker_threads (lane `io`: short and strictly FIFO; lane `work`: long, no order) and resolves with the reply.
// TETHER_EXECUTOR=worker|inline picks the backend (inline = same table in the loop; the default of the unit tests).
//
// This file must stay free of node:fs: the coordinator imports it, and the implementations (ops-*.ts) live behind
// the worker file, which is only ever started by path.
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { perf as globalPerf, type Perf } from '../core/perf.ts'
import { InlineTransport } from './inline.ts'
import {
  ExecError, ExecTimeout, ExecutorDown, OP_META,
  type ExecReply, type ExecRequest, type Lane, type OpArgs, type OpName, type OpValue,
} from './protocol.ts'

/** An `io` operation slower than this (queue wait included) raises a `slow-io` incident: the head of the FIFO is stuck. */
export const SLOW_IO_MS = 250

export interface Transport {
  call(lane: Lane, req: ExecRequest): Promise<ExecReply>
  close(): Promise<void>
}

export type ExecutorMode = 'worker' | 'inline'

export interface ExecutorOptions {
  /** Default: TETHER_EXECUTOR, else `worker`. */
  mode?: ExecutorMode
  /** Worker entry file. Default: ./worker.ts beside this file, resolved lazily (import.meta.url is empty in the CJS bundle: pass it there). */
  workerPath?: string
  /** Inline mode only: file URL of the table module. Default: ./table.ts beside inline.ts (import.meta.url is empty in a CJS bundle: pass it there). */
  tableUrl?: string
  /** Extra execArgv for the workers (default: the parent's own). */
  execArgv?: string[]
  /** Test hook: every operation sleeps this long in its worker. Default: TETHER_TEST_IO_DELAY_MS. */
  ioDelayMs?: number
  perf?: Perf
  log?: (msg: string) => void
}

export interface RunOptions { timeoutMs?: number }

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutorMode {
  return env.TETHER_EXECUTOR === 'inline' ? 'inline' : 'worker'
}

let defaultWorkerPath: string | undefined
/** Resolved on first use, never at import time. */
function getDefaultWorkerPath(): string {
  defaultWorkerPath ??= fileURLToPath(new URL('./worker.ts', import.meta.url))
  return defaultWorkerPath
}

interface Pending {
  req: ExecRequest
  idempotent: boolean
  attempts: number
  resolve: (r: ExecReply) => void
  reject: (e: Error) => void
}

interface LaneOptions { path: () => string; execArgv: string[] | undefined; ioDelayMs: number | undefined; log: (msg: string) => void }

class WorkerLane {
  private worker: Worker | undefined
  private readonly pending = new Map<number, Pending>()
  private closed = false
  private readonly lane: Lane
  private readonly o: LaneOptions
  constructor(lane: Lane, o: LaneOptions) { this.lane = lane; this.o = o }

  private spawn(): Worker {
    const w = new Worker(this.o.path(), {
      workerData: { lane: this.lane, ioDelayMs: this.o.ioDelayMs },
      ...(this.o.execArgv ? { execArgv: this.o.execArgv } : {}),
    })
    w.unref()
    w.on('message', (r: ExecReply) => {
      const p = this.pending.get(r.id)
      if (!p) return // timed out and dropped, or answered after a restart
      this.pending.delete(r.id)
      p.resolve(r)
    })
    w.on('error', (e) => this.o.log(`exec ${this.lane}: worker error: ${e.message}`))
    w.on('exit', (code) => this.onExit(w, code))
    this.worker = w
    return w
  }

  private onExit(w: Worker, code: number): void {
    if (this.worker !== w) return
    this.worker = undefined
    const stranded = [...this.pending.values()]
    if (this.closed) {
      this.pending.clear()
      for (const p of stranded) p.reject(new ExecutorDown('executor closed'))
      return
    }
    this.o.log(`exec ${this.lane}: worker exited (code ${code}) with ${stranded.length} pending`)
    const retry: Pending[] = []
    for (const p of stranded) {
      if (p.idempotent && p.attempts < 1) { p.attempts++; retry.push(p) } else { this.pending.delete(p.req.id); p.reject(new ExecutorDown()) }
    }
    if (retry.length) { // respawn now only when someone is waiting: a dead-on-arrival worker cannot loop (one retry per request)
      const nw = this.spawn()
      for (const p of retry) nw.postMessage(p.req)
    }
  }

  call(req: ExecRequest): Promise<ExecReply> {
    if (this.closed) return Promise.reject(new ExecutorDown('executor closed'))
    return new Promise((resolve, reject) => {
      const meta = (OP_META as Record<string, { idempotent: boolean } | undefined>)[req.op]
      this.pending.set(req.id, { req, idempotent: meta?.idempotent ?? false, attempts: 0, resolve, reject })
      ;(this.worker ?? this.spawn()).postMessage(req)
    })
  }

  forget(id: number): void { this.pending.delete(id) }

  /** Test hook: kill the worker as if it crashed. */
  async terminate(): Promise<void> { await this.worker?.terminate() }

  async close(): Promise<void> {
    this.closed = true
    const w = this.worker
    if (w) await w.terminate()
    for (const p of this.pending.values()) p.reject(new ExecutorDown('executor closed'))
    this.pending.clear()
  }
}

class WorkerTransport implements Transport {
  private readonly lanes: Record<Lane, WorkerLane>
  constructor(opts: ExecutorOptions) {
    const base = {
      path: () => opts.workerPath ?? getDefaultWorkerPath(),
      execArgv: opts.execArgv,
      ioDelayMs: opts.ioDelayMs ?? (Number(process.env.TETHER_TEST_IO_DELAY_MS) || undefined),
      log: opts.log ?? (() => {}),
    }
    this.lanes = { io: new WorkerLane('io', base), work: new WorkerLane('work', base) }
  }
  call(lane: Lane, req: ExecRequest): Promise<ExecReply> { return this.lanes[lane].call(req) }
  forget(lane: Lane, id: number): void { this.lanes[lane].forget(id) }
  terminateLane(lane: Lane): Promise<void> { return this.lanes[lane].terminate() }
  async close(): Promise<void> { await Promise.all([this.lanes.io.close(), this.lanes.work.close()]) }
}

export class Executor {
  readonly mode: ExecutorMode
  private readonly transport: Transport
  private readonly perf: Perf
  private readonly inflight = new Set<Promise<unknown>>()
  private nextId = 1

  constructor(opts: ExecutorOptions = {}) {
    this.mode = opts.mode ?? modeFromEnv()
    this.perf = opts.perf ?? globalPerf
    this.transport = this.mode === 'inline' ? new InlineTransport({ tableUrl: opts.tableUrl }) : new WorkerTransport(opts)
  }

  /** Runs one operation of the closed table. Rejects with ExecError (original name/code kept), ExecTimeout or ExecutorDown. */
  run<K extends OpName>(op: K, args: OpArgs<K>, opts: RunOptions = {}): Promise<OpValue<K>> {
    const meta = OP_META[op]
    if (!meta) return Promise.reject(new Error(`unknown operation: ${String(op)}`))
    const req: ExecRequest = { id: this.nextId++, op, args }
    // Own counters (n, total, max per op) in the ruler's label table: the wall time is spent in the worker, not in the loop,
    // so it must not raise `slow`. Only a stuck io lane raises `slow-io`.
    const p = (async (): Promise<OpValue<K>> => {
      const t0 = performance.now()
      let timer: NodeJS.Timeout | undefined
      const call = this.transport.call(meta.lane, req)
      const guarded = opts.timeoutMs === undefined ? call : Promise.race([
        call,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            if (this.transport instanceof WorkerTransport) this.transport.forget(meta.lane, req.id)
            rej(new ExecTimeout(op, opts.timeoutMs!))
          }, opts.timeoutMs)
        }),
      ])
      try {
        const reply = await guarded
        const wall = performance.now() - t0
        if (meta.lane === 'io' && wall > SLOW_IO_MS) this.perf.incident('slow-io', { op, ms: Math.round(wall), workerMs: reply.ms })
        if (!reply.ok) throw new ExecError(reply.error)
        return reply.value as OpValue<K>
      } finally {
        if (timer) clearTimeout(timer)
        this.perf.count(`exec:${op}`, performance.now() - t0)
      }
    })()
    this.inflight.add(p)
    const done = (): void => { this.inflight.delete(p) }
    p.then(done, done)
    return p
  }

  /** Resolves when every request issued so far has settled (success or failure). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
  }

  /** Drains, then stops the workers. Requests issued afterwards reject with ExecutorDown (worker mode). */
  async close(): Promise<void> {
    await this.drain()
    await this.transport.close()
  }

  /** Test hook: kill the lane's worker as if it crashed. No-op in inline mode. */
  async killWorker(lane: Lane): Promise<void> {
    if (this.transport instanceof WorkerTransport) await this.transport.terminateLane(lane)
  }
}

export function createExecutor(opts: ExecutorOptions = {}): Executor {
  return new Executor(opts)
}
