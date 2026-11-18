// Is the process recorded in RunInfo still the same process?
// PID alone is not enough (Windows reuses PIDs quickly), so we also compare the OS start time.
//
// The start time comes from the OS through the executor's `startTime` operation (src/exec/ops-os.ts): on Windows a resident
// PowerShell helper answers over stdin/stdout, started on the first query and living in the executor's `work` worker, so
// neither creating that process nor waiting for it touches the caller's event loop. A process without a registered executor
// (the CLI) gets the inline one, where the helper lives in its own loop, as before.
import { agentExecutor } from '../agents/agent-exec.ts'
import type { RunInfo } from './event.ts'

export type { StartTimeMethod } from '../exec/protocol.ts'

export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The process' start time as the OS reports it, normalized to an ISO-8601 UTC string with millisecond
 * precision so two readings of the same process compare equal. Undefined when the pid does not exist
 * or the OS refuses to tell.
 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (!pidExists(pid)) return undefined
  const raw = await agentExecutor().run('startTime', [pid])
  return normalize(raw ?? undefined)
}

/** True only when the pid exists AND was started when RunInfo says: a reused pid gives false. */
export function isAlive(run: RunInfo): Promise<boolean> {
  return isSameProcess(run.pid, run.startedAt)
}

/** True only when `pid` exists right now AND its OS start time is `startedAt`: the very process that was recorded. */
export async function isSameProcess(pid: number, startedAt: string): Promise<boolean> {
  if (!pidExists(pid)) return false
  const now = await processStartTime(pid)
  if (now === undefined) return false
  const recorded = normalize(startedAt)
  return recorded !== undefined && now === recorded
}

function normalize(raw: string | undefined): string | undefined {
  const s = raw?.trim()
  if (!s) return undefined
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? s : new Date(ms).toISOString()
}
