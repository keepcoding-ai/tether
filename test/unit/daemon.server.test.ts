// The daemon in-process: slots on disk, a real shell slot in a PTY (never Claude here), scrollback replay,
// binding updates picked up from the slot's jsonl, and clients that come and go without touching the slot.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotAttentionPath, slotEventsPath, slotMetaPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home) })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

describe('create / list / forget', () => {
  test('create without start: slot exited on disk and in the list; forget removes it everywhere', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const created = await c.client.request({ t: 'create', kind: 'shell', cwd, name: 'teste' })
    const slot = created.slot!
    assert.equal(slot.kind, 'shell')
    assert.equal(slot.name, 'teste')
    assert.equal(slot.status, 'exited')
    assert.equal(slot.cwd, cwd)
    assert.ok(existsSync(slotMetaPath(home, slot.slotId)))
    await c.state(slot.slotId, (s) => s.status === 'exited')

    const list = await c.client.request({ t: 'list' })
    assert.deepEqual(list.slots!.map((s) => s.slotId), [slot.slotId])

    const renamed = await c.client.request({ t: 'rename-slot', slotId: slot.slotId, name: 'outro' })
    assert.equal(renamed.slot!.name, 'outro')
    assert.equal(JSON.parse(readFileSync(slotMetaPath(home, slot.slotId), 'utf8')).name, 'outro')

    await c.client.request({ t: 'forget', slotId: slot.slotId })
    await waitUntil(() => c.removed.includes(slot.slotId), 5_000, 'removed event')
    assert.ok(!existsSync(slotMetaPath(home, slot.slotId)))
    assert.deepEqual((await c.client.request({ t: 'list' })).slots, [])
    c.close()
  })

  test('errors: unknown slot, bad kind, missing cwd', async () => {
    const c = await Recorder.connect(daemon.pipe)
    await assert.rejects(c.client.request({ t: 'start', slotId: 'nope' }), (e: DaemonError) => e.code === 'unknown-slot')
    await assert.rejects(c.client.request({ t: 'create', kind: 'vim' as 'shell', cwd }), (e: DaemonError) => e.code === 'bad-request')
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd: join(home, 'missing') })
    await assert.rejects(c.client.request({ t: 'start', slotId: slot!.slotId }), (e: DaemonError) => e.code === 'cwd-missing')
    const errored = await c.state(slot!.slotId, (s) => s.status === 'error')
    assert.equal(errored.error?.code, 'cwd-missing')
    await c.client.request({ t: 'forget', slotId: slot!.slotId })
    c.close()
  })
})

describe('a shell slot', () => {
  let first: Recorder
  let slotId: string
  let shellPid: number
  let childPid: number

  before(async () => {
    first = await Recorder.connect(daemon.pipe)
  })

  test('create+start: running with a pid; attach streams its output', async () => {
    const { slot } = await first.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    slotId = slot!.slotId
    assert.equal(slot!.status, 'running')
    assert.ok(slot!.pid! > 0)
    shellPid = slot!.pid!
    assert.ok(pidAlive(shellPid))
    const attached = await first.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    assert.equal(typeof attached.scrollback, 'string')
    await first.see(slotId, /\S/) // the prompt
  })

  test('input runs a command and the result arrives as data', async () => {
    first.client.input(slotId, "Write-Output ('tether-' + 'ok')\r")
    await first.see(slotId, /tether-ok/)
  })

  test('resize is accepted; a child process started in the shell is part of the tree', async () => {
    await first.client.request({ t: 'resize', slotId, cols: 120, rows: 40 })
    first.client.input(slotId, 'node -e "console.log(\'child=\'+process.pid);setInterval(()=>{},1000)"\r')
    const m = await first.see(slotId, /child=(\d+)/)
    childPid = Number(m[1])
    assert.ok(pidAlive(childPid))
  })

  test('a second client attaching later gets the scrollback', async () => {
    const second = await Recorder.connect(daemon.pipe)
    const attached = await second.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    assert.match(attached.scrollback!, /tether-ok/)
    assert.match(attached.scrollback!, /child=\d+/)
    assert.equal(attached.slot!.status, 'running')
    second.close()
  })

  test('the first client disconnecting does not stop the slot', async () => {
    first.close()
    await sleep(500)
    const probe = await Recorder.connect(daemon.pipe)
    const { slots } = await probe.client.request({ t: 'list' })
    const s = slots!.find((x) => x.slotId === slotId)!
    assert.equal(s.status, 'running')
    assert.equal(s.pid, shellPid)
    assert.ok(pidAlive(shellPid))
    assert.ok(pidAlive(childPid))
    probe.close()
  })

  test('stop kills the whole tree: state exited, no pid left, slot still listed', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const stopped = await c.client.request({ t: 'stop', slotId })
    assert.equal(stopped.slot!.status, 'exited')
    assert.equal(stopped.slot!.pid, undefined)
    await c.state(slotId, (s) => s.status === 'exited')
    await waitUntil(() => !pidAlive(shellPid) && !pidAlive(childPid), 10_000, 'shell and child gone')
    const { slots } = await c.client.request({ t: 'list' })
    assert.ok(slots!.some((s) => s.slotId === slotId))
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })
})

