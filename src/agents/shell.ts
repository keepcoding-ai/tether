// Shell adapter: a plain interactive shell in the slot's folder. No session to track; "resume" = a new shell
// in the same cwd. The user may pick the shell with SlotMeta.args (e.g. ["C:\\Program Files\\Git\\bin\\bash.exe",
// "--login", "-i"]); otherwise pwsh.exe if on PATH, else powershell.exe (Windows), else $SHELL or /bin/sh (macOS: $SHELL or /bin/zsh, as a login shell).
import { withColorSupport } from './termenv.ts'
import type { SlotMeta } from '../core/event.ts'
import { canonicalDir } from '../core/paths.ts'
import type { Executor } from '../exec/executor.ts'
import { agentExecutor, plainEnv } from './agent-exec.ts'
import type { ProfileLaunch } from '../core/profile.ts'
import type { LaunchPlan } from './types.ts'

export interface ShellPlanInput {
  slot: SlotMeta
  /** Folder to open the shell in (the slot's cwd, or a different one for "resume here"). */
  cwd?: string
  /** The slot's profile: its args name the shell the same way SlotMeta.args do (the slot's own args win). */
  profile?: ProfileLaunch
  /** Does the PATH walk (default: the process-wide executor, see agent-exec.ts). */
  exec?: Executor
}

function envWithoutUndefined(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v
  return out
}

export async function plan(input: ShellPlanInput): Promise<LaunchPlan> {
  const { slot, profile } = input
  // Which shell the slot's (or the profile's) args name is decided by the executor: it stats the paths and walks PATH.
  const shell = await (input.exec ?? agentExecutor()).run('resolveShell', [slot.args, profile?.args, plainEnv()])
  const env = withColorSupport(envWithoutUndefined(process.env))
  Object.assign(env, profile?.env ?? {})
  return {
    command: shell.command,
    args: shell.args,
    cwd: await canonicalDir(input.cwd ?? slot.cwd),
    env,
  }
}

export const shellAdapter = { name: 'shell' as const, plan }
