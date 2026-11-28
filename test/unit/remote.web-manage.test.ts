// Managing from afar (RR5 5.4), the device's side with no screen: which rows the menus of a desk, a pane and a closed session
// have by the device's scopes and the house's state; the app's questions in its own words; the person's sentence for each
// refusal (never the code); what an answer means for an act on its way; the act itself (one actId until its answer, the same
// id and the same proof again after a cut or a timeout, the biometrics before the first send of an act that destroys and
// again on 0x05, the window opened on 0x05 for one that gives power, a cancelled biometrics sending nothing); the ceilings
// of the portal checked before anything goes.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DESK_NAME_MAX } from '../../src/remote/app-acts.ts'
import { opByName, RES_STATUS, toHex, type Bytes, type UvProof } from '../../src/remote/index.ts'
import { RONDA_TEXT_MAX, SLOT_NAME_MAX } from '../../src/remote/manage.ts'
import { createManager, type ManageSession, type Prover } from '../../remote/web/src/manage.ts'
import {
  actStepOf, capsOf, closedMenu, closeDeskQuestion, closePaneQuestion, deskMenu, deskNameCheck, forgetClosedQuestion, hibernateQuestion,
  managesAny, neighbourOf, NO_CAPS, paneMenu, PROOF_LINE, reasonCheck, refusalWords, RESEND_MS, rondaCheck, slotNameCheck, stopAgentQuestion,
  type Caps, type DeskFacts, type MenuLine, type PaneFacts,
} from '../../remote/web/src/manage-rules.ts'
import { okDoes } from '../../remote/web/src/focus-rules.ts'

const ALL: Caps = { desks: true, agents: true, procs: true, destructive: true, channels: true }
const labels = (lines: readonly MenuLine[]): string[] => lines.map(l => (l === 'sep' ? '—' : 'heading' in l ? `# ${l.heading}` : l.label))
const desk = (o: Partial<DeskFacts> = {}): DeskFacts => ({ id: 'd1', name: 'Obra', kind: 'queue', asleep: false, queue: 2, awake: 2, ...o })
const pane = (o: Partial<PaneFacts> = {}): PaneFacts => ({
  id: 'p1', deskId: 'd1', title: 'conferente', type: 'terminal', agent: { name: 'conferente' }, asleep: false, exited: false, busy: false, moveTo: 1, ...o,
})

describe('what the device may do', () => {
  test('the scopes of manage, and nothing at all without a presence credential', () => {
    assert.deepEqual(capsOf(['manage:desks', 'channels'], true), { desks: true, agents: false, procs: false, destructive: false, channels: true })
    assert.deepEqual(capsOf(['manage:desks', 'manage:agents', 'manage:procs', 'manage:destructive'], false), NO_CAPS, 'a device that only reads acts on nothing (E-8)')
    assert.equal(managesAny(NO_CAPS), false)
    assert.equal(managesAny(capsOf(['manage:procs'], true)), true)
  })
})

