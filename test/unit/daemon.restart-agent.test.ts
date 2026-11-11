// tetherd `restart`: the live agent is relaunched in the SAME slot resuming the SAME session. Refused with
// `unconfirmed` (nothing killed) before the agent reported its session, an error on a dead slot, and
// `canRestart` only for adapters that resume. Fake adapters launch inert processes.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan, PlanInput } from '../../src/agents/types.ts'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string
const SESSION = 'dddddddd-0000-4000-8000-000000000004'

function inertPlan(dir: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir, env }
}
const planned: { resume?: string }[] = []
const fakeClaude: AgentAdapter = {
  name: 'claude',
  resumes: true,
  plan: (input: PlanInput) => { planned.push(input.resume ? { resume: input.resume.sessionId } : {}); return inertPlan(input.resume?.cwd ?? input.slot.cwd) },
  sessionExists: async () => true,
  title: async (b) => b.title,
}
const fakeSoul: AgentAdapter = { ...fakeClaude, name: 'soul', resumes: undefined }

function startEvent(slotId: string, agent: 'claude' | 'soul'): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent, kind: 'start', source: 'startup', sessionId: SESSION, cwd, resume: { cwd, args: ['--resume', SESSION] } }
}

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: fakeClaude, soul: fakeSoul }, readyFallbackMs: 60_000, minAgentAgeMs: 300, killWaitCapMs: 3_000 })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

describe('restart', () => {
  test('a reported session: canRestart turns on, then the same slot relaunches with --resume <same id>', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid1 = slot!.pid!
    assert.notEqual(slot!.canRestart, true, 'not before the agent reports')
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, 'claude')) + '\n')
    await c.state(slotId, (s) => s.canRestart === true, 5_000, 'canRestart broadcast once the session is reported')

    planned.length = 0
    const r = await c.client.request({ t: 'restart', slotId })
    assert.equal(r.slot!.slotId, slotId, 'same slot')
    assert.notEqual(r.slot!.pid, pid1, 'a new process')
    assert.equal(r.slot!.binding?.sessionId, SESSION)
    assert.equal(r.slot!.restarting, undefined)
    assert.deepEqual(planned, [{ resume: SESSION }])
    await waitUntil(() => !pidAlive(pid1), 10_000, 'old agent gone')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('no session reported: unconfirmed and the process is not killed', async () => {
    const quick = await startDaemon({ home: tempHome(), pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 300, minAgentAgeMs: 200, killWaitCapMs: 2_000 })
    try {
      const qcwd = join(quick.home, 'work')
      mkdirSync(qcwd)
      const q = await Recorder.connect(quick.pipe)
      const made = await q.client.request({ t: 'create', kind: 'claude', cwd: qcwd, start: true })
      const id = made.slot!.slotId
      await q.state(id, (s) => s.status === 'running', 5_000, 'running by the fallback, without a report')
      await assert.rejects(q.client.request({ t: 'restart', slotId: id }), (e: DaemonError) => e.code === 'unconfirmed')
      const after = (await q.client.request({ t: 'list' })).slots!.find((s) => s.slotId === id)!
      assert.equal(after.pid, made.slot!.pid, 'same process')
      assert.notEqual(after.canRestart, true)
      await q.client.request({ t: 'forget', slotId: id })
      q.close()
    } finally {
      const h = quick.home
      await quick.close()
      await removeHome(h)
    }
  })

  test('a dead slot, a shell and an unknown slot are refused', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const dead = (await c.client.request({ t: 'create', kind: 'claude', cwd })).slot!
    await assert.rejects(c.client.request({ t: 'restart', slotId: dead.slotId }), (e: DaemonError) => e.code === 'bad-request' && /não está rodando/.test(e.message))
    const shell = (await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })).slot!
    await assert.rejects(c.client.request({ t: 'restart', slotId: shell.slotId }), (e: DaemonError) => e.code === 'bad-request')
    await assert.rejects(c.client.request({ t: 'restart', slotId: 'zz999999' }), (e: DaemonError) => e.code === 'unknown-slot')
    for (const s of [dead, shell]) await c.client.request({ t: 'forget', slotId: s.slotId })
    c.close()
  })

  test('an adapter without `resumes`: canRestart stays false even with a reported session, and restart is refused', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'soul', cwd, start: true })
    const slotId = slot!.slotId
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, 'soul')) + '\n')
    const s = await c.state(slotId, (x) => x.binding?.sessionId === SESSION, 5_000, 'session reported')
    assert.notEqual(s.canRestart, true)
    await assert.rejects(c.client.request({ t: 'restart', slotId }), (e: DaemonError) => e.code === 'bad-request')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })
})
