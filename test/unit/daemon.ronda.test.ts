// The ronda: the pure model (interval parsing, assembly, nudge text, stimulus) and tetherd's clock (one per slot, typed
// only into an idle agent, persisted across the agent's restart and the daemon's, `off` with a criterion asks first).
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotAttentionPath, slotEventsPath, slotRondaPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { applyChange, buildNudgeText, criterionStimulus, formatInterval, parseInterval, RONDA_DEFAULT_NUDGE, RondaError } from '../../src/daemon/ronda.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { describeRonda } from '../../src/cli/ronda.ts'
import { rondaLabel, rondaTooltip } from '../../app/renderer/ronda-rules.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

describe('ronda: model', () => {
  test('parseInterval takes minutes and hours; seconds only when allowed; bounds', () => {
    assert.equal(parseInterval('20m'), 20 * 60_000)
    assert.equal(parseInterval('10min'), 10 * 60_000)
    assert.equal(parseInterval('1h'), 3_600_000)
    assert.equal(parseInterval('1h30m'), 90 * 60_000)
    assert.equal(parseInterval(' 2 H '), 2 * 3_600_000)
    assert.throws(() => parseInterval('30s'), RondaError)
    assert.equal(parseInterval('30s', true), 30_000)
    for (const bad of ['', 'x', '10', '0m', '25h', 'm']) assert.throws(() => parseInterval(bad), RondaError, bad)
    assert.equal(formatInterval(20 * 60_000), '20m')
    assert.equal(formatInterval(90 * 60_000), '1h30m')
    assert.equal(formatInterval(3_600_000), '1h')
    assert.equal(formatInterval(5_000), '5s')
  })

  test('applyChange: new = 20m; same call is unchanged; interval resets nextAt; texts keep unless given, "" clears', () => {
    const t0 = Date.parse('2026-11-10T10:00:00.000Z')
    const a = applyChange(undefined, {}, t0)
    assert.equal(a.outcome, 'created')
    assert.equal(a.ronda.intervalMs, 20 * 60_000)
    assert.equal(a.ronda.nextAt, '2026-11-10T10:20:00.000Z')
    assert.equal(applyChange(a.ronda, {}, t0 + 1000).outcome, 'unchanged')
    const b = applyChange(a.ronda, { criterion: 'merge feito no develop', nudge: 'linha\nnova' }, t0 + 1000)
    assert.equal(b.outcome, 'updated')
    assert.equal(b.ronda.nextAt, a.ronda.nextAt, 'texts do not move the clock')
    assert.equal(b.ronda.nudge, 'linha nova', 'flattened to one line')
    const c = applyChange(b.ronda, { interval: '10m' }, t0 + 2000)
    assert.equal(c.ronda.criterion, 'merge feito no develop', 'only the interval: what was assembled stays')
    assert.equal(c.ronda.nextAt, new Date(t0 + 2000 + 10 * 60_000).toISOString())
    assert.equal(applyChange(c.ronda, { interval: '10m' }, t0 + 3000).outcome, 'unchanged')
    const d = applyChange(c.ronda, { criterion: '' }, t0)
    assert.equal(d.ronda.criterion, undefined)
    assert.equal(d.ronda.nudge, 'linha nova')
  })

  test('nudge text = default + extra; stimulus names the criterion; status text', () => {
    assert.equal(RONDA_DEFAULT_NUDGE, '[ronda] Ronda de rotina. Olhe para o seu trabalho e para os seus subagentes, e siga. Se o trabalho já acabou, diga isso e desligue esta ronda.')
    assert.equal(buildNudgeText({}), RONDA_DEFAULT_NUDGE)
    assert.equal(buildNudgeText({ nudge: 'Registre decisões.' }), `${RONDA_DEFAULT_NUDGE} Registre decisões.`)
    assert.equal(criterionStimulus('merge feito no develop'), 'Esta ronda tem um critério de parada: merge feito no develop. Você cumpriu? Se não cumpriu, não deveria cumprir antes de parar? Para parar mesmo assim, use --off --force.')
    assert.equal(describeRonda(null), 'Ronda desligada neste painel.\n')
    const r = { v: 1 as const, intervalMs: 600_000, createdAt: '2026-11-10T10:00:00.000Z', nextAt: '2026-11-10T10:10:00.000Z', criterion: 'x' }
    const txt = describeRonda(r)
    assert.match(txt, /a cada 10m/)
    assert.match(txt, /Cutucão extra: \(nenhum\)/)
    assert.match(txt, /Critério de parada: x/)
    assert.match(describeRonda({ ...r, due: true }), /esperando o agente ficar ocioso/)
    assert.equal(rondaLabel(r), 'Ronda 10m')
    assert.match(rondaTooltip(r, Date.parse('2026-11-10T10:05:00.000Z')), /a cada 10 min[\s\S]*em 5 min[\s\S]*Critério de parada: x[\s\S]*Clique para desligar/)
  })
})

/** An "agent" that echoes what is typed, bracketed, so the test sees the nudge arrive. */
function echoPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  const script = "process.stdin.setRawMode&&process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('<'+String(d).replace(/\\r/g,'#CR#')+'>'))"
  return { command: process.execPath, args: ['-e', script], cwd, env }
}
const fakeClaude: AgentAdapter = { name: 'claude', plan: (input) => echoPlan(input.resume?.cwd ?? input.slot.cwd), sessionExists: async () => 'unknown', title: async (b) => b.title }
const isErr = (code: string) => (e: unknown): boolean => e instanceof DaemonError && e.code === code

