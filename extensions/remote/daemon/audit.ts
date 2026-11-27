// The remote's audit (plano §2 "Na máquina", M-10): one JSON line per act in <home>/remote/audit.jsonl, written only by the
// extension (the portal sends its lines as notes). A line says when, which device, which act, which target by id and the
// result; never content: no env value, no argument, no typed text. Every field is cut to the id alphabet `^[\w.:-]{1,64}$`
// here, at the single place that writes, so a caller cannot put content in by mistake.
//
// The log is rotated by size and by count (audit.jsonl, audit.1.jsonl … audit.<N-1>.jsonl: the oldest is replaced by the
// rename of the next one, nothing is deleted) and the writer never holds the loop: `record` is synchronous and only queues;
// one writer drains the queue in batches. A disk that stalls cannot grow it: the queue has a ceiling, what does not fit is
// counted and said in one `audit.dropped` line when the disk answers again.
//
// The audited cannot rotate the log away (M-3 of the RR2 gate):
// - A line equal to one written less than COALESCE_WINDOW_MS ago (same act, device, target and result) is not written
//   again: it is counted, and when the window closes one line with the same fields and `n:<count>` says how many came.
// - The security lines (pairing, revocation, the registration and the accepted proofs of biometrics, the lockout, the
//   notices of the relay, the remote turned on or off, the address of the phone's app and the credentials it voids) also go to audit-security.jsonl, a rotation of their own that no
//   common line touches, so a flood of refusals never pushes them off the disk.
import { join } from 'node:path'
import type { DaemonIo } from '../../../src/daemon/ext-api.ts'

export const AUDIT_MAX_BYTES = 256 * 1024
/** The live file plus the rotated ones: the log never holds more than AUDIT_FILES_MAX × AUDIT_MAX_BYTES (1 MiB). */
export const AUDIT_FILES_MAX = 4
/** The security lines' own rotation: AUDIT_SECURITY_FILES_MAX × AUDIT_MAX_BYTES (512 KiB) besides the 1 MiB. */
export const AUDIT_SECURITY_FILES_MAX = 2
/** Lines waiting for the disk, per rotation. An honest burst (a pairing, a flood of limits) is far below it. */
export const AUDIT_PENDING_MAX = 256
/** Equal lines within this window become one line and a count. */
export const COALESCE_WINDOW_MS = 60_000
/** Open windows at most; past it the oldest closes early (its count is written), so the memory is bounded. */
export const COALESCE_KEYS_MAX = 1024

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
  securityMaxFiles?: number
  pendingMax?: number
  coalesceMs?: number
}

/** The id alphabet: anything else becomes `-`, and a field is at most 64 characters. */
export function auditField(v: string): string {
  const s = v.replace(/[^\w.:-]/g, '-').slice(0, 64)
  return s || '-'
}

/** Acts that are security lines whatever their result: none of them can be repeated at will by a paired device. */
const SECURITY_ACTS = /^(pair\.[\w.-]+|remote\.(on|off|web)|relay\.notice|portal\.exit|uv\.lockout|uv\.sign-count|uv\.credential-stale|device\.revoke\.closed)$/
/** Acts that are security lines when they happened (a device's refused attempts are common lines: it can repeat them). */
const SECURITY_WHEN_DONE = /^(uv\.register|uv\.assert|device\.revoke|device\.revoke-self)$/
const DONE = /^(ok|by:)/

/** Whether a line goes to the security rotation too. Decided on the fields as written (already cut). */
export function securityLine(act: string, result: string): boolean {
  return SECURITY_ACTS.test(act) || (SECURITY_WHEN_DONE.test(act) && DONE.test(result))
}

function* pieces(lines: readonly string[], max: number): Generator<string> {
  let cur = ''
  for (const l of lines) {
    if (cur && cur.length + l.length > max) { yield cur; cur = '' }
    cur += l
  }
  if (cur) yield cur
}

export const auditFile = (n: number): string => (n === 0 ? 'audit.jsonl' : `audit.${n}.jsonl`)
export const securityFile = (n: number): string => (n === 0 ? 'audit-security.jsonl' : `audit-security.${n}.jsonl`)

/** One rotated set of files with its queue: the live file never goes over `max`, the set never over `files` files. */
class Rotation {
  queue: string[] = []
  dropped = 0
  #size: number | undefined
  readonly name: (n: number) => string
  readonly max: number
  readonly files: number
  readonly pendingMax: number
  constructor(name: (n: number) => string, max: number, files: number, pendingMax: number) {
    this.name = name
    this.max = max
    this.files = files
    this.pendingMax = pendingMax
  }

  push(text: string): void {
    if (this.queue.length >= this.pendingMax) this.dropped++
    else this.queue.push(text)
  }

  get waiting(): boolean { return this.queue.length > 0 || this.dropped > 0 }

  async write(d: AuditDeps, lines: readonly string[]): Promise<void> {
    for (const text of pieces(lines, this.max)) {
      await this.#rotateFor(d, text.length)
      await d.io.appendText(join(d.dir, this.name(0)), text)
      this.#size = (this.#size ?? 0) + text.length
    }
  }

