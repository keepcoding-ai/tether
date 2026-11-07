// tetherd's self-protection policy (src/daemon/guard.ts): uncaught errors are logged with their stack and the
// daemon keeps serving while the server is up; it exits when the server is gone or the errors come in a storm.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGuard, UNCAUGHT_LIMIT, UNCAUGHT_WINDOW_MS } from '../../src/daemon/guard.ts'

function setup(healthy: () => boolean) {
  const lines: string[] = []
  let t = 1_000_000
  const guard = createGuard({ log: (m) => lines.push(m), healthy, now: () => t })
  return { guard, lines, tick: (ms: number) => { t += ms } }
}

test('an uncaught exception is logged with its stack and the daemon keeps serving while the server listens', () => {
  const { guard, lines } = setup(() => true)
  const e = new Error('boom')
  assert.equal(guard.uncaught(e), false)
  assert.match(lines[0]!, /uncaught exception: Error: boom\n\s+at /)
  assert.match(lines[1]!, /continuing: server still listening \(1\/5/)
})

test('an unhandled rejection is logged (reason with or without a stack) and never exits', () => {
  const { guard, lines } = setup(() => true)
  guard.unhandled(new Error('later'))
  guard.unhandled('texto')
  assert.match(lines[0]!, /unhandled rejection: Error: later\n\s+at /)
  assert.equal(lines[1], 'unhandled rejection: texto')
})

test('the daemon exits when the server is no longer listening after the error', () => {
  const { guard, lines } = setup(() => false)
  assert.equal(guard.uncaught(new Error('x')), true)
  assert.match(lines.at(-1)!, /fatal: server no longer listening/)
})

test(`more than ${UNCAUGHT_LIMIT} uncaught exceptions inside the window are fatal; old ones fall out of the window`, () => {
  const { guard, lines, tick } = setup(() => true)
  for (let i = 0; i < UNCAUGHT_LIMIT; i++) { assert.equal(guard.uncaught(new Error(`e${i}`)), false); tick(1000) }
  assert.equal(guard.uncaught(new Error('one too many')), true)
  assert.match(lines.at(-1)!, new RegExp(`fatal: ${UNCAUGHT_LIMIT + 1} uncaught exceptions in ${UNCAUGHT_WINDOW_MS / 1000} s`))
  const fresh = setup(() => true)
  for (let i = 0; i < UNCAUGHT_LIMIT; i++) { fresh.guard.uncaught(new Error('old')); fresh.tick(UNCAUGHT_WINDOW_MS / UNCAUGHT_LIMIT + 1) }
  assert.equal(fresh.guard.uncaught(new Error('after the window')), false, 'errors older than the window do not count')
})

test('the guard also files uncaught errors and rejections in the registry (record), keeping the log line', () => {
  const lines: string[] = []
  const filed: string[] = []
  const guard = createGuard({ log: m => lines.push(m), healthy: () => true, record: (kind, e) => filed.push(`${kind}:${(e as Error).message}`) })
  guard.uncaught(new Error('a'))
  guard.unhandled(new Error('b'))
  assert.deepEqual(filed, ['uncaught:a', 'rejection:b'])
  assert.match(lines[0]!, /uncaught exception/)
})

test('a record that throws never reaches the daemon', () => {
  const guard = createGuard({ log: () => {}, healthy: () => true, record: () => { throw new Error('disk full') } })
  assert.equal(guard.uncaught(new Error('a')), false)
  guard.unhandled('x')
})
