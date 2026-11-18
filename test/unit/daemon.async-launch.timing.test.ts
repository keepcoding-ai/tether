// The asynchronous launch contract (E3.6a): an adapter's plan and an extension's launch middleware may be promises, and the
// ronda's MCP file is written through the store with a barrier before the spawn. What must hold:
//   - the slot takes its 'starting' seat BEFORE the launch's first await: a burst of starts never counts more than
//     MAX_STARTING in 'starting' (sampled inside the daemon while the plans are pending), and each slot's states arrive in order;
//   - a middleware that never answers is dropped at the host's ceiling: it holds the seat no longer than that;
//   - a stop while the plan is pending cancels the launch: nothing is spawned when the plan finally comes;
//   - the ronda's MCP file is on disk when the agent is born (the fake agent checks it first thing, with a slow io lane).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { AgentRegistry } from '../../src/agents/registry.ts'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import type { AgentAdapter, LaunchPlan, PlanInput } from '../../src/agents/types.ts'
import type { ExtensionManifest } from '../../extensions/types.ts'
import { appendFileSync } from 'node:fs'
import type { TetherEvent } from '../../src/core/event.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { MAX_STARTING, startDaemon, type Daemon, type DaemonOptions } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

/** A process that stays up until killed, in place of the agent. */
function inertPlan(cwd: string): LaunchPlan {
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: inheritedEnv() }
}

function startEvent(slotId: string, sessionId: string, cwd: string): TetherEvent {
  return { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['-r', sessionId] } }
}

const startingOf = (d: Daemon): number => d.slots().filter((s) => s.status === 'starting').length

