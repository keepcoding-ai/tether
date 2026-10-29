// soul-cli adapter: how to launch `soul` in a slot so that it reports its sessions to tether
// (SOUL_SESSION_REPORT=<slot jsonl>, written by the soul client itself), and how to resume one
// (the binding's recipe, verbatim: the client knows the flags that find the session: -a, -H, -g, -P...).
// Sessions live on the soul server, so nothing about them can be read locally: sessionExists is 'unknown'
// and the title is whatever the rename events put in the binding.
//
// Finding the executable (resolveSoulCommand):
//   1. TETHER_SOUL_CMD: a full command line ("node D:/x/bin/soul"), for a build that is not installed yet.
//   2. `soul` on PATH. On Windows the installed `soul` is a bash script (#!/usr/bin/env bash) that
//      execs `"$NODE" "$CLI"`: ConPTY cannot run it, so the script is read and its NODE=/CLI= lines
//      become the command (NODE in msys form, /c/..., is converted; when absent or missing on disk,
//      the daemon's own node runs the CLI). A script without a CLI= line runs through Git Bash.
//   3. Elsewhere, or when nothing is found: the bare `soul` (spawn resolves it).
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Binding } from '../core/event.ts'
import { canonicalDir, slotEventsPath } from '../core/paths.ts'
import { findOnPath } from './shell.ts'
import { ENV_HOME, ENV_SLOT, type AgentAdapter, type LaunchPlan, type PlanInput } from './types.ts'

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
  const bash = findOnPath('bash', env) ?? 'bash'
  return { command: bash, args: [script] }
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
  if (!found) return { command: 'soul', args: [] }
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(found) && isScript(found)) {
    return commandFromScript(found, env)
  }
  return { command: found, args: [] }
}

function envWithoutUndefined(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v
  return out
}

function plan(input: PlanInput): LaunchPlan {
  const { slot, home, resume, extraArgs, profile } = input
  const base = resolveSoulCommand()
  const env = envWithoutUndefined(process.env)
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