  /** Past the ceiling the files move one place up (the last one is replaced) and the live file starts empty. */
  async #rotateFor(d: AuditDeps, add: number): Promise<void> {
    const path = (n: number): string => join(d.dir, this.name(n))
    if (this.#size === undefined) this.#size = await d.io.stat(path(0)).then((s) => s.size, () => 0)
    if (this.#size === 0 || this.#size + add <= this.max) return
    for (let n = this.files - 2; n >= 0; n--) {
      if (await d.io.exists(path(n))) await d.io.rename(path(n), path(n + 1))
    }
    this.#size = 0
  }

  forget(): void { this.#size = undefined }
}

/** A line written, with the equal ones counted since. */
interface Window { e: AuditEntry; openedMs: number; n: number }

export class AuditLog {
  readonly #d: AuditDeps
  readonly #common: Rotation
  readonly #security: Rotation
  readonly #windowMs: number
  /** key → the window of a line written; insertion order is opening order, so the oldest is first. */
  readonly #windows = new Map<string, Window>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #busy = false
  #ready = false
  #loop: Promise<void> = Promise.resolve()

  constructor(deps: AuditDeps) {
    this.#d = deps
    const max = deps.maxBytes ?? AUDIT_MAX_BYTES
    const pendingMax = deps.pendingMax ?? AUDIT_PENDING_MAX
    this.#common = new Rotation(auditFile, max, Math.max(2, deps.maxFiles ?? AUDIT_FILES_MAX), pendingMax)
    this.#security = new Rotation(securityFile, max, Math.max(2, deps.securityMaxFiles ?? AUDIT_SECURITY_FILES_MAX), pendingMax)
    this.#windowMs = deps.coalesceMs ?? COALESCE_WINDOW_MS
  }

  /** Queues one line, or counts it in the open window of an equal one; never waits for the disk and never throws. */
  record(entry: AuditEntry): void {
    const e = {
      act: auditField(entry.act), result: auditField(entry.result),
      ...(entry.device ? { device: auditField(entry.device) } : {}), ...(entry.target ? { target: auditField(entry.target) } : {}),
    }
    const nowMs = this.#d.now()
    this.#close(nowMs, false)
    const key = `${e.act}\u0000${e.device ?? ''}\u0000${e.target ?? ''}\u0000${e.result}`
    const w = this.#windows.get(key)
    if (w) {
      w.n++
      this.#arm()
      return
    }
    if (this.#windows.size >= COALESCE_KEYS_MAX) {
      const [oldKey, oldest] = this.#windows.entries().next().value!
      this.#windows.delete(oldKey)
      this.#emitCount(oldest)
    }
    this.#windows.set(key, { e, openedMs: nowMs, n: 0 })
    this.#enqueue(e)
  }

  /** Resolves when everything recorded so far was written (or lost), counts of open windows included. For shutdown and tests. */
  async flush(): Promise<void> {
    this.#close(this.#d.now(), true)
    this.#kick()
    await this.#loop
  }

  #enqueue(e: AuditEntry & { n?: number }): void {
    const text = this.#line(e)
    this.#common.push(text)
    if (securityLine(e.act, e.result)) this.#security.push(text)
    this.#kick()
  }

  #emitCount(w: Window): void {
    if (w.n > 0) this.#enqueue({ ...w.e, n: w.n })
    w.n = 0
  }

  /** Closes the windows past their time (writing their counts); `all` also writes the counts of the open ones and keeps them open. */
  #close(nowMs: number, all: boolean): void {
    for (const [key, w] of this.#windows) {
      if (nowMs - w.openedMs >= this.#windowMs) { this.#windows.delete(key); this.#emitCount(w); continue }
      if (!all) break // opening order: the rest are younger
      this.#emitCount(w)
    }
  }

  /** One timer for the whole log, while some window holds a count: a count is written even if nothing else comes. */
  #arm(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#close(this.#d.now(), false)
      if ([...this.#windows.values()].some((w) => w.n > 0)) this.#arm()
    }, this.#windowMs)
    this.#timer.unref?.()
  }

  #line(e: AuditEntry & { n?: number }): string {
    return JSON.stringify({
      ts: new Date(this.#d.now()).toISOString(), act: e.act,
      ...(e.device ? { device: e.device } : {}), ...(e.target ? { target: e.target } : {}),
      result: e.result, ...(e.n ? { n: e.n } : {}),
    }) + '\n'
  }

  #kick(): void {
    if (this.#busy) return
    this.#busy = true
    this.#loop = this.#drain()
  }

  async #drain(): Promise<void> {
    try {
      while (this.#common.waiting || this.#security.waiting) {
        for (const r of [this.#common, this.#security]) {
          const lines = r.queue
          r.queue = []
          if (r.dropped > 0) {
            lines.push(this.#line({ act: 'audit.dropped', result: `n:${r.dropped}` }))
            r.dropped = 0
          }
          if (lines.length === 0) continue
          try {
            if (!this.#ready) { await this.#d.ensureDir?.(); this.#ready = true }
            // A batch is cut in pieces that fit the ceiling: the live file never goes over it, whatever the burst.
            await r.write(this.#d, lines)
          } catch (e) {
            // The batch is lost, counted and said later: a disk that fails must not make the queue grow or the loop spin.
            r.dropped += lines.length
            r.forget()
            this.#ready = false
            this.#d.log(`remote: audit not written (${(e as Error).message})`)
            return
          }
        }
      }
    } finally { this.#busy = false }
  }
}
