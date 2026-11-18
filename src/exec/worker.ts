// Executor worker: one per lane (`io`, `work`), same code. Runs each request from the coordinator against the
// closed table and posts the reply: synchronous operations in arrival order, asynchronous ones (process creation) as they
// settle, so slow children overlap. Exempt area of the sync ratchet.
import { parentPort, workerData } from 'node:worker_threads'
import { serializeError, type ExecReply, type ExecRequest } from './protocol.ts'
import { table } from './table.ts'

const delayMs = Number(workerData?.ioDelayMs ?? process.env.TETHER_TEST_IO_DELAY_MS ?? 0) || 0
const sleepCell = new Int32Array(new SharedArrayBuffer(4))

const post = (reply: ExecReply, t0: number): void => {
  reply.ms = Math.round((performance.now() - t0) * 10) / 10
  parentPort!.postMessage(reply)
}

parentPort!.on('message', (req: ExecRequest) => {
  const t0 = performance.now()
  if (delayMs > 0) Atomics.wait(sleepCell, 0, 0, delayMs) // test hook: a slow disk, felt by this worker only
  try {
    const fn = (table as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[req.op]
    if (!fn) throw new Error(`unknown operation: ${req.op}`)
    const value = fn(...req.args)
    if (value instanceof Promise) {
      value.then(
        (v) => post({ id: req.id, ok: true, value: v, ms: 0 }, t0),
        (e) => post({ id: req.id, ok: false, error: serializeError(e), ms: 0 }, t0),
      )
      return
    }
    post({ id: req.id, ok: true, value, ms: 0 }, t0)
  } catch (e) {
    post({ id: req.id, ok: false, error: serializeError(e), ms: 0 }, t0)
  }
})
