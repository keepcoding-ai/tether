// tetherd `set-profile`: the slot's launch profile changed in place. Validation (unknown profile, profile of
// another kind), the meta rewritten (id + snapshot, or no profile fields for `null`), the state carrying the new
// name / unsafe badge; and with `restart` on a live agent: the process is killed only after its minimum age,
// the SAME session is resumed with the new profile's args, and an agent that never reported its session makes
// the request fail with `unconfirmed` and nothing changed. No real agent: a fake claude adapter records every
// plan it was asked for and launches an inert process.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan, PlanInput } from '../../src/agents/types.ts'
import type { SlotMeta, TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath, slotMetaPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { pidAlive, Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

let home: string
let daemon: Daemon
let cwd: string

const SESSION = 'cccccccc-0000-4000-8000-000000000003'
const MIN_AGE_MS = 1_500

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

/** What each launch was asked for: the resume (if any) and the profile's args. */
const planned: { resume?: string; profileArgs: string[] }[] = []
const fakeClaude: AgentAdapter = {
  name: 'claude',
  plan: (input: PlanInput) => {
    planned.push({ ...(input.resume ? { resume: input.resume.sessionId } : {}), profileArgs: input.profile?.args ?? [] })
    return inertPlan(input.resume?.cwd ?? input.slot.cwd)
  },
  sessionExists: async () => true,
  title: async (b) => b.title,
}

function startEvent(slotId: string, sessionId: string): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent: 'claude', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['--resume', sessionId] } }
}

function meta(slotId: string): SlotMeta {
  return JSON.parse(readFileSync(slotMetaPath(home, slotId), 'utf8')) as SlotMeta
}

before(async () => {
  home = tempHome()
  cwd = join(home, 'work')
  mkdirSync(cwd)
  daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 60_000, minAgentAgeMs: MIN_AGE_MS })
})
after(async () => {
  await daemon.close()
  await removeHome(home)
})

describe('set-profile on a slot that is not running', () => {
  test('a claude slot created without a profile → "Claude modo dev": meta gets id + snapshot, state gets name + unsafe; null clears them all', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    const slotId = slot!.slotId
    assert.equal(slot!.profileId, undefined)

    const set = await c.client.request({ t: 'set-profile', slotId, profileId: 'claude-dev' })
    assert.deepEqual([set.slot!.profileId, set.slot!.profileName, set.slot!.unsafe, set.slot!.status], ['claude-dev', 'Claude modo dev', true, 'exited'])
    let m = meta(slotId)
    assert.deepEqual([m.profileId, m.profileArgs, m.profileEnv], ['claude-dev', ['--dangerously-skip-permissions'], undefined])
    await c.state(slotId, (s) => s.profileId === 'claude-dev', 5_000, 'state broadcast with the profile')

    const plain = await c.client.request({ t: 'set-profile', slotId, profileId: 'claude' })
    assert.deepEqual([plain.slot!.profileId, plain.slot!.profileName, plain.slot!.unsafe], ['claude', 'Claude', undefined])

    const none = await c.client.request({ t: 'set-profile', slotId, profileId: null })
    assert.deepEqual([none.slot!.profileId, none.slot!.profileName, none.slot!.unsafe], [undefined, undefined, undefined])
    m = meta(slotId)
    assert.ok(!('profileId' in m) && !('profileArgs' in m) && !('profileEnv' in m), `no profile fields left: ${JSON.stringify(m)}`)
    assert.equal(m.v, 1)
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('refusals: unknown profile, profile of another kind, bad profileId, unknown slot', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const claude = (await c.client.request({ t: 'create', kind: 'claude', cwd })).slot!
    const shell = (await c.client.request({ t: 'create', kind: 'shell', cwd })).slot!
    await assert.rejects(c.client.request({ t: 'set-profile', slotId: claude.slotId, profileId: 'nada' }), (e: DaemonError) => e.code === 'unknown-profile')
    await assert.rejects(c.client.request({ t: 'set-profile', slotId: claude.slotId, profileId: 'powershell' }), (e: DaemonError) => e.code === 'bad-request' && /é de shell, não de claude/.test(e.message))
    await assert.rejects(c.client.request({ t: 'set-profile', slotId: shell.slotId, profileId: 'claude-dev' }), (e: DaemonError) => e.code === 'bad-request' && /é de claude, não de shell/.test(e.message))
    await assert.rejects(c.client.request({ t: 'set-profile', slotId: claude.slotId, profileId: 7 as unknown as string }), (e: DaemonError) => e.code === 'bad-request')
    await assert.rejects(c.client.request({ t: 'set-profile', slotId: 'zz999999', profileId: null }), (e: DaemonError) => e.code === 'unknown-slot')
    assert.equal(meta(claude.slotId).profileId, undefined, 'nothing written on a refusal')
    for (const s of [claude, shell]) await c.client.request({ t: 'forget', slotId: s.slotId })
    c.close()
  })

  test('the next start applies the new profile (the plan sees its args)', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd })
    await c.client.request({ t: 'set-profile', slotId: slot!.slotId, profileId: 'claude-dev' })
    planned.length = 0
    const started = await c.client.request({ t: 'start', slotId: slot!.slotId })
    assert.equal(started.slot!.status, 'starting')
    assert.deepEqual(planned, [{ profileArgs: ['--dangerously-skip-permissions'] }])
    await c.client.request({ t: 'forget', slotId: slot!.slotId })
    c.close()
  })
})

