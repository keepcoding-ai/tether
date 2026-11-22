// Operations of the agent adapters (claude, codex, soul, shell, skills): everything that walks PATH, stats, reads, copies or
// runs a login shell to decide a launch. Synchronous on purpose: they run inside an executor worker (lane `work` for the
// long ones: login shells, copies, tree walks; `io` for the short ones). Exempt area of the sync ratchet; the coordinator
// never imports this file. The plain functions are exported for the tests that exercise them with injected seams.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import path from 'node:path'
import { homedir } from 'node:os'
import type { ExeName } from '../core/exe.ts'
import { ensureRenamedNode as ensureRenamedNodeSync, fileSig, isNodeExecutable, isRenamedNode } from '../core/exe-sync.ts'
import { parseTopLevelNotify, type CodexCommand } from '../agents/codex.ts'
import { parseFrontmatter, type TetherSkill } from '../agents/skills.ts'
import { defaultShell, findOnPath } from '../agents/shell-sync.ts'
import { ENV_SOUL_CMD, fromMsysPath, splitCommandLine, type Command } from '../agents/soul.ts'
import type { EnvMap, MaterializeSpec, RenamedNodeReply, SkillsLoad } from './protocol.ts'

// ---- claude ----

export interface ClaudeResolveDeps {
  platform?: NodeJS.Platform
  home?: string
  exists?: (path: string) => boolean
  /** Absolute path of `claude` as the user's login shell sees it, or undefined. */
  loginShell?: (env: EnvMap) => string | undefined
}

/** macOS/Linux: asks the user's interactive login shell where `claude` is (rc files add dirs launchd never sees). */
function claudeFromLoginShell(env: EnvMap): string | undefined {
  const shell = env.SHELL
  if (!shell) return undefined
  try {
    const out = execFileSync(shell, ['-lic', 'command -v claude'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.trim().split('\n').pop()?.trim()
    return line && isAbsolute(line) && existsSync(line) ? line : undefined
  } catch {
    return undefined
  }
}

const loginShellCache = new Map<string, string>() // keyed by $SHELL; a miss is not cached (claude may get installed meanwhile)

/** A hit is re-resolved after this long anyway, so a `claude` installed earlier on the PATH is eventually preferred. */
export const RESOLVE_TTL_MS = 60_000
const resolvedClaude = new Map<string, { path: string; sig: string; at: number }>()
/** Drops the memoized resolution (tests; a changed PATH already misses by key). */
export function clearClaudeResolveCache(): void { resolvedClaude.clear() }

/**
 * Finds the `claude` executable so it can be spawned without a shell. Returns an absolute path whenever it can:
 * a daemon started from the Dock inherits launchd's minimal PATH, which lacks ~/.local/bin (the native install).
 * Order: env PATH, known install dirs, the user's login shell. Falls back to the bare name.
 */
export function resolveClaudeCommand(env: EnvMap = process.env, deps: ClaudeResolveDeps = {}): string {
  // Memoized only on the real file system: a hit costs one stat of the binary found earlier for this same PATH.
  if (deps.exists || deps.loginShell) return resolveClaudeUncached(env, deps)
  const key = `${deps.platform ?? process.platform}\0${deps.home ?? ''}\0${env.SHELL ?? ''}\0${env.PATH ?? env.Path ?? ''}`
  const hit = resolvedClaude.get(key)
  const now = Date.now()
  if (hit && now - hit.at < RESOLVE_TTL_MS && fileSig(hit.path) === hit.sig) return hit.path
  const found = resolveClaudeUncached(env, deps)
  const sig = path.isAbsolute(found) ? fileSig(found) : undefined
  if (sig !== undefined) {
    if (resolvedClaude.size >= 16) resolvedClaude.clear()
    resolvedClaude.set(key, { path: found, sig, at: now })
  } else resolvedClaude.delete(key)
  return found
}

function resolveClaudeUncached(env: EnvMap, deps: ClaudeResolveDeps): string {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  const pathVar = env.PATH ?? env.Path ?? ''
  // Path flavor follows the injected platform, not the host's.
  const P = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') {
    for (const dir of pathVar.split(P.delimiter)) {
      if (!dir) continue
      for (const name of ['claude.exe', 'claude.cmd', 'claude']) {
        const candidate = P.join(dir, name)
        if (exists(candidate)) return candidate
      }
    }
    return 'claude'
  }
  for (const dir of pathVar.split(P.delimiter)) {
    if (dir && P.isAbsolute(dir) && exists(P.join(dir, 'claude'))) return P.join(dir, 'claude')
  }
  const home = deps.home ?? homedir()
  for (const dir of [P.join(home, '.local', 'bin'), P.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (exists(P.join(dir, 'claude'))) return P.join(dir, 'claude')
  }
  const shell = env.SHELL ?? ''
  const cached = loginShellCache.get(shell)
  if (cached && exists(cached)) return cached
  const found = (deps.loginShell ?? claudeFromLoginShell)(env)
  if (found) {
    if (!deps.loginShell) loginShellCache.set(shell, found)
    return found
  }
  return 'claude'
}

const settingsFileCache = new Map<string, { content: string; sig: string | undefined }>()

/**
 * Writes `content` at `file` only when it differs (atomic: temp + rename). A file whose size and mtime are what this
 * process last saw (written or verified) with the same content is the same file: one stat instead of a read.
 */
export function ensureSettingsFile(file: string, content: string): string {
  const known = settingsFileCache.get(file)
  if (known && known.content === content && known.sig !== undefined && fileSig(file) === known.sig) return file
  let current: string | undefined
  try { current = readFileSync(file, 'utf8') } catch { /* missing */ }
  if (current !== content) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, file)
  }
  if (settingsFileCache.size >= 16) settingsFileCache.clear()
  settingsFileCache.set(file, { content, sig: fileSig(file) })
  return file
}

