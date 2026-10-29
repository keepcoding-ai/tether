// tetherd entry point: `node src/daemon/main.ts`. One instance per user: if the pipe already answers
// `hello`, this process says so and exits 0. Writes <home>/tetherd.pid, logs to <home>/tetherd.log.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { tetherHome } from '../core/paths.ts'
import { pingDaemon } from './client.ts'
import { pipePath } from './protocol.ts'
import { startDaemon } from './server.ts'

export function pidFilePath(home: string): string {
  return join(home, 'tetherd.pid')
}

export function daemonLogPath(home: string): string {
  return join(home, 'tetherd.log')
}

async function main(): Promise<void> {
  const home = tetherHome()
  const pipe = pipePath(home, userInfo().username)
  mkdirSync(home, { recursive: true })
  const log = (msg: string): void => {
    try { appendFileSync(daemonLogPath(home), `${new Date().toISOString()} ${msg}\n`) } catch { /* disk full or gone */ }
  }

  const running = await pingDaemon(pipe)
  if (running) {
    process.stdout.write(`tetherd já está em execução (pid ${running.pid}) em ${pipe}\n`)
    process.exit(0)
  }

  let exiting = false
  const exit = (reason: string, code = 0): void => {
    if (exiting) return
    exiting = true
    log(`exiting: ${reason}`)
    rmSync(pidFilePath(home), { force: true })
    process.exit(code)
  }

  const daemon = await startDaemon({ home, pipe, log, onShutdown: () => exit('shutdown request') })
  writeFileSync(pidFilePath(home), `${process.pid}\n`)
  log(`started pid ${process.pid}, home ${home}`)

  const onSignal = (sig: string): void => {
    log(`signal ${sig}`)
    void daemon.close().then(() => exit(sig))
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGHUP', () => onSignal('SIGHUP'))
  process.on('uncaughtException', (e) => {
    log(`uncaught: ${e.stack ?? String(e)}`)
    void daemon.close().then(() => exit('uncaught exception', 1))
  })
}

void main().catch((e: Error) => {
  process.stderr.write(`tetherd: ${e.stack ?? e.message}\n`)
  process.exit(1)
})
