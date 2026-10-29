// Claude Code adapter: how to launch `claude` in a slot so that it reports its sessions to
// tether (hooks injected via --settings, never the user's global settings), and how to read
// what Claude keeps on disk (transcript exists? current title?).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Binding } from '../core/event.ts'
import { ENV_HOME, ENV_SLOT, type AgentAdapter, type LaunchPlan, type PlanInput } from './types.ts'

const HOOK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'report', 'claude-hook.mjs')

/** Settings injected with `--settings`: both hooks run the reporter. Forward slashes: the hook runs under Git Bash on Windows. */
export function hookSettings(hookPath: string = HOOK_PATH): object {
  const script = hookPath.replace(/\\/g, '/')
  const hook = (event: 'SessionStart' | 'SessionEnd') => [
    { hooks: [{ type: 'command', command: `node "${script}" ${event}` }] },
  ]
  return { hooks: { SessionStart: hook('SessionStart'), SessionEnd: hook('SessionEnd') } }
}

/** Writes <home>/claude-settings.json only when its content changed (atomic: temp + rename). Returns the path. */
export function ensureSettingsFile(home: string): string {
  const path = join(home, 'claude-settings.json')
  const content = JSON.stringify(hookSettings(), null, 2) + '\n'
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

/** Finds the `claude` executable on PATH so it can be spawned without a shell. Falls back to the bare name. */
export function resolveClaudeCommand(env: Record<string, string | undefined> = process.env): string {
  if (process.platform !== 'win32') return 'claude'
  const pathVar = env.PATH ?? env.Path ?? ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    for (const name of ['claude.exe', 'claude.cmd', 'claude']) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return 'claude'
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

function plan(input: PlanInput): LaunchPlan {
  const { slot, home, resume, extraArgs } = input
  const settings = ensureSettingsFile(home)
  const args = ['--settings', settings]
  if (resume) args.push('--resume', resume.sessionId)
  else args.push('--session-id', randomUUID())
  args.push(...slot.args, ...extraArgs)
  const env = cleanEnv()
  env[ENV_SLOT] = slot.slotId
  env[ENV_HOME] = home
  return {
    command: resolveClaudeCommand(env),
    args,
    cwd: resume ? resume.cwd : slot.cwd,
    env,
  }
}

// ---- reading Claude's files ----

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Claude's project folder name for a cwd: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Path of the session's transcript, or undefined when it is not on disk. */
export function findTranscript(binding: Pick<Binding, 'sessionId' | 'cwd'>): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(binding.sessionId)) return undefined
  const projects = join(claudeConfigDir(), 'projects')
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

async function sessionExists(binding: Binding): Promise<boolean | 'unknown'> {
  return findTranscript(binding) !== undefined
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

async function title(binding: Binding): Promise<string | undefined> {
  const file = findTranscript(binding)
  if (!file) return undefined
  try { return lastCustomTitle(file) } catch { return undefined }
}

export const claudeAdapter: AgentAdapter = { name: 'claude', plan, sessionExists, title }
