// Tether for agents, slice X4: the notice to the owner and the screen watch. The door's services are faked in memory (slots with
// a state stream, a screen per slot, desks, objects, a delivery that records, attention that routes like the core does) so
// each edge of the contract is driven by hand and the clock never matters; the stores and the gate are the real ones. The
// screens are the real ones the probes saw (a Soul permission card, a Codex permission card), the engine of the fake
// conductor is the only invention. Nothing touches the user's home, pipe or tetherd.
import assert from 'node:assert/strict'
import { afterEach, before, after, beforeEach, describe, test } from 'node:test'
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { slotAnswerPath } from '../../src/core/paths.ts'
import { conductorRegistry, type Conductor, type Detected } from '../../extensions/for-agents/conductor-api.ts'
import { WriteGate } from '../../extensions/for-agents/daemon/guard.ts'
import { Notices, finishedBody, handLine, returnedBody } from '../../extensions/for-agents/daemon/notices.ts'
import { OwnershipStore } from '../../extensions/for-agents/daemon/ownership.ts'
import { ScreenWatch, type WatchTimers } from '../../extensions/for-agents/daemon/watch.ts'
import { EXT_ID } from '../../extensions/for-agents/manifest.ts'
import type { DeliveryMessage, DeliveryReceipt } from '../../src/daemon/ext-api.ts'
import type { DeskMap, ScreenRead, SlotState } from '../../src/daemon/protocol.ts'
import { sleep } from './daemon.helpers.ts'

// What the probes saw on the screen (sonda-digitar-soul g5, sonda-digitar-codex s5-p), as the terminal shows it.
const SOUL_CARD = [
  ' ● Bash(node -e "setTimeout(()=>{},20000)")',
  '────────────────────────────────────────────────',
  ' Bash command',
  '  node -e "setTimeout(()=>{},20000)"',
  '  Espera de 20 segundos com node',
  ' This command requires approval',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel · Tab to amend · ctrl+e to explain · Ctrl+d to show debug info',
  ' ? waiting for your answer',
  '│ ❯ answer the card above                         │',
].join('\n')
const CODEX_CARD = [
  '• Running cmd /c "echo x> probe-p.txt"',
  '',
  '  Would you like to run the following command?',
  '',
  '  Environment: local',
  '',
  '  $ cmd /c "echo x> probe-p.txt"',
  '',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `cmd /c 'echo x> probe-p.txt'` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n')
const QUESTION = ['Qual banco usamos?', 'QUESTION-MARK', '1. Postgres', '2. SQLite'].join('\n')
const IDLE = ['› ', '  ? for shortcuts'].join('\n')

/** What the fake conductor says the last answer is (its `at` is when it was written), when a test sets it. */
const conductorAnswer: { text?: string; at?: string } = {}

/** The fake engine: reads the screen as the conductors do and says what card is on it. */
const fake: Conductor = {
  id: 'fake-x4',
  match: (t) => (t.slot?.kind === 'soul' ? 10 : undefined),
  capabilities: [],
  watch: true,
  lastAnswer: async () => (conductorAnswer.text === undefined ? undefined : { value: { text: conductorAnswer.text, at: conductorAnswer.at ?? '2099-01-01T00:00:00.000Z', source: 'screen' }, proven: false }),
  detect: async (ctx): Promise<Detected> => {
    const t = await ctx.screen()
    const lines = t.screen.map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
    const text = lines.join('\n')
    if (text.includes('Would you like to run')) {
      return { state: 'permission', card: { title: 'Would you like to run the following command?', text, options: [{ id: 'yes', label: 'Yes, proceed' }, { id: 'always', label: "Yes, and don't ask again" }, { id: 'no', label: 'No' }] } }
    }
    if (text.includes('waiting for your answer')) {
      return { state: 'permission', card: { title: 'Bash command', text, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] } }
    }
    if (text.includes('QUESTION-MARK')) return { state: 'question', card: { title: 'Pergunta', text: 'Qual banco usamos?', options: [{ id: '1', label: 'Postgres' }, { id: '2', label: 'SQLite' }] } }
    return { state: 'idle' }
  },
}

type Listener<T> = (v: T) => void

/** The door in memory: just what the notices and the watch read. */
class World {
  readonly states = new Map<string, SlotState>()
  readonly screens = new Map<string, string>()
  readonly reads: { id: string; since: number | undefined }[] = []
  readonly delivered: { to: string; msg: DeliveryMessage; paths?: unknown }[] = []
  readonly cancelled: string[] = []
  readonly signals: { id: string; kind: string }[] = []
  readonly routes = new Map<string, string>()
  readonly files = new Map<string, string>()
  readonly objs = new Map<string, unknown>()
  readonly events: string[] = []
  /** When true, the delivery answers `queued` (the owner has no way in yet). */
  queue = false
  private n = 0
  private readonly stateL = new Set<Listener<SlotState>>()
  private readonly objL = new Set<Listener<{ kind: 'desk' | 'pane'; id: string; key: string; value: unknown }>>()
  map: DeskMap = { desks: [{ id: 'cena', name: 'cena', kind: 'queue', panes: [{ id: 'own', type: 'terminal' }, { id: 'p1', type: 'terminal' }, { id: 'p2', type: 'terminal' }] }], drawer: [] }

