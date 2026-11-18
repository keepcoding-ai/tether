// Executor worker: one per lane (`io`, `work`), same code. Runs each request from the coordinator against the
// closed table, in arrival order, and posts the reply. Exempt area of the sync ratchet.
import { parentPort, workerData } from 'node:worker_threads'
import { serializeError, type ExecReply, type ExecRequest } from './protocol.ts'
import { table } from './table.ts'

const delayMs = Number(workerData?.ioDelayMs ?? process.env.TETHER_TEST_IO_DELAY_MS ?? 0) || 0
const sleepCell = new Int32Array(new SharedArrayBuffer(4))

parentPort!.on('message', (req: ExecRequest) => {
  const t0 = performance.now()
  if (delayMs > 0) Atomics.wait(sleepCell, 0, 0, delayMs) // test hook: a slow disk, felt by this worker only
  let reply: ExecReply
  try {
    const fn = (table as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[req.op]
    if (!fn) throw new Error(`unknown operation: ${req.op}`)
    reply = { id: req.id, ok: true, value: fn(...req.args), ms: 0 }
  } catch (e) {
    reply = { id: req.id, ok: false, error: serializeError(e), ms: 0 }
  }
  reply.ms = Math.round((performance.now() - t0) * 10) / 10
  parentPort!.postMessage(reply)
})
