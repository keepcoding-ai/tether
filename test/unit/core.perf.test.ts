import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Perf, type LoopDelaySource } from '../../src/core/perf.ts'

/** A fake histogram: `max`/`p99` in ns, set by the test before each `sample()`. */
function fakeSource(): LoopDelaySource & { maxNs: number; p99Ns: number } {
  return {
    maxNs: 0, p99Ns: 0,
    enable() {}, disable() {}, reset() { this.maxNs = 0; this.p99Ns = 0 },
    get max() { return this.maxNs },
    percentile() { return this.p99Ns },
  }
}

function rig(opts: ConstructorParameters<typeof Perf>[0] = {}) {
  const source = fakeSource()
  const clock = { t: 1_000_000 }
  const perf = new Perf({ source, now: () => clock.t, ...opts })
  perf.start()
  perf.stop() // sets lastRead from the fake clock without leaving a timer
  return { perf, source, clock }
}

test('sample ring has a fixed capacity and keeps the newest', () => {
  const { perf, source, clock } = rig({ sampleCapacity: 5 })
  for (let i = 1; i <= 12; i++) {
    clock.t += 1000
    source.maxNs = i * 1e6
    perf.sample()
  }
  const s = perf.snapshot().samples
  assert.equal(s.length, 5)
  assert.deepEqual(s.map((x) => x.maxMs), [8, 9, 10, 11, 12])
  assert.deepEqual(perf.snapshot(clock.t - 2000).samples.map((x) => x.maxMs), [11, 12])
})

test('incident ring has a fixed capacity and overwrites the oldest', () => {
  const { perf, clock } = rig({ incidentCapacity: 4 })
  for (let i = 0; i < 10; i++) {
    clock.t += 1000
    perf.incident('k' + i, { i })
  }
  const inc = perf.snapshot().incidents
  assert.equal(inc.length, 4)
  assert.deepEqual(inc.map((x) => x.kind), ['k6', 'k7', 'k8', 'k9'])
})

test('incidents are limited to one per second per kind, and the drops are counted', () => {
  const { perf, clock } = rig()
  perf.incident('a'); perf.incident('a'); perf.incident('a'); perf.incident('b')
  assert.equal(perf.snapshot().incidents.length, 2)
  assert.equal(perf.snapshot().dropped.a, 2)
  clock.t += 1000
  perf.incident('a')
  assert.equal(perf.snapshot().incidents.length, 3)
})

test('a sample whose real interval passed 3 s is discarded', () => {
  const { perf, source, clock } = rig()
  clock.t += 1000; source.maxNs = 5e6; perf.sample()
  clock.t += 3500; source.maxNs = 4000e6; perf.sample() // machine slept
  clock.t += 1000; source.maxNs = 6e6; perf.sample()
  const snap = perf.snapshot()
  assert.deepEqual(snap.samples.map((x) => x.maxMs), [5, 6])
  assert.equal(snap.incidents.length, 0)
})

test('a sample over 100 ms raises loop-lag', () => {
  const { perf, source, clock } = rig()
  clock.t += 1000; source.maxNs = 99e6; perf.sample()
  assert.equal(perf.snapshot().incidents.length, 0)
  clock.t += 1000; source.maxNs = 150e6; source.p99Ns = 120e6; perf.sample()
  const inc = perf.snapshot().incidents
  assert.equal(inc.length, 1)
  assert.equal(inc[0]!.kind, 'loop-lag')
})

test('start/stop are idempotent and leave no live timer', () => {
  const perf = new Perf({ source: fakeSource() })
  perf.start(); perf.start()
  assert.equal(perf.running, true)
  perf.stop(); perf.stop()
  assert.equal(perf.running, false)
})

test('real loop: a 300 ms busy wait shows up as maxMs >= 250 and a loop-lag incident', async () => {
  const perf = new Perf({ intervalMs: 50 })
  perf.start()
  try {
    await new Promise((r) => setTimeout(r, 120))
    const end = Date.now() + 300
    while (Date.now() < end) { /* block the loop */ }
    const deadline = Date.now() + 3000
    while (!perf.snapshot().samples.some((s) => s.maxMs >= 250) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    const snap = perf.snapshot()
    assert.ok(snap.samples.some((s) => s.maxMs >= 250), `max sample ${Math.max(...snap.samples.map((s) => s.maxMs))}`)
    assert.ok(snap.incidents.some((i) => i.kind === 'loop-lag'))
  } finally { perf.stop() }
})

/** A rig whose high-resolution clock the test advances by hand. */
function timedRig(opts: ConstructorParameters<typeof Perf>[0] = {}) {
  const hr = { t: 0 }
  const r = rig({ hrNow: () => hr.t, ...opts })
  return { ...r, hr }
}

test('timed: over the limit raises slow with the label, under it does not, and the result passes through', () => {
  const { perf, hr } = timedRig()
  assert.equal(perf.timed('fast', () => { hr.t += 99; return 7 }), 7)
  assert.equal(perf.snapshot().incidents.length, 0)
  assert.equal(perf.timed('slow-one', () => { hr.t += 150; return 'x' }), 'x')
  const inc = perf.snapshot().incidents
  assert.equal(inc.length, 1)
  assert.equal(inc[0]!.kind, 'slow')
  assert.deepEqual(inc[0]!.data, { label: 'slow-one', ms: 150 })
})

test('timed: a throw is still charged and rethrown', () => {
  const { perf, hr } = timedRig()
  assert.throws(() => perf.timed('boom', () => { hr.t += 200; throw new Error('x') }), /x/)
  assert.equal(perf.snapshot().incidents[0]!.data && (perf.snapshot().incidents[0]!.data as { label: string }).label, 'boom')
})

test('wrap: times every call, passes arguments and result', () => {
  const { perf, hr } = timedRig({ slowMs: 50 })
  const f = perf.wrap('cb', (a: number, b: number) => { hr.t += a; return a + b })
  assert.equal(f(10, 1), 11)
  assert.equal(perf.snapshot().incidents.length, 0)
  assert.equal(f(60, 1), 61)
  assert.deepEqual(perf.snapshot().incidents[0]!.data, { label: 'cb', ms: 60 })
  assert.deepEqual(perf.snapshot().labels!.cb, { n: 2, totalMs: 70, maxMs: 60 })
})

test('slow incidents are limited per label: different labels do not erase each other', () => {
  const { perf, hr, clock } = timedRig()
  for (const l of ['a', 'b', 'a', 'a', 'b']) perf.timed(l, () => { hr.t += 200 })
  const snap = perf.snapshot()
  assert.deepEqual(snap.incidents.map((i) => (i.data as { label: string }).label), ['a', 'b'])
  assert.equal(snap.dropped.slow, 3)
  clock.t += 1000
  perf.timed('a', () => { hr.t += 200 })
  assert.equal(perf.snapshot().incidents.length, 3)
})

test('label tables are bounded: labels past the cap fold into (other)', () => {
  const { perf, hr, clock } = timedRig()
  for (let i = 0; i < 100; i++) { clock.t += 1000; perf.timed('l' + i, () => { hr.t += 200 }) }
  const snap = perf.snapshot()
  assert.ok(Object.keys(snap.labels!).length <= 65)
  assert.equal(snap.labels!['(other)']!.n, 36)
  assert.ok(snap.incidents.length >= 64)
})

test('timedAsync charges wall time and flags the incident', async () => {
  const { perf, hr } = timedRig()
  await perf.timedAsync('boot:x', async () => { hr.t += 300 })
  assert.deepEqual(perf.snapshot().incidents[0]!.data, { label: 'boot:x', ms: 300, wall: true })
})
