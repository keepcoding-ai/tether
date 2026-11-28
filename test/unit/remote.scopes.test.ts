// The one table of remote operations is total (RR2.1; fio-spec 7.2 rules 2, 3, 6; plano §2 "Escopos"): every request type
// of the remote protocol has a line with its scope and presence class, every message type of the pipe is classified, and
// the gate decides by the table alone. Totality is checked twice: here at run time, and at compile time by the
// `@ts-expect-error` cases below (`npx tsc --noEmit -p .` fails if a table stops being total-by-type).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EVT, OP_CODES, OP_TABLE, opByCode, OPS, PRESENCE, RANGE_SCOPES, RES_STATUS, SCOPE_FAMILIES, knownScopes,
  type EvtLine, type OpName, type OpRule, type Req,
} from '../../src/remote/index.ts'
import { EVENTS, RESULTS } from '../../src/remote/projection.ts'
import {
  EXT_READS, EXT_WRITES, extReadOf, extWriteOf, gate, gateEvent, PIPE_REACH,
  type ExtPair, type ExtReadLinesOf, type ExtReadOp, type ExtReadPair, type ExtRequestLinesOf, type ExtWriteLinesOf, type ExtWriteOp,
  type GateContext, type PipeReach, type PipeType,
} from '../../src/remoted/gate.ts'
import { DEFAULT_SCOPES } from '../../src/remoted/house.ts'
import { REMOTE_ACT_ARGS, remoteMayAct } from '../../src/remoted/reach.ts'
import { isManageOp } from '../../src/remote/manage.ts'
import { APP_ACT_FIELDS } from '../../src/remote/app-acts.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---- compile-time totality: each of these lines must be a type error ------------------------------------------------

/** A request type added to the protocol (a name more than OP_CODES has today). */
type MoreOps = OpName | 'channels.archive'
type MorePipe = PipeType | 'new-request'
const { 'device.revoke': _dropped, ...tableWithoutOne } = OP_TABLE
const typeChecks = (): void => {
  // @ts-expect-error a new request type without a line in OP_TABLE does not compile
  const newOp: { readonly [K in MoreOps]: OpRule } = OP_TABLE
  // @ts-expect-error a table that loses the line of one request type does not compile
  const lostLine: { readonly [K in OpName]: OpRule } = tableWithoutOne
  // @ts-expect-error a line without a declared scope does not compile
  const noScope: OpRule = { presence: 'none', mutates: false, gesture: false, pipe: [] }
  // @ts-expect-error a new request type without a projector of its result does not compile
  const noProjector: { readonly [K in MoreOps]: (src: never) => unknown } = RESULTS
  // @ts-expect-error a new message type of the pipe without a classification does not compile
  const newPipe: { readonly [T in MorePipe]: PipeReach } = PIPE_REACH
  void [newOp, lostLine, noScope, noProjector, newPipe, _dropped]
}
void typeChecks

