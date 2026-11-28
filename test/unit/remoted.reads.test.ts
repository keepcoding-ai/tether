// RR3 step 3.4a: the portal's reads of tetherd's extensions (PIPE_REACH class `ext-read`). Proved here:
// - pipeReads (src/remoted/reads.ts) sends only a pair of EXT_READS, exactly as listed, under its ceilings;
// - each pair only READS on the real daemon halves: run as the `remote` client, the record on disk and the kept tree do
//   not change, while the writes of the same extensions refuse that client;
// - a real House (remoted.house-bench.ts) serves channels.marks, channels.page and regency.tree through the projectors,
//   rebuilds the arguments from the strict body, refuses without the scope, answers the ceilings, audits no read, and
//   pushes the thin notices (channels.changed, regency.changed) only to the sessions that read, paced by ReadFeeds;
// - the canary: a marker in every field tetherd might answer beyond the allowed ones is in no reply, no event and no
//   byte that crossed the relay.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { OP_CODES, RES_STATUS, toHex } from '../../src/remote/index.ts'
import { PAGE_LINES_MAX, READ_BODY_MAX } from '../../src/remote/projection.ts'
import { CHANNELS_NOTICE_GAP_MS, ReadFeeds, REGENCY_NOTICE_GAP_MS } from '../../src/remoted/feeds.ts'
import { EXT_READS, type ExtReadOp } from '../../src/remoted/gate.ts'
import { pipeReads, ReadError, SharedRead, type ExtRequestFn, type PipeReads } from '../../src/remoted/reads.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { activateWith } from '../../extensions/regency/daemon.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { until, type DeviceSession } from './remoted.helpers.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const MARKER = `canary${randomBytes(12).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const ISO = '2026-11-27T10:00:00.000Z'
const later = (): Record<string, unknown> => ({ variables: { LATER: MARKER }, argv: ['--token', MARKER], env: { GITHUB_TOKEN: MARKER }, cwd: `C:/${MARKER}` })

const homes: string[] = []
after(async () => { for (const h of homes) await fsIo.rm(h) })
async function newHome(): Promise<string> {
  const home = await mkdtemp(join(process.env.TETHER_BENCH_DIR ?? tmpdir(), 'tether-remoted-reads-'))
  homes.push(home)
  return home
}

