// Key->echo probe: pure helpers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAEMON_LABELS, ECHO_INCIDENT_MS, MAX_STAMPS, extendProbe, hops, isSlow, labelStamps, parseProbe, stamp, startProbe, totalMs } from '../../src/core/perf-probe.ts'

test('stamp: wall-clock epoch ms with a fraction, non-decreasing', () => {
  const a = stamp()
  const b = stamp()
  assert.ok(Math.abs(a - Date.now()) < 50)
  assert.ok(b >= a)
})

test('startProbe / extendProbe: build without mutating', () => {
  const p = startProbe(7, 100)
  const q = extendProbe(p, 130.5)
  assert.deepEqual(p, { seq: 7, t: [100] })
  assert.deepEqual(q, { seq: 7, t: [100, 130.5] })
})

test('parseProbe: accepts the shape, rejects the rest', () => {
  assert.deepEqual(parseProbe({ seq: 1, t: [1, 2.5], extra: 'x' }), { seq: 1, t: [1, 2.5] })
  for (const bad of [undefined, null, 5, 'x', {}, { seq: 'a', t: [] }, { seq: 1, t: 'x' }, { seq: 1, t: [1, 'a'] }, { seq: 1, t: [NaN] }, { seq: Infinity, t: [] }, { seq: 1, t: new Array(MAX_STAMPS + 1).fill(1) }]) {
    assert.equal(parseProbe(bad), undefined)
  }
})

test('hops: differences between consecutive stamps, named when labelled', () => {
  const p = { seq: 1, t: [10, 14, 15, 17, 40] }
  assert.deepEqual(hops(p).map((h) => h.ms), [4, 1, 2, 23])
  assert.equal(hops(p)[0]!.name, 't0>t1')
  const named = hops(p, labelStamps(p.t.length))
  assert.deepEqual(named.map((h) => h.name), ['t0>t1', 't1>daemon-arrive', 'daemon-arrive>daemon-write', 'daemon-write>daemon-out'])
  assert.equal(hops({ seq: 1, t: [5] }).length, 0)
})

test('labelStamps: daemon names sit at the tail; fewer stamps than names is safe', () => {
  assert.deepEqual(labelStamps(5), [undefined, undefined, ...DAEMON_LABELS])
  assert.deepEqual(labelStamps(2), [DAEMON_LABELS[1], DAEMON_LABELS[2]])
})

test('totalMs / isSlow: strictly above the threshold is an incident', () => {
  assert.equal(totalMs({ seq: 1, t: [] }), 0)
  assert.equal(totalMs({ seq: 1, t: [100] }), 0)
  assert.equal(totalMs({ seq: 1, t: [100, 120, 400] }), 300)
  assert.equal(ECHO_INCIDENT_MS, 250)
  assert.equal(isSlow({ seq: 1, t: [0, 250] }), false)
  assert.equal(isSlow({ seq: 1, t: [0, 250.5] }), true)
  assert.equal(isSlow({ seq: 1, t: [0, 100] }, 50), true)
})
