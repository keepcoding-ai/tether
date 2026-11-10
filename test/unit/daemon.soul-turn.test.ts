// The soul's `turn` events (busy|idle, in <slot>.jsonl next to start/rename/end) feed the slot's attention turn:
// exact, replacing the Enter / quiet heuristic from the first one. Stale lines (older than the run) are ignored.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { slotEventsPath } from '../../src/core/paths.ts'
import { AttentionState, attentionOptions, parseTurnReports } from '../../src/daemon/attention.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe } from './daemon.helpers.ts'

describe('attention: soul turn signal (state machine)', () => {
  test('busy then idle: turn follows, idle after busy is a finished turn (done), an idle with no turn is not', () => {
    const a = new AttentionState(attentionOptions('soul'))
    assert.equal(a.signal('idle'), false, 'already idle: nothing changes, no badge')
    assert.equal(a.value, undefined)
    assert.equal(a.signal('busy'), true)
    assert.equal(a.turn, 'busy')
    assert.equal(a.signal('busy'), false)
    assert.equal(a.signal('idle'), true)
    assert.equal(a.turn, 'idle')
    assert.equal(a.value, 'done')
  })

  test('from the first signal the heuristic stands down: Enter does not make it busy, silence does not make it done', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.signal('idle')
    assert.equal(a.input('oi\r'), false)
    assert.equal(a.turn, 'idle')
    a.output('x'.repeat(2000), 1_000)
    assert.equal(a.dueAt(), undefined)
    assert.equal(a.poll(1_000_000), false)
    // a busy turn the soul reported is not ended by quiet either
    a.signal('busy')
    a.output('x'.repeat(2000), 2_000)
    assert.equal(a.poll(1_000_000), false)
    assert.equal(a.turn, 'busy')
  })

  test('a reset (new launch) brings the heuristic back until the new run signals', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.signal('busy')
    assert.equal(a.reset(), true)
    assert.equal(a.turn, 'idle')
    assert.equal(a.input('oi\r'), true)
    assert.equal(a.turn, 'busy', 'heuristic is back')
  })

  test('parseTurnReports keeps only well-formed turn lines, in order', () => {
    const text = [
      JSON.stringify({ v: 1, ts: '2026-11-09T10:00:00.000Z', kind: 'start', sessionId: 's' }),
      JSON.stringify({ v: 1, ts: '2026-11-09T10:00:01.000Z', kind: 'turn', state: 'busy', sessionId: 's' }),
      '{broken "turn"',
      JSON.stringify({ v: 1, ts: '2026-11-09T10:00:02.000Z', kind: 'turn', state: 'weird' }),
      JSON.stringify({ v: 1, kind: 'turn', state: 'idle' }),
      JSON.stringify({ v: 1, ts: '2026-11-09T10:00:03.000Z', kind: 'turn', state: 'idle', sessionId: 's' }),
      '',
    ].join('\n')
    assert.deepEqual(parseTurnReports(text), [
      { ts: '2026-11-09T10:00:01.000Z', state: 'busy' },
      { ts: '2026-11-09T10:00:03.000Z', state: 'idle' },
    ])
  })
})

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}
const fakeSoul: AgentAdapter = { name: 'soul', plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd), sessionExists: async () => 'unknown', title: async (b) => b.title }

describe('daemon: soul turn events', () => {
  const homes: string[] = []
  const daemons: Daemon[] = []
  after(async () => {
    for (const d of daemons) await d.close()
    for (const h of homes) await removeHome(h)
  })

  test('busy and idle lines in the events file set and clear turn (and done); lines older than the run are ignored', async () => {
    const home = tempHome()
    homes.push(home)
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fakeSoul } })
    daemons.push(daemon)
    const rec = await Recorder.connect(daemon.pipe)
    const { slot } = await rec.client.request({ t: 'create', kind: 'soul', cwd: home, start: true })
    const id = slot!.slotId
    const line = (state: string, ts = new Date().toISOString()): void =>
      appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts, slotId: id, agent: 'soul', kind: 'turn', source: 'turn', state, sessionId: 'sess-1', cwd: home }) + '\n')

    line('busy', '2000-01-01T00:00:00.000Z') // a previous run's line
    await sleep(600)
    assert.equal((await rec.client.request({ t: 'list' })).slots!.find((s) => s.slotId === id)!.turn, undefined)

    line('busy')
    await rec.state(id, (s) => s.turn === 'busy', 5_000, 'turn busy')
    line('idle')
    const done = await rec.state(id, (s) => s.turn === undefined && s.attention === 'done', 5_000, 'turn idle + done')
    assert.equal(done.attention, 'done')

    // the signal is exact: Enter in the terminal does not make a signaling soul busy
    rec.client.input(id, 'oi\r')
    await sleep(600)
    assert.equal((await rec.client.request({ t: 'list' })).slots!.find((s) => s.slotId === id)!.turn, undefined)
    rec.close()
  })
})
