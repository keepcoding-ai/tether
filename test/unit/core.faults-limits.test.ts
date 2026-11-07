// Growth and concurrency limits of the fault registry: the per-sender rate limiter, the dropped counter, the cap on new
// signatures per hour (overflow), jsonl rotation, the cost of 5 000 reports, the debounced state write (flush, exit) and the
// lock (pid based, stale break, two real writers racing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultRateLimiter } from '../../src/core/faults-limit.ts'
import { flush, LockBusyError, MAX_JSONL_BYTES, NEW_SIG_LIMIT_PER_HOUR, noteDropped, OVERFLOW_SIG, readOccurrences, readState, record, statePath, withLock, writeState } from '../../src/core/faults.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tether-limits-'))
const finish = (dir: string): void => { flush(dir); rmSync(dir, { recursive: true, force: true }) }
const opts = (dir: string, now = 1_700_000_000_000) => ({ dir, now: () => now, version: '1', mapper: null, env: { TETHER_HOME: dir } })
const input = (message: string) => ({ proc: 'renderer', kind: 'uncaught', message, stack: `Error: ${message}\n    at f${message.length} (C:\\x\\a.js:1:1)` }) as const

test('rate limiter: 20 per second and 200 per minute per sender, senders independent', () => {
  let t = 0
  const lim = new FaultRateLimiter(() => t)
  let ok = 0
  for (let i = 0; i < 50; i++) if (lim.allow('renderer:1')) ok++
  assert.equal(ok, 20)
  assert.ok(lim.allow('renderer:2'), 'another sender has its own bucket')
  t += 1000
  ok = 0
  for (let i = 0; i < 50; i++) if (lim.allow('renderer:1')) ok++
  assert.equal(ok, 20, 'a second later the burst bucket is full again')
  // sustained 15/s: the minute bucket (200/min) cuts it
  const lim2 = new FaultRateLimiter(() => t)
  let accepted = 0
  for (let s = 0; s < 60; s++) { t += 1000; for (let i = 0; i < 15; i++) if (lim2.allow('x')) accepted++ }
  assert.ok(accepted <= 200 + 200 / 60 * 60 && accepted >= 195, `accepted ${accepted}`)
})

test('dropped reports are counted per sender in the state', () => {
  const dir = tmp()
  noteDropped('renderer:7', dir)
  noteDropped('renderer:7', dir)
  noteDropped('renderer:9', dir)
  flush(dir)
  assert.deepEqual(readState(dir).state.dropped, { 'renderer:7': 2, 'renderer:9': 1 })
  noteDropped('renderer:7', dir)
  flush(dir)
  assert.equal(readState(dir).state.dropped!['renderer:7'], 3)
  finish(dir)
})

test('new signatures per hour are capped; the rest folds into the overflow sig with a count', () => {
  const dir = tmp()
  for (let i = 0; i < NEW_SIG_LIMIT_PER_HOUR + 50; i++) record(input(`unique failure ${'x'.repeat(i)}`), opts(dir))
  flush(dir)
  const { faults } = readState(dir).state
  assert.equal(Object.keys(faults).length, NEW_SIG_LIMIT_PER_HOUR + 1)
  assert.equal(faults[OVERFLOW_SIG]!.count, 50)
  // a known sig is never folded
  record(input('unique failure '), opts(dir))
  flush(dir)
  assert.equal(Object.keys(readState(dir).state.faults).length, NEW_SIG_LIMIT_PER_HOUR + 1)
  finish(dir)
})

test('5 000 reports with unique messages: little synchronous work, files under the caps', () => {
  const dir = tmp()
  const t0 = performance.now()
  for (let i = 0; i < 5_000; i++) record({ proc: 'renderer', kind: 'uncaught', message: `unique message number ${i} ${'y'.repeat(i % 50)}`, stack: `Error: n${i}\n    at a${i} (C:\\x\\a.js:1:1)`, context: { windowId: 1, i } }, opts(dir, 1_700_000_000_000 + i))
  const spent = performance.now() - t0
  console.log(`# 5000 record() calls: ${spent.toFixed(1)} ms of synchronous work`)
  assert.ok(spent < 3_000, `${spent.toFixed(0)} ms`) // ~100 ms on a quiet machine; the bound only has to survive a loaded full-suite run
  assert.ok(!existsSync(statePath(dir)), 'the state write is debounced: nothing yet')
  flush(dir)
  assert.ok(statSync(statePath(dir)).size < 200_000)
  assert.ok(statSync(join(dir, 'faults.jsonl')).size < MAX_JSONL_BYTES)
  assert.ok(readOccurrences(dir).items.length < 300)
  finish(dir)
})