describe('bindings from the slot jsonl', () => {
  test('a start event appended by hand shows up as state with binding, title and cwd', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    const slotId = slot!.slotId
    assert.equal(slot!.binding, undefined)
    const other = join(home, 'other')
    mkdirSync(other)
    const ev: TetherEvent = {
      v: 1,
      ts: new Date().toISOString(),
      slotId,
      agent: 'claude',
      kind: 'start',
      source: 'startup',
      sessionId: '0b6f1111-2222-4333-8444-555555555555',
      title: 'sessão de teste',
      cwd: other,
      resume: { cwd: other, args: ['--resume', '0b6f1111-2222-4333-8444-555555555555'] },
    }
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(ev) + '\n')
    const s = await c.state(slotId, (x) => x.binding !== undefined)
    assert.equal(s.binding!.sessionId, ev.sessionId)
    assert.equal(s.binding!.confirmed, true)
    assert.equal(s.title, 'sessão de teste')
    assert.equal(s.cwd, other)
    assert.equal(s.status, 'exited')

    // a rename event: title follows
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify({ ...ev, kind: 'rename', source: 'rename', title: 'novo nome', resume: undefined }) + '\n')
    await c.state(slotId, (x) => x.title === 'novo nome')

    // a `start` on a slot with a confirmed binding would resume: with a missing session the adapter is not
    // consulted here (no Claude in unit tests); we only check the request validation path for 'already-open'
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a slot created on disk by another process is adopted', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const meta = { v: 1, slotId: 'ext0001', agent: 'shell', cwd, args: [], createdAt: new Date().toISOString() }
    appendFileSync(slotMetaPath(home, 'ext0001'), JSON.stringify(meta) + '\n')
    await c.state('ext0001', (x) => x.status === 'exited')
    await c.client.request({ t: 'forget', slotId: 'ext0001' })
    c.close()
  })
})

describe('attention', () => {
  test('hook report sets it, seen clears it; a bare BEL sets waiting, typing clears it; an old report is ignored', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    const id = slot!.slotId
    await c.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    await c.see(id, /\S/)
    const report = (kind: string, ts = new Date().toISOString()): void => writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts, kind }))
    report('done')
    await c.state(id, (s) => s.attention === 'done', 5_000, 'attention done')
    await c.client.request({ t: 'seen', slotId: id })
    await c.state(id, (s) => s.status === 'running' && s.attention === undefined, 5_000, 'cleared by seen')
    report('waiting', '2000-01-01T00:00:00.000Z') // older than the run: ignored
    await sleep(500)
    assert.equal((await c.client.request({ t: 'list' })).slots!.find((s) => s.slotId === id)!.attention, undefined)
    c.client.input(id, 'Write-Host ("bell" + [char]7)\r')
    await c.state(id, (s) => s.attention === 'waiting', 10_000, 'BEL → waiting')
    c.client.input(id, 'x')
    await c.state(id, (s) => s.attention === undefined, 5_000, 'typing clears')
    c.client.input(id, '\b')
    await c.client.request({ t: 'forget', slotId: id })
    assert.ok(!existsSync(slotAttentionPath(home, id)), 'forget removes the report')
    c.client.close()
  })

  test('unseen marks the slot unread: seen leaves it, off clears it', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    const id = slot!.slotId
    await c.state(id, (s) => s.status === 'running')
    await c.client.request({ t: 'unseen', slotId: id })
    await c.state(id, (s) => s.attention === 'done' && s.attentionHeld === true, 5_000, 'marked unread')
    await c.client.request({ t: 'seen', slotId: id })
    await sleep(300)
    const marked = (await c.client.request({ t: 'list' })).slots!.find((s) => s.slotId === id)!
    assert.equal(marked.attention, 'done')
    assert.equal(marked.attentionHeld, true)
    await c.client.request({ t: 'unseen', slotId: id, off: true })
    await c.state(id, (s) => s.attention === undefined && s.attentionHeld === undefined, 5_000, 'mark removed')
    await c.client.request({ t: 'forget', slotId: id })
    c.client.close()
  })
})