/** Every file under `dir`, with its bytes: what a request that writes would change. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const p = join(e.parentPath, e.name)
    out.set(p, (await readFile(p)).toString('base64'))
  }
  return out
}

describe('pipeReads: the one place of the portal that sends ext-request', () => {
  test('a read sends exactly the pair of its line, with the arguments the house built, and gives back the result', async () => {
    const sent: unknown[] = []
    const reads = pipeReads(async (b) => { sent.push(b); return { result: { ok: b.name } } })
    for (const [op, pair] of Object.entries(EXT_READS)) {
      assert.deepEqual(await reads.read(op as ExtReadOp, { channel: 'c_1' }), { ok: pair.name })
      assert.deepEqual(sent.at(-1), { t: 'ext-request', ext: pair.ext, name: pair.name, args: { channel: 'c_1' } })
    }
  })

  test('a name outside the list is refused before the pipe', async () => {
    let calls = 0
    const reads = pipeReads(async () => { calls++; return {} })
    for (const op of ['device.revoke', 'say', '__proto__', 'constructor', 'channels.say'])
      await assert.rejects(reads.read(op as ExtReadOp, {}), (e: unknown) => e instanceof ReadError && e.why === 'refused')
    assert.equal(calls, 0, 'nothing reached the pipe')
  })

  test('the ceilings: reads in flight for the whole portal, and the time a read may take (its slot held until tetherd answers)', async () => {
    const hold: (() => void)[] = []
    const request: ExtRequestFn = () => new Promise((res) => { hold.push(() => res({ result: {} })) })
    const reads = pipeReads(request, { max: 2, timeoutMs: 50 })
    const a = reads.read('channels.marks', {})
    const b = reads.read('regency.tree', {})
    await assert.rejects(reads.read('channels.marks', {}), (e: unknown) => e instanceof ReadError && e.why === 'limit')
    await assert.rejects(a, (e: unknown) => e instanceof ReadError && e.why === 'timeout')
    await assert.rejects(b, (e: unknown) => e instanceof ReadError && e.why === 'timeout')
    await assert.rejects(reads.read('channels.marks', {}), (e: unknown) => e instanceof ReadError && e.why === 'limit', 'given up, still held: tetherd has not answered')
    for (const h of hold.splice(0)) h()
    await new Promise((r) => setImmediate(r))
    const c = reads.read('channels.marks', {})
    hold.shift()!()
    assert.deepEqual(await c, {})
  })

  test("tetherd's refusal keeps its code; any other failure is `failed`", async () => {
    const refused = pipeReads(async () => { throw new DaemonError('unknown-channel' as never, 'não há canal com esse id') })
    await assert.rejects(refused.read('channels.page', {}), (e: unknown) => e instanceof ReadError && e.why === 'refused' && e.code === 'unknown-channel')
    const broken = pipeReads(async () => { throw new Error('conexão com o tetherd fechada') })
    await assert.rejects(broken.read('channels.page', {}), (e: unknown) => e instanceof ReadError && e.why === 'failed')
  })

  test('SharedRead: one request at a time, the answer kept for its time, never an answer started before an invalidation', async () => {
    let now = 0
    let asked = 0
    let inFlight = 0
    let peak = 0
    const hold: (() => void)[] = []
    const shared = new SharedRead(() => { asked++; inFlight++; peak = Math.max(peak, inFlight); return new Promise<number>((res) => { hold.push(() => { inFlight--; res(asked) }) }) }, { ttlMs: 100, now: () => now })
    const a = [shared.get(), shared.get(), shared.get()]
    await until(() => hold.length === 1 || undefined, 1_000, 'one at tetherd')
    shared.invalidate()
    const late = shared.get()
    await new Promise((r) => setImmediate(r))
    assert.equal(asked, 1, 'the read after the change waits for the one in flight')
    hold.shift()!()
    assert.deepEqual(await Promise.all(a), [1, 1, 1])
    await until(() => hold.length === 1 || undefined, 1_000, 'then it asks again')
    hold.shift()!()
    assert.equal(await late, 2, 'the request after the change got the answer asked after it')
    assert.equal(peak, 1, 'never two at tetherd')
    assert.equal(await shared.get(), 2, 'kept')
    now = 100
    const again = shared.get()
    await until(() => hold.length === 1 || undefined, 1_000, 'past its time')
    hold.shift()!()
    assert.equal(await again, 3)
    let fail = true
    const flaky = new SharedRead(async () => { if (fail) throw new ReadError('timeout'); return 'ok' })
    await assert.rejects(flaky.get())
    fail = false
    assert.equal(await flaky.get(), 'ok', 'a failure is not kept')
  })

  test("no other file of the portal names ext-request: the class has two doors, the reads and the writes", async () => {
    for (const f of await readdir(join(ROOT, 'src', 'remoted'))) {
      // reach.ts classifies ext-request (the table tetherd enforces too); it sends nothing.
      if (!f.endsWith('.ts') || f === 'reads.ts' || f === 'writes.ts' || f === 'gate.ts' || f === 'reach.ts') continue
      const src = (await readFile(join(ROOT, 'src', 'remoted', f), 'utf8')).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      assert.equal(/ext-request/.test(src), false, `${f} names ext-request`)
    }
  })
})

describe('each pair of EXT_READS only reads, on the real daemon halves', () => {
  test('channels: marks and history as the `remote` client change nothing on disk; the writes refuse that client', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, { now: () => new Date(ISO) })
    const made = await store.create({ name: 'obra', owner: { kind: 'user' }, createdBy: USER })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await store.join(id, 'a1b2c3d4', 'conferente', 'user')).ok)
    for (let i = 0; i < 5; i++) await store.append(id, { kind: 'message', from: { id: 'a1b2c3d4', name: 'conferente', role: 'member' }, body: `fala ${i}`, to: ['usuário'] })
    await store.flush()
    const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<unknown>>()
    const api = { requests: { handle: (name: string, fn: (args: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, fn); return { dispose: () => {} } } } }
    const channels = { store, nameOf: (who: string) => (who === USER ? 'usuário' : who) }
    const disposables = registerChannelRequests(api as never, Promise.resolve(channels as never), 1)
    const before = await snapshot(home)
    const remote = { client: 'remote' }
    for (const pair of Object.values(EXT_READS).filter((p) => p.ext === 'channels')) {
      const fn = handlers.get(pair.name)
      assert.ok(fn, `tetherd answers ${pair.name}`)
      await fn({ channel: id, limit: PAGE_LINES_MAX }, remote)
    }
    await new Promise((r) => setTimeout(r, 20))
    await store.flush()
    assert.deepEqual(await snapshot(home), before, 'the record on disk is the same byte for byte')
    for (const w of ['close', 'create', 'poll-close'])
      await assert.rejects(handlers.get(w)!({ channel: id, text: 'x', seq: 1, reaction: 'agree' }, remote), (e: unknown) => (e as { code?: string }).code === 'not-moderator', `${w} refuses remote`)
    for (const d of disposables) d.dispose()
  })

  test('regency: tree.read as the `remote` client keeps the tree as it was; tree.publish refuses that client', async () => {
    const handlers = new Map<string, (args: unknown, ctx: unknown) => unknown>()
    const api = {
      requests: { handle: (name: string, fn: (args: unknown, ctx: unknown) => unknown) => { handlers.set(name, fn); return { dispose: () => {} } } },
      slots: { list: () => [] }, desks: { map: () => undefined }, events: { emit: () => {} },
    }
    const { keeper, disposables } = activateWith(api as never, { setTimer: () => 0, clearTimer: () => {} })
    keeper.publish({ tree: { desks: { desks: [] }, owners: { desk: {}, pane: {} }, channels: [], channelMarks: {}, agents: [], since: {}, collapsed: [] } }, { client: 'app' })
    const kept = structuredClone(keeper.kept)
    const pair = EXT_READS['regency.tree']
    const read = handlers.get(pair.name)!(undefined, { client: 'remote' }) as { live: boolean; sig?: string }
    assert.equal(read.live, true)
    assert.deepEqual(keeper.kept, kept, 'reading kept the tree, its time and its lease')
    assert.throws(() => handlers.get('tree.publish')!({ sig: kept!.sig }, { client: 'remote' }), (e: unknown) => (e as { code?: string }).code === 'door-denied')
    for (const d of disposables) d.dispose()
  })
})

describe('ReadFeeds: thin notices, paced, never lost', () => {
  test('channels: the ids that changed, then `all` past the ceiling; a change inside the gap waits for the next take', () => {
    const f = new ReadFeeds()
    assert.equal(f.takeChannels(0), undefined, 'nothing changed')
    f.extEvent('channels', 'line', { channelId: 'c_1', room: 'obra', line: { body: MARKER } })
    f.extEvent('channels', 'channel', { channel: { id: 'c_2', name: MARKER } })
    f.extEvent('channels', 'typing', { channelId: 'c_3' })
    f.extEvent('other', 'line', { channelId: 'c_4' })
    f.extEvent('channels', 'seen', { channelId: 'c_5', seenByUser: 9 })
    assert.deepEqual(f.takeChannels(10_000), { channels: ['c_1', 'c_2', 'c_5'] })
    f.extEvent('channels', 'reaction', { channelId: 'c_1' })
    assert.equal(f.takeChannels(10_000 + CHANNELS_NOTICE_GAP_MS - 1), undefined, 'inside the gap')
    assert.deepEqual(f.takeChannels(10_000 + CHANNELS_NOTICE_GAP_MS), { channels: ['c_1'] }, 'and right after it')
    for (let i = 0; i < 40; i++) f.extEvent('channels', 'poll', { channelId: `c_${i}` })
    assert.deepEqual(f.takeChannels(60_000), { channels: [], all: true })
    f.extEvent('channels', 'line', { channelId: 'bad id' })
    assert.deepEqual(f.takeChannels(120_000), { channels: [], all: true }, 'an odd id says `all`, never the id')
  })

  test('regency: tree.changed by signature, time and liveness; the slots count only while the app does not publish', () => {
    const f = new ReadFeeds()
    f.slotsChanged()
    assert.deepEqual(f.takeRegency(0), { live: false }, 'nothing known yet: the floor may have changed')
    f.sawTree({ live: true, sig: '0123456789abcdef' })
    f.slotsChanged()
    assert.equal(f.takeRegency(REGENCY_NOTICE_GAP_MS), undefined, 'the app publishes: its own tree says what changed')
    f.extEvent('regency', 'tree.changed', { sig: 'fedcba9876543210', at: 77, live: false, tree: MARKER })
    assert.deepEqual(f.takeRegency(REGENCY_NOTICE_GAP_MS), { live: false, sig: 'fedcba9876543210', asOf: 77 })
    f.slotsChanged()
    assert.equal(f.takeRegency(REGENCY_NOTICE_GAP_MS + 1), undefined, 'inside the gap')
    assert.deepEqual(f.takeRegency(2 * REGENCY_NOTICE_GAP_MS), { live: false, sig: 'fedcba9876543210', asOf: 77 })
  })
})

// ---- the three reads through a real House ------------------------------------------------------------------------

/** What a hostile tetherd might answer: the allowed fields, and a marker in every field it might add or must keep home. */
const ANSWERS: Record<ExtReadOp, unknown> = {
  'channels.marks': {
    channels: [{ channel: 'c_1', name: 'obra', unread: 2, toMe: 1, seen: 3, asks: 0, owed: 0, firstCall: { why: 'to-you', text: 'conferente: oi' }, members: ['a1b2c3d4', 'user'], ...later() }],
    moderator: { name: 'Guga', ...later() }, ...later(),
  },
  'channels.page': {
    channel: { id: 'c_1', name: 'obra', title: `Obra em C:\\Users\\${MARKER}`, members: 1, seenByUser: 3, createdAt: ISO, ...later() },
    lines: [{ seq: 5, at: ISO, kind: 'message', from: { id: 'a1b2c3d4', name: 'conferente', role: 'member' }, body: 'oi', files: [{ name: 'a.txt', path: `C:/Users/${MARKER}/a.txt`, size: 3, type: 'text/plain' }], ...later() }],
    reactions: [], polls: [], more: true, last: 5,
    members: [{ id: 'a1b2c3d4', name: `conferente em /mnt/c/Users/${MARKER}/obra`, muted: true, since: ISO, by: MARKER, alive: true, path: 'inside', ...later() }],
    moderator: { name: 'Guga', ...later() }, ...later(),
  },
  'regency.tree': {
    input: {
      desks: { desks: [
        { id: 'desk-1', name: 'Mesa', color: 'blue', kind: 'queue', asleep: false, panes: [{ id: 'a1', type: 'agent', icon: 'claude', title: 'Agente', lines: [`revisa C:\\Users\\${MARKER}\\obra‮`, 'Esperando você'], ...later() }] },
        // RR3 gate B-4: titles carry the machine's paths (a session titled by its folder, a browser tab on a file).
        { id: 'desk-2', name: `C:/Users/${MARKER}/obra`, color: 'blue', kind: 'queue', asleep: false, panes: [
          { id: 'a2', type: 'terminal', icon: 'terminal', title: `C:\\Users\\${MARKER}\\tether` },
          { id: 'b1', type: 'browser', icon: 'browser', title: `file:///C:/Users/${MARKER}/docs/plano.html` },
          // RR3 final gate B-2: the same home as Git Bash, WSL and a lowercase mount name it.
          { id: 'a3', type: 'terminal', icon: 'terminal', title: `rodando em /c/Users/${MARKER}/proj` },
          { id: 'a4', type: 'terminal', icon: 'terminal', title: `/mnt/c/Users/${MARKER}/proj` },
          { id: 'a5', type: 'terminal', icon: 'terminal', title: `/users/${MARKER}/proj` },
          { id: 'a6', type: 'terminal', icon: 'terminal', title: `c:\\users\\${MARKER}\\proj` },
        ] },
      ] },
      owners: { desk: {}, pane: {} },
      channels: [{ id: 'c_1', name: 'obra', title: `/home/${MARKER}/obra`, owner: { kind: 'user' }, members: 1, seenByUser: 0, createdAt: ISO }],
      channelMarks: { c_1: { unread: 1, toMe: 1, asks: 0, owed: 0, first: { why: 'to-you', text: 'conferente: oi' } } },
      agents: [{ id: 'a2', kind: 'claude', name: `C:\\Users\\${MARKER}\\tether` }], since: {}, collapsed: [MARKER], query: MARKER,
      closed: [{ slotId: 's9', kind: 'claude', name: 'claude', title: `c:\\users\\${MARKER}\\antigo`, endedAt: ISO }], ...later(),
    },
    live: true, sig: '0123456789abcdef', ...later(),
  },
}

