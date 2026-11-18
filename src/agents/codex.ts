// OpenAI Codex CLI adapter: how to launch `codex` in a slot so that it reports its sessions to tether, and how to read
// what Codex keeps on disk (<CODEX_HOME>/sessions rollouts, the session_index.jsonl titles).
//
// Reporting goes through Codex's `notify` program (`-c notify=[...]`, this launch only, never ~/.codex/config.toml):
// Codex runs it with one JSON argument on agent-turn-complete (and on approval/question prompts), carrying `thread-id`
// (the session id) and `cwd`. Codex hooks would also report SessionStart, but hooks given on the command line stay
// "untrusted" until the person reviews them (hook trust is only read from the user's own config) and the only way past
// that is --dangerously-bypass-hook-trust, which would also run every other unreviewed hook: so notify, which needs no
// trust. Consequence: a brand-new session binds to the slot when its first turn ends (a session with no turn has
// nothing to resume). The user's own `notify` keeps working: the reporter chains to it (TETHER_CODEX_NOTIFY).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Binding } from '../core/event.ts'
import { fileSig } from '../core/exe.ts'
import { canonicalDir } from '../core/paths.ts'
import { cleanEnv } from './claude.ts'
import { McpNameCollisionError } from './mcp.ts'
import type { AgentSkills } from './skills.ts'
import { skillsPromptText } from './skills.ts'
import { withColorSupport } from './termenv.ts'
import { ENV_AGENT, ENV_HOME, ENV_SLOT, type AgentAdapter, type LaunchPlan, type LookupOptions, type PlanInput } from './types.ts'

/** The user's own notify program (a JSON array of argv), for the reporter to chain to. */
export const ENV_CODEX_NOTIFY = 'TETHER_CODEX_NOTIFY'

/** The reporter script (read on use: Electron main bundles this module as CommonJS, where import.meta.url is undefined). */
function defaultReporterPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'report', 'codex-hook.mjs')
}

/** <CODEX_HOME>: the slot's profile env wins, then ours, then ~/.codex. */
export function codexHome(opts?: LookupOptions): string {
  return opts?.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex')
}

// ---- TOML values for `-c key=value` (the value part is parsed as TOML) ----

/** A TOML basic string: JSON's string escapes are all valid TOML, and control characters come out escaped. */
export function tomlString(s: string): string {
  return JSON.stringify(s)
}

/** A bare TOML key when it can be one, else a quoted one. */
export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)
}

export function tomlStringArray(items: readonly string[]): string {
  return `[${items.map(tomlString).join(',')}]`
}