// ---- codex ----

const notifyCache = new Map<string, { sig: string; value: string[] | undefined }>()

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

export interface CodexResolveDeps {
  platform?: NodeJS.Platform
  home?: string
  exists?: (path: string) => boolean
}

const CODEX_TTL_MS = 60_000
const resolvedCodex = new Map<string, { value: CodexCommand; sigs: (string | undefined)[]; at: number }>()

/**
 * Finds codex so it can be spawned without a shell. On Windows the npm install is a `codex.cmd` shim: running it would put
 * cmd.exe between us and Codex, and cmd mangles quotes and `%` in the `-c` values (the skills text). So the shim's own
 * target, `node <dir>/node_modules/@openai/codex/bin/codex.js`, runs instead (with the node next to it when there is one).
 */
export function resolveCodexCommand(env: EnvMap = process.env, deps: CodexResolveDeps = {}): CodexCommand {
  if (deps.exists) return resolveCodexUncached(env, deps)
  const key = `${deps.platform ?? process.platform}|${deps.home ?? ''}|${env.PATH ?? env.Path ?? ''}`
  const hit = resolvedCodex.get(key)
  const now = Date.now()
  const sigs = (c: CodexCommand): (string | undefined)[] => [fileSig(c.command), ...c.prefix.map((p) => fileSig(p))]
  if (hit && now - hit.at < CODEX_TTL_MS && sigs(hit.value).every((s, i) => s !== undefined && s === hit.sigs[i])) return hit.value
  const found = resolveCodexUncached(env, deps)
  const foundSigs = sigs(found)
  if (isAbsolute(found.command) && foundSigs.every((s) => s !== undefined)) {
    if (resolvedCodex.size >= 16) resolvedCodex.clear()
    resolvedCodex.set(key, { value: found, sigs: foundSigs, at: now })
  } else resolvedCodex.delete(key)
  return found
}

