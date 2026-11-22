// The channels' record (extensions/channels/daemon/store.ts) over the real `api.io` (fsIo, node's async file API) in a
// temporary home: the index written atomically at every change of structure, and the reverse index agent -> channels.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fsIo } from '../../src/daemon/ext-io.ts'
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
