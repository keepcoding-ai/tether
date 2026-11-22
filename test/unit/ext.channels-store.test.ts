// The channels' record (extensions/channels/daemon/store.ts) over the real `api.io` (fsIo, node's async file API) in a
// temporary home: the index written atomically at every change of structure, the reverse index agent -> channels, and
// the lines (rotation every 500, seq recovered on reopen, history across files, the tail in memory).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fsIo } from '../../src/daemon/ext-io.ts'
import type { DaemonIo } from '../../src/daemon/ext-api.ts'
import { openStore, type ChannelStore } from '../../extensions/channels/daemon/store.ts'
import { agentOwnerOf, isMember, isMuted, isRemoved, ownerOf, USER, type Channel } from '../../extensions/channels/rules.ts'

const homes: string[] = []
after(async () => {
  for (const h of homes) await fsIo.rm(h)
})
async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tether-channels-store-'))
  homes.push(home)
  return home
}

let tick = 0
const options = { now: () => new Date(Date.UTC(2026, 10, 22, 12, 0, tick++)) }

async function indexOf(home: string): Promise<{ version: number; channels: Record<string, Channel> }> {
  return JSON.parse(await fsIo.readText(join(home, 'channels', 'index.json')))
}

const A = 'a1b2c3d4'
const B = 'b2c3d4e5'
const C = 'c3d4e5f6'

async function agentChannel(store: ChannelStore, name = 'obra'): Promise<Channel> {
  const r = await store.create({ name, owner: { kind: 'agent', id: A, name: 'claude · conferente' }, createdBy: A })
  assert.ok(r.ok)
  return r.channel
}

