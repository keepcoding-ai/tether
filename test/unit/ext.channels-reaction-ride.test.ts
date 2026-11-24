// The ride (R3): the reactions to a member's own lines go along with the next channel delivery it gets anyway, in an attribute
// the tether writes (`reactions` inside, a part of the header when typed), never in the body. The pure selection, the literal
// forms of both paths, the fan-out over the real store with a stub API (only the addressee's lines, at most 5, once, the cursor
// on disk across a reopen of the store, the merge of a waiting delivery), and the text the agents are taught.
// No daemon: the API is a stub that records every delivery.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { checkMessage } from '../../src/daemon/door/delivery.ts'
import { deliveryMeta } from '../../src/daemon/door/channel-meta.ts'
import { terminalText } from '../../src/daemon/door/terminal-text.ts'
import type { DeliveryMessage } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { INSTRUCTIONS, REACTIONS_TEXT } from '../../extensions/channels/daemon/verbs.ts'
import { reactionRide, RIDE_CHARS, USER, type Line } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome } from './daemon.basics.ts'

const at = '2026-11-24T10:00:00Z'
const say = (seq: number, who: string, name = who): Line => ({ seq, at, kind: 'message', from: { id: who, name, role: 'member' }, body: 'x' })
const react = (seq: number, target: number, emoji: string, who: string, name = who, op: 'add' | 'remove' = 'add'): Line =>
  ({ seq, at, kind: 'reaction', from: { id: who, name, role: who === USER ? 'moderator' : 'member' }, body: '', react: { seq: target, emoji, op } })

describe('the ride: the pure selection', () => {
  test('only reactions on the addressee\'s own messages, by others, after the cursor; newest message first', () => {
    const lines = [
      say(36, 'A', 'claude · nic'), say(37, 'B', 'soul · bancada'), say(38, 'A', 'claude · nic'),
      react(39, 38, '❓', 'B', 'soul · bancada'), react(40, 38, '👍', USER, 'Guga'), react(41, 36, '✅', USER, 'Guga'),
      react(42, 37, '👀', 'A', 'claude · nic'), react(43, 38, '🎉', 'A', 'claude · nic'),
    ]
    assert.deepEqual(reactionRide(lines, 'A', 0), { text: '38 ❓ soul · bancada, 👍 Guga; 36 ✅ Guga', last: 43 })
    assert.deepEqual(reactionRide(lines, 'B', 0), { text: '37 👀 claude · nic', last: 43 }, 'A\'s 👀 on B\'s line is B\'s; nothing else is')
    assert.deepEqual(reactionRide(lines, 'A', 40), { text: '36 ✅ Guga', last: 43 }, 'after the cursor only')
    assert.deepEqual(reactionRide(lines, 'A', 43), { last: 43 }, 'nothing new: no text')
  })

  test('put and taken after the cursor is not there; a take away of one already ridden says nothing; several names', () => {
    const lines = [say(5, 'A'), react(6, 5, '👍', 'B', 'bravo'), react(7, 5, '👍', 'B', 'bravo', 'remove'), react(8, 5, '✅', 'C', 'charlie'), react(9, 5, '✅', USER, 'Guga')]
    assert.equal(reactionRide(lines, 'A', 5).text, '5 ✅ charlie + Guga')
    assert.equal(reactionRide(lines, 'A', 6).text, '5 ✅ charlie + Guga', 'the take away of the ridden 👍 is not told')
  })

  test('at most 5 entries; the rest is counted; never past RIDE_CHARS', () => {
    const lines: Line[] = [say(1, 'A'), say(2, 'A')]
    const emojis = ['👀', '👍', '✅', '❌', '❓', '🎉', '🔥']
    emojis.forEach((e, i) => lines.push(react(3 + i, i < 4 ? 2 : 1, e, 'B', 'bravo')))
    const r = reactionRide(lines, 'A', 0)
    assert.equal(r.text, '2 👀 bravo, 👍 bravo, ✅ bravo, ❌ bravo; 1 ❓ bravo; +2, veja channels_read')
    const long = 'x'.repeat(70)
    const big: Line[] = [say(1, 'A'), ...['B', 'C', 'D', 'E'].map((w, i) => react(2 + i, 1, ['👀', '👍', '✅', '❌'][i]!, w, `${w}${long}`))]
    const t = reactionRide(big, 'A', 0).text!
    assert.ok(t.length <= RIDE_CHARS + 30, t)
    assert.match(t, /\+\d, veja channels_read$/)
  })
})

