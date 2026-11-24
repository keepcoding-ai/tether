// Reactions on lines of a channel (R1): the pure rules (parse, sum, caps), the fan-out's `react` over the real store (a line of its
// own, the refusals, idempotence, the window, the rate limit) and the `react` and `read` verbs. THE IRON RULE: a reaction reaches
// no delivery queue, no notice, no `line` event and moves no member's state. No daemon: the API is a stub that records every call.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { DeliveryMessage, VerbCaller } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { reactVerb } from '../../extensions/channels/daemon/verbs/react.ts'
import { readVerb } from '../../extensions/channels/daemon/verbs/read.ts'
import { failOf, type VerbDeps } from '../../extensions/channels/daemon/verbs/common.ts'
import {
  parseReaction, reactionLimit, reactRefusal, sumReactions, USER, type Channel, type Line,
} from '../../extensions/channels/rules.ts'
import { removeHome, tempHome } from './daemon.basics.ts'

const line = (seq: number, react: Line['react'], who: string, name = who): Line => ({
  seq, at: '2026-11-24T10:00:00Z', kind: 'reaction', from: { id: who, name, role: 'member' }, body: '', react,
})

describe('reactions: the pure rules', () => {
  test('parseReaction: the five by name (any case) and by emoji, one emoji of any kind, never text', () => {
    assert.deepEqual(parseReaction('done'), { emoji: '✅', name: 'done' })
    assert.deepEqual(parseReaction(' AGREE '), { emoji: '👍', name: 'agree' })
    assert.deepEqual(parseReaction('👀'), { emoji: '👀', name: 'seen' })
    assert.deepEqual(parseReaction('❓'), { emoji: '❓', name: 'question' })
    assert.deepEqual(parseReaction('❌'), { emoji: '❌', name: 'disagree' })
    assert.deepEqual(parseReaction('🎉'), { emoji: '🎉' })
    for (const composed of ['👍🏽', '🇧🇷', '👨‍👩‍👧', '1️⃣', '❤️']) assert.equal(parseReaction(composed)?.emoji, composed, composed)
    assert.equal(parseReaction('👍🏽')?.name, undefined, 'a skin tone is not the agreed 👍')
    for (const bad of ['', '  ', 'ok', 'done!', '👍👍', 'a', '1', '<b>', '👍x', 'x'.repeat(50), 42, undefined, null]) assert.equal(parseReaction(bad), undefined, String(bad))
  })

  test('sumReactions: a repeated add counts one, remove takes it, remove without add changes nothing, order kept', () => {
    const sums = sumReactions([
      line(5, { seq: 3, emoji: '👍', op: 'add' }, 'a', 'alfa'),
      line(6, { seq: 3, emoji: '👍', op: 'add' }, 'a', 'alfa'),
      line(7, { seq: 3, emoji: '👍', op: 'add' }, 'b', 'bravo'),
      line(8, { seq: 3, emoji: '❓', op: 'add' }, 'b', 'bravo'),
      line(9, { seq: 3, emoji: '👍', op: 'remove' }, 'a', 'alfa'),
      line(10, { seq: 4, emoji: '✅', op: 'remove' }, 'a', 'alfa'),
      line(11, { seq: 3, emoji: '👍️', op: 'add' }, 'c', 'charlie'), // 👍 + selector: the same reaction as 👍
    ])
    assert.deepEqual(sums.get(3)?.map((t) => [t.emoji, t.name, t.by.map((b) => b.name)]), [['👍', 'agree', ['bravo', 'charlie']], ['❓', 'question', ['bravo']]])
    assert.equal(sums.has(4), false)
  })

  test('caps: 3 emojis per member, 12 different per line (a 13th answers limit, an existing one still joins)', () => {
    const mine = ['🎉', '🔥', '🚀'].map((emoji) => ({ emoji, by: [{ id: 'a', name: 'alfa' }] }))
    assert.equal(reactionLimit(mine, 'a', { emoji: '🌟' }), 'limit')
    assert.equal(reactionLimit(mine, 'b', { emoji: '🌟' }), undefined)
    const twelve = Array.from({ length: 12 }, (_, i) => ({ emoji: String.fromCodePoint(0x1f600 + i), by: [{ id: 'z', name: 'zulu' }] }))
    assert.equal(reactionLimit(twelve, 'a', { emoji: '🌟' }), 'limit')
    assert.equal(reactionLimit(twelve, 'a', { emoji: twelve[0]!.emoji }), undefined)
  })

  test('reactRefusal: closed, stranger, muted with a free emoji; the person always; the muted with the five', () => {
    const ch = { members: { a: { name: 'alfa' }, m: { name: 'mudo', muted: { since: 'x', by: 'user' } } } } as unknown as Channel
    assert.equal(reactRefusal('a', ch), undefined)
    assert.equal(reactRefusal('z', ch), 'not-member')
    assert.equal(reactRefusal(USER, ch), undefined)
    assert.equal(reactRefusal('m', ch, { emoji: '🎉' }), 'muted')
    assert.equal(reactRefusal('m', ch, { emoji: '👍', name: 'agree' }), undefined)
    assert.equal(reactRefusal('a', { ...ch, closed: { at: 'x', by: 'user' } } as Channel), 'closed')
  })
})

