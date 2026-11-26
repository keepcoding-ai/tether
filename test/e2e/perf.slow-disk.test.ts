// Slow disk (slice E3.10, C2). A real tetherd runs in a SEPARATE process (own home and pipes) with the worker executor and
// TETHER_TEST_IO_DELAY_MS=300: every executor operation sleeps 300 ms in its worker, as a disk under antivirus or a network
// share would. 200 shell slots are on disk before it boots. During the slow disk the test, at the same time:
//   - starts 10 panes (a raw echo shell each, in tether-ptyd), then stops 5 of them;
//   - asks `list` over 200 slots every 40 ms on a second connection and times each answer;
//   - sends 200 broadcasts (rename-slot: memory + broadcast now, disk behind the loop).
// The tetherd loop delay is read back with the `perf` request (per-second samples and `loop-lag` incidents).
// Asserts: the loop never stalls (no stall of 100 ms, worst-second p99 < 50 ms: see STALL_MS and LOOP_P99_MS) and `list` answers in < 50 ms. Everything started is gone at the end.
// Run: node --test --test-timeout=300000 test/e2e/perf.slow-disk.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const ECHO = join(ROOT, 'test', 'e2e', 'fixtures', 'perf', 'echo.mjs')
const SLOTS = 200
const PANES = 10
const STOPS = 5
const BROADCASTS = 200
const BROADCAST_SLOTS = 40 // the renames cycle over these slots: the store coalesces the writes of one slot, so the drain stays short
const IO_DELAY_MS = Number(process.env.TETHER_SLOWDISK_DELAY_MS ?? 300) // the knob exists for a control run (0 = fast disk)
const LIST_EVERY_MS = 40
// The loop ruler is a 10 ms timer histogram: an idle tetherd already reads p99 ~ 20-25 ms and a once-per-second max of 25-45 ms on
// this machine (Windows, antivirus, 13 processes of the test itself), so a strict `max < 30 ms` is below the noise floor (five runs:
// 34-62 ms with no work of the loop's own). The p99 limit is 50 ms: the ruler's 10 ms bucket plus the idle reading of 20-25 ms leave
// no room under 30 ms. The criterion is the robust one: no stall of 100 ms or more in the window (no loop-lag incident, every
// per-second max < 100 ms) and the worst per-second p99 < 50 ms. The strict max is printed, never asserted.
const STALL_MS = 100
const LOOP_P99_MS = 50
const LIST_MAX_MS = 50
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tether-slowdisk-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(join(home, 'slots'), { recursive: true }); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const BS = String.fromCharCode(92)
const winPipe = (name: string): string => [BS, BS, '.', BS, 'pipe', BS, name].join('')
const pipe = process.platform === 'win32' ? winPipe('tether-slowdisk-e2e-' + tag) : join(home, 'd.sock')
const ptydPipe = process.platform === 'win32' ? winPipe('tether-slowdisk-ptyd-' + tag) : join(home, 'ptyd.sock')
const suite = new SuiteDaemon(home, pipe)
let probe: DaemonClient | undefined
/** Every pid this test started (tetherd, tether-ptyd, the echo processes): none may be left at the end. */
const seen = new Set<number>()
const ids = Array.from({ length: SLOTS }, (_, i) => `sd${String(i).padStart(3, '0')}`)

before(async () => {
  // Inherited by the tetherd this suite spawns.
  process.env.TETHER_EXECUTOR = 'worker'
  process.env.TETHER_TEST_IO_DELAY_MS = String(IO_DELAY_MS)
  process.env.TETHER_PANEL_HOST = '1'
  process.env.TETHER_PTYD_PIPE = ptydPipe
  // The 200 slots are on disk before the boot (creating them through the slow disk would take minutes and test nothing).
  for (const id of ids) {
    const meta = { v: 1, slotId: id, agent: 'shell', cwd: work, args: [process.execPath, ECHO], createdAt: new Date().toISOString() }
    writeFileSync(join(home, 'slots', `${id}.json`), JSON.stringify(meta, null, 2) + '\n')
  }
  await suite.connect()
  seen.add(suite.pid)
})