// The class `ext-read` is total both ways by type, for the reads and for the writes.
const { 'channels.page': _pagePair, ...pairsWithoutOne } = EXT_READS
const { 'channels.say': _sayPair, ...writesWithoutOne } = EXT_WRITES
type Line<M extends boolean, G extends boolean, S extends string, P extends string> = {
  readonly mutates: M; readonly gesture: G; readonly scope: S; readonly presence: P; readonly pipe: readonly ['ext-request']
}
/** Lines that emit ext-request and are neither a read nor a write (reach.ts extRequestReadsOrWrites refuses each). */
type GestureNoState = typeof OP_TABLE & { 'channels.ping': Line<false, true, 'channels', 'unlocked'> }
type SessionWrite = typeof OP_TABLE & { 'session.note': Line<true, true, 'session', 'unlocked'> }
type LockedWrite = typeof OP_TABLE & { 'channels.drop': Line<true, false, 'channels', 'none'> }
type AnyLines = { readonly [name: string]: { readonly mutates: boolean; readonly gesture: boolean; readonly scope: string; readonly presence: string; readonly pipe: readonly string[] } }
/** `true` when every line of T that emits ext-request is a read or a write (the guard of reach.ts, on any table). */
type ReadsOrWrites<T extends AnyLines> = [ExtRequestLinesOf<T>] extends [ExtReadLinesOf<T> | ExtWriteLinesOf<T>] ? true : false
const extReachChecks = (): void => {
  const real: ReadsOrWrites<typeof OP_TABLE> = true
  // @ts-expect-error a line that emits ext-request without a pair does not compile
  const lostPair: { readonly [K in ExtReadOp]: ExtReadPair } = pairsWithoutOne
  // @ts-expect-error a pair without a line that emits ext-request (here a line that writes by the table) does not compile
  const strayPair: { readonly [K in ExtReadOp]: ExtReadPair } = { ...EXT_READS, 'device.revoke': { ext: 'remote', name: 'device.revoke' } }
  // @ts-expect-error a write's pair among the reads does not compile: a pair is a read or a write by its line
  const writeAsRead: { readonly [K in ExtReadOp]: ExtReadPair } = { ...EXT_READS, 'channels.say': { ext: 'channels', name: 'say' } }
  // @ts-expect-error a write line without its pair does not compile
  const lostWrite: { readonly [K in ExtWriteOp]: ExtPair } = writesWithoutOne
  // @ts-expect-error a read's pair among the writes does not compile
  const readAsWrite: { readonly [K in ExtWriteOp]: ExtPair } = { ...EXT_WRITES, 'channels.page': { ext: 'channels', name: 'history' } }
  // @ts-expect-error a gesture that changes no state is neither a read nor a write
  const gesture: ReadsOrWrites<GestureNoState> = true
  // @ts-expect-error a write of the session family (what a locked session keeps) is no write line
  const session: ReadsOrWrites<SessionWrite> = true
  // @ts-expect-error a write a locked session could send (presence none) is no write line
  const locked: ReadsOrWrites<LockedWrite> = true
  void [real, lostPair, strayPair, writeAsRead, lostWrite, readAsWrite, gesture, session, locked, _pagePair, _sayPair]
}
void extReachChecks

// ---- run-time totality ---------------------------------------------------------------------------------------------

const ALL = new Set<string>(SCOPE_FAMILIES)
const ctx = (o: Partial<GateContext> = {}): GateContext => ({
  scopes: ALL, presence: PRESENCE.unlocked, elevUntilS: 2_000_000_000, freshPair: true, openedMs: 0, nowMs: 1_000, ...o,
})
const req = (op: number, o: Partial<Req> = {}): Req => ({ reqId: 1, op, actId: new Uint8Array(16), body: new Uint8Array(0), ...o })
const status = (v: ReturnType<typeof gate>): number => (v.ok ? RES_STATUS.ok : v.status)

/** The message types of the pipe, read from src/daemon/protocol.ts itself (the Request and Notice unions). */
function pipeTypesInProtocol(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'daemon', 'protocol.ts'), 'utf8')
  const from = src.indexOf('export type Request =')
  const to = src.indexOf('export type ClientMessage')
  assert.ok(from > 0 && to > from, 'the unions of the pipe are where this test reads them')
  const unions = src.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const members = unions.split('\n').filter(l => /^\s*\|/.test(l))
  const types = members.map(l => /^\s*\|\s*\{\s*t:\s*'([^']+)'/.exec(l)?.[1])
  assert.ok(types.every(t => t !== undefined), `every member of the unions is an object with a literal t: ${members.filter((_, i) => !types[i]).join(' / ')}`)
  return types as string[]
}

