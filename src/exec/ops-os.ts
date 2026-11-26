// Operations that ask the operating system something or create a process: kill a process tree, sample the process table, read a
// process' start time (the resident PowerShell helper lives here), check a private folder (whoami + icacls) and resolve a
// recipe's command. Creating a process runs `CreateProcess` on the calling thread (tens to hundreds of ms on Windows with an
// antivirus), so the coordinator never does it: it sends the message and awaits the reply. Exempt area of the sync ratchet; the
// coordinator never imports this file. Operations may return a promise (the worker awaits it), which lets several kills overlap.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDacl, ensurePrivateDir, keyDaclProblem, sidMemory, system32 } from '../../extensions/browser/private-dir.ts'
import { parseProcessTable, type ProcRow } from '../daemon/memory.ts'
import { planFor } from '../daemon/proc-launch-sync.ts'
import { parseLsof, parseNetstat, type Listener } from '../daemon/ports.ts'
import type { EnvMap, ProcPlanRecipe, StartTimeInfo, StartTimeMethod } from './protocol.ts'
import type { ProcPlan } from '../procd/protocol.ts'

// ---- kill a tree ----

/** Kills a process tree by pid. Windows: taskkill /T /F; elsewhere: children by parent pid, then SIGKILL. Never rejects. */
export function killTree(pid: number): Promise<null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(null))
    } else {
      execFile('pkill', ['-9', '-P', String(pid)], () => {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        resolve(null)
      })
    }
  })
}

// ---- the process table ----

const SAMPLE_TIMEOUT_MS = 20_000
const WIN_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,Name | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize),$($_.Name)" }'

/** One snapshot of the machine's process table. Rejects when the command fails or times out. */
export function sampleProcessTable(): Promise<ProcRow[]> {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32'
    const file = win ? 'powershell.exe' : 'ps'
    const args = win ? ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT] : ['-A', '-o', 'pid=,ppid=,rss=,comm=']
    execFile(file, args, { timeout: SAMPLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(parseProcessTable(stdout, win ? 1 : 1024))
    })
  })
}

// ---- listening ports ----

function runCapture(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'latin1' }, (err, stdout) => {
      // lsof exits 1 when nothing listens: its (empty) output is still the answer.
      if (err && !stdout) return reject(err)
      resolve(stdout)
    })
  })
}

/** Every TCP listener of the machine (`netstat -ano` on Windows, `lsof` elsewhere), one per port and pid. */
export async function listListeners(): Promise<Listener[]> {
  if (process.platform === 'win32') {
    const [v4, v6] = await Promise.all([runCapture('netstat', ['-ano', '-p', 'TCP']), runCapture('netstat', ['-ano', '-p', 'TCPv6'])])
    const seen = new Set<string>()
    return [...parseNetstat(v4), ...parseNetstat(v6)].filter((l) => { const k = `${l.port}/${l.pid}`; if (seen.has(k)) return false; seen.add(k); return true })
  }
  return parseLsof(await runCapture('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']))
}

// ---- a process' start time ----
// Windows has no Node-only way to read another process' creation time. The time comes from PowerShell, but not one process per
// query: starting powershell.exe costs 0.7-2 s and, under load, more than the 5 s a query may take. One long-lived helper per
// process answers queries over stdin/stdout instead: started on the first query (~0.8 s once), ~10 ms per query idle and ~65 ms
// (p95 120 ms) under heavy load, measured; it exits on its own when its stdin closes (its owner dies), is restarted when it
// dies, and a query it does not answer in time falls back to the one-shot PowerShell. The owner is the executor's `work` worker.

const QUERY_TIMEOUT_MS = 5000
/** The first answer includes PowerShell's own start-up; under load that alone can take seconds. */
const HELPER_START_TIMEOUT_MS = 20_000

let lastMethod: StartTimeMethod = 'none'
const counts = { helper: 0, oneShot: 0, helperRestarts: 0 }

export function startTimeMethod(): StartTimeMethod { return process.platform === 'win32' ? lastMethod : 'ps' }
export function startTimeStats(): Readonly<typeof counts> { return counts }

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
      // pipes are unref'd so an idle helper never keeps the owner alive).
      this.queue.push(pending)
      child.stdin!.write(`${pid}\n`, (err) => {
        if (err) { this.drop(pending); reject(err) }
      })
    })
  }

  stop(): void { this.kill('stopped') }

  get pid(): number | undefined { return this.child?.pid }

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

/** Ends the resident helper now (tests, shutdown); the next query starts another. */
export function stopStartTimeHelper(): void { helper?.stop() }

/** The helper's pid, when one is running (tests kill it to prove the restart). */
export function startTimeHelperPid(): number | undefined { return helper?.pid }

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const out = stdout?.trim()
      resolve(!err && out ? out : undefined)
    })
  })
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

/** The raw start time as the OS reports it (the caller normalizes it); null when there is no such process. */
export async function startTime(pid: number): Promise<string | null> {
  const raw = process.platform === 'win32' ? await windowsStartTime(pid) : await posixStartTime(pid)
  return raw ?? null
}

export function startTimeInfo(): StartTimeInfo {
  return { method: startTimeMethod(), stats: { ...counts }, helperPid: helper?.pid ?? null }
}

// ---- private folders and process recipes ----

/** The owner-only check of a folder (whoami + icacls on Windows): its own memory lives in this worker. */
function ensurePrivateDirOp(dir: string): null {
  ensurePrivateDir(dir)
  return null
}

