// The desk channel following its desk (extensions/channels/daemon/desk-channel.ts, slice F1) in a real tetherd on a test home
// and test pipe: the real desk map (`desk-map` over the pipe), the real door objects of for-agents feeding a desk owner feed
// through bindDeskOwners (the for-agents side of F0), the real store and the fan-out. The agents are fake `claude` slots
// (test/fixtures/channels/agent.cjs). No real agent; the user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorApi } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import type { DeskMap, DeskMapDesk } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { bindDeskOwners, createDeskOwnerFeed, type DeskOwnerPublisher } from '../../extensions/for-agents/desk-owners.ts'
import { wireDeskChannels } from '../../extensions/channels/daemon/desk-channel.ts'
import { createChannels, type Channels, type ChannelsApi, type LineEvent } from '../../extensions/channels/daemon/fanout.ts'
import { openStore, type ChannelStore } from '../../extensions/channels/daemon/store.ts'
import { agentOwnerOf, deskChannelId, isMember, USER, type Channel } from '../../extensions/channels/rules.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))

describe('the desk channel (F1)', () => {
  let home: string
  let pipe: string
  let daemon: Daemon
  let rec: Recorder
  let door: DoorHost
  const own = new DisposableStore()
  let doorApi: DoorApi
  let forAgents: DoorApi
  let ch: Channels
  let feed: DeskOwnerPublisher
  let binding: { dispose(): void }[] = []
  const logs: string[] = []
  /** Every channel id the desk channel asked the store for, and how many times it listed every channel. */
  const asked = new Set<string>()
  let listed = 0
  const lines: LineEvent[] = []

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = '0'
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

  const bind = (): void => { binding = bindDeskOwners(forAgents.objects, feed) }
  const unbind = (): void => { for (const d of binding) d.dispose(); binding = [] }
  /** The desk channel's wiring; a new one is the desk channel after the tetherd restarts (nothing seen, the store on disk). */
  let wiring: { dispose(): void }[] = []
  let store: ChannelStore
  const rewire = (): void => {
    for (const d of wiring) d.dispose()
    wiring = wireDeskChannels({ desks: doorApi.desks, slots: doorApi.slots, log: (m) => logs.push(m) }, Promise.resolve({ ...ch, store }), feed)
  }

  before(async () => {
    home = tempHome()
    pipe = uniquePipe(home)
    door = new DoorHost({ log: (m) => logs.push(m) })
    daemon = await startDaemon({
      home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
      log: (m) => logs.push(m), onSlot: (kind, slot) => { if (kind === 'removed') void ch?.forgotten(slot.slotId) },
    })
    rec = await Recorder.connect(daemon.pipe)
    doorApi = door.apiFor('channels', own)
    forAgents = door.apiFor('for-agents', own)
    own.add(doorApi.delivery.enable())
    const api: ChannelsApi = {
      slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery,
      events: { emit: (name, payload) => { if (name === 'line') lines.push(JSON.parse(JSON.stringify(payload)) as LineEvent) } }, settings: { get: () => undefined }, log: (m) => logs.push(m),
    }
    ch = createChannels(api, await openStore(fsIo, home))
    // The desk channel sees the store through a counter: it proves which channels it looks at.
    const real = ch.store
    store = { ...real, get: (id) => { asked.add(id); return real.get(id) }, channels: () => { listed++; return real.channels() } }
    feed = createDeskOwnerFeed()
    bind()
    rewire()
  })
  after(async () => {
    unbind()
    for (const d of wiring) d.dispose()
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
    await waitUntil(() => doorApi.slots.get(id)?.status === 'running', 30_000, `${name} running`)
    return id
  }
  const desks: Record<string, DeskMapDesk> = {}
  const deskOf = (id: string, name: string, panes: string[], kind: 'queue' | 'system' = 'queue'): DeskMapDesk =>
    ({ id, name, kind, panes: panes.map((p) => ({ id: p, type: 'terminal' })) })
  async function sendMap(): Promise<void> {
    const map: DeskMap = { desks: Object.values(desks), drawer: [] }
    await rec.client.request({ t: 'desk-map', map })
    await waitUntil(() => JSON.stringify(doorApi.desks.map()) === JSON.stringify(map), 5000, 'the map')
  }
  let tick = Date.parse('2026-11-22T10:00:00Z')
  const give = (deskId: string, owner: string): Promise<void> =>
    forAgents.objects.set('desk', deskId, 'owner', { owner, since: new Date(Math.max(++tick, Date.now())).toISOString(), givenBy: 'user' })
  const revoke = (deskId: string): Promise<void> => forAgents.objects.set('desk', deskId, 'owner', undefined)
  const channelOf = (deskId: string): Channel | undefined => ch.store.get(deskChannelId(deskId))
  const until = (what: string, ok: (c: Channel | undefined) => boolean, deskId = 'd1'): Promise<void> =>
    waitUntil(() => ok(channelOf(deskId)), 10_000, what)
  const bodies = async (deskId = 'd1'): Promise<string[]> => lines.filter((e) => e.channelId === deskChannelId(deskId)).map((e) => e.line.body)
  const lastSeq = async (deskId = 'd1'): Promise<number> =>
    Math.max(0, ...lines.filter((e) => e.channelId === deskChannelId(deskId)).map((e) => e.line.seq))
  /**
   * Waits for the line `body` after seq `after`, by the `line` events (reading the history while a gesture runs would race
   * it): the gesture that writes the line has done its structure first.
   */
  const said = (body: string, deskId = 'd1', after = 0): Promise<void> =>
    waitUntil(() => lines.some((e) => e.channelId === deskChannelId(deskId) && e.line.seq > after && e.line.body === body), 10_000,
      `the line "${body}" in ${deskId}: ${JSON.stringify(lines.filter((e) => e.channelId === deskChannelId(deskId)).map((e) => e.line.body))}`)

  let owner: string
  let other: string
  let pane: string
  let shell: string

  test('the desk gets an owner: the channel is born, named by the slug of the desk (C14), owner and agent panes by the desk; no shell', async () => {
    owner = await running('dono')
    other = await running('outro')
    pane = await running('guia')
    shell = (await doorApi.slots.create({ kind: 'shell', cwd: home, start: false })).slotId
    desks.d1 = deskOf('d1', 'Obra Nova', [owner, other, pane, shell])
    await sendMap()
    await sleep(100)
    assert.equal(channelOf('d1'), undefined, 'no owner, no channel')
    await give('d1', owner)
    await said('#obra-nova nasceu com a mesa · owner: dono')
    const c = channelOf('d1')!
    assert.equal(c.name, 'obra-nova')
    assert.equal(c.title, 'Obra Nova')
    assert.equal(c.desk, 'd1')
    assert.equal(agentOwnerOf(c), owner)
    assert.deepEqual(Object.keys(c.members).sort(), [owner, other, pane].sort(), 'the shell is not a member')
    for (const m of Object.values(c.members)) assert.equal(m.by, 'desk')
  })

  test('the desk passes to another owner: the owner changes, the old one stays a member', async () => {
    await give('d1', other)
    await said('#obra-nova agora é de outro')
    assert.equal(agentOwnerOf(channelOf('d1')!), other)
    assert.ok(isMember(channelOf('d1')!, owner))
  })

  test('revoked: closed by the person and readable; given again (another owner) the same channel reopens with its history', async () => {
    const lines = (await bodies()).length
    await revoke('d1')
    await said('#obra-nova foi encerrado: a mesa ficou sem dono')
    assert.equal(channelOf('d1')!.closed!.by, USER)
    assert.deepEqual(await ch.reopen(USER, deskChannelId('d1')), { ok: false, error: 'desk' }, 'not by hand (C17)')
    await give('d1', owner)
    await said('#obra-nova foi reaberto: a mesa é de dono')
    const c = channelOf('d1')!
    assert.equal(c.closed, undefined)
    assert.equal(agentOwnerOf(c), owner)
    assert.equal(c.name, 'obra-nova')
    const now = await bodies()
    assert.ok(now.length > lines + 1, 'the history goes on')
    assert.equal(now.at(-1), '#obra-nova foi reaberto: a mesa é de dono')
  })

  test('the desk renamed: the title follows, the name stays', async () => {
    desks.d1 = { ...desks.d1!, name: 'Obra Velha' }
    await sendMap()
    await until('title', (c) => c!.title === 'Obra Velha')
    assert.equal(channelOf('d1')!.name, 'obra-nova')
  })

  test('the owner removed from the channel: it stays open, the person commands; the same owner given again joins and owns', async () => {
    assert.ok((await ch.remove(USER, deskChannelId('d1'), owner)).ok)
    await sleep(200)
    let c = channelOf('d1')!
    assert.equal(c.closed, undefined)
    assert.equal(agentOwnerOf(c), undefined, 'the person commands')
    assert.ok(c.removed?.includes(owner))
    const from = await lastSeq()
    await give('d1', owner)
    await said('#obra-nova agora é de dono', 'd1', from)
    c = channelOf('d1')!
    assert.equal(agentOwnerOf(c), owner)
    assert.ok(isMember(c, owner))
    assert.ok(!c.removed?.includes(owner))
  })

  test('for-agents off: the channels stay as they are; on again, one pass reconciles', async () => {
    unbind()
    assert.equal(feed.active, false)
    await revoke('d1')
    desks.d1 = { ...desks.d1!, name: 'Obra Desligada' }
    await sendMap()
    await sleep(300)
    let c = channelOf('d1')!
    assert.equal(c.closed, undefined, 'nothing follows while off')
    assert.equal(c.title, 'Obra Velha')
    // Another desk, owned, so the activation has something to publish.
    desks.d2 = deskOf('d2', 'Obra', [])
    await sendMap()
    await give('d2', other)
    await sleep(200)
    assert.equal(channelOf('d2'), undefined, 'nothing is born while off')
    const from = await lastSeq()
    bind()
    await said('#obra-nova foi encerrado: a mesa ficou sem dono', 'd1', from)
    await said('#obra nasceu com a mesa · owner: outro', 'd2')
    assert.equal(channelOf('d2')!.name, 'obra')
  })

  test('a name taken by a common channel gets the suffix (C14)', async () => {
    const made = await ch.create(USER, { name: 'praca' })
    assert.ok(made.ok)
    desks.d3 = deskOf('d3', 'Praça', [pane])
    await sendMap()
    await give('d3', pane)
    await said('#praca-2 nasceu com a mesa · owner: guia', 'd3')
    assert.equal(channelOf('d3')!.name, 'praca-2')
    assert.equal(channelOf('d3')!.title, 'Praça')
  })

  test('the desk closed (gone from the map): the channel is closed', async () => {
    delete desks.d3
    await sendMap()
    await said('#praca-2 foi encerrado: a mesa foi fechada', 'd3')
    assert.equal(channelOf('d3')!.closed!.by, USER)
  })

  test('the owner forgotten (ended): the channel is closed by the person', async () => {
    const gone = await running('esquecido')
    desks.d4 = deskOf('d4', 'Quarta', [gone, other])
    await sendMap()
    await give('d4', gone)
    await said('#quarta nasceu com a mesa · owner: esquecido', 'd4')
    // for-agents marks the ownership ended when the owner's pane is forgotten.
    await doorApi.slots.forget(gone)
    await forAgents.objects.set('desk', 'd4', 'owner', { owner: gone, since: new Date().toISOString(), givenBy: 'user', ended: { at: new Date().toISOString(), name: 'esquecido' } })
    await said('#quarta foi encerrado: a guia dona da mesa foi fechada', 'd4')
    assert.equal(channelOf('d4')!.closed!.by, USER)
    assert.equal(channelOf('d4')!.ownerEnded?.why, 'forgotten')
  })

  test('a system desk has no channel', async () => {
    desks.sys = deskOf('sys', 'Sistema', [other], 'system')
    await sendMap()
    await give('sys', other)
    await sleep(300)
    assert.equal(channelOf('sys'), undefined)
  })

  test('the panes follow the desk: in joins, out leaves if the desk brought it; removed stays out until it leaves the desk; by hand stays', async () => {
    const outsider = await running('de-fora')
    const a = await running('movel')
    const b = await running('tirada')
    const hand = await running('a-mao')
    const id = deskChannelId('d5')
    desks.d5 = deskOf('d5', 'Quinta', [a])
    await sendMap()
    await give('d5', outsider)
    await said('#quinta nasceu com a mesa · owner: de-fora', 'd5')
    assert.deepEqual(Object.keys(channelOf('d5')!.members).sort(), [outsider, a].sort(), 'the owner from outside the desk joins too')

    desks.d5 = deskOf('d5', 'Quinta', [a, b])
    await sendMap()
    await said('tirada entrou em #quinta', 'd5')
    assert.equal(channelOf('d5')!.members[b]!.by, 'desk')

    desks.d5 = deskOf('d5', 'Quinta', [b])
    await sendMap()
    await said('movel saiu de #quinta', 'd5')
    assert.ok(!isMember(channelOf('d5')!, a))
    assert.ok(isMember(channelOf('d5')!, outsider), 'the owner never leaves by the desk')

    // Joined by hand: it stays whatever the desk does.
    assert.ok((await ch.join(USER, id, hand)).ok)
    desks.d5 = deskOf('d5', 'Quinta', [b, hand])
    await sendMap()
    desks.d5 = deskOf('d5', 'Quinta', [b])
    await sendMap()
    await sleep(200)
    assert.equal(channelOf('d5')!.members[hand]?.by, USER, 'by hand stays')

    // Removed: the desk does not bring it back; out of the desk and in again, it joins.
    assert.ok((await ch.remove(USER, id, b)).ok)
    desks.d5 = deskOf('d5', 'Quinta Feira', [b])
    await sendMap()
    await until('title', (x) => x!.title === 'Quinta Feira', 'd5')
    await sleep(200)
    assert.ok(!isMember(channelOf('d5')!, b) && channelOf('d5')!.removed?.includes(b))
    desks.d5 = deskOf('d5', 'Quinta Feira', [])
    await sendMap()
    await until('out of removed', (x) => !x!.removed?.includes(b), 'd5')
    const from = await lastSeq('d5')
    desks.d5 = deskOf('d5', 'Quinta Feira', [b])
    await sendMap()
    await said('tirada entrou em #quinta', 'd5', from)

    // Another owner: the old one, outside the desk, stays a member.
    await give('d5', b)
    await said('#quinta agora é de tirada', 'd5')
    desks.d5 = deskOf('d5', 'Quinta Feira', [b, hand])
    await sendMap()
    await sleep(200)
    assert.ok(isMember(channelOf('d5')!, outsider))

    // for-agents off: a pane coming in is not followed; on again, the pass brings it.
    unbind()
    desks.d5 = deskOf('d5', 'Quinta Feira', [b, hand, a])
    await sendMap()
    await sleep(300)
    assert.ok(!isMember(channelOf('d5')!, a), 'nothing follows while off')
    const off = await lastSeq('d5')
    bind()
    await said('movel entrou em #quinta', 'd5', off)

    // Closed, a pane leaves the desk; reopened, the members are the desk's then.
    await revoke('d5')
    await said('#quinta foi encerrado: a mesa ficou sem dono', 'd5')
    desks.d5 = deskOf('d5', 'Quinta Feira', [b, hand])
    await sendMap()
    const closed = await lastSeq('d5')
    await give('d5', b)
    await said('#quinta foi reaberto: a mesa é de tirada', 'd5', closed)
    await said('movel saiu de #quinta', 'd5', closed)
    assert.ok(isMember(channelOf('d5')!, b) && isMember(channelOf('d5')!, hand))
  })

  test('no sweep: only the channels of desks with an owner or an open desk channel are looked at, every channel listed once', async () => {
    const desksSeen = new Set([...asked].map((id) => id.replace(/^desk_/, '')))
    for (const d of desksSeen) assert.ok(['d1', 'd2', 'd3', 'd4', 'd5', 'sys'].includes(d), d)
    assert.ok(![...asked].some((id) => id.startsWith('c_')), 'no common channel is looked at')
    assert.equal(listed, 1, 'every channel listed only at the start')
    // A desk with no owner and no channel: a map change does not look at it.
    asked.clear()
    desks.d9 = deskOf('d9', 'Sem dono', [pane])
    await sendMap()
    await sleep(200)
    assert.ok(!asked.has(deskChannelId('d9')))
    assert.equal(channelOf('d9'), undefined)
  })

  test('the tetherd restarted: the first pass takes no member the desk brought out (in the desk, or the old owner from outside)', async () => {
    const outsider = await running('antigo')
    const p = await running('sexta-a')
    const q = await running('sexta-b')
    desks.d6 = deskOf('d6', 'Sexta', [p, q])
    await sendMap()
    await give('d6', outsider)
    await said('#sexta nasceu com a mesa · owner: antigo', 'd6')
    await give('d6', p)
    await said('#sexta agora é de sexta-a', 'd6')
    assert.equal(channelOf('d6')!.members[outsider]?.by, 'desk', 'the old owner from outside stays a member by the desk')
    const from = await lastSeq('d6')
    rewire()
    desks.d6 = deskOf('d6', 'Sexta Feira', [p, q])
    await sendMap()
    await until('title', (x) => x!.title === 'Sexta Feira', 'd6')
    await sleep(300)
    const c = channelOf('d6')!
    assert.deepEqual(lines.filter((e) => e.channelId === deskChannelId('d6') && e.line.seq > from).map((e) => e.line.body), [], 'no line: nobody left')
    assert.ok(isMember(c, q), 'the pane in the desk stays')
    assert.ok(isMember(c, outsider), 'the old owner from outside stays, as before the restart')
  })
})
