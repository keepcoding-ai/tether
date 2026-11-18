// What the OS says about a process and a port, for the one place the tether ends a process it did not start in this
// run: the bridge daemon that runs an older bundle (update.ts, design §1.3). A pid alone never justifies a kill (pids
// are reused within seconds on Windows, and a stale daemon.pid can land on anything): the daemon is ended only when the
// pid is alive, its command line names the bridge bundle and the `start` command, AND it is the process listening on
// the bridge's port. Windows answers through one PowerShell call per question (Get-CimInstance for the process,
// Get-NetTCPConnection for the port); POSIX through ps and lsof (src/exec/ops-os.ts). Everything is injectable, so the unit test never
// spawns a shell.
import { agentExecutor } from '../../src/agents/agent-exec.ts'

export interface ProcessInfo {
  pid: number
  name?: string
  /** The full command line as the OS reports it (undefined when it refuses, e.g. another user's process). */
  cmd?: string
}

// Both questions create a process (PowerShell, ps, lsof) and `CreateProcess` runs on the calling thread, so they are executor
// operations (src/exec/ops-os.ts); this file only awaits the answer.

/** The process with this pid right now, or undefined when there is none. */
export async function identifyProcess(pid: number): Promise<ProcessInfo | undefined> {
  try { return (await agentExecutor().run('identifyProcess', [pid])) ?? undefined } catch { return undefined }
}

/** The pid listening on `port` (TCP), or undefined when nothing is or the OS will not say. */
export async function listeningOwner(port: number): Promise<number | undefined> {
  try { return (await agentExecutor().run('listeningOwner', [port])) ?? undefined } catch { return undefined }
}

/** Ends the process (TerminateProcess on Windows, SIGTERM then SIGKILL elsewhere). Silent when it is already gone. */
export async function killProcess(pid: number): Promise<void> {
  try { process.kill(pid, process.platform === 'win32' ? undefined : 'SIGTERM') } catch { return }
  if (process.platform === 'win32') return
  await new Promise(r => setTimeout(r, 1500))
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
