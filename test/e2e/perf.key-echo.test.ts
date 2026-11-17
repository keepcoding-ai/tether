// Key->echo with a blocked tetherd (slices E0.5 and E1.10a). A real tetherd runs in a SEPARATE process (own home and
// pipes, TETHER_TEST_BLOCK=1) with a shell slot that runs test/e2e/fixtures/perf/echo.mjs (raw stdin -> stdout).
// TETHER_PANEL_HOST=0: typing goes through tetherd's event loop, so a 3 s stall shows up in the echo; the test asserts
// that RED baseline. Default / TETHER_PANEL_HOST=1: the pane runs in tether-ptyd and the test types like the app (a
// `direct` tetherd client plus a PanelLink straight to the host); each marker is timed by its own echo and P1 asserts
// p99 < 30 ms across a 5 s tetherd stall. P3 (reported, not asserted): tetherd's loop delay around the pane launch.
// Run: node --test --test-timeout=180000 test/e2e/perf.key-echo.test.ts   (TETHER_PANEL_HOST=0 for the red baseline)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import { HostClient } from '../../src/procd/client.ts'
import { PanelLink } from '../../app/main/panel-link.ts'
import { hops, labelStamps, startProbe, stamp, totalMs, type Probe } from '../../src/core/perf-probe.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const ECHO = join(ROOT, 'test', 'e2e', 'fixtures', 'perf', 'echo.mjs')
const KEYS = 200
const INTERVAL_MS = 25
const BLOCK_AT_KEY = 40
const BLOCK_MS = 3000
const STALL_KEYS = Math.ceil(BLOCK_MS / INTERVAL_MS) + 10
const P1_BLOCK_MS = 5000
const P1_P99_MS = 30
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** On unless TETHER_PANEL_HOST=0 (the tetherd default is on too); written back below so the spawned tetherd agrees. */
const TETHER_PANEL_HOST = process.env.TETHER_PANEL_HOST?.trim() !== '0'

