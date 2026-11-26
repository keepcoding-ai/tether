// The ronda: the pure model (interval parsing, assembly, nudge text, stimulus) and tetherd's clock (one per slot, sent
// through the ronda's channel only to an idle agent that listens, never typed into its terminal; persisted across the
// agent's restart and the daemon's; `off` with a criterion asks first; unavailable to an agent with no channel).
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { withMcpConfigFlag } from '../../src/agents/mcp.ts'
import { agentRegistry } from '../../src/agents/registry.ts'
import { slotAttentionPath, slotRondaPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import type { RondaChannelAgent } from '../../src/daemon/ronda-channel.ts'
import { applyChange, buildChannelText, buildNudgeText, criterionStimulus, formatInterval, parseInterval, RONDA_DEFAULT_NUDGE, RondaError } from '../../src/daemon/ronda.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { conductorRegistry, type Conductor } from '../../extensions/for-agents/conductor-api.ts'
import { PendingCommands } from '../../extensions/for-agents/daemon/verbs/command.ts'
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
    assert.equal(buildChannelText({ nudge: 'Registre decisões.', criterion: 'merge  feito' }), `${RONDA_DEFAULT_NUDGE} Registre decisões. Critério de parada: merge feito`)
    assert.equal(buildChannelText({}), RONDA_DEFAULT_NUDGE)
    assert.equal(criterionStimulus('merge feito no develop'), 'Esta ronda tem um critério de parada: merge feito no develop. Você cumpriu? Se não cumpriu, não deveria cumprir antes de parar? Para parar mesmo assim, use --off --force.')
    assert.equal(describeRonda(null), 'Ronda desligada neste painel.\n')
    const r = { v: 1 as const, intervalMs: 600_000, createdAt: '2026-11-10T10:00:00.000Z', nextAt: '2026-11-10T10:10:00.000Z', criterion: 'x' }
    const txt = describeRonda(r)
    assert.match(txt, /a cada 10m/)
    assert.match(txt, /Cutucão extra: \(nenhum\)/)
    assert.match(txt, /Critério de parada: x/)
    assert.match(describeRonda({ ...r, due: true }), /esperando o agente ficar ocioso/)
    assert.match(describeRonda({ ...r, channel: 'listening' }), /Canal: ouvindo/)
    assert.match(describeRonda({ ...r, channel: 'none' }), /Canal: sem canal agora/)
    assert.equal(rondaLabel(r), 'Ronda 10m')
    assert.equal(rondaLabel({ ...r, channel: 'listening' }), 'Ronda 10m')
    assert.equal(rondaLabel({ ...r, channel: 'none' }), 'Ronda 10m · sem canal')
    assert.match(rondaTooltip({ ...r, channel: 'listening' }), /Canal: ouvindo/)
    assert.match(rondaTooltip({ ...r, channel: 'none' }), /Sem canal/)
    assert.match(rondaTooltip(r, Date.parse('2026-11-10T10:05:00.000Z')), /a cada 10 min[\s\S]*em 5 min[\s\S]*Critério de parada: x[\s\S]*Clique para desligar/)
  })
})

/** The fake agent (an MCP client of the ronda's channel, test/unit/ronda-channel-agent.ts) prints this once its GET stream is open. */
const AGENT_LISTENING = 'AGENT-LISTENING'
const AGENT_SCRIPT = fileURLToPath(new URL('./ronda-channel-agent.ts', import.meta.url))

function agentPlan(cwd: string, dialog?: 'exact' | 'other'): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (dialog) env.FAKE_DIALOG = dialog
  else delete env.FAKE_DIALOG
  return { command: process.execPath, args: [AGENT_SCRIPT], cwd, env }
}
const fakeAgent = (name: string, dialog?: 'exact' | 'other'): AgentAdapter => ({ name, plan: (input) => agentPlan(input.resume?.cwd ?? input.slot.cwd, dialog), sessionExists: async () => 'unknown', title: async (b) => b.title })
/** The channel as Claude's contribution offers it (its real dialog), but with no leading args (the fake is `node <script>`). */
const channelOf = (): RondaChannelAgent => ({ args: [], inject: withMcpConfigFlag, confirm: agentRegistry.get('claude')!.channelConfirm! })
const isErr = (code: string) => (e: unknown): boolean => e instanceof DaemonError && e.code === code

