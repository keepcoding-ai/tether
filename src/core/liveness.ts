// Is the process recorded in RunInfo still the same process?
// PID alone is not enough (Windows reuses PIDs quickly), so we also compare the OS start time.
//
// Windows has no Node-only way to read another process' creation time (no procfs; no API in node:os / node:fs;
// no native module beyond node-pty, which does not expose it). The time therefore comes from PowerShell, but
// not one process per query: starting powershell.exe costs 0.7-2 s and, under load, more than the 5 s a query
// may take (the orphan reaper then went blind and the liveness tests flaked). One long-lived helper per process
// answers queries over stdin/stdout instead: started on the first query, ~0.8 s once, then ~10 ms per query
// idle and ~65 ms (p95 120 ms) under heavy load, measured; it exits on its own when its stdin closes (we die),
// is restarted when it dies, and a query it does not answer in time falls back to the old one-shot PowerShell.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import type { RunInfo } from './event.ts'

const QUERY_TIMEOUT_MS = 5000
/** The first answer includes PowerShell's own start-up; under load that alone can take seconds. */
const HELPER_START_TIMEOUT_MS = 20_000

export type StartTimeMethod = 'helper' | 'one-shot' | 'ps' | 'none'

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

// ---- Windows: the resident helper ---------------------------------------------------------------------------

/** How the last Windows query was answered (for `tether doctor` and the tests). */
let lastMethod: StartTimeMethod = 'none'
/** Queries answered by the helper / by the one-shot fallback since this process started. */
const counts = { helper: 0, oneShot: 0, helperRestarts: 0 }

export function startTimeMethod(): StartTimeMethod {
  return process.platform === 'win32' ? lastMethod : 'ps'
}

export function startTimeStats(): Readonly<typeof counts> {
  return counts
}

// One line in: a pid. One line out: `<pid> <ISO-8601 UTC>` or `<pid> -` when there is no such process.
// Get-Process is the cheap path; Get-CimInstance covers processes Get-Process cannot open. Stdout is flushed
// per answer; the loop ends when stdin closes (ReadLine returns null), so the helper never outlives its owner.
const HELPER_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$o=[Console]::Out',
  'while ($null -ne ($l=[Console]::In.ReadLine())) {',
  '  $id=0',
  '  if ([int]::TryParse($l.Trim(), [ref]$id)) {',
  '    $t=$null',
  '    try { $t=(Get-Process -Id $id -ErrorAction Stop).StartTime } catch { $c=Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if ($c) { $t=$c.CreationDate } }',
  "    if ($t) { $o.WriteLine(\"$id \" + $t.ToUniversalTime().ToString('o')) } else { $o.WriteLine(\"$id -\") }",
  '  } else { $o.WriteLine("0 -") }',
  '  $o.Flush()',
  '}',
].join('\n')

/** `undefined`: the helper looked and found no such process. `null`: the helper died before answering. */
type HelperAnswer = string | undefined | null

interface Pending {
  pid: number
  resolve: (raw: HelperAnswer) => void
  timer: NodeJS.Timeout
}

class StartTimeHelper {
  private child: ChildProcess | undefined
  private buffer = ''
  private readonly queue: Pending[] = []
  /** Set once the helper answered anything: later queries get the short timeout. */
  private ready = false

  /** Resolves with the raw time (null: the helper died first), or rejects when it could not answer (not started, timed out). */
  query(pid: number): Promise<HelperAnswer> {
    return new Promise((resolve, reject) => {
      const child = this.child ?? this.start()
      if (!child) return reject(new Error('helper could not be started'))
      const pending: Pending = {
        pid,
        resolve,
        timer: setTimeout(() => {
          this.drop(pending)
          this.kill('timeout') // a helper that stalls once is not trusted again: the next query starts a new one
          reject(new Error('helper timed out'))
        }, this.ready ? QUERY_TIMEOUT_MS : HELPER_START_TIMEOUT_MS),
      }
      // The timer is NOT unref'd: it is what keeps the event loop alive while an answer is awaited (the helper's
      // pipes are unref'd so an idle helper never keeps the owner alive; tetherd before it listens has nothing else).
      this.queue.push(pending)
      child.stdin!.write(`${pid}\n`, (err) => {
        if (err) { this.drop(pending); reject(err) }
      })
    })
  }

  stop(): void {
    this.kill('stopped')
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  private start(): ChildProcess | undefined {
    let child: ChildProcess
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', HELPER_SCRIPT],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return undefined
    }
    this.child = child
    this.buffer = ''
    this.ready = false
    // Nothing here may keep the owner alive: a CLI command must exit when its work is done.
    child.unref()
    ;(child.stdin as unknown as Socket).unref()
    ;(child.stdout as unknown as Socket).unref()
    child.stdin!.on('error', () => { /* EPIPE when it died: surfaces as exit */ })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(child, chunk))
    child.on('exit', () => { if (this.child === child) this.kill('exited') })
    child.on('error', () => { if (this.child === child) this.kill('spawn error') })
    return child
  }

  private onData(child: ChildProcess, chunk: string): void {
    if (this.child !== child) return
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      const sp = line.indexOf(' ')
      const pid = Number.parseInt(sp < 0 ? line : line.slice(0, sp), 10)
      const raw = sp < 0 ? '' : line.slice(sp + 1).trim()
      const pending = this.queue.shift()
      if (!pending) continue
      clearTimeout(pending.timer)
      this.ready = true
      if (pending.pid !== pid) {
        // Out of step with the helper: nothing it says from now on can be trusted.
        this.kill('out of order answer')
        pending.resolve(null)
        continue
      }
      pending.resolve(raw && raw !== '-' ? raw : undefined)
    }
  }

  private drop(p: Pending): void {
    clearTimeout(p.timer)
    const i = this.queue.indexOf(p)
    if (i >= 0) this.queue.splice(i, 1)
  }

  /** Forgets the current helper (killing it by handle) and fails every query still waiting on it. */
  private kill(reason: string): void {
    const child = this.child
    if (!child) return
    this.child = undefined
    this.ready = false
    if (reason !== 'stopped' && reason !== 'exited') counts.helperRestarts++
    try { child.kill() } catch { /* already gone */ }
    for (const p of this.queue.splice(0)) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
    this.buffer = ''
  }
}

const helper = process.platform === 'win32' ? new StartTimeHelper() : undefined

/** Ends the resident helper now (tests, daemon shutdown); the next query starts another. */
export function stopStartTimeHelper(): void {
  helper?.stop()
}

/** The helper's pid, when one is running (tests kill it to prove the restart). */
export function startTimeHelperPid(): number | undefined {
  return helper?.pid
}

async function windowsStartTime(pid: number): Promise<string | undefined> {
  if (helper) {
    // A helper that died under the query (killed, crashed) is replaced and the query asked once more; one that
    // stalls (timeout) or cannot start is not retried: the one-shot below answers this query.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await helper.query(pid)
        if (raw === null) continue
        lastMethod = 'helper'
        counts.helper++
        return raw
      } catch {
        break
      }
    }
  }
  lastMethod = 'one-shot'
  counts.oneShot++
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
