// Measures a folder's context with `claude -p "/context"` (zero API cost, ~4 s) and caches the parsed report by
// inventoryKey + model. The arguments never go through a shell: MSYS would turn "/context" into a path.

import { spawn } from 'node:child_process'
import { cleanEnv, resolveClaudeCommand } from '../agents/claude.ts'
import { parseContextReport, type ContextReport } from './context-report.ts'
import { inventoryKey, readInventory, type Inventory } from './inventory.ts'

export type MeasureFailureReason = 'timeout' | 'not-found' | 'failed' | 'unparseable'

export interface MeasureInput {
  cwd: string
  model: string
  /** Who asked. Informational: the cache is shared by every slot of the same folder. */
  slotKey?: string
  /** Skip the cached report and measure again. */
  force?: boolean
}

export type MeasureResult =
  | { ok: true; report: ContextReport; measuredAt: number; fromCache: boolean; durationMs: number }
  | { ok: false; reason: MeasureFailureReason; message: string }

export type RunnerResult = { ok: true; stdout: string } | { ok: false; reason: Exclude<MeasureFailureReason, 'unparseable'> }
export type ContextRunner = (req: { cwd: string; model: string; timeoutMs: number }) => Promise<RunnerResult>

const MAX_STDOUT = 1024 * 1024

/** Fixed texts: raw stderr or paths never reach the caller. */
const MESSAGES: Record<MeasureFailureReason, string> = {
  timeout: 'A medição do contexto demorou demais e foi cancelada.',
  'not-found': 'Não encontrei o executável do Claude para medir o contexto.',
  failed: 'O Claude não conseguiu medir o contexto.',
  unparseable: 'O relatório de contexto do Claude veio em um formato que não entendi.',
}

/** Real runner: `claude -p /context --model <m>` in the folder, no shell, no CLAUDE* variables, killed by PID on timeout. */
export const runClaudeContext: ContextRunner = async ({ cwd, model, timeoutMs }) => {
  const env = cleanEnv()
  const command = await resolveClaudeCommand(env).catch(() => 'claude')
  return new Promise<RunnerResult>((done) => {
    let settled = false
    const finish = (r: RunnerResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(r)
    }
    let child
    try {
      child = spawn(command, ['-p', '/context', '--model', model], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      done({ ok: false, reason: 'not-found' })
      return
    }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(child.pid) } catch { /* already gone */ }
      finish({ ok: false, reason: 'timeout' })
    }, timeoutMs)
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (out.length < MAX_STDOUT) out += chunk })
    child.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, reason: e.code === 'ENOENT' ? 'not-found' : 'failed' }))
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout: out } : { ok: false, reason: 'failed' }))
  })
}

export interface ContextMeterOptions {
  runner?: ContextRunner
  /** Reads the folder's inventory; injectable for tests. */
  inventory?: (cwd: string) => Promise<Inventory>
  timeoutMs?: number
  /** LRU bound of the report cache. */
  maxEntries?: number
  now?: () => number
}

interface Cached {
  report: ContextReport
  measuredAt: number
  durationMs: number
}

export class ContextMeter {
  private readonly runner: ContextRunner
  private readonly inventory: (cwd: string) => Promise<Inventory>
  private readonly timeoutMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly cache = new Map<string, Cached>() // insertion order = recency
  private readonly inflight = new Map<string, Promise<MeasureResult>>()
  private queue: Promise<unknown> = Promise.resolve() // one measurement at a time, globally

  constructor(opts: ContextMeterOptions = {}) {
    this.runner = opts.runner ?? runClaudeContext
    this.inventory = opts.inventory ?? ((cwd) => readInventory(cwd))
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.maxEntries = Math.max(1, opts.maxEntries ?? 64)
    this.now = opts.now ?? Date.now
  }

  async measure(input: MeasureInput): Promise<MeasureResult> {
    let key: string
    try {
      key = `${inventoryKey(await this.inventory(input.cwd))}|${input.model}`
    } catch {
      return fail('failed')
    }
    const hit = input.force ? undefined : this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return { ok: true, report: hit.report, measuredAt: hit.measuredAt, fromCache: true, durationMs: hit.durationMs }
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const job = this.queue.then(() => this.run(key, input))
    this.queue = job.catch(() => undefined)
    this.inflight.set(key, job)
    try {
      return await job
    } finally {
      this.inflight.delete(key)
    }
  }

  private async run(key: string, input: MeasureInput): Promise<MeasureResult> {
    const started = this.now()
    let r: RunnerResult
    try {
      r = await this.runner({ cwd: input.cwd, model: input.model, timeoutMs: this.timeoutMs })
    } catch {
      return fail('failed')
    }
    if (!r.ok) return fail(r.reason)
    const report = parseContextReport(r.stdout)
    if (report.categories.length === 0) return fail('unparseable')
    const entry: Cached = { report, measuredAt: this.now(), durationMs: this.now() - started }
    this.cache.set(key, entry)
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string)
    return { ok: true, report, measuredAt: entry.measuredAt, fromCache: false, durationMs: entry.durationMs }
  }
}

function fail(reason: MeasureFailureReason): MeasureResult {
  return { ok: false, reason, message: MESSAGES[reason] }
}
