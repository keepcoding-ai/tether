// The hand-off of "Reiniciar o app" (app/main/relaunch.ts): the flag that names the replaced pid, the next
// instance's arguments, and which second-instance acks count as a live window.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ackFromLiveInstance, RELAUNCHED_FROM_FLAG, relaunchArgs, relaunchedFrom } from '../../app/main/relaunch.ts'

describe('relaunchedFrom', () => {
  test('reads the pid from the flag, anywhere in argv', () => {
    assert.equal(relaunchedFrom(['electron.exe', 'app\\dist\\main.cjs', `${RELAUNCHED_FROM_FLAG}4242`]), 4242)
    assert.equal(relaunchedFrom(['electron.exe', `${RELAUNCHED_FROM_FLAG}7`, 'main.cjs']), 7)
  })
  test('undefined without the flag or with a pid that is not one', () => {
    assert.equal(relaunchedFrom(['electron.exe', 'app\\dist\\main.cjs']), undefined)
    assert.equal(relaunchedFrom(['electron.exe', `${RELAUNCHED_FROM_FLAG}`]), undefined)
    assert.equal(relaunchedFrom(['electron.exe', `${RELAUNCHED_FROM_FLAG}abc`]), undefined)
    assert.equal(relaunchedFrom(['electron.exe', `${RELAUNCHED_FROM_FLAG}-3`]), undefined)
  })
})

describe('relaunchArgs', () => {
  test('keeps the Start Menu arguments as they are (relative path included) and appends this pid', () => {
    assert.deepEqual(relaunchArgs(['C:\\e\\electron.exe', 'app\\dist\\main.cjs'], 100), ['app\\dist\\main.cjs', `${RELAUNCHED_FROM_FLAG}100`])
  })
  test('keeps other switches and replaces an inherited flag (a relaunch of a relaunch)', () => {
    assert.deepEqual(
      relaunchArgs(['electron', 'main.cjs', '--remote-debugging-port=0', `${RELAUNCHED_FROM_FLAG}5`], 6),
      ['main.cjs', '--remote-debugging-port=0', `${RELAUNCHED_FROM_FLAG}6`],
    )
  })
})

describe('ackFromLiveInstance', () => {
  const startedAt = 1_000_000
  test('an ack newer than this process from another pid is a live window', () => {
    assert.equal(ackFromLiveInstance({ at: startedAt + 50, pid: 11 }, startedAt, undefined), true)
    assert.equal(ackFromLiveInstance({ at: startedAt, pid: 11 }, startedAt, 22), true)
  })
  test('an older ack, or none, is not', () => {
    assert.equal(ackFromLiveInstance({ at: startedAt - 1, pid: 11 }, startedAt, undefined), false)
    assert.equal(ackFromLiveInstance({}, startedAt, undefined), false)
    assert.equal(ackFromLiveInstance({ at: 'x', pid: 11 }, startedAt, undefined), false)
  })
  test('the instance this launch replaces is not a live window, however fresh its ack', () => {
    assert.equal(ackFromLiveInstance({ at: startedAt + 50, pid: 22 }, startedAt, 22), false)
    assert.equal(ackFromLiveInstance({ at: startedAt + 50, pid: 23 }, startedAt, 22), true)
  })
})
