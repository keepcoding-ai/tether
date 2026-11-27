// What leaves the portal for a device goes through a projection by ALLOW list (RR2.1; plano §2 "Segredos"): field by field,
// never a spread object of the pipe. The canary: a unique marker in the env of a process and of a profile, and in
// secret-looking arguments (and in fields the pipe might add later), goes through every projection and through a real
// House driven in process; the marker shows in no projected value and in no frame's plaintext (the content of each record
// before the cipher, read where the device decrypts it).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  accessFromCode, CERT_ROLE_TICKET, decodeEvt, decodeOuter, decodeRes, DevicePairing, encodeOuter, encodeReq, generateRoleKey,
  issueKeyCert, OP_CODES, PAIR_STATE, PRESENCE, RES_STATUS, ROUTE_KIND, type Bytes, type Session, type SessionEffect,
} from '../../src/remote/index.ts'
import {
  ATTENTION_MAX, attentionItem, attentionList, CHANGED_IDS_MAX, channelsChanged, channelsMarks, channelsPage, emptyBody, errorBody,
  eventBody, LINE_BODY_MAX, MARKS_MAX, PAGE_BYTES_MAX, PAGE_LINES_MAX, regencyChanged, regencyTree, remoteProc, remoteProfile, resultBody,
  RESULTS, sessionInfo, type MarkRowSource, type ProcSource, type ProfileSource, type RegencyTree, type SlotSource,
} from '../../src/remote/projection.ts'
import { utf8 } from '../../src/remote/bytes.ts'
import type { RemoteMarks } from '../../extensions/channels/daemon/marks.ts'
import type { Line } from '../../extensions/channels/rules.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { House } from '../../src/remoted/house.ts'
import { toEmbedProc, type EmbedProc } from '../../extensions/processes/embed.ts'
import { remoteInputOf } from '../../extensions/regency/remote-input.ts'
import { TreeKeeper } from '../../extensions/regency/daemon.ts'
import type { RegencyInput } from '../../extensions/regency/model.ts'
import { publishedTreeOf, STALE_MS } from '../../extensions/regency/publish-rules.ts'
import { TreePublisher } from '../../extensions/regency/renderer/publish.ts'
import type { Profile } from '../../src/core/profile.ts'
import type { ProcState } from '../../src/daemon/procs.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { until } from './remoted.helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MARKER = `canary${randomBytes(12).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const bytesHave = (b: Uint8Array): boolean => Buffer.from(b).toString('latin1').includes(MARKER)
const decode = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b))
const ISO = '2026-11-27T10:00:00.000Z'

// The pipe's types fit the projection's sources (a field renamed in the pipe breaks this at compile time).
const fits = (p: ProcState, e: EmbedProc, f: Profile, s: SlotState): [ProcSource, ProcSource, ProfileSource, SlotSource] => [p, e, f, s]
void fits

/** Fields a later version of the pipe might add: none of them may ever reach a device. */
const later = (): Record<string, unknown> => ({ variables: { LATER: MARKER }, argv: ['--token', MARKER], request: MARKER, secret: MARKER })

function hostileProc(): ProcState {
  const p: ProcState = {
    name: 'web', status: 'running', run: 3, pid: 4242, startedAt: ISO,
    startedBy: { kind: 'agent', slotId: 's1', name: 'Atrium', agent: 'claude', sessionId: MARKER, user: MARKER, label: MARKER },
    card: {
      v: 1, name: 'web', command: 'node', cwd: 'C:/proj/web', ports: [3000], stopGraceMs: 5000, description: 'servidor web',
      args: ['server.js', '--token', MARKER, `API_KEY=${MARKER}`, `--password=${MARKER}`, `-c "GITHUB_TOKEN=${MARKER} run"`],
      env: { PORT: MARKER, GITHUB_TOKEN: MARKER, PLAIN_VALUE: MARKER },
      info: { apiKey: MARKER, url: `https://user:${MARKER}@example.test/` },
      registeredBy: { kind: 'agent', name: 'Atrium', sessionId: MARKER, user: MARKER }, createdAt: ISO,
    },
    ports: [{ port: 3000, listening: true }], memoryMB: 120, attention: true,
  }
  Object.assign(p, later(), { uses: [{ by: MARKER, purpose: MARKER }] })
  Object.assign(p.card, later())
  return p
}

