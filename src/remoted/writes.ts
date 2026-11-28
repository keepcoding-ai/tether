// The portal's writes to tetherd's extensions (step 4.2a; PIPE_REACH class `ext-read`, the pairs of EXT_WRITES): the
// person's speech in a channel. A path of its own, beside ./reads.ts and never sharing its slots: a write sends only the
// pair of EXT_WRITES its op names (src/remoted/reach.ts), with the arguments src/remote/talk.ts rebuilt from the checked
// body. The device never names an extension or a request.
//
// The deadline is the device's, not the slot's (RR3 gate O-6): the device is answered `timeout` at `timeoutMs` and the
// slot is freed then, but the write is not forgotten. It is counted as `late` until tetherd answers it, and its real
// outcome (`settled`) still comes, so the house can keep it for the same actId. Ceilings, every device together: `max`
// writes in flight, `lateMax` late ones; over either a write is refused before the pipe. Every change of the late count
// leaves one log line with the count (a tetherd that stops answering shows in the log, not only in refusals).
import { EXT_WRITES, type ExtWriteOp } from './reach.ts'
import type { ExtRequestFn } from './reads.ts'

/** Writes in flight through the pipe, every device together (the reads have their own 8). */
export const PIPE_WRITES_MAX = 4
/** How long a write may take before the device is answered `timeout`. */
export const PIPE_WRITE_TIMEOUT_MS = 10_000
/** Writes past their deadline that tetherd has not answered yet: over it, no write is sent until one comes back. */
export const PIPE_WRITES_LATE_MAX = 8
/** How long the real outcome of a write may take for what waits on it (`settled`): past it, `timeout` (a speech's uploads are freed). */
export const PIPE_WRITE_SETTLE_MS = 10 * 60_000
/** How long the late ceiling may stay reached before the portal leaves to be reborn. */
export const PIPE_WRITES_STUCK_MS = 60_000

/** Why a write did not come back: over a ceiling, past its deadline, refused by tetherd with a code, or the pipe failed. */
export class WriteError extends Error {
  readonly why: 'limit' | 'timeout' | 'refused' | 'failed'
  readonly code: string | undefined
  constructor(why: WriteError['why'], code?: string) {
    super(code ? `${why}: ${code}` : why)
    this.why = why
    this.code = code
  }
}

/** The real outcome of a write, whenever tetherd gives it (`limit` when it was never sent). */
export type WriteOutcome = { ok: true; result: unknown } | { ok: false; error: WriteError }

export interface WriteFlight {
  /** What the device is told: the result, or a WriteError (`timeout` at the deadline). */
  answer: Promise<unknown>
  /** The real outcome; never rejects. Past the deadline it still comes, when tetherd answers. */
  settled: Promise<WriteOutcome>
}

export interface PipeWrites {
  write(op: ExtWriteOp, args: Record<string, unknown>): WriteFlight
  /** Writes in flight now, and the late ones (diagnostics and tests). */
  readonly inflight: number
  readonly late: number
}

const outcomeOf = (e: unknown): WriteError => {
  if (e instanceof WriteError) return e
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? new WriteError('refused', code) : new WriteError('failed')
}

export interface PipeWritesOptions {
  max?: number
  timeoutMs?: number
  lateMax?: number
  /** How long a write's real outcome may take before `settled` gives up on it (`timeout`), so what waits on it is freed. */
  settleMs?: number
  /** How long the late ceiling may stay reached before `onStuck` is called. */
  stuckMs?: number
  /** The late ceiling stayed reached for `stuckMs`: tetherd does not answer; the portal should leave and be reborn. Once per stretch. */
  onStuck?: () => void
  log?: (m: string) => void
}

export function pipeWrites(request: ExtRequestFn, o: PipeWritesOptions = {}): PipeWrites {
  const max = o.max ?? PIPE_WRITES_MAX
  const timeoutMs = o.timeoutMs ?? PIPE_WRITE_TIMEOUT_MS
  const lateMax = o.lateMax ?? PIPE_WRITES_LATE_MAX
  const settleMs = o.settleMs ?? PIPE_WRITE_SETTLE_MS
  const stuckMs = o.stuckMs ?? PIPE_WRITES_STUCK_MS
  const log = o.log ?? (() => {})
  let inflight = 0
  let late = 0
  let stuckTimer: ReturnType<typeof setTimeout> | undefined
  // The ceiling reached starts the clock; one answer below it stops it. Past `stuckMs` the portal is told once.
  const watchStuck = (): void => {
    if (late >= lateMax) {
      if (stuckTimer !== undefined || !o.onStuck) return
      stuckTimer = setTimeout(() => {
        log(`pipe: ${late} writes late at tetherd for ${Math.round(stuckMs / 1000)} s, the portal leaves`)
        o.onStuck?.()
      }, stuckMs)
      stuckTimer.unref?.()
    } else if (stuckTimer !== undefined) { clearTimeout(stuckTimer); stuckTimer = undefined }
  }
  return {
    get inflight() { return inflight },
    get late() { return late },
    write(op, args) {
      const pair = Object.hasOwn(EXT_WRITES, op) ? EXT_WRITES[op] : undefined
      if (!pair || inflight >= max || late >= lateMax) {
        const error = pair ? new WriteError('limit') : new WriteError('refused', 'no-pair')
        if (pair && late >= lateMax) log(`pipe: a write refused, ${late} late at tetherd`)
        return { answer: Promise.reject(error), settled: Promise.resolve({ ok: false, error }) }
      }
      inflight++
      let state: 'flight' | 'late' | 'done' = 'flight'
      const real: Promise<WriteOutcome> = request({ t: 'ext-request', ext: pair.ext, name: pair.name, args }).then(
        (reply): WriteOutcome => ({ ok: true, result: reply.result }),
        (e: unknown): WriteOutcome => ({ ok: false, error: outcomeOf(e) }),
      )
      // What the house keeps (a speech's files marked `said`) must not wait forever for a tetherd that never answers: past
      // `settleMs` the outcome is `timeout`. The late count below still follows the real answer.
      let giveUp: ReturnType<typeof setTimeout> | undefined
      const settled: Promise<WriteOutcome> = Promise.race([
        real,
        new Promise<WriteOutcome>((resolve) => { giveUp = setTimeout(() => resolve({ ok: false, error: new WriteError('timeout') }), settleMs); giveUp.unref?.() }),
      ])
      void real.then(() => clearTimeout(giveUp))
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<WriteOutcome>((resolve) => {
        timer = setTimeout(() => {
          if (state !== 'flight') return
          state = 'late'
          inflight--
          late++
          log(`pipe: a write past its deadline, ${late} late at tetherd`)
          watchStuck()
          resolve({ ok: false, error: new WriteError('timeout') })
        }, timeoutMs)
      })
      void real.then(() => {
        clearTimeout(timer)
        if (state === 'flight') inflight--
        else if (state === 'late') { late--; log(`pipe: a late write answered, ${late} late at tetherd`); watchStuck() }
        state = 'done'
      })
      const answer = Promise.race([real, deadline]).then((r) => { if (r.ok) return r.result; throw r.error })
      return { answer, settled }
    },
  }
}
