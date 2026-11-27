// The remote's audit (plano §2 "Na máquina", M-10): one JSON line per act in <home>/remote/audit.jsonl, written only by the
// extension (the portal sends its lines as notes). A line says when, which device, which act, which target by id and the
// result; never content: no env value, no argument, no typed text. Every field is cut to the id alphabet `^[\w.:-]{1,64}$`
// here, at the single place that writes, so a caller cannot put content in by mistake.
//
// The log is rotated by size and by count (audit.jsonl, audit.1.jsonl … audit.<N-1>.jsonl: the oldest is replaced by the
// rename of the next one, nothing is deleted) and the writer never holds the loop: `record` is synchronous and only queues;
// one writer drains the queue in batches. A disk that stalls cannot grow it: the queue has a ceiling, what does not fit is
// counted and said in one `audit.dropped` line when the disk answers again.
import { join } from 'node:path'
import type { DaemonIo } from '../../../src/daemon/ext-api.ts'

export const AUDIT_MAX_BYTES = 256 * 1024
/** The live file plus the rotated ones: the log never holds more than AUDIT_FILES_MAX × AUDIT_MAX_BYTES (1 MiB). */
export const AUDIT_FILES_MAX = 4
/** Lines waiting for the disk. An honest burst (a pairing, a flood of limits) is far below it. */
export const AUDIT_PENDING_MAX = 256

export interface AuditEntry {
  act: string
  /** The device by id. */
  device?: string
  /** What the act was about, by id or by name of an operation; never a value. */
  target?: string
  result: string
}

export interface AuditDeps {
  /** <home>/remote */
  dir: string
  io: Pick<DaemonIo, 'appendText' | 'rename' | 'stat' | 'exists'>
  now(): number
  log(msg: string): void
  /** Makes the folder, private, when it does not exist yet (a refused request may be the first act ever); runs before the first write. */
  ensureDir?(): Promise<void>
  maxBytes?: number
  maxFiles?: number
  pendingMax?: number
}

/** The id alphabet: anything else becomes `-`, and a field is at most 64 characters. */
export function auditField(v: string): string {
  const s = v.replace(/[^\w.:-]/g, '-').slice(0, 64)
  return s || '-'
}

function* pieces(lines: readonly string[], max: number): Generator<string> {
  let cur = ''
  for (const l of lines) {
    if (cur && cur.length + l.length > max) { yield cur; cur = '' }
    cur += l
  }
  if (cur) yield cur
}

export const auditFile =(n: number): string => (n === 0 ? 'audit.jsonl' : `audit.${n}.jsonl`)

export class AuditLog {
  readonly #d: AuditDeps
  readonly #max: number
  readonly #files: number
  readonly #pendingMax: number
  #queue: string[] = []
  #dropped = 0
  #size: number | undefined
  #busy = false
  #ready = false
  #loop: Promise<void> = Promise.resolve()

  constructor(deps: AuditDeps) {
    this.#d = deps
    this.#max = deps.maxBytes ?? AUDIT_MAX_BYTES
    this.#files = Math.max(2, deps.maxFiles ?? AUDIT_FILES_MAX)
    this.#pendingMax = deps.pendingMax ?? AUDIT_PENDING_MAX
  }

  /** Queues one line; never waits for the disk and never throws. */
  record(e: AuditEntry): void {
    if (this.#queue.length >= this.#pendingMax) { this.#dropped++; return }
    this.#queue.push(this.#line(e))
    this.#kick()
  }

  /** Resolves when everything recorded so far was written (or lost). For shutdown and tests. */
  async flush(): Promise<void> {
    await this.#loop
  }

  #line(e: AuditEntry): string {
    return JSON.stringify({
      ts: new Date(this.#d.now()).toISOString(), act: auditField(e.act),
      ...(e.device ? { device: auditField(e.device) } : {}), ...(e.target ? { target: auditField(e.target) } : {}),
      result: auditField(e.result),
    }) + '\n'
  }

  #kick(): void {
    if (this.#busy) return
    this.#busy = true
    this.#loop = this.#drain()
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0 || this.#dropped > 0) {
        const lines = this.#queue
        this.#queue = []
        if (this.#dropped > 0) {
          lines.push(this.#line({ act: 'audit.dropped', result: `n:${this.#dropped}` }))
          this.#dropped = 0
        }
        try {
          if (!this.#ready) { await this.#d.ensureDir?.(); this.#ready = true }
          // A batch is cut in pieces that fit the ceiling: the live file never goes over it, whatever the burst.
          for (const text of pieces(lines, this.#max)) {
            await this.#rotateFor(text.length)
            await this.#d.io.appendText(join(this.#d.dir, auditFile(0)), text)
            this.#size = (this.#size ?? 0) + text.length
          }
        } catch (e) {
          // The batch is lost, counted and said later: a disk that fails must not make the queue grow or the loop spin.
          this.#dropped += lines.length
          this.#ready = false
          this.#d.log(`remote: audit not written (${(e as Error).message})`)
          return
        }
      }
    } finally { this.#busy = false }
  }

  /** Past the ceiling the files move one place up (the last one is replaced) and the live file starts empty. */
  async #rotateFor(add: number): Promise<void> {
    const path = (n: number): string => join(this.#d.dir, auditFile(n))
    if (this.#size === undefined) this.#size = await this.#d.io.stat(path(0)).then((s) => s.size, () => 0)
    if (this.#size === 0 || this.#size + add <= this.#max) return
    for (let n = this.#files - 2; n >= 0; n--) {
      if (await this.#d.io.exists(path(n))) await this.#d.io.rename(path(n), path(n + 1))
    }
    this.#size = 0
  }
}
