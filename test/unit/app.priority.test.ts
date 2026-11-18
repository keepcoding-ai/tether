// E2.7: the app raises its own main, the GPU process and the main window's renderer, nothing else; the switch turns it off.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPriorityPass, pidsToRaise, startPriorityKeeper } from '../../app/main/priority.ts'
import { PRIORITY_ABOVE_NORMAL } from '../../src/procd/priority.ts'

const metrics = [
  { pid: 10, type: 'Browser' }, { pid: 11, type: 'GPU' }, { pid: 12, type: 'Tab' }, { pid: 13, type: 'Tab' },
  { pid: 14, type: 'Utility' }, { pid: 15, type: 'Utility' },
]

describe('app priorities', () => {
  test('picks main, GPU and the window renderer only', () => {
    assert.deepEqual(pidsToRaise(metrics, 10, new Set([12])).sort(), [10, 11, 12])
  })
  test('every pass reapplies ABOVE_NORMAL (Chromium resets renderers)', () => {
    const calls: [number, number][] = []
    const pass = createPriorityPass({ enabled: true, getMetrics: () => metrics, rendererPids: () => new Set([12]), selfPid: 10, set: (p, v) => calls.push([p, v]) })
    pass(); pass()
    assert.equal(calls.length, 6)
    assert.ok(calls.every(([, v]) => v === PRIORITY_ABOVE_NORMAL))
  })
  test('a failing setPriority is logged once and ignored', () => {
    const logs: string[] = []
    const pass = createPriorityPass({ enabled: true, getMetrics: () => metrics, rendererPids: () => new Set([12]), selfPid: 10, set: () => { throw new Error('denied') }, log: (m) => logs.push(m) })
    pass(); pass()
    assert.equal(logs.length, 1)
  })
  test('disabled: nothing is touched, no timer', () => {
    let n = 0
    const k = startPriorityKeeper({ enabled: false, getMetrics: () => metrics, rendererPids: () => new Set([12]), set: () => { n++ } })
    k.pass(); k.stop()
    assert.equal(n, 0)
  })
})