describe('the rows of a desk', () => {
  test('awake: the pill\'s rows from afar, in the app\'s words', () => {
    assert.deepEqual(labels(deskMenu(desk(), ALL, 0)), ['Renomear', 'Cor…', 'Hibernar mesa', 'Fechar mesa…'])
  })
  test('hibernating shows "Despertar mesa"; the last awake desk does not hibernate; the only desk does not close', () => {
    assert.ok(labels(deskMenu(desk({ asleep: true, awake: 1 }), ALL, 0)).includes('Despertar mesa'))
    assert.ok(!labels(deskMenu(desk({ asleep: true, awake: 1 }), ALL, 0)).includes('Hibernar mesa'))
    assert.ok(!labels(deskMenu(desk({ awake: 1 }), ALL, 0)).includes('Hibernar mesa'), 'the last awake desk stays awake')
    assert.ok(!labels(deskMenu(desk({ queue: 1, awake: 1 }), ALL, 0)).includes('Fechar mesa…'))
  })
  test('by scope: without manage:desks nothing of the pill; without destructive no close; Browser and the drawer have no menu', () => {
    assert.deepEqual(labels(deskMenu(desk(), { ...ALL, desks: false }, 0)), ['Fechar mesa…'])
    assert.ok(!labels(deskMenu(desk(), { ...ALL, destructive: false }, 0)).includes('Fechar mesa…'))
    assert.deepEqual(deskMenu(desk({ kind: 'system' }), ALL, 2), [])
    assert.deepEqual(deskMenu(desk(), NO_CAPS, 2), [])
  })
  test('ownership in for-agents\' words: give with no owner (when there are agents), take, give back and take away with one', () => {
    assert.deepEqual(labels(deskMenu(desk(), { ...NO_CAPS, agents: true }, 1)), ['# Quem manda aqui: você', 'Dar a mesa a um agente…'])
    assert.deepEqual(labels(deskMenu(desk(), { ...NO_CAPS, agents: true }, 0)), [], 'no agent, nobody to give it to')
    assert.deepEqual(labels(deskMenu(desk({ owner: { id: 'a1', name: 'Atrium' } }), { ...NO_CAPS, agents: true }, 1)),
      ['# Quem manda aqui: Atrium', 'Assumir o comando da mesa', 'Devolver a mesa a Atrium', 'Tirar a mesa de Atrium…'])
  })
})

describe('the rows of a pane', () => {
  test('an agent running: its block, the pane\'s block, the close last', () => {
    assert.deepEqual(labels(paneMenu(pane(), { ...ALL, agents: false }, 0)),
      ['# Esta guia', 'Espiar', 'Mover…', 'Hibernar guia', 'Suspender guia', '—', 'Fechar guia'])
    assert.deepEqual(labels(paneMenu(pane(), ALL, 0)).slice(0, 4), ['# O agente conferente', 'Reiniciar agente', 'Encerrar agente…', '—'])
  })
  test('hibernating shows "Despertar guia" and nothing that needs it running', () => {
    const l = labels(paneMenu(pane({ asleep: true }), ALL, 0))
    assert.ok(l.includes('Despertar guia'))
    for (const x of ['Hibernar guia', 'Suspender guia', 'Reiniciar agente', 'Encerrar agente…']) assert.ok(!l.includes(x), x)
  })
  test('an ended agent resumes; a note has no process to sleep; no other awake desk, no move', () => {
    assert.ok(labels(paneMenu(pane({ exited: true }), ALL, 0)).includes('Retomar agente'))
    const note = labels(paneMenu(pane({ type: 'note', agent: undefined }), ALL, 0))
    assert.deepEqual(note, ['# Esta guia', 'Espiar', 'Mover…', '—', 'Fechar guia'])
    assert.ok(!labels(paneMenu(pane({ moveTo: 0 }), ALL, 0)).includes('Mover…'))
  })
  test('who commands it: its own owner, else its desk\'s, else you', () => {
    assert.ok(labels(paneMenu(pane({ owner: { id: 'a', name: 'Atrium' } }), ALL, 1)).includes('# Quem manda aqui: Atrium'))
    assert.ok(labels(paneMenu(pane({ owner: { id: 'a', name: 'Atrium' } }), ALL, 1)).includes('Tirar de Atrium (volta para a mesa)'))
    assert.ok(labels(paneMenu(pane({ deskOwner: { id: 'b', name: 'Bia' } }), ALL, 1)).includes('# Quem manda aqui: Bia'))
    assert.ok(labels(paneMenu(pane(), ALL, 1)).includes('Dar esta guia a um agente…'))
  })
  test('a device that only reads has "Espiar" alone', () => {
    assert.deepEqual(labels(paneMenu(pane(), NO_CAPS, 3)), ['# Esta guia', 'Espiar'])
  })
})

