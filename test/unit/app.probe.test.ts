import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_LABELS, isProbeResultNotice, probeEnabled, probeResult, ProbeRing, PROBE_RING_CAP } from '../../app/shared/probe-app.ts'

const full = (...steps: number[]) => ({ seq: 7, t: steps.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 1000) + s], [1000]) })

test('probeResult: labels follow the hop order and hops are named from>to', () => {
  const r = probeResult('s1', full(1, 2, 3, 4, 5, 6))
  assert.deepEqual(r.labels, [...APP_LABELS])
  assert.equal(r.hops.length, 6)
  assert.equal(r.hops[0]!.name, 'renderer-send>main-in')
  assert.equal(r.hops[5]!.name, 'main-out>renderer-recv')
  assert.deepEqual(r.hops.map(h => h.ms), [1, 2, 3, 4, 5, 6])
  assert.equal(r.seq, 7)
})

test('probeResult: total is last minus first; a partial probe keeps generic names past the known ones', () => {
  assert.equal(probeResult('s', full(1, 2, 3)).total, 6)
  const r = probeResult('s', { seq: 1, t: new Array(9).fill(0).map((_, i) => i) })
  assert.equal(r.labels[7], 't7')
})

test('probeResult: incident only strictly above 50 ms', () => {
  assert.equal(probeResult('s', full(10, 10, 10, 10, 10, 0)).incident, false) // exactly 50
  assert.equal(probeResult('s', full(10, 10, 10, 10, 10, 1)).incident, true)
  assert.equal(probeResult('s', full(1, 1), 2).incident, false)
  assert.equal(probeResult('s', full(1, 1), 1).incident, true)
})

test('ProbeRing: keeps the last cap totals oldest first and never grows', () => {
  const ring = new ProbeRing(3)
  for (let i = 1; i <= 5; i++) ring.push(i, i === 4)
  assert.deepEqual(ring.summary(), { count: 5, slow: 1, last: [3, 4, 5] })
  const big = new ProbeRing()
  for (let i = 0; i < PROBE_RING_CAP * 3; i++) big.push(i)
  assert.equal(big.summary().last.length, PROBE_RING_CAP)
  assert.equal(big.summary().count, PROBE_RING_CAP * 3)
})

test('probeEnabled: only TETHER_PROBE=1; isProbeResultNotice validates the shape', () => {
  assert.equal(probeEnabled({}), false)
  assert.equal(probeEnabled({ TETHER_PROBE: '0' }), false)
  assert.equal(probeEnabled({ TETHER_PROBE: '1' }), true)
  assert.equal(isProbeResultNotice({ t: 'probe-result', slotId: 's', probe: { seq: 1, t: [1, 2] } }), true)
  assert.equal(isProbeResultNotice({ t: 'probe-result', slotId: 's', probe: { seq: 1, t: ['x'] } }), false)
  assert.equal(isProbeResultNotice({ t: 'input', slotId: 's' }), false)
  assert.equal(isProbeResultNotice(null), false)
})
