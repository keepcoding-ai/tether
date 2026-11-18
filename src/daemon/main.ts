// tetherd entry point: `node src/daemon/main.ts`. One instance per pipe: the pipe itself is the lock (the
// first listener owns it; a second one gets EADDRINUSE and leaves). Writes <home>/tetherd.pid, logs to
// <home>/tetherd.log. Keeps serving through uncaught errors while the server is up; goes down cleanly
// (PTY trees killed, pid file removed) on SIGINT/SIGTERM/SIGHUP(console closed)/SIGBREAK and on `shutdown`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setExeLogSink } from '../core/exe.ts'
import { perf } from '../core/perf.ts'
import { pidExists } from '../core/liveness.ts'
import { AppendBatch } from '../exec/append-batch.ts'
import { createExecutor } from '../exec/executor.ts'
import { loadOpTable } from '../exec/inline.ts'
import { PerfLog } from '../exec/perf-log.ts'
import { tetherHome } from '../core/paths.ts'
import { pingDaemon } from './client.ts'
import { disabledExtensions } from '../agents/load.ts'
import { DaemonExtensionHost } from './ext-host.ts'
import { ProfileStore } from '../core/profile.ts'
import { UserSettings } from '../core/user-settings.ts'
import { createGuard } from './guard.ts'
import { pipePath } from './protocol.ts'
import { startDaemon, type Daemon } from './server.ts'

export function pidFilePath(home: string): string {
  return join(home, 'tetherd.pid')
}

export function daemonLogPath(home: string): string {
  return join(home, 'tetherd.log')
}

function readPidFile(home: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(pidFilePath(home), 'utf8').trim(), 10)
    return Number.isNaN(n) ? undefined : n
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const home = tetherHome()
  const pipe = pipePath(home, userInfo().username)
  mkdirSync(home, { recursive: true })
  // The one executor of this process: the log (and the persisted ruler) are its first clients. Lines are batched in memory and
  // appended by the io worker; the loop never touches the disk for them.
  const executor = createExecutor()
  const emergency = (await loadOpTable()).appendText // sync writer for the fatal path only (see AppendBatch.emergencySync)
  const logBatch = new AppendBatch(executor, daemonLogPath(home), { emergency })
  const log = (msg: string): void => logBatch.write(`${new Date().toISOString()} [${process.pid}] ${msg}\n`)
  setExeLogSink((line) => logBatch.write(line))
  const perfLog = new PerfLog(executor, perf, home, { everyMs: Number(process.env.TETHER_PERF_PERSIST_MS) || 60_000, emergency })
  // Flushes both batches and stops the workers, never waiting more than 2 s (a stuck disk must not hold the exit).
  const finish = async (code: number): Promise<never> => {
    await Promise.race([
      perfLog.stop().then(() => logBatch.close()).then(() => executor.close()),
      new Promise((r) => setTimeout(r, 2000)),
    ]).catch(() => {})
    return process.exit(code)
  }

  const running = await pingDaemon(pipe)
  if (running) {
    log(`another tetherd (pid ${running.pid}) is already running on ${pipe}; exiting`)
    process.stdout.write(`tetherd já está em execução (pid ${running.pid}) em ${pipe}\n`)
    return void await finish(0)
  }
  const stale = readPidFile(home)
  if (stale !== undefined && stale !== process.pid) {
    log(`stale pid file: pid ${stale} ${pidExists(stale) ? 'exists but is not a tetherd (pid reused by another program)' : 'is gone'}; `
      + `nothing answers on ${pipe}; taking over`)
  }

  let exiting = false
  const exit = (reason: string, code = 0): void => {
    if (exiting) return
    exiting = true
    log(`exiting: ${reason}`)
    if (readPidFile(home) === process.pid) rmSync(pidFilePath(home), { force: true }) // never a successor's file
    void finish(code)
  }

  // Extensions activate before the slots load: an agent they register must be known when slot metas are read. One the
  // person turned off (settings.json `extensions.disabled`) stays off until the next tetherd start: its slots are kept,
  // listed as agent-unavailable.
  // The snapshots the extensions read (settings, profiles) are loaded by the executor (the daemon's start loads the profiles); the daemon shares them.
  const profileStore = new ProfileStore(home, executor, log)
  const userSettings = new UserSettings(home, executor, process.env, log)
  await userSettings.fresh() // the profiles load after the activation: reading them consults the agent registry the extensions fill
  const extHost = new DaemonExtensionHost({ home, log, disabled: disabledExtensions(home), profileStore, settings: userSettings, executor })
  extHost.activate()

  let daemon: Daemon
  try {
    daemon = await startDaemon({ home, pipe, log, backgroundBoot: true, executor, profileStore, userSettings, onShutdown: () => exit('shutdown request'), transformPlan: extHost.transformPlan, onSlot: extHost.emitSlot })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      // Lost the race for the pipe, or a stranger holds it. Either way this process has nothing to own.
      const winner = await pingDaemon(pipe)
      if (winner) {
        log(`pipe ${pipe} taken by tetherd pid ${winner.pid} (started at the same time); leaving`)
        process.stdout.write(`tetherd já está em execução (pid ${winner.pid}) em ${pipe}\n`)
        return void await finish(0)
      }
      log(`pipe ${pipe} is taken by a process that is not a tetherd (${err.message}); leaving`)
      process.stderr.write(`tetherd: o canal ${pipe} está ocupado por um programa que não é o tetherd; feche-o ou use outro TETHER_PIPE\n`)
      return void await finish(2)
    }
    throw e
  }
  writeFileSync(pidFilePath(home), `${process.pid}\n`)
  log(`started pid ${process.pid}, home ${home}, executor ${executor.mode}`)
  log(`extensions: ${extHost.activated.length} active${extHost.failed.length ? `, ${extHost.failed.length} failed` : ''}`)
  // Only the owner of the pipe gets here: the extensions' startup side effects (files, helper processes) run now.
  extHost.emitStarted()
  perfLog.start()

  const shutdown = (reason: string, code = 0): void => {
    log(`shutting down: ${reason}`)
    void daemon.close().then(() => exit(reason, code))
    setTimeout(() => exit(`${reason} (close timed out)`, code), 20_000).unref()
  }
  // SIGHUP = the console window was closed / the user logged off (Windows maps CTRL_CLOSE_EVENT to it);
  // SIGBREAK = Ctrl+Break (Windows only). All of them: kill the PTY trees, flush the log, drop the pid file.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(sig, () => shutdown(`signal ${sig}`))
  }
  const guard = createGuard({ log, healthy: () => daemon.listening() })
  process.on('uncaughtException', (e) => { if (guard.uncaught(e)) shutdown('uncaught exception with inconsistent state', 1) })
  process.on('unhandledRejection', (r) => guard.unhandled(r))
  process.on('exit', (code) => { log(`process exit ${code}`); logBatch.emergencySync(); perfLog.batch.emergencySync() })
}

void main().catch((e: Error) => {
  process.stderr.write(`tetherd: ${e.stack ?? e.message}\n`)
  process.exit(1)
})
