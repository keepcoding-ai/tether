// Live context data for one Claude Code slot: the statusline summary file and an incremental transcript reader.
// Node built-ins only. Never re-reads a transcript from the start once it has consumed it.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

export interface LiveSummary {
  session_id?: string
  transcript_path?: string
  version?: string
  model?: { id?: string; display_name?: string }
  context_window?: {
    context_window_size?: number
    used_percentage?: number
    remaining_percentage?: number
    total_input_tokens?: number
    total_output_tokens?: number
    current_usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  exceeds_200k_tokens?: boolean
  cost?: { total_cost_usd?: number; total_duration_ms?: number; total_api_duration_ms?: number }
  prompt_cache?: Record<string, unknown>
  rate_limits?: Record<string, unknown>
  effort?: { level?: string }
  at?: string
}

/** Reads <home>/context/<slotId>.json written by the statusline script; undefined when absent or corrupt. */
export function readLiveSummary(home: string, slotId: string): LiveSummary | undefined {
  if (!slotId || /[\\/]|\.\./.test(slotId)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'context', `${slotId}.json`), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as LiveSummary
  } catch {
    return undefined
  }
}

export interface UsageTurn {
  /** Message id (or line uuid) used for dedupe. */
  id: string
  /** Epoch ms of the line timestamp (0 when missing/invalid). */
  ts: number
  /** Tokens the model saw as input: input + cache creation + cache read. */
  ctxTokens: number
  input: number
  cacheRead: number
  cacheCreate: number
  output: number
  model: string
  sidechain: boolean
}

export interface UsageTotals {
  turns: number
  input: number
  cacheRead: number
  cacheCreate: number
  output: number
}

export interface TranscriptUsageReaderOptions {
  /** Ring size (default 500 turns). */
  maxTurns?: number
}

const CHUNK = 1 << 20

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export class TranscriptUsageReader {
  /** Bytes consumed so far (always at a line boundary). */
  offset = 0
  /** Cumulative bytes read from disk across all polls (for tests and diagnostics). */
  bytesRead = 0
  readonly path: string
  private readonly max: number
  private ring: UsageTurn[] = []
  private byId = new Map<string, UsageTurn>()
  private tot: UsageTotals = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }

  constructor(path: string, opts: TranscriptUsageReaderOptions = {}) {
    this.path = path
    this.max = Math.max(1, opts.maxTurns ?? 500)
  }

  /** Reads only the bytes appended since the last poll. Returns how many turns were added or updated. */
  poll(): number {
    let fd: number
    try {
      fd = openSync(this.path, 'r')
    } catch {
      return 0
    }
    let applied = 0
    try {
      const size = fstatSync(fd).size
      if (size < this.offset) this.reset() // truncated or replaced
      let pos = this.offset
      let carry: Buffer = Buffer.alloc(0)
      const buf = Buffer.allocUnsafe(CHUNK)
      while (pos < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos)
        if (n <= 0) break
        this.bytesRead += n
        pos += n
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        let start = 0
        let nl: number
        while ((nl = data.indexOf(10, start)) !== -1) {
          applied += this.line(data.toString('utf8', start, nl))
          this.offset += nl + 1 - start
          start = nl + 1
        }
        carry = Buffer.from(data.subarray(start)) // copy: buf is reused
      }
    } finally {
      closeSync(fd)
    }
    return applied
  }

  turns(): readonly UsageTurn[] {
    return this.ring
  }

  last(): UsageTurn | undefined {
    return this.ring[this.ring.length - 1]
  }

  totals(): UsageTotals {
    return { ...this.tot }
  }

  private reset(): void {
    this.offset = 0
    this.ring = []
    this.byId.clear()
    this.tot = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }
  }

  private line(raw: string): number {
    const text = raw.trim()
    if (!text || text.charCodeAt(0) !== 123 || !text.includes('"usage"')) return 0
    let o: any
    try {
      o = JSON.parse(text)
    } catch {
      return 0
    }
    if (!o || o.type !== 'assistant') return 0
    const msg = o.message
    const u = msg && typeof msg === 'object' ? msg.usage : undefined
    if (!u || typeof u !== 'object') return 0
    const id = typeof msg.id === 'string' && msg.id ? msg.id : typeof o.uuid === 'string' ? o.uuid : ''
    const input = num(u.input_tokens)
    const cacheCreate = num(u.cache_creation_input_tokens)
    const cacheRead = num(u.cache_read_input_tokens)
    const output = num(u.output_tokens)
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const turn: UsageTurn = {
      id,
      ts: Number.isFinite(t) ? t : 0,
      ctxTokens: input + cacheCreate + cacheRead,
      input,
      cacheRead,
      cacheCreate,
      output,
      model: typeof msg.model === 'string' ? msg.model : '',
      sidechain: o.isSidechain === true,
    }
    const prev = id ? this.byId.get(id) : undefined
    if (prev) {
      // Same message streamed over several lines: the latest line carries the final usage.
      this.tot.input += input - prev.input
      this.tot.cacheRead += cacheRead - prev.cacheRead
      this.tot.cacheCreate += cacheCreate - prev.cacheCreate
      this.tot.output += output - prev.output
      Object.assign(prev, turn)
      return 1
    }
    this.tot.turns++
    this.tot.input += input
    this.tot.cacheRead += cacheRead
    this.tot.cacheCreate += cacheCreate
    this.tot.output += output
    this.ring.push(turn)
    if (id) this.byId.set(id, turn)
    if (this.ring.length > this.max) {
      const old = this.ring.shift()!
      if (old.id && this.byId.get(old.id) === old) this.byId.delete(old.id)
    }
    return 1
  }
}

/** Share of the turn's input tokens served from the prompt cache (0 when the turn has no input). */
export function cacheHitRatio(turn: Pick<UsageTurn, 'ctxTokens' | 'cacheRead'>): number {
  return turn.ctxTokens > 0 ? turn.cacheRead / turn.ctxTokens : 0
}

export interface ContextJump {
  /** Index in the given array of the turn after the jump. */
  index: number
  turn: UsageTurn
  /** ctxTokens(turn) minus ctxTokens(previous turn of the same lane). */
  delta: number
}

/**
 * Largest growth steps in context size between consecutive turns of the same lane (main thread and sidechains are
 * compared separately). Only deltas of at least `minDelta` tokens count; biggest first, at most `top`.
 */
export function detectContextJumps(turns: readonly UsageTurn[], opts: { minDelta?: number; top?: number } = {}): ContextJump[] {
  const minDelta = opts.minDelta ?? 10_000
  const top = opts.top ?? 5
  const prev: [UsageTurn | undefined, UsageTurn | undefined] = [undefined, undefined]
  const jumps: ContextJump[] = []
  turns.forEach((turn, index) => {
    const lane = turn.sidechain ? 1 : 0
    const p = prev[lane]
    prev[lane] = turn
    if (p && turn.ctxTokens - p.ctxTokens >= minDelta) jumps.push({ index, turn, delta: turn.ctxTokens - p.ctxTokens })
  })
  return jumps.sort((a, b) => b.delta - a.delta).slice(0, top)
}
