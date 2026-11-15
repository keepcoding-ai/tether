// Claude Code adapter: how to launch `claude` in a slot so that it reports its sessions to
// tether (hooks injected via --settings, never the user's global settings), and how to read
// what Claude keeps on disk (transcript exists? current title?).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { withColorSupport } from './termenv.ts'
import type { Binding } from '../core/event.ts'
import { canonicalDir } from '../core/paths.ts'
import { ENV_AGENT, ENV_HOME, ENV_SLOT, type AgentAdapter, type LaunchPlan, type LookupOptions, type PlanInput } from './types.ts'

/**
 * The reporter script, next to this module. Read on use, never at load: Electron main bundles this module as CommonJS
 * (through the agent registry that core/profile.ts imports), where `import.meta.url` is undefined and resolving it at
 * load threw before the app could start. Only tetherd (plain ESM) ever writes the hook settings.
 */
function defaultHookPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'report', 'claude-hook.mjs')
}

/** The status line script, next to the reporter (same read-on-use rule as defaultHookPath). */
function defaultStatusLinePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'report', 'claude-statusline.mjs')
}

/**
 * Settings injected with `--settings`: every hook runs the reporter. Forward slashes: the hook runs under Git Bash on Windows.
 * The hook stays on the plain `node` (not on <home>/bin/tetherd.exe like the daemon): it lives ~150 ms per session
 * switch, so a "killall node" in that window loses at most one event (the next SessionStart/SessionEnd reports the
 * session again), while an absolute path into <home>/bin would make every Claude launched by tether depend on that
 * copy being present and current, and on bash quoting of a Windows path, for a failure mode that is worse (every
 * event lost) than the one it avoids.
 */
