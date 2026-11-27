// The portal's reads of tetherd's extensions (step 3.4a; PIPE_REACH class `ext-read`): the ONE place of src/remoted/ that
// sends `ext-request`, and it sends only a pair of EXT_READS (src/remoted/gate.ts), chosen by the op the gate already let
// through. The device never names an extension or a request; the arguments are built by the house from the strict body
// of the op's line, never copied whole. What tetherd answers goes back as unknown JSON, to the op's projector.
//
// Ceilings: at most `max` reads in flight for the whole portal (all devices), each answered within `timeoutMs`; a read
// over the first is refused before it reaches the pipe, one over the second is given up (tetherd may still answer it; the
// answer is dropped).
import { EXT_READS, type ExtReadOp } from './gate.ts'

/** Reads in flight through the pipe, every device together. */
export const PIPE_READS_MAX = 8
/** How long a read may take before the device is answered `failed`. */
export const PIPE_READ_TIMEOUT_MS = 10_000

/** Why a read did not come back: over the ceiling, too slow, tetherd refused it with a code (`unknown-channel`…), or the pipe failed. */
export class ReadError extends Error {
  readonly why: 'limit' | 'timeout' | 'refused' | 'failed'
  readonly code: string | undefined
  constructor(why: ReadError['why'], code?: string) {
    super(code ? `${why}: ${code}` : why)
    this.why = why
    this.code = code
  }
}

/** The pipe request this module sends: exactly an `ext-request` (a DaemonClient's `request` fits). */
export type ExtRequestFn = (body: { t: 'ext-request'; ext: string; name: string; args: Record<string, unknown> }) => Promise<{ result?: unknown }>

export interface PipeReads {
  /** The answer of the pair of `op`, or a ReadError. */
  read(op: ExtReadOp, args: Record<string, unknown>): Promise<unknown>
}

export function pipeReads(request: ExtRequestFn, o: { max?: number; timeoutMs?: number } = {}): PipeReads {
  const max = o.max ?? PIPE_READS_MAX
  const timeoutMs = o.timeoutMs ?? PIPE_READ_TIMEOUT_MS
  let inflight = 0
  return {
    async read(op, args) {
      const pair = Object.hasOwn(EXT_READS, op) ? EXT_READS[op] : undefined
      if (!pair) throw new ReadError('refused', 'no-pair')
      if (inflight >= max) throw new ReadError('limit')
      inflight++
      let timer: ReturnType<typeof setTimeout> | undefined
      // The slot is held until tetherd answers, not until the device is: a read given up still costs tetherd until then.
      const asked = request({ t: 'ext-request', ext: pair.ext, name: pair.name, args })
      const release = (): void => { inflight-- }
      asked.then(release, release)
      try {
        const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadError('timeout')), timeoutMs) })
        const reply = await Promise.race([asked, late])
        return reply.result
      } catch (e) {
        if (e instanceof ReadError) throw e
        const code = (e as { code?: unknown }).code
        throw typeof code === 'string' ? new ReadError('refused', code) : new ReadError('failed')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
