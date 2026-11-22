// Claude Code adapter: how to launch `claude` in a slot so that it reports its sessions to
// tether (hooks injected via --settings, never the user's global settings), and how to read
// what Claude keeps on disk (transcript exists? current title?).
import { access, open, readdir, stat } from 'node:fs/promises'
import path, { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { withColorSupport } from './termenv.ts'
import type { Binding } from '../core/event.ts'
import type { Executor } from '../exec/executor.ts'
import { agentExecutor, plainEnv } from './agent-exec.ts'
import { perf } from '../core/perf.ts'
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
  // Model (loud when it is Fable), effort and cwd. Left out (null) only by callers that want hooks alone.
  if (statusLinePath !== null) settings.statusLine = { type: 'command', command: `node "${statusLinePath.replace(/\\/g, '/')}"` }
  return settings
}

/** Contents of the injected settings files, per path: a pure function of this module's location, built once. */
const settingsContent = new Map<string, string>()

/**
 * Makes sure the injected settings file exists with the right content (the executor writes it, atomic: temp + rename) and
 * returns its path: <home>/claude-settings.json, always with our status line. `--settings` wins over the user's own
 * statusLine, so claude-statusline.mjs chains the user's command after ours (see there).
 */
export async function ensureSettingsFile(home: string, exec: Executor = agentExecutor()): Promise<string> {
  const file = join(home, 'claude-settings.json')
  let content = settingsContent.get(file)
  if (content === undefined) {
    content = JSON.stringify(hookSettings(defaultHookPath(), defaultStatusLinePath()), null, 2) + '\n'
    settingsContent.set(file, content)
  }
  return exec.run('ensureSettingsFile', [file, content])
}

/**
 * Finds the `claude` executable so it can be spawned without a shell: PATH, known install dirs, the user's login shell
 * (a `bash -lic` that can take seconds, so the executor runs it). Falls back to the bare name. See ops-agents.ts.
 */
export function resolveClaudeCommand(env: Record<string, string | undefined> = process.env, exec: Executor = agentExecutor()): Promise<string> {
  return exec.run('resolveClaude', [plainEnv(env)])
}