function hostileProfile(): Profile {
  const f: Profile = {
    id: 'dev', name: 'Dev', agent: 'claude', default: true, cwd: 'C:/proj',
    args: ['--token', MARKER, `--api-key=${MARKER}`, `ANTHROPIC_API_KEY=${MARKER}`],
    env: { ANTHROPIC_API_KEY: MARKER, PLAIN: MARKER },
    shell: { command: 'pwsh', args: ['-c', `API_KEY=${MARKER} run --password ${MARKER}`] },
    extensions: { browser: { secret: MARKER } },
  }
  Object.assign(f, later())
  return f
}

function hostileSlot(slotId: string): SlotState {
  const s: SlotState = {
    slotId, kind: 'claude', name: 'Agente de teste', cwd: `C:/${MARKER}/proj`, folder: `C:/${MARKER}/proj`, status: 'running',
    attention: 'waiting', error: { code: 'cwd-missing', message: MARKER },
  } as SlotState
  Object.assign(s, later(), { env: { GITHUB_TOKEN: MARKER }, args: ['--token', MARKER], binding: { sessionId: MARKER }, profileName: 'Dev' })
  return s
}

describe('projections by allow list', () => {
  test('a process carries at most what toEmbedProc lets through: no env value, no args, no info, no OS user', () => {
    const p = hostileProc()
    const out = remoteProc(p)
    assert.equal(has(out), false, 'the marker reaches no field')
    assert.deepEqual(out.envNames, ['PORT', 'GITHUB_TOKEN', 'PLAIN_VALUE'])
    assert.deepEqual(out.card, { command: 'node', cwd: 'C:/proj/web', ports: [3000], createdAt: ISO, description: 'servidor web', registeredBy: { kind: 'agent', name: 'Atrium' } })
    const embed = toEmbedProc(p)
    for (const k of Object.keys(out)) assert.ok(k in embed, `${k} is a field toEmbedProc keeps`)
    for (const k of Object.keys(out.card)) assert.ok(k in embed.card, `card.${k} is a field toEmbedProc keeps`)
    assert.equal(has(remoteProc(embed)), false, 'the same through toEmbedProc first')
  })

  test('a profile carries the env by names only, and neither its args nor its extensions', () => {
    const out = remoteProfile(hostileProfile())
    assert.equal(has(out), false)
    assert.deepEqual(out, { id: 'dev', name: 'Dev', agent: 'claude', envNames: ['ANTHROPIC_API_KEY', 'PLAIN'], cwd: 'C:/proj', shell: { command: 'pwsh' }, default: true })
  })

  test('a waiting slot is id, name, kind and since; its folder, error, binding and any later field stay home', () => {
    const slot = hostileSlot('slot-1')
    const item = attentionItem(slot, ISO)
    assert.deepEqual(item, { id: 'slot-1', name: 'Agente de teste', kind: 'claude', since: ISO })
    const view = new AttentionView(() => Date.parse(ISO))
    view.reset([slot, hostileSlot('bad id with spaces'), { ...hostileSlot('slot-2'), attention: 'done' } as SlotState])
    const items = view.items()
    assert.deepEqual(items.items.map(i => i.id), ['slot-1'])
    assert.equal(has(items), false)
    assert.equal(has(remoteInputOf({ slots: [slot] })), false, "the Regency's floor for a remote screen keeps none of it either")
  })

  test("the Regency's published tree: no env, profile or path the app holds is published, kept or read back", async () => {
    // Every object of the entry carries fields the app might hold beside the allowed ones (an env, a profile, args, a
    // folder, a later field); the allow list copies none of them, the app sends none, tetherd keeps and gives none.
    const leak = (): Record<string, unknown> => ({
      ...later(), env: { GITHUB_TOKEN: MARKER }, profile: hostileProfile(), args: ['--token', MARKER], cwd: `C:/${MARKER}`, folder: `C:/${MARKER}`, keyPath: `C:/${MARKER}/.keys`,
    })
    const pane = { id: 'a1', type: 'agent', icon: 'claude', title: 'Agente', lines: [MARKER], ...leak() }
    const desk = { id: 'desk-1', name: 'Mesa', color: 'blue', kind: 'queue', asleep: false, panes: [pane], ...leak() }
    const entry = {
      desks: { desks: [desk], ...leak() },
      owners: { desk: { 'desk-1': { id: 'a1', name: 'Agente', ...leak() } }, pane: {}, ...leak() },
      channels: [{ id: 'c1', name: 'geral', title: 'Geral', owner: { kind: 'agent', id: 'a1', name: 'Agente', ...leak() }, members: 2, seenByUser: 0, createdAt: ISO, closed: { at: ISO, by: 'user', ...leak() }, ...leak() }],
      channelMarks: { c1: { unread: 1, toMe: 0, asks: 0, owed: 0, first: { why: 'to-you', text: 'oi', ...leak() }, ...leak() } },
      agents: [{ id: 'a1', kind: 'claude', name: 'Agente', emblem: { name: 'e', color: 'red', icon: 'star', ...leak() }, ...leak() }],
      since: { 'agent:a1': 1 }, collapsed: [MARKER], query: MARKER, selfDeskId: 'regency.main',
      closed: [{ slotId: 's9', kind: 'claude', name: 'Velha', ...leak() }],
      ...leak(),
    } as unknown as RegencyInput
    const tree = publishedTreeOf(entry)
    assert.equal(has(tree), false, JSON.stringify(tree))
    assert.equal(tree.desks.desks[0]!.panes[0]!.title, 'Agente', 'the allowed fields do go')

    const sent: unknown[] = []
    let now = Date.parse(ISO)
    const keeper = new TreeKeeper({ now: () => now, live: () => ({ slots: [hostileSlot('a1'), hostileSlot('s2')] }), setTimer: () => 0, clearTimer: () => {} })
    const pub = new TreePublisher({ read: () => entry, send: async (a) => { sent.push(a); return keeper.publish(a, { client: 'app' }) }, setInterval: () => 0, clearInterval: () => {}, log: () => {} })
    await pub.flush()
    pub.dispose()
    assert.equal(sent.length, 1)
    assert.equal(has(sent), false, 'nothing of it goes over the pipe')
    // tetherd projects again what arrives: a hostile client that skips the app's projection keeps nothing either.
    keeper.publish({ tree: entry }, { client: 'app' })
    assert.equal(has(keeper.kept), false)
    assert.equal(has(keeper.read()), false, 'live')
    now += STALE_MS + 1
    const stale = keeper.read()
    assert.equal(stale.live, false)
    assert.equal(has(stale), false, 'app closed: the live slots over the tree carry none of theirs either')
  })

  test('the session info keeps only known scopes and a sanitized name', () => {
    const out = sessionInfo({ house: 'abcd efgh', name: `Casa\u0000\u202e ${'x'.repeat(100)}`, deviceId: 'ab'.repeat(16), ver: 1, presence: PRESENCE.noCredential, scopes: ['attention', MARKER, 'root'] })
    assert.equal(has(out), false)
    assert.deepEqual(out.scopes, ['attention'])
    assert.equal(out.name.length, 64)
    assert.equal(/[\u0000\u202e]/.test(out.name), false)
    assert.equal(sessionInfo({ house: '', name: '', deviceId: MARKER, ver: 999, presence: 77, scopes: [] }).deviceId, '')
    assert.equal(sessionInfo({ house: '', name: '', deviceId: '', ver: 1, presence: 77, scopes: [] }).presence, PRESENCE.locked, 'an odd presence says the least')
  })

  test('an attention list is copied item by item, capped, and an odd item is left out', () => {
    const many = Array.from({ length: ATTENTION_MAX + 5 }, (_, i) => ({ id: `s${i}`, name: 'n', kind: 'claude', since: ISO, ...later() }))
    const out = attentionList({ items: [{ id: 'x y', name: MARKER, kind: 'k', since: ISO }, ...many], more: 2 })
    assert.equal(out.items.length, ATTENTION_MAX)
    assert.equal(out.more, 2)
    assert.equal(has(out), false)
    assert.deepEqual(Object.keys(out.items[0]!), ['id', 'name', 'kind', 'since'])
  })

  test('every projector of a result and of an event leaves the marker out of its plaintext body', () => {
    const items = { items: [{ ...attentionItem(hostileSlot('slot-9'), ISO)!, ...later() }], more: 0 }
    const bodies: Bytes[] = [
      resultBody('session.info', { house: 'h', name: 'Casa', deviceId: 'ab'.repeat(16), ver: 1, presence: 1, scopes: [...['attention'], MARKER], ...later() }),
      resultBody('admit.renew', { ticket: MARKER.toUpperCase() + '!', ...later() }),
      resultBody('device.revoke-self', {}),
      resultBody('attention.list', items),
      resultBody('attention.watch', items),
      eventBody('attention.changed', items),
      errorBody('failed'),
      errorBody(MARKER as 'failed'),
      emptyBody(),
    ]
    for (const b of bodies) assert.equal(bytesHave(b), false, new TextDecoder().decode(b))
    assert.deepEqual(decode(errorBody(MARKER as 'failed')), { error: 'failed' }, 'an unknown error code goes out as failed')
  })

  test('an op without a handler has no result to build; house.ts builds no body of its own', () => {
    const unbuilt = Object.entries(RESULTS).filter(([, f]) => f.name === 'unbuilt').map(([k]) => k).sort()
    assert.deepEqual(unbuilt, ['device.list', 'house.key-rotate.ack'])
    const compileOnly = (): void => {
      // @ts-expect-error the result of an op without a handler cannot be built
      resultBody('device.list', {})
    }
    void compileOnly
    const house = readFileSync(join(ROOT, 'src', 'remoted', 'house.ts'), 'utf8').replace(/\/\/.*$/gm, '')
    assert.equal(/JSON\.stringify|new TextEncoder/.test(house), false, 'every body comes from projection.ts')
    assert.equal(house.match(/encodeRes\(/g)?.length, 1, 'one place encodes a RES (#send)')
    assert.equal(house.match(/encodeEvt\(/g)?.length, 1, 'one place encodes an EVT')
    assert.match(house, /encodeEvt\(\{ evt: line\.code, body: eventBody\(/)
  })
})

// ---- the reads of step 3.4a ----------------------------------------------------------------------------------------

// What tetherd answers fits the sources, and what a device gets of the tree fits the model's entry (compile time).
const readsFit = (m: RemoteMarks, t: RegencyTree): [MarkRowSource, RegencyInput] => [m, t.input]
void readsFit

function hostileLine(seq: number, o: Partial<Line> = {}): Line {
  const l: Line = {
    seq, at: ISO, kind: 'message', from: { id: 'a1b2c3d4', name: 'conferente', role: 'member' }, body: `fala ${seq}`,
    files: [{ name: 'foto.png', path: `C:/Users/${MARKER}/.tether/channels/c_1/files/foto.png`, size: 10, type: 'image/png' }],
    ...o,
  }
  Object.assign(l, later())
  return l
}

describe('the reads of an extension, by allow list', () => {
  test('channels.marks: field by field, capped, the first call one line; an odd row is left out', () => {
    const row: RemoteMarks = { channel: 'c_1', name: 'obra', unread: 3, toMe: 1, firstToMe: 7, seen: 4, asks: 1, owed: 0, firstCall: { why: 'to-you', text: 'conferente: oi\nde novo' } }
    const out = channelsMarks({ channels: [{ ...row, ...later() } as RemoteMarks, { ...row, channel: 'bad id' }] })
    assert.deepEqual(out, { channels: [{ channel: 'c_1', name: 'obra', unread: 3, toMe: 1, seen: 4, asks: 1, owed: 0, firstToMe: 7, firstCall: { why: 'to-you', text: 'conferente: oi de novo' } }], more: 1 })
    const many = channelsMarks({ channels: Array.from({ length: MARKS_MAX + 3 }, (_, i) => ({ ...row, channel: `c_${i}` })) })
    assert.deepEqual([many.channels.length, many.more], [MARKS_MAX, 3])
    assert.deepEqual(channelsMarks({ channels: 'x' } as never), { channels: [], more: 0 }, 'an odd answer says nothing')
  })

  test('channels.page: lines field by field; attachments by name, size and type, never the path; a long body is cut and says so', () => {
    const answer = {
      channel: { id: 'c_1', name: 'obra', title: 'Obra', members: 2, seenByUser: 0, createdAt: ISO, closed: { at: ISO, by: 'user' }, ...later() },
      lines: [
        hostileLine(1),
        hostileLine(2, { body: 'x'.repeat(LINE_BODY_MAX + 10), files: undefined }),
        hostileLine(3, { kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body: 'entrou', event: { type: 'join', who: 'a1b2c3d4', by: 'user' }, files: undefined }),
        hostileLine(4, { kind: 'reaction' as Line['kind'], body: '' }),
      ],
      reactions: [{ seq: 1, tallies: [{ emoji: '👍', name: 'agree', by: [{ id: 'user', name: 'Guga' }], ...later() }] }],
      polls: [], more: false, last: 4,
    }
    const page = channelsPage({ answer, limit: PAGE_LINES_MAX })
    assert.equal(has(page), false, JSON.stringify(page))
    assert.deepEqual(page.channel, { id: 'c_1', name: 'obra', title: 'Obra', closed: true })
    assert.deepEqual(page.lines.map(l => l.seq), [1, 2, 3], 'a reaction is no line of the page')
    assert.deepEqual(page.lines[0]!.files, [{ name: 'foto.png', size: 10, type: 'image/png' }])
    assert.equal(page.lines[1]!.body.length, LINE_BODY_MAX)
    assert.equal(page.lines[1]!.cut, true)
    assert.deepEqual(page.lines[2]!.event, { type: 'join', who: 'a1b2c3d4', by: 'user' })
    assert.deepEqual(page.reactions, [{ seq: 1, tallies: [{ emoji: '👍', name: 'agree', by: [{ id: 'user', name: 'Guga' }] }] }])
    assert.equal(page.before, undefined, 'the start of the channel: no cursor')
  })

  test("channels.page: the cursor is the store's arithmetic, even for a page with no line of conversation", () => {
    const at = (last: number, before: number | undefined, limit: number, lines: Line[] = []): number | undefined =>
      channelsPage({ answer: { channel: { id: 'c_1' }, lines, reactions: [], polls: [], last }, limit, ...(before !== undefined ? { before } : {}) }).before
    assert.equal(at(120, undefined, 50), 71, 'the latest page of 120 lines starts at 71')
    assert.equal(at(120, 71, 50), 21)
    assert.equal(at(120, 21, 50), undefined, 'the first page: nothing before it')
    assert.equal(at(120, 500, 50), 71, 'a cursor past the end is the latest page')
    assert.equal(at(30, undefined, 50), undefined)
    assert.equal(at(0, undefined, 50), undefined, 'an empty channel')
  })

  test('channels.page: over PAGE_BYTES_MAX the oldest lines go, with their reactions and polls, and the cursor follows', () => {
    const lines = Array.from({ length: PAGE_LINES_MAX }, (_, i) => hostileLine(51 + i, { body: 'é'.repeat(LINE_BODY_MAX), files: undefined }))
    const answer = { channel: { id: 'c_1' }, lines, reactions: [{ seq: 51, tallies: [{ emoji: '👀', by: [] }] }], polls: [{ seq: 51 }], last: 100 }
    const page = channelsPage({ answer, limit: PAGE_LINES_MAX })
    assert.ok(utf8(JSON.stringify(page)).length <= PAGE_BYTES_MAX, 'the page fits its ceiling')
    assert.ok(page.lines.length < PAGE_LINES_MAX && page.lines.length > 0)
    assert.equal(page.lines.at(-1)!.seq, 100, 'the newest line stays')
    assert.equal(page.before, page.lines[0]!.seq, 'the cursor is the oldest line kept: asked again, nothing is lost')
    assert.deepEqual([page.reactions, page.polls], [[], []], 'what belonged to the lines that went, went with them')
  })

  test('channels.page: an open poll and a result, field by field; the receipts of the deliveries stay home', () => {
    const open = {
      seq: 9, type: 'choice', question: 'Qual?', options: ['a', 'b'], to: [{ id: 'a1b2c3d4', name: 'conferente' }], closesAt: ISO,
      author: { id: 'user', name: 'Guga' }, votes: { a1b2c3d4: { option: 2, reason: 'porque', at: ISO, name: 'conferente', ...later() } },
      asked: { a1b2c3d4: MARKER }, changes: { a1b2c3d4: 1 }, ...later(),
    }
    const result = { poll: 8, by: 'timeout', tally: [{ option: 1, text: 'ok', voters: [{ id: 'a1b2c3d4', name: 'conferente', ...later() }] }], missing: [{ id: 'b2c3d4e5', name: 'revisor', why: 'stopped' }, { id: 'x', name: 'y', why: MARKER }] }
    const page = channelsPage({ answer: { channel: { id: 'c_1' }, lines: [], reactions: [], polls: [{ seq: 9, open }, { seq: 8, result, closedAt: ISO }], last: 9 }, limit: 10 })
    assert.equal(has(page), false, JSON.stringify(page))
    assert.deepEqual(page.polls[0], {
      seq: 9, open: { type: 'choice', question: 'Qual?', options: ['a', 'b'], to: [{ id: 'a1b2c3d4', name: 'conferente' }], closesAt: ISO, author: { id: 'user', name: 'Guga' }, votes: [{ id: 'a1b2c3d4', name: 'conferente', option: 2, reason: 'porque' }] },
    })
    assert.deepEqual(page.polls[1], { seq: 8, result: { poll: 8, by: 'timeout', tally: [{ option: 1, text: 'ok', voters: [{ id: 'a1b2c3d4', name: 'conferente' }] }], missing: [{ id: 'b2c3d4e5', name: 'revisor', why: 'stopped' }] }, closedAt: ISO })
  })

  test("regency.tree: the model's entry field by field; the first call's text only to a device that holds `channels`", () => {
    const entry = {
      desks: { desks: [{ id: 'desk-1', name: 'Mesa', color: 'blue', kind: 'queue', asleep: false, panes: [{ id: 'a1', type: 'agent', icon: 'claude', title: 'Agente', lines: [MARKER], ...later() }], ...later() }] },
      owners: { desk: { 'desk-1': { id: 'a1', name: 'Agente', ...later() } }, pane: {} },
      channels: [{ id: 'c1', name: 'geral', title: 'Geral', owner: { kind: 'user' }, members: 2, seenByUser: 0, createdAt: ISO, ...later() }],
      channelMarks: { c1: { unread: 1, toMe: 1, asks: 0, owed: 0, first: { why: 'to-you', text: 'conferente: oi' } } },
      agents: [{ id: 'a1', kind: 'claude', name: 'Agente', ...later() }],
      since: { 'agent:a1': 5 }, collapsed: [MARKER], query: MARKER, filter: 'busy', selfDeskId: 'regency.main', ...later(),
    }
    const view = { input: entry, live: false, asOf: 1234, sig: '0123456789abcdef', ...later() }
    const withCh = regencyTree({ view, channels: true })
    const without = regencyTree({ view, channels: false })
    assert.equal(has(withCh) || has(without), false)
    assert.deepEqual(withCh.input.channelMarks.c1, { unread: 1, toMe: 1, asks: 0, owed: 0, first: { why: 'to-you', text: 'conferente: oi' } })
    assert.deepEqual(without.input.channelMarks.c1, { unread: 1, toMe: 1, asks: 0, owed: 0 })
    assert.deepEqual([withCh.live, withCh.asOf, withCh.sig], [false, 1234, '0123456789abcdef'])
    assert.deepEqual(withCh.input.collapsed, [], "the device's folds are its own")
    assert.equal('query' in withCh.input || 'filter' in withCh.input, false)
    assert.deepEqual(withCh.input.desks.desks[0]!.panes[0], { id: 'a1', type: 'agent', icon: 'claude', title: 'Agente' }, 'no seal lines')
    assert.equal(regencyTree({ view: { ...view, live: true }, channels: true }).asOf, undefined, 'live: no "como estavam às"')
    assert.equal(regencyTree({ view: { ...view, sig: MARKER }, channels: true }).sig, undefined)
    assert.deepEqual(regencyTree({ view: 7, channels: true }).input.desks, { desks: [] }, 'an odd answer is an empty tree')
  })

  test('the thin notices: ids only, capped, and the tree by signature, time and liveness', () => {
    assert.deepEqual(channelsChanged({ channels: ['c_1', 'bad id', 'c_1', 'c_2', 7 as never] }), { channels: ['c_1', 'c_2'] })
    assert.deepEqual(channelsChanged({ channels: Array.from({ length: CHANGED_IDS_MAX + 1 }, (_, i) => `c_${i}`) }), { channels: [], all: true })
    assert.deepEqual(channelsChanged({ channels: [], all: true }), { channels: [], all: true })
    assert.deepEqual(regencyChanged({ live: false, sig: '0123456789abcdef', asOf: 9 }), { live: false, sig: '0123456789abcdef', asOf: 9 })
    assert.deepEqual(regencyChanged({ live: true, sig: MARKER, asOf: 9 }), { live: true })
  })
})

// ---- the canary through a real House ------------------------------------------------------------------------------

async function bench(attention: AttentionView) {
  const kH = (await generateRoleKey('house')).key
  const kT = (await generateRoleKey('ticket')).key
  const nowS = Math.floor(Date.now() / 1000)
  const certT = await issueKeyCert(kH, { role: CERT_ROLE_TICKET, pub: kT.pub, notBefore: nowS - 60, notAfter: nowS + 86_400 })
  const inbox: Bytes[] = []
  const wire: Bytes[] = []
  const house: House = new House({
    keys: { kH, kT, certT }, aud: 'localhost:9', houseName: 'Casa de teste', attention,
    send: (b) => {
      wire.push(b)
      const f = decodeOuter('house', 'end', b)
      if (f.type === 'ROUTE_DATA') inbox.push(f.inner)
      else if (f.type === 'H_PAIR_LISTEN') queueMicrotask(() => house.onFrame(encodeOuter({ type: 'R_PAIR_STATE', code: PAIR_STATE.listening })))
    },
    ask: async () => {}, note: () => {}, notice: () => {}, log: () => {}, now: Date.now,
  })
  await house.init([], [])
  house.linkUp()
  const data = (inner: Bytes): void => house.onFrame(encodeOuter({ type: 'ROUTE_DATA', routeId: 1, inner }))
  const next = async (): Promise<Bytes> => {
    await until(() => inbox.length > 0, 10_000, 'a frame from the house')
    return inbox.shift()!
  }
  return { house, data, next, wire }
}

test('canary: a marker in the env of a process and of a profile, in secret-looking args and in later fields, is in no plaintext frame', async () => {
  // What a portal might hold: the processes and profiles go through their projections (no op exposes them yet), the slots
  // through the attention view a real House reads. Every result and event the device gets is decrypted and searched.
  assert.equal(has(remoteProc(hostileProc())) || has(remoteProfile(hostileProfile())), false)
  const attention = new AttentionView()
  attention.reset([hostileSlot('slot-1')])
  const { house, data, next, wire } = await bench(attention)

  const kD = (await generateRoleKey('device')).key
  const kA = (await generateRoleKey('admission')).key
  const begun = await house.pairBegin()
  const access = await accessFromCode(begun.code)
  house.onFrame(encodeOuter({ type: 'ROUTE_OPEN', routeId: 1, kind: ROUTE_KIND.pair, hint: access.rv }))
  const started = await DevicePairing.start({ access, kD, kA, name: 'Telefone', caps: 0, nowMs: Date.now() })
  let fx = started.effects
  let session: Session | undefined
  for (;;) {
    const paired = fx.find((e) => e.t === 'paired')
    if (paired && paired.t === 'paired') { session = paired.session; break }
    for (const e of fx) {
      if (e.t === 'send') data(e.frame)
      else if (e.t === 'failed') throw new Error(`pairing failed: ${e.reason}`)
      else if (e.t === 'show-sas') {
        const sas = e.sas
        void (async () => {
          await until(() => house.pairState(begun.pairId).state === 'waiting-sas' || undefined, 10_000, 'waiting-sas')
          await house.pairSas(begun.pairId, sas)
        })()
      }
    }
    fx = await started.pairing.onFrame(await next(), Date.now())
  }
  for (const e of fx) if (e.t === 'send') data(e.frame)
  const dev = session as Session

  const plaintexts: { ctype: string; content: Bytes }[] = []
  const send = async (reqId: number, op: number, body: string, actId?: Bytes): Promise<void> => {
    for (const e of await dev.send('REQ', encodeReq({ reqId, op, ...(actId ? { actId } : {}), body: new TextEncoder().encode(body) }), Date.now()))
      if (e.t === 'send') data(e.frame)
  }
  const read = async (want: (p: { ctype: string; content: Bytes }) => boolean): Promise<void> => {
    for (;;) {
      const fx: SessionEffect[] = await dev.receive(await next(), Date.now())
      for (const e of fx) {
        if (e.t === 'closed') throw new Error(`the session closed: ${JSON.stringify(e)}`)
        if (e.t === 'record') {
          const p = { ctype: e.ctype, content: e.content }
          plaintexts.push(p)
          if (want(p)) return
        }
      }
    }
  }
  const resOf = (id: number) => (p: { ctype: string; content: Bytes }): boolean => p.ctype === 'RES' && decodeRes(p.content).reqId === id

  await send(1, OP_CODES['session.info'], '{}')
  await read(resOf(1))
  await send(2, OP_CODES['attention.list'], '{}')
  await read(resOf(2))
  await send(3, OP_CODES['attention.watch'], '{}')
  await read(resOf(3))
  await send(4, 0x0999, '{}')
  await read(resOf(4))
  await send(5, OP_CODES['device.list'], `{"x":"${MARKER}"}`)
  await read(resOf(5))
  await send(6, OP_CODES['admit.renew'], `{"pubA":"${MARKER}"}`, new Uint8Array(randomBytes(16)))
  await read(resOf(6))
  attention.state(hostileSlot('slot-2'))
  await house.tick()
  await read((p) => p.ctype === 'EVT')

  const res = plaintexts.filter((p) => p.ctype === 'RES').map((p) => decodeRes(p.content))
  assert.deepEqual(res.slice(0, 5).map((r) => [r.reqId, r.status]), [
    [1, RES_STATUS.ok], [2, RES_STATUS.ok], [3, RES_STATUS.ok], [4, RES_STATUS.unknownOp], [5, RES_STATUS.failed],
  ])
  assert.equal(res[5]!.reqId, 6)
  assert.ok(res[5]!.status === RES_STATUS.failed || res[5]!.status === RES_STATUS.badRequest, 'a renewal with a bogus key is refused')
  const list = decode(res[1]!.body) as { items: { id: string }[] }
  assert.deepEqual(list.items.map((i) => i.id), ['slot-1'], 'the waiting slot did go out, by its allowed fields')
  const evt = decodeEvt(plaintexts.find((p) => p.ctype === 'EVT')!.content)
  assert.deepEqual((decode(evt.body) as { items: { id: string }[] }).items.map((i) => i.id).sort(), ['slot-1', 'slot-2'])

  for (const p of plaintexts) assert.equal(bytesHave(p.content), false, `a ${p.ctype} in clear carries the marker: ${new TextDecoder().decode(p.content)}`)
  for (const w of wire) assert.equal(bytesHave(w), false, 'nor any frame on the wire')
  house.linkDown()
})
