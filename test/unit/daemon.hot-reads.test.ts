// The daemon keeps what it reads about the slots' files in memory: boot scans slots/ once, an events file is read whole
// once and then only from where it stopped, the subagent markers are tracked from the watcher's events, and `list` /
// broadcasts touch no disk. `fsProbe` reports every read the daemon makes, so these tests count them.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import type { SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath, slotRunPath, slotsDir } from '../../src/core/paths.ts'
import { createSlot, readEventsFile, readEventsFrom, writeSlotMeta } from '../../src/core/store.ts'
import { startDaemon, type Daemon, type FsProbeOp } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}
const fakeSoul: AgentAdapter = { name: 'soul', plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd), sessionExists: async () => 'unknown', title: async (b) => b.title }

const homes: string[] = []
const daemons: Daemon[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

interface Probe { ops: { op: FsProbeOp; slotId?: string }[]; count(op: FsProbeOp, slotId?: string): number }
function probe(): Probe & { fn: (op: FsProbeOp, slotId?: string) => void } {
  const ops: Probe['ops'] = []
  return { ops, fn: (op, slotId) => { ops.push(slotId === undefined ? { op } : { op, slotId }) }, count: (op, slotId) => ops.filter((o) => o.op === op && (slotId === undefined || o.slotId === slotId)).length }
}

const meta = (slotId: string, createdAt: string, cwd: string): SlotMeta => ({ v: 1, slotId, agent: 'soul', cwd, args: [], createdAt })
const event = (slotId: string, kind: 'start' | 'rename' | 'end', ts: string, extra: Partial<TetherEvent> = {}): string =>
  JSON.stringify({ v: 1, ts, slotId, agent: 'soul', kind, source: 'test', sessionId: 'sess-1', ...extra }) + '\n'
const turn = (slotId: string, state: 'busy' | 'idle'): string =>
  JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'turn', source: 'turn', state, sessionId: 'sess-1' }) + '\n'

async function boot(home: string, p: ReturnType<typeof probe>): Promise<{ daemon: Daemon; rec: Recorder }> {
  const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, adapters: { soul: fakeSoul }, fsProbe: p.fn })
  daemons.push(daemon)
  return { daemon, rec: await Recorder.connect(daemon.pipe) }
}

describe('store: events read from an offset', () => {
  test('readEventsFrom returns only what was appended; a shorter file is read whole; a partial last line waits for its newline', async () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(slotsDir(home), { recursive: true })
    const id = 'bb000001'
    const first = event(id, 'start', '2026-11-01T10:00:00.000Z')
    writeFileSync(slotEventsPath(home, id), first)
    const a = await readEventsFrom(home, id, 0)
    assert.equal(a.complete, first)
    assert.equal(a.resume, Buffer.byteLength(first))
    const second = event(id, 'rename', '2026-11-01T10:00:01.000Z', { title: 'ação é só uma' })
    appendFileSync(slotEventsPath(home, id), second + '{"v":1,"ts"')
    const b = await readEventsFrom(home, id, a.resume)
    assert.equal(b.start, a.resume)
    assert.equal(b.complete, second)
    assert.equal(b.fragment, '{"v":1,"ts"')
    assert.equal(b.resume, a.resume + Buffer.byteLength(second))
    // sync twin: same split, parsed from the offset
    const c = readEventsFile(home, id, a.resume)
    assert.deepEqual([c.start, c.complete, c.fragment, c.resume], [b.start, b.complete, b.fragment, b.resume])
    // truncated / rewritten shorter: whole file again
    writeFileSync(slotEventsPath(home, id), first)
    const d = await readEventsFrom(home, id, b.resume)
    assert.equal(d.start, 0)
    assert.equal(d.complete, first)
    // missing file
    rmSync(slotEventsPath(home, id))
    assert.deepEqual(await readEventsFrom(home, id, 5), { start: 0, end: 0, resume: 0, complete: '', fragment: '' })
  })
})

