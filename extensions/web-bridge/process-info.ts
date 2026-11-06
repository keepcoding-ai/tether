// What the OS says about a process and a port, for the one place the tether ends a process it did not start in this
// run: the bridge daemon that runs an older bundle (update.ts, design §1.3). A pid alone never justifies a kill (pids
// are reused within seconds on Windows, and a stale daemon.pid can land on anything): the daemon is ended only when the
// pid is alive, its command line names the bridge bundle and the `start` command, AND it is the process listening on
// the bridge's port. Windows answers through one PowerShell call per question (Get-CimInstance for the process,
// Get-NetTCPConnection for the port); POSIX through ps and lsof. Everything is injectable, so the unit test never
// spawns a shell.
import { execFile } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  name?: string
  /** The full command line as the OS reports it (undefined when it refuses, e.g. another user's process). */
  cmd?: string
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1 << 24, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

const ps = (script: string): Promise<string> => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])

/** The process with this pid right now, or undefined when there is none. */
export async function identifyProcess(pid: number): Promise<ProcessInfo | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      const out = await ps(`Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`)
      if (!out.trim()) return undefined
      const p = JSON.parse(out) as { ProcessId: number; Name: string; CommandLine: string | null }
      return { pid: p.ProcessId, name: p.Name, cmd: p.CommandLine ?? undefined }
    }
    const out = await run('ps', ['-o', 'args=', '-p', String(pid)])
    const cmd = out.trim()
    return cmd ? { pid, name: cmd.split(' ')[0]!.split('/').pop(), cmd } : undefined
  } catch { return undefined }
}

/** The pid listening on 127.0.0.1:`port` (TCP), or undefined when nothing is or the OS will not say. */
export async function listeningOwner(port: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const out = await ps(`@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json -Compress`)
      const raw = out.trim() ? (JSON.parse(out) as number | number[]) : []
      const pids = (Array.isArray(raw) ? raw : [raw]).filter(n => Number.isInteger(n) && n > 0)
      return pids[0]
    }
    const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    const n = Number(out.trim().split('\n')[0])
    return Number.isInteger(n) && n > 0 ? n : undefined
  } catch { return undefined }
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
