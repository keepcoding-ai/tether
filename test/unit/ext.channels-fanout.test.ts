// The channels' fan-out (extensions/channels/daemon/fanout.ts, slice H2) in a real tetherd on a test home and test pipe, with
// the real store and the core's real delivery. The agents are fake `claude` slots (test/fixtures/channels/agent.cjs): each logs
// every stdin chunk it gets and, when its name starts with "dentro", opens the `tether` MCP stream as Claude Code does and logs
// each channel notification. The turn and the attention come from the hook's attention file the test writes. No real agent;
// the user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotAttentionPath } from '../../src/core/paths.ts'
import { inboxPath } from '../../src/daemon/door/delivery.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DeliveryMessage, DoorApi } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { mergedNotice, returnNotice } from '../../extensions/channels/daemon/notices.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { isMember, USER } from '../../extensions/channels/rules.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))

const readLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])

interface Note { method?: string; params?: { content: string; meta: Record<string, string> } }

describe('channels fan-out (H2)', () => {
  let home: string
  let pipe: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  const own = new DisposableStore()
  let doorApi: DoorApi
  let ch: Channels
  const logs: string[] = []
  const events: Array<{ name: string; payload: any }> = []
  const slotListeners: Array<(kind: string, slot: SlotState) => void> = []
  const states: SlotState[] = []
  /** When set, the next `cancel` answers false (the line left meanwhile) without touching the queue. */
  let cancelFails = false

  const echoLog = (slotId: string): string => join(home, `echo-${slotId}.log`)
  const chanLog = (slotId: string): string => join(home, `chan-${slotId}.log`)
  const chunks = (slotId: string): string[] => readLines<string>(echoLog(slotId))
  const notes = (slotId: string): Note[] => readLines<Note>(chanLog(slotId)).filter((l) => l.method === 'notifications/claude/channel')
  const inbox = async (slotId: string): Promise<DeliveryMessage[]> => {
    await door.delivery.flush()
    return readLines<{ msg: DeliveryMessage }>(inboxPath(home, slotId)).map((i) => i.msg)
  }

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog(input.slot.slotId)
      env.CHAN_LOG = chanLog(input.slot.slotId)
      env.OPEN_STREAM = input.slot.name?.startsWith('dentro') ? '1' : '0'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }

  // The fake is `node <script>`: the door's channel flag (first in the plan once the delivery is on) would be read by node.
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  before(() => { contribution.channels = () => [] })
  after(() => { contribution.channels = savedChannels })

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    door = new DoorHost({ log: (m) => logs.push(m) })
    daemon = await startDaemon({
      home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
      log: (m) => logs.push(m), onSlot: (kind, slot) => { for (const l of slotListeners) l(kind, slot) },
    })
    rec = await Recorder.connect(daemon.pipe)
    doorApi = door.apiFor('channels', own)
    own.add(doorApi.delivery.enable())
    own.add(doorApi.slots.onState((s) => { states.push(s) }))
    const delivery = {
      ...doorApi.delivery,
      cancel: (id: string) => { if (cancelFails) { cancelFails = false; return false } return doorApi.delivery.cancel(id) },
    }
    const api: ChannelsApi = {
      slots: doorApi.slots, attention: doorApi.attention, delivery,
      events: { emit: (name, payload) => { events.push({ name, payload: JSON.parse(JSON.stringify(payload)) }) } },
      settings: { get: () => undefined },
      log: (m) => logs.push(m),
    }
    ch = createChannels(api, await openStore(fsIo, home))
    slotListeners.push((kind, slot) => {
      if (kind === 'removed') void ch.forgotten(slot.slotId)
      if (kind === 'spawned') void ch.spawned(slot.slotId)
    })
  })
  after(async () => {
    ch?.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    rec?.close()
    await daemon?.close()
    await door.mcp.close()
    await removeHome(home)
  })

  const running = async (name: string): Promise<string> => {
    const id = (await doorApi.slots.create({ kind: 'claude', cwd: home, name })).slotId
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    if (name.startsWith('dentro')) await waitUntil(() => doorApi.delivery.pathOf(id) === 'inside', 30_000, `${name} opened its stream`)
    return id
  }
  let attentionTs = Date.now()
  const report = (id: string, kind: 'start' | 'done' | 'waiting'): void => {
    attentionTs = Math.max(attentionTs + 1, Date.now())
    writeFileSync(slotAttentionPath(home, id), JSON.stringify({ ts: new Date(attentionTs).toISOString(), kind }) + '\n')
  }
  const hold = (id: string): Promise<void> => doorApi.slots.setHeld(id, { ext: 'probe', by: 'owner-slot' })
  const channel = async (owner: string, name: string): Promise<string> => {
    const made = await ch.create(owner, { name })
    assert.ok(made.ok, JSON.stringify(made))
    return made.channel.id
  }
  const addMember = async (id: string, agent: string): Promise<void> => {
    const r = await ch.join(USER, id, agent)
    assert.ok(r.ok && !r.already, JSON.stringify(r))
  }

  let owner: string
  let inside: string
  let outside: string

  test('a line reaches every member but the speaker: room, from, role member (the owner too), to, ref; the moderator is role moderator, id user', async () => {
    owner = await running('dentro-dono')
    inside = await running('dentro-par')
    outside = await running('fora')
    const id = await channel(owner, 'obra')
    await addMember(id, inside)
    await addMember(id, outside)
    await waitUntil(() => notes(inside).some((n) => n.params!.content.startsWith('você entrou em #obra')), 10_000, 'the join notice inside')
    const joined = notes(inside).find((n) => n.params!.content.startsWith('você entrou em #obra'))!
    assert.equal(joined.params!.meta.role, 'system')
    assert.equal(joined.params!.meta.from_id, 'tether')
    assert.ok(!joined.params!.content.includes('TETHER_CLI'), 'inside: no CLI hint')
    const outJoin = (await inbox(outside)).find((m) => m.body.startsWith('você entrou em #obra'))!
    assert.ok(outJoin.body.includes('channels say obra'), 'not inside: the CLI hint')
    assert.ok(outJoin.body.includes('elas esperam'), 'wait: told the lines wait')

    const before = notes(inside).length
    const said = await ch.say(owner, id, { body: 'o teste passou', to: ['dentro-par'] })
    assert.ok(said.ok)
    assert.deepEqual(Object.keys(said.receipts).sort(), [inside, outside].sort(), 'the speaker gets nothing')
    assert.equal(said.receipts[inside], 'inside')
    assert.equal(said.receipts[outside], 'queued')
    assert.equal(said.line.from.role, 'owner', 'the record keeps the role in the channel')
    await waitUntil(() => notes(inside).length > before, 10_000, 'the line inside')
    const n = notes(inside).at(-1)!
    assert.equal(n.params!.content, 'o teste passou')
    assert.equal(n.params!.meta.room, 'obra')
    assert.equal(n.params!.meta.origin, 'channels')
    assert.equal(n.params!.meta.kind, 'message')
    assert.equal(n.params!.meta.from, 'dentro-dono')
    assert.equal(n.params!.meta.from_id, owner)
    assert.equal(n.params!.meta.role, 'member', 'the owner speaks as a member (C2)')
    assert.equal(n.params!.meta.to, 'dentro-par')
    assert.equal(n.params!.meta.ref, `obra#${said.line.seq}`)
    assert.ok(events.some((e) => e.name === 'line' && e.payload.line.seq === said.line.seq && e.payload.room === 'obra'), 'the line event')
    assert.ok(events.some((e) => e.name === 'channel' && e.payload.channel.id === id), 'the channel event')

    const reply = await ch.say(USER, id, { body: 'e o README?', replyTo: said.line.seq })
    assert.ok(reply.ok)
    assert.deepEqual(Object.keys(reply.receipts).sort(), [owner, inside, outside].sort())
    await waitUntil(() => notes(owner).some((x) => x.params!.content === 'e o README?'), 10_000, 'the moderator line at the owner')
    const m = notes(owner).find((x) => x.params!.content === 'e o README?')!
    assert.equal(m.params!.meta.role, 'moderator')
    assert.equal(m.params!.meta.from_id, 'user')
    assert.equal(m.params!.meta.from, 'usuário')
    assert.equal(m.params!.meta.reply_to, `obra#${said.line.seq}`)
  })

  test('muted hears and does not speak; unmute gives the voice back', async () => {
    const id = ch.store.findOpen('obra')!.id
    const muted = await ch.mute(owner, id, inside)
    assert.ok(muted.ok && muted.changed)
    await waitUntil(() => notes(inside).some((n) => n.params!.content.startsWith('você foi calado em #obra por dentro-dono')), 10_000, 'the mute notice')
    const refused = await ch.say(inside, id, { body: 'posso?' })
    assert.deepEqual(refused, { ok: false, error: 'muted' })
    const said = await ch.say(owner, id, { body: 'ouve isto' })
    assert.ok(said.ok)
    assert.equal(said.receipts[inside], 'inside', 'muted still hears')
    assert.equal((await ch.mute(USER, id, inside)).ok, true)
    assert.deepEqual(await ch.mute(outside, id, inside), { ok: false, error: 'not-owner' })
    const un = await ch.unmute(USER, id, inside)
    assert.ok(un.ok && un.changed)
    assert.ok((await ch.say(inside, id, { body: 'voltei' })).ok)
    const stranger = await running('fora-estranho')
    assert.deepEqual(await ch.say(stranger, id, { body: 'x' }), { ok: false, error: 'not-member' })
    await doorApi.slots.forget(stranger)
  })

  test('remove and close cancel what waited; the removed one is told apart', async () => {
    const a = await running('fora-tirado')
    const id = await channel(owner, 'tirar')
    await addMember(id, a)
    const said = await ch.say(owner, id, { body: 'espera na fila' })
    assert.ok(said.ok && said.receipts[a] === 'queued')
    const waitingIds = doorApi.delivery.pending(a).map((p) => p.id)
    assert.ok((await inbox(a)).some((m) => m.body === 'espera na fila'))
    const gone = await ch.remove(owner, id, a)
    assert.ok(gone.ok)
    const after = await inbox(a)
    assert.ok(!after.some((m) => m.body === 'espera na fila'), 'the waiting line left the queue')
    assert.ok(after.some((m) => m.body === 'você foi tirado de #tirar por dentro-dono' && m.from.role === 'system'))
    assert.ok(doorApi.delivery.pending(a).length <= waitingIds.length)
    assert.deepEqual(await ch.join(a, id), { ok: false, error: 'removed' }, 'removed does not come back by itself')

    const b = await running('fora-encerrado')
    const id2 = await channel(owner, 'encerrar')
    await addMember(id2, b)
    assert.ok((await ch.say(owner, id2, { body: 'some no fim' })).ok)
    const closed = await ch.close(owner, id2)
    assert.ok(closed.ok)
    const left = await inbox(b)
    assert.ok(!left.some((m) => m.body === 'some no fim'), 'closing cancels what waited')
    assert.ok(left.some((m) => m.body === '#encerrar foi encerrado por dentro-dono'))
    assert.deepEqual(await ch.say(owner, id2, { body: 'x' }), { ok: false, error: 'closed' })
    const reopened = await ch.reopen(USER, id2)
    assert.ok(reopened.ok)
    // The close notice still waited: the reopen joins it in one merged notice (one waiting delivery per member and channel).
    const reopenedFor = (await inbox(b)).filter((m) => m.room === 'encerrar')
    assert.equal(reopenedFor.at(-1)!.body.startsWith('#encerrar: 2 avisos desde'), true, JSON.stringify(reopenedFor))
    assert.ok((await ch.store.history(id2)).some((l) => l.body === '#encerrar foi reaberto por usuário'))
    await doorApi.slots.forget(a)
  })

  test('a forgotten pane leaves every channel by the reverse index', async () => {
    const f = await running('fora-esquecido')
    const c1 = await channel(owner, 'um')
    const c2 = await channel(f, 'dois')
    await addMember(c1, f)
    await addMember(c2, inside)
    assert.equal(ch.store.channelsOf(f).length, 2)
    await doorApi.slots.forget(f)
    await waitUntil(() => ch.store.channelsOf(f).length === 0, 10_000, 'out of every channel')
    await waitUntil(() => events.some((e) => e.name === 'line' && e.payload.channelId === c2 && e.payload.line.event?.type === 'owner-ended'), 10_000, 'owner ended')
    await waitUntil(() => events.some((e) => e.name === 'line' && e.payload.channelId === c1 && e.payload.line.event?.type === 'leave'), 10_000, 'the leave line')
    const l1 = await ch.store.history(c1)
    assert.ok(l1.some((l) => l.body === 'fora-esquecido saiu de #um (a guia foi fechada)'))
    assert.equal(ch.store.get(c2)!.ownerEnded?.why, 'forgotten')
    await waitUntil(() => notes(inside).some((n) => n.params!.content === 'fora-esquecido saiu de #dois (a guia foi fechada)'), 10_000, 'the others told')
  })

  test('the second line with the first pending is the merged notice, with no third-party text; a failed cancel sends the line as it came', async () => {
    const q = await running('fora-fusao')
    const id = await channel(owner, 'fusao')
    await addMember(id, q)
    const base = (await inbox(q)).length
    const s1 = await ch.say(owner, id, { body: 'primeira fala secreta' })
    const s2 = await ch.say(USER, id, { body: 'segunda fala secreta' })
    const s3 = await ch.say(owner, id, { body: 'terceira fala secreta' })
    assert.ok(s1.ok && s2.ok && s3.ok)
    const waiting = (await inbox(q)).slice(base)
    assert.equal(waiting.length, 1, JSON.stringify(waiting))
    const merged = waiting[0]!
    assert.equal(merged.kind, 'notice')
    assert.equal(merged.from.role, 'system')
    assert.ok(!merged.body.includes('secreta'), merged.body)
    assert.equal(merged.body, mergedNotice('fusao', { since: s1.line.seq, at: s1.line.at, messages: 3, notices: 0, speakers: ['dentro-dono'], fromUser: 1 }))
    assert.match(merged.body, /^#fusao: 3 falas novas desde \d\d:\d\d, de dentro-dono \(uma do usuário\); ler: channels read fusao --since \d+$/)

    cancelFails = true
    const s4 = await ch.say(owner, id, { body: 'quarta vai como veio' })
    assert.ok(s4.ok)
    const now = (await inbox(q)).slice(base)
    assert.equal(now.length, 2)
    assert.equal(now[1]!.body, 'quarta vai como veio')
    assert.equal(now[1]!.ref, `fusao#${s4.line.seq}`)

    // Held: what waits is typed, the merged notice and the line, in order.
    await hold(q)
    await waitUntil(() => doorApi.delivery.pending(q).length === 0, 30_000, 'typed once held')
    const typed = chunks(q).join('')
    assert.ok(typed.includes('#fusao: 3 falas novas'), typed)
    assert.ok(!typed.includes('secreta'))
    await doorApi.slots.forget(q)
  })

  test('a member that does not run is away and gets one notice on its return', async () => {
    const d = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'fora-parado', start: false })).slotId
    const id = await channel(owner, 'parado')
    await addMember(id, d)
    const s1 = await ch.say(owner, id, { body: 'enquanto dormia' })
    const s2 = await ch.say(USER, id, { body: 'e mais isto' })
    assert.ok(s1.ok && s2.ok)
    assert.equal(s1.receipts[d], 'away')
    assert.equal(s2.receipts[d], 'away')
    assert.deepEqual(doorApi.delivery.pending(d), [], 'nothing delivered nor queued')
    await doorApi.slots.start(d)
    await waitUntil(() => doorApi.delivery.pending(d).length > 0, 30_000, 'the return notice')
    await sleep(500)
    const got = await inbox(d)
    assert.equal(got.length, 1, JSON.stringify(got))
    assert.equal(got[0]!.kind, 'notice')
    assert.ok(got[0]!.body.startsWith('você voltou · #parado: 2 falas novas'), got[0]!.body)
    assert.ok(got[0]!.body.includes('(uma do usuário)'))
    assert.ok(!got[0]!.body.includes('dormia'))
    // It missed its own join too (the join notice is not delivered to a pane that does not run): counted as a notice.
    const joinLine = (await ch.store.history(id)).find((l) => l.event?.type === 'join' && l.event.who === d)!
    assert.equal(got[0]!.body, returnNotice('parado', { since: joinLine.seq, at: joinLine.at, messages: 2, notices: 1, speakers: ['dentro-dono'], fromUser: 1 }))
    assert.match(got[0]!.body, new RegExp(`^você voltou · #parado: 2 falas novas e 1 aviso desde \\d\\d:\\d\\d, de dentro-dono \\(uma do usuário\\); ler: channels read parado --since ${joinLine.seq - 1}$`))
    // A third line now fuses into the return notice that waits.
    assert.ok((await ch.say(owner, id, { body: 'terceira' })).ok)
    const fused = await inbox(d)
    assert.equal(fused.length, 1)
    assert.ok(fused[0]!.body.startsWith('#parado: 3 falas novas'), fused[0]!.body)
    await doorApi.slots.forget(d)
  })

  const statesOf = (id: string, from: number): SlotState[] => states.slice(from).filter((s) => s.slotId === id)

  test('the done of a turn a line opened goes (attention.seen); waiting stays; a user key in the turn keeps the done', async () => {
    const g = await running('dentro-turno')
    const id = await channel(owner, 'turno')
    await addMember(id, g)
    // A turn a line opened, nobody typed: the done goes.
    let mark = states.length
    let said = await ch.say(owner, id, { body: 'acorda' })
    assert.ok(said.ok && said.receipts[g] === 'inside')
    report(g, 'start')
    await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, 'busy')
    report(g, 'done')
    await waitUntil(() => statesOf(g, mark).some((s) => s.attention === 'done'), 10_000, 'the done edge')
    await waitUntil(() => doorApi.slots.get(g)?.attention === undefined, 10_000, 'the done cleared')

    // waiting is never cleared.
    said = await ch.say(owner, id, { body: 'pede permissão' })
    assert.ok(said.ok)
    report(g, 'start')
    await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, 'busy')
    report(g, 'waiting')
    await waitUntil(() => doorApi.slots.get(g)?.attention === 'waiting', 10_000, 'waiting')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attention, 'waiting', 'waiting stays')
    report(g, 'start')
    report(g, 'done')
    await waitUntil(() => doorApi.slots.get(g)?.turn === undefined, 10_000, 'the turn ended')
    if (doorApi.slots.get(g)?.attention) doorApi.attention.seen(g)

    // The person typed in the turn: the done stays.
    mark = states.length
    said = await ch.say(owner, id, { body: 'outra' })
    assert.ok(said.ok && said.receipts[g] === 'inside')
    report(g, 'start')
    await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, 'busy')
    await sleep(20)
    rec.client.input(g, 'x')
    await waitUntil(() => doorApi.slots.userTypedAt(g) !== undefined, 10_000, 'the user key counted')
    report(g, 'done')
    await waitUntil(() => statesOf(g, mark).some((s) => s.attention === 'done'), 10_000, 'the done edge')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attention, 'done', 'the person typed: the done stays')
    doorApi.attention.seen(g)
    await doorApi.slots.forget(g)
  })

  test('a line taken while busy opens the next turn: its done goes; the turn the person opened keeps its done; her key or a waiting stays', async () => {
    const g = await running('dentro-ocupado')
    const id = await channel(owner, 'ocupado')
    await addMember(id, g)
    const turn = async (what: string): Promise<void> => {
      report(g, 'start')
      await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, `${what}: busy`)
    }
    const finish = async (what: string): Promise<void> => {
      const mark = states.length
      report(g, 'done')
      await waitUntil(() => statesOf(g, mark).some((s) => s.attention === 'done'), 10_000, `${what}: the done edge`)
    }
    const lineWhileBusy = async (body: string): Promise<void> => {
      const said = await ch.say(owner, id, { body })
      assert.ok(said.ok && said.receipts[g] === 'inside', JSON.stringify(said))
    }

    // The person opens a turn by typing; a line comes in the middle of it: her done stays.
    rec.client.input(g, 'x')
    await waitUntil(() => doorApi.slots.userTypedAt(g) !== undefined, 10_000, 'the user key counted')
    await sleep(20)
    await turn('her turn')
    await lineWhileBusy('no meio')
    await finish('her turn')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attention, 'done', 'the turn she opened keeps its done')

    // The agent opens a turn of its own for the line right after: that done goes (the measured defect).
    await turn('the line turn')
    await finish('the line turn')
    await waitUntil(() => doorApi.slots.get(g)?.attention === undefined, 10_000, 'the done of the turn the line opened cleared')

    // A turn nobody's line opened, a line in it, then the line's turn: the person types in that one, so its done stays.
    await turn('a plain turn')
    await lineWhileBusy('outra no meio')
    await finish('a plain turn')
    await turn('the line turn, she types')
    await sleep(20)
    rec.client.input(g, 'y')
    const typed = doorApi.slots.userTypedAt(g)
    await waitUntil(() => doorApi.slots.userTypedAt(g) !== typed, 10_000, 'the second user key counted')
    await finish('the line turn, she types')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attention, 'done', 'she typed in the turn the line opened: the done stays')
    doorApi.attention.seen(g)

    // The line's turn asks for permission: waiting is never cleared.
    await turn('a plain turn')
    await lineWhileBusy('mais uma no meio')
    await finish('a plain turn')
    await turn('the line turn, waiting')
    report(g, 'waiting')
    await waitUntil(() => doorApi.slots.get(g)?.attention === 'waiting', 10_000, 'waiting')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attention, 'waiting', 'waiting stays')
    await doorApi.slots.forget(g)
  })

  test('the desk gestures (F1): open by the desk, owner changes, panes in and out, closed and reopened with the history; no hand close', async () => {
    const p = await running('fora-mesa')
    const shell = (await doorApi.slots.create({ kind: 'shell', cwd: home, start: false })).slotId
    const opened = await ch.desk.open('m1', { name: 'mesa1', title: 'Mesa 1', owner, panes: [owner, p, shell] })
    assert.ok(opened.ok && opened.created && !opened.reopened, JSON.stringify(opened))
    const id = opened.channel.id
    assert.equal(id, 'desk_m1')
    assert.equal(opened.channel.desk, 'm1')
    assert.equal(opened.channel.title, 'Mesa 1')
    assert.deepEqual(opened.channel.owner, { kind: 'agent', id: owner, name: 'dentro-dono' })
    assert.deepEqual(Object.keys(opened.channel.members).sort(), [owner, p].sort(), 'the shell is not a member')
    assert.equal(opened.channel.members[owner]!.by, 'desk')
    assert.equal(opened.channel.members[p]!.by, 'desk')
    assert.equal(opened.line.body, '#mesa1 nasceu com a mesa · owner: dentro-dono')
    assert.ok((await inbox(p)).some((m) => m.room === 'mesa1' && m.body.startsWith('você entrou em #mesa1 (por a mesa) · members: dentro-dono')))
    await waitUntil(() => notes(owner).some((n) => n.params!.content.startsWith('você entrou em #mesa1 (por a mesa)')), 10_000, 'the owner told')
    assert.deepEqual(await ch.desk.open('m1', { name: 'x', title: 'x', owner, panes: [] }), { ok: false, error: 'exists' })
    assert.deepEqual(await ch.close(USER, id), { ok: false, error: 'desk' }, 'never closed by hand')
    assert.deepEqual(await ch.reopen(USER, id), { ok: false, error: 'desk' })

    // Removed: the desk does not bring it back; leaving the desk clears it; coming back joins it.
    assert.ok((await ch.remove(USER, id, p)).ok)
    assert.deepEqual(await ch.desk.enter(id, p), { ok: true, channel: ch.store.get(id), joined: false })
    const out = await ch.desk.exit(id, p)
    assert.ok(out.ok && !out.left)
    assert.equal(ch.store.get(id)!.removed, undefined)
    const back = await ch.desk.enter(id, p)
    assert.ok(back.ok && back.joined && back.line?.body === 'fora-mesa entrou em #mesa1')
    assert.deepEqual(await ch.desk.enter(id, shell), { ok: true, channel: ch.store.get(id), joined: false }, 'a shell never joins')

    // Another owner: it joins and owns; the old one stays a member; the same again is no change.
    const changed = await ch.desk.setOwner(id, inside)
    assert.ok(changed.ok && changed.changed && changed.line?.body === '#mesa1 agora é de dentro-par')
    assert.equal(changed.line.event?.type, 'owner-changed')
    assert.ok(isMember(ch.store.get(id)!, owner) && isMember(ch.store.get(id)!, inside))
    assert.equal(ch.store.get(id)!.owner.kind === 'agent' && (ch.store.get(id)!.owner as { id: string }).id, inside)
    const again = await ch.desk.setOwner(id, inside)
    assert.ok(again.ok && !again.changed && again.line === undefined)
    // The owner never leaves by the desk; a member the desk brought does.
    assert.ok((await ch.desk.exit(id, inside)).ok && isMember(ch.store.get(id)!, inside))
    const oldOut = await ch.desk.exit(id, owner)
    assert.ok(oldOut.ok && oldOut.left && oldOut.line?.body === 'dentro-dono saiu de #mesa1')

    const t = await ch.desk.retitle(id, 'Mesa Um')
    assert.ok(t.ok && t.changed)
    assert.equal(ch.store.get(id)!.name, 'mesa1', 'the name never follows the title')

    // The desk lost its owner: closed by the person, readable; a common channel takes the name; the desk reopens renamed.
    const closed = await ch.desk.close(id, 'revoked')
    assert.ok(closed.ok && closed.changed && closed.line?.body === '#mesa1 foi encerrado: a mesa ficou sem dono')
    assert.equal(ch.store.get(id)!.closed?.by, USER)
    assert.deepEqual(await ch.say(USER, id, { body: 'x' }), { ok: false, error: 'closed' })
    const twice = await ch.desk.close(id, 'gone')
    assert.ok(twice.ok && !twice.changed)
    const lastBefore = await ch.store.lastSeq(id)
    const common = await channel(owner, 'mesa1')
    const re = await ch.desk.open('m1', { name: 'ignored', title: 'Mesa Um', owner, panes: [p] })
    assert.ok(re.ok && re.reopened && !re.created, JSON.stringify(re))
    assert.equal(re.channel.name, 'mesa1-2')
    assert.equal(re.line.body, '#mesa1-2 foi reaberto: a mesa é de dentro-dono (antes #mesa1; o nome estava tomado)')
    assert.ok(re.line.seq > lastBefore, 'the same history goes on')
    assert.ok((await ch.store.history(id)).some((l) => l.body === '#mesa1 nasceu com a mesa · owner: dentro-dono'))
    assert.ok(isMember(re.channel, owner) && isMember(re.channel, p))
    assert.equal(re.channel.ownerEnded, undefined)
    assert.deepEqual(await ch.desk.setOwner(common, owner), { ok: false, error: 'bad-request' }, 'only a desk channel')
    await doorApi.slots.forget(p)
    await doorApi.slots.forget(shell)
  })

  test('a commanded pane (attentionFor) is not touched', async () => {
    const g = await running('dentro-comandada')
    const id = await channel(owner, 'comandada')
    await addMember(id, g)
    await doorApi.attention.route(g, owner)
    const said = await ch.say(owner, id, { body: 'para a comandada' })
    assert.ok(said.ok && said.receipts[g] === 'inside')
    report(g, 'start')
    await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, 'busy')
    report(g, 'done')
    await waitUntil(() => doorApi.slots.get(g)?.attentionFor?.value === 'done', 10_000, 'the done goes to the owner')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attentionFor?.value, 'done', 'left for the owner')
    // A line while busy, then the turn it opens: still left for the owner.
    report(g, 'start')
    await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, 'busy')
    const busySaid = await ch.say(owner, id, { body: 'no meio, comandada' })
    assert.ok(busySaid.ok && busySaid.receipts[g] === 'inside')
    const mark = states.length
    report(g, 'done')
    await waitUntil(() => statesOf(g, mark).some((s) => s.turn === undefined), 10_000, 'the turn ended')
    report(g, 'start')
    await waitUntil(() => doorApi.slots.get(g)?.turn === 'busy', 10_000, 'the line turn')
    report(g, 'done')
    await waitUntil(() => doorApi.slots.get(g)?.attentionFor?.value === 'done', 10_000, 'the done goes to the owner')
    await sleep(800)
    assert.equal(doorApi.slots.get(g)?.attentionFor?.value, 'done', 'the line turn of a commanded pane: left for the owner')
    await doorApi.attention.unroute(g)
    await doorApi.slots.forget(g)
  })
})
