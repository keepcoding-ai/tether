import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Perf } from '../../src/core/perf.ts'
import { createExecutor, type Executor, type ExecutorMode } from '../../src/exec/executor.ts'
import { ExecError, ExecTimeout } from '../../src/exec/protocol.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-exec-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const file = (name = 'f'): string => join(dir, `${name}-${n++}.txt`)

async function using<T>(ex: Executor, fn: (ex: Executor) => Promise<T>): Promise<T> {
  try { return await fn(ex) } finally { await ex.close() }
}

for (const mode of ['inline', 'worker'] as ExecutorMode[]) {
  describe(`executor (${mode})`, () => {
    test('basic ops round trip and errors keep their code', () => using(createExecutor({ mode }), async (ex) => {
      const p = file()
      await ex.run('writeTextAtomic', [p, 'hello'])
      assert.equal(await ex.run('readText', [p]), 'hello')
      await ex.run('appendText', [p, ' world'])
      assert.equal(await ex.run('readText', [p]), 'hello world')
      assert.equal((await ex.run('stat', [p])).size, 11)
      assert.equal(await ex.run('exists', [p]), true)
      assert.equal(await ex.run('hashFile', [p]).then((h) => h.length), 64)
      const sub = join(dir, `sub-${n++}`, 'a', 'b')
      await ex.run('mkdirp', [sub])
      assert.deepEqual((await ex.run('readdir', [join(sub, '..')])).map((e) => [e.name, e.isDirectory]), [['b', true]])
      await ex.run('rm', [p])
      assert.equal(await ex.run('exists', [p]), false)
      await assert.rejects(ex.run('readText', [p]), (e: unknown) => e instanceof ExecError && e.code === 'ENOENT')
      assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0)
    }))

    test('io lane is FIFO: a read right after a write sees it', () => using(createExecutor({ mode }), async (ex) => {
      const p = file()
      const w = ex.run('writeTextAtomic', [p, 'v1'])
      const r = ex.run('readText', [p])
      await w
      assert.equal(await r, 'v1')
      for (let i = 0; i < 20; i++) ex.run('appendText', [p, `${i},`])
      const last = await ex.run('readText', [p])
      assert.equal(last, 'v1' + Array.from({ length: 20 }, (_, i) => `${i},`).join(''))
    }))

    test('drain waits for everything issued', () => using(createExecutor({ mode }), async (ex) => {
      const p = file()
      for (let i = 0; i < 30; i++) void ex.run('appendText', [p, 'x']).catch(() => {})
      await ex.drain()
      assert.equal(readFileSync(p, 'utf8').length, 30)
    }))

    test('stats per op on the ruler', async () => {
      const perf = new Perf()
      await using(createExecutor({ mode, perf }), async (ex) => {
        await ex.run('writeTextAtomic', [file(), 'a'])
        assert.equal(perf.snapshot().labels?.['exec:writeTextAtomic']?.n, 1)
      })
    })

    test('slow-io incident above 250 ms', { skip: mode === 'inline' }, async () => {
      const perf = new Perf()
      await using(createExecutor({ mode, perf, ioDelayMs: 300 }), async (ex) => {
        await ex.run('exists', [file()])
        assert.ok(perf.snapshot().incidents.some((i) => i.kind === 'slow-io'))
      })
    })
  })
}

describe('executor (worker only)', () => {
  test('work lane does not block the io lane', async () => {
    const ex = createExecutor({ mode: 'worker', ioDelayMs: 300 })
    try {
      const p = file()
      writeFileSync(p, 'x')
      await ex.run('exists', [p]) // spawn both workers' paths warm
      const t0 = performance.now()
      await Promise.all([ex.run('hashFile', [p]), ex.run('exists', [p])])
      const dt = performance.now() - t0
      assert.ok(dt < 500, `lanes ran serially: ${Math.round(dt)} ms`) // 2 x 300 ms serial; ~300 ms in parallel
    } finally { await ex.close() }
  })

  test('timeout rejects with ExecTimeout; the late reply is dropped', async () => {
    const ex = createExecutor({ mode: 'worker', ioDelayMs: 300 })
    try {
      const p = file()
      await assert.rejects(ex.run('exists', [p], { timeoutMs: 50 }), (e: unknown) => e instanceof ExecTimeout)
      await new Promise((r) => setTimeout(r, 400))
      assert.equal(await ex.run('exists', [p]), false) // the lane keeps working
    } finally { await ex.close() }
  })

  test('a dead worker comes back in < 200 ms and nothing hangs (C5)', async () => {
    const ex = createExecutor({ mode: 'worker' })
    try {
      const p = file()
      await ex.run('writeTextAtomic', [p, 'a'])
      await ex.killWorker('io')
      const t0 = performance.now()
      assert.equal(await ex.run('readText', [p]), 'a')
      const dt = performance.now() - t0
      assert.ok(dt < 200, `respawn took ${Math.round(dt)} ms`)
    } finally { await ex.close() }
  })

  test('pending requests: idempotent ones are repeated once, others reject with ExecutorDown', async () => {
    const ex = createExecutor({ mode: 'worker', ioDelayMs: 200 })
    try {
      const p = file()
      writeFileSync(p, 'z')
      await ex.run('exists', [p])
      const idem = ex.run('readText', [p])
      const non = ex.run('appendText', [p, 'q'])
      await new Promise((r) => setTimeout(r, 50))
      await ex.killWorker('io')
      const [a, b] = await Promise.allSettled([idem, non])
      assert.equal(a.status, 'fulfilled')
      assert.equal(b.status, 'rejected')
      assert.equal((b as PromiseRejectedResult).reason.name, 'ExecutorDown')
    } finally { await ex.close() }
  })

  // A loop that ran the 50 x 300 ms sleeps itself would stall ~15 s in one piece. Machine noise (other processes) shows as
  // isolated spikes of tens of ms even with an idle loop, so the bar is: no stall >= 100 ms and at most 2% of the 5 ms ticks over 30 ms.
  test('50 slow operations (300 ms each) leave the main loop free', { timeout: 60000 }, async () => {
    const ex = createExecutor({ mode: 'worker', ioDelayMs: 300 })
    try {
      const p = file()
      await ex.run('writeTextAtomic', [p, 'a']) // warm: the worker boot is not what is measured
      const late: number[] = []
      let last = performance.now()
      const tick = setInterval(() => { const now = performance.now(); late.push(now - last - 5); last = now }, 5)
      await Promise.all(Array.from({ length: 50 }, () => ex.run('readText', [p])))
      clearInterval(tick)
      const max = Math.max(...late)
      const over = late.filter((l) => l > 30).length
      assert.ok(max < 100, `loop stalled ${max.toFixed(1)} ms`)
      assert.ok(over <= late.length * 0.02, `${over} of ${late.length} ticks over 30 ms (max ${max.toFixed(1)})`)
    } finally { await ex.close() }
  })
})