describe('the table of remote operations is total', () => {
  test('every request type of the protocol has exactly one line, and every line one projector of its result', () => {
    const names = Object.keys(OP_CODES).sort()
    assert.deepEqual(Object.keys(OP_TABLE).sort(), names)
    assert.deepEqual(Object.keys(RESULTS).sort(), names)
    assert.deepEqual(OPS.map(l => l.name).sort(), names)
    assert.equal(new Set(Object.values(OP_CODES)).size, names.length, 'codes are unique')
    for (const l of OPS) {
      assert.equal(opByCode(l.code), l)
      assert.ok(Number.isInteger(l.code) && l.code > 0 && l.code <= 0xffff, l.name)
      assert.ok(typeof l.scope === 'string' && l.scope.length > 0, `${l.name}: a declared scope`)
      assert.ok(['none', 'unlocked', 'window', 'per-act', 'fresh-pair'].includes(l.presence), `${l.name}: a presence class`)
      assert.ok(RANGE_SCOPES[l.code >>> 8]?.includes(l.scope), `${l.name}: scope ${l.scope} belongs to the range 0x${(l.code >>> 8).toString(16)}`)
      if (l.gesture) assert.equal(l.mutates, true, `${l.name}: a gesture changes state`)
      for (const t of l.pipe) {
        const reach = (PIPE_REACH as Record<string, PipeReach>)[t]
        assert.ok(reach === 'op' || reach === 'ext-read', `${l.name} emits ${t}, which must be classified 'op' (or 'ext-read' for ext-request)`)
      }
    }
  })

  test('the scope families are those of the plan, and a device gets all of them at pairing', () => {
    assert.deepEqual([...SCOPE_FAMILIES], [
      'attention', 'channels', 'regency:read', 'manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive',
      'peek:terminal:read', 'peek:terminal:write', 'peek:browser',
    ])
    assert.deepEqual([...DEFAULT_SCOPES], [...SCOPE_FAMILIES])
    for (const l of OPS) assert.ok(l.scope === 'session' || ALL.has(l.scope), l.name)
    assert.deepEqual(knownScopes(['peek:browser', 'root', 'attention', 7, 'attention']), ['attention', 'peek:browser'])
  })

  test('every event has a line with its scope and presence, and a projector of its body', () => {
    const lines: EvtLine[] = Object.values(EVT)
    assert.deepEqual(Object.keys(EVENTS).sort(), lines.map(l => l.name).sort())
    for (const l of lines) {
      assert.ok(RANGE_SCOPES[l.code >>> 8]?.includes(l.scope), l.name)
      assert.ok(l.presence === 'none' || l.presence === 'unlocked', l.name)
    }
  })

  test('every message type of the pipe is classified; a device reaches the pipe only through the reads of EXT_READS', () => {
    const inProtocol = pipeTypesInProtocol()
    assert.deepEqual(Object.keys(PIPE_REACH).sort(), [...new Set(inProtocol)].sort(), 'PIPE_REACH has one key per type of the pipe')
    const viaOps = Object.entries(PIPE_REACH as Record<string, PipeReach>).filter(([, r]) => r === 'op').map(([t]) => t).sort()
    assert.deepEqual([...new Set(OPS.flatMap(l => l.pipe))].filter(t => t !== 'ext-request').sort(), viaOps, "a type is 'op' exactly when some line emits it")
    assert.deepEqual(Object.entries(PIPE_REACH).filter(([, r]) => r === 'ext-read').map(([t]) => t), ['ext-request'], "only ext-request is of the class 'ext-read'")
    for (const tunnel of ['verb', 'object-set', 'object-get', 'verb-list', 'input', 'typed', 'shutdown'])
      assert.equal(PIPE_REACH[tunnel as PipeType], 'never', `${tunnel}: no remote path`)
  })
})