describe('the rows of a closed session', () => {
  test('"Reabrir em…" with an awake desk, "Esquecer…" with destructive', () => {
    assert.deepEqual(labels(closedMenu({ id: 's', name: 'migra', awakeDesks: 1 }, ALL)), ['Reabrir em…', '—', 'Esquecer…'])
    assert.deepEqual(labels(closedMenu({ id: 's', name: 'migra', awakeDesks: 0 }, ALL)), ['Esquecer…'])
    assert.deepEqual(labels(closedMenu({ id: 's', name: 'migra', awakeDesks: 1 }, { ...ALL, destructive: false })), ['Reabrir em…'])
  })
})

describe('the questions, in the app\'s words', () => {
  test('closing a pane with an agent running: keep it running without a pane, or end it; both need the biometrics', () => {
    const q = closePaneQuestion(pane(), 'Claude')
    assert.equal(q.title, 'Esta guia tem o Claude rodando')
    assert.deepEqual(q.choices.map(c => c.label), ['Só fechar a guia', 'Encerrar o Claude'])
    assert.ok(q.choices.every(c => c.proof))
    assert.equal(q.cancel, 'Deixar aberto')
    assert.match(q.choices[0]!.consequence, /continua rodando sem guia/)
    assert.equal(closePaneQuestion(pane({ agent: undefined }), undefined).title, 'Esta guia tem um shell aberto')
    assert.equal(closePaneQuestion(pane({ exited: true }), 'Claude').title, 'O Claude não está rodando nesta guia')
  })
  test('closing a desk: move its panes to the neighbour (by name) or end and close; an empty one only closes', () => {
    const q = closeDeskQuestion('Obra', [pane(), pane({ id: 'p2', title: 'web', agent: undefined, exited: true })], 'Migração')
    assert.equal(q.title, 'A mesa "Obra" tem agentes rodando')
    assert.deepEqual(q.choices.map(c => [c.id, c.label]), [['move', 'Mover os painéis para "Migração"'], ['stop', 'Encerrar e fechar a mesa']])
    assert.equal(q.context?.status, '1 processo rodando')
    assert.deepEqual(closeDeskQuestion('Vazia', [], 'Obra').choices.map(c => c.id), ['move'])
  })
  test('forgetting, ending, hibernating with an agent mid-turn', () => {
    assert.equal(forgetClosedQuestion('migra').title, 'Esquecer a sessão de migra?')
    assert.match(forgetClosedQuestion('migra').lead ?? '', /não pode ser desfeito/)
    assert.deepEqual(stopAgentQuestion(pane(), 'Claude').choices.map(c => c.label), ['Encerrar o Claude'])
    assert.equal(stopAgentQuestion(pane(), 'Claude').choices[0]!.proof, undefined, 'ending an agent is not per-act')
    assert.equal(hibernateQuestion('da mesa "Obra"', ['conferente']).title, 'Um agente da mesa "Obra" está trabalhando')
    assert.deepEqual(hibernateQuestion('da mesa "Obra"', ['a', 'b']).choices.map(c => c.label), ['Hibernar mesmo assim'])
    assert.match(PROOF_LINE, /biometria/)
  })
  test('the neighbour of a desk: the next, else the one before', () => {
    const q = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    assert.equal(neighbourOf(q, 'a')?.id, 'b')
    assert.equal(neighbourOf(q, 'c')?.id, 'b')
    assert.equal(neighbourOf(q, 'x'), undefined)
  })
})

