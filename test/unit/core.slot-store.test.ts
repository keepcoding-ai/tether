import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Perf } from '../../src/core/perf.ts'
import { SlotStore } from '../../src/core/slot-store.ts'
import { createExecutor, type Executor, type ExecutorMode } from '../../src/exec/executor.ts'
import type { OpArgs, OpName, OpValue } from '../../src/exec/protocol.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-slot-store-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const file = (name = 'f'): string => join(dir, `d${n}`, `${name}-${n++}.json`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The real executor behind a recorder; `failWrites` makes the next N `writeTextAtomic` calls fail with ENOSPC. */
function spy(ex: Executor, hooks: { failWrites?: number; delayMs?: number } = {}): { ex: Executor; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = []
  const wrapped = {
    run: async <K extends OpName>(op: K, args: OpArgs<K>): Promise<OpValue<K>> => {
      calls.push([op, args])
      if (hooks.delayMs && op === 'writeTextAtomic') await sleep(hooks.delayMs)
      if (op === 'writeTextAtomic' && (hooks.failWrites ?? 0) > 0) {
        hooks.failWrites!--
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
      return ex.run(op, args)
    },
  }
  return { ex: wrapped as unknown as Executor, calls }
}

const writesOf = (calls: Array<[string, unknown[]]>, path?: string): Array<[string, unknown[]]> =>
  calls.filter(([op, a]) => op === 'writeTextAtomic' && (path === undefined || a[0] === path))

for (const mode of ['inline', 'worker'] as ExecutorMode[]) {
  describe(`slot store (${mode})`, () => {
    async function using(
      fn: (s: SlotStore, calls: Array<[string, unknown[]]>, perf: Perf) => Promise<void>,
      hooks: { failWrites?: number; delayMs?: number } = {},
      retryMs = 20,
    ): Promise<void> {
      const real = createExecutor({ mode })
      const { ex, calls } = spy(real, hooks)
      const perf = new Perf()
      const s = new SlotStore(ex, { perf, retryMs })
      try { await fn(s, calls, perf) } finally { await s.drain(); await real.close() }
    }

    test('10 puts of the same path in one tick become one write with the last text', () => using(async (s, calls) => {
      const p = file()
      for (let i = 0; i < 10; i++) s.put(p, `v${i}`)
      await s.flush(p)
      assert.equal(writesOf(calls, p).length, 1)
      assert.equal(readFileSync(p, 'utf8'), 'v9')
    }))

    test('puts while a write is in flight collapse into one more write', () => using(async (s, calls) => {
      const p = file()
      s.put(p, 'a')
      await sleep(5) // the first write is in flight (delayed by the spy)
      for (let i = 0; i < 10; i++) s.put(p, `b${i}`)
      await s.flush(p)
      assert.equal(writesOf(calls, p).length, 2)
      assert.equal(readFileSync(p, 'utf8'), 'b9')
    }, { delayMs: 30 }))

    test('remove cancels a queued put: nothing is written, the file is gone', () => using(async (s, calls) => {
      const p = file()
      s.put(p, 'x')
      s.remove(p)
      await s.flush(p)
      assert.equal(writesOf(calls, p).length, 0)
      assert.equal(existsSync(p), false)
    }))

    test('remove goes behind the write in flight', () => using(async (s) => {
      const p = file()
      s.put(p, 'x')
      await sleep(5)
      s.remove(p)
      await s.flush(p)
      assert.equal(existsSync(p), false)
    }, { delayMs: 30 }))

    test('order put -> remove -> put keeps the last put', () => using(async (s) => {
      const p = file()
      s.put(p, 'one')
      s.remove(p)
      s.put(p, 'two')
      await s.flush(p)
      assert.equal(readFileSync(p, 'utf8'), 'two')
      s.put(p, 'three')
      s.remove(p)
      s.put(p, 'four')
      s.remove(p)
      await s.flush()
      assert.equal(existsSync(p), false)
    }))

    test('flush waits for the write; without it the disk is behind', () => using(async (s) => {
      const p = file()
      s.put(p, 'late')
      assert.equal(existsSync(p), false)
      await s.flush(p)
      assert.equal(readFileSync(p, 'utf8'), 'late')
    }, { delayMs: 20 }))

    test('flush() without a path waits for every path and for appends', () => using(async (s) => {
      const a = file(); const b = file(); const l = file('log')
      s.put(a, 'A'); s.put(b, 'B'); s.append(l, 'one\n'); s.append(l, 'two\n')
      await s.flush()
      assert.equal(readFileSync(a, 'utf8'), 'A')
      assert.equal(readFileSync(b, 'utf8'), 'B')
      assert.equal(readFileSync(l, 'utf8'), 'one\ntwo\n')
    }))

    test('remove sends pending appended lines first, then deletes', () => using(async (s) => {
      const l = file('log')
      s.append(l, 'x\n')
      s.remove(l)
      await s.flush(l)
      assert.equal(existsSync(l), false)
    }))

    test('echo: our own text is recognized, another one is not', () => using(async (s) => {
      const p = file()
      s.put(p, 'mine')
      assert.equal(s.isEcho(p, 'mine'), true) // still queued
      await s.flush(p)
      assert.equal(s.isEcho(p, 'mine'), true)
      assert.equal(s.isEcho(p, 'theirs'), false)
      s.put(p, 'mine2')
      assert.equal(s.isEcho(p, 'mine'), false)
      s.remove(p)
      await s.flush(p)
      assert.equal(s.isEcho(p, 'mine2'), false)
    }))

    test('failure: incident store-fail, one retry, memory untouched', () => using(async (s, calls, perf) => {
      const p = file()
      s.put(p, 'keep')
      await s.flush(p)
      assert.equal(s.stats.failed, 1)
      assert.equal(s.isEcho(p, 'keep'), false) // nothing was written
      await sleep(80)
      await s.flush(p)
      assert.equal(readFileSync(p, 'utf8'), 'keep')
      assert.equal(writesOf(calls, p).length, 2)
      const inc = perf.snapshot().incidents.filter((i) => i.kind === 'store-fail')
      assert.equal(inc.length, 1)
      assert.deepEqual(inc[0]!.data, { path: p, code: 'ENOSPC' })
    }, { failWrites: 1 }))

    test('failure: a newer put replaces the retry', () => using(async (s, calls) => {
      const p = file()
      s.put(p, 'old')
      await s.flush(p)
      s.put(p, 'new')
      await s.flush(p)
      await sleep(80)
      assert.equal(readFileSync(p, 'utf8'), 'new')
      assert.equal(writesOf(calls, p).length, 2) // failed old + new; the old one is not retried
    }, { failWrites: 1 }))

    test('failure: the retry happens once only', () => using(async (s, calls) => {
      const p = file()
      s.put(p, 'x')
      await s.flush(p)
      await sleep(80)
      await s.flush(p)
      await sleep(80)
      assert.equal(writesOf(calls, p).length, 2)
      assert.equal(existsSync(p), false)
    }, { failWrites: 5 }))

    test('drain runs a waiting retry at once', async () => {
      const real = createExecutor({ mode })
      const { ex } = spy(real, { failWrites: 1 })
      const s = new SlotStore(ex, { retryMs: 60_000 })
      try {
        const p = file()
        s.put(p, 'saved')
        await s.flush(p)
        assert.equal(existsSync(p), false)
        await s.drain()
        assert.equal(readFileSync(p, 'utf8'), 'saved')
      } finally { await real.close() }
    })

    test('leaves no temp files behind', () => using(async (s) => {
      const p = file()
      for (let i = 0; i < 5; i++) { s.put(p, String(i)); await sleep(1) }
      await s.flush()
      assert.equal(readdirSync(join(p, '..')).filter((f) => f.endsWith('.tmp')).length, 0)
    }))
  })
}
