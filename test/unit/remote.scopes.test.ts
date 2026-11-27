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
import { gate, gateEvent, PIPE_REACH, type GateContext, type PipeReach, type PipeType } from '../../src/remoted/gate.ts'
import { DEFAULT_SCOPES } from '../../src/remoted/house.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---- compile-time totality: each of these lines must be a type error ------------------------------------------------

/** A request type added to the protocol (a name more than OP_CODES has today). */
type MoreOps = OpName | 'channels.say'
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
      for (const t of l.pipe) assert.equal((PIPE_REACH as Record<string, PipeReach>)[t], 'op', `${l.name} emits ${t}, which must be classified 'op'`)
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

  test('every message type of the pipe is classified; nothing a device asks reaches the pipe in this version', () => {
    const inProtocol = pipeTypesInProtocol()
    assert.deepEqual(Object.keys(PIPE_REACH).sort(), [...new Set(inProtocol)].sort(), 'PIPE_REACH has one key per type of the pipe')
    const viaOps = Object.entries(PIPE_REACH as Record<string, PipeReach>).filter(([, r]) => r === 'op').map(([t]) => t).sort()
    assert.deepEqual([...new Set(OPS.flatMap(l => l.pipe))].sort(), viaOps, "a type is 'op' exactly when some line emits it")
    for (const tunnel of ['ext-request', 'verb', 'object-set', 'object-get', 'verb-list', 'input', 'typed', 'shutdown'])
      assert.equal(PIPE_REACH[tunnel as PipeType], 'never', `${tunnel}: no remote path`)
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