test('rotation: a full faults.jsonl moves to faults.1.jsonl (one generation) and reads see both', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'faults.jsonl'), JSON.stringify({ id: 'old', ts: '2026-01-01T00:00:00.000Z', proc: 'main', version: '1', kind: 'uncaught', message: 'old one', stack: '', sig: 'ab', context: {} }) + '\n' + ' '.repeat(MAX_JSONL_BYTES))
  record(input('fresh one'), opts(dir))
  assert.ok(existsSync(join(dir, 'faults.1.jsonl')))
  assert.ok(statSync(join(dir, 'faults.jsonl')).size < 10_000, 'the current file starts again')
  const msgs = readOccurrences(dir).items.map(o => o.message)
  assert.equal(msgs[0], 'old one', 'oldest first: the rotated generation, then the current file')
  assert.ok(msgs.includes('old one') && msgs.includes('fresh one'))
  finish(dir)
})

test('the state is written on flush and at process exit', () => {
  const dir = tmp()
  record(input('pending one'), opts(dir))
  assert.ok(!existsSync(statePath(dir)))
  flush(dir)
  assert.equal(Object.keys(readState(dir).state.faults).length, 1)
  finish(dir)
  const dir2 = tmp()
  const code = `import { record } from ${JSON.stringify(new URL('../../src/core/faults.ts', import.meta.url).href)}
record({ proc: 'daemon', kind: 'uncaught', message: 'died before the debounce' }, { dir: ${JSON.stringify(dir2)}, version: '1', mapper: null })
process.exit(1)`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(Object.values(readState(dir2).state.faults)[0]!.count, 1)
  rmSync(dir2, { recursive: true })
})

test('permissions: the folder is 0700 and the files 0600 (modes only mean something off Windows)', { skip: process.platform === 'win32' }, () => {
  const dir = join(tmp(), 'faults')
  record(input('private'), opts(dir))
  flush(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'faults.jsonl')).mode & 0o777, 0o600)
  assert.equal(statSync(statePath(dir)).mode & 0o777, 0o600)
  finish(dir)
})

// ---- lock ----

const DEAD_PID = 2_000_000_000

test('lock: a lock whose pid is not alive is stale and broken; its owner is never waited for', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'faults.lock'), String(DEAD_PID))
  let ran = false
  withLock(dir, () => { ran = true; assert.equal(readFileSync(join(dir, 'faults.lock'), 'utf8'), String(process.pid)) }, { waitMs: 1_000 })
  assert.ok(ran)
  assert.ok(!existsSync(join(dir, 'faults.lock')), 'released')
  finish(dir)
})

test('lock: a lock held by a live pid is respected, however old, until the wait runs out', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'faults.lock'), String(process.pid))
  utimesSync(join(dir, 'faults.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)) // the old rule broke locks older than 5 s
  assert.throws(() => withLock(dir, () => 'never', { waitMs: 120, pid: process.pid + 1 }), LockBusyError)
  assert.equal(readFileSync(join(dir, 'faults.lock'), 'utf8'), String(process.pid), 'the holder keeps it')
  rmSync(dir, { recursive: true })
})

test('lock: a writer that finds a dead owner and one that finds a fresh live lock never both proceed', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'faults.lock'), '111')
  // writer A: sees 111 dead and breaks it. While A holds the lock, writer B (alive check says 111 is dead, but the lock is A's now) must wait.
  const alive = (pid: number): boolean => pid !== 111
  let inner: 'busy' | 'ran' = 'ran'
  withLock(dir, () => {
    try { withLock(dir, () => 'ran', { waitMs: 80, pid: 222, alive }) } catch (e) { if (e instanceof LockBusyError) inner = 'busy' }
  }, { pid: 333, alive })
  assert.equal(inner, 'busy')
  rmSync(dir, { recursive: true })
})

test('lock: several real processes racing on one stale lock increment a shared counter without losing an update', async () => {
  const dir = tmp()
  const counter = join(dir, 'counter.txt')
  writeFileSync(counter, '0')
  writeFileSync(join(dir, 'faults.lock'), String(DEAD_PID))
  const worker = `import { withLock } from ${JSON.stringify(new URL('../../src/core/faults.ts', import.meta.url).href)}
import { readFileSync, writeFileSync } from 'node:fs'
const [dir, counter] = process.argv.slice(1)
for (let i = 0; i < 40; i++) withLock(dir, () => { const n = Number(readFileSync(counter, 'utf8')); writeFileSync(counter, String(n + 1)) }, { waitMs: 20_000 })`
  const runs = Array.from({ length: 4 }, () => new Promise<number | null>(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', worker, dir, counter], { stdio: 'inherit' })
    p.on('exit', resolve)
  }))
  const codes = await Promise.all(runs)
  assert.deepEqual(codes, [0, 0, 0, 0])
  assert.equal(Number(readFileSync(counter, 'utf8')), 160)
  rmSync(dir, { recursive: true })
})

test('writeState keeps the dropped counters and stays readable by readState', () => {
  const dir = tmp()
  writeState(dir, { v: 1, faults: {}, dropped: { 'renderer:1': 4 } })
  assert.deepEqual(readState(dir).state.dropped, { 'renderer:1': 4 })
  rmSync(dir, { recursive: true })
})
