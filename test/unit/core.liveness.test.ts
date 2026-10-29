import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { isAlive, pidExists, processStartTime } from '../../src/core/liveness.ts'

test('processStartTime of the current process is a normalized ISO UTC string, stable across calls, and fast enough', async () => {
  const t0 = performance.now()
  const a = await processStartTime(process.pid)
  const elapsed = performance.now() - t0
  const b = await processStartTime(process.pid)
  assert.ok(a, 'got a start time')
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(a, b)
  assert.ok(Math.abs(Date.parse(a) - Date.now()) < 10 * 60_000, 'start time is recent')
  // ~0.7s alone on Windows (one powershell.exe); the bound is loose because test files run in parallel.
  assert.ok(elapsed < 5000, `took ${elapsed.toFixed(0)}ms`)
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
