// Is the process recorded in RunInfo still the same process?
// PID alone is not enough (Windows reuses PIDs quickly), so we also compare the OS start time.
import { execFile } from 'node:child_process'
import type { RunInfo } from './event.ts'

const QUERY_TIMEOUT_MS = 5000

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
  const raw = process.platform === 'win32' ? await windowsStartTime(pid) : await posixStartTime(pid)
  return normalize(raw)
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

async function windowsStartTime(pid: number): Promise<string | undefined> {
  // Get-Process is ~0.4s on a warm machine. Get-CimInstance covers processes Get-Process cannot open.
  const script =
    `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o') } ` +
    `catch { $c = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($c) { $c.CreationDate.ToUniversalTime().ToString('o') } }`
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

async function posixStartTime(pid: number): Promise<string | undefined> {
  // lstart is the full, unambiguous date (e.g. "Wed Oct 29 01:05:55 2026").
  return run('ps', ['-o', 'lstart=', '-p', String(pid)])
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const out = stdout?.trim()
      resolve(!err && out ? out : undefined)
    })
  })
}