describe('reactions: the fan-out and the verbs over the real store', () => {
  let home: string
  let ch: Channels
  let deps: VerbDeps
  const delivered: DeliveryMessage[] = []
  const events: Array<{ name: string; payload: any }> = []
  const queued: unknown[] = []
  const slot = (id: string, name: string) => ({ slotId: id, kind: 'claude', status: 'running', name, cwd: '/x' })
  const SLOTS: Record<string, ReturnType<typeof slot>> = { A: slot('A', 'alfa'), B: slot('B', 'bravo'), M: slot('M', 'mudo') }
  const caller = (id: string): VerbCaller => ({ slotId: id, state: SLOTS[id], via: 'mcp', proven: true }) as unknown as VerbCaller
  /** What `registerVerbs` does around a verb: an error with a code is the verb's error result. */
  const run = async (def: typeof reactVerb | typeof readVerb, who: string, args: Record<string, unknown>) => {
    try { return await def.run(deps, caller(who), args) } catch (e) { return failOf(e) }
  }
  const react = (who: string, seq: number, reaction: string, remove = false) => run(reactVerb, who, { canal: 'obra', seq, reaction, ...(remove ? { remove: true } : {}) })
  const codeOf = (r: { data?: unknown }): unknown => (r.data as { error?: string }).error
  let id: string
  const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 20)) }

  before(async () => {
    home = tempHome()
    const none = { dispose: () => {} }
    const api = {
      slots: { get: (s: string) => SLOTS[s], list: () => Object.values(SLOTS), onState: () => none, userTypedAt: () => undefined },
      delivery: {
        onDidDeliver: () => none,
        deliver: async (_slot: string, msg: DeliveryMessage) => { delivered.push(msg); return { id: `r${delivered.length}`, slotId: _slot, state: 'inside' } },
        pending: () => queued, cancel: () => false, routeOf: () => 'inside', hasTools: () => true,
      },
      attention: { seen: () => { throw new Error('attention must not be touched') } },
      events: { emit: (name: string, payload: unknown) => { events.push({ name, payload }) } },
      settings: { get: () => undefined }, log: () => {},
      verbs: { register: () => none, instructions: () => none },
    } as unknown as ChannelsApi & VerbDeps['api']
    const store = await openStore(fsIo, home)
    ch = createChannels(api, store)
    deps = { api, channels: ch }
    const made = await ch.create('A', { name: 'obra' })
    assert.ok(made.ok)
    id = made.channel.id
    assert.ok((await ch.join('B', id)).ok)
    assert.ok((await ch.join('M', id)).ok)
    assert.ok((await ch.mute(USER, id, 'M')).ok)
  })
  after(async () => { ch?.dispose(); await removeHome(home) })

  test('react writes one line of its own (kind reaction, own seq), changes no earlier line, and reaches no one', async () => {
    const said = await ch.say('A', id, { body: 'Terminei a revisão. Posso subir?' })
    assert.ok(said.ok)
    const seq = said.line.seq
    const before = { delivered: delivered.length, lines: events.filter((e) => e.name === 'line').length, last: await ch.store.lastSeq(id) }
    const earlier = JSON.stringify(await ch.store.history(id))

    const r = await react('B', seq, 'agree')
    assert.equal(r.isError, undefined, r.text)
    assert.match(r.text, /^Reagiu 👍 em obra#\d+\.$/)
    assert.equal(await ch.store.lastSeq(id), before.last + 1)
    const written = (await ch.store.since(id, before.last)).at(-1)!
    assert.equal(written.kind, 'reaction')
    assert.equal(written.seq, before.last + 1)
    assert.deepEqual(written.react, { seq, emoji: '👍', op: 'add' })
    assert.equal(written.body, '')
    assert.deepEqual(written.from, { id: 'B', name: 'bravo', role: 'member' })
    assert.equal(JSON.stringify((await ch.store.history(id)).slice(0, -1)), earlier, 'no earlier line was touched')

    // The iron rule.
    await flush()
    assert.equal(delivered.length, before.delivered, 'no delivery')
    assert.equal(queued.length, 0, 'nothing in the core queue')
    assert.equal(events.filter((e) => e.name === 'line').length, before.lines, 'no `line` event')
    assert.equal(events.filter((e) => e.name === 'reaction').length, 1)
    assert.equal(ch.store.get(id)!.seenByUser, 0, '"seen" did not move')
  })

  test('put is idempotent and writes no second line; remove takes it; remove without add changes nothing', async () => {
    const seq = (await ch.store.history(id)).find((l) => l.kind === 'message')!.seq
    const last = await ch.store.lastSeq(id)
    const again = await react('B', seq, '👍')
    assert.match(again.text, /^Você já tinha 👍/)
    assert.equal((again.data as { changed: boolean }).changed, false)
    assert.equal(await ch.store.lastSeq(id), last)

    const taken = await react('B', seq, 'agree', true)
    assert.match(taken.text, /^Tirou 👍 de obra#/)
    assert.equal(await ch.store.lastSeq(id), last + 1)
    const nothing = await react('B', seq, 'agree', true)
    assert.match(nothing.text, /^Você não tinha 👍/)
    assert.equal(await ch.store.lastSeq(id), last + 1)
  })

  test('refusals, each with its code: bad-reaction, unknown-line, not-a-message, not-member', async () => {
    const msg = (await ch.store.history(id)).find((l) => l.kind === 'message')!.seq
    const notice = (await ch.store.history(id)).find((l) => l.kind === 'notice')!.seq
    const reaction = (await ch.store.history(id)).find((l) => l.kind === 'reaction')!.seq
    assert.equal(codeOf(await react('B', msg, 'ok')), 'bad-reaction')
    assert.equal(codeOf(await react('B', 9999, 'done')), 'unknown-line')
    assert.equal(codeOf(await react('B', 0, 'done')), 'unknown-line')
    assert.equal(codeOf(await react('B', notice, 'done')), 'not-a-message')
    assert.equal(codeOf(await react('B', reaction, 'done')), 'not-a-message')
    SLOTS.Z = slot('Z', 'estranho')
    assert.equal(codeOf(await run(reactVerb, 'Z', { canal: 'obra', seq: msg, reaction: 'done' })), 'not-member')
    assert.equal(codeOf(await run(reactVerb, 'A', { canal: 'obra', reaction: 'done' })), 'bad-request')
  })

  test('the muted reacts with the five and is refused (muted) with a free emoji', async () => {
    const seq = (await ch.store.history(id)).find((l) => l.kind === 'message')!.seq
    assert.equal(codeOf(await react('M', seq, '🎉')), 'muted')
    const r = await react('M', seq, 'seen')
    assert.equal(r.isError, undefined, r.text)
    assert.match(r.text, /^Reagiu 👀/)
  })

  test('limits: 3 emojis per member on a line (a 4th answers limit); the line carries the emojis of every member', async () => {
    const said = await ch.say('A', id, { body: 'fala dos limites' })
    assert.ok(said.ok)
    const seq = said.line.seq
    for (const e of ['🎉', '🔥', '🚀']) assert.equal((await react('A', seq, e)).isError, undefined, e)
    assert.equal(codeOf(await react('A', seq, '🌟')), 'limit', 'a 4th emoji of the same member')
    assert.equal((await react('A', seq, '🎉', true)).isError, undefined, 'taking one away frees the slot')
    assert.equal((await react('A', seq, '🌟')).isError, undefined)
    for (const e of ['😀', '😁', '😂']) assert.equal((await react('B', seq, e)).isError, undefined, e)
    const sum = sumReactions(await ch.store.since(id, seq - 1)).get(seq)!
    assert.deepEqual(sum.map((t) => t.emoji), ['🔥', '🚀', '🌟', '😀', '😁', '😂'])
  })

  test('slow-down: the 11th gesture of a member in a minute in one channel', async () => {
    // The count is per member AND channel: a channel of its own starts the person's minute at zero.
    const made = await ch.create('A', { name: 'taxa' })
    assert.ok(made.ok)
    const said = await ch.say('A', made.channel.id, { body: 'fala da taxa' })
    assert.ok(said.ok)
    const seq = said.line.seq
    let refused: unknown
    let done = 0
    for (let i = 0; i < 14 && !refused; i++) {
      const r = await ch.react(USER, made.channel.id, { seq, reaction: 'agree', remove: i % 2 === 1 })
      if (r.ok) done++
      else refused = r.error
    }
    assert.equal(refused, 'slow-down')
    assert.equal(done, 10, 'ten gestures pass, the eleventh is refused')
  })

  test('read: the reaction in brackets on its line, reaction lines hidden, structured reactions, `end` counts them', async () => {
    const said = await ch.say('A', id, { body: 'para o read' })
    assert.ok(said.ok)
    const seq = said.line.seq
    assert.ok((await ch.react(USER, id, { seq, reaction: 'agree' })).ok)
    const r = await run(readVerb, 'B', { canal: 'obra', limit: 5 })
    const data = r.data as { lines: Array<Line & { reactions?: Array<{ emoji: string; name?: string; by: string[] }> }>; end: number }
    assert.equal(data.lines.some((l) => l.kind === 'reaction'), false)
    const mine = data.lines.find((l) => l.seq === seq)!
    assert.deepEqual(mine.reactions, [{ emoji: '👍', name: 'agree', by: [ch.nameOf(USER)] }])
    assert.match(r.text, new RegExp(`${seq} alfa: para o read  \\[👍 ${ch.nameOf(USER)}\\]`))
    assert.equal(data.end, await ch.store.lastSeq(id))
  })

  test('read --since: new reactions to lines before the stretch come in a last line', async () => {
    const said = await ch.say('A', id, { body: 'antiga' })
    assert.ok(said.ok)
    const cut = await ch.store.lastSeq(id)
    assert.ok((await ch.react(USER, id, { seq: said.line.seq, reaction: 'done' })).ok)
    const r = await run(readVerb, 'B', { canal: 'obra', since: cut })
    assert.match(r.text, new RegExp(`^reações novas em falas anteriores: ${said.line.seq} ✅ ${ch.nameOf(USER)}$`))
    assert.deepEqual((r.data as { earlier: unknown }).earlier, [{ seq: said.line.seq, reactions: [{ emoji: '✅', name: ch.nameOf(USER) }] }])
  })

  test('the window: a message beyond the last 500 lines answers too-old; the record survives a reopen of the store', async () => {
    const old = await ch.say('A', id, { body: 'vai envelhecer' })
    assert.ok(old.ok)
    assert.ok((await ch.react(USER, id, { seq: old.line.seq, reaction: 'seen' })).ok)
    for (let i = 0; i < 500; i++) await ch.store.append(id, { kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body: `n${i}` })
    const r = await ch.react(USER, id, { seq: old.line.seq, reaction: 'agree' })
    assert.deepEqual(r.ok ? 'ok' : r.error, 'too-old')
    // After a restart (a new store over the same files) the sum is the same.
    const again = await openStore(fsIo, home)
    const sum = sumReactions(await again.since(id, old.line.seq - 1, 600)).get(old.line.seq)!
    assert.deepEqual(sum.map((t) => t.emoji), ['👀'])
  })

  test('a closed channel takes neither a put nor a take away', async () => {
    const said = await ch.say('A', id, { body: 'última' })
    assert.ok(said.ok)
    assert.ok((await ch.react(USER, id, { seq: said.line.seq, reaction: 'seen' })).ok)
    assert.ok((await ch.close(USER, id)).ok)
    assert.equal(codeOf(await run(reactVerb, 'B', { canal: id, seq: said.line.seq, reaction: 'agree' })), 'closed')
    const put = await ch.react('B', id, { seq: said.line.seq, reaction: 'agree' })
    const take = await ch.react(USER, id, { seq: said.line.seq, reaction: 'seen', remove: true })
    assert.deepEqual([put.ok ? 'ok' : put.error, take.ok ? 'ok' : take.error], ['closed', 'closed'])
  })
})
