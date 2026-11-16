// Read-only inventory of what CAN enter a Claude Code prompt for a folder, straight from disk (no network, no
// Claude). Only the known directories are visited. Nothing secret is ever carried into the returned objects:
// MCP servers keep name + transport only; hook/statusLine commands pass through redactSecrets.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { cleanEnv, resolveClaudeCommand } from '../agents/claude.ts'

/** Files bigger than this are stat'ed (their size counts) but not read. */
export const MAX_READ_BYTES = 256 * 1024
/** ~/.claude.json grows with history; it is read once per mtime+size and projected to server names right away. */
const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024

export interface InventoryFile {
  path: string
  bytes: number
  mtimeMs: number
}

/** Rough size in tokens (chars/4, rounded up). Always an estimate. */
export interface TokenEstimate {
  tokens: number
  estimated: true
}

export interface InventoryMemoryFile extends InventoryFile, TokenEstimate {
  kind: 'user' | 'project' | 'local' | 'import'
}

export interface InventorySkill extends InventoryFile {
  name: string
  scope: 'project' | 'user'
  description: string
  /** What stays in the prompt: name + description. */
  promptTokens: number
  /** What only enters when the skill is invoked: the body after the frontmatter. */
  bodyTokens: number
  estimated: true
}

export interface InventoryAgent extends InventoryFile {
  name: string
  scope: 'project' | 'user'
  description: string
  promptTokens: number
  bodyTokens: number
  estimated: true
}

export interface InventoryCommand extends InventoryFile, TokenEstimate {
  name: string
  scope: 'project' | 'user'
  description: string
}

export interface InventoryMcpServer {
  name: string
  /** stdio | http | sse | ... as declared (or inferred from command/url); never args, env, headers or URLs. */
  transport: string
  source: 'project-file' | 'claude-json-project' | 'claude-json-user' | 'codex-config'
}

export interface InventoryHook {
  event: string
  count: number
  /** Redacted, capped. */
  commands: string[]
}

export interface Inventory {
  cwd: string
  claudeVersion: string
  memory: InventoryMemoryFile[]
  skills: InventorySkill[]
  agents: InventoryAgent[]
  commands: InventoryCommand[]
  mcpServers: InventoryMcpServer[]
  hooks: InventoryHook[]
  statusLine: { command: string } | undefined
  plugins: string[]
  /** Every file that feeds the inventoryKey (path + size + mtime). */
  files: InventoryFile[]
}

export interface InventoryOptions {
  home?: string
  /** User config dir; default <home>/.claude. */
  configDir?: string
  /** Injected in tests; otherwise `claude --version` runs once per process. */
  claudeVersion?: string
  maxReadBytes?: number
}

export const estimate = (chars: number): number => Math.ceil(chars / 4)

// ---------- secrets ----------

const SECRET_NAME = /(token|secret|key|passw(or)?d|passwd|auth|credential|cookie|bearer)/i

/** Masks anything shaped like a credential in a command line. Conservative: false positives are fine. */
export function redactSecrets(text: string, max = 300): string {
  let s = text
  s = s.replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
  s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (m, name: string) => (SECRET_NAME.test(name) ? `${name}=[redacted]` : m))
  s = s.replace(/(--?[A-Za-z][\w-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/g, (m, flag: string, sep: string) => (SECRET_NAME.test(flag) ? `${flag}${sep}[redacted]` : m))
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_\w{10,}|github_pat_\w+|xox[a-z]-[\w-]+|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w.-]+)/g, '[redacted]')
  s = s.replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, '[redacted]')
  return s.length > max ? `${s.slice(0, max)}...` : s
}

// ---------- fs helpers ----------