function tomlInlineTable(obj: Record<string, string>): string {
  return `{${Object.entries(obj).map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`).join(',')}}`
}

/**
 * The top-level `notify = [...]` of a config.toml (before the first table header), or undefined. Handles basic and
 * literal strings and arrays over several lines; anything it cannot read counts as none.
 */
export function parseTopLevelNotify(text: string): string[] | undefined {
  const top = text.split(/^\s*\[/m)[0] ?? ''
  const m = /^\s*notify\s*=\s*\[/m.exec(top)
  if (!m) return undefined
  const out: string[] = []
  let i = m.index + m[0].length
  while (i < top.length) {
    const c = top[i]!
    if (c === ']') return out.length ? out : undefined
    if (c === '#') { while (i < top.length && top[i] !== '\n') i++; continue }
    if (c === "'") {
      const end = top.indexOf("'", i + 1)
      if (end < 0) return undefined
      out.push(top.slice(i + 1, end))
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < top.length && top[j] !== '"') j += top[j] === '\\' ? 2 : 1
      try { out.push(JSON.parse(top.slice(i, j + 1)) as string) } catch { return undefined }
      i = j + 1
      continue
    }
    if (/[\s,]/.test(c)) { i++; continue }
    return undefined
  }
  return undefined
}

/** The user's notify program from <CODEX_HOME>/config.toml, or undefined. */
export function userNotify(home: string): string[] | undefined {
  const file = join(home, 'config.toml')
  const sig = fileSig(file)
  if (sig === undefined) { notifyCache.delete(file); return undefined }
  const hit = notifyCache.get(file)
  if (hit?.sig === sig) return hit.value
  let value: string[] | undefined
  try { value = parseTopLevelNotify(readFileSync(file, 'utf8')) } catch { return undefined }
  if (notifyCache.size >= 16) notifyCache.clear()
  notifyCache.set(file, { sig, value })
  return value
}

/** The parsed notify of each config.toml, kept while its size and mtime stay what they were. */
const notifyCache = new Map<string, { sig: string; value: string[] | undefined }>()

// ---- finding the executable ----

/** How to run codex: `command` plus leading args (the npm shim's script, run by node, so no .cmd sits in between). */
export interface CodexCommand {
  command: string
  prefix: string[]
}

export interface CodexResolveDeps {
  platform?: NodeJS.Platform
  home?: string
  exists?: (path: string) => boolean
}

/**
 * Finds codex so it can be spawned without a shell. On Windows the npm install is a `codex.cmd` shim: running it would put
 * cmd.exe between us and Codex, and cmd mangles quotes and `%` in the `-c` values (the skills text). So the shim's own
 * target, `node <dir>/node_modules/@openai/codex/bin/codex.js`, runs instead (with the node next to it when there is one).
 */
export function resolveCodexCommand(env: Record<string, string | undefined> = process.env, deps: CodexResolveDeps = {}): CodexCommand {
  // Memoized only on the real file system: a hit costs a stat of the command found for this same PATH (and of its script).
  if (deps.exists) return resolveCodexUncached(env, deps)
  const key = `${deps.platform ?? process.platform}|${deps.home ?? ''}|${env.PATH ?? env.Path ?? ''}`
  const hit = resolvedCodex.get(key)
  const now = Date.now()
  const sigs = (c: CodexCommand): (string | undefined)[] => [fileSig(c.command), ...c.prefix.map((p) => fileSig(p))]
  if (hit && now - hit.at < RESOLVE_TTL_MS && sigs(hit.value).every((s, i) => s !== undefined && s === hit.sigs[i])) return hit.value
  const found = resolveCodexUncached(env, deps)
  const foundSigs = sigs(found)
  if (isAbsolute(found.command) && foundSigs.every((s) => s !== undefined)) {
    if (resolvedCodex.size >= 16) resolvedCodex.clear()
    resolvedCodex.set(key, { value: found, sigs: foundSigs, at: now })
  } else resolvedCodex.delete(key)
  return found
}

/** A hit is re-resolved after this long anyway, so a codex installed earlier on the PATH is eventually preferred. */
const RESOLVE_TTL_MS = 60_000
const resolvedCodex = new Map<string, { value: CodexCommand; sigs: (string | undefined)[]; at: number }>()

function resolveCodexUncached(env: Record<string, string | undefined>, deps: CodexResolveDeps): CodexCommand {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  if (platform === 'win32') {
    for (const dir of dirs) {
      const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (exists(join(dir, 'codex.cmd')) && exists(script)) {
        const node = join(dir, 'node.exe')
        return { command: exists(node) ? node : 'node', prefix: [script] }
      }
      if (exists(join(dir, 'codex.exe'))) return { command: join(dir, 'codex.exe'), prefix: [] }
    }
    return { command: 'codex', prefix: [] }
  }
  for (const dir of dirs) if (isAbsolute(dir) && exists(join(dir, 'codex'))) return { command: join(dir, 'codex'), prefix: [] }
  const home = deps.home ?? homedir()
  for (const dir of [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (exists(join(dir, 'codex'))) return { command: join(dir, 'codex'), prefix: [] }
  }
  return { command: 'codex', prefix: [] }
}

// ---- launch ----

/** The `-c notify=[...]` value: the reporter, run by the plain `node` (same reasoning as the claude hook). */
export function notifyOverride(reporterPath: string = defaultReporterPath()): string {
  return `notify=${tomlStringArray(['node', reporterPath.replace(/\\/g, '/'), 'notify'])}`
}

function plan(input: PlanInput): LaunchPlan {
  const { slot, home, resume, extraArgs, profile } = input
  const cwd = canonicalDir(resume ? resume.cwd : slot.cwd)
  // Inherited CLAUDE* vars belong to a Claude session that launched tether (or the app); Codex does not need them.
  const env = withColorSupport(cleanEnv())
  Object.assign(env, profile?.env ?? {})
  env[ENV_SLOT] = slot.slotId
  env[ENV_AGENT] = 'codex'
  env[ENV_HOME] = home
  const chained = userNotify(codexHome({ env }))
  if (chained) env[ENV_CODEX_NOTIFY] = JSON.stringify(chained)
  else delete env[ENV_CODEX_NOTIFY]
  const { command, prefix } = resolveCodexCommand(env)
  const own = [...(profile?.args ?? []), ...slot.args, ...extraArgs]
  const args = [...prefix, ...(resume ? ['resume', resume.sessionId] : []), '-c', notifyOverride(), ...own]
  return { command, args, cwd, env }
}

// ---- reading Codex's files ----

/** Session ids are UUIDs (v7 today); anything else is never looked up on disk. */
const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The ms timestamp a UUIDv7 carries in its first 48 bits, or undefined for any other version. */
export function uuidV7Time(id: string): number | undefined {
  if (!ID_RE.test(id) || id[14] !== '7') return undefined
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

function dayDir(sessions: string, t: number): string {
  const d = new Date(t)
  return join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
}

function findIn(dir: string, suffix: string): string | undefined {
  let names: string[]
  try { names = readdirSync(dir) } catch { return undefined }
  const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(suffix))
  return hit ? join(dir, hit) : undefined
}

/**
 * The session's rollout (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local ts>-<id>.jsonl). A UUIDv7 says the day (local
 * time, as the folder names are; ±1 day for clocks and midnight), else every day folder is searched.
 */
export function findRollout(sessionId: string, opts?: LookupOptions): string | undefined {
  if (!ID_RE.test(sessionId)) return undefined
  const sessions = join(codexHome(opts), 'sessions')
  const suffix = `-${sessionId}.jsonl`
  const t = uuidV7Time(sessionId)
  if (t !== undefined) {
    for (const delta of [0, -86_400_000, 86_400_000]) {
      const hit = findIn(dayDir(sessions, t + delta), suffix)
      if (hit) return hit
    }
  }
  const sub = (d: string): string[] => { try { return readdirSync(d).sort().reverse() } catch { return [] } }
  for (const y of sub(sessions)) for (const m of sub(join(sessions, y))) for (const d of sub(join(sessions, y, m))) {
    const hit = findIn(join(sessions, y, m, d), suffix)
    if (hit) return hit
  }
  return undefined
}

async function sessionExists(binding: Binding, opts?: LookupOptions): Promise<boolean | 'unknown'> {
  return findRollout(binding.sessionId, opts) !== undefined
}

const CHUNK = 64 * 1024

/** The `thread_name` of the LAST line of session_index.jsonl for `sessionId` (renames append), read backwards. */
export function indexTitle(file: string, sessionId: string): string | undefined {
  const needle = `"id":${JSON.stringify(sessionId)}`
  const fd = openSync(file, 'r')
  try {
    let end = fstatSync(fd).size
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      readSync(fd, chunk, 0, chunk.length, start)
      let data = Buffer.concat([chunk, carry])
      if (start > 0) {
        const nl = data.indexOf(0x0a)
        if (nl === -1) { carry = data; end = start; continue }
        carry = data.subarray(0, nl)
        data = data.subarray(nl + 1)
      }
      const lines = data.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (!line.includes(needle)) continue
        try {
          const o = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
          if (o.id === sessionId && typeof o.thread_name === 'string' && o.thread_name) return o.thread_name
        } catch { /* torn line */ }
      }
      end = start
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

function indexFile(opts?: LookupOptions): string {
  return join(codexHome(opts), 'session_index.jsonl')
}

async function title(binding: Binding, opts?: LookupOptions): Promise<string | undefined> {
  try { return indexTitle(indexFile(opts), binding.sessionId) } catch { return undefined }
}

export const TITLE_POLL_MS = 5_000

/** Titles land in session_index.jsonl, not in the slot's jsonl: polled, re-read only when the file's size changed. */
function watchTitle(binding: Binding, onTitle: (title: string) => void, intervalMs = TITLE_POLL_MS, opts?: LookupOptions): () => void {
  let lastSize = -1
  let lastTitle: string | undefined
  const tick = (): void => {
    const file = indexFile(opts)
    let size: number
    try { size = statSync(file).size } catch { return }
    if (size === lastSize) return
    lastSize = size
    let t: string | undefined
    try { t = indexTitle(file, binding.sessionId) } catch { return }
    if (t !== undefined && t !== lastTitle) {
      lastTitle = t
      onTitle(t)
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return () => clearInterval(timer)
}

export const codexAdapter: AgentAdapter = { name: 'codex', resumes: true, plan, sessionExists, title, watchTitle }

// ---- MCP ----

interface McpFileServer {
  type?: unknown
  url?: unknown
  headers?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
}

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const BEARER_REF = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * One `{ mcpServers }` server as `-c mcp_servers.<name>.*` overrides. HTTP: `url`; an `Authorization: Bearer ${VAR}` header
 * becomes `bearer_token_env_var` (Codex reads the token from its env, as Claude expands `${VAR}`), a header that is exactly
 * `${VAR}` becomes `env_http_headers`, any other header `http_headers`. Stdio: `command`, `args`, `env`, `cwd`.
 */
export function mcpServerOverrides(name: string, s: McpFileServer): string[] {
  const p = `mcp_servers.${tomlKey(name)}`
  const out: string[] = []
  if (typeof s.url === 'string') {
    out.push(`${p}.url=${tomlString(s.url)}`)
    const literal: Record<string, string> = {}
    const fromEnv: Record<string, string> = {}
    if (s.headers && typeof s.headers === 'object') {
      for (const [h, v] of Object.entries(s.headers as Record<string, unknown>)) {
        if (typeof v !== 'string') continue
        const bearer = h.toLowerCase() === 'authorization' ? BEARER_REF.exec(v) : null
        const ref = ENV_REF.exec(v)
        if (bearer) out.push(`${p}.bearer_token_env_var=${tomlString(bearer[1]!)}`)
        else if (ref) fromEnv[h] = ref[1]!
        else literal[h] = v
      }
    }
    if (Object.keys(literal).length) out.push(`${p}.http_headers=${tomlInlineTable(literal)}`)
    if (Object.keys(fromEnv).length) out.push(`${p}.env_http_headers=${tomlInlineTable(fromEnv)}`)
    return out
  }
  if (typeof s.command !== 'string') throw new Error(`servidor MCP "${name}" sem url nem command`)
  out.push(`${p}.command=${tomlString(s.command)}`)
  if (Array.isArray(s.args)) out.push(`${p}.args=${tomlStringArray(s.args.filter((a): a is string => typeof a === 'string'))}`)
  if (s.env && typeof s.env === 'object') {
    const env = Object.fromEntries(Object.entries(s.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
    if (Object.keys(env).length) out.push(`${p}.env=${tomlInlineTable(env)}`)
  }
  if (typeof s.cwd === 'string') out.push(`${p}.cwd=${tomlString(s.cwd)}`)
  return out
}

/**
 * AgentMcp.inject for Codex, which has no `--mcp-config <file>`: the file is read now and each server becomes `-c`
 * overrides appended to the plan (a copy). Same collision rule as withMcpConfigFlag, and Codex itself would let the last
 * override win silently, so every name of the file is checked, declared or not.
 */
export function withCodexMcpOverrides(plan: LaunchPlan, configFile: string, servers?: readonly string[], read: (p: string) => string = (p) => readFileSync(p, 'utf8')): LaunchPlan {
  const parsed = JSON.parse(read(configFile)) as { mcpServers?: Record<string, McpFileServer> }
  const entries = Object.entries(parsed.mcpServers ?? {})
  const taken = plan.mcpServers ?? {}
  const names = servers ?? entries.map(([n]) => n)
  for (const n of names) if (taken[n] !== undefined && taken[n] !== configFile) throw new McpNameCollisionError(n, taken[n], configFile)
  const args = [...plan.args]
  for (const [name, s] of entries) for (const o of mcpServerOverrides(name, s)) args.push('-c', o)
  return { ...plan, args, mcpServers: { ...taken, ...Object.fromEntries(names.map((n) => [n, configFile])) } }
}

// ---- skills ----

/**
 * Codex reads skills only from its own folders (<CODEX_HOME>/skills, the repo's .agents/skills, installed plugins, which
 * it copies into <CODEX_HOME>/plugins/cache): `skills.config` entries only toggle skills it already found. Nothing loads a
 * folder for one launch without touching the user's home, so the skills go in as text through `developer_instructions`
 * (the systemPromptSkills fallback). This replaces a `developer_instructions` of the user's config for these sessions.
 */
export const codexSkills: AgentSkills = {
  inject(plan, bundle) {
    if (!bundle.skills.length) return plan
    return { ...plan, args: [...plan.args, '-c', `developer_instructions=${tomlString(skillsPromptText(bundle.skills))}`] }
  },
}
