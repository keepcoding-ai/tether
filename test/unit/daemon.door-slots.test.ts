// The agent door's slots (slice D1) in a real tetherd on a test home and test pipe, with a fake adapter whose process echoes
// what it receives. No real agent; the user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorSlots } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

// The process: prints a marker, logs every chunk it receives (JSON, one per line) to the file in ECHO_LOG, and echoes it.
const ECHO = [
  "const fs = require('node:fs')",
  "process.stdout.write('READY\\r\\n')",
  'if (process.stdin.setRawMode) process.stdin.setRawMode(true)',
  "process.stdin.on('data', (d) => {",
  "  fs.appendFileSync(process.env.ECHO_LOG, JSON.stringify(d.toString()) + '\\n')",
  "  process.stdout.write('GOT:' + d.toString().replace(/[\\x00-\\x1f]/g, '?') + '\\r\\n')",
  '})',
  'setInterval(() => {}, 1000)',
].join('\n')

const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code

describe('agent door slots (D1)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  let echoLog: string
  const logs: string[] = []
  const door = new DoorHost({ log: (m) => logs.push(m) })
  const own = new DisposableStore()
  let slots: DoorSlots

  const fake: AgentAdapter = {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog
      return { command: process.execPath, args: [join(home, 'echo.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }
  const received = (): string => (existsSync(echoLog) ? readFileSync(echoLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string).join('') : '')

  const ready = (slotId: string): Promise<void> => waitUntil(() => slots.readScreen(slotId).data.includes('READY'), 30_000, `READY in the ring of ${slotId}`)

  before(async () => {
    home = tempHome()
    echoLog = join(home, 'echo.log')
    writeFileSync(echoLog, '')
    // A script file: a `-e` script does not survive the terminal host's command line on Windows.
    writeFileSync(join(home, 'echo.cjs'), ECHO)
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fake }, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    slots = door.apiFor('probe', own).slots
  })
  after(async () => {
    own.dispose()
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  const comparable = (s: SlotState): Record<string, unknown> => {
    const { slotId: _id, createdBy: _by, paneRequest: _pane, ...rest } = s
    return rest
  }

  test('slots.create gives the same state as the pipe create (plus createdBy); the ext and the agent it acted for are on it', async () => {
    const viaPipe = (await rec.client.request({ t: 'create', kind: 'soul', cwd: home, name: 'igual', start: false })).slot!
    const viaDoor = await slots.create({ kind: 'soul', cwd: home, name: 'igual', start: false, onBehalfOf: 'abcd1234' })
    assert.notEqual(viaDoor.slotId, viaPipe.slotId)
    assert.deepEqual(comparable(viaDoor), comparable(viaPipe))
    assert.deepEqual(viaDoor.createdBy, { ext: 'probe', slotId: 'abcd1234' })
    assert.equal(viaPipe.createdBy, undefined)
    assert.deepEqual(slots.get(viaDoor.slotId), viaDoor)
    assert.ok(slots.list().some((s) => s.slotId === viaDoor.slotId))
    const desk = await slots.create({ kind: 'soul', cwd: home, start: false, desk: 'mesa-1' })
    assert.deepEqual(desk.paneRequest, { deskId: 'mesa-1' })
    await slots.forget(viaDoor.slotId); await slots.forget(viaPipe.slotId); await slots.forget(desk.slotId)
    assert.equal(slots.get(viaDoor.slotId), undefined)
  })

  test('write and keys reach the process; write on a slot with no process rejects door-no-pty; an unknown slot rejects unknown-slot', async () => {
    const cold = await slots.create({ kind: 'soul', cwd: home, start: false })
    await assert.rejects(slots.write(cold.slotId, 'x'), (e: unknown) => codeOf(e) === 'door-no-pty')
    await assert.rejects(slots.write('ffffffff', 'x'), (e: unknown) => codeOf(e) === 'unknown-slot')
    await slots.forget(cold.slotId)

    const s = await slots.create({ kind: 'soul', cwd: home })
    await ready(s.slotId)
    await slots.write(s.slotId, 'ola')
    await waitUntil(() => received().includes('ola'), 10_000, 'write reached the process')
    const before = received().length
    await slots.keys(s.slotId, ['up', 'enter'], { gapMs: 30 })
    await waitUntil(() => received().length >= before + 4, 10_000, 'keys reached the process')
    const tail = received().slice(before)
    assert.ok(tail.includes('\x1b[A') && tail.includes('\r'), JSON.stringify(tail))
    await assert.rejects(slots.keys(s.slotId, ['nope' as never]), /tecla desconhecida/)
    await slots.stop(s.slotId)
    await slots.forget(s.slotId)
  })

  test('readScreen returns the raw ring without resizing or attaching; since returns only what is new; read-screen over the pipe is the same read', async () => {
    const s = await slots.create({ kind: 'soul', cwd: home })
    await ready(s.slotId)
    const live = (): SlotState => slots.get(s.slotId)!
    const stateBefore = live()
    const first = slots.readScreen(s.slotId)
    assert.ok(first.data.includes('READY'))
    assert.equal(first.reset, false)
    assert.ok(first.end > first.start)
    assert.ok(first.cols > 0 && first.rows > 0)
    const dims = { cols: first.cols, rows: first.rows }
    assert.deepEqual({ cols: slots.readScreen(s.slotId).cols, rows: slots.readScreen(s.slotId).rows }, dims, 'the size is not touched')
    assert.deepEqual(live(), stateBefore, 'a read changes nothing in the slot (no attach, no resize)')

    const none = slots.readScreen(s.slotId, { since: first.end })
    assert.equal(none.data, '')
    assert.equal(none.end, first.end)
    await slots.write(s.slotId, 'novo')
    await waitUntil(() => slots.readScreen(s.slotId, { since: first.end }).data.includes('GOT:novo'), 10_000, 'new output')
    const delta = slots.readScreen(s.slotId, { since: first.end })
    assert.ok(!delta.data.includes('READY'), 'only the new part')
    assert.equal(delta.reset, false)

    const piped = (await rec.client.request({ t: 'read-screen', slotId: s.slotId, since: first.end })).screen!
    assert.ok(piped.data.includes('GOT:novo'))
    assert.deepEqual({ cols: piped.cols, rows: piped.rows }, dims)
    const whole = (await rec.client.request({ t: 'read-screen', slotId: s.slotId })).screen!
    assert.ok(whole.data.includes('READY') && whole.data.includes('GOT:novo'))
    await assert.rejects(rec.client.request({ t: 'read-screen', slotId: 'ffffffff' }), (e: unknown) => e instanceof DaemonError && e.code === 'unknown-slot')
    await assert.rejects(rec.client.request({ t: 'read-screen' } as never), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request')
    assert.deepEqual(live(), stateBefore, 'the pipe read changes nothing either')
    await slots.forget(s.slotId)
  })

  test('onState fires on the turn change and stops after dispose; setHeld persists in the meta and shows in the state', async () => {
    const seen: SlotState[] = []
    const sub = slots.onState((st) => seen.push(st))
    const s = await slots.create({ kind: 'soul', cwd: home })
    await ready(s.slotId)
    const line = (state: string): void =>
      appendFileSync(slotEventsPath(home, s.slotId), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: s.slotId, agent: 'soul', kind: 'turn', source: 'turn', state, sessionId: 'sess-1', cwd: home }) + '\n')
    line('busy')
    await waitUntil(() => seen.some((x) => x.slotId === s.slotId && x.turn === 'busy'), 10_000, 'onState busy')
    line('idle')
    await waitUntil(() => seen.some((x) => x.slotId === s.slotId && x.turn === undefined && x.attention === 'done'), 10_000, 'onState idle')

    await slots.setHeld(s.slotId, { ext: 'probe', by: 'dono1' })
    assert.deepEqual(slots.get(s.slotId)!.held, { ext: 'probe', by: 'dono1' })
    assert.deepEqual(seen.at(-1)!.held, { ext: 'probe', by: 'dono1' })
    await slots.setHeld(s.slotId, undefined)
    assert.equal(slots.get(s.slotId)!.held, undefined)

    sub.dispose()
    const n = seen.length
    await slots.rename(s.slotId, 'outro')
    await sleep(200)
    assert.equal(seen.length, n, 'a disposed listener hears nothing')
    await slots.forget(s.slotId)
  })

  test('a satellite door (no port) rejects every act with door-unavailable, and onState still registers', async () => {
    const inert = new DoorHost({ log: () => {} }).apiFor('x', new DisposableStore()).slots
    await assert.rejects(inert.create({ kind: 'shell', cwd: home }), (e: unknown) => codeOf(e) === 'door-unavailable')
    await assert.rejects(inert.write('a', 'b'), (e: unknown) => codeOf(e) === 'door-unavailable')
    assert.throws(() => inert.readScreen('a'), (e: unknown) => codeOf(e) === 'door-unavailable')
    assert.equal(inert.get('a'), undefined)
    assert.deepEqual(inert.list(), [])
    inert.onState(() => {}).dispose()
  })
})
