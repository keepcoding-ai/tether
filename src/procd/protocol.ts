// Contract between tetherd and tether-procd (the host that owns the background processes' PTYs).
// Transport: the same NDJSON framing as tetherd's own pipe (daemon/ndjson.ts). Requests carry `id` and get one
// `ok` / `error` reply each; `exit` events go to every client, `data` events to the clients attached to that name.
// The host knows nothing of cards, authors or history: it runs plans, keeps output and records pid/exit on disk.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { procRunPath } from '../core/paths.ts'

export const PROCD_PROTOCOL_VERSION = 1
export const PROCD_VERSION = '0.1.0'

/** A ready launch: tetherd resolved the command, the folder and the complete environment. */
export interface ProcPlan {
  command: string
  /** A string goes to node-pty untouched (cmd.exe /d /s /c "<line>" for .cmd/.bat shortcuts). */
  args: string[] | string
  cwd: string
  env: Record<string, string>
}

export interface RunExit {
  code: number
  /** ISO time the host saw the process end. */
  at: string
}

export interface HostRun {
  name: string
  run: number
  pid: number
  /** OS creation time of the process (identity, with the pid). */
  startedAt: string
  spawnedAt: string
  exit?: RunExit
}

/** <home>/procs/<name>.run.json: written only by the host, atomically, before any client hears of a change. */
export interface RunFile extends HostRun {
  v: 1
  hostPid: number
  hostStartedAt: string
}

export type HostRequest =
  | { t: 'hello'; id: number; v: number }
  | { t: 'spawn'; id: number; name: string; run: number; plan: ProcPlan; cols: number; rows: number; home: string }
  /** Ctrl+C, wait up to graceMs, then killTree; the reply comes once the process ended. */
  | { t: 'stop'; id: number; name: string; graceMs: number }
  | { t: 'list'; id: number }
  | { t: 'attach'; id: number; name: string }
  | { t: 'detach'; id: number; name: string }
  | { t: 'resize'; id: number; name: string; cols: number; rows: number }
  /** Drops the scrollback of an ended run. */
  | { t: 'forget'; id: number; name: string }
  /** Refused (`busy`) while a process lives, unless `force`: then every process is killed and the host exits. */
  | { t: 'shutdown'; id: number; force?: boolean }

export type HostErrorCode = 'spawn-failed' | 'already-running' | 'unknown-run' | 'busy' | 'bad-request' | 'version'

export interface HostHello {
  v: number
  pid: number
  version: string
  startedAt: string
}

export type HostReply =
  | { t: 'ok'; id: number; hello?: HostHello; pid?: number; startedAt?: string; exit?: RunExit; runs?: HostRun[]; scrollback?: string }
  | { t: 'error'; id: number; code: HostErrorCode; message: string }

export type HostEvent =
  | { t: 'exit'; name: string; run: number; exit: RunExit }
  | { t: 'data'; name: string; data: string }

/** TETHER_PROCD_PIPE, else derived from tetherd's pipe: `<pipe>-procd` on Windows, `<home>/tether-procd.sock` elsewhere. */
export function procdPipePath(tetherPipe: string, home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = env.TETHER_PROCD_PIPE?.trim()
  if (fromEnv) return fromEnv
  return platform === 'win32' ? `${tetherPipe}-procd` : join(home, 'tether-procd.sock')
}

export function procdPidPath(home: string): string {
  return join(home, 'tether-procd.pid')
}

export function procdLogPath(home: string): string {
  return join(home, 'tether-procd.log')
}

/** Write to a temp name and rename into place: a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}

export function writeRunFile(home: string, run: RunFile): void {
  writeJsonAtomic(procRunPath(home, run.name), run)
}

export function readRunFile(home: string, name: string): RunFile | undefined {
  try {
    const r = JSON.parse(readFileSync(procRunPath(home, name), 'utf8')) as RunFile
    return r && r.v === 1 && typeof r.run === 'number' && typeof r.pid === 'number' ? r : undefined
  } catch {
    return undefined
  }
}
