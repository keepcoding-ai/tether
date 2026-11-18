// The main process' own log file, <TETHER_HOME>/tether-app.log: what a launch decided (single-instance lock,
// second launches, "Reiniciar o app") with pid and time, so a launch from the Start Menu, which has no stderr,
// still leaves a trace that can be read afterwards. Append-only; rotated once to .1 past LOG_MAX_BYTES. A
// failure to write never reaches the caller: the log is evidence, not a dependency.
// The lines go through the executor in batches (AppendBatch, at most every 50 ms): the main loop never waits for the
// disk. Before the first batch the file's size is checked once (rotation), the lines wait in memory meanwhile.
// Fatal exit: `emergencySync()` (process 'exit', or right before a process.exit) appends what is still in memory with
// the injected synchronous writer.
import { dirname } from 'node:path'
import type { Executor } from '../../src/exec/executor.ts'
import { AppendBatch } from '../../src/exec/append-batch.ts'

export const LOG_MAX_BYTES = 1_000_000

export type AppLog = ((line: string) => void) & {
  /** Resolves when every line written so far is on disk (or lost to a failed write). */
  flush(): Promise<void>
  /** Appends what is still in memory with the injected synchronous writer. Fatal-exit paths only. */
  emergencySync(): void
}

export interface AppLogOptions {
  pid?: number
  /** Synchronous append, used only by `emergencySync`. */
  emergency?: (path: string, text: string) => void
}

export function createAppLog(path: string, ex: Executor, opts: AppLogOptions = {}): AppLog {
  const pid = opts.pid ?? process.pid
  const batch = new AppendBatch(ex, path, { emergency: opts.emergency })
  let early: string[] | undefined = [] // lines written before the rotation check finished
  let written = 0
  let rotating = false
  const rotate = (): void => {
    if (rotating) return
    rotating = true
    written = 0
    void batch.flush()
      .then(() => ex.run('rename', [path, `${path}.1`]))
      .catch(() => { /* nothing to rotate */ })
      .finally(() => { rotating = false })
  }
  const ready = (async () => {
    try { await ex.run('mkdirp', [dirname(path)]) } catch { /* unwritable home: the lines go to stderr only */ }
    try {
      const size = (await ex.run('stat', [path])).size
      if (size > LOG_MAX_BYTES) await ex.run('rename', [path, `${path}.1`])
      else written = size
    } catch { /* no file yet */ }
    const lines = early ?? []
    early = undefined
    for (const l of lines) batch.write(l)
    if (written > LOG_MAX_BYTES) rotate()
  })()
  const log = ((line: string): void => {
    const text = `${new Date().toISOString()} [${pid}] ${line}\n`
    written += text.length
    if (early) early.push(text)
    else { batch.write(text); if (written > LOG_MAX_BYTES) rotate() }
    console.error(`tether: ${line}`)
  }) as AppLog
  log.flush = async () => { await ready; await batch.flush() }
  log.emergencySync = () => {
    if (early) {
      const lines = early
      early = undefined
      if (lines.length && opts.emergency) { try { opts.emergency(path, lines.join('')) } catch { /* nothing left to try */ } }
    }
    batch.emergencySync()
  }
  return log
}
