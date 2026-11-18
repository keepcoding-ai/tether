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
  const { perf, hr } = timedRig({ slowMs: 100 })
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
  for (let i = 0; i < 200; i++) { clock.t += 1000; perf.timed('l' + i, () => { hr.t += 200 }) }
  const snap = perf.snapshot()
  assert.ok(Object.keys(snap.labels!).length <= 129)
  assert.equal(snap.labels!['(other)']!.n, 72)
  assert.ok(snap.incidents.length >= 128)
})

test('timedAsync charges wall time and flags the incident', async () => {
  const { perf, hr } = timedRig()
  await perf.timedAsync('boot:x', async () => { hr.t += 300 })
  assert.deepEqual(perf.snapshot().incidents[0]!.data, { label: 'boot:x', ms: 300, wall: true })
})

test('loop-lag names the longest timed section of the second and carries process and machine CPU', () => {
  const cpu = { micros: 0 }
  const mach = { busy: 0, total: 0 }
  const { perf, source, clock, hr } = timedRig({ cpuMicros: () => cpu.micros, machineCpu: () => ({ ...mach }) })
  perf.start(); perf.stop() // baselines from the fakes
  perf.timed('small', () => { hr.t += 10 })
  perf.timed('big', () => { hr.t += 130 })
  cpu.micros += 250_000; mach.busy += 60; mach.total += 100
  clock.t += 1000; source.maxNs = 140e6; perf.sample()
  const lag = perf.snapshot().incidents.find((i) => i.kind === 'loop-lag')!.data as Record<string, unknown>
  assert.equal(lag.label, 'big')
  assert.equal(lag.labelMs, 130)
  assert.equal(lag.cpuMs, 250)
  assert.equal(lag.machinePct, 60)
  // the longest resets each second: a lag with nothing timed names nothing
  clock.t += 1000; source.maxNs = 150e6; perf.sample()
  const last = perf.snapshot().incidents.filter((i) => i.kind === 'loop-lag').at(-1)!.data as Record<string, unknown>
  assert.equal(last.label, undefined)
})

test('enter/exit track the active label, innermost first, and charge the time', () => {
  const { perf, hr } = timedRig()
  assert.equal(perf.active, undefined)
  perf.enter('outer')
  perf.enter('inner')
  assert.equal(perf.active, 'inner')
  hr.t += 70
  perf.exit()
  assert.equal(perf.active, 'outer')
  perf.exit()
  assert.equal(perf.active, undefined)
  assert.equal(perf.snapshot().labels!.inner!.maxMs, 70)
})

test('a lag sampled while a section is running names that section', () => {
  const { perf, source, clock } = timedRig()
  perf.enter('mcp:x:tools/call')
  clock.t += 1000; source.maxNs = 200e6; perf.sample()
  perf.exit()
  assert.equal((perf.snapshot().incidents.find((i) => i.kind === 'loop-lag')!.data as { label: string }).label, 'mcp:x:tools/call')
})

test('the default slow threshold is 50 ms', () => {
  const { perf, hr } = timedRig()
  perf.timed('a', () => { hr.t += 49 })
  assert.equal(perf.snapshot().incidents.length, 0)
  perf.timed('b', () => { hr.t += 60 })
  assert.equal(perf.snapshot().incidents.length, 1)
})
