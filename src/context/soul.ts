// Context data for one soul session, read from the slot's events file (<home>/slots/<id>.events.jsonl). The soul client
// appends one `kind:"context"` line per finished turn carrying the context it measured itself (categories, memory files,
// skills, agents, MCP tools, API usage). parseEvents keeps only start/rename/end, so the raw lines are read here.
// Only lines of the session opened by the last `start` count: a `start` with another session id (switch, clear) resets.
// The file is read incrementally (from the last consumed byte, at line boundaries) and never re-read from the start
// unless it shrank. Node built-ins only.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { UsageTotals, UsageTurn } from './live.ts'

export interface SoulCategory { name: string; tokens: number; isDeferred?: boolean }
export interface SoulMemoryFile { path: string; type: string; tokens: number }
export interface SoulSkill { name: string; source: string; tokens: number }
export interface SoulAgent { agentType: string; source: string; tokens: number }
export interface SoulMcpTool { serverName: string; name: string; tokens: number }

/** The context the soul client measured at the end of a turn. */
export interface SoulContext {
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  autoCompactThreshold: number | undefined
  categories: SoulCategory[]
  memoryFiles: SoulMemoryFile[]
  skills: SoulSkill[]
  agents: SoulAgent[]
  mcpTools: SoulMcpTool[]
  credits: number | undefined
  sessionId: string
  /** Epoch ms of the line (0 when missing/invalid). */
  at: number
}

const CHUNK = 1 << 20
/** Bound on each measured list kept (a pathological line must not grow memory). */
const MAX_ITEMS = 500

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = <T>(v: unknown, map: (o: Record<string, any>) => T | undefined): T[] => {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const x of v) {
    if (out.length >= MAX_ITEMS) break
    const m = isObj(x) ? map(x) : undefined
    if (m) out.push(m)
  }
  return out
}

export function parseSoulContext(c: unknown, sessionId: string, at: number): SoulContext | undefined {
  if (!isObj(c)) return undefined
  return {
    model: str(c.model),
    totalTokens: num(c.totalTokens),
    maxTokens: num(c.maxTokens),
    percentage: typeof c.percentage === 'number' && Number.isFinite(c.percentage) ? c.percentage : 0,
    autoCompactThreshold: num(c.autoCompactThreshold) || undefined,
    categories: list(c.categories, o => (str(o.name) ? { name: str(o.name), tokens: num(o.tokens), ...(o.isDeferred === true ? { isDeferred: true } : {}) } : undefined)),
    memoryFiles: list(c.memoryFiles, o => (str(o.path) ? { path: str(o.path), type: str(o.type), tokens: num(o.tokens) } : undefined)),
    skills: list(c.skills, o => (str(o.name) ? { name: str(o.name), source: str(o.source), tokens: num(o.tokens) } : undefined)),
    agents: list(c.agents, o => (str(o.agentType) ? { agentType: str(o.agentType), source: str(o.source), tokens: num(o.tokens) } : undefined)),
    mcpTools: list(c.mcpTools, o => (str(o.name) ? { serverName: str(o.serverName), name: str(o.name), tokens: num(o.tokens) } : undefined)),
    credits: typeof c.credits === 'number' && Number.isFinite(c.credits) ? c.credits : undefined,
    sessionId,
    at,
  }
}

export class SoulEventsReader {
  /** Bytes consumed so far (always at a line boundary). */
  offset = 0
  /** Cumulative bytes read from disk across all polls (for tests and diagnostics). */
  bytesRead = 0
  readonly path: string
  private readonly max: number
  private ring: UsageTurn[] = []
  private tot: UsageTotals = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }
  private session: string | undefined
  private ctx: SoulContext | undefined

  constructor(path: string, opts: { maxTurns?: number } = {}) {
    this.path = path
    this.max = Math.max(1, opts.maxTurns ?? 500)
  }

  poll(): number {
    let fd: number
    try { fd = openSync(this.path, 'r') } catch { return 0 }
    let applied = 0
    try {
      const size = fstatSync(fd).size
      if (size < this.offset) { this.offset = 0; this.session = undefined; this.clear() }
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
        carry = Buffer.from(data.subarray(start))
      }
    } finally {
      closeSync(fd)
    }
    return applied
  }

  turns(): readonly UsageTurn[] { return this.ring }
  last(): UsageTurn | undefined { return this.ring[this.ring.length - 1] }
  totals(): UsageTotals { return { ...this.tot } }
  /** The latest measured context of the current session. */
  context(): SoulContext | undefined { return this.ctx }
  sessionId(): string | undefined { return this.session }

  private clear(): void {
    this.ring = []
    this.tot = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }
    this.ctx = undefined
  }

  private line(raw: string): number {
    const text = raw.trim()
    if (!text || text.charCodeAt(0) !== 123) return 0
    let o: any
    try { o = JSON.parse(text) } catch { return 0 }
    if (!isObj(o) || typeof o.sessionId !== 'string') return 0
    if (o.kind === 'start') {
      if (o.sessionId !== this.session) { this.session = o.sessionId; this.clear() }
      return 0
    }
    if (o.kind !== 'context') return 0
    if (this.session !== undefined && o.sessionId !== this.session) return 0
    const t = typeof o.ts === 'string' ? Date.parse(o.ts) : NaN
    const ts = Number.isFinite(t) ? t : 0
    const ctx = parseSoulContext(o.context, o.sessionId, ts)
    if (!ctx) return 0
    this.ctx = ctx
    const u = isObj(o.context.apiUsage) ? o.context.apiUsage : {}
    const turn: UsageTurn = {
      id: `${o.sessionId}:${this.tot.turns + 1}`,
      ts,
      ctxTokens: ctx.totalTokens,
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreate: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
      model: ctx.model,
      sidechain: false,
    }
    this.tot.turns++
    this.tot.input += turn.input
    this.tot.cacheRead += turn.cacheRead
    this.tot.cacheCreate += turn.cacheCreate
    this.tot.output += turn.output
    this.ring.push(turn)
    if (this.ring.length > this.max) this.ring.splice(0, this.ring.length - this.max)
    return 1
  }
}