const root = mkdtempSync(join(tmpdir(), 'tether-keyecho-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const BS = String.fromCharCode(92)
const winPipe = (name: string): string => [BS, BS, '.', BS, 'pipe', BS, name].join('')
const pipe = process.platform === 'win32' ? winPipe('tether-keyecho-e2e-' + tag) : join(home, 'd.sock')
const ptydPipe = process.platform === 'win32' ? winPipe('tether-keyecho-ptyd-' + tag) : join(home, 'ptyd.sock')
const suite = new SuiteDaemon(home, pipe)
let blocker: DaemonClient | undefined
let typist: DaemonClient | undefined
let link: PanelLink | undefined
/** Every pid this test started (tetherd, tether-ptyd, the echo process): none may be left at the end. */
const seen = new Set<number>()

before(async () => {
  process.env.TETHER_TEST_BLOCK = '1' // inherited by the tetherd this suite spawns
  process.env.TETHER_PANEL_HOST = TETHER_PANEL_HOST ? '1' : '0'
  process.env.TETHER_PTYD_PIPE = ptydPipe // tetherd and the tether-ptyd it launches stay on this private pipe
  await suite.connect()
  seen.add(suite.pid)
})

after(async () => {
  try { blocker?.close() } catch { /* gone */ }
  try { typist?.close() } catch { /* gone */ }
  try { link?.stop() } catch { /* gone */ }
  try {
    const ptyd = await HostClient.ping(ptydPipe)
    if (ptyd) seen.add(ptyd.pid)
    await suite.shutdown()
  } finally {
    // The host (and the pane under it) outlives tetherd: kill them by identity (pid + creation time), never by name.
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

const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7)
const ANSI = new RegExp(ESC + '[[][0-9;?]*[ -/]*[@-~]|' + ESC + '[]][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '.)', 'g')
const stripAnsi = (s: string): string => s.replace(ANSI, '')
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!

/** P3 (reported, never asserted): tetherd's own loop delay, from its `perf` request. The host's loop is not measured yet. */
async function reportLoopDelay(c: DaemonClient, since: number, label: string): Promise<number> {
  const snap = (await c.request({ t: 'perf', since })).perf
  const samples = snap?.samples ?? []
  const worst = samples.reduce((m, x) => Math.max(m, x.maxMs), 0)
  const kinds = (snap?.incidents ?? []).map(i => i.kind).join(',') || '-'
  console.log(`P3 ${label}: tetherd loop-delay samples=${samples.length} max=${worst.toFixed(1)}ms incidents=[${kinds}] (host loop not measured yet)`)
  return worst
}

test('key->echo baseline: a 3 s tetherd stall freezes the echo (red baseline)', { skip: TETHER_PANEL_HOST ? 'panel host on: see P1' : false }, async () => {
  const client = suite.client
  const created = await client.request({ t: 'create', kind: 'shell', cwd: work, args: [process.execPath, ECHO], start: false })
  const slotId = created.slot!.slotId
  let output = ''
  const probes = new Map<number, Probe>()
  client.on('data', (id: string, data: string, probe?: Probe) => {
    if (id !== slotId) return
    output += data
    if (probe) probes.set(probe.seq, { seq: probe.seq, t: [...probe.t, stamp()] }) // client-recv
  })
  await client.request({ t: 'attach', slotId, cols: 120, rows: 40 })
  const started = await client.request({ t: 'start', slotId })
  if (started.slot?.pid) seen.add(started.slot.pid)
  for (const end = Date.now() + 20_000; !output.includes('ECHO-READY'); await sleep(50)) assert.ok(Date.now() < end, 'echo never became ready')
  const ready = (await client.request({ t: 'list' })).slots?.find(s => s.slotId === slotId)
  if (ready?.pid) seen.add(ready.pid)

  blocker = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
  const mark = (i: number): string => `M${String(i).padStart(3, '0')}`
  let blockedAt = 0
  for (let i = 0; i < KEYS; i++) {
    const tick = Date.now()
    if (i === BLOCK_AT_KEY) {
      blockedAt = tick
      await blocker.request({ t: 'debug-block', ms: BLOCK_MS }) // ok comes back before the stall begins
    }
    // tetherd keeps ONE pending probe per slot (a newer replaces it): inside the stall window the queued keys land in one
    // batch, so only a single canary key carries a probe there; elsewhere every other key does.
    const inStall = i >= BLOCK_AT_KEY && i <= BLOCK_AT_KEY + STALL_KEYS
    const probed = inStall ? i === BLOCK_AT_KEY + 1 : i % 2 === 0
    client.input(slotId, mark(i) + String.fromCharCode(13, 10), probed ? startProbe(i) : undefined) // first stamp = client-send
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - tick)))
  }
  assert.ok(blockedAt > 0)

  // All markers must come back, in order.
  const seenIds = (): number[] => [...stripAnsi(output).matchAll(/M(\d{3})/g)].map(m => Number(m[1]))
  for (const end = Date.now() + 30_000; new Set(seenIds()).size < KEYS; await sleep(100)) {
    assert.ok(Date.now() < end, `only ${new Set(seenIds()).size}/${KEYS} markers echoed`)
  }
  const ids = seenIds()
  assert.deepEqual(ids, Array.from({ length: KEYS }, (_, i) => i), 'every marker exactly once, in order')

  // Per-probe totals (client-send -> client-recv) and the largest single hop.
  const rows = [...probes.values()].map(p => {
    const hs = hops(p, [undefined, ...labelStamps(p.t.length - 1), 'client-recv'].slice(0, p.t.length))
    const names = ['client-send', 'daemon-arrive', 'daemon-write', 'daemon-out', 'client-recv']
    const named = hs.map((h, i) => ({ name: `${names[i]}>${names[i + 1]}`, ms: h.ms }))
    return { seq: p.seq, total: totalMs(p), worst: named.reduce((a, b) => (b.ms > a.ms ? b : a)) }
  })
  assert.ok(rows.length > 0, 'no probe came back')
  const totals = rows.map(r => r.total).sort((a, b) => a - b)
  const top = rows.reduce((a, b) => (b.total > a.total ? b : a))
  const summary = `E0.5 key-echo baseline: probes=${rows.length}/${KEYS} p50=${pct(totals, 0.5).toFixed(1)}ms p99=${pct(totals, 0.99).toFixed(1)}ms max=${top.total.toFixed(1)}ms (key ${top.seq}) worstHop=${top.worst.name} ${top.worst.ms.toFixed(1)}ms`
  console.log(summary)

  // RED baseline: the stall reaches the echo, and the responsible hop is tetherd's.
  assert.ok(top.total >= 2900, `echo max ${top.total.toFixed(1)} ms < 2900: the stall did not reach the echo`)
  assert.ok(/daemon-/.test(top.worst.name), `largest hop ${top.worst.name} is not tetherd's`)
})

test('P1: panel host on, typing and echo skip tetherd: p99 < 30 ms across a 5 s tetherd stall', { skip: TETHER_PANEL_HOST ? false : 'TETHER_PANEL_HOST=0: red baseline above' }, async () => {
  const client = suite.client
  const sinceLaunch = Date.now()
  const created = await client.request({ t: 'create', kind: 'shell', cwd: work, args: [process.execPath, ECHO], start: false })
  const slotId = created.slot!.slotId
  await client.request({ t: 'start', slotId })
  await reportLoopDelay(client, sinceLaunch, 'at pane launch')
  for (const end = Date.now() + 20_000; ; await sleep(100)) {
    const s = (await client.request({ t: 'list' })).slots?.find(x => x.slotId === slotId)
    if (s?.status === 'running') { assert.equal(s.ptyHost, true, 'the pane runs in tether-ptyd'); seen.add(s.pid!); break }
    assert.ok(Date.now() < end, `slot never ran (${s?.status})`)
  }
  const ptyd = await HostClient.ping(ptydPipe)
  assert.ok(ptyd, 'tether-ptyd answers on its isolated pipe')
  seen.add(ptyd.pid)

  // The typist is the app: a direct tetherd connection (no data for hosted panes) plus the link straight to the host.
  typist = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false, direct: true })
  await typist.request({ t: 'attach', slotId, cols: 120, rows: 40 })
  let output = ''
  const arrivals = new Map<number, number>()
  const scan = (): void => {
    for (const m of stripAnsi(output).matchAll(/M(\d{3})/g)) { const id = Number(m[1]); if (!arrivals.has(id)) arrivals.set(id, performance.now()) }
  }
  link = new PanelLink({ pipe: ptydPipe, onData: (id, d) => { if (id === slotId) { output += d; scan() } } })
  await link.start()
  assert.ok(link.connected, 'link to the host')
  output = (await link.attach(slotId)).scrollback
  for (const end = Date.now() + 20_000; !output.includes('ECHO-READY'); await sleep(50)) assert.ok(Date.now() < end, 'echo never became ready')
  output = ''

  blocker = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
  const sent = new Map<number, number>()
  const mark = (i: number): string => `M${String(i).padStart(3, '0')}`
  for (let i = 0; i < KEYS; i++) {
    const tick = Date.now()
    if (i === BLOCK_AT_KEY) await blocker.request({ t: 'debug-block', ms: P1_BLOCK_MS })
    sent.set(i, performance.now())
    assert.ok(link.write(slotId, mark(i) + String.fromCharCode(13, 10)), `write ${i} dropped`)
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - tick)))
  }
  for (const end = Date.now() + 30_000; arrivals.size < KEYS; await sleep(50)) assert.ok(Date.now() < end, `only ${arrivals.size}/${KEYS} markers echoed`)
  const ids = [...stripAnsi(output).matchAll(/M(\d{3})/g)].map(m => Number(m[1]))
  assert.deepEqual(ids, Array.from({ length: KEYS }, (_, i) => i), 'every marker exactly once, in order')

  const lat = Array.from({ length: KEYS }, (_, i) => arrivals.get(i)! - sent.get(i)!)
  const sorted = [...lat].sort((a, b) => a - b)
  const max = sorted[sorted.length - 1]!
  console.log(`P1 key-echo (panel host, ${P1_BLOCK_MS} ms tetherd stall at key ${BLOCK_AT_KEY}): n=${KEYS} p50=${pct(sorted, 0.5).toFixed(1)}ms p99=${pct(sorted, 0.99).toFixed(1)}ms max=${max.toFixed(1)}ms (key ${lat.indexOf(max)})`)
  assert.ok(pct(sorted, 0.99) < P1_P99_MS, `p99 ${pct(sorted, 0.99).toFixed(1)} ms >= ${P1_P99_MS} ms`)
  await sleep(2_000) // the stall ends and tetherd's sampler reads it
  await reportLoopDelay(suite.client, sinceLaunch, 'after the stall')
})

