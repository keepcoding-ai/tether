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
  ATTENTION_MAX, attentionItem, attentionList, emptyBody, errorBody, eventBody, remoteProc, remoteProfile, resultBody,
  RESULTS, sessionInfo, type ProcSource, type ProfileSource, type SlotSource,
} from '../../src/remote/projection.ts'
import { AttentionView } from '../../src/remoted/attention.ts'
import { House } from '../../src/remoted/house.ts'
import { toEmbedProc, type EmbedProc } from '../../extensions/processes/embed.ts'
import { remoteInputOf } from '../../extensions/regency/remote-input.ts'
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
    assert.deepEqual(unbuilt, ['device.list', 'device.revoke', 'house.key-rotate.ack', 'session.lock', 'uv.assert', 'uv.challenge', 'uv.register'])
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
