// E2.7/E4.1: the app raises its own main, the GPU process and the main window's renderer, nothing else; it checks often,
// sets only what fell and counts the falls; the switch turns it off.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPriorityPass, pidsToRaise, priorityStats, startPriorityKeeper } from '../../app/main/priority.ts'
import { PRIORITY_ABOVE_NORMAL } from '../../src/procd/priority.ts'

const metrics = [
  { pid: 10, type: 'Browser' }, { pid: 11, type: 'GPU' }, { pid: 12, type: 'Tab' }, { pid: 13, type: 'Tab' },
  { pid: 14, type: 'Utility' }, { pid: 15, type: 'Utility' },
]

function rig(over: Partial<Parameters<typeof createPriorityPass>[0]> = {}) {
  const prio = new Map<number, number>([[10, 0], [11, 0], [12, 0]])
  const sets: [number, number][] = []
  let clock = 0
  const pass = createPriorityPass({
    enabled: true, getMetrics: () => metrics, rendererPids: () => new Set([12]), selfPid: 10, now: () => clock,
    get: p => { const v = prio.get(p); if (v === undefined) throw new Error('gone'); return v },
    set: (p, v) => { sets.push([p, v]); prio.set(p, v) }, ...over,
  })
  return { prio, sets, pass, tick: (ms: number) => { clock += ms } }
}

describe('app priorities', () => {
  test('picks main, GPU and the window renderer only', () => {
    assert.deepEqual(pidsToRaise(metrics, 10, new Set([12])).sort(), [10, 11, 12])
  })
  test('the renderer is raised even when the metrics do not list it', () => {
    assert.deepEqual(pidsToRaise([], 10, new Set([99])).sort(), [10, 99])
  })
  test('sets only what is not raised; a steady state sets nothing', () => {
    const r = rig()
    r.pass(); assert.equal(r.sets.length, 3)
    r.tick(250); r.pass(); r.pass()
    assert.equal(r.sets.length, 3)
    assert.ok(r.sets.every(([, v]) => v === PRIORITY_ABOVE_NORMAL))
  })
  test('a raised pid that falls is put back and counted', () => {
    const r = rig()
    r.pass()
    const before = priorityStats.drops
    r.prio.set(12, 0)
    r.tick(250); r.pass()
    assert.equal(r.prio.get(12), PRIORITY_ABOVE_NORMAL)
    assert.equal(r.sets.length, 4)
    assert.equal(priorityStats.drops, before + 1)
    r.tick(250); r.pass()
    assert.equal(priorityStats.drops, before + 1)
  })
  test('metrics are read at most every 2 s', () => {
    let n = 0
    const r = rig({ getMetrics: () => { n++; return metrics } })
    r.pass(); r.tick(250); r.pass(); r.tick(250); r.pass()
    assert.equal(n, 1)
    r.tick(2000); r.pass()
    assert.equal(n, 2)
  })
  test('a failing setPriority is logged once and ignored', () => {
    const logs: string[] = []
    const r = rig({ set: () => { throw new Error('denied') }, log: (m) => logs.push(m) })
    r.pass(); r.tick(250); r.pass()
    assert.equal(logs.length, 1)
  })
  test('disabled: nothing is touched, no timer', () => {
    let n = 0
    const k = startPriorityKeeper({ enabled: false, getMetrics: () => metrics, rendererPids: () => new Set([12]), set: () => { n++ } })
    k.pass(); k.stop()
    assert.equal(n, 0)
  })
})
