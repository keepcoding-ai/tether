// Context data for one Codex session: where its rollout lives, an incremental rollout reader (model, effort, window and
// per-turn usage from `token_count` events), and the disk inventory of what Codex puts in every prompt (AGENTS.md chain,
// skills, MCP servers from config.toml). Node built-ins only. The rollout is never re-read from the start once consumed.
// Secrets: ~/.codex/auth.json is never opened; from config.toml only MCP server names and their transport kind are taken.
import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { estimate, readSkills, readText, statFile, MAX_READ_BYTES, type Inventory, type InventoryFile, type InventoryMcpServer, type InventoryMemoryFile } from './inventory.ts'
import type { UsageTotals, UsageTurn } from './live.ts'

export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const v = env.CODEX_HOME
  return v && v.trim() ? resolve(v) : join(home, '.codex')
}

// ---------- locating the rollout ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Day folders (YYYY/MM/DD) to try first: a v7 uuid carries its creation time; the day before/after covers the time zone. */
function likelyDays(sessionId: string): string[] {
  const hex = sessionId.replaceAll('-', '').slice(0, 12)
  const ms = parseInt(hex, 16)
  if (sessionId[14] !== '7' || !Number.isFinite(ms)) return []
  const days = new Set<string>()
  for (const d of [-1, 0, 1]) {
    const t = new Date(ms + d * 86_400_000)
    days.add(join(String(t.getFullYear()), pad2(t.getMonth() + 1), pad2(t.getDate())))
  }
  return [...days]
}

function findIn(dir: string, suffix: string): string | undefined {
  try {
    const hit = readdirSync(dir).find(n => n.toLowerCase().endsWith(suffix))
    return hit ? join(dir, hit) : undefined
  } catch {
    return undefined
  }
}

const sortedDesc = (dir: string): string[] => { try { return readdirSync(dir).filter(n => /^\d+$/.test(n)).sort().reverse() } catch { return [] } }

/**
 * The rollout file of a session: <codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. Tries the days the id
 * points at, then walks the day folders newest first (callers cache the answer per session id).
 */
export function findCodexRollout(sessionId: string, home = codexHome()): string | undefined {
  if (!UUID_RE.test(sessionId)) return undefined
  const root = join(home, 'sessions')
  const suffix = `-${sessionId.toLowerCase()}.jsonl`
  for (const d of likelyDays(sessionId)) {
    const hit = findIn(join(root, d), suffix)
    if (hit) return hit
  }
  for (const y of sortedDesc(root)) for (const m of sortedDesc(join(root, y))) for (const d of sortedDesc(join(root, y, m))) {
    const hit = findIn(join(root, y, m, d), suffix)
    if (hit) return hit
  }
  return undefined
}

// ---------- the rollout reader ----------

export interface CodexSessionInfo {
  sessionId: string
  cwd: string
  cliVersion: string
  model: string
  effort: string
  /** model_context_window of the last token_count (or task_started). */
  windowSize: number | undefined
  /** Tokens of the last request (its total), what occupies the window now. */
  usedTokens: number | undefined
  /** Epoch ms of the last usage line. */
  at: number
  /** Primary rate limit, when the rollout carries one. */
  rateLimitPct: number | undefined
}

