// soul-cli adapter: how to launch `soul` in a slot so that it reports its sessions to tether
// (SOUL_SESSION_REPORT=<slot jsonl>, written by the soul client itself), and how to resume one
// (the binding's recipe, verbatim: the client knows the flags that find the session: -a, -H, -g, -P...).
// Sessions live on the soul server, so nothing about them can be read locally: sessionExists is 'unknown'
// and the title is whatever the rename events put in the binding.
// The same file also carries the client's `turn` lines (busy|idle, written on every change): the daemon feeds them to
// the attention turn (daemon/attention.ts `signal`), and from the first one the Enter / quiet heuristic stands down.
// The polite pause request (<slot>.pause-request.json) is read by the client itself, which answers in <slot>.pause.jsonl
// (client: resume/pause-request.ts); TETHER_HOME and TETHER_SLOT_ID, set below, are how it finds them.
//
// Finding the executable (resolveSoulCommand):
//   1. TETHER_SOUL_CMD: a full command line ("node D:/x/bin/soul"), for a build that is not installed yet.
//   2. `soul` on PATH. On Windows the installed `soul` is a bash script (#!/usr/bin/env bash) that
//      execs `"$NODE" "$CLI"`: ConPTY cannot run it, so the script is read and its NODE=/CLI= lines
//      become the command (NODE in msys form, /c/..., is converted; when absent or missing on disk,
//      the daemon's own node runs the CLI). A script without a CLI= line runs through Git Bash.
//   3. macOS, `soul` not on the daemon's PATH (an alias or a PATH set in the user's rc files): asked of the
//      user's login shell; an alias/function runs through `$SHELL -lic 'soul "$@"'`.
//   4. Windows, `soul` not on the daemon's PATH: the installed launcher lives in Git Bash's ~/bin, which only
//      Git Bash puts on PATH (the app and its daemon get the Windows PATH, without it). Looked up in
//      %USERPROFILE%in, then asked of Git Bash's login shell (`bash -lic 'command -v soul'`); the script found
//      goes through step 2. Without this, the bare `soul` fails to spawn and the panel never opens.
//   5. Elsewhere, or when nothing is found: the bare `soul` (spawn resolves it).
// Whichever node the command ends up with runs as <home>/bin/tether-soul.exe (core/exe.ts): a panel of the
// soul survives a "kill every node.exe" and shows its own name in the Task Manager.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { withColorSupport } from './termenv.ts'
import type { Binding } from '../core/event.ts'
import { ensureRenamedNode, exeLog, isNodeExecutable, isRenamedNode } from '../core/exe.ts'
import { canonicalDir, slotEventsPath } from '../core/paths.ts'
import { findOnPath } from './shell.ts'
import { ENV_AGENT, ENV_HOME, ENV_SLOT, type AgentAdapter, type LaunchPlan, type PlanInput } from './types.ts'

export const ENV_SOUL_CMD = 'TETHER_SOUL_CMD'
export const ENV_SOUL_REPORT = 'SOUL_SESSION_REPORT'

export interface Command {
  command: string
  args: string[]
}