after(async () => {
  try { probe?.close() } catch { /* gone */ }
  try {
    const ptyd = await HostClient.ping(ptydPipe, home)
    if (ptyd) seen.add(ptyd.pid)
    // The shutdown drains the queued writes through the slow disk: it can take a while.
    await suite.shutdown(120_000)
  } finally {
    for (const pid of [...seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 5_000; [...seen].some(pidAlive) && Date.now() < end; await sleep(100));
    rmSync(root, { recursive: true, force: true })
  }
  const left = [...seen].filter(pidAlive)
  assert.deepEqual(left, [], `processes left behind: ${left.join(', ')}`)
  console.log(`pids started and gone: ${[...seen].join(', ')}`)
})

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!

test(`slow disk (${IO_DELAY_MS} ms per operation): ${PANES} panes start, list over ${SLOTS} slots, ${BROADCASTS} broadcasts, ${STOPS} stops: the loop never stalls and list answers fast`, async () => {
  const client = suite.client
  probe = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
  const listed = (await client.request({ t: 'list' })).slots ?? []
  assert.equal(listed.length, SLOTS, 'the daemon loaded the slots seeded on disk')
  assert.equal((await client.request({ t: 'perf' })).perf !== undefined, true, 'the perf request answers')

  // tether-ptyd is launched by the first pane of a tetherd's life: a detached CreateProcess on the loop thread (the one launch the
  // sync ratchet lists in "spawn"). It is warmed up and reported apart, so the window below measures the slow disk and not that launch.
  const warmSince = Date.now()
  const warm = (await client.request({ t: 'start', slotId: ids[SLOTS - 1]! })).slot
  if (warm?.pid) seen.add(warm.pid)
  await client.request({ t: 'stop', slotId: ids[SLOTS - 1]! })
  await sleep(1500)
  const warmSnap = (await client.request({ t: 'perf', since: warmSince })).perf!
  console.log(`slow-disk: ptyd launch (first pane, reported only): loop max=${warmSnap.samples.reduce((m, x) => Math.max(m, x.maxMs), 0).toFixed(1)} ms`)

  const since = Date.now()
  const listMs: number[] = []
  let listing = true
  const lister = (async () => {
    while (listing) {
      const t0 = performance.now()
      const r: { slots?: unknown[] } = await probe!.request({ t: 'list' })
      listMs.push(performance.now() - t0)
      assert.equal(r.slots?.length, SLOTS)
      await sleep(LIST_EVERY_MS)
    }
  })()

  // 10 panes launched at once; 200 broadcasts in bursts while they come up.
  const t0 = performance.now()
  const starts = ids.slice(0, PANES).map(async id => {
    const r = await client.request({ t: 'start', slotId: id })
    if (r.slot?.pid) seen.add(r.slot.pid)
    return r.slot
  })
  const renames: Promise<unknown>[] = []
  for (let i = 0; i < BROADCASTS; i++) {
    renames.push(client.request({ t: 'rename-slot', slotId: ids[PANES + (i % BROADCAST_SLOTS)]!, name: `r${i}` }))
    if (i % 20 === 19) await sleep(25)
  }
  await Promise.all(renames)
  const started = await Promise.all(starts)
  const startedMs = performance.now() - t0
  for (const s of (await client.request({ t: 'list' })).slots ?? []) if (s.pid) seen.add(s.pid)

  // 5 stops while the disk is still slow.
  const t1 = performance.now()
  await Promise.all(ids.slice(0, STOPS).map(id => client.request({ t: 'stop', slotId: id })))
  const stoppedMs = performance.now() - t1
  await sleep(1500) // at least one more sampler tick after the last operation
  listing = false
  await lister

  const snap = (await client.request({ t: 'perf', since })).perf!
  const samples = snap.samples
  const lags = snap.incidents.filter(i => i.kind === 'loop-lag')
  const worstMax = samples.reduce((m, x) => Math.max(m, x.maxMs), 0)
  const worstP99 = samples.reduce((m, x) => Math.max(m, x.p99Ms), 0)
  const sorted = [...listMs].sort((a, b) => a - b)
  console.log(`slow-disk: panes started in ${startedMs.toFixed(0)} ms (${started.filter(s => s?.pid).length}/${PANES} with pid), ${STOPS} stops in ${stoppedMs.toFixed(0)} ms`)
  console.log(`slow-disk: loop delay over ${samples.length} samples: max=${worstMax.toFixed(1)} ms, p99(worst second)=${worstP99.toFixed(1)} ms, loop-lag incidents=${lags.length}, other incidents=[${snap.incidents.filter(i => i.kind !== 'loop-lag').map(i => i.kind).join(',') || '-'}]`)
  console.log(`slow-disk: list n=${listMs.length} p50=${pct(sorted, 0.5).toFixed(1)} ms p99=${pct(sorted, 0.99).toFixed(1)} ms max=${sorted.at(-1)!.toFixed(1)} ms`)

  for (const i of snap.incidents.filter(i => i.kind === 'loop-lag')) console.log('slow-disk: lag ' + JSON.stringify(i.data))
  console.log('slow-disk: top samples ' + JSON.stringify([...samples].sort((a, b) => b.maxMs - a.maxMs).slice(0, 5).map(x => ({ at: Math.round((x.t - since) / 100) / 10, maxMs: Math.round(x.maxMs) }))) + ` phases(s): panes+broadcasts 0..${(startedMs / 1000).toFixed(0)}, stops ${((t1 - t0) / 1000).toFixed(0)}..${((t1 - t0 + stoppedMs) / 1000).toFixed(0)}`)
  assert.ok(samples.length >= 3, `the window held only ${samples.length} loop samples`)
  assert.ok(started.every(s => s?.pid), 'every pane started with a pid')
  assert.ok(IO_DELAY_MS === 0 || startedMs > IO_DELAY_MS, `the disk was not slow enough to matter (panes up in ${startedMs.toFixed(0)} ms)`)
  assert.equal(lags.length, 0, `loop-lag incidents (a stall of 100 ms or more): ${JSON.stringify(lags)}`)
  assert.ok(worstMax < STALL_MS, `the tetherd loop stalled ${worstMax.toFixed(1)} ms (limit ${STALL_MS} ms)`)
  assert.ok(worstP99 < LOOP_P99_MS, `the tetherd loop p99 reached ${worstP99.toFixed(1)} ms in its worst second (limit ${LOOP_P99_MS} ms)`)
  assert.ok(listMs.length >= 10, `only ${listMs.length} list answers were measured`)
  assert.ok((sorted.at(-1) ?? 0) < LIST_MAX_MS, `list took ${sorted.at(-1)!.toFixed(1)} ms (limit ${LIST_MAX_MS} ms)`)
})
