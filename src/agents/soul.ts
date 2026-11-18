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
import { withColorSupport } from './termenv.ts'
import type { Binding } from '../core/event.ts'
import { exeLog } from '../core/exe.ts'
import type { Executor } from '../exec/executor.ts'
import { canonicalDir, slotEventsPath } from '../core/paths.ts'
import { agentExecutor, plainEnv } from './agent-exec.ts'
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

/**
 * The soul command: resolved by the executor (PATH, the installed bash launcher, Git Bash's or the login shell's `command -v`,
 * which can take seconds), memoized there and revalidated by stat. See ops-agents.ts resolveSoulCommand.
 */
export function resolveSoulCommand(env: Record<string, string | undefined> = process.env, exec: Executor = agentExecutor()): Promise<Command> {
  return exec.run('resolveSoul', [plainEnv(env)])
}

/**
 * The launch command with its node replaced by <home>/bin/tether-soul.exe when it is a node at all (a `soul.exe` or a bash
 * launcher is left alone); the copy is made by the executor and its log lines go to `log`. The daemon may itself be a renamed
 * node (tetherd.exe): the node it was made from is in TETHER_NODE, and the soul's copy comes from that one.
 * On macOS no copy exists (core/exe.ts: dyld refuses it) and the name goes through the shell (`exec -a`, see argv0Command).
 */
export async function resolveSoulLaunch(home: string, exec: Executor = agentExecutor(), log: (msg: string) => void = exeLog(home, 'soul')): Promise<Command> {
  const r = await exec.run('soulLaunch', [plainEnv(process.env), home])
  for (const line of r.logs) log(line)
  return r.command
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

async function plan(input: PlanInput): Promise<LaunchPlan> {
  const { slot, home, resume, extraArgs, profile } = input
  const base = await resolveSoulLaunch(home, input.exec ?? agentExecutor())
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
    return withReport({ command: base.command, args: [...base.args, ...profileArgs, ...recipe.args, ...own], cwd: await canonicalDir(recipe.cwd), env })
  }
  if (resume) {
    // A binding without a recipe (older event): the id alone, in the binding's folder.
    return withReport({ command: base.command, args: [...base.args, ...profileArgs, '-r', resume.sessionId, ...slot.args], cwd: await canonicalDir(resume.cwd), env })
  }
  return withReport({ command: base.command, args: [...base.args, ...profileArgs, ...slot.args, ...extraArgs], cwd: await canonicalDir(slot.cwd), env })

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

export const soulAdapter: AgentAdapter = { name: 'soul', resumes: true, plan, sessionExists, title }
