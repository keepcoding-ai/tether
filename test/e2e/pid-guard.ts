// Guard for every kill an app E2E test does: a PID can be reused by an unrelated process (the user's own
// tether/tetherd included) between the moment the test learned it and the kill. A process is killed only
// when its command line carries the test's marker (its checkout path, or its private home/pipe) and it was
// created after the test started. Anything else is left alone and reported.
import { execFileSync } from 'node:child_process'

export interface ProcessInfo { pid: number; createdAt: number; commandLine: string }

/** Command line and creation time of a process (undefined when it no longer exists). */
export function processInfo(pid: number): ProcessInfo | undefined {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { "$([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds())|$($p.CommandLine)" }`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()
  if (!out) return undefined
  const sep = out.indexOf('|')
  return { pid, createdAt: Number(out.slice(0, sep)), commandLine: out.slice(sep + 1) }
}

export interface KillGuard {
  /** Substrings, any of which must appear in the command line (the test's root path, home or pipe). */
  markers: string[]
  /** The test's start time: a process created before it cannot be the test's. */
  notBefore: number
}

/**
 * Kills `pid` when it is provably the test's own process; otherwise does nothing and returns why.
 * Returns 'killed', 'gone' (no such process) or a reason string for the refusal.
 */
export function killOwned(pid: number, guard: KillGuard): 'killed' | 'gone' | string {
  const info = processInfo(pid)
  if (!info) return 'gone'
  if (!guard.markers.some(m => info.commandLine.toLowerCase().includes(m.toLowerCase()))) {
    return `pid ${pid} is not ours (command line: ${info.commandLine.slice(0, 200)}); not killed`
  }
  // CIM creation time has ms precision; allow a little slack against the test's own clock.
  if (info.createdAt < guard.notBefore - 2000) {
    return `pid ${pid} was created before this test (${new Date(info.createdAt).toISOString()}); not killed`
  }
  try { process.kill(pid) } catch (e) { return `pid ${pid}: ${(e as Error).message}` }
  return 'killed'
}