describe('index and structure', () => {
  test('create writes index.json atomically; the creating agent is the owner and a member', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const ch = await agentChannel(store)
    const disk = await indexOf(home)
    assert.equal(disk.version, 1)
    assert.deepEqual(disk.channels[ch.id], JSON.parse(JSON.stringify(ch)))
    assert.match(ch.id, /^c_[a-z0-9]+$/)
    assert.equal(agentOwnerOf(ch), A)
    assert.ok(isMember(ch, A))
    assert.deepEqual(store.channelsOf(A).map((c) => c.id), [ch.id])
    const entries = await fsIo.readdir(join(home, 'channels'))
    assert.deepEqual(entries.map((e) => e.name).filter((n) => n.endsWith('.tmp')), [])
  })

  test('a user-owned channel has no member; the name is refused when bad or taken among the open ones', async () => {
    const store = await openStore(fsIo, await newHome(), options)
    const made = await store.create({ name: 'geral', title: 'Geral', owner: { kind: 'user' }, createdBy: USER })
    assert.ok(made.ok)
    assert.deepEqual(made.channel.members, {})
    assert.equal(made.channel.title, 'Geral')
    assert.deepEqual(await store.create({ name: 'geral', owner: { kind: 'user' }, createdBy: USER }), { ok: false, error: 'name-taken' })
    assert.deepEqual(await store.create({ name: 'Geral!', owner: { kind: 'user' }, createdBy: USER }), { ok: false, error: 'bad-name' })
    assert.equal(store.findOpen('geral')?.id, made.channel.id)
  })

  test('the desk channel has the id desk_<deskId> and carries the desk; the same desk twice is refused', async () => {
    const store = await openStore(fsIo, await newHome(), options)
    const r = await store.create({ name: 'obra', owner: { kind: 'agent', id: A, name: 'Atrium' }, createdBy: A, desk: 'd7' })
    assert.ok(r.ok)
    assert.equal(r.channel.id, 'desk_d7')
    assert.equal(r.channel.desk, 'd7')
    assert.deepEqual(await store.create({ name: 'outra', owner: { kind: 'user' }, createdBy: USER, desk: 'd7' }), { ok: false, error: 'exists' })
  })

  test('join writes the member, is idempotent (already), and clears a removal', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const ch = await agentChannel(store)
    const first = await store.join(ch.id, B, 'soul · bancada', A)
    assert.ok(first.ok && !first.already)
    assert.equal((await indexOf(home)).channels[ch.id]!.members[B]!.by, A)
    const again = await store.join(ch.id, B, 'soul · bancada', A)
    assert.ok(again.ok && again.already)

    await store.remove(ch.id, B)
    assert.ok(isRemoved(ch, B))
    const back = await store.join(ch.id, B, 'soul · bancada', USER)
    assert.ok(back.ok && !back.already)
    assert.ok(!isRemoved(ch, B))
    assert.equal(ch.removed, undefined)
    assert.deepEqual(await store.join('nope', B, 'x', USER), { ok: false, error: 'unknown-channel' })
  })

  test('the reverse index follows join, remove, leave and a forgotten pane', async () => {
    const store = await openStore(fsIo, await newHome(), options)
    const one = await agentChannel(store, 'um')
    const two = await agentChannel(store, 'dois')
    await store.join(one.id, B, 'b', A)
    await store.join(two.id, B, 'b', A)
    await store.join(two.id, C, 'c', A)
    const ids = (agent: string): string[] => store.channelsOf(agent).map((c) => c.id).sort()
    assert.deepEqual(ids(B), [one.id, two.id].sort())
    await store.remove(one.id, B)
    assert.deepEqual(ids(B), [two.id])
    await store.leave(two.id, C)
    assert.deepEqual(ids(C), [])
    assert.deepEqual(await store.leave(two.id, C), { ok: false, error: 'not-member' })
    const gone = await store.forget(B)
    assert.deepEqual(gone.map((g) => g.channel.id), [two.id])
    assert.deepEqual(ids(B), [])
    assert.ok(!isMember(two, B))
    assert.deepEqual(await store.forget(B), [])
  })

  test('the owner who leaves, is removed or is forgotten gives the channel up with the why; the user owns it then', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const left = await agentChannel(store, 'saiu')
    const l = await store.leave(left.id, A)
    assert.ok(l.ok && l.endedOwner)
    assert.equal(left.ownerEnded?.why, 'left')
    assert.equal(left.ownerEnded?.name, 'claude · conferente')
    assert.deepEqual(ownerOf(left), { kind: 'user' })

    const taken = await agentChannel(store, 'tirado')
    const r = await store.remove(taken.id, A)
    assert.ok(r.ok && r.endedOwner)
    assert.equal(taken.ownerEnded?.why, 'removed')
    assert.deepEqual(taken.removed, [A])

    const forgot = await agentChannel(store, 'esquecido')
    const f = await store.forget(A)
    assert.deepEqual(f.map((x) => x.channel.id), [forgot.id])
    assert.equal(forgot.ownerEnded?.why, 'forgotten')

    // coming back it is only a member; the abdication stays on disk
    await store.join(forgot.id, A, 'claude · conferente', USER)
    assert.ok(isMember(forgot, A))
    assert.equal(agentOwnerOf(forgot), undefined)
    assert.equal((await indexOf(home)).channels[forgot.id]!.ownerEnded?.why, 'forgotten')
  })

  test('a plain member leaving does not end ownership', async () => {
    const store = await openStore(fsIo, await newHome(), options)
    const ch = await agentChannel(store)
    await store.join(ch.id, B, 'b', A)
    const r = await store.leave(ch.id, B)
    assert.ok(r.ok && !r.endedOwner)
    assert.equal(ch.ownerEnded, undefined)
    assert.equal(agentOwnerOf(ch), A)
  })

  test('mute and unmute write the member; repeating changes nothing', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const ch = await agentChannel(store)
    await store.join(ch.id, B, 'b', A)
    const m = await store.mute(ch.id, B, A)
    assert.ok(m.ok && m.changed)
    assert.ok(isMuted(ch, B))
    assert.deepEqual((await indexOf(home)).channels[ch.id]!.members[B]!.muted?.by, A)
    const m2 = await store.mute(ch.id, B, USER)
    assert.ok(m2.ok && !m2.changed)
    assert.equal(ch.members[B]!.muted?.by, A)
    const u = await store.unmute(ch.id, B)
    assert.ok(u.ok && u.changed)
    assert.equal((await indexOf(home)).channels[ch.id]!.members[B]!.muted, undefined)
    assert.deepEqual(await store.mute(ch.id, C, A), { ok: false, error: 'not-member' })
  })

  test('close frees the name; reopen takes it back unless another open channel has it', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const ch = await agentChannel(store)
    const c = await store.close(ch.id, A)
    assert.ok(c.ok && c.changed)
    assert.equal(store.findOpen('obra'), undefined)
    assert.equal((await indexOf(home)).channels[ch.id]!.closed?.by, A)
    const c2 = await store.close(ch.id, USER)
    assert.ok(c2.ok && !c2.changed)

    const other = await agentChannel(store)
    assert.deepEqual(await store.reopen(ch.id), { ok: false, error: 'name-taken' })
    await store.close(other.id, USER)
    const o = await store.reopen(ch.id)
    assert.ok(o.ok && o.changed)
    assert.equal(ch.closed, undefined)
    assert.equal((await indexOf(home)).channels[ch.id]!.closed, undefined)
    assert.equal(store.findOpen('obra')?.id, ch.id)
  })

  test('setOwner clears the abdication; setTitle; markSeen and flush', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const ch = await agentChannel(store)
    await store.leave(ch.id, A)
    assert.ok(ch.ownerEnded)
    await store.join(ch.id, B, 'b', USER)
    await store.setOwner(ch.id, { kind: 'agent', id: B, name: 'b' })
    assert.equal(ch.ownerEnded, undefined)
    assert.equal(agentOwnerOf(ch), B)
    const t = await store.setTitle(ch.id, 'Nova')
    assert.ok(t.ok && t.changed)

    store.markSeen(ch.id, 5)
    store.markSeen(ch.id, 3)
    assert.equal((await indexOf(home)).channels[ch.id]!.seenByUser, 0)
    await store.flush()
    const disk = (await indexOf(home)).channels[ch.id]!
    assert.equal(disk.seenByUser, 5)
    assert.equal(disk.title, 'Nova')
  })

  test('reopening the store reads the index back, with the reverse index', async () => {
    const home = await newHome()
    const first = await openStore(fsIo, home, options)
    const ch = await agentChannel(first)
    await first.join(ch.id, B, 'b', A)
    await first.mute(ch.id, B, A)
    const second = await openStore(fsIo, home, options)
    assert.deepEqual(second.get(ch.id), JSON.parse(JSON.stringify(first.get(ch.id))))
    assert.deepEqual(second.channelsOf(B).map((c) => c.id), [ch.id])
    assert.equal(second.findOpen('obra')?.id, ch.id)
  })

  test('an unreadable index is kept beside and the store starts empty', async () => {
    const home = await newHome()
    await fsIo.writeTextAtomic(join(home, 'channels', 'index.json'), '{ not json')
    const logs: string[] = []
    const store = await openStore(fsIo, home, { ...options, log: (m) => logs.push(m) })
    assert.deepEqual(store.channels(), [])
    assert.equal(logs.length, 1)
    const names = (await fsIo.readdir(join(home, 'channels'))).map((e) => e.name)
    assert.ok(names.some((n) => n.startsWith('index.json.unreadable-')))
  })

  test('concurrent changes end with every one of them on disk', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const ch = await agentChannel(store)
    await Promise.all([store.join(ch.id, B, 'b', A), store.join(ch.id, C, 'c', A), store.mute(ch.id, A, USER), store.setTitle(ch.id, 'T')])
    const disk = (await indexOf(home)).channels[ch.id]!
    assert.deepEqual(Object.keys(disk.members).sort(), [A, B, C].sort())
    assert.ok(disk.members[A]!.muted)
    assert.equal(disk.title, 'T')
  })
})

