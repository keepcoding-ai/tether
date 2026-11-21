// A soul slot whose pane is open (a client attached) must apply the soul's `turn` reports like one nobody looks at.
// Fake process: a .cjs that stays alive (a `node -e` one dies at once under the panel host on Windows), NODE_TEST_CONTEXT cleared.
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { slotEventsPath } from '../../src/core/paths.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe } from './daemon.helpers.ts'

const STAY = "process.stdout.write('READY'); setInterval(() => {}, 1000)"

describe('daemon: soul turn reports with the pane open', () => {
  const homes: string[] = []
  const daemons: Daemon[] = []
  after(async () => {
    for (const d of daemons) await d.close()
    for (const h of homes) await removeHome(h)
  })

  async function boot(): Promise<{ home: string; pipe: string; rec: Recorder; id: string; line: (state: 'busy' | 'idle') => void }> {
    const home = tempHome()
    homes.push(home)
    writeFileSync(join(home, 'stay.cjs'), STAY)
    const fakeSoul: AgentAdapter = {
      name: 'soul',
      plan: (input): LaunchPlan => {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
        delete env.NODE_TEST_CONTEXT
        return { command: process.execPath, args: [join(home, 'stay.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
      },
      sessionExists: async () => 'unknown',
      title: async (b) => b.title,
    }
    const pipe = uniquePipe(home)
    const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fakeSoul } })
    daemons.push(daemon)
    const rec = await Recorder.connect(daemon.pipe)
    const { slot } = await rec.client.request({ t: 'create', kind: 'soul', cwd: home, start: true })
    const id = slot!.slotId
    await rec.state(id, (s) => s.pid !== undefined, 30_000, 'spawned')
    await sleep(1_500) // the fake process is up
    const line = (state: 'busy' | 'idle'): void =>
      appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: id, agent: 'soul', kind: 'turn', source: 'turn', state, sessionId: 'sess-1', cwd: home }) + '\n')
    return { home, pipe, rec, id, line }
  }
  const turnOf = async (rec: Recorder, id: string) => (await rec.client.request({ t: 'list' })).slots!.find((s) => s.slotId === id)!

  test('control: a live fake process, nobody attached: busy then idle are applied', async () => {
    const { rec, id, line } = await boot()
    line('busy')
    await rec.state(id, (s) => s.turn === 'busy', 8_000, 'turn busy (control)')
    await sleep(300)
    line('idle')
    await rec.state(id, (s) => s.turn === undefined && s.attention === 'done', 8_000, 'turn idle + done (control)')
    rec.close()
  })

  test('with a client attached (the pane is open): busy then idle are applied', async () => {
    const { rec, id, line } = await boot()
    await rec.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    await sleep(500)
    line('busy')
    await rec.state(id, (s) => s.turn === 'busy', 8_000, 'turn busy (attached)')
    await sleep(300)
    line('idle')
    await rec.state(id, (s) => s.turn === undefined && s.attention === 'done', 8_000, `turn idle + done (attached); last state ${JSON.stringify((await turnOf(rec, id)))}`)
    rec.close()
  })

  test('with attach + resize + seen from the pane: busy then idle are applied', async () => {
    const { rec, id, line } = await boot()
    await rec.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    await rec.client.request({ t: 'resize', slotId: id, cols: 120, rows: 40 })
    await rec.client.request({ t: 'seen', slotId: id })
    await sleep(500)
    line('busy')
    await rec.state(id, (s) => s.turn === 'busy', 8_000, 'turn busy (attach+resize+seen)')
    await sleep(300)
    line('idle')
    await rec.state(id, (s) => s.turn === undefined && s.attention === 'done', 8_000, `turn idle + done (attach+resize+seen); last state ${JSON.stringify((await turnOf(rec, id)))}`)
    rec.close()
  })

  test('a direct client (the app) attached to the hosted pane, with focus/DA answers typed: busy then idle are applied', async () => {
    const { rec, id, line, pipe } = await boot()
    const app = await Recorder.connect(pipe, { direct: true })
    await app.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    app.client.typed(id, '[I')
    app.client.input(id, '[?1;2c')
    await app.client.request({ t: 'resize', slotId: id, cols: 120, rows: 40 })
    await sleep(500)
    line('busy')
    await rec.state(id, (s) => s.turn === 'busy', 8_000, 'turn busy (direct)')
    await sleep(300)
    line('idle')
    await rec.state(id, (s) => s.turn === undefined && s.attention === 'done', 8_000, `turn idle + done (direct); last state ${JSON.stringify((await turnOf(rec, id)))}`)
    app.close()
    rec.close()
  })

  test('the pane that looks (seen as soon as done shows) does not lose the turn: idle is applied, done is broadcast, then cleared by the look', async () => {
    const { rec, id, line } = await boot()
    await rec.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    // What a focused tab does: a `seen` on every state that carries attention.
    rec.client.on('state', (s) => { if (s.slotId === id && s.attention) void rec.client.request({ t: 'seen', slotId: id }) })
    line('busy')
    await rec.state(id, (s) => s.turn === 'busy', 8_000, 'turn busy')
    await sleep(300)
    line('idle')
    await rec.state(id, (s) => s.turn === undefined && s.attention === 'done', 8_000, 'idle was applied: the done state was broadcast')
    await rec.state(id, (s) => s.turn === undefined && s.attention === undefined && rec.states.some((x) => x.slotId === id && x.attention === 'done'), 8_000, 'and the look cleared it')
    assert.equal((await turnOf(rec, id)).turn, undefined)
    assert.equal((await turnOf(rec, id)).attention, undefined, 'a later `list` finds no done: only the broadcast ever showed it')
    rec.close()
  })
})