/** A recipe's launch plan: the command is looked up on disk (PATH, extensions), so it runs where disk work belongs. */
function procPlan(recipe: ProcPlanRecipe, base: EnvMap, platform: NodeJS.Platform): ProcPlan {
  return planFor(recipe, base as NodeJS.ProcessEnv, platform)
}

// ---- who is this pid / who listens on this port (web-bridge's daemon update) ----

/** What the OS says about a process: pid, image name and full command line (cmd absent when the OS refuses). */
export interface ProcessInfo { pid: number; name?: string; cmd?: string }

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1 << 24, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}
const powershell = (script: string): Promise<string> => runFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])

/** The process with this pid right now, or null when there is none. Windows: one Get-CimInstance; POSIX: ps. */
export async function identifyProcess(pid: number): Promise<ProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const out = await powershell(`Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`)
      if (!out.trim()) return null
      const p = JSON.parse(out) as { ProcessId: number; Name: string; CommandLine: string | null }
      return { pid: p.ProcessId, name: p.Name, ...(p.CommandLine ? { cmd: p.CommandLine } : {}) }
    }
    const cmd = (await runFile('ps', ['-o', 'args=', '-p', String(pid)])).trim()
    return cmd ? { pid, name: cmd.split(' ')[0]!.split('/').pop(), cmd } : null
  } catch { return null }
}

// ---- the pipe keys (src/daemon/pipe-key.ts) ----

/** The current user's SID (whoami from System32), remembered like private-dir's. */
async function userSid(): Promise<string> {
  if (sidMemory.sid) return sidMemory.sid
  const m = /"(S-1-[\d-]+)"/.exec(await runFile(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']))
  if (!m) throw new Error('não consegui ler o SID do usuário atual')
  sidMemory.sid = m[1]!
  return sidMemory.sid
}

/** The DACL of a file or folder as SDDL (`icacls /save`, the same in every system language); undefined when unreadable. */
async function sddlOf(path: string): Promise<string | undefined> {
  const tmp = await mkdtemp(join(tmpdir(), 'tether-acl-'))
  try {
    const file = join(tmp, 'acl')
    await runFile(system32('icacls.exe'), [path, '/save', file, '/q'])
    return (await readFile(file)).toString('utf16le').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('D:'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * A key file readable by its user only. Windows: a protected DACL with the user and SYSTEM (`/grant:r` replaces only the
 * entries of the SIDs it names, so the result is read back and any other entry refuses), and the user as owner (the owner keeps
 * WRITE_DAC whatever the DACL says; `/setowner` to oneself needs only the F just granted). Elsewhere mode 0600, checked.
 * Throws, saying what is wrong, when the file does not end up private.
 */
async function restrictKeyFile(path: string): Promise<null> {
  if (process.platform !== 'win32') {
    await chmod(path, 0o600)
    if (((await stat(path)).mode & 0o077) !== 0) throw new Error('o arquivo continua aberto a outros usuários')
    return null
  }
  const sid = await userSid()
  await runFile(system32('icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)', '/q'])
  await runFile(system32('icacls.exe'), [path, '/setowner', `*${sid}`, '/q'])
  const sddl = await sddlOf(path)
  if (!sddl) throw new Error('não consegui ler de volta a ACL do arquivo')
  const problem = keyDaclProblem(sddl, sid)
  if (problem) throw new Error(problem)
  return null
}

/** Besides the user, who may hold access to a folder that still counts as private: SYSTEM, Administrators, CREATOR OWNER (SDDL names or SIDs). */
const PRIVATE_FOLDER_TRUSTED = new Set(['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544', 'CO', 'S-1-3-0'])

/**
 * Whether only the user (and SYSTEM / Administrators) can reach the folder, changing nothing. Windows: every allow entry of its
 * DACL, read as SDDL (`icacls /save`, the same in every system language), is the user or one of PRIVATE_FOLDER_TRUSTED;
 * elsewhere no group/other permission bit. Anything that cannot be read counts as not private.
 */
async function isPrivateFolder(dir: string): Promise<boolean> {
  try {
    if (process.platform !== 'win32') return ((await stat(dir)).mode & 0o077) === 0
    const sddl = await sddlOf(dir)
    if (!sddl) return false
    return checkDacl(sddl, await userSid()).others.every((who) => PRIVATE_FOLDER_TRUSTED.has(who))
  } catch {
    return false
  }
}

/** The pid listening on `port` (TCP), or null when nothing is or the OS will not say. */
export async function listeningOwner(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const out = await powershell(`@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json -Compress`)
      const raw = out.trim() ? (JSON.parse(out) as number | number[]) : []
      const pids = (Array.isArray(raw) ? raw : [raw]).filter((n) => Number.isInteger(n) && n > 0)
      return pids[0] ?? null
    }
    const n = Number((await runFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).trim().split(/\r?\n/)[0])
    return Number.isInteger(n) && n > 0 ? n : null
  } catch { return null }
}

export const osOps = {
  killTree,
  sampleProcessTable,
  listListeners,
  startTime,
  startTimeInfo,
  stopStartTimeHelper: (): null => { stopStartTimeHelper(); return null },
  ensurePrivateDir: ensurePrivateDirOp,
  procPlan,
  identifyProcess,
  listeningOwner,
  restrictKeyFile,
  isPrivateFolder,
}