describe('set-profile with restart on a live agent', () => {
  test('a reported session: killed only after the minimum age, resumed with the SAME id and the new args; same binding', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid1 = slot!.pid!
    assert.ok(pidAlive(pid1))
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify(startEvent(slotId, SESSION)) + '\n')
    await c.state(slotId, (s) => s.status === 'running' && s.binding?.sessionId === SESSION, 5_000, 'running with the session reported')

    planned.length = 0
    const t0 = Date.now()
    const set = await c.client.request({ t: 'set-profile', slotId, profileId: 'claude-dev', restart: true })
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= MIN_AGE_MS - 100, `the restart waited for the agent's minimum age (${elapsed} ms)`)
    assert.ok(!pidAlive(pid1) || set.slot!.pid !== pid1, 'the old process was killed')
    assert.notEqual(set.slot!.pid, pid1, 'a new process runs the slot')
    assert.equal(set.slot!.status, 'starting', 'relaunched (the fake agent has not reported yet)')
    assert.equal(set.slot!.restarting, undefined, 'the restarting flag is gone from the reply')
    assert.deepEqual([set.slot!.profileId, set.slot!.profileName, set.slot!.unsafe], ['claude-dev', 'Claude modo dev', true])
    assert.equal(set.slot!.binding?.sessionId, SESSION, 'same binding')
    assert.deepEqual(planned, [{ resume: SESSION, profileArgs: ['--dangerously-skip-permissions'] }], 'relaunched with --resume <same id> and the profile args')
    assert.ok(c.states.some((s) => s.slotId === slotId && s.restarting === true && s.pid === pid1), 'clients saw the restart pending on the old process')
    await waitUntil(() => !pidAlive(pid1), 10_000, 'old agent gone')

    // The new run reports the same session: running, confirmed, nothing unconfirmed about it.
    appendFileSync(slotEventsPath(home, slotId), JSON.stringify({ ...startEvent(slotId, SESSION), source: 'resume' }) + '\n')
    await c.state(slotId, (s) => s.status === 'running' && s.pid === set.slot!.pid, 5_000, 'new run running')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('restart: false on a running slot changes the meta only (same pid); the next start uses it', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const set = await c.client.request({ t: 'set-profile', slotId, profileId: 'claude-dev' })
    assert.equal(set.slot!.pid, slot!.pid, 'same process')
    assert.equal(set.slot!.profileId, 'claude-dev')
    assert.equal(meta(slotId).profileId, 'claude-dev')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a running agent that never reported its session: restart refused with unconfirmed, pid and meta untouched', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'claude', cwd, start: true })
    const slotId = slot!.slotId
    const pid = slot!.pid!
    // 'starting' with no report: the daemon waits for the age and the report; shorten the wait by making the
    // slot 'running' without a report, as the ready fallback would (append nothing, use the fallback daemon? no:
    // this daemon's fallback is 60 s). Instead check the pre-flight refusal through a slot already 'running'.
    const quick = await startDaemon({ home: tempHome(), pipe: uniquePipe(home), adapters: { claude: fakeClaude }, readyFallbackMs: 300, minAgentAgeMs: 200 })
    try {
      const qcwd = join(quick.home, 'work')
      mkdirSync(qcwd)
      const q = await Recorder.connect(quick.pipe)
      const made = await q.client.request({ t: 'create', kind: 'claude', cwd: qcwd, start: true })
      const qid = made.slot!.slotId
      await q.state(qid, (s) => s.status === 'running', 5_000, 'running by the fallback, without a report')
      await assert.rejects(q.client.request({ t: 'set-profile', slotId: qid, profileId: 'claude-dev', restart: true }), (e: DaemonError) => e.code === 'unconfirmed' && /não registrou a sessão/.test(e.message))
      const after = (await q.client.request({ t: 'list' })).slots!.find((s) => s.slotId === qid)!
      assert.equal(after.pid, made.slot!.pid, 'same process')
      assert.equal(after.profileId, undefined, 'meta untouched')
      assert.equal(JSON.parse(readFileSync(slotMetaPath(quick.home, qid), 'utf8')).profileId, undefined)
      // Still 'starting' when asked: the daemon waits; the fallback turns it running without a report → refused too.
      const made2 = await q.client.request({ t: 'create', kind: 'claude', cwd: qcwd, start: true })
      await assert.rejects(q.client.request({ t: 'set-profile', slotId: made2.slot!.slotId, profileId: 'claude-dev', restart: true }), (e: DaemonError) => e.code === 'unconfirmed')
      assert.equal(JSON.parse(readFileSync(slotMetaPath(quick.home, made2.slot!.slotId), 'utf8')).profileId, undefined, 'meta untouched after the wait')
      for (const s of [made.slot!, made2.slot!]) await q.client.request({ t: 'forget', slotId: s.slotId })
      q.close()
    } finally {
      const qhome = quick.home
      await quick.close()
      await removeHome(qhome)
    }
    assert.ok(pidAlive(pid))
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })

  test('a shell slot: restart = a new shell with the new profile (no session involved)', async () => {
    const c = await Recorder.connect(daemon.pipe)
    const { slot } = await c.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    const slotId = slot!.slotId
    const pid1 = slot!.pid!
    const set = await c.client.request({ t: 'set-profile', slotId, profileId: 'powershell', restart: true })
    assert.notEqual(set.slot!.pid, pid1)
    assert.equal(set.slot!.status, 'running')
    assert.equal(set.slot!.profileId, 'powershell')
    await waitUntil(() => !pidAlive(pid1), 10_000, 'old shell gone')
    await c.client.request({ t: 'forget', slotId })
    c.close()
  })
})
