// Slot weight and timing fields: busySince (attention), endedAt (persisted across a restart), memoryMB (process-tree sampler).
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { AttentionState, attentionOptions } from '../../src/daemon/attention.ts'
import { memoryChanged, parseProcessTable, treeBytes } from '../../src/daemon/memory.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const MB = 1048576

describe('busySince', () => {
  test('set when the turn starts, cleared when it ends; idleSince is the mirror', () => {
    const a = new AttentionState(attentionOptions('claude'))
    assert.equal(a.busySince, undefined)
    a.signal('busy')
    assert.equal(a.turn, 'busy')
    assert.match(a.busySince ?? '', /^\d{4}-\d\d-\d\dT/)
    assert.equal(a.idleSince, undefined)
    a.signal('idle')
    assert.equal(a.busySince, undefined)
    assert.ok(a.idleSince)
  })
  test('a reset (launch / exit) drops it', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.signal('busy')
    a.reset()
    assert.equal(a.busySince, undefined)
  })
})

describe('memory sample parser', () => {
  test('parses pid,ppid,bytes lines and skips noise', () => {
    const rows = parseProcessTable('0,0,8192\r\n4,0,147456\r\nheader junk\r\n10,4,1048576\r\n\r\n')
    assert.deepEqual(rows, [
      { pid: 0, ppid: 0, bytes: 8192 },
      { pid: 4, ppid: 0, bytes: 147456 },
      { pid: 10, ppid: 4, bytes: 1048576 },
    ])
  })
  test('ps style (whitespace, KiB) is scaled to bytes', () => {
    assert.deepEqual(parseProcessTable('  12   1   2048\n', 1024), [{ pid: 12, ppid: 1, bytes: 2 * MB }])
  })
  test('sums the whole tree of each root (parent -> children -> grandchildren), not unrelated processes', () => {
    const rows = parseProcessTable(['100,1,10485760', '101,100,20971520', '102,101,31457280', '103,100,1048576', '200,1,5242880', '201,200,2097152', '300,1,999999999'].join('\n'))
    const sums = treeBytes(rows, [100, 200, 999])
    assert.equal(sums.get(100), (10 + 20 + 30 + 1) * MB)
    assert.equal(sums.get(200), 7 * MB)
    assert.equal(sums.has(999), false, 'a root that is not running is absent')
  })
  test('a parent cycle (reused pids) does not hang', () => {
    const sums = treeBytes([{ pid: 1, ppid: 2, bytes: MB }, { pid: 2, ppid: 1, bytes: MB }, { pid: 3, ppid: 3, bytes: MB }], [1, 3])
    assert.equal(sums.get(1), 2 * MB)
    assert.equal(sums.get(3), MB)
  })
  test('broadcast threshold: more than 5 % or 20 MB', () => {
    assert.equal(memoryChanged(undefined, 100), true)
    assert.equal(memoryChanged(1000, 1015), false)
    assert.equal(memoryChanged(1000, 1051), true)
    assert.equal(memoryChanged(100, 106), true)
    assert.equal(memoryChanged(100, 104), false)
    assert.equal(memoryChanged(1000, 1021), true)
    assert.equal(memoryChanged(10000, 9990), false)
  })
})

describe('endedAt and memoryMB in the daemon', () => {
  let home: string
  let daemon: Daemon
  let cwd: string
  before(async () => {
    home = tempHome()
    cwd = join(home, 'work')
    mkdirSync(cwd)
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 300 })
  })
  after(async () => {
    await daemon.close()
    await removeHome(home)
  })

  test('a live shell reports memoryMB and no endedAt; stopping sets endedAt, drops memoryMB, and endedAt survives a restart', async () => {
    const r = await Recorder.connect(daemon.pipe)
    const created = await r.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    const slotId = created.slot!.slotId
    const last = (): typeof r.states[number] | undefined => [...r.states].reverse().find((s) => s.slotId === slotId)
    await waitUntil(() => (last()?.memoryMB ?? 0) > 0, 30_000, 'a memory sample')
    assert.equal(last()!.endedAt, undefined)
    assert.ok(last()!.memoryMB! > 1 && last()!.memoryMB! < 4096)

    const before = Date.now()
    await r.client.request({ t: 'stop', slotId })
    await waitUntil(() => last()?.status === 'exited', 15_000, 'exit')
    const ended = last()!
    assert.equal(ended.memoryMB, undefined)
    assert.ok(ended.endedAt && Date.parse(ended.endedAt) >= before - 1000)
    r.client.close()

    await daemon.close()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0 })
    const r2 = await Recorder.connect(daemon.pipe)
    const listed = (await r2.client.request({ t: 'list' })).slots!.find((s) => s.slotId === slotId)!
    assert.equal(listed.endedAt, ended.endedAt)
    assert.equal(listed.memoryMB, undefined)
    r2.client.close()
  })
})