function resolveCodexUncached(env: EnvMap, deps: CodexResolveDeps): CodexCommand {
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

// ---- shell ----

/** The slot's args name a shell when the first one is an executable path or a command found on PATH. */
export function shellFromArgs(args: readonly string[], env: EnvMap = process.env): Command | undefined {
  const first = args[0]
  if (!first) return undefined
  if (existsSync(first)) return { command: first, args: args.slice(1) }
  const found = findOnPath(first, env)
  if (found) return { command: found, args: args.slice(1) }
  return undefined
}

/** The shell of a launch: the slot's args, else the profile's, else the platform default. */
export function resolveShell(slotArgs: readonly string[], profileArgs: readonly string[] | undefined, env: EnvMap): Command {
  return shellFromArgs(slotArgs, env) ?? (profileArgs ? shellFromArgs(profileArgs, env) : undefined) ?? defaultShell(env)
}

// ---- soul ----

function isScript(file: string): boolean {
  try {
    return readFileSync(file).subarray(0, 2).toString('latin1') === '#!'
  } catch {
    return false
  }
}

/** `NAME="value"` or `NAME=value` at the start of a line of a shell script. */
function scriptVar(text: string, name: string): string | undefined {
  const m = new RegExp(`^${name}=(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`, 'm').exec(text)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** Turns the installed bash launcher into something ConPTY can spawn. */
export function commandFromScript(script: string, env: EnvMap): Command {
  const text = readFileSync(script, 'utf8')
  const cli = scriptVar(text, 'CLI')
  if (cli) {
    const node = scriptVar(text, 'NODE')
    const nodePath = node ? fromMsysPath(node) : undefined
    return { command: nodePath && existsSync(nodePath) ? nodePath : process.execPath, args: [cli] }
  }
  const bash = findGitBash(env) ?? 'bash'
  return { command: bash, args: [script] }
}

/** Git for Windows' bash.exe (never WSL's System32 bash.exe, which runs Linux, not the msys scripts). */
export function findGitBash(env: EnvMap): string | undefined {
  const candidates: string[] = []
  const git = findOnPath('git', env)
  if (git) candidates.push(join(dirname(git), '..', 'bin', 'bash.exe'), join(dirname(git), 'bash.exe'))
  const onPath = findOnPath('bash', env)
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) candidates.push(onPath)
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
  }
  return candidates.find((c) => existsSync(c))
}

