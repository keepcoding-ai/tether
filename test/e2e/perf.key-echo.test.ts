// Key->echo baseline with a blocked tetherd (slice E0.5). A real tetherd runs in a SEPARATE process (own home and
// pipe, TETHER_TEST_BLOCK=1) with a shell slot that runs test/e2e/fixtures/perf/echo.mjs (raw stdin -> stdout).
// The test types 200 distinct markers, one every 25 ms, each with a probe; mid-run a second connection asks
// `debug-block` 3000 ms. Today typing goes through tetherd's event loop, so the stall shows up in the echo:
// the test asserts that RED baseline. TETHER_PANEL_HOST (not implemented yet) will pick the mode in step 1.
// Run: node --test --test-timeout=180000 test/e2e/perf.key-echo.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import { hops, labelStamps, startProbe, stamp, totalMs, type Probe } from '../../src/core/perf-probe.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const ECHO = join(ROOT, 'test', 'e2e', 'fixtures', 'perf', 'echo.mjs')
const KEYS = 200
const INTERVAL_MS = 25
const BLOCK_AT_KEY = 40
const BLOCK_MS = 3000
const STALL_KEYS = Math.ceil(BLOCK_MS / INTERVAL_MS) + 10
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Off today: typing goes through tetherd. Step 1 introduces the panel-host path and flips this. */
const TETHER_PANEL_HOST = process.env.TETHER_PANEL_HOST === '1'

const root = mkdtempSync(join(tmpdir(), 'tether-keyecho-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const BS = String.fromCharCode(92)
const pipe = process.platform === 'win32' ? [BS, BS, '.', BS, 'pipe', BS, 'tether-keyecho-e2e-' + tag].join('') : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
let blocker: DaemonClient | undefined
/** Every pid this test started (tetherd + the echo process): none may be left at the end. */
const seen = new Set<number>()

before(async () => {
  assert.equal(TETHER_PANEL_HOST, false, 'only the tetherd-in-the-path mode exists today (E1 adds the other)')
  process.env.TETHER_TEST_BLOCK = '1' // inherited by the tetherd this suite spawns
  await suite.connect()
  seen.add(suite.pid)
})

after(async () => {
  try { blocker?.close() } catch { /* gone */ }
  try { await suite.shutdown() } finally { rmSync(root, { recursive: true, force: true }) }
  const left = [...seen].filter(pidAlive)
  assert.deepEqual(left, [], `processes left behind: ${left.join(', ')}`)
})

const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7)
const ANSI = new RegExp(ESC + '[[][0-9;?]*[ -/]*[@-~]|' + ESC + '[]][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '.)', 'g')
const stripAnsi = (s: string): string => s.replace(ANSI, '')
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!

test('key->echo baseline: a 3 s tetherd stall freezes the echo (red baseline)', async () => {
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
  // TODO(E1.10): with TETHER_PANEL_HOST on, assert P1 instead: p99 of totals < 30 ms (and drop the red assertions above).
})