describe("the class 'ext-read': a read of an extension, listed by name", () => {
  const RESULT_OF = RESULTS as Record<string, { name: string }>

  test('the pairs are exactly the lines that emit ext-request: the reads in EXT_READS, the writes in EXT_WRITES, none in both', () => {
    const emitters = OPS.filter(l => l.pipe.includes('ext-request' as never)).map(l => l.name).sort()
    assert.deepEqual([...Object.keys(EXT_READS), ...Object.keys(EXT_WRITES)].sort(), emitters, 'one pair per line that emits ext-request, and no pair without one')
    assert.deepEqual(Object.keys(EXT_READS).filter(k => Object.hasOwn(EXT_WRITES, k)), [])
    assert.deepEqual(Object.keys(EXT_READS).sort(), ['channels.file', 'channels.marks', 'channels.page', 'create.options', 'regency.tree'])
    assert.deepEqual(Object.keys(EXT_WRITES).filter(n => n.startsWith('channels.')).sort(), [
      'channels.close', 'channels.create', 'channels.join', 'channels.mute', 'channels.poll', 'channels.poll-close', 'channels.react',
      'channels.remove', 'channels.reopen', 'channels.say', 'channels.seen', 'channels.unmute', 'channels.vote',
    ])
    // RR5 5.1: the rest are the gestures the app does, all of them the one pair `regency/act`, and (RR5 5.3) the agent and the
    // terminal tetherd creates alone, the pair `regency/create`.
    assert.deepEqual(Object.keys(EXT_WRITES).filter(n => !n.startsWith('channels.')).sort(), [...Object.keys(APP_ACT_FIELDS), 'create.agent', 'create.agent-unrestricted', 'create.terminal'].sort())
    assert.deepEqual([EXT_WRITES['create.agent'], EXT_WRITES['create.agent-unrestricted'], EXT_WRITES['create.terminal']], [{ ext: 'regency', name: 'create' }, { ext: 'regency', name: 'create' }, { ext: 'regency', name: 'create' }])
  })

  test('each act of the app changes state, is a gesture, needs an actId, a scope of management, a strict body; what destroys a proof per act', () => {
    for (const name of Object.keys(APP_ACT_FIELDS)) {
      const l = OPS.find(x => x.name === name)!
      assert.deepEqual(EXT_WRITES[name as keyof typeof EXT_WRITES], { ext: 'regency', name: 'act' }, name)
      assert.equal(l.mutates && l.gesture, true, name)
      assert.equal(l.code >>> 8, 0x04, `${name}: in the range of management`)
      assert.deepEqual(l.pipe, ['ext-request'], name)
      const fields = APP_ACT_FIELDS[name as keyof typeof APP_ACT_FIELDS] as { need: object; may?: object }
      assert.deepEqual([...l.body!].sort(), [...Object.keys(fields.need), ...Object.keys(fields.may ?? {})].sort(), `${name}: the body is the act's fields`)
      const destroys = ['desks.close', 'panes.close', 'closed.forget'].includes(name)
      assert.equal(l.scope === 'manage:destructive' && l.presence === 'per-act', destroys, `${name}: destructive only where it destroys`)
      if (name.startsWith('owners.')) assert.equal(l.scope, 'manage:agents', name)
      else if (!destroys) assert.equal(l.scope, 'manage:desks', name)
      // Giving power to an agent is the window (7.3); taking it away only lowers it.
      if (name === 'owners.give' || name === 'owners.return') assert.equal(l.presence, 'window', name)
      else if (!destroys) assert.equal(l.presence, 'unlocked', name)
      assert.notEqual(RESULT_OF[name]!.name, 'unbuilt', `${name}: a projector that can be called`)
    }
  })

  test('each write line changes state, needs an actId, the channels scope unlocked, has a strict body and a projector that builds', () => {
    for (const name of Object.keys(EXT_WRITES).filter(n => n.startsWith('channels.'))) {
      const l = OPS.find(x => x.name === name)!
      assert.equal(l.mutates, true, `${name}: a write`)
      // Closing a channel ends it for every member (RR5, fio-spec 18): destructive, with a proof per act.
      const closes = name === 'channels.close'
      assert.equal(l.scope, closes ? 'manage:destructive' : 'channels', name)
      assert.equal(l.presence, closes ? 'per-act' : 'unlocked', `${name}: fio-spec 7.3, talk needs the session unlocked`)
      assert.equal(l.code >>> 8, 0x02, `${name}: in the range of the channels`)
      assert.deepEqual(l.pipe, ['ext-request'], `${name}: a write emits nothing but its pair`)
      assert.ok(Array.isArray(l.body) && (l.body.includes('channel') || name === 'channels.create'), `${name}: a strict body naming its channel`)
      // Step 4.3: only a speech carries files (indexes of its own uploads, never paths).
      assert.equal(l.body!.includes('files'), name === 'channels.say', `${name}: files on the speech alone`)
      assert.notEqual(RESULT_OF[name]!.name, 'unbuilt', `${name}: a projector that can be called`)
      assert.equal(l.gesture, name !== 'channels.seen', `${name}: a gesture of the person, except the seen the screen sends by itself`)
    }
    assert.deepEqual(Object.fromEntries(Object.keys(EXT_WRITES).filter(n => n.startsWith('channels.')).map(n => [n, OP_CODES[n as OpName]])), {
      'channels.say': 0x0202, 'channels.react': 0x0203, 'channels.vote': 0x0204, 'channels.poll': 0x0205, 'channels.seen': 0x0206,
      'channels.create': 0x020a, 'channels.join': 0x020b, 'channels.remove': 0x020c, 'channels.mute': 0x020d, 'channels.unmute': 0x020e,
      'channels.close': 0x020f, 'channels.reopen': 0x0210, 'channels.poll-close': 0x0211,
    })
  })

  test('the read lines only read', () => {
    for (const name of Object.keys(EXT_READS)) {
      const l = OPS.find(x => x.name === name)!
      assert.equal(l.mutates, false, `${name}: a pair is a read`)
      assert.equal(l.gesture, false, `${name}: a read is no gesture`)
      assert.equal(l.presence, 'unlocked', `${name}: reads need the session unlocked`)
      assert.deepEqual(l.pipe, ['ext-request'], `${name}: a read emits nothing but its pair`)
      assert.ok(Array.isArray(l.body), `${name}: a strict body`)
      assert.notEqual(RESULT_OF[name]!.name, 'unbuilt', `${name}: a projector that can be called`)
    }
  })

  test('the pairs name the read requests of the daemon halves, and no write of theirs', () => {
    assert.deepEqual(EXT_READS, {
      'channels.marks': { ext: 'channels', name: 'marks' },
      'channels.page': { ext: 'channels', name: 'history' },
      'channels.file': { ext: 'channels', name: 'history' },
      'regency.tree': { ext: 'regency', name: 'tree.read' },
      'create.options': { ext: 'regency', name: 'create.options' },
    })
    // The writes of the same extensions (the person's speech and gestures, the app's publish): none is a read pair.
    const writes = ['say', 'seen', 'react', 'vote', 'poll', 'poll-close', 'create', 'join', 'remove', 'mute', 'unmute', 'close', 'reopen', 'tree.publish']
    const named = new Set<string>(Object.values(EXT_READS).map(p => p.name))
    for (const w of writes) assert.equal(named.has(w), false, `${w} writes: never a read pair`)
  })

  test("the write pairs are the person's speech, her managing a channel and the Regency's writes; never leave nor publish", () => {
    const channels = ['say', 'react', 'vote', 'poll', 'seen', 'create', 'join', 'remove', 'mute', 'unmute', 'close', 'reopen', 'poll-close']
    assert.deepEqual(Object.fromEntries(Object.entries(EXT_WRITES).filter(([n]) => n.startsWith('channels.'))),
      Object.fromEntries(channels.map(n => [`channels.${n}`, { ext: 'channels', name: n }])))
    const named = new Set<string>(Object.values(EXT_WRITES).map(p => `${p.ext} ${p.name}`))
    // `leave` is an agent's own (the person removes), never a pair.
    assert.equal(named.has('channels leave'), false)
    assert.deepEqual([...named].filter(n => n.startsWith('regency ') || n.startsWith('remote ')).sort(), ['regency act', 'regency create'], 'the bridge and the creation, never tree.publish nor a remote request')
  })

  test('a request outside the lists has no pair, whatever its name', () => {
    for (const name of ['say', 'channels.say', 'device.revoke', 'session.info', 'ext-request', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ''])
      assert.equal(extReadOf(name), undefined, name)
    for (const name of ['say', 'channels.marks', 'channels.leave', 'channels.archive', 'device.revoke', '__proto__', 'constructor', 'toString', ''])
      assert.equal(extWriteOf(name), undefined, name)
    for (const [op, pair] of Object.entries(EXT_READS)) assert.equal(extReadOf(op), pair)
    for (const [op, pair] of Object.entries(EXT_WRITES)) assert.equal(extWriteOf(op), pair)
  })
})