export async function statFile(path: string): Promise<InventoryFile | undefined> {
  try {
    const st = await stat(path)
    return st.isFile() ? { path, bytes: st.size, mtimeMs: st.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

export async function readText(file: InventoryFile, max: number): Promise<string | undefined> {
  if (file.bytes > max) return undefined
  try {
    return await readFile(file.path, 'utf8')
  } catch {
    return undefined
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

async function readJson(file: InventoryFile | undefined, max: number): Promise<unknown> {
  if (!file) return undefined
  const text = await readText(file, max)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------- frontmatter ----------

export interface Frontmatter {
  fields: Record<string, string>
  /** Characters of the frontmatter block, delimiters included. */
  length: number
}

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '')
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return { fields: {}, length: 0 }
  const fields: Record<string, string> = {}
  const lines = (m[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '')
    if (!kv) continue
    let value = (kv[2] ?? '').trim()
    const block = /^[>|][+-]?$/.test(value)
    if (block || value === '') {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) parts.push((lines[++i] ?? '').trim())
      value = parts.join(' ')
    }
    fields[kv[1] as string] = value.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  return { fields, length: m[0].length }
}

// ---------- memory chain ----------

const IMPORT_RE = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])?[\w.\\/~-]+\.[\w-]+|(?:~\/|\.{1,2}\/)[\w.\\/~-]+)/g

function importsOf(text: string, fileDir: string, home: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const m of line.replaceAll(/`[^`]*`/g, ' ').matchAll(IMPORT_RE)) {
      const raw = (m[1] ?? '').replace(/[.,;:)]+$/, '')
      if (!raw) continue
      out.push(raw.startsWith('~/') ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(fileDir, raw))
    }
  }
  return out
}

async function readMemory(cwd: string, home: string, configDir: string, max: number): Promise<InventoryMemoryFile[]> {
  const candidates: { path: string; kind: InventoryMemoryFile['kind'] }[] = [{ path: join(configDir, 'CLAUDE.md'), kind: 'user' }]
  const dirs: string[] = []
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.push(d)
    if (dirname(d) === d) break
  }
  // Root first, like Claude's own ordering: farther files load earlier.
  for (const d of dirs.reverse()) {
    candidates.push({ path: join(d, 'CLAUDE.md'), kind: 'project' }, { path: join(d, '.claude', 'CLAUDE.md'), kind: 'project' }, { path: join(d, 'CLAUDE.local.md'), kind: 'local' })
  }
  const found = (await Promise.all(candidates.map(async (c) => ({ c, f: await statFile(c.path) })))).filter((x) => x.f)
  const seen = new Set<string>()
  const result: InventoryMemoryFile[] = []
  const importPaths: string[] = []
  for (const { c, f } of found) {
    if (!f || seen.has(f.path.toLowerCase())) continue
    seen.add(f.path.toLowerCase())
    result.push({ ...f, kind: c.kind, tokens: estimate(f.bytes), estimated: true })
    const text = await readText(f, max)
    if (text) importPaths.push(...importsOf(text, dirname(f.path), home))
  }
  const imports = await Promise.all([...new Set(importPaths)].map(statFile))
  for (const f of imports) {
    if (!f || seen.has(f.path.toLowerCase())) continue
    seen.add(f.path.toLowerCase())
    result.push({ ...f, kind: 'import', tokens: estimate(f.bytes), estimated: true })
  }
  return result
}

// ---------- skills / agents / commands ----------

export async function readSkills(dir: string, scope: 'project' | 'user', max: number): Promise<InventorySkill[]> {
  const names = await listDir(dir)
  const out = await Promise.all(names.map(async (n): Promise<InventorySkill | undefined> => {
    const f = await statFile(join(dir, n, 'SKILL.md'))
    if (!f) return undefined
    const text = await readText(f, max)
    const fm = parseFrontmatter(text ?? '')
    const name = fm.fields.name || n
    const description = fm.fields.description ?? ''
    const bodyChars = text === undefined ? f.bytes : Math.max(0, text.length - fm.length)
    return { ...f, name, scope, description, promptTokens: estimate(name.length + description.length), bodyTokens: estimate(bodyChars), estimated: true }
  }))
  return out.filter((x): x is InventorySkill => !!x)
}

async function readAgents(dir: string, scope: 'project' | 'user', max: number): Promise<InventoryAgent[]> {
  const names = (await listDir(dir)).filter((n) => n.toLowerCase().endsWith('.md'))
  const out = await Promise.all(names.map(async (n): Promise<InventoryAgent | undefined> => {
    const f = await statFile(join(dir, n))
    if (!f) return undefined
    const text = await readText(f, max)
    const fm = parseFrontmatter(text ?? '')
    const name = fm.fields.name || basename(n, '.md')
    const description = fm.fields.description ?? ''
    const bodyChars = text === undefined ? f.bytes : Math.max(0, text.length - fm.length)
    return { ...f, name, scope, description, promptTokens: estimate(name.length + description.length), bodyTokens: estimate(bodyChars), estimated: true }
  }))
  return out.filter((x): x is InventoryAgent => !!x)
}

async function readCommands(dir: string, scope: 'project' | 'user', max: number): Promise<InventoryCommand[]> {
  const names = (await listDir(dir)).filter((n) => n.toLowerCase().endsWith('.md'))
  const out = await Promise.all(names.map(async (n): Promise<InventoryCommand | undefined> => {
    const f = await statFile(join(dir, n))
    if (!f) return undefined
    const text = await readText(f, max)
    return { ...f, name: basename(n, '.md'), scope, description: parseFrontmatter(text ?? '').fields.description ?? '', tokens: estimate(f.bytes), estimated: true }
  }))
  return out.filter((x): x is InventoryCommand => !!x)
}

// ---------- settings / MCP ----------

interface SettingsView {
  hooks: Map<string, string[]>
  statusLine: string | undefined
  plugins: Set<string>
}

function foldSettings(into: SettingsView, json: unknown): void {
  if (!isObj(json)) return
  if (isObj(json.hooks)) {
    for (const [event, groups] of Object.entries(json.hooks)) {
      if (!Array.isArray(groups)) continue
      const list = into.hooks.get(event) ?? []
      for (const g of groups) {
        const hooks = isObj(g) && Array.isArray(g.hooks) ? g.hooks : []
        for (const h of hooks) {
          if (isObj(h)) list.push(typeof h.command === 'string' ? redactSecrets(h.command) : `[${String(h.type ?? 'hook')}]`)
        }
      }
      into.hooks.set(event, list)
    }
  }
  if (isObj(json.statusLine) && typeof json.statusLine.command === 'string') into.statusLine = redactSecrets(json.statusLine.command)
  if (isObj(json.enabledPlugins)) {
    for (const [id, on] of Object.entries(json.enabledPlugins)) {
      if (on === true) into.plugins.add(id)
      else into.plugins.delete(id)
    }
  }
}

function transportOf(server: unknown): string {
  if (!isObj(server)) return 'unknown'
  if (typeof server.type === 'string') return server.type
  if (typeof server.command === 'string') return 'stdio'
  if (typeof server.url === 'string') return 'http'
  return 'unknown'
}

/** Names + transport only: env, headers, args and URLs never leave this function. */
function projectServers(obj: unknown, source: InventoryMcpServer['source']): InventoryMcpServer[] {
  if (!isObj(obj)) return []
  return Object.entries(obj).map(([name, server]) => ({ name, transport: transportOf(server), source }))
}

interface ClaudeJsonProjection {
  user: InventoryMcpServer[]
  projects: Map<string, InventoryMcpServer[]>
}

let claudeJsonCache: { path: string; mtimeMs: number; bytes: number; value: ClaudeJsonProjection } | undefined

async function readClaudeJson(path: string): Promise<ClaudeJsonProjection | undefined> {
  const f = await statFile(path)
  if (!f) return undefined
  if (claudeJsonCache && claudeJsonCache.path === path && claudeJsonCache.mtimeMs === f.mtimeMs && claudeJsonCache.bytes === f.bytes) return claudeJsonCache.value
  const json = await readJson(f, MAX_CLAUDE_JSON_BYTES)
  if (!isObj(json)) return undefined
  const projects = new Map<string, InventoryMcpServer[]>()
  if (isObj(json.projects)) {
    for (const [key, entry] of Object.entries(json.projects)) {
      if (isObj(entry)) projects.set(normalizePath(key), projectServers(entry.mcpServers, 'claude-json-project'))
    }
  }
  const value = { user: projectServers(json.mcpServers, 'claude-json-user'), projects }
  claudeJsonCache = { path, mtimeMs: f.mtimeMs, bytes: f.bytes, value }
  return value
}

const normalizePath = (p: string) => resolve(p).replaceAll('\\', '/').toLowerCase()

// ---------- claude version ----------

let versionPromise: Promise<string> | undefined

export function claudeVersion(): Promise<string> {
  versionPromise ??= new Promise<string>((done) => {
    try {
      const env = cleanEnv()
      execFile(resolveClaudeCommand(env), ['--version'], { env, timeout: 10_000, windowsHide: true, shell: false }, (err, stdout) => {
        const v = err ? '' : /\d+\.\d+\.\d+\S*/.exec(String(stdout))?.[0]
        if (!v) versionPromise = undefined // a failure is not cached: claude may get installed later
        done(v || 'unknown')
      })
    } catch {
      versionPromise = undefined
      done('unknown')
    }
  })
  return versionPromise
}

// ---------- entry points ----------

export async function readInventory(cwd: string, opts: InventoryOptions = {}): Promise<Inventory> {
  const home = opts.home ?? homedir()
  const configDir = opts.configDir ?? join(home, '.claude')
  const max = opts.maxReadBytes ?? MAX_READ_BYTES
  const root = resolve(cwd)
  const projectClaude = join(root, '.claude')

  const settingsPaths = [join(configDir, 'settings.json'), join(projectClaude, 'settings.json'), join(projectClaude, 'settings.local.json')]
  const [version, memory, projectSkills, userSkills, projectAgents, userAgents, projectCommands, userCommands, settingsFiles, mcpFile, claudeJson] = await Promise.all([
    opts.claudeVersion !== undefined ? Promise.resolve(opts.claudeVersion) : claudeVersion(),
    readMemory(root, home, configDir, max),
    readSkills(join(projectClaude, 'skills'), 'project', max),
    readSkills(join(configDir, 'skills'), 'user', max),
    readAgents(join(projectClaude, 'agents'), 'project', max),
    readAgents(join(configDir, 'agents'), 'user', max),
    readCommands(join(projectClaude, 'commands'), 'project', max),
    readCommands(join(configDir, 'commands'), 'user', max),
    Promise.all(settingsPaths.map(statFile)),
    statFile(join(root, '.mcp.json')),
    readClaudeJson(join(home, '.claude.json')),
  ])

  const view: SettingsView = { hooks: new Map(), statusLine: undefined, plugins: new Set() }
  const settingsJson = await Promise.all(settingsFiles.map((f) => readJson(f, max)))
  for (const j of settingsJson) foldSettings(view, j)

  const mcpJson = await readJson(mcpFile, max)
  const mcpServers: InventoryMcpServer[] = [
    ...projectServers(isObj(mcpJson) ? mcpJson.mcpServers : undefined, 'project-file'),
    ...(claudeJson?.projects.get(normalizePath(root)) ?? []),
    ...(claudeJson?.user ?? []),
  ]

  const skills = [...projectSkills, ...userSkills]
  const agents = [...projectAgents, ...userAgents]
  const commands = [...projectCommands, ...userCommands]
  const files: InventoryFile[] = [
    ...memory, ...skills, ...agents, ...commands,
    ...settingsFiles.filter((f): f is InventoryFile => !!f),
    ...(mcpFile ? [mcpFile] : []),
  ].map((f) => ({ path: f.path, bytes: f.bytes, mtimeMs: f.mtimeMs }))

  return {
    cwd: root,
    claudeVersion: version,
    memory, skills, agents, commands, mcpServers,
    hooks: [...view.hooks].map(([event, commands]) => ({ event, count: commands.length, commands })),
    statusLine: view.statusLine === undefined ? undefined : { command: view.statusLine },
    plugins: [...view.plugins].sort(),
    files,
  }
}

/**
 * Stable hash that changes only when something relevant does: Claude's version, path+size+mtime of every file that
 * feeds the prompt, and the MCP server list. ~/.claude.json itself is deliberately NOT stamped (Claude rewrites it
 * on every session); only the server names/transports taken from it count.
 */
export function inventoryKey(inv: Inventory): string {
  const files = inv.files.map((f) => [f.path.toLowerCase(), f.bytes, Math.round(f.mtimeMs)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const mcp = inv.mcpServers.map((s) => `${s.source}:${s.name}:${s.transport}`).sort()
  const payload = JSON.stringify({ v: inv.claudeVersion, files, mcp, plugins: inv.plugins })
  return createHash('sha256').update(payload).digest('hex')
}