describe('the refusals in the person\'s words', () => {
  test('never the code', () => {
    assert.equal(refusalWords('no-app'), 'O tether não está aberto na máquina. Nada foi feito.')
    assert.equal(refusalWords('with-user'), 'Alguém está usando esta guia na máquina agora.')
    assert.match(refusalWords('last-desk'), /É a última mesa/)
    for (const code of ['no-app', 'with-user', 'in-view', 'last-desk', 'same-desk', 'not-closed', 'not-given', 'cannot', 'owners-off', 'unconfirmed',
      'no-answer', 'refused', 'timeout', 'busy', 'unknown-desk', 'unknown-pane', 'unknown-slot', 'unknown-agent', 'unknown-proc', 'proc-in-use',
      'proc-running', 'port-busy', 'too-long', 'bad-request', 'no-scope', 'no-credential', 'locked', 'cut', 'cancelled', 'whatever-else']) {
      const w = refusalWords(code)
      assert.ok(w.length > 8 && !w.includes(code), `${code}: ${w}`)
    }
  })
})

describe('what an answer means for an act on its way', () => {
  test('done, resend (the session fell, timeout), prove again (0x05 with a proof), locked, fail', () => {
    assert.deepEqual(actStepOf({ status: RES_STATUS.ok, body: { state: 'done' } }, 'none'), { do: 'done', body: { state: 'done' } })
    assert.deepEqual(actStepOf({ status: -1, body: {} }, 'none'), { do: 'resend', afterMs: RESEND_MS })
    assert.deepEqual(actStepOf({ status: RES_STATUS.failed, body: { error: 'timeout' } }, 'act'), { do: 'resend', afterMs: RESEND_MS })
    assert.deepEqual(actStepOf({ status: RES_STATUS.presenceRequired, body: {} }, 'act'), { do: 'prove' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.presenceRequired, body: {} }, 'window'), { do: 'prove' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.presenceRequired, body: {} }, 'none'), { do: 'fail', code: 'no-credential' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.locked, body: {} }, 'none'), { do: 'locked' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.noApp, body: { error: 'no-app' } }, 'none'), { do: 'fail', code: 'no-app' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.limit, body: { error: 'busy' } }, 'none'), { do: 'fail', code: 'busy' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.failed, body: { error: 'with-user' } }, 'none'), { do: 'fail', code: 'with-user' })
    assert.deepEqual(actStepOf({ status: RES_STATUS.failed, body: { error: 'no-answer' } }, 'none'), { do: 'fail', code: 'no-answer' }, 'taken and not answered: it may have happened, never sent again')
    assert.deepEqual(actStepOf({ status: RES_STATUS.failed, body: { error: '<b>' } }, 'none'), { do: 'fail', code: 'refused' }, 'an odd code is no code')
  })
})

describe('the ceilings, before anything is sent', () => {
  test('a desk\'s name and a slot\'s name: folded as the portal does, empty and too long refused', () => {
    assert.deepEqual(deskNameCheck('  Obra‮ nova '), { ok: true, value: 'Obra nova' })
    assert.equal(deskNameCheck('   ').ok, false)
    assert.equal(deskNameCheck('x'.repeat(DESK_NAME_MAX + 1)).ok, false)
    assert.equal(deskNameCheck('x'.repeat(DESK_NAME_MAX)).ok, true)
    assert.equal(slotNameCheck('x'.repeat(SLOT_NAME_MAX + 1)).ok, false)
  })
  test('the ronda: an interval of [0-9a-z ], a nudge and a criterion of at most 500', () => {
    assert.deepEqual(rondaCheck({ interval: ' 20M ' }), { ok: true, value: { interval: '20m' } })
    assert.equal(rondaCheck({ interval: '20m;rm' }).ok, false)
    assert.equal(rondaCheck({ criterion: 'x'.repeat(RONDA_TEXT_MAX + 1) }).ok, false)
    assert.deepEqual(rondaCheck({ criterion: '' }), { ok: true, value: { criterion: '' } }, "'' clears")
  })
  test('the reason of a force: required, at most 200', () => {
    assert.equal(reasonCheck('  ').ok, false)
    assert.equal(reasonCheck('x'.repeat(201)).ok, false)
    assert.deepEqual(reasonCheck(' preciso da porta '), { ok: true, value: 'preciso da porta' })
  })
})