describe('ronda: daemon clock', () => {
  const homes: string[] = []
  const daemons: Daemon[] = []
  after(async () => {
    for (const d of daemons) await d.close()
    for (const h of homes) await removeHome(h)
  })
  async function boot(home = tempHome()): Promise<{ home: string; daemon: Daemon; rec: Recorder }> {
    if (!homes.includes(home)) homes.push(home)
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), readyFallbackMs: 300, minAgentAgeMs: 0, memoryIntervalMs: 0, rondaAllowSeconds: true, rondaRetryMs: 200, rondaInputQuietMs: 300, adapters: { claude: fakeClaude } })
    daemons.push(daemon)
    return { home, daemon, rec: await Recorder.connect(daemon.pipe) }
  }
  /** The agent's start report (what Claude's SessionStart hook writes): the run opened its session. */
  const started = (home: string, id: string): void => appendFileSync(slotEventsPath(home, id), JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: id, agent: 'claude', kind: 'start', source: 'startup', sessionId: 'sess-ronda', cwd: home, resume: { cwd: home, args: ['--resume', 'sess-ronda'] } }) + '\n')
  const nudges = (rec: Recorder, id: string): number => rec.text(id).split('[ronda] Ronda de rotina').length - 1

  test('one per slot; nudges an idle agent on time; waits while busy; survives a restart of the agent and of the daemon', async () => {
    const { home, daemon, rec } = await boot()
    const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home, start: true })
    const id = slot!.slotId
    await rec.client.request({ t: 'attach', slotId: id, cols: 300, rows: 30 })
    await rec.state(id, (s) => s.status === 'running', 5_000, 'running')

    // running by the fallback but no start report (still in a menu): the due ronda waits
    await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s' })
    await rec.state(id, (s) => s.ronda?.due === true, 5_000, 'due before the start report')
    assert.equal(nudges(rec, id), 0, 'nothing typed before the agent opened its session')
    await rec.client.request({ t: 'ronda-off', slotId: id })
    started(home, id)
    await rec.state(id, (s) => !!s.binding, 5_000, 'bound')

    await assert.rejects(rec.client.request({ t: 'ronda-set', slotId: id, interval: '5x' }), isErr('bad-request'))
    const on = await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s', nudge: 'Extra do teste.' })
    assert.equal(on.rondaOutcome, 'created')
    assert.equal((await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s' })).rondaOutcome, 'unchanged', 'no duplicate')
    assert.ok(existsSync(slotRondaPath(home, id)))
    await rec.state(id, (s) => !!s.ronda, 3_000, 'ronda in the state')

    await rec.see(id, /\[ronda\] Ronda de rotina[^<>]*Extra do teste\.>/, 5_000)
    await rec.see(id, /<#CR#>/, 3_000) // Enter in its own chunk

    // busy: the hook says a turn started → no nudge, the ronda becomes due
    writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date().toISOString(), kind: 'start' }))
    await rec.state(id, (s) => s.turn === 'busy', 5_000, 'busy')
    const before = nudges(rec, id)
    await rec.state(id, (s) => s.ronda?.due === true, 5_000, 'due while busy')
    await sleep(1500)
    assert.equal(nudges(rec, id), before, 'nothing typed into a busy agent')
    // idle again → the due nudge goes at once
    writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date(Date.now() + 1).toISOString(), kind: 'done' }))
    await waitUntil(() => nudges(rec, id) > before, 5_000, 'nudge after idle')

    // agent restart: the ronda is kept while it is down and nudges the new run
    await rec.client.request({ t: 'ronda-set', slotId: id, interval: '2s' })
    await rec.client.request({ t: 'stop', slotId: id })
    await rec.state(id, (s) => s.status === 'exited', 10_000, 'exited')
    assert.ok((await rec.client.request({ t: 'ronda-get', slotId: id })).ronda, 'kept while the agent is down')
    await rec.client.request({ t: 'start', slotId: id, choice: 'new' })
    await rec.client.request({ t: 'attach', slotId: id, cols: 300, rows: 30 })
    await sleep(500)
    started(home, id)
    const n1 = nudges(rec, id)
    await waitUntil(() => nudges(rec, id) > n1, 10_000, 'nudge after the agent restarted')

    // daemon restart: the ronda comes back from disk
    rec.close()
    await daemon.close()
    const second = await boot(home)
    const got = (await second.rec.client.request({ t: 'ronda-get', slotId: id })).ronda
    assert.equal(got?.intervalMs, 2000)
    assert.equal(got?.nudge, 'Extra do teste.')
    second.rec.close()
  })

  test('off: with a criterion it answers the stimulus and keeps running; --force switches off; without one it switches off', async () => {
    const { home, rec } = await boot()
    const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home })
    const id = slot!.slotId
    assert.equal((await rec.client.request({ t: 'ronda-off', slotId: id })).rondaOutcome, 'was-off')
    await rec.client.request({ t: 'ronda-set', slotId: id, criterion: 'merge feito no develop' })
    await assert.rejects(rec.client.request({ t: 'ronda-off', slotId: id }), (e: unknown) => e instanceof DaemonError && e.code === 'ronda-criterion' && e.message === criterionStimulus('merge feito no develop'))
    assert.ok((await rec.client.request({ t: 'ronda-get', slotId: id })).ronda)
    assert.equal((await rec.client.request({ t: 'ronda-off', slotId: id, force: true })).rondaOutcome, 'off')
    assert.equal((await rec.client.request({ t: 'ronda-get', slotId: id })).ronda, null)
    assert.ok(!existsSync(slotRondaPath(home, id)))
    await rec.client.request({ t: 'ronda-set', slotId: id, interval: '30m' })
    assert.equal(JSON.parse(readFileSync(slotRondaPath(home, id), 'utf8')).intervalMs, 30 * 60_000)
    assert.equal((await rec.client.request({ t: 'ronda-off', slotId: id })).rondaOutcome, 'off')
    rec.close()
  })
})