/** Splits a command line on whitespace; double or single quotes keep a token whole (no escapes, no $expansion). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | undefined
  let inToken = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(cur)
      cur = ''
      inToken = false
    } else {
      cur += ch
      inToken = true
    }
  }
  if (inToken) out.push(cur)
  return out
}

/** `/c/Users/x` (msys) → `C:/Users/x`; anything else is returned as is. */
export function fromMsysPath(p: string): string {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p)
  return m ? `${m[1]!.toUpperCase()}:/${m[2]}` : p
}

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
export function commandFromScript(script: string, env: Record<string, string | undefined>): Command {
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

/** Git for Windows' bash.exe (never WSL's System32ash.exe, which runs Linux, not the msys scripts). */
export function findGitBash(env: Record<string, string | undefined>): string | undefined {
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
export function soulFromGitBash(env: Record<string, string | undefined>): Command | undefined {
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
    const path = fromMsysPath(line)
    if (isAbsolute(path) && existsSync(path)) return fromFound(path)
    return { command: bash, args: ['-lic', 'soul "$@"', 'soul'] } // alias or shell function
  } catch {
    return undefined
  }

  function fromFound(path: string): Command {
    if (!/\.(exe|cmd|bat)$/i.test(path) && isScript(path)) return commandFromScript(path, env)
    return { command: path, args: [] }
  }
}

/** macOS: `soul` as the user's interactive login shell sees it (rc files, aliases). Undefined when it cannot tell. */
const loginShellCache = new Map<string, Command | undefined>()

export function soulFromLoginShell(env: Record<string, string | undefined>): Command | undefined {
  const shell = env.SHELL // no $SHELL, no lookup: an env that names no shell is not the user's session
  if (!shell) return undefined
  if (loginShellCache.has(shell)) return loginShellCache.get(shell)
  const found = askLoginShell(shell, env)
  if (found) loginShellCache.set(shell, found) // a miss is not cached: soul may get installed meanwhile
  return found
}

function askLoginShell(shell: string, env: Record<string, string | undefined>): Command | undefined {
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

export function resolveSoulCommand(env: Record<string, string | undefined> = process.env): Command {
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
 * from is in TETHER_NODE, and the soul's copy comes from that one, never from another copy.
 *
 * On macOS no copy exists (core/exe.ts: dyld refuses it) and node-pty has no argv0 of its own (its argv[0] is
 * always the file), so the name goes through the shell: `/bin/sh -c 'exec -a tether-soul "$0" "$@"' node args…`.
 * /bin/sh there is bash (or zsh), both with `exec -a`; the shell is replaced by the node, not kept in between.
 */
export function withRenamedNode(cmd: Command, home: string, env: Record<string, string | undefined> = process.env, log: (msg: string) => void = exeLog(home, 'soul')): Command {
  if (!isNodeExecutable(cmd.command)) return cmd
  const source = isRenamedNode(cmd.command) ? (env.TETHER_NODE?.trim() || cmd.command) : cmd.command
  const exe = ensureRenamedNode(home, 'tether-soul', source, log)
  if (exe.argv0) return argv0Command(exe.argv0, exe.path, cmd.args)
  return { command: exe.path, args: cmd.args }
}

/** `/bin/sh -c 'exec -a <name> "$0" "$@"' <file> <args…>`: runs `file` with `name` as its argv[0]. */
export function argv0Command(name: string, file: string, args: string[]): Command {
  return { command: '/bin/sh', args: ['-c', `exec -a ${name} "$0" "$@"`, file, ...args] }
}

function envWithoutUndefined(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v
  return out
}

function plan(input: PlanInput): LaunchPlan {
  const { slot, home, resume, extraArgs, profile } = input
  const base = withRenamedNode(resolveSoulCommand(), home)
  const env = withColorSupport(envWithoutUndefined(process.env))
  Object.assign(env, profile?.env ?? {})
  const profileArgs = profile?.args ?? []
  if (resume?.resume) {
    // The recipe finds the session (-r, -a, -H, -g/--config-dir, -P...); the profile is the baseline it goes on top of
    // (a repeated option takes its last value in soul: a profile edited to another -P must not hide the session), and the
    // slot's own args still apply last (--strategy, --model, -n), as in the Claude adapter. -c/--continue is dropped: it
    // picks a session by itself and would contradict the -r of the recipe.
    const recipe = resume.resume
    Object.assign(env, recipe.env ?? {})
    const own = slot.args.filter((a) => a !== '-c' && a !== '--continue')
    return withReport({ command: base.command, args: [...base.args, ...profileArgs, ...recipe.args, ...own], cwd: canonicalDir(recipe.cwd), env })
  }
  if (resume) {
    // A binding without a recipe (older event): the id alone, in the binding's folder.
    return withReport({ command: base.command, args: [...base.args, ...profileArgs, '-r', resume.sessionId, ...slot.args], cwd: canonicalDir(resume.cwd), env })
  }
  return withReport({ command: base.command, args: [...base.args, ...profileArgs, ...slot.args, ...extraArgs], cwd: canonicalDir(slot.cwd), env })

  /** The slot's identity goes on last: nothing from a profile or a recipe may redirect the report. */
  function withReport(p: LaunchPlan): LaunchPlan {
    p.env[ENV_SOUL_REPORT] = slotEventsPath(home, slot.slotId)
    p.env[ENV_SLOT] = slot.slotId
    p.env[ENV_AGENT] = 'soul'
    p.env[ENV_HOME] = home
    return p
  }
}

async function sessionExists(_binding: Binding): Promise<boolean | 'unknown'> {
  return 'unknown'
}

async function title(binding: Binding): Promise<string | undefined> {
  return binding.title
}

export const soulAdapter: AgentAdapter = { name: 'soul', plan, sessionExists, title }
