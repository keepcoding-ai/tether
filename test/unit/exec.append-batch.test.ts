import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Perf } from '../../src/core/perf.ts'
import { AppendBatch } from '../../src/exec/append-batch.ts'
import { createExecutor, type ExecutorMode } from '../../src/exec/executor.ts'
import { PerfLog } from '../../src/exec/perf-log.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-batch-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const file = (): string => join(dir, `b-${n++}.log`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

for (const mode of ['inline', 'worker'] as ExecutorMode[]) {
  describe(`append batch (${mode})`, () => {
    test('10k lines in one tick become a few appends, in order', async () => {
      const ex = createExecutor({ mode })
      try {
        const p = file()
        const b = new AppendBatch(ex, p)
        for (let i = 0; i < 10_000; i++) b.write(`line ${i}\n`)
        await b.flush()
        assert.ok(b.stats.appends <= 5, `${b.stats.appends} appends`)
        const lines = readFileSync(p, 'utf8').split('\n').slice(0, -1)
        assert.equal(lines.length, 10_000)
        assert.ok(lines.every((l, i) => l === `line ${i}`))
        assert.equal(b.stats.writes, 10_000)
      } finally { await ex.close() }
    })

    test('flushes by itself within ~50 ms and close drains the rest', async () => {
      const ex = createExecutor({ mode })
      try {
        const p = file()
        const b = new AppendBatch(ex, p)
        b.write('a\n')
        assert.equal(existsSync(p), false) // nothing synchronous
        const t0 = performance.now()
        while (!existsSync(p) && performance.now() - t0 < 3000) await sleep(10) // a cold worker takes a while to boot
        assert.equal(readFileSync(p, 'utf8'), 'a\n')
        b.write('b\n'); b.write('c\n')
        await b.close()
        assert.equal(readFileSync(p, 'utf8'), 'a\nb\nc\n')
      } finally { await ex.close() }
    })
  })
}

describe('append batch (worker only)', () => {
  test('a hard worker death loses at most the last batch; what was flushed stays, in order', async () => {
    const ex = createExecutor({ mode: 'worker', ioDelayMs: 200 })
    try {
      const p = file()
      const b = new AppendBatch(ex, p)
      for (let k = 0; k < 3; k++) { b.write(`batch${k}\n`); await b.flush() }
      b.write('batch3\n')
      void b.flush() // handed to the worker, which is "slow"
      await sleep(50)
      await ex.killWorker('io')
      await sleep(100)
      const text = readFileSync(p, 'utf8')
      assert.ok(text === 'batch0\nbatch1\nbatch2\n' || text === 'batch0\nbatch1\nbatch2\nbatch3\n', text)
      assert.equal(b.stats.failed, 1)
    } finally { await ex.close() }
  })

  test('emergencySync writes what is still pending with the injected writer', async () => {
    const ex = createExecutor({ mode: 'inline' })
    try {
      const p = file()
      writeFileSync(p, '')
      const seen: string[] = []
      const b = new AppendBatch(ex, p, { emergency: (_p, t) => seen.push(t) })
      b.write('x\n'); b.write('y\n')
      b.emergencySync()
      assert.deepEqual(seen, ['x\ny\n'])
      assert.equal(b.pending, 0)
    } finally { await ex.close() }
  })
})

describe('persisted ruler', () => {
  test('writes samples and incidents once, rotates by size', async () => {
    const ex = createExecutor({ mode: 'worker' })
    try {
      const home = join(dir, `home-${n++}`)
      const perf = new Perf({ intervalMs: 1_000_000 })
      const log = new PerfLog(ex, perf, home, { maxBytes: 600 })
      log.start()
      for (let i = 0; i < 6; i++) {
        perf.sample()
        perf.incident(`kind${i}`, { i })
        await log.tick()
        await sleep(5)
      }
      await log.stop()
      const main = readFileSync(join(home, 'perf', 'tetherd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const old = readFileSync(join(home, 'perf', 'tetherd.jsonl.1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const all = [...old, ...main]
      assert.ok(all.length >= 4)
      const kinds = all.flatMap((l) => l.incidents.map((x: { kind: string }) => x.kind))
      assert.equal(new Set(kinds).size, kinds.length) // no incident written twice
      assert.ok(old.length > 0 && main.length > 0)
    } finally { await ex.close() }
  })
})