/** `env` with the directory of an absolute `command` prepended to PATH (when missing), keeping every other entry. */
export function withCommandDirOnPath(env: Record<string, string>, command: string, platform: NodeJS.Platform = process.platform): void {
  const P = platform === 'win32' ? path.win32 : path.posix
  if (!P.isAbsolute(command)) return
  const dir = P.dirname(command)
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const entries = (env[key] ?? '').split(P.delimiter).filter(Boolean)
  if (entries.includes(dir)) return
  env[key] = [dir, ...entries].join(P.delimiter)
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

async function plan(input: PlanInput): Promise<LaunchPlan> {
  const { slot, home, resume, extraArgs, profile } = input
  const cwd = await canonicalDir(resume ? resume.cwd : slot.cwd)
  const ex = input.exec ?? agentExecutor()
  const settings = await ensureSettingsFile(home, ex)
  const args = ['--settings', settings]
  // Profile args first (the baseline), the slot's own args, then this launch's: a repeated option takes its last value.
  const own = [...(profile?.args ?? []), ...slot.args, ...extraArgs]
  if (resume) args.push('--resume', resume.sessionId)
  else if (!own.some((a) => PICKS_SESSION.has(a))) args.push('--session-id', randomUUID())
  args.push(...own)
  const env = withColorSupport(cleanEnv())
  // Every Bash call starts back in the pane's folder: an agent's `cd` never moves the pane's origin (tether keys on it).
  // Before the profile's env, so a profile can still turn it off.
  env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1'
  // The profile's env goes on AFTER the CLAUDE* strip: an explicit CLAUDE_CONFIG_DIR (a second account) must reach Claude.
  Object.assign(env, profile?.env ?? {})
  env[ENV_SLOT] = slot.slotId
  env[ENV_AGENT] = 'claude'
  env[ENV_HOME] = home
  const command = await resolveClaudeCommand(env, ex)
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
export function claudeConfigDir(opts?: LookupOptions): string {
  return opts?.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Claude's project folder name for a cwd: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Test seams for the async lookup. */
export interface AsyncLookupDeps {
  /** false = only the direct path (the projects-dir scan is skipped). Default true. */
  scan?: boolean
  readdir?: (dir: string) => Promise<string[]>
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

/** Path of the session's transcript, or undefined when it is not on disk. Never stalls the event loop on the ~hundreds of project dirs. */
export async function findTranscriptAsync(binding: Pick<Binding, 'sessionId' | 'cwd'>, opts?: LookupOptions, deps: AsyncLookupDeps = {}): Promise<string | undefined> {
  if (!/^[A-Za-z0-9-]+$/.test(binding.sessionId)) return undefined
  const projects = join(claudeConfigDir(opts), 'projects')
  const file = `${binding.sessionId}.jsonl`
  const direct = join(projects, encodeProjectDir(binding.cwd), file)
  if (await exists(direct)) return direct
  if (deps.scan === false) return undefined
  let dirs: string[]
  try { dirs = await (deps.readdir ?? readdir)(projects) } catch { return undefined }
  for (const d of dirs) {
    const candidate = join(projects, d, file)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

async function sessionExists(binding: Binding, opts?: LookupOptions): Promise<boolean | 'unknown'> {
  return (await findTranscriptAsync(binding, opts)) !== undefined
}

export function titleOf(line: string): string | undefined {
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

export const CHUNK = 64 * 1024

/** The last {"type":"custom-title"} line of a transcript, read backwards in chunks (transcripts can be MBs). */
export async function lastCustomTitleAsync(file: string): Promise<string | undefined> {
  const fh = await open(file, 'r')
  try {
    let end = (await fh.stat()).size
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      await fh.read(chunk, 0, chunk.length, start)
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
    await fh.close()
  }
}

async function title(binding: Binding, opts?: LookupOptions): Promise<string | undefined> {
  const file = await findTranscriptAsync(binding, opts)
  if (!file) return undefined
  try { return await lastCustomTitleAsync(file) } catch { return undefined }
}

export const TITLE_POLL_MS = 5_000
/** While the transcript is not found, the full projects-dir scan runs at most this often per watcher. */
export const FULL_SCAN_MS = 60_000

export interface WatchTitleDeps extends AsyncLookupDeps {
  now?: () => number
  fullScanMs?: number
}

/**
 * A `/rename` lands in the transcript, not in the slot's jsonl, so the title is polled: one stat per tick,
 * and the transcript is only re-read when its size changed (a session without a title would otherwise be
 * read back to its first line every tick). The transcript may not exist yet at the first ticks.
 * Everything is async (the daemon shares its loop with terminal echo): the resolved path is cached, a miss
 * re-checks only the direct path each tick and does the full scan at most once per FULL_SCAN_MS, and a tick
 * is skipped while the previous one is still running.
 */
export function watchTitleWith(binding: Binding, onTitle: (title: string) => void, intervalMs: number, opts: LookupOptions | undefined, deps: WatchTitleDeps = {}): () => void {
  const now = deps.now ?? Date.now
  const fullScanMs = deps.fullScanMs ?? FULL_SCAN_MS
  let lastSize = -1
  let lastTitle: string | undefined
  let cached: string | undefined
  let lastScanAt = -Infinity
  let running = false
  let stopped = false
  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      let file = cached
      let size: number | undefined
      if (file) {
        try { size = (await stat(file)).size } catch { cached = undefined; file = undefined }
      }
      if (!file) {
        const scan = now() - lastScanAt >= fullScanMs
        file = await findTranscriptAsync(binding, opts, { scan, readdir: deps.readdir })
        if (scan) lastScanAt = now()
        if (!file) return
        try { size = (await stat(file)).size } catch { return }
        cached = file
        lastSize = -1 // a new file: never compare against the old one's size
      }
      if (size === lastSize) return
      lastSize = size!
      let t: string | undefined
      try { t = await lastCustomTitleAsync(file) } catch { return }
      if (!stopped && t !== undefined && t !== lastTitle) {
        lastTitle = t
        onTitle(t)
      }
    } finally {
      running = false
    }
  }
  const timer = setInterval(perf.wrap('title:claude', () => { void tick() }), intervalMs)
  timer.unref()
  void tick()
  return () => { stopped = true; clearInterval(timer) }
}

function watchTitle(binding: Binding, onTitle: (title: string) => void, intervalMs = TITLE_POLL_MS, opts?: LookupOptions): () => void {
  return watchTitleWith(binding, onTitle, intervalMs, opts)
}

export const claudeAdapter: AgentAdapter = { name: 'claude', resumes: true, plan, sessionExists, title, watchTitle }
