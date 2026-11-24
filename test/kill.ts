// The only way a test kills a process. A pid alone is never enough on Windows (pids are reused within seconds,
// and a test's stale pid can land on the user's own tetherd or agent): a process is killed only when it is
// still the one the test claimed, i.e. the same pid AND the same OS creation time, and optionally a command
// line that contains a token only this test could have put there (its home, pipe or checkout path).
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

/** A process identity captured while the process was known to be the test's own. */
export interface Owned {
  pid: number
  /** OS creation time (Windows: FILETIME ticks; POSIX: ms since epoch). 0 = unknown, never trusted for a kill. */
  created: number
  name?: string
  cmd?: string
}

export type KillOutcome = 'killed' | 'gone' | 'not-ours'

function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 1 << 24, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

/** What the OS says about `pid` right now (undefined when there is no such process). */
export async function identify(pid: number): Promise<Owned | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'win32') {
    const out = await ps(`Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,Name,CommandLine,@{n='Created';e={$_.CreationDate.ToFileTime()}} | ConvertTo-Json -Compress`)
    if (!out.trim()) return undefined
    const p = JSON.parse(out) as { ProcessId: number; Name: string; CommandLine: string | null; Created: number | null }
    return { pid: p.ProcessId, created: p.Created ?? 0, name: p.Name, cmd: p.CommandLine ?? undefined }
  }
  const out = await new Promise<string>((res, rej) => execFile('ps', ['-o', 'lstart=,args=', '-p', String(pid)], (e, so) => (e ? rej(e) : res(so))))
  const m = /^\s*(.{24})\s+(.*)$/.exec(out.trim())
  return m ? { pid, created: Date.parse(m[1]!) || 0, name: m[2]!.split(' ')[0], cmd: m[2] } : undefined
}

/**
 * Every process with this image name whose command line contains `cmdIncludes` (a path only this test uses),
 * never this process itself. What a test's "killall node" acts on: `killAllOwned(await findProcesses(...))`.
 */
export async function findProcesses(opts: { name: string; cmdIncludes: string }): Promise<Owned[]> {
  const needle = opts.cmdIncludes.toLowerCase()
  if (process.platform === 'win32') {
    const q = (s: string): string => s.replace(/'/g, "''")
    const out = await ps(`@(Get-CimInstance Win32_Process -Filter 'Name=''${q(opts.name)}''' | Select-Object ProcessId,Name,CommandLine,@{n='Created';e={$_.CreationDate.ToFileTime()}}) | ConvertTo-Json -Compress`)
    if (!out.trim()) return []
    const raw = JSON.parse(out) as { ProcessId: number; Name: string; CommandLine: string | null; Created: number | null }[] | { ProcessId: number; Name: string; CommandLine: string | null; Created: number | null }
    const list = Array.isArray(raw) ? raw : [raw]
    return list
      .filter((p) => p.ProcessId !== process.pid && (p.CommandLine ?? '').toLowerCase().includes(needle))
      .map((p) => ({ pid: p.ProcessId, created: p.Created ?? 0, name: p.Name, cmd: p.CommandLine ?? undefined }))
  }
  const out = await new Promise<string>((res, rej) => execFile('ps', ['-eo', 'pid=,lstart=,args='], (e, so) => (e ? rej(e) : res(so))))
  const found: Owned[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1]); const cmd = m[3]!
    const name = cmd.split(' ')[0]!.split('/').pop()!
    if (pid !== process.pid && name === opts.name && cmd.toLowerCase().includes(needle)) found.push({ pid, created: Date.parse(m[2]!) || 0, name, cmd })
  }
  return found
}

/**
 * Claims `pid` as the test's own, recording its identity now. `cmdIncludes` (a path or pipe name only this
 * test uses) must appear in its command line, or the claim is refused: the pid is not what the test thinks.
 */
export async function claim(pid: number, opts: { cmdIncludes?: string; what?: string } = {}): Promise<Owned> {
  const what = opts.what ?? 'process'
  const p = await identify(pid)
  if (!p) throw new Error(`cannot claim ${what} pid ${pid}: no such process`)
  if (opts.cmdIncludes !== undefined && !(p.cmd ?? '').toLowerCase().includes(opts.cmdIncludes.toLowerCase())) {
    throw new Error(`refusing to claim ${what} pid ${pid}: its command line does not mention ${opts.cmdIncludes}\n  ${p.name}: ${p.cmd ?? '(no command line)'}`)
  }
  return p
}