describe('the TV\'s OK on a row of the tree', () => {
  test('opens its menu on a device that manages, clicks it on one that reads', () => {
    assert.equal(okDoes('tree', false, true), 'menu')
    assert.equal(okDoes('tree', false), 'click')
    assert.equal(okDoes('chip', false, true), 'click')
  })
})

// ---------------------------------------------------------------- the act itself, over a made-up session

interface Call { op: number; body: string; actId: string; proof: string }
const decode = (b: Record<string, unknown> | Bytes | undefined): string => (b instanceof Uint8Array ? new TextDecoder().decode(b) : JSON.stringify(b ?? {}))
const proofOf = (n: number): UvProof => ({ uvCtr: n, authenticatorData: new Uint8Array([n]), clientDataJSON: new Uint8Array([n]), signature: new Uint8Array([n]) })
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function bench(answer: (op: number, n: number) => { status: number; body: Record<string, unknown> }, prover: Partial<Prover> = {}) {
  const calls: Call[] = []
  const proofs: string[] = []
  const timers: (() => void)[] = []
  let clock = 0
  const info = opByName('session.info')!.code
  const s: ManageSession = {
    ended: undefined,
    sessionId: new Uint8Array(16),
    request: async (op, body, o) => {
      if (op === info) return { status: RES_STATUS.ok, body: { scopes: ['manage:desks', 'manage:agents', 'manage:procs', 'manage:destructive'], deviceId: 'ab'.repeat(16) } }
      calls.push({ op, body: decode(body), actId: o?.actId ? toHex(o.actId) : '', proof: o?.uvProof ? String(o.uvProof.uvCtr) : '' })
      return answer(op, calls.length)
    },
  }
  let n = 0
  const p: Prover = {
    act: prover.act ?? (async () => { n++; proofs.push(`act${n}`); return { ok: true, uvProof: proofOf(n) } }),
    window: prover.window ?? (async () => { proofs.push('window'); return { ok: true } }),
  }
  const m = createManager({ credential: true, prover: p, now: () => clock, setTimer: (fn) => { timers.push(fn); return 0 } })
  m.attach(s)
  const tick = (ms: number): void => { clock += ms; for (const t of timers.splice(0)) t() }
  return { m, calls, proofs, tick }
}

