// tether-procd entry point: `node src/procd/main.ts`, started detached by tetherd (as <home>/bin/tether-procd.exe).
// One per pipe: the pipe is the lock. Writes <home>/tether-procd.pid, logs to <home>/tether-procd.log. Leaves when
// idle (no live process for PROCD_IDLE_MS) or on a `shutdown`; a signal kills the hosted trees first. An uncaught
// error is logged and the host carries on: every hosted process dies with this process.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { tetherHome } from '../core/paths.ts'
import { pipePath } from '../daemon/protocol.ts'
import { HostClient } from './client.ts'
import { ProcHost, PROCD_IDLE_MS } from './host.ts'
import { hostStore } from './run-store.ts'
import { procdLogPath, procdPidPath, procdPipePath } from './protocol.ts'

async function main(): Promise<void> {
  const home = tetherHome()
  const pipe = procdPipePath(pipePath(home, userInfo().username), home)
  mkdirSync(home, { recursive: true })
  const log = (msg: string): void => {
    try { appendFileSync(procdLogPath(home), `${new Date().toISOString()} [${process.pid}] ${msg}\n`) } catch { /* disk full or gone */ }
  }
  const other = await HostClient.ping(pipe)
  if (other) {
    log(`another tether-procd (pid ${other.pid}) answers on ${pipe}; exiting`)
    process.exit(0)
  }

  let exiting = false
  const exit = (reason: string, code = 0): void => {
    if (exiting) return
    exiting = true
    log(`exiting: ${reason}`)
    try { if (readFileSync(procdPidPath(home), 'utf8').trim() === String(process.pid)) rmSync(procdPidPath(home), { force: true }) } catch { /* no pid file */ }
    process.exit(code)
  }
  const idleMs = Number(process.env.TETHER_PROCD_IDLE_MS) > 0 ? Number(process.env.TETHER_PROCD_IDLE_MS) : PROCD_IDLE_MS
  const host = new ProcHost({ home, pipe, log, idleMs, store: hostStore, onExit: (reason) => exit(reason) })
  try {
    await host.listen()
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    log(`cannot listen on ${pipe}: ${err.message}; leaving`)
    process.exit(err.code === 'EADDRINUSE' ? 0 : 2)
  }
  writeFileSync(procdPidPath(home), `${process.pid}\n`)
  log(`started pid ${process.pid}, home ${home}`)

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(sig, () => {
      log(`signal ${sig}: stopping the hosted processes`)
      void host.close().then(() => exit(`signal ${sig}`))
      setTimeout(() => exit(`signal ${sig} (close timed out)`), 15_000).unref()
    })
  }
  process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e.message}`))
  process.on('unhandledRejection', (r) => log(`unhandled rejection: ${String((r as Error)?.stack ?? r)}`))
}

void main().catch((e: Error) => {
  process.stderr.write(`tether-procd: ${e.stack ?? e.message}\n`)
  process.exit(1)
})