describe('the gate decides by the table alone', () => {
  test('every op code without a line is 0x02, whatever the context; every line is found', () => {
    for (let op = 0; op <= 0xffff; op++) {
      const known = opByCode(op)
      const v = gate(req(op), ctx())
      if (!known) assert.equal(status(v), RES_STATUS.unknownOp, `0x${op.toString(16)}`)
      else assert.notEqual(status(v), RES_STATUS.unknownOp, known.name)
    }
  })

  test('with every scope, unlocked, a window and the pairing session: each line passes, except per-act (its proof is step 2.4)', () => {
    for (const l of OPS) {
      const expected = l.presence === 'per-act' ? RES_STATUS.presenceRequired : RES_STATUS.ok
      assert.equal(status(gate(req(l.code), ctx())), expected, l.name)
    }
  })

  test('without the scope of its line, a request is 0x03; the session family needs none', () => {
    for (const l of OPS) {
      const without = new Set([...ALL].filter(s => s !== l.scope))
      assert.equal(status(gate(req(l.code), ctx({ scopes: without }))), l.scope === 'session' ? (l.presence === 'per-act' ? RES_STATUS.presenceRequired : RES_STATUS.ok) : RES_STATUS.noScope, l.name)
    }
  })

  test('locked: only the lines of class none or fresh-pair pass; the others answer by their class', () => {
    for (const l of OPS) {
      const v = status(gate(req(l.code), ctx({ presence: PRESENCE.locked })))
      const expected = l.presence === 'none' || l.presence === 'fresh-pair' ? RES_STATUS.ok
        : l.presence === 'unlocked' ? RES_STATUS.locked : RES_STATUS.presenceRequired
      assert.equal(v, expected, l.name)
    }
  })

  test('no credential [E-8]: reads pass, acts outside the session family and every window or per-act line answer 0x05', () => {
    for (const l of OPS) {
      const v = status(gate(req(l.code), ctx({ presence: PRESENCE.noCredential })))
      const refused = l.presence === 'window' || l.presence === 'per-act' || (l.scope !== 'session' && l.mutates && !l.allowedWithoutCredential)
      assert.equal(v, refused ? RES_STATUS.presenceRequired : RES_STATUS.ok, l.name)
    }
  })

  test('the thin notices of the reads go by the scope of their family, never to a locked session', () => {
    assert.deepEqual([EVT.channelsChanged.code, EVT.channelsChanged.scope, EVT.regencyChanged.code, EVT.regencyChanged.scope], [0x0200, 'channels', 0x0300, 'regency:read'])
    for (const line of [EVT.channelsChanged, EVT.regencyChanged]) {
      assert.equal(gateEvent(line, { scopes: ALL, presence: PRESENCE.noCredential }), true, `${line.name}: a device without credential reads`)
      assert.equal(gateEvent(line, { scopes: new Set([...ALL].filter(s => s !== line.scope)), presence: PRESENCE.unlocked }), false, `${line.name}: without its scope`)
      assert.equal(gateEvent(line, { scopes: ALL, presence: PRESENCE.locked }), false, `${line.name}: locked`)
    }
  })

  test('an event goes only with its scope, never to a locked session, and no peek event goes without a credential', () => {
    const line = EVT.attentionChanged
    assert.equal(gateEvent(line, { scopes: ALL, presence: PRESENCE.unlocked }), true)
    assert.equal(gateEvent(line, { scopes: ALL, presence: PRESENCE.noCredential }), true)
    assert.equal(gateEvent(line, { scopes: new Set(), presence: PRESENCE.unlocked }), false)
    assert.equal(gateEvent(line, { scopes: ALL, presence: PRESENCE.locked }), false)
    const peek: EvtLine = { code: 0x0500, name: 'peek.terminal.data', scope: 'peek:terminal:read', presence: 'unlocked' }
    assert.equal(gateEvent(peek, { scopes: ALL, presence: PRESENCE.noCredential }), false)
    assert.equal(gateEvent(peek, { scopes: ALL, presence: PRESENCE.unlocked }), true)
  })

  test('the gate and the house read the table, and keep no table of their own', () => {
    const house = readFileSync(join(ROOT, 'src', 'remoted', 'house.ts'), 'utf8')
    const gateSrc = readFileSync(join(ROOT, 'src', 'remoted', 'gate.ts'), 'utf8')
    assert.equal(/STRICT_KEYS|Record<string, readonly string\[\]>/.test(house), false, 'the strict keys of a body live on its line')
    assert.equal(/'(?:attention|channels|regency:read|manage:\w+|peek:[\w:]+)'/.test(house), false, 'house.ts names no scope')
    assert.match(gateSrc, /opByCode\(req\.op\)/)
  })
})