describe('the three reads through a real House', () => {
  let bench: HouseBench
  let s: DeviceSession
  const calls: { op: ExtReadOp; args: Record<string, unknown> }[] = []
  let answer: (op: ExtReadOp, args: Record<string, unknown>) => Promise<unknown> = async (op) => ANSWERS[op]
  const reads: PipeReads = { read: (op, args) => { calls.push({ op, args }); return answer(op, args) } }
  const deviceId = (): string => toHex(bench.device.result!.deviceId)
  const scopes = (list: readonly string[]): void => {
    const d = bench.registry.get(deviceId())!
    d.scopes = [...list]
    bench.house.upsertDevice(structuredClone(d))
  }
  const allScopes: string[] = []

  before(async () => {
    bench = await startHouseBench({ reads, noticeGapsMs: { channels: 0, regency: 0 } })
    allScopes.push(...bench.registry.get(deviceId())!.scopes)
    s = await bench.connect()
  })
  after(async () => { await bench?.stop() })

  test('each read answers its projection; the pair gets only the arguments rebuilt from the strict body', async () => {
    calls.length = 0
    const marks = await s.request(OP_CODES['channels.marks'])
    assert.deepEqual(marks, {
      status: RES_STATUS.ok,
      body: { channels: [{ channel: 'c_1', name: 'obra', unread: 2, toMe: 1, seen: 3, asks: 0, owed: 0, members: ['a1b2c3d4'], firstCall: { why: 'to-you', text: 'conferente: oi' } }], more: 0, moderator: { name: 'Guga' } },
    })
    const page = await s.request(OP_CODES['channels.page'], { channel: 'c_1', before: 9 })
    assert.equal(page.status, RES_STATUS.ok)
    assert.deepEqual([page.body.members, page.body.moderator], [[{ id: 'a1b2c3d4', name: 'conferente em ~/obra', muted: true }], { name: 'Guga' }], 'the members by id, name and mute only')
    assert.deepEqual((page.body.lines as { files: unknown }[])[0]!.files, [{ name: 'a.txt', size: 3, type: 'text/plain' }], 'an attachment by its name, never its path')
    assert.equal(page.body.before, undefined, 'seq 5 of 5 with a page of 50: the start')
    const tree = await s.request(OP_CODES['regency.tree'])
    assert.equal(tree.status, RES_STATUS.ok)
    assert.deepEqual([tree.body.live, tree.body.sig, (tree.body.input as { collapsed: unknown }).collapsed], [true, '0123456789abcdef', []])
    const input = tree.body.input as { desks: { desks: { name: string; panes: { title: string; lines?: string[] }[] }[] }; closed: { title: string }[]; channels: { title: string }[]; agents: { name: string }[] }
    assert.deepEqual(input.desks.desks[0]!.panes[0]!.lines, ['revisa ~\\obra', 'Esperando você'], 'the seal lines of a live tree, one line each, without paths or bidi')
    const d2 = input.desks.desks[1]!
    assert.deepEqual(
      { desk: d2.name, panes: d2.panes.map((p) => p.title), closed: input.closed[0]!.title, channel: input.channels[0]!.title, agent: input.agents[0]!.name },
      { desk: '~/obra', panes: ['~\\tether', '~/…/plano.html', 'rodando em ~/proj', '~/proj', '~/proj', '~\\proj'], closed: '~\\antigo', channel: '~/obra', agent: '~\\tether' },
      'the home is `~`, a file: address its last segment',
    )
    assert.equal((page.body.channel as { title: string }).title, 'Obra em ~')
    assert.deepEqual(calls, [
      { op: 'channels.marks', args: {} },
      { op: 'channels.page', args: { channel: 'c_1', limit: PAGE_LINES_MAX, before: 9 } },
      { op: 'regency.tree', args: {} },
    ])
    for (const r of [marks, page, tree]) assert.equal(has(r), false, JSON.stringify(r))
  })

  test('the strict body: an unknown key, an odd channel id, a cursor below 1 or a limit past the ceiling is 0x01, before the pipe', async () => {
    calls.length = 0
    for (const body of [{ channel: 'c_1', ext: 'channels' }, { channel: 'c_1', name: 'say' }, { channel: '../c_1' }, { channel: 'c_1', before: 0 }, { channel: 'c_1', limit: PAGE_LINES_MAX + 1 }, { channel: 'c_1', limit: 1.5 }, {}])
      assert.equal((await s.request(OP_CODES['channels.page'], body)).status, RES_STATUS.badRequest, JSON.stringify(body))
    assert.equal((await s.request(OP_CODES['channels.marks'], { ext: 'regency', name: 'tree.publish' })).status, RES_STATUS.badRequest)
    assert.deepEqual(calls, [], 'nothing reached the pipe')
  })

  test('without the scope of its line a read is 0x03; without `channels` the tree goes, without the first call', async () => {
    scopes(allScopes.filter((x) => x !== 'channels'))
    calls.length = 0
    assert.equal((await s.request(OP_CODES['channels.marks'])).status, RES_STATUS.noScope)
    assert.equal((await s.request(OP_CODES['channels.page'], { channel: 'c_1' })).status, RES_STATUS.noScope)
    const tree = await s.request(OP_CODES['regency.tree'])
    assert.equal(tree.status, RES_STATUS.ok)
    assert.deepEqual((tree.body.input as { channelMarks: unknown }).channelMarks, { c_1: { unread: 1, toMe: 1, asks: 0, owed: 0 } })
    scopes(allScopes.filter((x) => x !== 'regency:read'))
    assert.equal((await s.request(OP_CODES['regency.tree'])).status, RES_STATUS.noScope)
    assert.deepEqual(calls.map((c) => c.op), ['regency.tree'], 'a refused read never reached the pipe')
    scopes(allScopes)
  })

  test("the answers of the ceilings: unknown channel 0x06, the pipe's ceiling 0x07, a failure or a body too large 0x09", async () => {
    answer = async () => { throw new ReadError('refused', 'unknown-channel') }
    assert.deepEqual(await s.request(OP_CODES['channels.page'], { channel: 'c_9' }), { status: RES_STATUS.notFound, body: {} })
    answer = async () => { throw new ReadError('limit') }
    bench.house.extEvent('channels', 'line', { channelId: 'c_1' }) // the shared marks were kept: a change lets them be asked again
    assert.deepEqual(await s.request(OP_CODES['channels.marks']), { status: RES_STATUS.limit, body: {} })
    answer = async () => { throw new ReadError('timeout') }
    assert.deepEqual(await s.request(OP_CODES['regency.tree']), { status: RES_STATUS.failed, body: { error: 'failed' } })
    const big = Array.from({ length: 256 }, (_, i) => ({ id: `d${i}`, name: 'x'.repeat(128), color: 'c', kind: 'queue', asleep: false, panes: Array.from({ length: 8 }, (_, j) => ({ id: `p${i}-${j}`, type: 'agent', icon: 'i', title: 'y'.repeat(256) })) }))
    answer = async () => ({ input: { desks: { desks: big } }, live: true })
    const r = await s.request(OP_CODES['regency.tree'])
    assert.deepEqual(r, { status: RES_STATUS.failed, body: { error: 'too-large' } }, `a body over ${READ_BODY_MAX} bytes is refused, never cut`)
    answer = async (op) => ANSWERS[op]
  })

  test('a read is no gesture (its line says so) and leaves no audit line, accepted or refused', async () => {
    const before = bench.audits().length
    for (let i = 0; i < 3; i++) {
      await s.request(OP_CODES['channels.marks'])
      await s.request(OP_CODES['channels.page'], { channel: 'c_1' })
      await s.request(OP_CODES['regency.tree'])
    }
    await s.request(OP_CODES['channels.page'], { channel: 'c_1', bogus: 1 })
    assert.equal(bench.audits().length, before, 'reads, accepted or refused, leave no line')
  })

  test('the thin notices go to a session that read, by its scope, with no content; a session that never read gets none', async () => {
    const quiet = await bench.connect()
    await quiet.request(OP_CODES['session.info'])
    await s.request(OP_CODES['channels.marks'])
    await s.request(OP_CODES['regency.tree'])
    const from = s.events.length
    bench.house.extEvent('channels', 'line', { channelId: 'c_1', room: 'obra', line: { body: MARKER, from: { name: MARKER } } })
    bench.house.extEvent('regency', 'tree.changed', { sig: 'fedcba9876543210', at: 99, live: false })
    await until(() => (s.events.length >= from + 2) || undefined, 5_000, 'both notices')
    const got = s.events.slice(from)
    assert.deepEqual(got.find((e) => e.evt === 0x0200)?.body, { channels: ['c_1'] })
    assert.deepEqual(got.find((e) => e.evt === 0x0300)?.body, { live: false, sig: 'fedcba9876543210', asOf: 99 })
    assert.equal(has(got), false)
    assert.deepEqual(quiet.events, [], 'it never read: no notice')
    // Without `channels`, the channels notice stops; the Regency's goes on.
    scopes(allScopes.filter((x) => x !== 'channels'))
    const mark = s.events.length
    bench.house.extEvent('channels', 'line', { channelId: 'c_1' })
    bench.house.extEvent('regency', 'tree.changed', { sig: '0123456789abcdef', at: 100, live: true })
    await until(() => s.events.slice(mark).some((e) => e.evt === 0x0300) || undefined, 5_000, 'the Regency notice')
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(s.events.slice(mark).map((e) => e.evt), [0x0300])
    scopes(allScopes)
  })

  // RR3 gate M-1: every device asked tetherd for the marks on its own, each notice, and could take the 8 slots of the pipe.
  test('channels.marks is one read for every device: one at tetherd at a time, kept until a channels event', async () => {
    // One session stands for the devices: what it shares is the portal's, never the session's (the handshake ceilings of
    // the bench leave no room for one more session here).
    const other = s
    bench.house.extEvent('channels', 'line', { channelId: 'c_1' })
    calls.length = 0
    let release: () => void = () => {}
    const gateOpen = new Promise<void>((r) => { release = r })
    answer = async (op) => { await gateOpen; return ANSWERS[op] }
    const asked = [s, other, s, other].map((x) => x.request(OP_CODES['channels.marks']))
    await until(() => calls.length > 0 || undefined, 5_000, 'the marks at the pipe')
    await new Promise((r) => setTimeout(r, 50))
    release()
    for (const r of await Promise.all(asked)) assert.equal(r.status, RES_STATUS.ok)
    assert.equal(calls.filter((c) => c.op === 'channels.marks').length, 1, 'four requests at once, one read')
    for (let i = 0; i < 5; i++) assert.equal((await other.request(OP_CODES['channels.marks'])).status, RES_STATUS.ok)
    assert.equal(calls.filter((c) => c.op === 'channels.marks').length, 1, 'kept: nothing changed')
    bench.house.extEvent('channels', 'reaction', { channelId: 'c_1' })
    assert.equal((await s.request(OP_CODES['channels.marks'])).status, RES_STATUS.ok)
    assert.equal(calls.filter((c) => c.op === 'channels.marks').length, 2, 'a channels event: asked again')
    answer = async (op) => ANSWERS[op]
  })

  // RR3 temper O-1: "seen" on the machine changes the marks a device holds; the event is thin and works like any channels event.
  test('a `seen` event of the machine: the shared marks are asked again and the device gets a thin notice', async () => {
    await s.request(OP_CODES['channels.marks'])
    calls.length = 0
    await s.request(OP_CODES['channels.marks'])
    assert.equal(calls.filter((c) => c.op === 'channels.marks').length, 0, 'kept')
    const from = s.events.length
    bench.house.extEvent('channels', 'seen', { channelId: 'c_1', seenByUser: 7 })
    await until(() => s.events.slice(from).find((e) => e.evt === 0x0200) || undefined, 5_000, 'the channels notice')
    assert.deepEqual(s.events.slice(from).find((e) => e.evt === 0x0200)?.body, { channels: ['c_1'] })
    assert.equal((await s.request(OP_CODES['channels.marks'])).status, RES_STATUS.ok)
    assert.equal(calls.filter((c) => c.op === 'channels.marks').length, 1, 'asked again after the event')
  })

  test('canary: the marker tetherd put in every extra field crossed the relay in no byte', () => {
    assert.equal(bench.relay.allBytes().includes(Buffer.from(MARKER, 'latin1')), false)
  })
})
