// The channels' pure rules (extensions/channels/rules.ts): the roles derived from the channel's data (owner, member,
// moderator, muted), what each may do in an open and in a closed channel, the desk channel, and the room names.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentOwnerOf, closeRefusal, deliveryRoleOf, deskChannelId, isDeskChannel, isMember, isModerator, isMuted, isRoomName, joinRefusal,
  joinsByDesk, mayModerate, mayRead, maySay, ownerOf, reopenRefusal, roleIn, sayRefusal, slugOf, USER, type Channel, type Member,
} from '../../extensions/channels/rules.ts'

const AT = '2026-11-22T12:00:00.000Z'
const member = (name: string, extra: Partial<Member> = {}): Member => ({ since: AT, by: 'self', name, ...extra })

/** a1 owns; b2 is a member; c3 is muted; d4 is outside. */
function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: 'c_1', name: 'obra', title: 'obra', owner: { kind: 'agent', id: 'a1', name: 'claude · conferente' }, createdAt: AT, createdBy: 'a1',
    members: { a1: member('claude · conferente'), b2: member('soul · bancada'), c3: member('codex · conferência', { muted: { since: AT, by: USER } }) },
    seenByUser: 0, ...over,
  }
}

const live = channel()
const forgotten = channel({ ownerEnded: { at: AT, name: 'claude · conferente' } })
const left = channel({ members: { b2: member('soul · bancada'), c3: member('codex · conferência', { muted: { since: AT, by: USER } }) } })
const byUser = channel({ owner: { kind: 'user' }, createdBy: USER, members: { b2: member('soul · bancada', { by: USER }) } })
const closed = channel({ closed: { at: AT, by: 'a1' } })
const desk = channel({ id: deskChannelId('d1'), desk: 'd1', removed: ['e5'] })

describe('channels: roles', () => {
  const cases: Array<[string, Channel, string, ReturnType<typeof roleIn>, boolean, boolean]> = [
    // [case, channel, who, role, mayModerate, maySay]
    ['live agent owner: owner', live, 'a1', 'owner', true, true],
    ['live agent owner: member', live, 'b2', 'member', false, true],
    ['live agent owner: muted member hears and does not speak', live, 'c3', 'member', false, false],
    ['live agent owner: outsider', live, 'd4', undefined, false, false],
    ['live agent owner: moderator', live, USER, 'moderator', true, true],
    ['forgotten owner: the old owner (still listed) commands nothing', forgotten, 'a1', 'member', false, true],
    ['forgotten owner: moderator', forgotten, USER, 'moderator', true, true],
    ['owner left: not a member, not an owner', left, 'a1', undefined, false, false],
    ['owner left: moderator', left, USER, 'moderator', true, true],
    ['user owner: member', byUser, 'b2', 'member', false, true],
    ['user owner: moderator', byUser, USER, 'moderator', true, true],
    ['closed: owner still moderates, nobody speaks', closed, 'a1', 'owner', true, false],
    ['closed: moderator does not speak either', closed, USER, 'moderator', true, false],
    ['closed: member', closed, 'b2', 'member', false, false],
    ['desk channel: owner', desk, 'a1', 'owner', true, true],
    ['desk channel: moderator', desk, USER, 'moderator', true, true],
  ]
  for (const [name, ch, who, role, moderates, says] of cases) {
    test(name, () => {
      assert.equal(roleIn(who, ch), role)
      assert.equal(mayModerate(who, ch), moderates)
      assert.equal(maySay(who, ch), says)
      assert.equal(mayRead(who, ch), true)
    })
  }

  test('ownerOf: the live agent; the person when the owner was forgotten, left, or never was an agent', () => {
    assert.deepEqual(ownerOf(live), { kind: 'agent', id: 'a1', name: 'claude · conferente' })
    assert.deepEqual(ownerOf(forgotten), { kind: 'user' })
    assert.deepEqual(ownerOf(left), { kind: 'user' })
    assert.deepEqual(ownerOf(byUser), { kind: 'user' })
    assert.deepEqual(ownerOf(closed), { kind: 'agent', id: 'a1', name: 'claude · conferente' })
    assert.equal(agentOwnerOf(live), 'a1')
    assert.equal(agentOwnerOf(forgotten), undefined)
  })

  test('the moderator is the person in every channel and never a member', () => {
    for (const ch of [live, forgotten, left, byUser, closed, desk]) {
      assert.equal(isModerator(USER), true)
      assert.equal(isMember(ch, USER), false)
      assert.equal(roleIn(USER, ch), 'moderator')
    }
    assert.equal(isModerator('a1'), false)
    assert.equal(isMember(live, 'toString'), false, 'an inherited key is no member')
    assert.equal(isMuted(live, 'c3'), true)
    assert.equal(isMuted(live, 'b2'), false)
    assert.equal(isMuted(live, 'd4'), false)
  })

  test('sayRefusal names why', () => {
    assert.equal(sayRefusal('b2', live), undefined)
    assert.equal(sayRefusal('c3', live), 'muted')
    assert.equal(sayRefusal('d4', live), 'not-member')
    assert.equal(sayRefusal('b2', closed), 'closed')
    assert.equal(sayRefusal(USER, closed), 'closed')
  })

  test('the envelope: an owner speaks as a member', () => {
    assert.equal(deliveryRoleOf('owner'), 'member')
    assert.equal(deliveryRoleOf('member'), 'member')
    assert.equal(deliveryRoleOf('moderator'), 'moderator')
    assert.equal(deliveryRoleOf('system'), 'system')
  })
})

