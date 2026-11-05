// The main process' own log file, <TETHER_HOME>/tether-app.log: what a launch decided (single-instance lock,
// second launches, "Reiniciar o app") with pid and time, so a launch from the Start Menu, which has no stderr,
// still leaves a trace that can be read afterwards. Append-only; rotated once to .1 past LOG_MAX_BYTES. A
// failure to write never reaches the caller: the log is evidence, not a dependency.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const LOG_MAX_BYTES = 1_000_000

export type AppLog = (line: string) => void

export function createAppLog(path: string, pid: number = process.pid): AppLog {
  return line => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      try { if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`) } catch { /* no file yet */ }
      appendFileSync(path, `${new Date().toISOString()} [${pid}] ${line}\n`)
    } catch { /* unwritable home: the line goes to stderr only */ }
    console.error(`tether: ${line}`)
  }
}
