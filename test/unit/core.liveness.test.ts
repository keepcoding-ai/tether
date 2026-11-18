import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { isAlive, pidExists, processStartTime } from '../../src/core/liveness.ts'
// The helper lives in the executor's operations; the unit tests run inline, so it is this very module instance.
import { startTimeHelperPid, startTimeMethod, startTimeStats, stopStartTimeHelper } from '../../src/exec/ops-os.ts'

const isWin = process.platform === 'win32'

test('processStartTime of the current process is a normalized ISO UTC string, stable across calls, and fast after the first', async () => {
  const t0 = performance.now()
  const a = await processStartTime(process.pid)
  const first = performance.now() - t0
  const t1 = performance.now()
  const b = await processStartTime(process.pid)
  const second = performance.now() - t1
  assert.ok(a, 'got a start time')
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(a, b)
  assert.ok(Math.abs(Date.parse(a) - Date.now()) < 10 * 60_000, 'start time is recent')
  // Windows: the first query starts the resident PowerShell helper (~0.8 s idle, seconds under load, never a
  // one-shot per query); from then on a query is ~10 ms idle, ~65 ms (p95 120 ms) under heavy load. The 1 s bound on
  // the second call is what proves the helper answered: a one-shot powershell.exe alone takes 0.7-2 s.
  assert.ok(first < 20_000, `first query took ${first.toFixed(0)}ms`)
  assert.ok(second < 1000, `second query took ${second.toFixed(0)}ms (helper not in use?)`)
  if (isWin) assert.equal(startTimeMethod(), 'helper')
})

test('Windows: the helper is restarted when it dies, and a stopped helper is started again by the next query', { skip: !isWin && 'Windows-only helper' }, async () => {
  const a = await processStartTime(process.pid)
  const pid = startTimeHelperPid()
  assert.ok(pid && pidExists(pid), 'a helper is running')
  const before = startTimeStats().helper
  // Kill it the hard way (what a killall of powershell, or a crash, does): the next query must still answer, fast.
  process.kill(pid) // our own child, by the pid we got from its handle moments ago
  const t0 = performance.now()
  const b = await processStartTime(process.pid)
  const ms = performance.now() - t0
  assert.equal(b, a)
  assert.ok(ms < 20_000, `recovered in ${ms.toFixed(0)}ms`)
  const again = startTimeHelperPid()
  assert.ok(again && again !== pid && pidExists(again), 'a new helper')
  assert.ok(startTimeStats().helper > before)
  assert.equal(startTimeMethod(), 'helper')

  stopStartTimeHelper()
  assert.equal(startTimeHelperPid(), undefined)
  assert.equal(await processStartTime(process.pid), a)
  assert.ok(startTimeHelperPid(), 'started again on demand')
  // Many queries at once go through the one helper, in order, each getting its own answer.
  const all = await Promise.all([process.pid, process.ppid, process.pid, process.ppid, process.pid].map((p) => processStartTime(p)))
  assert.deepEqual(all, [a, all[1], a, all[1], a])
  assert.equal(startTimeStats().oneShot, 0, 'no one-shot fallback was needed')
})

test('isAlive: current process with its real start time → true; wrong start time (reused pid) → false', async () => {
  const startedAt = (await processStartTime(process.pid))!
  assert.equal(await isAlive({ pid: process.pid, startedAt }), true)
  assert.equal(await isAlive({ pid: process.pid, agentPid: 1, startedAt }), true)
  assert.equal(await isAlive({ pid: process.pid, startedAt: '2001-01-01T00:00:00.000Z' }), false)
  assert.equal(await isAlive({ pid: process.pid, startedAt: '' }), false)
  assert.equal(await isAlive({ pid: process.pid, startedAt: 'not a date' }), false)
})

test('isAlive accepts the same instant written in another ISO spelling', async () => {
  const startedAt = (await processStartTime(process.pid))!
  const spelled = startedAt.replace('Z', '+00:00')
  assert.equal(await isAlive({ pid: process.pid, startedAt: spelled }), true)
})

test('dead pid → false quickly, without consulting the OS', async () => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  const pid = child.pid!
  await once(child, 'exit')
  // Give the OS a moment to reap it, then it must be gone (unless the pid got reused, which would be another live process).
  const t0 = performance.now()
  const alive = await isAlive({ pid, startedAt: '2001-01-01T00:00:00.000Z' })
  assert.equal(alive, false)
  if (!pidExists(pid)) assert.ok(performance.now() - t0 < 200, 'no OS query for a missing pid')
  assert.equal(await isAlive({ pid: 0, startedAt: 'x' }), false)
  assert.equal(await isAlive({ pid: -5, startedAt: 'x' }), false)
  assert.equal(await isAlive({ pid: 2 ** 31 - 1, startedAt: 'x' }), false)
  assert.equal(await processStartTime(2 ** 31 - 1), undefined)
})

test('a live child process: alive with its own time, not with the parent\'s', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' })
  try {
    const pid = child.pid!
    const childStart = await processStartTime(pid)
    assert.ok(childStart)
    assert.equal(await isAlive({ pid, startedAt: childStart }), true)
    const parentStart = (await processStartTime(process.pid))!
    if (parentStart !== childStart) assert.equal(await isAlive({ pid, startedAt: parentStart }), false)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})
