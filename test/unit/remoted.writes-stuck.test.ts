// pipeWrites (src/remoted/writes.ts) with a tetherd that stops answering (RR3 gate O-6, RR4 temper): the real outcome gives up
// at `settleMs` (what waits on it is freed) and the late ceiling held for `stuckMs` calls `onStuck` once.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { pipeWrites, WriteError } from '../../src/remoted/writes.ts'

const never = (): Promise<never> => new Promise(() => {})
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('pipeWrites with a tetherd that does not answer', () => {
  test('settled gives up with timeout at settleMs, while the late count still waits for the real answer', async () => {
    const writes = pipeWrites(never, { timeoutMs: 10, settleMs: 40 })
    const f = writes.write('channels.say', { text: 'x' })
    await assert.rejects(f.answer, (e: unknown) => e instanceof WriteError && e.why === 'timeout')
    const o = await f.settled
    assert.ok(!o.ok && o.error.why === 'timeout')
    assert.equal(writes.late, 1)
  })

  test('the late ceiling held for stuckMs calls onStuck once; one answer below the ceiling stops the clock', async () => {
    let stuck = 0
    const answers: Array<() => void> = []
    const writes = pipeWrites(() => new Promise((resolve) => { answers.push(() => resolve({ result: {} })) }), {
      max: 8, lateMax: 2, timeoutMs: 5, settleMs: 10_000, stuckMs: 60, onStuck: () => { stuck++ },
    })
    const say = (): void => { writes.write('channels.say', {}).answer.catch(() => {}) }
    say(); say()
    await sleep(30)
    assert.equal(writes.late, 2)
    answers[0]!()
    await sleep(100)
    assert.equal(stuck, 0, 'below the ceiling the clock stopped')
    say()
    await sleep(30)
    assert.equal(writes.late, 2)
    await sleep(120)
    assert.equal(stuck, 1)
    answers.forEach((a) => a())
  })
})