const CHUNK = 1 << 20
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Same surface as TranscriptUsageReader (poll/turns/last/totals) plus the session's header data. */
export class CodexRolloutReader {
  offset = 0
  bytesRead = 0
  readonly path: string
  private readonly max: number
  private ring: UsageTurn[] = []
  private tot: UsageTotals = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }
  private lastTotal = -1
  private s: CodexSessionInfo = blankInfo()

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
      if (size < this.offset) this.reset()
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
  info(): CodexSessionInfo { return { ...this.s } }

  private reset(): void {
    this.offset = 0
    this.ring = []
    this.tot = { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 }
    this.lastTotal = -1
    this.s = blankInfo()
  }

  private line(raw: string): number {
    const text = raw.trim()
    if (!text || text.charCodeAt(0) !== 123) return 0
    // Cheap prefilter: only the line types this reader uses (response items can be huge and are skipped unparsed).
    if (!/"type":"(session_meta|turn_context|event_msg)"/.test(text.slice(0, 200))) return 0
    let o: any
    try { o = JSON.parse(text) } catch { return 0 }
    const p = isObj(o?.payload) ? o.payload : undefined
    if (!p) return 0
    if (o.type === 'session_meta') {
      this.s.sessionId = str(p.id) || str(p.session_id) || this.s.sessionId
      this.s.cwd = str(p.cwd) || this.s.cwd
      this.s.cliVersion = str(p.cli_version) || this.s.cliVersion
      return 0
    }
    if (o.type === 'turn_context') {
      this.settings(p)
      return 0
    }
    // event_msg
    if (p.type === 'thread_settings_applied') { this.settings(isObj(p.thread_settings) ? p.thread_settings : {}); return 0 }
    if (p.type === 'task_started') { if (num(p.model_context_window)) this.s.windowSize = p.model_context_window; return 0 }
    if (p.type !== 'token_count') return 0
    const rl = isObj(p.rate_limits) && isObj(p.rate_limits.primary) ? p.rate_limits.primary : undefined
    if (rl && typeof rl.used_percent === 'number') this.s.rateLimitPct = rl.used_percent
    const info = isObj(p.info) ? p.info : undefined
    if (!info) return 0
    if (num(info.model_context_window)) this.s.windowSize = info.model_context_window
    const last = isObj(info.last_token_usage) ? info.last_token_usage : undefined
    const total = isObj(info.total_token_usage) ? info.total_token_usage : undefined
    if (!last) return 0
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const ts = Number.isFinite(t) ? t : 0
    const inputAll = num(last.input_tokens)
    const cached = Math.min(inputAll, num(last.cached_input_tokens))
    const output = num(last.output_tokens)
    this.s.usedTokens = num(last.total_tokens) || inputAll + output
    this.s.at = ts
    // A token_count is repeated (rate limit refreshes) without a new request: the cumulative total tells them apart.
    const cumul = total ? num(total.total_tokens) : -2
    if (cumul >= 0 && cumul === this.lastTotal) return 0
    this.lastTotal = cumul
    const turn: UsageTurn = {
      id: String(this.tot.turns + 1),
      ts,
      ctxTokens: inputAll,
      input: inputAll - cached,
      cacheRead: cached,
      cacheCreate: num(last.cache_write_input_tokens),
      output,
      model: this.s.model,
      sidechain: false,
    }
    this.tot.turns++
    if (total) {
      const ti = num(total.input_tokens)
      const tc = Math.min(ti, num(total.cached_input_tokens))
      this.tot.input = ti - tc
      this.tot.cacheRead = tc
      this.tot.cacheCreate = num(total.cache_write_input_tokens)
      this.tot.output = num(total.output_tokens)
    } else {
      this.tot.input += turn.input
      this.tot.cacheRead += turn.cacheRead
      this.tot.cacheCreate += turn.cacheCreate
      this.tot.output += turn.output
    }
    this.ring.push(turn)
    if (this.ring.length > this.max) this.ring.shift()
    return 1
  }

  private settings(p: Record<string, any>): void {
    const model = str(p.model)
    if (model) this.s.model = model
    const cm = isObj(p.collaboration_mode) && isObj(p.collaboration_mode.settings) ? p.collaboration_mode.settings : undefined
    const effort = str(p.effort) || str(p.reasoning_effort) || str(cm?.reasoning_effort) || str(p.model_reasoning_effort)
    if (effort) this.s.effort = effort
  }
}

function blankInfo(): CodexSessionInfo {
  return { sessionId: '', cwd: '', cliVersion: '', model: '', effort: '', windowSize: undefined, usedTokens: undefined, at: 0, rateLimitPct: undefined }
}

// ---------- inventory ----------

/** The project root Codex uses for the AGENTS.md chain: the nearest folder with a `.git` entry, else the folder itself. */
async function projectRoot(cwd: string): Promise<string> {
  for (let d = cwd; ; d = dirname(d)) {
    try {
      await stat(join(d, '.git'))
      return d
    } catch { /* keep walking */ }
    if (dirname(d) === d) return cwd
  }
}

/** Folders from the project root down to cwd (root first). */
function chain(root: string, cwd: string): string[] {
  const out: string[] = []
  for (let d = cwd; ; d = dirname(d)) {
    out.push(d)
    if (d.toLowerCase() === root.toLowerCase() || dirname(d) === d) break
  }
  return out.reverse()
}