/** The real io, counting what reads from disk and able to fail the next append. */
function counting(real: DaemonIo): { io: DaemonIo; reads: () => number; failNextAppend: () => void } {
  let n = 0
  let fail = false
  const io: DaemonIo = {
    ...real,
    readText: (p) => (n++, real.readText(p)),
    tryReadText: (p) => (n++, real.tryReadText(p)),
    readdir: (p) => (n++, real.readdir(p)),
    appendText: (p, t) => {
      if (fail) {
        fail = false
        return Promise.reject(new Error('disk full'))
      }
      return real.appendText(p, t)
    },
  }
  return { io, reads: () => n, failNextAppend: () => { fail = true } }
}

const say = (n: number): { kind: 'message'; from: { id: string; name: string; role: 'member' }; body: string } => ({
  kind: 'message', from: { id: A, name: 'claude · conferente', role: 'member' }, body: `fala ${n}`,
})

async function fill(store: ChannelStore, id: string, count: number): Promise<void> {
  for (let n = 1; n <= count; n++) await store.append(id, say(n))
}

async function linesIn(home: string, id: string, file: string): Promise<string[]> {
  return (await fsIo.readText(join(home, 'channels', id, file))).split('\n').filter(Boolean)
}

describe('lines, files and the tail', () => {
  test('append numbers the lines and writes 500 per file, the 501st opening the next', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const first = await store.append('c_1', say(1))
    assert.equal(first.seq, 1)
    assert.match(first.at, /^2026-11-22T/)
    await fill(store, 'c_1', 499) // 500 lines now
    assert.deepEqual((await fsIo.readdir(join(home, 'channels', 'c_1'))).map((e) => e.name), ['000001.jsonl'])
    const last = await store.append('c_1', { ...say(501), at: '2026-01-01T00:00:00.000Z', replyTo: 3, to: ['soul · bancada'] })
    assert.equal(last.seq, 501)
    assert.equal(last.at, '2026-01-01T00:00:00.000Z')
    assert.deepEqual((await fsIo.readdir(join(home, 'channels', 'c_1'))).map((e) => e.name).sort(), ['000001.jsonl', '000002.jsonl'])
    const one = await linesIn(home, 'c_1', '000001.jsonl')
    const two = await linesIn(home, 'c_1', '000002.jsonl')
    assert.equal(one.length, 500)
    assert.equal(JSON.parse(one[499]!).seq, 500)
    assert.deepEqual(two.map((l) => JSON.parse(l).seq), [501])
    assert.deepEqual(JSON.parse(two[0]!).to, ['soul · bancada'])
  })

  test('seq is recovered from the last line when the store is reopened, in the next file when the last is full', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    await fill(store, 'c_1', 230)
    await fill(store, 'c_2', 500)
    const again = await openStore(fsIo, home, options)
    assert.equal(await again.lastSeq('c_1'), 230)
    assert.equal((await again.append('c_1', say(231))).seq, 231)
    assert.equal(await again.lastSeq('c_unknown'), 0)
    assert.equal((await again.append('c_2', say(501))).seq, 501)
    assert.deepEqual((await linesIn(home, 'c_2', '000002.jsonl')).map((l) => JSON.parse(l).seq), [501])
    assert.equal((await linesIn(home, 'c_1', '000001.jsonl')).length, 231)
  })

  test('a torn last line is skipped on reading and the next append starts on a line of its own', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    await fill(store, 'c_1', 3)
    await fsIo.appendText(join(home, 'channels', 'c_1', '000001.jsonl'), '{"seq":4,"at":"2026')
    const again = await openStore(fsIo, home, options)
    assert.equal(await again.lastSeq('c_1'), 3)
    const line = await again.append('c_1', say(4))
    assert.equal(line.seq, 4)
    assert.deepEqual((await again.history('c_1')).map((l) => l.seq), [1, 2, 3, 4])
    const fresh = await openStore(fsIo, home, options)
    assert.deepEqual((await fresh.history('c_1')).map((l) => l.seq), [1, 2, 3, 4])
  })

  test('history(before, limit) crosses two files, from disk', async () => {
    const home = await newHome()
    await fill(await openStore(fsIo, home, options), 'c_1', 600)
    const store = await openStore(fsIo, home, options)
    const page = await store.history('c_1', 531, 200) // 331..530: the tail (401..600) does not cover it
    assert.equal(page.length, 200)
    assert.equal(page[0]!.seq, 331)
    assert.equal(page[199]!.seq, 530)
    assert.deepEqual(page.map((l) => l.seq), Array.from({ length: 200 }, (_, i) => 331 + i))
    // the page before that one goes back through the first file only, and before 1 is empty
    assert.deepEqual((await store.history('c_1', 331, 5)).map((l) => l.seq), [326, 327, 328, 329, 330])
    assert.deepEqual(await store.history('c_1', 1), [])
    assert.deepEqual((await store.history('c_1', 1000, 2)).map((l) => l.seq), [599, 600])
    assert.equal((await store.history('c_1')).length, 200)
    assert.equal((await store.history('c_nothing')).length, 0)
  })

  test('since(seq) reads forward, from the tail and across files', async () => {
    const home = await newHome()
    await fill(await openStore(fsIo, home, options), 'c_1', 600)
    const store = await openStore(fsIo, home, options)
    assert.deepEqual((await store.since('c_1', 596)).map((l) => l.seq), [597, 598, 599, 600])
    assert.deepEqual((await store.since('c_1', 600)), [])
    const old = await store.since('c_1', 490, 20)
    assert.deepEqual(old.map((l) => l.seq), Array.from({ length: 20 }, (_, i) => 491 + i))
    assert.equal((await store.since('c_1', 0, 3)).length, 3)
  })

  test('the tail serves history and since without touching the disk', async () => {
    const home = await newHome()
    const c = counting(fsIo)
    const store = await openStore(c.io, home, options)
    await fill(store, 'c_1', 40)
    const before = c.reads()
    assert.equal((await store.history('c_1')).length, 40)
    assert.deepEqual((await store.since('c_1', 35)).map((l) => l.seq), [36, 37, 38, 39, 40])
    assert.equal(await store.lastSeq('c_1'), 40)
    assert.deepEqual((await store.history('c_1', 5)).map((l) => l.seq), [1, 2, 3, 4])
    assert.equal(c.reads(), before)
    // the tail keeps only the last 200, and appending keeps it in step
    await fill(store, 'c_1', 300)
    const latest = await store.history('c_1')
    assert.equal(latest[0]!.seq, 141)
    assert.equal(latest[199]!.seq, 340)
    assert.equal(c.reads(), before, 'appending to a cached channel reads nothing either')
  })

  test('at most 16 channels keep a tail; the least recently used leaves, and reading it goes back to the disk', async () => {
    const home = await newHome()
    const c = counting(fsIo)
    const store = await openStore(c.io, home, options)
    const ids = Array.from({ length: 17 }, (_, i) => `c_${i + 1}`)
    for (const id of ids) await fill(store, id, 3)
    assert.equal(store.cachedChannels().length, 16)
    assert.ok(!store.cachedChannels().includes('c_1'))
    assert.equal(store.cachedChannels()[0], 'c_2')

    // using c_2 makes c_3 the least used
    await store.history('c_2')
    await fill(store, 'c_18', 1)
    assert.ok(store.cachedChannels().includes('c_2'))
    assert.ok(!store.cachedChannels().includes('c_3'))
    assert.equal(store.cachedChannels().length, 16)

    const before = c.reads()
    await store.history('c_2')
    assert.equal(c.reads(), before, 'a cached channel reads nothing')
    const cold = await store.history('c_1')
    assert.deepEqual(cold.map((l) => l.seq), [1, 2, 3])
    assert.ok(c.reads() > before, 'an evicted channel is read back from disk')
    assert.equal(store.cachedChannels().length, 16)
  })

  test('an evicted channel keeps its seq: appending to it does not read the disk and the numbering goes on', async () => {
    const home = await newHome()
    const c = counting(fsIo)
    const store = await openStore(c.io, home, { ...options, tailChannels: 1 })
    await fill(store, 'c_1', 5)
    await fill(store, 'c_2', 2) // c_1 leaves the tail
    assert.deepEqual(store.cachedChannels(), ['c_2'])
    const before = c.reads()
    assert.equal((await store.append('c_1', say(6))).seq, 6)
    assert.equal(c.reads(), before)
    assert.deepEqual((await store.history('c_1')).map((l) => l.seq), [1, 2, 3, 4, 5, 6])
  })

  test('concurrent appends to one channel get distinct, ordered seqs', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    const lines = await Promise.all(Array.from({ length: 60 }, (_, i) => store.append('c_1', say(i + 1))))
    assert.deepEqual(lines.map((l) => l.seq), Array.from({ length: 60 }, (_, i) => i + 1))
    assert.deepEqual(lines.map((l) => l.body), Array.from({ length: 60 }, (_, i) => `fala ${i + 1}`))
    assert.equal((await linesIn(home, 'c_1', '000001.jsonl')).length, 60)
  })

  test('a failed write consumes no seq and leaves the channel usable', async () => {
    const home = await newHome()
    const c = counting(fsIo)
    const store = await openStore(c.io, home, options)
    await fill(store, 'c_1', 2)
    c.failNextAppend()
    await assert.rejects(() => store.append('c_1', say(3)), /disk full/)
    assert.equal((await store.append('c_1', say(3))).seq, 3)
    assert.deepEqual((await store.history('c_1')).map((l) => l.seq), [1, 2, 3])
  })

  test('a line with a multi-line body stays one line on disk', async () => {
    const home = await newHome()
    const store = await openStore(fsIo, home, options)
    await store.append('c_1', { ...say(1), body: 'a\nb\r\nc' })
    assert.equal((await linesIn(home, 'c_1', '000001.jsonl')).length, 1)
    assert.equal((await openStore(fsIo, home, options).then((s) => s.history('c_1')))[0]!.body, 'a\nb\r\nc')
  })
})