/** True when the process still exists with the recorded identity. */
export async function stillOurs(p: Owned): Promise<boolean> {
  const now = await identify(p.pid)
  return now !== undefined && now.created !== 0 && now.created === p.created
}

/**
 * Kills the claimed process (and its tree with `tree`) only if it is still the same process: same pid and same
 * creation time. 'gone' when nothing has that pid; 'not-ours' when the pid now belongs to another process
 * (nothing is killed). A claim with an unknown creation time is never acted on.
 */
export async function killOwned(p: Owned, opts: { tree?: boolean } = {}): Promise<KillOutcome> {
  const outcome = await killOwnedProcess(p, opts)
  // A tetherd of a test home leaves its terminal-pane host (tether-ptyd) behind on purpose (it outlives the daemon
  // in real use); a test that ends the daemon ends that host too, found by the home in its command line.
  if (outcome !== 'not-ours') { const home = testHomeOfDaemon(p); if (home) await killTestPtyd(home) }
  return outcome
}

/** The temp home a tetherd runs for (`<tmp>/tether-*`, from `<home>/bin/tetherd[.exe]` in its command line); undefined for any other process, and for any home outside the OS temp dir. */
export function testHomeOfDaemon(p: Owned): string | undefined {
  const m = /^"?([^"]*)[\\/]bin[\\/]tetherd(?:\.exe)?"?(?:\s|$)/i.exec(p.cmd ?? '')
  if (!m) return undefined
  const home = resolve(m[1]!)
  const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  return basename(home).startsWith('tether-') && testTmpBases().some((b) => same(dirname(home), b)) ? home : undefined
}

/**
 * The only directories a test home may live directly in: the OS temp dir and the checkout's own scratch dir
 * (`<repo>/../../.tmp`, the `tmpBase` the app E2Es use when it exists). Nothing else is ever a test home.
 */
export function testTmpBases(): string[] {
  return [resolve(tmpdir()), resolve(import.meta.dirname, '..', '..', '..', '.tmp')]
}

/**
 * Kills the tether-ptyd of a test home (never of a home outside the test temp bases) and its tree: the host runs as
 * `<home>/bin/tether-ptyd.exe`, so its command line names the home, which is the identity checked.
 */
export async function killTestPtyd(home: string): Promise<Owned[]> {
  const probe: Owned = { pid: 0, created: 0, cmd: `"${resolve(home, 'bin', 'tetherd.exe')}"` }
  if (testHomeOfDaemon(probe) === undefined) return []
  const killed: Owned[] = []
  for (const name of process.platform === 'win32' ? ['tether-ptyd.exe'] : ['node']) {
    for (const h of await findProcesses({ name, cmdIncludes: home }).catch(() => [])) {
      if (await killOwnedProcess(h, { tree: true }) === 'killed') killed.push(h)
    }
  }
  return killed
}

async function killOwnedProcess(p: Owned, opts: { tree?: boolean } = {}): Promise<KillOutcome> {
  const now = await identify(p.pid)
  if (!now) return 'gone'
  if (p.created === 0 || now.created !== p.created) return 'not-ours'
  await new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(p.pid), ...(opts.tree ? ['/T'] : []), '/F'], { windowsHide: true }, () => resolve())
    } else if (opts.tree) {
      execFile('pkill', ['-9', '-P', String(p.pid)], () => { try { process.kill(p.pid, 'SIGKILL') } catch { /* gone */ } resolve() })
    } else {
      try { process.kill(p.pid, 'SIGKILL') } catch { /* gone */ }
      resolve()
    }
  })
  return 'killed'
}

/** killOwned for each, in sequence; returns what happened to each pid. */
export async function killAllOwned(procs: Owned[], opts: { tree?: boolean } = {}): Promise<Map<number, KillOutcome>> {
  const out = new Map<number, KillOutcome>()
  for (const p of procs) out.set(p.pid, await killOwned(p, opts))
  return out
}
