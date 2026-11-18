// What tether-procd leaves on disk, written synchronously (its own process, its own loop): the clean log of each run and
// <home>/procs/<name>.run.json. The host (host.ts) takes it as an option; tetherd's graph and the terminal-pane host never
// import it. Tests and the doctor read run.json through readRunFile.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { procLogPath, procLogsDir, procRunPath } from '../core/paths.ts'
import type { HostStore } from './host.ts'
import { makeLineCleaner, type LineCleaner } from './log-clean.ts'
import type { RunFile } from './protocol.ts'

/** Logs of this many runs are kept per process. */
export const LOG_RUNS_KEPT = 5
/** The last line of output that did not end in a newline is written after this much quiet. */
const LOG_IDLE_FLUSH_MS = 1_000

/** One run's clean log: <home>/procs/<name>/logs/run-<n>.log, ISO UTC time + space + text per line. */
export class RunLog {
  private fd: number | undefined
  private bytes = 0
  private readonly cleaner: LineCleaner = makeLineCleaner()
  private idle: NodeJS.Timeout | undefined
  private readonly path: string
  private readonly maxBytes: number
  private readonly log: (msg: string) => void

  constructor(home: string, name: string, run: number, maxBytes: number, log: (msg: string) => void) {
    this.path = procLogPath(home, name, run)
    this.maxBytes = maxBytes
    this.log = log
    const dir = procLogsDir(home, name)
    mkdirSync(dir, { recursive: true })
    // Only the newest LOG_RUNS_KEPT runs keep their log (this one included).
    for (const f of readdirSync(dir)) {
      const m = /^run-(\d+)\.log$/.exec(f)
      if (m && Number(m[1]) <= run - LOG_RUNS_KEPT) rmSync(`${dir}/${f}`, { force: true })
    }
    this.fd = openSync(this.path, 'a')
  }

  push(data: string): void {
    this.write(this.cleaner.push(data))
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.write(this.cleaner.flush()), LOG_IDLE_FLUSH_MS)
    this.idle.unref()
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle)
    this.write(this.cleaner.flush())
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
  }

  private write(lines: string[]): void {
    if (!lines.length || this.fd === undefined) return
    const ts = new Date().toISOString()
    const text = lines.map((l) => `${ts} ${l}\n`).join('')
    try {
      this.bytes += writeSync(this.fd, text)
      if (this.bytes > this.maxBytes) this.halve()
    } catch (e) {
      this.log(`log ${this.path}: ${(e as Error).message}`)
    }
  }

  /** Keeps the newer half, cut at a line boundary. */
  private halve(): void {
    closeSync(this.fd!)
    const all = readFileSync(this.path, 'utf8')
    let keep = all.slice(Math.floor(all.length / 2))
    const nl = keep.indexOf('\n')
    keep = nl >= 0 ? keep.slice(nl + 1) : keep
    writeFileSync(this.path, keep)
    this.bytes = Buffer.byteLength(keep)
    this.fd = openSync(this.path, 'a')
  }
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

/** The store tether-procd's host persists through. */
export const hostStore: HostStore = {
  openLog: (home, name, run, maxBytes, log) => new RunLog(home, name, run, maxBytes, log),
  writeRun: writeRunFile,
}