describe('asynchronous launch', () => {
  const homes: string[] = []
  const daemons: Daemon[] = []
  const recorders: Recorder[] = []
  after(async () => {
    for (const r of recorders) r.close()
    for (const d of daemons) await d.close()
    for (const h of homes) await removeHome(h)
  })
  async function boot(opts: Partial<DaemonOptions>): Promise<{ home: string; cwd: string; daemon: Daemon; rec: Recorder; logs: string[] }> {
    const home = tempHome()
    homes.push(home)
    const cwd = join(home, 'work')
    mkdirSync(cwd)
    const logs: string[] = []
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, log: (m) => logs.push(m), ...opts })
    daemons.push(daemon)
    const rec = await Recorder.connect(daemon.pipe)
    recorders.push(rec)
    return { home, cwd, daemon, rec, logs }
  }

  test(`10 panels restored in a burst: never more than ${MAX_STARTING} 'starting' (plans pending included), states in order`, async () => {
    let daemon!: Daemon
    let maxStarting = 0
    let plansInFlight = 0
    let maxPlansInFlight = 0
    const sample = (): void => { maxStarting = Math.max(maxStarting, startingOf(daemon)) }
    // A slow, asynchronous plan and middleware: every launch spends its awaits holding the seat.
    const slowSoul: AgentAdapter = {
      name: 'soul',
      plan: async (input: PlanInput) => {
        plansInFlight++
        maxPlansInFlight = Math.max(maxPlansInFlight, plansInFlight)
        sample()
        await sleep(20 + Math.floor(Math.random() * 40))
        sample()
        plansInFlight--
        return inertPlan(input.resume?.cwd ?? input.slot.cwd)
      },
      sessionExists: async () => 'unknown',
      title: async (b) => b.title,
    }
    const booted = await boot({ adapters: { soul: slowSoul }, transformPlan: async (plan) => { sample(); await sleep(Math.floor(Math.random() * 20)); sample(); return plan } })
    daemon = booted.daemon
    const { cwd, rec, home } = booted
    const sampler = setInterval(sample, 1)
    try {
      const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => rec.client.request({ t: 'create', kind: 'soul', cwd, name: `p${i}`, start: true })))
      const ids = replies.map((r) => r.slot!.slotId)
      sample()
      assert.equal(startingOf(daemon), MAX_STARTING)
      assert.equal(daemon.slots().filter((s) => s.status === 'queued').length, 10 - MAX_STARTING)
      // Drain: each confirmed agent frees a seat for the next queued one.
      for (let n = 0; n < 10; n++) {
        const up = await waitUntil(() => daemon.slots().some((s) => s.status === 'starting' && s.pid !== undefined), 10_000, 'a spawned slot')
        void up
        const s = daemon.slots().find((x) => x.status === 'starting' && x.pid !== undefined)!
        appendFileSync(slotEventsPath(home, s.slotId), JSON.stringify(startEvent(s.slotId, `sess-${n}`, cwd)) + '\n')
        await rec.state(s.slotId, (x) => x.status === 'running', 10_000, 'running')
      }
      await waitUntil(() => daemon.slots().filter((s) => ids.includes(s.slotId)).every((s) => s.status === 'running'), 10_000, 'all running')
      assert.ok(maxStarting <= MAX_STARTING, `max 'starting' seen inside the daemon: ${maxStarting}`)
      assert.ok(maxPlansInFlight <= MAX_STARTING, `max plans pending at once: ${maxPlansInFlight}`)
      assert.equal(maxStarting, MAX_STARTING, 'the seats were all used')

      // Client side: the 'starting' count seen by a client never passes the ceiling either, and each slot goes forward only.
      const last = new Map<string, string>()
      let clientMax = 0
      const rank: Record<string, number> = { queued: 1, starting: 2, running: 3 }
      const seq = new Map<string, string[]>()
      for (const st of rec.states as SlotState[]) {
        if (!ids.includes(st.slotId)) continue
        last.set(st.slotId, st.status)
        clientMax = Math.max(clientMax, [...last.values()].filter((v) => v === 'starting').length)
        const list = seq.get(st.slotId) ?? []
        if (rank[st.status] !== undefined && list.at(-1) !== st.status) list.push(st.status)
        seq.set(st.slotId, list)
      }
      assert.ok(clientMax <= MAX_STARTING, `max 'starting' seen by a client: ${clientMax}`)
      for (const id of ids) {
        const list = seq.get(id)!
        for (let i = 1; i < list.length; i++) assert.ok(rank[list[i]!]! > rank[list[i - 1]!]!, `slot ${id}: ${list.join(' → ')}`)
        assert.deepEqual(list.slice(-2), ['starting', 'running'], `slot ${id}: ${list.join(' → ')}`)
        const starting = (rec.states as SlotState[]).filter((s) => s.slotId === id && s.status === 'starting')
        assert.ok(starting.every((s) => s.pid !== undefined), `slot ${id}: 'starting' is announced once, with the pid`)
      }
    } finally {
      clearInterval(sampler)
    }
  })

  test('a launch middleware that never answers is dropped at the ceiling: the seat is held no longer than that', async () => {
    const CEILING = 400
    const hostLogs: string[] = []
    const host = new DaemonExtensionHost({
      home: tempHome(), log: (m) => hostLogs.push(m), agents: new AgentRegistry(), planTimeoutMs: CEILING,
      extensions: [{
        manifest: { id: 'hangs', version: '0.0.0', displayName: 'hangs', hosts: ['daemon'] } as ExtensionManifest,
        activate: (api) => [api.launch.use(() => new Promise<LaunchPlan>(() => { /* never */ }))],
      }],
    })
    host.activate()
    try {
      const fakeSoul: AgentAdapter = { name: 'soul', plan: (input) => inertPlan(input.slot.cwd), sessionExists: async () => 'unknown', title: async (b) => b.title }
      const { daemon, cwd, rec } = await boot({ adapters: { soul: fakeSoul }, transformPlan: host.transformPlan })
      const t0 = Date.now()
      const replies = await Promise.all(Array.from({ length: MAX_STARTING + 1 }, (_, i) => rec.client.request({ t: 'create', kind: 'soul', cwd, name: `h${i}`, start: true })))
      const ids = replies.map((r) => r.slot!.slotId)
      // The first MAX_STARTING spawn once the ceiling drops the middleware; the last one stays queued (no start event comes).
      for (const id of ids.slice(0, MAX_STARTING)) await rec.state(id, (s) => s.status === 'starting' && s.pid !== undefined, 10_000, 'spawned')
      const took = Date.now() - t0
      assert.ok(took >= CEILING - 20, `spawned after the ceiling (${took} ms)`)
      assert.ok(took < CEILING + 3_000, `the hung middleware held the seats for ${took} ms`)
      assert.equal(daemon.slots().find((s) => s.slotId === ids.at(-1))!.status, 'queued')
      assert.ok(startingOf(daemon) <= MAX_STARTING)
      assert.equal(hostLogs.filter((m) => m.includes(`launch middleware of hangs took over ${CEILING} ms`)).length, MAX_STARTING)
    } finally {
      host.dispose()
    }
  })

  test('a stop while the plan is pending cancels the launch: the seat frees and nothing is spawned when the plan comes', async () => {
    let entered!: () => void
    const inPlan = new Promise<void>((r) => { entered = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let plans = 0
    const gatedSoul: AgentAdapter = {
      name: 'soul',
      plan: async (input) => { plans++; entered(); await gate; return inertPlan(input.slot.cwd) },
      sessionExists: async () => 'unknown',
      title: async (b) => b.title,
    }
    const { daemon, cwd, rec, logs } = await boot({ adapters: { soul: gatedSoul } })
    const { slot } = await rec.client.request({ t: 'create', kind: 'soul', cwd, name: 'gated' })
    const id = slot!.slotId
    const starting = rec.client.request({ t: 'start', slotId: id, choice: 'new' })
    await inPlan
    assert.equal(startingOf(daemon), 1, 'the seat is held while the plan is pending')
    await rec.client.request({ t: 'stop', slotId: id })
    await starting // the start answers once the launch is cancelled
    assert.equal(daemon.slots().find((s) => s.slotId === id)!.status, 'exited')
    assert.equal(startingOf(daemon), 0, 'the seat is free again')
    release()
    await sleep(500)
    const after = daemon.slots().find((s) => s.slotId === id)!
    assert.equal(after.status, 'exited')
    assert.equal(after.pid, undefined)
    assert.equal(plans, 1)
    assert.ok(!logs.some((m) => m.startsWith(`slot ${id}: spawned`)), 'nothing spawned after the cancel')
    assert.ok(!(rec.states as SlotState[]).some((s) => s.slotId === id && s.pid !== undefined), 'no client ever saw a pid')
  })

  test('the ronda\'s MCP file is on disk when the agent is born (slow io lane: the spawn waits for the write)', async () => {
    const executor = createExecutor({ mode: 'worker', ioDelayMs: 150 })
    try {
      // The fake agent checks the file named after --mcp-config first thing, then stays up (a script file: no quoting through the pty).
      const probeDir = tempHome()
      homes.push(probeDir)
      const probe = join(probeDir, 'probe.cjs')
      writeFileSync(probe, 'const a=process.argv;const f=a[a.indexOf("--mcp-config")+1];const ok=require("fs").existsSync(f);process.stdout.write(ok?"MCP-ON-DISK\\n":"MCP-MISSING "+f+"\\n");setInterval(()=>{},1000)\n')
      const fakeClaude: AgentAdapter = {
        name: 'claude',
        plan: (input) => ({ command: process.execPath, args: [probe], cwd: input.slot.cwd, env: inheritedEnv() }),
        sessionExists: async () => 'unknown',
        title: async (b) => b.title,
      }
      const { rec, cwd, home } = await boot({ executor, adapters: { claude: fakeClaude }, channelOf: (agent) => (agent === 'claude' ? { args: [], inject: withMcpConfigFlag } : undefined) })
      const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd, start: true })
      const id = slot!.slotId
      // What it printed before the attach comes back in the attach's scrollback.
      const attached = await rec.client.request({ t: 'attach', slotId: id, cols: 200, rows: 30 })
      const seen = (): string => (attached.scrollback ?? '') + rec.text(id)
      let m: RegExpExecArray | null = null
      await waitUntil(() => (m = /MCP-ON-DISK|MCP-MISSING[^\r\n]*/.exec(seen())) !== null, 30_000, 'the agent\'s report').catch((e: Error) => {
        throw new Error(`${e.message}; slot: ${JSON.stringify(daemons.at(-1)?.slots().find((s) => s.slotId === id))}; output: ${seen().slice(-500)}`)
      })
      assert.equal(m![0], 'MCP-ON-DISK', `the agent saw: ${m![0]}`)
      void home
    } finally {
      for (const d of daemons.splice(0)) await d.close()
      await executor.close()
    }
  })
})