/** In each folder AGENTS.override.md wins over AGENTS.md (Codex reads one per folder). */
async function agentsFileIn(dir: string): Promise<InventoryFile | undefined> {
  return (await statFile(join(dir, 'AGENTS.override.md'))) ?? (await statFile(join(dir, 'AGENTS.md')))
}

/** `[mcp_servers.<name>]` tables of a config.toml: the name and whether it runs a command (stdio) or a url (http). Nothing else. */
export function codexMcpServers(toml: string): { name: string; transport: string }[] {
  const out = new Map<string, string>()
  let current: string | undefined
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      const m = /^\[\s*mcp_servers\.("([^"]+)"|'([^']+)'|[A-Za-z0-9_-]+)\s*\]$/.exec(line)
      current = m ? (m[2] ?? m[3] ?? m[1]!) : undefined
      if (current && !out.has(current)) out.set(current, 'unknown')
      continue
    }
    if (!current) continue
    if (/^command\s*=/.test(line)) out.set(current, 'stdio')
    else if (/^url\s*=/.test(line) && out.get(current) === 'unknown') out.set(current, 'http')
  }
  return [...out].map(([name, transport]) => ({ name, transport }))
}

export interface CodexInventoryOptions {
  codexHome?: string
  home?: string
  cliVersion?: string
  maxReadBytes?: number
}

/** What Codex can put in every prompt for a folder, in the same shape as the Claude inventory (agents/commands/hooks empty). */
export async function readCodexInventory(cwd: string, opts: CodexInventoryOptions = {}): Promise<Inventory> {
  const home = opts.home ?? homedir()
  const ch = opts.codexHome ?? codexHome(process.env, home)
  const max = opts.maxReadBytes ?? MAX_READ_BYTES
  const cwdAbs = resolve(cwd)
  const root = await projectRoot(cwdAbs)
  const dirs = chain(root, cwdAbs)

  const globalAgents = await agentsFileIn(ch)
  const projectAgents = await Promise.all(dirs.map(agentsFileIn))
  const memory: InventoryMemoryFile[] = []
  const toMem = (f: InventoryFile, kind: InventoryMemoryFile['kind']): InventoryMemoryFile => ({ ...f, kind, tokens: estimate(f.bytes), estimated: true })
  if (globalAgents) memory.push(toMem(globalAgents, 'user'))
  for (const f of projectAgents) if (f) memory.push(toMem(f, /override/i.test(f.path) ? 'local' : 'project'))

  const userSkillDirs = [join(ch, 'skills'), join(ch, 'skills', '.system'), join(home, '.agents', 'skills')]
  const projectSkillDirs = dirs.flatMap(d => [join(d, '.agents', 'skills'), join(d, '.codex', 'skills')])
  const skillLists = await Promise.all([
    ...projectSkillDirs.map(d => readSkills(d, 'project', max)),
    ...userSkillDirs.map(d => readSkills(d, 'user', max)),
  ])
  const seenSkill = new Set<string>()
  const skills = skillLists.flat().filter(s => { const k = s.path.toLowerCase(); if (seenSkill.has(k)) return false; seenSkill.add(k); return true })

  const configFiles = (await Promise.all([join(ch, 'config.toml'), ...dirs.map(d => join(d, '.codex', 'config.toml'))].map(statFile))).filter((f): f is InventoryFile => !!f)
  const mcp = new Map<string, InventoryMcpServer>()
  for (const f of configFiles) {
    const text = await readText(f, max)
    if (text === undefined) continue
    for (const s of codexMcpServers(text)) mcp.set(s.name, { ...s, source: 'codex-config' })
  }

  const files: InventoryFile[] = [...memory, ...skills, ...configFiles].map(f => ({ path: f.path, bytes: f.bytes, mtimeMs: f.mtimeMs }))
  return {
    cwd: cwdAbs,
    claudeVersion: opts.cliVersion ?? 'codex',
    memory,
    skills,
    agents: [],
    commands: [],
    mcpServers: [...mcp.values()],
    hooks: [],
    statusLine: undefined,
    plugins: [],
    files,
  }
}
