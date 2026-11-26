// Starting and stopping the portal (tether-remoted). It is tetherd's child, with three things only it holds: the
// credential on its stdin (written once, then stdin closes; fio-spec 1.5), its log file as stdout/stderr, and Node's IPC
// channel (the private line of src/remoted/ipc.ts). It cannot go through the detached launch of ptyd/procd (PowerShell
// Start-Process gives no stdin) and it should not outlive tetherd: its credential dies with tetherd anyway, and the IPC
// channel closing makes it leave. The environment is minimal (B-8): no NODE_OPTIONS, no NODE_TLS_REJECT_UNAUTHORIZED, no
// TETHER_*KEY, nothing of the person's shell but what Windows and the executor need. Stopped by PID.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FromPortal, ToPortal } from '../../../src/remoted/ipc.ts'

const PASS_ENV = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'HOME', 'LANG',
]
const BENCH_ENV = /^TETHER_TEST_REMOTE(_[A-Z_]+)?$/

/** The portal's environment: the allow list above, the home and the pipe, and the bench knobs only on the bench. */
export function portalEnv(base: NodeJS.ProcessEnv, home: string, pipe: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of PASS_ENV) { const v = base[k]; if (v !== undefined) env[k] = v }
  if (base.TETHER_TEST_REMOTE === '1') for (const [k, v] of Object.entries(base)) if (BENCH_ENV.test(k) && v !== undefined) env[k] = v
  env.TETHER_HOME = home
  env.TETHER_PIPE = pipe
  return env
}

/**
 * The portal's entry script, resolved only when a portal is about to start (the procd/ptyd pattern, src/procd/client.ts):
 * the app bundles the daemon extensions as CJS, where import.meta.url is empty and evaluating this at load would throw.
 */
export function portalMain(): string {
  return fileURLToPath(new URL('../../../src/remoted/main.ts', import.meta.url))
}

export interface PortalChild {
  readonly pid: number | undefined
  send(m: ToPortal): void
  /** Ends it by PID (after a `stop` and a grace period, so its sessions get CLOSE(0x06)). */
  kill(graceMs?: number): Promise<void>
}

export interface SpawnPortal {
  (o: { home: string; pipe: string; node: string; env: NodeJS.ProcessEnv; cred: Buffer; onMessage(m: FromPortal): void; onExit(code: number | null): void }): Promise<PortalChild>
}

/** A fresh credential for one portal process (32 random bytes). */
export const newPortalCredential = (): Buffer => randomBytes(32)

export const spawnPortal: SpawnPortal = async (o) => {
  const log = await open(join(o.home, 'tether-remoted.log'), 'a')
  let child: ChildProcess
  try {
    child = spawn(o.node, [portalMain()], {
      cwd: o.home, env: portalEnv(o.env, o.home, o.pipe), windowsHide: true, stdio: ['pipe', log.fd, log.fd, 'ipc'], serialization: 'json',
    })
  } finally { await log.close() }
  child.on('error', () => { /* surfaces as exit */ })
  child.stdin!.on('error', () => { /* the portal left before reading */ })
  child.stdin!.end(`${o.cred.toString('hex')}\n`)
  let exited = false
  child.on('message', (m) => o.onMessage(m as FromPortal))
  child.on('exit', (code) => { exited = true; o.onExit(code) })
  return {
    pid: child.pid,
    send: (m) => { if (child.connected) child.send(m) },
    kill: async (graceMs = 2_000) => {
      if (exited) return
      if (child.connected) child.send({ t: 'stop' } satisfies ToPortal)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!exited && child.pid !== undefined) { try { process.kill(child.pid) } catch { /* gone */ } }
          resolve()
        }, graceMs)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    },
  }
}