describe('an act on its way (manage.ts)', () => {
  const HIB = opByName('desks.hibernate')!.code
  const CLOSE = opByName('panes.close')!.code
  const GIVE = opByName('owners.give')!.code

  test('the caps come from session.info', async () => {
    const b = bench(() => ({ status: RES_STATUS.ok, body: {} }))
    await flush()
    assert.deepEqual(b.m.caps, { desks: true, agents: true, procs: true, destructive: true, channels: false })
  })

  test('a timeout and a cut send the SAME actId again; the real answer ends it', async () => {
    const replies = [{ status: RES_STATUS.failed, body: { error: 'timeout' } }, { status: -1, body: {} }, { status: RES_STATUS.ok, body: { state: 'done' } }]
    const b = bench((_op, n) => replies[n - 1]!)
    const done = b.m.act('desks.hibernate', { deskId: 'd1' })
    await flush(); b.tick(RESEND_MS); await flush(); b.tick(RESEND_MS); await flush()
    assert.deepEqual(await done, { ok: true, body: { state: 'done' } })
    assert.equal(b.calls.length, 3)
    assert.ok(b.calls.every(c => c.op === HIB && c.actId === b.calls[0]!.actId && c.body === '{"deskId":"d1"}'), JSON.stringify(b.calls))
  })

  test('a refusal ends it at once, with its code (no resend)', async () => {
    const b = bench(() => ({ status: RES_STATUS.noApp, body: { error: 'no-app' } }))
    assert.deepEqual(await b.m.act('desks.hibernate', { deskId: 'd1' }), { ok: false, code: 'no-app', body: { error: 'no-app' } })
    assert.equal(b.calls.length, 1)
  })

  test('an act that destroys: the biometrics before the first send, the same proof with every resend, a new one on 0x05', async () => {
    const replies = [{ status: RES_STATUS.failed, body: { error: 'timeout' } }, { status: RES_STATUS.presenceRequired, body: {} }, { status: RES_STATUS.ok, body: { state: 'done' } }]
    const b = bench((_op, n) => replies[n - 1]!)
    const said: string[] = []
    const done = b.m.act('panes.close', { deskId: 'd1', paneId: 'p1', process: 'keep' }, { proof: 'act', proving: () => said.push('proving') })
    await flush()
    assert.deepEqual(b.proofs, ['act1'], 'the proof first')
    assert.equal(b.calls[0]!.proof, '1')
    b.tick(RESEND_MS); await flush()
    assert.equal(b.calls[1]!.proof, '1', 'the same proof with the resend')
    await flush()
    assert.deepEqual(await done, { ok: true, body: { state: 'done' } })
    assert.deepEqual(b.proofs, ['act1', 'act2'], '0x05: proved again')
    assert.equal(b.calls[2]!.proof, '2')
    assert.ok(b.calls.every(c => c.op === CLOSE && c.actId === b.calls[0]!.actId))
    assert.deepEqual(said, ['proving', 'proving'], 'the screen is told before each ask of the system')
  })

  test('cancelling the biometrics sends nothing', async () => {
    const b = bench(() => ({ status: RES_STATUS.ok, body: {} }), { act: async () => ({ ok: false, fail: 'cancelled' }) })
    assert.deepEqual(await b.m.act('closed.forget', { slotId: 's1' }, { proof: 'act' }), { ok: false, code: 'cancelled' })
    assert.equal(b.calls.length, 0, 'nothing reached the house')
  })

  test('the proof that keeps failing is asked at most twice', async () => {
    const b = bench(() => ({ status: RES_STATUS.presenceRequired, body: {} }))
    const r = await b.m.act('desks.close', { deskId: 'd1', panes: 'move' }, { proof: 'act' })
    assert.equal(r.ok, false)
    assert.deepEqual(b.proofs, ['act1', 'act2'])
    assert.equal(b.calls.length, 2)
  })

  test('giving power: tried as it is; on 0x05 the window opens and the same act goes again', async () => {
    const replies = [{ status: RES_STATUS.presenceRequired, body: {} }, { status: RES_STATUS.ok, body: { state: 'done' } }]
    const b = bench((_op, n) => replies[n - 1]!)
    await flush()
    const r = await b.m.act('owners.give', { deskId: 'd1', to: 'a1' }, { proof: 'window' })
    assert.deepEqual(r, { ok: true, body: { state: 'done' } })
    assert.deepEqual(b.proofs, ['window'])
    assert.equal(b.calls.length, 2)
    assert.ok(b.calls.every(c => c.op === GIVE && c.actId === b.calls[0]!.actId && c.proof === ''), 'the window is the session\'s: no proof rides the act')
  })

  test('locked: the screen is told, nothing more is sent', async () => {
    const b = bench(() => ({ status: RES_STATUS.locked, body: {} }))
    let locked = 0
    b.m.onLocked = () => { locked++ }
    assert.deepEqual(await b.m.act('agents.stop', { slotId: 'p1' }), { ok: false, code: 'locked' })
    assert.equal(locked, 1)
  })

  test('no session within the deadline: timeout, nothing sent', async () => {
    const b = bench(() => ({ status: RES_STATUS.ok, body: {} }))
    b.m.detach()
    const done = b.m.act('desks.wake', { deskId: 'd1' })
    await flush()
    b.tick(60_000)
    assert.deepEqual(await done, { ok: false, code: 'timeout' })
    assert.equal(b.calls.length, 0)
  })
})