  add(id: string, name: string): void {
    this.states.set(id, { slotId: id, kind: 'soul', name, cwd: 'C:/x', status: 'running' } as SlotState)
  }

  /** A state of the slot goes out (what the core does after each change). */
  set(id: string, patch: Partial<SlotState>, drop: (keyof SlotState)[] = []): SlotState {
    const next = { ...this.states.get(id)!, ...patch } as SlotState
    for (const k of drop) delete next[k]
    this.states.set(id, next)
    for (const l of [...this.stateL]) l(next)
    return next
  }

  /** The core's decoration: attention of a routed slot with a live recipient becomes `attentionFor`. */
  raise(id: string, value: 'done' | 'waiting', extra: Partial<SlotState> = {}, drop: (keyof SlotState)[] = []): SlotState {
    const to = this.routes.get(id)
    const live = to !== undefined && this.states.get(to)?.status === 'running'
    return this.set(id, { ...extra, ...(live ? { attentionFor: { slotId: to, value } } : { attention: value }) }, [...drop, ...(live ? ['attention' as const] : ['attentionFor' as const])])
  }

  clear(id: string): SlotState {
    return this.set(id, {}, ['attention', 'attentionFor'])
  }

  readonly api = {
    home: 'C:/home',
    log: (m: string): void => { this.events.push(`log:${m}`) },
    onSlot: (): IDisposable => toDisposable(() => {}),
    agents: { get: () => undefined },
    io: { tryReadText: async (p: string): Promise<string | undefined> => this.files.get(p) },
    slots: {
      get: (id: string): SlotState | undefined => this.states.get(id),
      list: (): SlotState[] => [...this.states.values()],
      onState: (l: Listener<SlotState>): IDisposable => { this.stateL.add(l); return toDisposable(() => this.stateL.delete(l)) },
      userFree: (): boolean => true,
      readScreen: (id: string, opts?: { since?: number }): ScreenRead => {
        this.reads.push({ id, since: opts?.since })
        const raw = (this.screens.get(id) ?? '').replace(/\n/g, '\r\n')
        const since = opts?.since ?? 0
        return { data: raw.slice(since), cols: 120, rows: 40, start: 0, end: raw.length, reset: false }
      },
    },
    desks: {
      ready: Promise.resolve(),
      map: (): DeskMap => this.map,
      deskOf: (id: string) => this.map.desks.find((d) => d.panes.some((p) => p.id === id)),
      onDidChange: (): IDisposable => toDisposable(() => {}),
    },
    objects: {
      ready: Promise.resolve(),
      get: <T,>(kind: string, id: string, key: string): T | undefined => this.objs.get(`${kind}|${id}|${key}`) as T | undefined,
      set: async (kind: 'desk' | 'pane', id: string, key: string, value: unknown): Promise<void> => {
        if (value === undefined) this.objs.delete(`${kind}|${id}|${key}`)
        else this.objs.set(`${kind}|${id}|${key}`, value)
        for (const l of [...this.objL]) l({ kind, id, key, value })
      },
      entries: <T,>(kind: string, key: string): [string, T][] => {
        const out: [string, T][] = []
        for (const [k, v] of this.objs) { const [kd, id, ky] = k.split('|'); if (kd === kind && ky === key) out.push([id!, v as T]) }
        return out
      },
      onDidChange: (l: Listener<{ kind: 'desk' | 'pane'; id: string; key: string; value: unknown }>): IDisposable => { this.objL.add(l); return toDisposable(() => this.objL.delete(l)) },
      onDidDrop: (): IDisposable => toDisposable(() => {}),
    },
    delivery: {
      deliver: async (to: string, msg: DeliveryMessage, opts?: { paths?: unknown }): Promise<DeliveryReceipt> => {
        this.delivered.push({ to, msg, ...(opts?.paths ? { paths: opts.paths } : {}) })
        return { id: `r${++this.n}`, slotId: to, state: this.queue ? 'queued' : 'inside', at: 'now' }
      },
      cancel: (id: string): boolean => { this.cancelled.push(id); return true },
    },
    attention: {
      routeOf: (id: string): string | undefined => this.routes.get(id),
      signal: (id: string, kind: string): void => { this.events.push(`signal:${id}`); this.signals.push({ id, kind }) },
    },
  }
}

