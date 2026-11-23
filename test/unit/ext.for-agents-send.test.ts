// `agents send` with the owner's envelope: the three ways (inside / conductor / delivery), `unsent` as an error, and the failure
// of the conductor. No daemon: the verb runs on fake deps (delivery, slots, store, gate) and a FAKE conductor in the registry.
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { conductorRegistry, ConductError, type Conductor, type Detected } from '../../extensions/for-agents/conductor-api.ts'
import { sendVerb } from '../../extensions/for-agents/daemon/verbs/send.ts'
import { failOf, type VerbDeps } from '../../extensions/for-agents/daemon/verbs/common.ts'
import type { VerbCaller, VerbResult } from '../../src/daemon/ext-api.ts'

const OWNER = 'owner1'
const PANE = 'pane1'

describe('for-agents: send with the envelope (X5)', () => {
  let setAside: Conductor[] = []
  let unregister: { dispose(): void }
  let path: 'inside' | 'terminal' | 'wait'
  let hand: 'owner' | 'user'
  let detected: Detected
  let sendImpl: (text: string) => Promise<void>
  let typed: string[]
  let delivered: string[]
  let receipt: Record<string, unknown>
  let logs: string[]
  /** What the verb told the store about each send: true = failed (the text may be left in the box). */
  let outcomes: boolean[]

  const fake: Conductor = {
    id: 'fake',
    match: (t) => (t.slot?.kind === 'soul' || t.slot?.kind === 'shell' ? 10 : undefined),
    capabilities: [{ id: 'send', label: 'Enviar' }],
    detect: async () => detected,
    send: async (_ctx, text) => { await sendImpl(text); typed.push(text); return { value: undefined, proven: true } },
  }

  const caller = { slotId: OWNER } as VerbCaller
  const slot = { slotId: PANE, kind: 'soul' as string, name: 'p1', cwd: '/x' }
  const deps = {
    api: {
      slots: { get: (id: string) => (id === PANE ? slot : { slotId: OWNER, kind: 'soul', name: 'Atrium', cwd: '/x' }) },
      desks: { map: () => undefined },
      delivery: {
        pathOf: () => path,
        deliver: async (_id: string, msg: { body: string }) => { delivered.push(msg.body); return receipt },
      },
      agents: { get: () => undefined },
      log: (m: string) => { logs.push(m) },
    },
    store: {
      panesOf: () => new Set([PANE]),
      effectiveOf: () => ({ commander: OWNER, via: 'pane', hand }),
      inventoryOf: () => ({}),
      recordLast: async () => ({}),
      beginSend: () => (failed: boolean) => { outcomes.push(failed) },
    },
    gate: {},
    readers: {},
    pending: {},
  } as unknown as VerbDeps

  // verbs.ts turns a thrown refusal into the error result; the test does the same.
  const run = (): Promise<VerbResult> => sendVerb.run(deps, caller, { guia: PANE, text: 'olá' }).catch(failOf)
  const codeOf = (r: { data?: unknown }): unknown => (r.data as { error?: string } | undefined)?.error

  before(() => {
    unregister = conductorRegistry.register(fake)
    const list = (conductorRegistry as unknown as { list: Conductor[] }).list
    setAside = list.filter((c) => c !== fake)
    list.splice(0, list.length, fake)
  })
  after(() => {
    unregister.dispose()
    ;(conductorRegistry as unknown as { list: Conductor[] }).list.push(...setAside)
  })
  beforeEach(() => {
    slot.kind = 'soul'
    path = 'terminal'; hand = 'owner'; detected = { state: 'idle' }; typed = []; delivered = []; logs = []; outcomes = []
    sendImpl = async () => {}
    receipt = { id: 'm_x', slotId: PANE, state: 'typed', at: '' }
  })

  test('inside: the agent has a channel, so the delivery carries it and the conductor is not used', async () => {
    path = 'inside'
    receipt = { id: 'm_1', slotId: PANE, state: 'inside', at: '' }
    const r = await run()
    assert.equal(r.isError, undefined)
    assert.deepEqual([(r.data as { state: string }).state, delivered.length, typed.length], ['inside', 1, 0])
  })

  test('terminal, idle and free: through the conductor, with the envelope already in the text', async () => {
    const r = await run()
    assert.equal(r.isError, undefined, r.text)
    assert.equal((r.data as { state: string }).state, 'typed')
    assert.equal(delivered.length, 0)
    assert.equal(typed.length, 1)
    assert.match(typed[0]!, /^\[tether · for-agents · de p?Atrium \(owner\) · m_[0-9a-z]+\] olá$/)
  })

  test('terminal but a card or dialog is on the screen: the delivery takes it, not the conductor', async () => {
    detected = { state: 'permission', card: { title: 't', text: 't', options: [] } }
    receipt = { id: 'm_2', slotId: PANE, state: 'typed', at: '' }
    await run()
    assert.deepEqual([typed.length, delivered.length], [0, 1])
  })

  test('busy turn or the hand with the person (path wait): the delivery holds it, with-user when it is the hand', async () => {
    path = 'wait'; hand = 'user'
    receipt = { id: 'm_3', slotId: PANE, state: 'queued', at: '' }
    const r = await run()
    assert.deepEqual([(r.data as { state: string }).state, (r.data as { why?: string }).why, typed.length, delivered.length], ['queued', 'with-user', 0, 1])
  })

  test('the person takes the pane before a byte goes (with-user from the gate): nothing is lost, the delivery holds it', async () => {
    sendImpl = async () => { throw new ConductError('with-user', 'a guia está com a pessoa agora; nada foi digitado') }
    receipt = { id: 'm_4', slotId: PANE, state: 'queued', at: '' }
    const r = await run()
    assert.equal(r.isError, undefined)
    assert.deepEqual([(r.data as { state: string }).state, delivered.length], ['queued', 1])
  })

  test('the conductor fails or cannot prove the text left the box: a clear error, and no delivery behind it', async () => {
    sendImpl = async () => { throw new Error('o texto continua na caixa') }
    const r = await run()
    assert.equal(r.isError, true)
    assert.equal(codeOf(r), 'conductor-failed')
    assert.match(r.text, /não foi confirmada/)
    assert.match(r.text, /o texto continua na caixa/)
    assert.equal(delivered.length, 0)
    assert.ok(logs.some((l) => l.includes('não confirmou')))

    sendImpl = async () => { throw new ConductError('busy', 'o motor está em turno') }
    assert.equal(codeOf(await run()), 'busy')
  })

  test('a shell pane takes the plain text without the header, with no --raw: the raw way, not the delivery', async () => {
    slot.kind = 'shell'
    path = 'wait'
    const r = await run()
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual(typed, ['olá'])
    assert.equal(delivered.length, 0)
    assert.equal((r.data as { state: string }).state, 'typed')
  })

  test('a receipt `unsent` from the delivery is an error of the verb, not a success', async () => {
    path = 'wait'
    receipt = { id: 'm_5', slotId: PANE, state: 'typed', at: '', unsent: true }
    const r = await run()
    assert.equal(r.isError, true)
    assert.equal(codeOf(r), 'unsent')
    assert.equal((r.data as { id?: string }).id, 'm_5')
    assert.deepEqual(outcomes, [true])
  })

  test('the store is told whether each send failed: success no, unsent and unconfirmed yes, busy and with-user no', async () => {
    await run()
    sendImpl = async () => { throw new Error('o texto continua na caixa') }
    await run()
    sendImpl = async () => { throw new ConductError('busy', 'o motor está em turno') }
    await run()
    sendImpl = async () => { throw new ConductError('with-user', 'com a pessoa') }
    receipt = { id: 'm_6', slotId: PANE, state: 'queued', at: '' }
    await run()
    assert.deepEqual(outcomes, [false, true, false, false])
  })
})