describe('ronda: daemon clock, through the channel', () => {
  const homes: string[] = []
  const daemons: Daemon[] = []
  const logs: string[] = []
  after(async () => {
    for (const d of daemons) await d.close()
    for (const h of homes) await removeHome(h)
  })
  async function boot(home = tempHome(), adapters: Record<string, AgentAdapter> = { claude: fakeAgent('claude') }, door?: DoorHost): Promise<{ home: string; daemon: Daemon; rec: Recorder }> {
    if (!homes.includes(home)) homes.push(home)
    const daemon = await startDaemon({
      home, pipe: uniquePipe(home), readyFallbackMs: 300, minAgentAgeMs: 0, memoryIntervalMs: 0, rondaAllowSeconds: true, rondaRetryMs: 200,
      adapters, channelOf: (agent) => (agent === 'claude' ? channelOf() : undefined), log: (m) => logs.push(m), ...(door ? { door } : {}),
    })
    daemons.push(daemon)
    return { home, daemon, rec: await Recorder.connect(daemon.pipe) }
  }
  const listening = (rec: Recorder, id: string): number => rec.text(id).split(AGENT_LISTENING).length - 1
  /** Rondas the daemon sent (its own log line) and the ones the agent received (its stdout). */
  const sent = (id: string): number => logs.filter((m) => m === `slot ${id}: ronda sent through the channel`).length
  const received = (rec: Recorder, id: string): string[] => [...rec.text(id).matchAll(/CHANNEL\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!)
  /** What was typed into the agent's terminal (its `<...>` echo). */
  const typed = (rec: Recorder, id: string): string => [...rec.text(id).replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').matchAll(/<([^<>]*)>/g)].map((m) => m[1]).join('')

  test('the nudge goes through the channel, never the terminal: the draft stays, busy waits, the agent\'s restart reconnects, the daemon\'s restart keeps it', async () => {
    const { home, daemon, rec } = await boot()
    const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home, start: true })
    const id = slot!.slotId
    await rec.client.request({ t: 'attach', slotId: id, cols: 300, rows: 30 })
    await waitUntil(() => listening(rec, id) >= 1, 30_000, 'the agent listening on its channel')
    assert.match(rec.text(id), /CAP-CHANNEL/, 'the server declares claude/channel')
    assert.ok(logs.some((m) => m.startsWith(`slot ${id}: ronda channel session (era legacy, protocol 2025-11-25`)), 'the session\'s era and protocol are logged')

    // the user has a draft in the box: the ronda must not touch it
    rec.client.input(id, 'rascunho do usuário')
    await waitUntil(() => typed(rec, id).includes('rascunho do usuário'), 30_000, 'the draft reaching the agent')

    await assert.rejects(rec.client.request({ t: 'ronda-set', slotId: id, interval: '5x' }), isErr('bad-request'))
    const on = await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s', nudge: 'Extra do teste.', criterion: 'merge feito' })
    assert.equal(on.rondaOutcome, 'created')
    assert.equal(on.ronda?.channel, 'listening')
    assert.equal((await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s' })).rondaOutcome, 'unchanged', 'no duplicate')
    assert.ok(existsSync(slotRondaPath(home, id)))

    await waitUntil(() => received(rec, id).length >= 1, 30_000, 'the ronda through the channel')
    assert.equal(received(rec, id)[0], `${RONDA_DEFAULT_NUDGE} Extra do teste. Critério de parada: merge feito`)
    assert.equal(typed(rec, id), 'rascunho do usuário', 'nothing typed into the terminal: the draft is all there is')
    assert.ok(sent(id) >= 1)

    // busy: the hook says a turn started → no ronda, it becomes due
    writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date().toISOString(), kind: 'start' }))
    await rec.state(id, (s) => s.turn === 'busy', 5_000, 'busy')
    await waitUntil(() => logs.includes(`slot ${id}: ronda due, waiting (busy)`), 10_000, 'due while busy')
    const before = sent(id)
    await sleep(1500)
    assert.equal(sent(id), before, 'nothing sent to a busy agent')
    writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date(Date.now() + 1).toISOString(), kind: 'done' }))
    await waitUntil(() => sent(id) > before, 30_000, 'ronda after idle')

    // agent restart: the channel drops (state says so), the ronda is kept, the new run gets a new key and reconnects
    await rec.client.request({ t: 'ronda-set', slotId: id, interval: '2s' })
    await rec.client.request({ t: 'stop', slotId: id })
    await rec.state(id, (s) => s.status === 'exited', 10_000, 'exited')
    const down = (await rec.client.request({ t: 'ronda-get', slotId: id })).ronda
    assert.ok(down, 'kept while the agent is down')
    assert.equal(down!.channel, 'none')
    assert.ok(!existsSync(join(home, 'ronda', 'mcp', `${id}.json`)), 'the run\'s MCP file goes with it')
    await rec.client.request({ t: 'start', slotId: id, choice: 'new' })
    await rec.client.request({ t: 'attach', slotId: id, cols: 300, rows: 30 })
    await waitUntil(() => listening(rec, id) >= 2, 30_000, 'the restarted agent listening')
    const n1 = sent(id)
    await waitUntil(() => sent(id) > n1, 30_000, 'ronda after the agent restarted')

    // daemon restart: the ronda comes back from disk
    rec.close()
    await daemon.close()
    const second = await boot(home)
    const got = (await second.rec.client.request({ t: 'ronda-get', slotId: id })).ronda
    assert.equal(got?.intervalMs, 2000)
    assert.equal(got?.nudge, 'Extra do teste.')
    assert.equal(got?.channel, 'none', 'not running in this daemon yet')
    second.rec.close()
  })

  test('a claimed window holds a due ronda (blocker `claimed`); once released it goes on the retry', async () => {
    const door = new DoorHost({ log: (m) => logs.push(m) })
    const { home, rec } = await boot(undefined, undefined, door)
    const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home, start: true })
    const id = slot!.slotId
    await rec.client.request({ t: 'attach', slotId: id, cols: 300, rows: 30 })
    await waitUntil(() => listening(rec, id) >= 1, 30_000, 'the agent listening on its channel')
    const claim = door.delivery.claim(id, 'comando /compact')
    await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s' })
    await waitUntil(() => logs.includes(`slot ${id}: ronda due, waiting (claimed)`), 10_000, 'due while claimed')
    await sleep(800)
    assert.equal(sent(id), 0, 'nothing sent through several retries while claimed')
    claim.release(false)
    await waitUntil(() => sent(id) >= 1, 10_000, 'ronda on the retry after the release')
    assert.equal(received(rec, id).length, 1)
    rec.close()
  })

  // Regression of 25/11 (ronda 02:38:04.914Z, /compact 02:38:05.085Z, no compaction): a due ronda and a command of oneself
  // waiting on the same pane meet at its busy -> idle edge. The ronda went at once (setImmediate in broadcastState) and opened a
  // turn the command then fell into. The junction: the real daemon and door (rondaBlocker, delivery), the real PendingCommands
  // on the door's API, and a fake conductor that records when it types (the for-agents extension itself is not loaded).
  test('regression 25/11: at the busy -> idle edge the queued /compact is typed before the due ronda, which goes after the settle', async () => {
    const door = new DoorHost({ log: (m) => logs.push(m) })
    const { home, rec } = await boot(undefined, undefined, door)
    const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd: home, start: true })
    const id = slot!.slotId
    await rec.client.request({ t: 'attach', slotId: id, cols: 300, rows: 30 })
    await waitUntil(() => listening(rec, id) >= 1, 30_000, 'the agent listening on its channel')

    let compactAt: number | undefined
    const conductor: Conductor = {
      id: 'regression-25-11',
      match: (t) => (t.paneId === id ? 1000 : undefined),
      capabilities: [{ id: 'command', label: 'c' }],
      command: async (_ctx, name) => { if (name === 'compact') compactAt ??= logs.length; return { value: undefined, proven: true } },
    }
    const reg = conductorRegistry.register(conductor)
    const own = new DisposableStore()
    const pending = new PendingCommands()
    try {
      const api = door.apiFor('for-agents', own)
      pending.bind({
        api: { ...api, agents: { get: () => undefined }, io: {}, home, log: () => {} },
        store: { recordLast: async () => {} },
        gate: { check: () => undefined, write: async () => ({ ok: true }) },
        readers: {},
      } as never)

      // A turn in course: the ronda becomes due, and the agent asks for its own /compact.
      writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date().toISOString(), kind: 'start' }))
      await rec.state(id, (s) => s.turn === 'busy', 5_000, 'busy')
      await rec.client.request({ t: 'ronda-set', slotId: id, interval: '1s' })
      await waitUntil(() => logs.includes(`slot ${id}: ronda due, waiting (busy)`), 10_000, 'due while busy')
      pending.add(id, id, 'compact', undefined)
      const sentLine = `slot ${id}: ronda sent through the channel`
      assert.equal(sent(id), 0)

      // The edge: the turn ends.
      writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date(Date.now() + 1).toISOString(), kind: 'done' }))
      await waitUntil(() => compactAt !== undefined || sent(id) > 0, 10_000, 'the compact or the ronda')
      assert.notEqual(compactAt, undefined, `the /compact went first, not the ronda (${logs.filter((m) => m.startsWith(`slot ${id}: ronda`)).join(' | ')})`)
      const typedAt = Date.now()
      await waitUntil(() => sent(id) > 0, 15_000, 'the ronda after the compact')
      const rondaIdx = logs.indexOf(sentLine)
      assert.ok(rondaIdx >= compactAt!, 'the ronda line comes after the compact in the log')
      assert.ok(Date.now() - typedAt >= 1_500, `the ronda waited for the settle (${Date.now() - typedAt} ms)`)
      await waitUntil(() => received(rec, id).length >= 1, 10_000, 'the agent receiving the ronda')
      assert.equal(received(rec, id).length, 1, 'one ronda, not one per retry')
    } finally {
      pending.dispose().dispose()
      own.dispose()
      reg.dispose()
      rec.close()
    }
  })

  test('no channel, no ronda: a shell and an agent without one are refused with the reason', async () => {
    const { home, rec } = await boot(undefined, { claude: fakeAgent('claude'), soul: fakeAgent('soul') })
    const shell = (await rec.client.request({ t: 'create', kind: 'shell', cwd: home })).slot!.slotId
    await assert.rejects(rec.client.request({ t: 'ronda-set', slotId: shell }), (e: unknown) => isErr('ronda-unavailable')(e) && /terminal sem agente/.test((e as Error).message))
    const soul = (await rec.client.request({ t: 'create', kind: 'soul', cwd: home })).slot!.slotId
    await assert.rejects(rec.client.request({ t: 'ronda-set', slotId: soul }), (e: unknown) => isErr('ronda-unavailable')(e) && /não recebe mensagens por canal/.test((e as Error).message))
    rec.close()
  })

  test('the channel\'s start dialog: answered once when it is exactly Claude\'s; any other screen gets no key', async () => {
    // The captured dialog was drawn for 140x40: the terminal gets that size before the agent starts.
    const { home, rec } = await boot(undefined, { claude: fakeAgent('claude', 'exact') })
    const id = (await rec.client.request({ t: 'create', kind: 'claude', cwd: home })).slot!.slotId
    await rec.client.request({ t: 'attach', slotId: id, cols: 140, rows: 40 })
    await rec.client.request({ t: 'start', slotId: id, choice: 'new' })
    await waitUntil(() => listening(rec, id) >= 1, 30_000, 'the agent connecting after the dialog was answered')
    assert.ok(logs.includes(`slot ${id}: channel confirmation recognized; answering`))
    assert.equal(typed(rec, id), '#CR#', 'one Enter, nothing else')
    rec.close()

    const other = await boot(undefined, { claude: fakeAgent('claude', 'other') })
    const id2 = (await other.rec.client.request({ t: 'create', kind: 'claude', cwd: other.home })).slot!.slotId
    await other.rec.client.request({ t: 'attach', slotId: id2, cols: 140, rows: 40 })
    await other.rec.client.request({ t: 'start', slotId: id2, choice: 'new' })
    await other.rec.see(id2, /Enter[\s\S]*cancel/)
    await sleep(1500)
    assert.equal(typed(other.rec, id2), '', 'a dialog with "Exit" selected gets no key')
    assert.ok(!logs.includes(`slot ${id2}: channel confirmation recognized; answering`))
    other.rec.close()
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
