// `--here`: run the slot's agent in THIS terminal (stdio inherited) instead of a tetherd PTY. The plan comes
// from the same adapters the daemon uses (so the hooks/report still record the slot's events), the run file
// says who holds the slot while it runs, and the agent's exit code becomes ours.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { claudeAdapter } from '../agents/claude.ts'
import { shellAdapter } from '../agents/shell.ts'
import { soulAdapter } from '../agents/soul.ts'
import type { AgentAdapter, LaunchPlan } from '../agents/types.ts'
import type { Binding, SlotMeta } from '../core/event.ts'
import { processStartTime } from '../core/liveness.ts'
import { clearRun, writeRun } from '../core/store.ts'

export const adapters: Record<'claude' | 'soul', AgentAdapter> = { claude: claudeAdapter, soul: soulAdapter }

export function planFor(home: string, meta: SlotMeta, resume: Binding | undefined, extraArgs: string[]): LaunchPlan {
  if (meta.agent === 'shell') return shellAdapter.plan({ slot: meta, cwd: resume?.cwd })
  return adapters[meta.agent].plan({ slot: meta, home, resume, extraArgs })
}

/** `.cmd`/`.bat` need a shell on Windows (Node refuses to spawn them directly); args are quoted for it. */
function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

function quoteForShell(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

export interface RunHereResult {
  exitCode: number
}

/** Spawns the plan with inherited stdio and waits for it. Rejects when the spawn itself fails. */
export async function runHere(home: string, slotId: string, plan: LaunchPlan): Promise<RunHereResult> {
  if (!existsSync(plan.cwd)) throw new Error(`a pasta não existe: ${plan.cwd}`)
  const startedAt = (await processStartTime(process.pid)) ?? new Date().toISOString()
  const shell = needsShell(plan.command)
  const child = spawn(
    shell ? quoteForShell(plan.command) : plan.command,
    shell ? plan.args.map(quoteForShell) : plan.args,
    { cwd: plan.cwd, env: plan.env, stdio: 'inherit', shell, windowsHide: false },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  const run = { pid: process.pid, startedAt, ...(child.pid !== undefined ? { agentPid: child.pid } : {}) }
  writeRun(home, slotId, run)
  // Ctrl+C goes to the child through the shared console; we only wait for it to leave.
  const ignore = (): void => {}
  process.on('SIGINT', ignore)
  try {
    const exitCode = await new Promise<number>((resolve) => {
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    return { exitCode }
  } finally {
    process.off('SIGINT', ignore)
    clearRun(home, slotId)
  }
}
