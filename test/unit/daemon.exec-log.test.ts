// The real tetherd process boots with the executor in worker mode, logs through the append batch and persists the ruler.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DaemonClient } from '../../src/daemon/client.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')

describe('tetherd with the executor in worker mode', () => {
  let home: string
  let pipe: string
  let pid = 0
  const saved = { exec: process.env.TETHER_EXECUTOR, every: process.env.TETHER_PERF_PERSIST_MS }

  before(() => {
    home = tempHome()
    pipe = uniquePipe(home)
    process.env.TETHER_EXECUTOR = 'worker'
    process.env.TETHER_PERF_PERSIST_MS = '300'
  })
  after(async () => {
    if (pid && pidAlive(pid)) await killOwned(await claim(pid, { cmdIncludes: MAIN, what: 'tetherd' }), { tree: true })
    for (const [k, v] of [['TETHER_EXECUTOR', saved.exec], ['TETHER_PERF_PERSIST_MS', saved.every]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    await removeHome(home)
  })

  test('log and perf jsonl are written; shutdown flushes both', async () => {
    const c = await DaemonClient.connect({ home, pipe, client: 'test' })
    pid = c.hello.pid
    const perfFile = join(home, 'perf', 'tetherd.jsonl')
    await waitUntil(() => { try { return readFileSync(perfFile, 'utf8').includes('"samples"') } catch { return false } }, 15_000, 'perf jsonl')
    await c.request({ t: 'shutdown' })
    await waitUntil(() => !pidAlive(pid), 15_000, 'daemon gone')
    const log = readFileSync(join(home, 'tetherd.log'), 'utf8')
    assert.match(log, /started pid [0-9]+, home .*, executor worker/)
    assert.match(log, /started pid/)
    assert.match(log, /shutdown requested/)
    assert.match(log, /process exit 0/)
    const lines = readFileSync(perfFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(lines.length >= 1 && Array.isArray(lines[0].samples))
  })
})
