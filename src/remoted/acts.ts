// The portal's management acts on tetherd (RR5 5.2; PIPE_REACH class `op`): one pipe message per op, built by
// src/remote/manage.ts from the checked body and checked AGAIN here by the very rule tetherd refuses by
// (./reach.ts remoteMayAct), so the portal never sends what tetherd would not take, and a message outside the rule never
// leaves. A path of its own, beside ./reads.ts and ./writes.ts, never sharing their slots.
//
// Like the writes (./writes.ts), an act answers the device by its deadline and is not forgotten past it: it counts as
// `late` until tetherd answers, and its real outcome (`settled`) still comes, so the house keeps it for the same actId.
// Ceilings, every device together: `max` acts in flight and `lateMax` late ones; the reads of this path (a list, a
// process's card, a ronda) have their own `readMax`. Over a ceiling nothing is sent. The deadline is longer than a write's:
// stopping a process waits for its grace, and a restart answers once the new run is up.
import { remoteMayAct } from './reach.ts'
import type { ActMessage } from '../remote/manage.ts'

/** Acts in flight through the pipe, every device together. */
export const PIPE_ACTS_MAX = 4
/** How long an act may take before the device is answered `timeout` (a process's grace, an agent's minimum age). */
export const PIPE_ACT_TIMEOUT_MS = 30_000
/** Acts past their deadline that tetherd has not answered yet: over it, no act is sent until one comes back. */
export const PIPE_ACTS_LATE_MAX = 8
/** Reads of this path in flight, and how long one may take. */
export const PIPE_ACT_READS_MAX = 4
export const PIPE_ACT_READ_TIMEOUT_MS = 10_000

/** One pipe request (the portal's DaemonClient): resolves with the `ok` reply, rejects with an error that has a `code`. */
export type PipeRequestFn = (msg: ActMessage) => Promise<Record<string, unknown>>

/** Why an act did not come back: over a ceiling, past its deadline, refused by tetherd with a code, or the pipe failed. */
export class ActError extends Error {
  readonly why: 'limit' | 'timeout' | 'refused' | 'failed'
  readonly code: string | undefined
  constructor(why: ActError['why'], code?: string) {
    super(code ? `${why}: ${code}` : why)
    this.why = why
    this.code = code
  }
}

export type ActOutcome = { ok: true; reply: Record<string, unknown> } | { ok: false; error: ActError }

export interface ActFlight {
  /** What the device is told: the reply, or an ActError (`timeout` at the deadline). */
  answer: Promise<Record<string, unknown>>
  /** The real outcome; never rejects. Past the deadline it still comes, when tetherd answers. */
  settled: Promise<ActOutcome>
}

export interface PipeActs {
  /** An act that changes state. */
  act(msg: ActMessage): ActFlight
  /** A read of this path (no state): the reply, or an ActError. */
  read(msg: ActMessage): Promise<Record<string, unknown>>
  readonly inflight: number
  readonly late: number
}

const errorOf = (e: unknown): ActError => {
  if (e instanceof ActError) return e
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? new ActError('refused', code) : new ActError('failed')
}

export interface PipeActsOptions { max?: number; timeoutMs?: number; lateMax?: number; readMax?: number; readTimeoutMs?: number; log?: (m: string) => void }

export function pipeActs(request: PipeRequestFn, o: PipeActsOptions = {}): PipeActs {
  const max = o.max ?? PIPE_ACTS_MAX
  const timeoutMs = o.timeoutMs ?? PIPE_ACT_TIMEOUT_MS
  const lateMax = o.lateMax ?? PIPE_ACTS_LATE_MAX
  const readMax = o.readMax ?? PIPE_ACT_READS_MAX
  const readTimeoutMs = o.readTimeoutMs ?? PIPE_ACT_READ_TIMEOUT_MS
  const log = o.log ?? (() => {})
  let inflight = 0
  let late = 0
  let reading = 0
  const send = (msg: ActMessage): Promise<Record<string, unknown>> => request(msg)
  return {
    get inflight() { return inflight },
    get late() { return late },
    act(msg) {
      const allowed = remoteMayAct(msg)
      if (!allowed || inflight >= max || late >= lateMax) {
        const error = allowed ? new ActError('limit') : new ActError('refused', 'outside-reach')
        if (allowed && late >= lateMax) log(`pipe: an act refused, ${late} late at tetherd`)
        return { answer: Promise.reject(error), settled: Promise.resolve({ ok: false, error }) }
      }
      inflight++
      let state: 'flight' | 'late' | 'done' = 'flight'
      const settled: Promise<ActOutcome> = send(msg).then(
        (reply): ActOutcome => ({ ok: true, reply }),
        (e: unknown): ActOutcome => ({ ok: false, error: errorOf(e) }),
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<ActOutcome>((resolve) => {
        timer = setTimeout(() => {
          if (state !== 'flight') return
          state = 'late'
          inflight--
          late++
          log(`pipe: an act past its deadline, ${late} late at tetherd`)
          resolve({ ok: false, error: new ActError('timeout') })
        }, timeoutMs)
      })
      void settled.then(() => {
        clearTimeout(timer)
        if (state === 'flight') inflight--
        else if (state === 'late') { late--; log(`pipe: a late act answered, ${late} late at tetherd`) }
        state = 'done'
      })
      const answer = Promise.race([settled, deadline]).then((r) => { if (r.ok) return r.reply; throw r.error })
      return { answer, settled }
    },
    async read(msg) {
      if (!remoteMayAct(msg)) throw new ActError('refused', 'outside-reach')
      if (reading >= readMax) throw new ActError('limit')
      reading++
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          send(msg).catch((e: unknown) => { throw errorOf(e) }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ActError('timeout')), readTimeoutMs) }),
        ])
      } finally {
        clearTimeout(timer)
        reading--
      }
    },
  }
}