// ---- P7: the same typing, with N extra panes producing continuous output (an agent at work, ~50-200 KB/s each) ----
const FLOOD = join(ROOT, 'test', 'e2e', 'fixtures', 'perf', 'flood.mjs')
const cpuTimes = (): { idle: number; total: number } => {
  let idle = 0, total = 0
  for (const c of cpus()) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }
  return { idle, total }
}
/** CPU milliseconds consumed so far by a process (PowerShell on Windows, /proc-free ps elsewhere). */
function procCpuMs(pid: number): number {
  const out = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8' })
    : execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' })
  return Number.parseFloat(out.trim()) || 0
}

async function p7(extra: number): Promise<void> {
  const sinceLaunch = Date.now()
  const startSlot = async (script: string, args: string[] = []): Promise<string> => {
    const created = await suite.client.request({ t: 'create', kind: 'shell', cwd: work, args: [process.execPath, script, ...args], start: false })
    const id = created.slot!.slotId
    await suite.client.request({ t: 'start', slotId: id })
    for (const end = Date.now() + 20_000; ; await sleep(100)) {
      const s = (await suite.client.request({ t: 'list' })).slots?.find(x => x.slotId === id)
      if (s?.status === 'running') { seen.add(s.pid!); break }
      assert.ok(Date.now() < end, `slot never ran (${s?.status})`)
    }
    return id
  }
  const slotId = await startSlot(ECHO)
  const floods: string[] = []
  for (let i = 0; i < extra; i++) floods.push(await startSlot(FLOOD, [String(50 + Math.round((150 * i) / Math.max(1, extra - 1)))]))
  const ptyd = await HostClient.ping(ptydPipe)
  assert.ok(ptyd, 'tether-ptyd answers on its isolated pipe')
  seen.add(ptyd.pid)

  typist = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false, direct: true })
  await typist.request({ t: 'attach', slotId, cols: 120, rows: 40 })
  let output = ''
  let floodBytes = 0
  const arrivals = new Map<number, number>()
  const floodSet = new Set(floods)
  link?.stop()
  link = new PanelLink({ pipe: ptydPipe, onData: (id, d) => {
    if (id === slotId) { output += d; for (const m of stripAnsi(d).matchAll(/M(\d{3})/g)) { const k = Number(m[1]); if (!arrivals.has(k)) arrivals.set(k, performance.now()) } }
    else if (floodSet.has(id)) floodBytes += d.length
  } })
  await link.start()
  assert.ok(link.connected, 'link to the host')
  output = (await link.attach(slotId)).scrollback
  // The app has every pane attached: the host streams the extra ones to the link too.
  for (const id of floods) await link.attach(id)
  for (const end = Date.now() + 20_000; !output.includes('ECHO-READY'); await sleep(50)) assert.ok(Date.now() < end, 'echo never became ready')
  output = ''
  await sleep(2_000) // let the floods reach steady state

  blocker = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
  const cpu0 = cpuTimes(), t0 = performance.now(), ptyd0 = procCpuMs(ptyd.pid), fb0 = floodBytes
  const machine: number[] = []
  let last = cpu0
  const sampler = setInterval(() => {
    const c = cpuTimes(); const dt = c.total - last.total
    if (dt > 0) machine.push(100 * (1 - (c.idle - last.idle) / dt))
    last = c
  }, 500)
  const sent = new Map<number, number>()
  const mark = (i: number): string => `M${String(i).padStart(3, '0')}`
  try {
    for (let i = 0; i < KEYS; i++) {
      const tick = Date.now()
      if (i === BLOCK_AT_KEY) await blocker.request({ t: 'debug-block', ms: P1_BLOCK_MS })
      sent.set(i, performance.now())
      assert.ok(link.write(slotId, mark(i) + String.fromCharCode(13, 10)), `write ${i} dropped`)
      await sleep(Math.max(0, INTERVAL_MS - (Date.now() - tick)))
    }
    for (const end = Date.now() + 30_000; arrivals.size < KEYS; await sleep(50)) assert.ok(Date.now() < end, `only ${arrivals.size}/${KEYS} markers echoed`)
  } finally { clearInterval(sampler) }
  const wall = performance.now() - t0
  const cpuAll = cpuTimes()
  const machineAvg = 100 * (1 - (cpuAll.idle - cpu0.idle) / (cpuAll.total - cpu0.total))
  const ptydPct = (100 * (procCpuMs(ptyd.pid) - ptyd0)) / wall // % of one core
  const flooded = (floodBytes - fb0) / 1024 / (wall / 1000)
  const ids = [...stripAnsi(output).matchAll(/M(\d{3})/g)].map(m => Number(m[1]))
  assert.deepEqual([...new Set(ids)], Array.from({ length: KEYS }, (_, i) => i), 'every marker, in order')

  const sorted = Array.from({ length: KEYS }, (_, i) => arrivals.get(i)! - sent.get(i)!).sort((a, b) => a - b)
  const p99 = pct(sorted, 0.99)
  await sleep(2_000)
  const loop = await reportLoopDelay(suite.client, sinceLaunch, `P7 extra=${extra}`)
  console.log(`P7 extra=${extra} | p50=${pct(sorted, 0.5).toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${sorted[KEYS - 1]!.toFixed(1)}ms | machineCPU avg=${machineAvg.toFixed(0)}% peak=${Math.max(0, ...machine).toFixed(0)}% | ptydCPU=${ptydPct.toFixed(0)}% of one core | tetherd loop max=${loop.toFixed(0)}ms (includes the ${P1_BLOCK_MS} ms block) | flood to link=${flooded.toFixed(0)} KB/s total`)
  for (const id of floods) await suite.client.request({ t: 'stop', slotId: id }).catch(() => undefined)
  assert.ok(p99 < P1_P99_MS, `p99 ${p99.toFixed(1)} ms >= ${P1_P99_MS} ms with ${extra} extra busy panes`)
}

test('P7a: 5 extra busy panes: p99 < 30 ms across a 5 s tetherd stall', { skip: TETHER_PANEL_HOST ? false : 'panel host off' }, () => p7(5))
test('P7b: 10 extra busy panes: p99 < 30 ms across a 5 s tetherd stall', { skip: TETHER_PANEL_HOST ? false : 'panel host off' }, () => p7(10))