export function hookSettings(hookPath: string = defaultHookPath(), statusLinePath: string | null = defaultStatusLinePath()): object {
  const script = hookPath.replace(/\\/g, '/')
  const hook = (event: 'SessionStart' | 'SessionEnd' | 'Stop' | 'Notification' | 'UserPromptSubmit' | 'SubagentStart' | 'SubagentStop') => [
    { hooks: [{ type: 'command', command: `node "${script}" ${event}` }] },
  ]
  // PostToolUse fires per tool call: a shell guard keeps Node from spawning unless a polite-pause request or a notice is pending for this slot.
  const postToolUse = [
    {
      matcher: '*',
      hooks: [{ type: 'command', command: `{ test -e "$TETHER_HOME/slots/$TETHER_SLOT_ID.pause-request.json" || test -e "$TETHER_HOME/slots/$TETHER_SLOT_ID.notices.jsonl"; } && node "${script}" PostToolUse || true` }],
    },
  ]
  // Stop / Notification feed the attention badge (turn finished / waiting for the user); UserPromptSubmit marks the turn start.
  const settings: Record<string, unknown> = {
    hooks: {
      SessionStart: hook('SessionStart'),
      SessionEnd: hook('SessionEnd'),
      Stop: hook('Stop'),
      Notification: hook('Notification'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      PostToolUse: postToolUse,
      // A subagent's life (background ones keep the agent "working" after its Stop; see claude-hook.mjs backgroundStep).
      SubagentStart: hook('SubagentStart'),
      SubagentStop: hook('SubagentStop'),
    },
  }
  // Model (loud when it is Fable), effort and cwd. Left out (null) when the user has a status line of their own.
  if (statusLinePath !== null) settings.statusLine = { type: 'command', command: `node "${statusLinePath.replace(/\\/g, '/')}"` }
  return settings
}

/**
 * Writes the injected settings only when their content changed (atomic: temp + rename). Returns the path.
 * Two files: <home>/claude-settings.json (with our status line) and claude-settings.no-statusline.json (without),
 * because `--settings` wins over the user's own statusLine and the choice depends on each launch's cwd.
 */
export function ensureSettingsFile(home: string, withStatusLine = true): string {
  const path = join(home, withStatusLine ? 'claude-settings.json' : 'claude-settings.no-statusline.json')
  const content = JSON.stringify(hookSettings(defaultHookPath(), withStatusLine ? defaultStatusLinePath() : null), null, 2) + '\n'
  let current: string | undefined
  try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
  if (current !== content) {
    mkdirSync(home, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  }
  return path
}

/** True when a settings file defines a statusLine. Missing or malformed JSON counts as none. */
function definesStatusLine(path: string, read: (path: string) => string): boolean {
  try {
    const parsed: unknown = JSON.parse(read(path))
    return typeof parsed === 'object' && parsed !== null && (parsed as { statusLine?: unknown }).statusLine != null
  } catch {
    return false
  }
}

/**
 * Whether the user already has a status line for a launch in `cwd`: user settings (<configDir>/settings.json) or the
 * project's .claude/settings.json / settings.local.json. Then tether leaves theirs alone.
 */
export function userHasStatusLine(cwd: string, configDir: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): boolean {
  return [join(configDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]
    .some((p) => definesStatusLine(p, read))
}

/** Seams of the resolver, so tests can fake the platform, the home, the file system and the login shell. */
export interface ClaudeResolveDeps {
  platform?: NodeJS.Platform
  home?: string
  exists?: (path: string) => boolean
  /** Absolute path of `claude` as the user's login shell sees it, or undefined. */
  loginShell?: (env: Record<string, string | undefined>) => string | undefined
}

/** macOS/Linux: asks the user's interactive login shell where `claude` is (rc files add dirs launchd never sees). */
function claudeFromLoginShell(env: Record<string, string | undefined>): string | undefined {
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

/**
 * Finds the `claude` executable so it can be spawned without a shell. Returns an absolute path whenever it can:
 * a daemon started from the Dock inherits launchd's minimal PATH, which lacks ~/.local/bin (the native install).
 * Order: env PATH, known install dirs, the user's login shell. Falls back to the bare name.
 */
export function resolveClaudeCommand(env: Record<string, string | undefined> = process.env, deps: ClaudeResolveDeps = {}): string {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  const pathVar = env.PATH ?? env.Path ?? ''
  if (platform === 'win32') {
    for (const dir of pathVar.split(delimiter)) {
      if (!dir) continue
      for (const name of ['claude.exe', 'claude.cmd', 'claude']) {
        const candidate = join(dir, name)
        if (exists(candidate)) return candidate
      }
    }
    return 'claude'
  }
  for (const dir of pathVar.split(delimiter)) {
    if (dir && isAbsolute(dir) && exists(join(dir, 'claude'))) return join(dir, 'claude')
  }
  const home = deps.home ?? homedir()
  for (const dir of [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (exists(join(dir, 'claude'))) return join(dir, 'claude')
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

/** `env` with the directory of an absolute `command` prepended to PATH (when missing), keeping every other entry. */
export function withCommandDirOnPath(env: Record<string, string>, command: string, platform: NodeJS.Platform = process.platform): void {
  if (!isAbsolute(command)) return
  const dir = dirname(command)
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const entries = (env[key] ?? '').split(delimiter).filter(Boolean)
  if (entries.includes(dir)) return
  env[key] = [dir, ...entries].join(platform === 'win32' ? ';' : delimiter)
}

/** process.env without any CLAUDE* variable (E0 finding 1: inherited ones make Claude skip the transcript). */
export function cleanEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (/^claude/i.test(k)) continue
    out[k] = v
  }
  return out
}

/** Args that make Claude pick the session itself; `--session-id` is refused next to them (unless forking). */
const PICKS_SESSION = new Set(['-c', '--continue', '-r', '--resume'])

function plan(input: PlanInput): LaunchPlan {
  const { slot, home, resume, extraArgs, profile } = input
  const cwd = canonicalDir(resume ? resume.cwd : slot.cwd)
  const configDir = profile?.env?.CLAUDE_CONFIG_DIR || claudeConfigDir()
  const settings = ensureSettingsFile(home, !userHasStatusLine(cwd, configDir))
  const args = ['--settings', settings]
  // Profile args first (the baseline), the slot's own args, then this launch's: a repeated option takes its last value.
  const own = [...(profile?.args ?? []), ...slot.args, ...extraArgs]
  if (resume) args.push('--resume', resume.sessionId)
  else if (!own.some((a) => PICKS_SESSION.has(a))) args.push('--session-id', randomUUID())
  args.push(...own)
  const env = withColorSupport(cleanEnv())
  // The profile's env goes on AFTER the CLAUDE* strip: an explicit CLAUDE_CONFIG_DIR (a second account) must reach Claude.
  Object.assign(env, profile?.env ?? {})
  env[ENV_SLOT] = slot.slotId
  env[ENV_AGENT] = 'claude'
  env[ENV_HOME] = home
  const command = resolveClaudeCommand(env)
  withCommandDirOnPath(env, command)
  return {
    command,
    args,
    // Canonical even for slots/bindings recorded before the fix (a lower-case drive letter would hide
    // the project's sessions from Claude's /resume picker).
    cwd,
    env,
  }
}

// ---- reading Claude's files ----

/** The slot's CLAUDE_CONFIG_DIR (its profile env) wins over ours; the default is ~/.claude. */
function claudeConfigDir(opts?: LookupOptions): string {
  return opts?.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Claude's project folder name for a cwd: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Path of the session's transcript, or undefined when it is not on disk. */
export function findTranscript(binding: Pick<Binding, 'sessionId' | 'cwd'>, opts?: LookupOptions): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(binding.sessionId)) return undefined
  const projects = join(claudeConfigDir(opts), 'projects')
  const file = `${binding.sessionId}.jsonl`
  const direct = join(projects, encodeProjectDir(binding.cwd), file)
  if (existsSync(direct)) return direct
  let dirs: string[]
  try { dirs = readdirSync(projects) } catch { return undefined }
  for (const d of dirs) {
    const candidate = join(projects, d, file)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function sessionExists(binding: Binding, opts?: LookupOptions): Promise<boolean | 'unknown'> {
  return findTranscript(binding, opts) !== undefined
}

function titleOf(line: string): string | undefined {
  if (!line.includes('"custom-title"')) return undefined
  try {
    const obj: unknown = JSON.parse(line)
    if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'custom-title') {
      const t = (obj as { customTitle?: unknown }).customTitle
      if (typeof t === 'string') return t
    }
  } catch { /* partial or foreign line */ }
  return undefined
}

const CHUNK = 64 * 1024

/** The last {"type":"custom-title"} line of a transcript, read backwards in chunks (transcripts can be MBs). */
export function lastCustomTitle(file: string): string | undefined {
  const fd = openSync(file, 'r')
  try {
    let end = fstatSync(fd).size
    let carry = Buffer.alloc(0) // bytes of the (still incomplete) first line of the chunk above
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
        const t = titleOf(lines[i]!.trimEnd())
        if (t !== undefined) return t
      }
      end = start
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

async function title(binding: Binding, opts?: LookupOptions): Promise<string | undefined> {
  const file = findTranscript(binding, opts)
  if (!file) return undefined
  try { return lastCustomTitle(file) } catch { return undefined }
}

export const TITLE_POLL_MS = 5_000

/**
 * A `/rename` lands in the transcript, not in the slot's jsonl, so the title is polled: one stat per tick,
 * and the transcript is only re-read when its size changed (a session without a title would otherwise be
 * read back to its first line every tick). The transcript may not exist yet at the first ticks.
 */
function watchTitle(binding: Binding, onTitle: (title: string) => void, intervalMs = TITLE_POLL_MS, opts?: LookupOptions): () => void {
  let lastSize = -1
  let lastTitle: string | undefined
  const tick = (): void => {
    const file = findTranscript(binding, opts)
    if (!file) return
    let size: number
    try { size = statSync(file).size } catch { return }
    if (size === lastSize) return
    lastSize = size
    let t: string | undefined
    try { t = lastCustomTitle(file) } catch { return }
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

export const claudeAdapter: AgentAdapter = { name: 'claude', resumes: true, plan, sessionExists, title, watchTitle }
