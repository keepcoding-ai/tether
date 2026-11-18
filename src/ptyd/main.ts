// tether-ptyd entry point: `node src/ptyd/main.ts`, started detached (as <home>/bin/tether-ptyd.exe). The same
// ProcHost as tether-procd, with persist:false (no clean log, no run.json): it hosts terminal panes. One per pipe:
// the pipe is the lock. Writes <home>/tether-ptyd.pid, logs to <home>/tether-ptyd.log. Leaves when idle (no live
// process for TETHER_PTYD_IDLE_MS) or on a `shutdown`; a signal kills the hosted trees first. An uncaught error is
// logged and the host carries on. Async fs only: this file is a root of the sync-fs ratchet.
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { tetherHome } from '../core/paths.ts'
import { pipePath } from '../daemon/protocol.ts'
import { HostClient } from '../procd/client.ts'
import { ProcHost, PROCD_IDLE_MS } from '../procd/host.ts'
import { makePrioritySetter, prioritiesEnabled, PRIORITY_ABOVE_NORMAL } from '../procd/priority.ts'
import { ptydLogPath, ptydPidPath, ptydPipePath } from './paths.ts'

async function main(): Promise<void> {
  const home = tetherHome()
  const pipe = ptydPipePath(pipePath(home, userInfo().username), home)
  await mkdir(home, { recursive: true })
  const log = (msg: string): void => {
    appendFile(ptydLogPath(home), `${new Date().toISOString()} [${process.pid}] ${msg}\n`).catch(() => { /* disk full or gone */ })
  }
  const other = await HostClient.ping(pipe)
  if (other) {
    log(`another tether-ptyd (pid ${other.pid}) answers on ${pipe}; exiting`)
    setTimeout(() => process.exit(0), 200)
    return
  }

  let exiting = false
  const exit = (reason: string, code = 0): void => {
    if (exiting) return
    exiting = true
    log(`exiting: ${reason}`)
    void (async () => {
      try { if ((await readFile(ptydPidPath(home), 'utf8')).trim() === String(process.pid)) await rm(ptydPidPath(home), { force: true }) } catch { /* no pid file */ }
      // let the log line above reach the disk
      setTimeout(() => process.exit(code), 100)
    })()
  }
  const idleMs = Number(process.env.TETHER_PTYD_IDLE_MS) > 0 ? Number(process.env.TETHER_PTYD_IDLE_MS) : PROCD_IDLE_MS
  const host = new ProcHost({ home, pipe, log, idleMs, persist: false, onExit: (reason) => exit(reason) })
  try {
    await host.listen()
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    log(`cannot listen on ${pipe}: ${err.message}; leaving`)
    setTimeout(() => process.exit(err.code === 'EADDRINUSE' ? 0 : 2), 200)
    return
  }
  // The pane host carries typing and echo: above normal (what it hosts is set below normal by the ProcHost).
  makePrioritySetter({ enabled: prioritiesEnabled(), log })(process.pid, PRIORITY_ABOVE_NORMAL)
  await writeFile(ptydPidPath(home), `${process.pid}\n`)
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
  process.stderr.write(`tether-ptyd: ${e.stack ?? e.message}\n`)
  process.exit(1)
})
