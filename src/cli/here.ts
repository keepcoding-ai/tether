// `--here`: run the slot's agent in THIS terminal (stdio inherited) instead of a tetherd PTY. The plan comes
// from the same adapters the daemon uses (so the hooks/report still record the slot's events), the run file
// says who holds the slot while it runs, and the agent's exit code becomes ours.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import '../agents/load.ts'
import { agentRegistry } from '../agents/registry.ts'
import { shellAdapter } from '../agents/shell.ts'
import type { AgentAdapter, LaunchPlan } from '../agents/types.ts'
import type { Binding, SlotMeta } from '../core/event.ts'
import { processStartTime } from '../core/liveness.ts'
import { readProfiles, slotProfile, snapshotProfile, type SlotProfile } from '../core/profile.ts'
import { clearRun, writeRun, writeSlotMeta } from '../core/store.ts'

/** The agent's adapter from the registry; throws (Portuguese) when the agent is not registered. */
export function adapterOf(agent: string): AgentAdapter {
  const adapter = agentRegistry.get(agent)?.adapter
  if (!adapter) throw new Error(`o agente ${agent} não está disponível (extensão desativada ou ausente)`)
  return adapter
}

/** The slot's profile as the daemon would apply it now (current profile, else the snapshot); refreshes the snapshot. */
export function profileFor(home: string, meta: SlotMeta): SlotProfile {
  const profiles = readProfiles(home).profiles
  const current = profiles.find((p) => p.id === meta.profileId)
  if (current && snapshotProfile(meta, current)) {
    try { writeSlotMeta(home, meta) } catch { /* the launch still uses the current profile */ }
  }
  return slotProfile(meta, profiles)
}

export function planFor(home: string, meta: SlotMeta, resume: Binding | undefined, extraArgs: string[]): LaunchPlan {
  const profile = profileFor(home, meta).launch
  if (meta.agent === 'shell') return shellAdapter.plan({ slot: meta, cwd: resume?.cwd, profile })
  return adapterOf(meta.agent).plan({ slot: meta, home, resume, extraArgs, profile })
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