/** Windows: `soul` where Git Bash finds it (~/bin, or its login shell's PATH and aliases). Undefined when it cannot tell. */
export function soulFromGitBash(env: EnvMap): Command | undefined {
  const home = env.USERPROFILE || env.HOME
  if (home) {
    const inHomeBin = join(home, 'bin', 'soul')
    if (existsSync(inHomeBin)) return fromFound(inHomeBin)
  }
  const bash = findGitBash(env)
  if (!bash) return undefined
  try {
    const out = execFileSync(bash, ['-lic', 'command -v soul'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const line = out.trim().split('\n').pop()?.trim()
    if (!line) return undefined
    const found = fromMsysPath(line)
    if (isAbsolute(found) && existsSync(found)) return fromFound(found)
    return { command: bash, args: ['-lic', 'soul "$@"', 'soul'] } // alias or shell function
  } catch {
    return undefined
  }

  function fromFound(file: string): Command {
    if (!/\.(exe|cmd|bat)$/i.test(file) && isScript(file)) return commandFromScript(file, env)
    return { command: file, args: [] }
  }
}

const soulLoginShellCache = new Map<string, Command | undefined>()

/** macOS: `soul` as the user's interactive login shell sees it (rc files, aliases). Undefined when it cannot tell. */
export function soulFromLoginShell(env: EnvMap): Command | undefined {
  const shell = env.SHELL // no $SHELL, no lookup: an env that names no shell is not the user's session
  if (!shell) return undefined
  if (soulLoginShellCache.has(shell)) return soulLoginShellCache.get(shell)
  const found = askLoginShell(shell, env)
  if (found) soulLoginShellCache.set(shell, found) // a miss is not cached: soul may get installed meanwhile
  return found
}

function askLoginShell(shell: string, env: EnvMap): Command | undefined {
  try {
    const out = execFileSync(shell, ['-lic', 'command -v soul'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.trim().split('\n').pop()?.trim()
    if (!line) return undefined
    if (isAbsolute(line) && existsSync(line)) return { command: line, args: [] }
    return { command: shell, args: ['-lic', 'soul "$@"', 'soul'] } // alias or shell function
  } catch {
    return undefined
  }
}

const SOUL_RESOLVE_TTL_MS = 60_000
const resolvedSoul = new Map<string, { value: Command; paths: string[]; sigs: (string | undefined)[]; at: number }>()
/** Drops the memoized resolution (tests). */
export function clearSoulResolveCache(): void { resolvedSoul.clear() }

export function resolveSoulCommand(env: EnvMap = process.env): Command {
  // Memoized by the inputs that decide it; a hit costs one stat per absolute path of the command (the program and a script it runs).
  const key = [process.platform, env[ENV_SOUL_CMD] ?? '', env.PATH ?? env.Path ?? '', env.USERPROFILE ?? '', env.HOME ?? '', env.SHELL ?? ''].join('|')
  const hit = resolvedSoul.get(key)
  const now = Date.now()
  const pathsOf = (c: Command): string[] => [c.command, ...c.args].filter((a) => isAbsolute(a))
  if (hit && now - hit.at < SOUL_RESOLVE_TTL_MS && hit.sigs.every((s, i) => s !== undefined && s === fileSig(hit.paths[i]!))) return { command: hit.value.command, args: [...hit.value.args] }
  const found = resolveSoulUncached(env)
  const paths = pathsOf(found)
  const sigs = paths.map((p) => fileSig(p))
  if (paths.length && isAbsolute(found.command) && sigs.every((s) => s !== undefined)) {
    if (resolvedSoul.size >= 16) resolvedSoul.clear()
    resolvedSoul.set(key, { value: found, paths, sigs, at: now })
  } else resolvedSoul.delete(key)
  return found
}

function resolveSoulUncached(env: EnvMap): Command {
  const custom = env[ENV_SOUL_CMD]?.trim()
  if (custom) {
    const [first, ...rest] = splitCommandLine(custom)
    if (!first) throw new Error(`${ENV_SOUL_CMD} vazio`)
    const command = existsSync(first) || isAbsolute(first) ? first : (findOnPath(first, env) ?? first)
    return { command, args: rest }
  }
  const found = findOnPath('soul', env)
  if (!found) {
    const fallback = process.platform === 'darwin' ? soulFromLoginShell(env) : process.platform === 'win32' ? soulFromGitBash(env) : undefined
    return fallback ?? { command: 'soul', args: [] }
  }
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(found) && isScript(found)) {
    return commandFromScript(found, env)
  }
  return { command: found, args: [] }
}

/**
 * The command with its node replaced by <home>/bin/tether-soul.exe, when it is a node at all (a `soul.exe` or a
 * bash launcher is left alone). The daemon may itself be a renamed node (tetherd.exe): the node it was made
 * from is in TETHER_NODE, and the soul's copy comes from that one, never from another copy. On macOS no copy exists
 * (core/exe.ts: dyld refuses it) and the name goes through the shell (`exec -a`).
 */
export function withRenamedNode(cmd: Command, home: string, env: EnvMap = process.env, log: (msg: string) => void = () => {}): Command {
  if (!isNodeExecutable(cmd.command)) return cmd
  const source = isRenamedNode(cmd.command) ? (env.TETHER_NODE?.trim() || cmd.command) : cmd.command
  const exe = ensureRenamedNodeSync(home, 'tether-soul', source, log)
  if (exe.argv0) return { command: '/bin/sh', args: ['-c', `exec -a ${exe.argv0} "$0" "$@"`, exe.path, ...cmd.args] }
  return { command: exe.path, args: cmd.args }
}

/** The soul command of a launch: resolved on `env`, its node renamed for `home`. The log lines come back for the caller to write. */
export function soulLaunch(env: EnvMap, home: string): { command: Command; logs: string[] } {
  const logs: string[] = []
  return { command: withRenamedNode(resolveSoulCommand(env), home, env, (m) => logs.push(m)), logs }
}

// ---- renamed node ----

export function renamedNode(home: string, name: ExeName, source: string, platform: NodeJS.Platform): RenamedNodeReply {
  const logs: string[] = []
  const result = ensureRenamedNodeSync(home, name, source, (m) => logs.push(m), platform)
  return { result, logs }
}

// ---- skills ----

/** The skills of a library folder (one subfolder per skill); a folder without a valid SKILL.md is skipped and reported. */
export function loadSkills(libraryDir: string, log: (msg: string) => void = () => {}): TetherSkill[] {
  let entries: string[]
  try { entries = readdirSync(libraryDir).sort() } catch { return [] }
  const out: TetherSkill[] = []
  for (const entry of entries) {
    const dir = join(libraryDir, entry)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const meta = parseFrontmatter(text)
    if (!meta || meta.name !== entry) { log(`skill ${entry} ignorada: o SKILL.md precisa de "name: ${entry}" no cabeçalho`); continue }
    out.push({ name: meta.name, description: meta.description, dir, text })
  }
  return out
}

/** A cheap fingerprint of the skills (names, sizes and mtimes of every file). */
export function skillsVersion(skills: readonly TetherSkill[]): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else parts.push(`${p}:${st.size}:${st.mtimeMs}`)
    }
  }
  for (const s of skills) walk(s.dir)
  return parts.join('|')
}