describe("the class 'op' (RR5 5.2): the management acts, each type with its closed fields", () => {
  test('the rules are exactly the types of the class, and every management line emits only types of it (and proc-info for a board)', () => {
    const ops = Object.entries(PIPE_REACH as Record<string, PipeReach>).filter(([, r]) => r === 'op').map(([t]) => t).sort()
    assert.deepEqual(Object.keys(REMOTE_ACT_ARGS).sort(), ops)
    for (const l of OPS.filter(l => isManageOp(l.name))) {
      assert.ok(l.pipe.length >= 1 && l.pipe.every(t => ops.includes(t)), l.name)
      assert.ok(l.body !== undefined, `${l.name}: a strict body`)
    }
    for (const kept of ['create', 'set-want', 'set-profile', 'proc-adopt', 'proc-host-stop', 'proc-attach', 'pause-start', 'object-set', 'verb', 'input'])
      assert.equal(PIPE_REACH[kept as PipeType], 'never', `${kept}: still no remote path`)
  })

  test('a message passes only with the fields and values of its rule: never by, a recipe, a wait or another why', () => {
    assert.equal(remoteMayAct({ t: 'stop', id: 1, slotId: 's1', why: 'end' }), true)
    assert.equal(remoteMayAct({ t: 'proc-stop', id: 1, name: 'web', force: 'porque' }), true)
    assert.equal(remoteMayAct({ t: 'ronda-off', slotId: 's1', force: true }), true)
    for (const m of [
      { t: 'stop', slotId: 's1', why: 'hibernate' }, { t: 'proc-stop', name: 'web', by: { slotId: 's2' } }, { t: 'proc-stop', name: 'web', waitMs: 1000 },
      { t: 'proc-start', name: 'web', recipe: { command: 'x', args: [], cwd: '.' } }, { t: 'proc-start', name: 'web', force: true },
      { t: 'ronda-off', slotId: 's1', force: false }, { t: 'rename-slot', slotId: 's1', name: 7 }, { t: 'create', kind: 'claude', cwd: '.' },
      { t: 'ext-request', ext: 'channels', name: 'say' }, { t: 'proc-use', name: 'web', purpose: 'x', constructor: 'x' }, { t: 7 },
    ]) assert.equal(remoteMayAct(m as Record<string, unknown>), false, JSON.stringify(m))
  })
})
