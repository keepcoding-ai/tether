// Recipe → launch plan for tether-procd. The environment is tetherd's own, cleaned of what ties a process to a
// panel or an agent session, plus colour support, plus the recipe's env: nothing comes from the caller's shell.
// The command is resolved here (PATH, PATHEXT-like .exe/.cmd/.bat); a .cmd/.bat shortcut is wrapped in cmd.exe
// with ONE raw argument string (node-pty re-quotes an args array and breaks inner quotes).
// The lookups that stat the disk (planFor) are in proc-launch-sync.ts, which only the executor's operation imports.
import { agentExecutor } from '../agents/agent-exec.ts'
import { withColorSupport } from '../agents/termenv.ts'
import type { ProcPlan } from '../procd/protocol.ts'
import type { RecipeFields } from './procs.ts'

export class LaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchError'
  }
}

const DROPPED = new Set(['TETHER_SLOT_ID', 'TETHER_TAB_URL', 'TETHER_OPEN_CWD', 'TETHER_AGENT'])

export function procEnv(base: NodeJS.ProcessEnv, recipeEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROPPED.has(k.toUpperCase()) || k.toUpperCase().startsWith('CLAUDE')) continue
    env[k] = v
  }
  withColorSupport(env)
  return Object.assign(env, recipeEnv)
}

/** cmd.exe quoting for one argument of the line: quoted when it has a space, a quote or is empty; inner quotes doubled. */
export function cmdQuote(arg: string): string {
  return arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/**
 * planFor on the executor: the PATH lookup and the folder check stat the disk, so a caller on the tetherd loop awaits this
 * instead of the synchronous planFor above. A LaunchError raised in the worker comes back as a LaunchError.
 */
export async function planForAsync(recipe: Pick<RecipeFields, 'command' | 'args' | 'cwd' | 'env'>, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<ProcPlan> {
  try {
    return await agentExecutor().run('procPlan', [{ command: recipe.command, args: recipe.args, cwd: recipe.cwd, env: recipe.env }, { ...base }, platform])
  } catch (e) {
    if (e instanceof Error && e.name === 'LaunchError') throw new LaunchError(e.message)
    throw e
  }
}