export function loadSkillsSnapshot(library: string): SkillsLoad {
  const logs: string[] = []
  const skills = loadSkills(library, (m) => logs.push(m))
  return { skills, version: skillsVersion(skills), logs }
}

/** What each target's stamp looked like when this worker last saw it right: the version, and the stamp file's size and mtime. */
const materialized = new Map<string, { version: string; sig: string }>()

/**
 * Writes an agent's copy of the skills at `spec.target` when the version differs from the one recorded there (staging +
 * rename: an agent starting meanwhile never sees half a folder). Returns `target`. A stamp this worker already verified
 * (same version, same size and mtime) is trusted with one stat instead of a read.
 */
export function materializeSkills(spec: MaterializeSpec): string {
  const { target, version } = spec
  const stamp = join(target, '.tether-version')
  const known = materialized.get(target)
  if (known?.version === version && known.sig === fileSig(stamp)) return target
  try {
    if (readFileSync(stamp, 'utf8') === version) {
      const sig = fileSig(stamp)
      if (sig) materialized.set(target, { version, sig })
      return target
    }
  } catch { /* first time or changed */ }
  const staging = `${target}.${process.pid}.tmp`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  if (spec.layout === 'claude-plugin') {
    mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
    writeFileSync(join(staging, '.claude-plugin', 'plugin.json'), spec.pluginJson ?? '{}')
  }
  const skillsDir = join(staging, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  for (const s of spec.skills) cpSync(s.dir, join(skillsDir, s.name), { recursive: true })
  writeFileSync(join(staging, '.tether-version'), version)
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  const sig = fileSig(stamp)
  if (sig) materialized.set(target, { version, sig })
  return target
}

export const agentOps = {
  resolveClaude: (env: EnvMap): string => resolveClaudeCommand(env),
  resolveCodex: (env: EnvMap): CodexCommand => resolveCodexCommand(env),
  ensureSettingsFile: (file: string, content: string): string => ensureSettingsFile(file, content),
  userNotify: (home: string): string[] | undefined => userNotify(home),
  resolveShell: (slotArgs: string[], profileArgs: string[] | undefined, env: EnvMap): Command => resolveShell(slotArgs, profileArgs, env),
  resolveSoul: (env: EnvMap): Command => resolveSoulCommand(env),
  soulLaunch: (env: EnvMap, home: string): { command: Command; logs: string[] } => soulLaunch(env, home),
  renamedNode: (home: string, name: ExeName, source: string, platform: NodeJS.Platform): RenamedNodeReply => renamedNode(home, name, source, platform),
  loadSkills: (library: string): SkillsLoad => loadSkillsSnapshot(library),
  materializeSkills: (spec: MaterializeSpec): string => materializeSkills(spec),
}