describe('daemon: hot paths read the disk once', () => {
  const N = 40

  test('boot scans slots/ once, reads each events file once and only the run files that exist; list and state broadcasts read nothing', async () => {
    const home = tempHome()
    homes.push(home)
    const lastTs = (i: number): string => `2026-11-0${1 + (i % 3)}T12:00:0${i % 10}.000Z`
    for (let i = 0; i < N; i++) {
      const id = `cc${String(i).padStart(6, '0')}`
      createSlot(home, meta(id, `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`, home))
      appendFileSync(slotEventsPath(home, id), event(id, 'start', '2026-11-01T10:00:00.000Z') + event(id, 'rename', lastTs(i), { title: `t${i}` }))
    }
    // two stale run files: tetherd's own, naming nobody alive
    for (const id of ['cc000003', 'cc000007']) writeFileSync(slotRunPath(home, id), JSON.stringify({ pid: 999999, startedAt: '2020-01-01T00:00:00.000Z', by: 'cli' }))
    const p = probe()
    const { rec } = await boot(home, p)
    assert.equal(p.count('slots:scan'), 1)
    assert.equal(p.count('run:read'), 2, 'only the slots that have a run file')
    assert.equal(p.count('events:full'), N, 'one whole read per slot')
    assert.equal(p.count('events:tail'), 0)
    assert.equal(p.count('markers:list'), 0, 'the boot scan told which markers exist')

    const before = p.ops.length
    for (let k = 0; k < 3; k++) {
      const { slots } = await rec.client.request({ t: 'list' })
      assert.equal(slots!.length, N)
      for (let i = 0; i < N; i++) {
        const s = slots!.find((x) => x.slotId === `cc${String(i).padStart(6, '0')}`)!
        assert.equal(s.endedAt, lastTs(i), 'an inactive slot reports its last event from memory')
        assert.equal(s.idleSince, lastTs(i))
      }
    }
    assert.equal(p.ops.length, before, 'list reads no file')
    rec.close()
  })

  test('an appended event is read from the offset (no whole re-read); the daemon\'s own meta writes cause no events read', async () => {
    const home = tempHome()
    homes.push(home)
    const id = 'dd000001'
    createSlot(home, meta(id, '2026-10-01T00:00:00.000Z', home))
    appendFileSync(slotEventsPath(home, id), event(id, 'start', '2026-11-01T10:00:00.000Z', { title: 'um' }))
    const p = probe()
    const { rec } = await boot(home, p)
    assert.equal(p.count('events:full', id), 1)

    appendFileSync(slotEventsPath(home, id), event(id, 'rename', '2026-11-01T10:05:00.000Z', { title: 'dois' }))
    await rec.state(id, (s) => s.binding?.title === 'dois', 5_000, 'title from the appended rename')
    assert.equal(p.count('events:tail', id), 1)
    assert.equal(p.count('events:full', id), 1, 'no whole re-read')

    // the daemon's own writes of <slot>.json (rename request) trigger the watcher but not a read of the events
    await rec.client.request({ t: 'rename-slot', slotId: id, name: 'novo nome' })
    writeSlotMeta(home, { ...meta(id, '2026-10-01T00:00:00.000Z', home), name: 'por fora' })
    await sleep(500)
    assert.equal(p.count('events:tail', id), 1)
    assert.equal(p.count('events:full', id), 1)

    // a burst of appends inside one debounce is one read; a half-written last line is picked up once complete
    const line = event(id, 'rename', '2026-11-01T10:06:00.000Z', { title: 'tres' })
    appendFileSync(slotEventsPath(home, id), line.slice(0, 20))
    await sleep(400)
    assert.equal((await rec.client.request({ t: 'list' })).slots![0]!.binding?.title, 'dois')
    appendFileSync(slotEventsPath(home, id), line.slice(20))
    await rec.state(id, (s) => s.binding?.title === 'tres', 5_000, 'title once the line is complete')

    // the file rewritten smaller: read again from the start
    writeFileSync(slotEventsPath(home, id), event(id, 'start', '2026-11-02T00:00:00.000Z', { sessionId: 'sess-2' }))
    await rec.state(id, (s) => s.binding?.sessionId === 'sess-2', 5_000, 'binding from the rewritten file')
    assert.equal((await rec.client.request({ t: 'list' })).slots![0]!.binding?.title, undefined)
    rec.close()
  })

  test('subagent markers are tracked from the watcher: no directory listing for a marker event or a launch/stop', async () => {
    const home = tempHome()
    homes.push(home)
    const id = 'ee000001'
    createSlot(home, meta(id, '2026-10-01T00:00:00.000Z', home))
    for (let i = 0; i < 30; i++) createSlot(home, meta(`ee1${String(i).padStart(5, '0')}`, '2026-10-02T00:00:00.000Z', home)) // a crowded slots/
    const p = probe()
    const { rec } = await boot(home, p)
    const { slot } = await rec.client.request({ t: 'start', slotId: id, choice: 'new' })
    assert.ok(slot)
    await rec.state(id, (s) => s.status === 'starting' || s.status === 'running', 10_000, 'launched')
    appendFileSync(slotEventsPath(home, id), turn(id, 'busy'))
    await rec.state(id, (s) => s.turn === 'busy', 5_000, 'busy')

    const marker = join(slotsDir(home), `${id}.bg.agent-1`)
    writeFileSync(marker, '1')
    await rec.state(id, (s) => s.background === 1, 5_000, 'one subagent')
    writeFileSync(join(slotsDir(home), `${id}.bg.agent-2`), '1')
    await rec.state(id, (s) => s.background === 2, 5_000, 'two subagents')
    rmSync(marker)
    await rec.state(id, (s) => s.background === 1, 5_000, 'one subagent left')
    assert.equal(p.count('markers:list'), 0, 'the marker count came from memory')

    await rec.client.request({ t: 'stop', slotId: id })
    await waitUntil(() => !existsSync(join(slotsDir(home), `${id}.bg.agent-2`)), 5_000, 'markers cleared by the stop')
    assert.equal(p.count('markers:list'), 0, 'clearing used the remembered names')
    rec.close()
  })
})