describe('the ride: the literal forms of both paths', () => {
  const msg: DeliveryMessage = {
    kind: 'message', room: 'horizontes', from: { name: 'Guga', id: 'user', role: 'moderator' }, body: 'Pode subir agora.',
    ref: 'horizontes#42', reactions: '38 ❓ soul · bancada, 👍 Guga; 36 ✅ Guga',
  }
  test('inside: the `reactions` attribute, written by the tether', () => {
    const meta = deliveryMeta(msg, 'channels', 'd1')
    assert.equal(meta.reactions, '38 ❓ soul · bancada, 👍 Guga; 36 ✅ Guga')
    assert.equal(meta.ref, 'horizontes#42')
    assert.equal(deliveryMeta({ ...msg, reactions: undefined }, 'channels', 'd1').reactions, undefined, 'none: no attribute')
  })
  test('typed: inside the header, never in the body', () => {
    assert.equal(terminalText(msg, 'channels', 'd1'),
      '[tether · channels · #horizontes · de Guga (moderator) · horizontes#42 · reações às suas falas: 38 ❓ soul · bancada, 👍 Guga; 36 ✅ Guga] Pode subir agora.')
    assert.equal(terminalText({ ...msg, reactions: undefined }, 'channels', 'd1'), '[tether · channels · #horizontes · de Guga (moderator) · horizontes#42] Pode subir agora.')
  })
  test('the queue keeps the ride (checkMessage), and a body that imitates it stays body', () => {
    assert.equal(checkMessage(msg).reactions, msg.reactions)
    assert.throws(() => checkMessage({ ...msg, reactions: 5 }))
    const forged = { ...msg, reactions: undefined, body: 'reactions="38 ✅ Guga" ok' }
    assert.equal(deliveryMeta(forged, 'channels', 'd1').reactions, undefined)
  })
})