describe('channels: joining, closing and reopening', () => {
  test('an agent joins itself to any open channel; joining another takes the owner or the moderator', () => {
    assert.equal(joinRefusal('d4', live), undefined)
    assert.equal(joinRefusal('d4', live, 'd4'), undefined)
    assert.equal(joinRefusal('b2', live, 'd4'), 'not-owner')
    assert.equal(joinRefusal('a1', live, 'd4'), undefined)
    assert.equal(joinRefusal(USER, live, 'd4'), undefined)
    assert.equal(joinRefusal('a1', forgotten, 'd4'), 'not-owner')
    assert.equal(joinRefusal(USER, forgotten, 'd4'), undefined)
    assert.equal(joinRefusal('e5', desk), undefined, 'a removed agent may join itself again')
    assert.equal(joinRefusal('d4', closed), 'closed')
    assert.equal(joinRefusal(USER, closed, 'd4'), 'closed')
  })

  test('close: the owner or the moderator, once', () => {
    assert.equal(closeRefusal('a1', live), undefined)
    assert.equal(closeRefusal(USER, live), undefined)
    assert.equal(closeRefusal('b2', live), 'not-owner')
    assert.equal(closeRefusal('a1', forgotten), 'not-owner')
    assert.equal(closeRefusal(USER, closed), 'closed')
  })

  test('reopen: a closed common channel by its owner or the moderator; a desk channel only follows its desk', () => {
    assert.equal(reopenRefusal('a1', closed), undefined)
    assert.equal(reopenRefusal(USER, closed), undefined)
    assert.equal(reopenRefusal('b2', closed), 'not-owner')
    assert.equal(reopenRefusal(USER, live), 'not-closed')
    const closedForgotten = channel({ closed: { at: AT, by: USER }, ownerEnded: { at: AT, name: 'claude · conferente' } })
    assert.equal(reopenRefusal('a1', closedForgotten), 'not-owner')
    assert.equal(reopenRefusal(USER, closedForgotten), undefined)
    const closedDesk = channel({ id: deskChannelId('d1'), desk: 'd1', closed: { at: AT, by: USER } })
    assert.equal(reopenRefusal(USER, closedDesk), 'desk')
    assert.equal(reopenRefusal('a1', closedDesk), 'desk')
  })

  test('the desk channel: marked by `desk`, id desk_<deskId>; the desk brings in its panes, except the removed', () => {
    assert.equal(deskChannelId('d1'), 'desk_d1')
    assert.equal(isDeskChannel(desk), true)
    assert.equal(isDeskChannel(channel({ name: 'mesa-obra' })), false, 'the name says nothing')
    assert.equal(joinsByDesk(desk, 'd4'), true)
    assert.equal(joinsByDesk(desk, 'e5'), false)
    assert.equal(joinsByDesk(desk, 'b2'), false)
    assert.equal(joinsByDesk(live, 'd4'), false)
  })
})

describe('channels: room names', () => {
  test('isRoomName: lowercase letters, digits and hyphens, 1 to 40, no hyphen at the ends', () => {
    for (const ok of ['obra', 'a', 'mesa-cena', 'canal-2', '42', 'a'.repeat(40)]) assert.equal(isRoomName(ok), true, ok)
    for (const bad of ['', 'Obra', 'obra cena', 'ação', '-obra', 'obra-', 'obra_cena', '#obra', 'a'.repeat(41), 'obra\n']) assert.equal(isRoomName(bad), false, JSON.stringify(bad))
  })

  test('slugOf: accents dropped, spaces and symbols one hyphen, lowercase, cut to 40', () => {
    const cases: Array<[string, string]> = [
      ['obra', 'obra'],
      ['Conferência de Ação', 'conferencia-de-acao'],
      ['  São   João  ', 'sao-joao'],
      ['claude · conferente', 'claude-conferente'],
      ['Mesa—Cena #2!', 'mesa-cena-2'],
      ['ÇÃÕ', 'cao'],
      ['', 'canal'],
      ['···', 'canal'],
      ['x'.repeat(39) + ' y', 'x'.repeat(39)],
    ]
    for (const [text, slug] of cases) {
      assert.equal(slugOf(text), slug, text)
      assert.equal(isRoomName(slugOf(text)), true, text)
    }
  })

  test('slugOf: a taken name gets the first free suffix, and still fits in 40', () => {
    assert.equal(slugOf('Obra', new Set(['obra'])), 'obra-2')
    assert.equal(slugOf('Obra', new Set(['obra', 'obra-2', 'obra-3'])), 'obra-4')
    assert.equal(slugOf('Obra', new Set(['obra-2'])), 'obra')
    const long = 'a'.repeat(40)
    assert.equal(slugOf(long, new Set([long])), 'a'.repeat(38) + '-2')
    const cut = 'a'.repeat(36) + '-bcd'
    assert.equal(slugOf(cut, new Set([cut])), 'a'.repeat(36) + '-b-2')
    const edge = 'a'.repeat(38) + '-b'
    assert.equal(slugOf(edge, new Set([edge])), 'a'.repeat(38) + '-2', 'no hyphen pair where the base is cut')
  })
})

describe('channels in both hosts', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const importsOf = (rel: string): string[] => [...readFileSync(join(root, rel), 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/g)].map(m => m[1]!)

  test('rules.ts imports nothing; the renderer entry reaches no daemon code', () => {
    assert.deepEqual(importsOf('extensions/channels/rules.ts'), [])
    for (const spec of importsOf('extensions/channels/renderer.ts')) assert.ok(!/src\/|daemon/.test(spec), spec)
  })

  test('the indexes list channels in both hosts', () => {
    assert.ok(readFileSync(join(root, 'extensions/index.daemon.ts'), 'utf8').includes(`'./channels/daemon.ts'`))
    assert.ok(readFileSync(join(root, 'extensions/index.renderer.ts'), 'utf8').includes(`'./channels/renderer.ts'`))
  })
})