const TURN_START = '2026-11-21T10:00:00.000Z'
const TURN_END = '2026-11-21T10:00:09.000Z'
const own = (v: string) => ({ owner: v, since: 'then', givenBy: 'user' })
const settle = (ms = 150): Promise<void> => sleep(ms)

describe('for-agents: the notice to the owner and the screen watch (X4)', () => {
  let w: World
  let store: OwnershipStore
  let notices: Notices
  let live: IDisposable[]
  let unregister: IDisposable

  before(() => { unregister = conductorRegistry.register(fake) })
  after(() => unregister.dispose())

  beforeEach(async () => {
    w = new World()
    w.add('own', 'Atrium'); w.add('p1', 'bancada'); w.add('p2', 'cozinha')
    // The desk is Atrium's; Atrium is also given its own pane ("de si"), which is where the tether types into it.
    await w.api.objects.set('desk', 'cena', 'owner', own('own'))
    store = new OwnershipStore(w.api.objects as never, w.api.desks as never)
    w.routes.set('p1', 'own'); w.routes.set('p2', 'own')
    live = []
    notices = new Notices(w.api as never, { store, gate: new WriteGate(store, w.api.slots as never) }, { settleMs: 10, cardWaitMs: 300, cardPollMs: 10 })
    live.push(w.api.slots.onState((s) => notices.stateChanged(s)), w.api.objects.onDidChange((e) => notices.objectChanged(e)))
  })
  afterEach(() => { for (const d of live) d.dispose(); notices.dispose() })

  // ---- the edge --------------------------------------------------------------------------------

  test('a finished turn is one notice in the guia\'s name, with the exact body of 4.3', async () => {
    w.set('p1', { turn: 'busy', busySince: TURN_START })
    w.files.set(slotAnswerPath('C:/home', 'p1'), JSON.stringify({ ts: TURN_END, text: 'Feito: criei o arquivo.', from: 'claude-stop' }))
    w.raise('p1', 'done', { idleSince: TURN_END }, ['turn'])
    await settle()
    assert.equal(w.delivered.length, 1)
    const { to, msg } = w.delivered[0]!
    assert.equal(to, 'own')
    assert.deepEqual(msg.from, { name: 'soul · bancada', id: 'p1', role: 'member' })
    assert.equal(msg.kind, 'notice')
    assert.equal(msg.body, 'terminou · guia p1 · mesa cena\nÚltima resposta (23 caracteres):\nFeito: criei o arquivo.\nLer tudo: agents last-answer p1')
  })

  test('a long answer is cut at 600 characters and says the total', () => {
    const body = finishedBody('p1', 'cena', 'a'.repeat(2810))
    const lines = body.split('\n')
    assert.equal(lines[0], 'terminou · guia p1 · mesa cena')
    assert.equal(lines[1], 'Última resposta (600 de 2810 caracteres):')
    assert.equal(lines[2], `${'a'.repeat(600)}…`)
    assert.equal(lines[3], 'Ler tudo: agents last-answer p1')
  })

  test('one edge, one notice: the same attention broadcast again does not notify twice', async () => {
    const s = w.raise('p1', 'done', { idleSince: 'T1' })
    notices.stateChanged(s)
    notices.stateChanged(s)
    w.set('p1', { name: 'bancada' }) // a rename broadcasts the state again, with the same attentionFor
    await settle()
    assert.equal(w.delivered.length, 1)
  })

  // The core's silence heuristic can say `done` for a Codex whose Enter did not take (the box redraws, nothing ran). The
  // `done` lands while the send is still being checked; it is told only if that send did not fail.
  test('a send left unsent, then the heuristic done: nothing is told, and a line says why', async () => {
    const end = store.beginSend('p1')
    w.raise('p1', 'done', { idleSince: 'T1' })
    await settle()
    assert.equal(w.delivered.length, 0, 'held while the send is checked')
    end(true)
    await settle()
    assert.equal(w.delivered.length, 0)
    assert.ok(w.events.some((e) => e.startsWith('log:aviso de p1 descartado')))
  })

  test('a send that worked, then done: the "terminou" goes out', async () => {
    const end = store.beginSend('p1')
    w.raise('p1', 'done', { idleSince: 'T1' })
    end(false)
    await settle()
    assert.equal(w.delivered.length, 1)
    assert.match(w.delivered[0]!.msg.body, /^terminou · guia p1/)
  })

  test('an unsent send, then a send that worked, then done: the "terminou" goes out', async () => {
    store.beginSend('p1')(true)
    store.beginSend('p1')(false)
    w.raise('p1', 'done', { idleSince: 'T1' })
    await settle()
    assert.equal(w.delivered.length, 1)
  })

  test('a failed send explains one done only: the next turn is told', async () => {
    store.beginSend('p1')(true)
    w.raise('p1', 'done', { idleSince: 'T1' })
    await settle()
    assert.equal(w.delivered.length, 0)
    w.raise('p1', 'done', { idleSince: 'T2' })
    await settle()
    assert.equal(w.delivered.length, 1)
  })

  test('a new turn is a new edge; the owner acting and the attention coming back is one too', async () => {
    w.raise('p1', 'done', { idleSince: 'T1' })
    await settle()
    w.raise('p1', 'done', { idleSince: 'T2' })
    await settle()
    assert.equal(w.delivered.length, 2)
    w.clear('p1')
    w.raise('p1', 'done', { idleSince: 'T2' })
    await settle()
    assert.equal(w.delivered.length, 3, 'the attention went away and came back')
  })

  test('a permission card: the card as on the screen, the options the engine has, how to answer', async () => {
    w.screens.set('p1', SOUL_CARD)
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle()
    assert.equal(w.delivered.length, 1)
    const { msg } = w.delivered[0]!
    assert.equal(msg.kind, 'request')
    assert.equal(msg.from.role, 'member')
    const lines = msg.body.split('\n')
    assert.equal(lines[0], 'pede permissão · guia p1 · mesa cena')
    assert.ok(lines.map((l) => l.trim()).includes("Do you want to proceed?"))
    assert.deepEqual(lines.slice(-2), ['Opções: yes · no', 'Responder: agents answer p1 <opção>'])
    assert.ok(lines.length <= 1 + 20 + 2)

    w.screens.set('p2', CODEX_CARD)
    w.raise('p2', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle()
    const codex = w.delivered[1]!.msg.body.split('\n')
    assert.deepEqual(codex.slice(-2), ['Opções: yes · always · no', 'Responder: agents answer p2 <opção>'])
    assert.ok(codex.some((l) => l.includes('Would you like to run the following command?')))
  })

  test('a question: the text, the numbered options, both ways to answer', async () => {
    w.screens.set('p1', QUESTION)
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle()
    const { msg } = w.delivered[0]!
    assert.equal(msg.kind, 'request')
    assert.equal(msg.body, 'pergunta · guia p1 · mesa cena\nQual banco usamos?\n1. Postgres\n2. SQLite\nResponder: agents answer p1 <n> ou agents send p1 "<texto>"')
  })

  test('a waiting that no conductor can name says it waits and where to read the screen', async () => {
    w.screens.set('p1', IDLE)
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle(30)
    assert.equal(w.delivered.length, 0, 'the generic notice waits for the card until the deadline')
    await settle(450)
    const body = w.delivered[0]!.msg.body.split('\n')
    assert.equal(body[0], 'espera por você · guia p1 · mesa cena')
    assert.equal(body.at(-1), 'Ver a tela: agents read-screen p1')
  })

  test('a bell before the card is drawn tells nothing until the card is there; then one request with the options', async () => {
    w.screens.set('p1', ['• Vou criar ola.txt.', '• Working (6s • esc to interrupt)'].join('\n'))
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle(30)
    assert.equal(w.delivered.length, 0, 'no card yet: nothing is told')
    w.screens.set('p1', `${w.screens.get('p1')}\n${CODEX_CARD}`) // the engine draws the card after the bell
    await settle()
    assert.equal(w.delivered.length, 1)
    const { msg } = w.delivered[0]!
    assert.equal(msg.kind, 'request')
    assert.equal(msg.body.split('\n')[0], 'pede permissão · guia p1 · mesa cena')
    assert.ok(msg.body.includes('Opções: yes · always · no'))
  })

  test('after the answer, the bell of the turn end tells no request: the finish comes alone', async () => {
    w.screens.set('p1', CODEX_CARD)
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle()
    assert.equal(w.delivered.length, 1)
    w.clear('p1') // the owner answered: typing clears the attention
    w.screens.set('p1', `${w.screens.get('p1')}\x1b[2J\x1b[H${IDLE}`) // the card is gone
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' }) // the bell of the turn end, before the engine's `done`
    await settle(20)
    w.raise('p1', 'done', { idleSince: 'T2' }, ['turn'])
    await settle()
    assert.deepEqual(w.delivered.map((d) => d.msg.kind), ['request', 'notice'])
    assert.ok(w.delivered[1]!.msg.body.startsWith('terminou · guia p1'))
  })

  test('the guia "de si" does not notify itself, and a pane with no route notifies nobody', async () => {
    w.routes.set('own', 'own')
    w.raise('own', 'done', { idleSince: 'T1' })
    w.clear('p2'); w.routes.delete('p2')
    w.raise('p2', 'done', { idleSince: 'T1' })
    await settle()
    assert.equal(w.delivered.length, 0)
  })

  test('a notice that is no longer true (the owner changed while the screen was read) is not sent', async () => {
    w.screens.set('p1', SOUL_CARD)
    w.raise('p1', 'waiting', { busySince: 'B1', turn: 'busy' })
    w.clear('p1')
    await settle()
    assert.equal(w.delivered.length, 0)
  })

  // ---- the owner away and back -----------------------------------------------------------------

  test('the owner away gets nothing and nothing waits; back, it gets ONE notice with the state of now', async () => {
    w.set('own', { status: 'exited' })
    w.raise('p1', 'done', { idleSince: 'T1' }) // the person is called (attention, not attentionFor)
    w.screens.set('p2', SOUL_CARD)
    w.raise('p2', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle()
    assert.equal(w.delivered.length, 0)
    assert.equal(w.cancelled.length, 0)

    w.set('own', { status: 'running' })
    w.raise('p1', 'done', { idleSince: 'T1' }) // the core re-sends the routed slots when the owner is live again
    w.raise('p2', 'waiting', { busySince: 'B1', turn: 'busy' })
    await settle()
    assert.equal(w.delivered.length, 1)
    const { to, msg } = w.delivered[0]!
    assert.equal(to, 'own')
    assert.deepEqual(msg.from, { name: 'tether', id: 'tether', role: 'system' })
    assert.equal(msg.kind, 'notice')
    assert.equal(msg.body, 'você voltou · esperam por você: p1 (terminou), p2 (pede permissão)')
    assert.equal(returnedBody(['a (terminou)']), 'você voltou · esperam por você: a (terminou)')
  })

  test('what the person already saw while the owner was away is not told on its return', async () => {
    w.set('own', { status: 'exited' })
    w.raise('p1', 'done', { idleSince: 'T1' })
    w.clear('p1') // the person looked
    w.set('own', { status: 'running' })
    await settle()
    assert.equal(w.delivered.length, 0)
  })

  // ---- the pending ones ------------------------------------------------------------------------

  test('a change of ownership cancels what waits for the guia; a newer notice replaces the older one', async () => {
    w.queue = true
    w.raise('p1', 'done', { idleSince: 'T1' })
    await settle()
    w.raise('p1', 'done', { idleSince: 'T2' })
    await settle()
    assert.deepEqual(w.cancelled, ['r1'], 'the second replaced the first')
    await w.api.objects.set('pane', 'p1', 'owner', own('other'))
    await settle()
    assert.deepEqual(w.cancelled, ['r1', 'r2'])
    await w.api.objects.set('pane', 'p1', 'owner', undefined)
    assert.deepEqual(w.cancelled, ['r1', 'r2', 'r3'], 'r3: the desk owner is told it only sees now; the revoke replaces it')
  })

  test('a delivery that finished no longer counts as waiting', async () => {
    w.queue = true
    w.raise('p1', 'done', { idleSince: 'T1' })
    await settle()
    notices.delivered({ id: 'r1', slotId: 'own', state: 'inside', at: 'now' })
    await w.api.objects.set('pane', 'p1', 'owner', own('other'))
    assert.deepEqual(w.cancelled, [])
  })

  // ---- the hand --------------------------------------------------------------------------------

  const hand = (why: 'taken' | 'paused') => ({ with: 'user', why, by: 'gesture', since: 'now' })

  test('taking, pausing, resuming and giving back are told to the owner, one line, system', async () => {
    await w.api.objects.set('pane', 'p1', 'hand', hand('taken'))
    await w.api.objects.set('pane', 'p1', 'hand', undefined)
    await w.api.objects.set('pane', 'p1', 'hand', hand('paused'))
    await w.api.objects.set('pane', 'p1', 'hand', undefined)
    await settle()
    assert.deepEqual(w.delivered.map((d) => d.msg.body), [
      'o usuário tomou a guia bancada', 'o usuário devolveu a guia bancada', 'bancada foi pausada para você', 'bancada foi retomada',
    ])
    for (const d of w.delivered) {
      assert.equal(d.to, 'own')
      assert.equal(d.msg.kind, 'notice')
      assert.deepEqual(d.msg.from, { name: 'tether', id: 'tether', role: 'system' })
    }
    assert.equal(handLine('owner', 'owner', 'x'), undefined)
  })

  test('taking the desk is one notice to the owner with a line per guia it commands; the own pane has none', async () => {
    await w.api.objects.set('desk', 'cena', 'hand', hand('taken'))
    await settle()
    assert.equal(w.delivered.length, 1)
    assert.equal(w.delivered[0]!.msg.body, 'o usuário tomou a guia bancada\no usuário tomou a guia cozinha')
  })

  test('the guia "de si" is never told it was taken, and giving a hand back that was never taken says nothing', async () => {
    await w.api.objects.set('pane', 'own', 'owner', own('own'))
    await w.api.objects.set('pane', 'own', 'hand', hand('taken'))
    await w.api.objects.set('pane', 'p2', 'hand', undefined)
    await settle()
    assert.equal(w.delivered.length, 0)
  })

  test('an owner that is away is not told of the hand either (nothing queues)', async () => {
    w.set('own', { status: 'exited' })
    await w.api.objects.set('pane', 'p1', 'hand', hand('taken'))
    await settle()
    assert.equal(w.delivered.length, 0)
  })
})

describe('for-agents: giving, revoking, pausing and the answer of the turn (X4)', () => {
  let w: World
  let store: OwnershipStore
  let notices: Notices
  let live: IDisposable[]
  let unregister: IDisposable

  before(() => { unregister = conductorRegistry.register(fake) })
  after(() => unregister.dispose())

  beforeEach(() => {
    w = new World()
    w.add('own', 'Atrium'); w.add('kai', 'Kai'); w.add('p1', 'bancada'); w.add('p2', 'cozinha')
    store = new OwnershipStore(w.api.objects as never, w.api.desks as never)
    w.routes.set('p1', 'own'); w.routes.set('p2', 'own')
    conductorAnswer.text = undefined; conductorAnswer.at = undefined
    notices = new Notices(w.api as never, { store, gate: new WriteGate(store, w.api.slots as never) }, { settleMs: 10, cardWaitMs: 60, cardPollMs: 10 })
    live = [w.api.slots.onState((s) => notices.stateChanged(s)), w.api.objects.onDidChange((e) => notices.objectChanged(e))]
  })
  afterEach(() => { for (const d of live) d.dispose(); notices.dispose() })

  const system = { name: 'tether', id: 'tether', role: 'system' }
  const lines = (): [string, string][] => w.delivered.map((d) => [d.to, d.msg.body])

  test('giving and revoking a desk: the agent that gained and the one that lost are told, one line, system', async () => {
    await w.api.objects.set('desk', 'cena', 'owner', own('own'))
    await w.api.objects.set('desk', 'cena', 'owner', own('kai'))
    await w.api.objects.set('desk', 'cena', 'owner', undefined)
    await settle()
    assert.deepEqual(lines(), [
      ['own', 'você recebeu a mesa cena'],
      ['kai', 'você recebeu a mesa cena'], ['own', 'a mesa cena foi revogada'],
      ['kai', 'a mesa cena foi revogada'],
    ])
    for (const d of w.delivered) { assert.equal(d.msg.kind, 'notice'); assert.deepEqual(d.msg.from, system) }
  })

  test('giving a guia: the agent that gets it is told, and so is the desk owner, who now only sees; revoking tells the loser', async () => {
    await w.api.objects.set('desk', 'cena', 'owner', own('own'))
    w.delivered.length = 0
    await w.api.objects.set('pane', 'p2', 'owner', own('kai'))
    await settle()
    assert.deepEqual(lines(), [['kai', 'você recebeu a guia cozinha'], ['own', 'a guia cozinha foi dada a Kai: agora você só vê']])
    for (const d of w.delivered) assert.deepEqual(d.msg.from, system)
    w.delivered.length = 0
    await w.api.objects.set('pane', 'p2', 'owner', undefined)
    await settle()
    assert.deepEqual(lines(), [['kai', 'a guia cozinha foi revogada']])
  })

  test('a guia given to itself ("de si") tells nobody; a gain that changes nothing is not told twice', async () => {
    await w.api.objects.set('pane', 'p1', 'owner', own('p1'))
    await settle()
    assert.deepEqual(lines(), [])
    await w.api.objects.set('pane', 'p1', 'owner', own('kai'))
    await w.api.objects.set('pane', 'p1', 'owner', own('kai'))
    await settle()
    assert.deepEqual(lines(), [['kai', 'você recebeu a guia bancada']])
  })

  test('the owner paused everywhere is told once, and told when it is resumed', async () => {
    await w.api.objects.set('pane', 'own', 'frozen', { since: 'now' })
    await w.api.objects.set('pane', 'own', 'frozen', { since: 'again' })
    await w.api.objects.set('pane', 'own', 'frozen', undefined)
    await settle()
    assert.deepEqual(lines(), [['own', 'você foi pausada em tudo'], ['own', 'você foi retomada']])
    assert.deepEqual(w.delivered[0]!.msg.from, system)
  })

  const commanded = (): void => { w.objs.set('desk|cena|owner', own('own')) }

  test('an answer from before the turn is never sent as this one: the conductor\'s fresh source, or no block', async () => {
    commanded()
    w.files.set(slotAnswerPath('C:/home', 'p1'), JSON.stringify({ ts: '2026-11-21T09:00:00.000Z', text: 'resposta do turno anterior', from: 'claude-stop' }))
    w.set('p1', { turn: 'busy', busySince: TURN_START })
    w.raise('p1', 'done', { idleSince: TURN_END }, ['turn'])
    await settle()
    assert.equal(w.delivered[0]!.msg.body, 'terminou · guia p1 · mesa cena\nLer tudo: agents last-answer p1', 'stale file, no conductor answer: no block')

    // The conductor has an answer written after the second turn began: it is this turn's.
    w.clear('p1')
    w.set('p1', { turn: 'busy', busySince: '2026-11-21T10:05:00.000Z' })
    conductorAnswer.text = 'resposta deste turno'; conductorAnswer.at = '2026-11-21T10:05:08.000Z'
    w.raise('p1', 'done', { idleSince: '2026-11-21T10:05:09.000Z' }, ['turn'])
    await settle()
    assert.equal(w.delivered[1]!.msg.body, 'terminou · guia p1 · mesa cena\nÚltima resposta (20 caracteres):\nresposta deste turno\nLer tudo: agents last-answer p1')

    // The same conductor answer is stale for the next turn.
    w.clear('p1')
    w.set('p1', { turn: 'busy', busySince: '2026-11-21T10:10:00.000Z' })
    w.raise('p1', 'done', { idleSince: '2026-11-21T10:10:09.000Z' }, ['turn'])
    await settle()
    assert.equal(w.delivered[2]!.msg.body, 'terminou · guia p1 · mesa cena\nLer tudo: agents last-answer p1')
  })

  test('an answer file written during the turn is used', async () => {
    commanded()
    w.files.set(slotAnswerPath('C:/home', 'p1'), JSON.stringify({ ts: TURN_END, text: 'dentro do turno', from: 'claude-stop' }))
    w.set('p1', { turn: 'busy', busySince: TURN_START })
    w.raise('p1', 'done', { idleSince: TURN_END }, ['turn'])
    await settle()
    assert.match(w.delivered[0]!.msg.body, /dentro do turno/)
  })
})

// ---- the watch -----------------------------------------------------------------------------------

describe('for-agents: the screen watch (X4)', () => {
  let w: World
  let store: OwnershipStore
  let watch: ScreenWatch
  let unregister: IDisposable
  const timers = { live: new Set<number>(), made: 0 }
  const fakeTimers: WatchTimers = {
    set: () => { const h = ++timers.made; timers.live.add(h); return h },
    clear: (h) => { timers.live.delete(h as number) },
  }
  const setCard: [string, boolean][] = []

  before(() => { unregister = conductorRegistry.register(fake) })
  after(() => unregister.dispose())

  beforeEach(async () => {
    w = new World()
    w.add('own', 'Atrium'); w.add('p1', 'bancada'); w.add('p2', 'cozinha')
    await w.api.objects.set('desk', 'cena', 'owner', own('own'))
    store = new OwnershipStore(w.api.objects as never, w.api.desks as never)
    w.routes.set('p1', 'own'); w.routes.set('p2', 'own')
    timers.live.clear(); timers.made = 0; setCard.length = 0
    const reconciler = {
      setCard: (id: string, shown: boolean): void => { w.events.push(`setCard:${id}:${shown}`); setCard.push([id, shown]) },
      idle: async (): Promise<void> => { await sleep(5); w.events.push('idle') },
    }
    watch = new ScreenWatch(w.api as never, { store, gate: new WriteGate(store, w.api.slots as never), reconciler }, { timers: fakeTimers })
  })
  afterEach(() => watch.dispose())

  test('no timer with nothing to watch: idle panes, panes with no owner, panes the person holds, a pane that is not in a turn', async () => {
    assert.equal(timers.live.size, 0)
    watch.seed()
    assert.equal(watch.armed, false)
    watch.stateChanged(w.set('p1', {}))                                  // commanded, idle
    watch.stateChanged(w.set('own', { turn: 'busy' }))                    // its own pane in its desk is the person's
    w.map = { desks: [{ id: 'cena', name: 'cena', kind: 'queue', panes: [{ id: 'own', type: 'terminal' }, { id: 'p1', type: 'terminal' }] }], drawer: [{ id: 'p2', type: 'terminal' }] }
    watch.stateChanged(w.set('p2', { turn: 'busy' }))                     // in the drawer: no owner
    await w.api.objects.set('pane', 'p1', 'hand', { with: 'user', why: 'taken', by: 'gesture', since: 'now' })
    watch.stateChanged(w.set('p1', { turn: 'busy' }))                     // busy but the person has the hand
    assert.equal(watch.size, 0)
    assert.equal(timers.live.size, 0)
    assert.equal(timers.made, 0)
  })

  test('one timer while any commanded pane is in a turn, however many; none again when the last turn ends', async () => {
    watch.stateChanged(w.set('p1', { turn: 'busy' }))
    assert.equal(timers.live.size, 1)
    watch.stateChanged(w.set('p2', { turn: 'busy' }))
    assert.equal(timers.live.size, 1)
    assert.equal(timers.made, 1)
    assert.equal(watch.size, 2)
    watch.stateChanged(w.set('p1', {}, ['turn']))
    assert.equal(timers.live.size, 1, 'p2 is still in a turn')
    // The person takes p2: it leaves, and the last timer goes with it.
    await w.api.objects.set('pane', 'p2', 'hand', { with: 'user', why: 'paused', by: 'gesture', since: 'now' })
    watch.ownershipChanged(['p2'])
    assert.equal(watch.size, 0)
    assert.equal(timers.live.size, 0)
    watch.dispose()
    assert.equal(timers.live.size, 0)
  })

  test('a beat reads with the reader\'s `since`, signals the card once, and the F12 entry goes first', async () => {
    w.screens.set('p1', 'a prompt\n')
    watch.stateChanged(w.set('p1', { turn: 'busy' }))
    await watch.beat()
    assert.equal(w.signals.length, 0)
    assert.equal(w.reads.at(-1)!.since, undefined, 'the first read takes the ring')

    w.screens.set('p1', `a prompt\n${SOUL_CARD}`)
    await watch.beat()
    const reads = w.reads.filter((r) => r.id === 'p1')
    assert.ok(reads.slice(1).every((r) => typeof r.since === 'number'), 'the next reads ask only for what is new')
    assert.deepEqual(w.signals, [{ id: 'p1', kind: 'waiting' }])
    assert.deepEqual(w.events.filter((e) => /^(setCard|idle|signal)/.test(e)), ['setCard:p1:true', 'idle', 'signal:p1'])

    await watch.beat(); await watch.beat()
    assert.equal(w.signals.length, 1, 'once per card')
  })

  test('the card leaving re-arms the watch: the next card is signalled again', async () => {
    watch.stateChanged(w.set('p1', { turn: 'busy' }))
    w.screens.set('p1', CODEX_CARD)
    await watch.beat()
    assert.equal(w.signals.length, 1)
    w.screens.set('p1', `${CODEX_CARD}\n\x1b[2J\x1b[H${IDLE}`)
    await watch.beat()
    assert.deepEqual(setCard.at(-1), ['p1', false])
    w.screens.set('p1', `${w.screens.get('p1')}\x1b[2J\x1b[H${CODEX_CARD}`)
    await watch.beat()
    assert.equal(w.signals.length, 2)
  })

  test('a pane leaving the watch with a card clears the F12 mark and frees its reader', async () => {
    watch.stateChanged(w.set('p1', { turn: 'busy' }))
    w.screens.set('p1', SOUL_CARD)
    await watch.beat()
    watch.stateChanged(w.set('p1', {}, ['turn']))
    assert.deepEqual(setCard.at(-1), ['p1', false])
    assert.equal(timers.live.size, 0)
  })

  test('a conductor that does not watch, or a pane with no conductor, is never watched', () => {
    const quiet = conductorRegistry.register({ ...fake, id: 'quiet-x4', watch: false, match: (t) => (t.paneId === 'p2' ? 99 : undefined) })
    try {
      watch.stateChanged(w.set('p2', { turn: 'busy' }))
      assert.equal(watch.size, 0)
      assert.equal(timers.live.size, 0)
    } finally { quiet.dispose() }
    w.states.get('p1')!.kind = 'shell'
    watch.stateChanged(w.set('p1', { turn: 'busy' }))
    assert.equal(watch.size, 0)
  })

  test('the signal and the notice meet: the core routes the signal and the owner gets one request', async () => {
    const notices = new Notices(w.api as never, { store, gate: new WriteGate(store, w.api.slots as never) }, { settleMs: 10, cardWaitMs: 60, cardPollMs: 10 })
    const sub = w.api.slots.onState((s) => notices.stateChanged(s))
    // What the core does with `attention.signal(waiting)`: the state goes out with the attention (rerouted to the owner).
    w.api.attention.signal = (id: string): void => { w.signals.push({ id, kind: 'waiting' }); w.raise(id, 'waiting', { busySince: 'B1' }); w.raise(id, 'waiting', { busySince: 'B1' }) }
    try {
      w.screens.set('p1', SOUL_CARD)
      watch.stateChanged(w.set('p1', { turn: 'busy', busySince: 'B1' }))
      await watch.beat()
      await settle()
      assert.equal(w.delivered.length, 1, 'two broadcasts of the same edge, one notice')
      assert.equal(w.delivered[0]!.msg.body.split('\n')[0], 'pede permissão · guia p1 · mesa cena')
    } finally { sub.dispose(); notices.dispose() }
  })
})

test('the extension id the notices speak for is the same as everywhere', () => {
  assert.equal(EXT_ID, 'for-agents')
})
