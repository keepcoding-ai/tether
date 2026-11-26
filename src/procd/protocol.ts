// Contract between tetherd and tether-procd (the host that owns the background processes' PTYs).
// Transport: the same NDJSON framing as tetherd's own pipe (daemon/ndjson.ts). Requests carry `id` and get one
// `ok` / `error` reply each; `exit` events go to every client, `data` events to the clients attached to that name.
// The host knows nothing of cards, authors or history: it runs plans, keeps output and records pid/exit on disk.
import { join } from 'node:path'

/**
 * 2: the client proves it holds the host's key (`auth`, then `hello` with `proof`; daemon/pipe-key.ts, scope
 * 'tether-host', key file hostKeyPath) and the host proves it back. Until the hello the host answers nothing else and
 * sends no event; a connection without hello in time is dropped. A v1 host answers `auth` with bad-request: the client
 * calls it `outdated`.
 */
export const PROCD_PROTOCOL_VERSION = 2
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
  /** Opens every connection: the client's nonce (64 hex). Reply: `auth`. */
  | { t: 'auth'; id: number; nonce: string }
  /** `proof`: pipe-key.ts clientProof with scope 'tether-host'. A wrong or missing proof is refused and the connection closed. */
  | { t: 'hello'; id: number; v: number; proof?: string }
  | { t: 'spawn'; id: number; name: string; run: number; plan: ProcPlan; cols: number; rows: number; home: string }
  /** Ctrl+C, wait up to graceMs, then killTree; the reply comes once the process ended. */
  | { t: 'stop'; id: number; name: string; graceMs: number }
  | { t: 'list'; id: number }
  /** With `from` and a matching `epoch` the reply carries only what is missing after `from`; otherwise the whole ring. */
  | { t: 'attach'; id: number; name: string; from?: number; epoch?: string }
  /** Releases the ConPTY WITHOUT killing the process tree; the run then ends with an `exit` event. */
  | { t: 'release'; id: number; name: string }
  | { t: 'detach'; id: number; name: string }
  | { t: 'resize'; id: number; name: string; cols: number; rows: number }
  /** Drops the scrollback of an ended run. */
  | { t: 'forget'; id: number; name: string }
  /** Refused (`busy`) while a process lives, unless `force`: then every process is killed and the host exits. */
  | { t: 'shutdown'; id: number; force?: boolean }

/** Fire-and-forget input: no `id`, no reply. Unknown names are ignored. */
export type HostNotice = { t: 'write'; name: string; data: string }

/** `auth-required` / `auth-failed`: see the hello; `outdated` (client side): the host predates protocol 2 and checks nobody. */
export type HostErrorCode = 'spawn-failed' | 'already-running' | 'unknown-run' | 'busy' | 'bad-request' | 'version' | 'auth-required' | 'auth-failed' | 'outdated'

/** Capabilities announced in `hello` (additive: the protocol version stays the same). */
export type HostCap = 'write' | 'offsets' | 'lag'

export interface HostHello {
  v: number
  /** Client side: a host before protocol 2, reached only by an `open` that allows it (ping, shutdown). */
  legacy?: true
  caps?: HostCap[]
  pid: number
  version: string
  startedAt: string
}

export type HostReply =
  | { t: 'ok'; id: number; hello?: HostHello; auth?: { nonce: string; proof: string }; pid?: number; startedAt?: string; exit?: RunExit; runs?: HostRun[]; scrollback?: string; off?: number; epoch?: string }
  | { t: 'error'; id: number; code: HostErrorCode; message: string }

export type HostEvent =
  | { t: 'exit'; name: string; run: number; exit: RunExit }
  /** `off` is the run's output offset AFTER this chunk (restarts at 0 with each run). */
  | { t: 'data'; name: string; off?: number; data: string }
  /** Declared only: the host will say a client fell behind (E1.3). */
  | { t: 'lag'; name: string }

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
