import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyThrottleSwitches, throttleSwitches, throttlingWanted } from '../../app/main/throttle.ts'

test('throttling off (default): only disable-features=CalculateNativeWinOcclusion', () => {
  const calls: Array<[string, string | undefined]> = []
  applyThrottleSwitches({ appendSwitch: (n, v) => calls.push([n, v]) }, false)
  assert.deepEqual(throttleSwitches(false), { flags: [], disableFeatures: ['CalculateNativeWinOcclusion'] })
  assert.deepEqual(calls, [
    ['disable-features', 'CalculateNativeWinOcclusion'],
  ])
})

test('throttling on: nothing is appended', () => {
  const calls: unknown[] = []
  applyThrottleSwitches({ appendSwitch: (...a) => calls.push(a) }, true)
  assert.deepEqual(calls, [])
  assert.deepEqual(throttleSwitches(true), { flags: [], disableFeatures: [] })
})

test('restore key: env or settings', () => {
  assert.equal(throttlingWanted(undefined, undefined), false)
  assert.equal(throttlingWanted('1', undefined), true)
  assert.equal(throttlingWanted(undefined, true), true)
  assert.equal(throttlingWanted('0', false), false)
})
