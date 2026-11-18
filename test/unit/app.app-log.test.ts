// The main process' log (app/main/app-log.ts): lines go through the executor in batches, in order, with the pid; a file past the
// limit is rotated to .1 once at the start; the fatal-exit writer saves what is still in memory.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAppLog, LOG_MAX_BYTES } from '../../app/main/app-log.ts'
import { Executor } from '../../src/exec/executor.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-app-log-')
const ex = new Executor({ mode: 'inline' })
after(async () => { await ex.close(); tmp.cleanup() })

const quiet = async (fn: () => Promise<void> | void): Promise<void> => {
  const orig = console.error
  console.error = () => {}
  try { await fn() } finally { console.error = orig }
}

describe('app log', () => {
  test('lines are appended in order with time and pid, in a folder that did not exist', async () => {
    const path = join(tmp.make(), 'deep', 'tether-app.log')
    await quiet(async () => {
      const log = createAppLog(path, ex, { pid: 42 })
      log('first')
      log('second')
      await log.flush()
    })
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[42\] first$/)
    assert.match(lines[1]!, / \[42\] second$/)
  })

  test('a file past the limit is rotated to .1 before the first line', async () => {
    const path = join(tmp.make(), 'tether-app.log')
    writeFileSync(path, 'x'.repeat(LOG_MAX_BYTES + 10))
    await quiet(async () => {
      const log = createAppLog(path, ex)
      log('fresh')
      await log.flush()
    })
    assert.equal(readFileSync(`${path}.1`, 'utf8').length, LOG_MAX_BYTES + 10)
    assert.match(readFileSync(path, 'utf8'), /fresh\n$/)
    assert.equal(readFileSync(path, 'utf8').split('\n').length, 2)
  })

  test('emergencySync writes what is still in memory with the injected writer', async () => {
    const path = join(tmp.make(), 'tether-app.log')
    await quiet(async () => {
      const log = createAppLog(path, ex, { emergency: (p, t) => appendFileSync(p, t) })
      log('before the exit') // the rotation check has not even run yet: the line is only in memory
      assert.equal(existsSync(path), false)
      log.emergencySync()
      await log.flush()
    })
    assert.match(readFileSync(path, 'utf8'), /before the exit\n$/)
    assert.equal(readFileSync(path, 'utf8').split('\n').length, 2, 'written once')
  })
})