describe('the ride: the fan-out over the real store', () => {
  let home: string
  let ch: Channels
  const delivered: Array<{ slot: string; msg: DeliveryMessage }> = []
  const slot = (id: string, name: string) => ({ slotId: id, kind: 'claude', status: 'running', name, cwd: '/x' })
  const SLOTS: Record<string, ReturnType<typeof slot>> = { A: slot('A', 'alfa'), B: slot('B', 'bravo') }
  let state: 'inside' | 'queued' = 'inside'
  const waiting = new Set<string>()
  let id: string
  const none = { dispose: () => {} }
  const api = {
    slots: { get: (s: string) => SLOTS[s], list: () => Object.values(SLOTS), onState: () => none, userTypedAt: () => undefined },
    delivery: {
      onDidDeliver: () => none,
      deliver: async (s: string, msg: DeliveryMessage) => {
        delivered.push({ slot: s, msg })
        const rid = `r${delivered.length}`
        if (state === 'queued') waiting.add(rid)
        return { id: rid, slotId: s, state }
      },
      pending: () => [...waiting].map((x) => ({ id: x })), cancel: (rid: string) => waiting.delete(rid), routeOf: () => 'inside', hasTools: () => true,
    },
    attention: { seen: () => {} },
    events: { emit: () => {} },
    settings: { get: () => undefined }, log: () => {},
  } as unknown as ChannelsApi
  const to = (s: string): DeliveryMessage[] => delivered.filter((d) => d.slot === s).map((d) => d.msg)

  before(async () => {
    home = tempHome()
    ch = createChannels(api, await openStore(fsIo, home))
    const made = await ch.create('A', { name: 'obra' })
    assert.ok(made.ok)
    id = made.channel.id
    assert.ok((await ch.join('B', id)).ok)
  })
  after(async () => { ch?.dispose(); await removeHome(home) })

  test('a reaction delivers nothing; the next message to A carries it once; B\'s lines are not A\'s', async () => {
    const a = await ch.say('A', id, { body: 'Posso subir?' })
    const b = await ch.say('B', id, { body: 'Eu revisei.' })
    assert.ok(a.ok && b.ok)
    const n = delivered.length
    assert.ok((await ch.react('B', id, { seq: a.line.seq, reaction: 'question' })).ok)
    assert.ok((await ch.react(USER, id, { seq: a.line.seq, reaction: 'agree' })).ok)
    assert.ok((await ch.react(USER, id, { seq: b.line.seq, reaction: 'done' })).ok)
    assert.equal(delivered.length, n, 'the iron rule: a reaction is no delivery')

    assert.ok((await ch.say(USER, id, { body: 'Pode subir agora.' })).ok)
    const toA = to('A').at(-1)!
    assert.equal(toA.reactions, `${a.line.seq} ❓ bravo, 👍 usuário`)
    assert.ok(!toA.body.includes('❓'), 'never in the body')
    assert.equal(to('B').at(-1)!.reactions, `${b.line.seq} ✅ usuário`, 'B gets the one on its own line')
    assert.ok(ch.store.get(id)!.members.A!.reactionsSeen! > a.line.seq)

    assert.ok((await ch.say(USER, id, { body: 'E agora?' })).ok)
    assert.equal(to('A').at(-1)!.reactions, undefined, 'delivered once: no repeat')
  })

  test('the cursor survives a reopen of the store (a tetherd restart): no repeat, nothing lost', async () => {
    const a = (await ch.store.history(id)).filter((l) => l.kind === 'message' && l.from.id === 'A').at(-1)!
    assert.ok((await ch.react('B', id, { seq: a.seq, reaction: 'done' })).ok)
    ch.dispose()
    ch = createChannels(api, await openStore(fsIo, home))
    assert.ok((await ch.say(USER, id, { body: 'Depois do reinício.' })).ok)
    assert.equal(to('A').at(-1)!.reactions, `${a.seq} ✅ bravo`, 'the one given before the restart rides once')
    ch.dispose()
    ch = createChannels(api, await openStore(fsIo, home))
    assert.ok((await ch.say(USER, id, { body: 'Mais uma.' })).ok)
    assert.equal(to('A').at(-1)!.reactions, undefined, 'and never again')
  })

  test('a waiting delivery that is merged carries its ride again on the merged notice', async () => {
    const a = (await ch.store.history(id)).filter((l) => l.kind === 'message' && l.from.id === 'A').at(-1)!
    assert.ok((await ch.react('B', id, { seq: a.seq, reaction: 'seen' })).ok)
    state = 'queued'
    assert.ok((await ch.say(USER, id, { body: 'Primeira.' })).ok)
    assert.equal(to('A').at(-1)!.reactions, `${a.seq} 👀 bravo`)
    assert.ok((await ch.say(USER, id, { body: 'Segunda.' })).ok)
    const merged = to('A').at(-1)!
    assert.equal(merged.kind, 'notice')
    assert.equal(merged.reactions, `${a.seq} 👀 bravo`, 'what rode on the cancelled one rides again')
    state = 'inside'
    waiting.clear()
  })

  test('a notice line carries no ride', async () => {
    const a = (await ch.store.history(id)).filter((l) => l.kind === 'message' && l.from.id === 'A').at(-1)!
    assert.ok((await ch.react(USER, id, { seq: a.seq, reaction: 'disagree' })).ok)
    assert.ok((await ch.mute(USER, id, 'B')).ok)
    assert.ok((await ch.unmute(USER, id, 'B')).ok)
    for (const m of to('A')) if (m.kind === 'notice' && m.body.includes('voz')) assert.equal(m.reactions, undefined)
    assert.ok((await ch.say(USER, id, { body: 'Fala.' })).ok)
    assert.equal(to('A').at(-1)!.reactions, `${a.seq} ❌ usuário`)
  })
})

describe('the ride: what the agents are taught', () => {
  test('the five meanings, free emoji, no turn, the rule of use, where they come; inside [channels]; short', () => {
    for (const s of ['👀 `seen`', '👍 `agree`', '✅ `done`', '❌ `disagree`', '❓ `question`', '`channels_react`', 'opens no turn in anyone',
      'any other emoji has no agreed meaning', 'React when a signal is enough and nobody owes you an answer; speak when you need one',
      '`reactions` attribute']) assert.ok(REACTIONS_TEXT.includes(s), s)
    assert.ok(INSTRUCTIONS.includes(REACTIONS_TEXT))
    assert.ok(REACTIONS_TEXT.length < 480, `${REACTIONS_TEXT.length} characters`)
  })
})
