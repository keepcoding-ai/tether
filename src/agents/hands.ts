// hands adapter: how to launch `hands` (the client the end customers run, bin/hands) in a slot so that it reports its
// sessions to tether, and how to resume one. Derived from the soul adapter (src/agents/soul.ts) and kept apart on purpose:
// the two programs are distinct products and evolve on their own.
//
// The report: HANDS_SESSION_EVENTS=<slot jsonl> and HANDS_SLOT_ID=<slot id>, the hands' own names (any other name it reads is
// an alias used only when these are unset, so setting these means an inherited value cannot redirect the report). The file
// carries `start`, `rename`, `end`, the `turn` lines (busy|idle, fed to the attention turn) and the `context` lines.
// The resume is the binding's recipe, verbatim (-r <id> and the flags that find the session: -H, -a, --config-dir, -S, -w).
// The sessions live on the server: sessionExists is 'unknown' and the title is whatever the rename events put in the binding.
// The skills: one shared folder in HANDS_SHARED_FOLDERS; over -H the client lends them to the agent as the `shared-skills` MCP.
// Not here, because the hands (0.1.188) does not take them: `--mcp-config` ("unknown option"), `-g`, and the polite pause
// (its request is read only by an in-process engine; the hands is always remote).
//
// Finding the executable (resolveHandsCommand, in exec/ops-hands.ts):
//   1. TETHER_HANDS_CMD: a full command line ("node D:/x/bin/hands"), for a build that is not installed yet.
//   2. `hands` on PATH. On Windows the installed `hands` is a bash script that execs `"$NODE" "$CLI"`: its NODE=/CLI= lines
//      become the command (ConPTY cannot run the script).
//   3. macOS, not on the daemon's PATH: asked of the user's login shell.
//   4. Windows, not on the daemon's PATH: %USERPROFILE%\bin\hands (Git Bash's ~/bin), then Git Bash's login shell.
//   5. Elsewhere, or when nothing is found: the bare `hands`.
// Whichever node the command ends up with runs as <home>/bin/tether-hands.exe (core/exe.ts).
import { delimiter, join } from 'node:path'
import { withColorSupport } from './termenv.ts'
import type { Binding } from '../core/event.ts'
import { exeLog } from '../core/exe.ts'
import type { Executor } from '../exec/executor.ts'
import { canonicalDir, slotEventsPath } from '../core/paths.ts'
import { agentExecutor, plainEnv } from './agent-exec.ts'
import type { AgentSkills } from './skills.ts'
import { ENV_AGENT, ENV_HOME, ENV_SLOT, type AgentAdapter, type LaunchPlan, type PlanInput } from './types.ts'

export const ENV_HANDS_CMD = 'TETHER_HANDS_CMD'
export const ENV_HANDS_REPORT = 'HANDS_SESSION_EVENTS'
export const ENV_HANDS_SLOT = 'HANDS_SLOT_ID'
export const HANDS_SHARED_FOLDERS_ENV = 'HANDS_SHARED_FOLDERS'

export interface HandsCommand {
  command: string
  args: string[]
}

/** The hands command: resolved by the executor (PATH, the installed bash launcher, a login shell), memoized there. */
export function resolveHandsCommand(env: Record<string, string | undefined> = process.env, exec: Executor = agentExecutor()): Promise<HandsCommand> {
  return exec.run('resolveHands', [plainEnv(env)])
}

/** The launch command with its node replaced by <home>/bin/tether-hands.exe when it is a node at all; the log lines go to `log`. */
export async function resolveHandsLaunch(home: string, exec: Executor = agentExecutor(), log: (msg: string) => void = exeLog(home, 'hands')): Promise<HandsCommand> {
  const r = await exec.run('handsLaunch', [plainEnv(process.env), home])
  for (const line of r.logs) log(line)
  return r.command
}

function envWithoutUndefined(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v
  return out
}

async function plan(input: PlanInput): Promise<LaunchPlan> {
  const { slot, home, resume, extraArgs, profile } = input
  const base = await resolveHandsLaunch(home, input.exec ?? agentExecutor())
  const env = withColorSupport(envWithoutUndefined(process.env))
  Object.assign(env, profile?.env ?? {})
  const profileArgs = profile?.args ?? []
  if (resume?.resume) {
    // The recipe finds the session; the profile is the baseline under it (a repeated option takes its last value), the slot's
    // own args go last. -c/--continue is dropped: it picks a session by itself and would contradict the recipe's -r.
    const recipe = resume.resume
    Object.assign(env, recipe.env ?? {})
    const own = slot.args.filter((a) => a !== '-c' && a !== '--continue')
    return withReport({ command: base.command, args: [...base.args, ...profileArgs, ...recipe.args, ...own], cwd: await canonicalDir(recipe.cwd), env })
  }
  if (resume) {
    // A binding without a recipe: the id alone, in the binding's folder.
    return withReport({ command: base.command, args: [...base.args, ...profileArgs, '-r', resume.sessionId, ...slot.args], cwd: await canonicalDir(resume.cwd), env })
  }
  return withReport({ command: base.command, args: [...base.args, ...profileArgs, ...slot.args, ...extraArgs], cwd: await canonicalDir(slot.cwd), env })

  /** The slot's identity goes on last: nothing from a profile or a recipe may redirect the report. */
  function withReport(p: LaunchPlan): LaunchPlan {
    p.env[ENV_HANDS_REPORT] = slotEventsPath(home, slot.slotId)
    p.env[ENV_HANDS_SLOT] = slot.slotId
    p.env[ENV_SLOT] = slot.slotId
    p.env[ENV_AGENT] = 'hands'
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

export const handsAdapter: AgentAdapter = { name: 'hands', resumes: true, plan, sessionExists, title }

/** The tether's skills as one shared folder, `<home>/skills/hands`, appended to what HANDS_SHARED_FOLDERS already holds. */
export const handsSkills: AgentSkills = {
  async inject(plan, bundle) {
    if (!bundle.skills.length) return plan
    const dir = await bundle.exec.run('materializeSkills', [{ target: join(bundle.home, 'skills', 'hands'), version: bundle.version, layout: 'shared', skills: bundle.skills.map(s => ({ name: s.name, dir: s.dir })) }])
    const current = plan.env[HANDS_SHARED_FOLDERS_ENV]?.trim()
    const value = current ? `${current}${delimiter}${dir}` : dir
    return { ...plan, env: { ...plan.env, [HANDS_SHARED_FOLDERS_ENV]: value } }
  },
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
