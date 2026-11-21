// Tether for agents, slice X0: the pure ownership rules (extensions/for-agents/rules.ts), one case per rule of the
// agreement; the conductors' registry (conductor-api.ts: chosen by `match`, a missing act falls to the next); the rules
// importable by both hosts with nothing of either; and the five new extensions turned on and unused changing no state of
// a slot in a real tetherd (test home and test pipe, a fake agent process in a .cjs file).
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { ConductorRegistry, type Conductor, type ConductorTarget } from '../../extensions/for-agents/conductor-api.ts'
import {
  capabilityOn, deskAcceptsOwner, effective, mayGiveOrRevoke, paneCapabilityState, portOf, relationOf,
  type DeskFacts, type Effective, type Hand, type Ownership, type PaneFacts,
} from '../../extensions/for-agents/rules.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const T = '2026-11-21T14:00:00.000Z'
const own = (owner: string, extra: Partial<Ownership> = {}): Ownership => ({ owner, since: T, givenBy: 'user', ...extra })
const gone = (owner: string, name: string): Ownership => own(owner, { ended: { at: T, name } })
const hand = (why: Hand['why'], by: Hand['by'] = 'gesture'): Hand => ({ with: 'user', why, by, since: T })
const NONE: ReadonlySet<string> = new Set()

// A = Atrium (an agent running in pane 'A'), K = Kai (pane 'K'); 'p' is a pane of desk 'cena'.
interface Case { rule: string; pane: PaneFacts; desk?: DeskFacts; frozen?: string[]; want: Effective }
const CASES: Case[] = [
  { rule: 'guia sem dono numa mesa sem dono: do usuário', pane: { id: 'p' }, desk: { id: 'cena' }, want: { hand: 'user' } },
  { rule: 'um dono por mesa: a guia herda da mesa', pane: { id: 'p' }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'A', via: 'desk', hand: 'owner' } },
  { rule: 'um dono por guia, fora de mesa com dono', pane: { id: 'p', owner: own('K') }, desk: { id: 'cena' }, want: { commander: 'K', via: 'pane', hand: 'owner' } },
  { rule: 'a guia vence a mesa; o dono da mesa só vê', pane: { id: 'p', owner: own('K', { givenBy: 'A' }) }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'K', via: 'pane', viewer: 'A', hand: 'owner' } },
  { rule: 'guia dada ao próprio dono da mesa: comanda pela guia, ninguém só vê', pane: { id: 'p', owner: own('A') }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'A', via: 'pane', hand: 'owner' } },
  { rule: 'guia do dono na própria mesa: não herda, é do usuário, ele só vê', pane: { id: 'A' }, desk: { id: 'cena', owner: own('A') }, want: { viewer: 'A', hand: 'user' } },
  { rule: 'guia "de si" na mesa dela', pane: { id: 'A', owner: own('A') }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'A', via: 'self', hand: 'owner' } },
  { rule: 'guia "de si" na mesa de outro: o dono da mesa só vê', pane: { id: 'K', owner: own('K') }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'K', via: 'self', viewer: 'A', hand: 'owner' } },
  { rule: 'guia tomada digitando', pane: { id: 'p', hand: hand('taken', 'typing') }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'A', via: 'desk', hand: 'user', handWhy: 'taken' } },
  { rule: 'guia dada e pausada', pane: { id: 'p', owner: own('K'), hand: hand('paused') }, desk: { id: 'cena', owner: own('A') }, want: { commander: 'K', via: 'pane', viewer: 'A', hand: 'user', handWhy: 'paused' } },
  { rule: 'mesa tomada: toma a guia que a mesa comanda', pane: { id: 'p' }, desk: { id: 'cena', owner: own('A'), hand: hand('taken') }, want: { commander: 'A', via: 'desk', hand: 'user', handWhy: 'taken' } },
  { rule: 'mesa tomada: a guia dada a outro fica com ele', pane: { id: 'p', owner: own('K') }, desk: { id: 'cena', owner: own('A'), hand: hand('taken') }, want: { commander: 'K', via: 'pane', viewer: 'A', hand: 'owner' } },
  { rule: 'mesa pausada: a mão da guia herdada volta, pausada', pane: { id: 'p' }, desk: { id: 'cena', owner: own('A'), hand: hand('paused') }, want: { commander: 'A', via: 'desk', hand: 'user', handWhy: 'paused' } },
  { rule: 'dono congelado ("em tudo"): pausada em toda guia dele', pane: { id: 'p' }, desk: { id: 'cena', owner: own('A') }, frozen: ['A'], want: { commander: 'A', via: 'desk', hand: 'user', handWhy: 'paused' } },
  { rule: 'dono congelado: a guia "de si" também', pane: { id: 'A', owner: own('A') }, desk: { id: 'cena', owner: own('A') }, frozen: ['A'], want: { commander: 'A', via: 'self', hand: 'user', handWhy: 'paused' } },
  { rule: 'outro dono congelado não muda a guia', pane: { id: 'p', owner: own('K') }, desk: { id: 'cena', owner: own('A') }, frozen: ['A'], want: { commander: 'K', via: 'pane', viewer: 'A', hand: 'owner' } },
  { rule: 'dono da mesa esquecido: a guia volta ao usuário, com a marca', pane: { id: 'p' }, desk: { id: 'cena', owner: gone('A', 'Atrium') }, want: { hand: 'user', ended: { owner: 'A', name: 'Atrium', at: T, on: 'desk' } } },
  { rule: 'dono da mesa esquecido: a guia dada a outro segue com ele', pane: { id: 'p', owner: own('K') }, desk: { id: 'cena', owner: gone('A', 'Atrium') }, want: { commander: 'K', via: 'pane', hand: 'owner' } },
  { rule: 'dono da guia esquecido: volta ao usuário, não ao dono da mesa', pane: { id: 'p', owner: gone('K', 'Kai') }, desk: { id: 'cena', owner: own('A') }, want: { viewer: 'A', hand: 'user', ended: { owner: 'K', name: 'Kai', at: T, on: 'pane' } } },
  { rule: 'guia na gaveta (sem mesa) dada a um agente', pane: { id: 'p', owner: own('K') }, want: { commander: 'K', via: 'pane', hand: 'owner' } },
  { rule: 'guia sem dono com mão gravada e sem comandante: do usuário', pane: { id: 'p', hand: hand('taken') }, desk: { id: 'cena' }, want: { hand: 'user' } },
]

describe('for-agents rules: effective ownership', () => {
  for (const c of CASES) {
    test(c.rule, () => {
      assert.deepEqual(effective(c.pane, c.desk, c.frozen ? new Set(c.frozen) : NONE), c.want)
    })
  }

  test('pure: the facts given are not changed and the same facts give the same answer', () => {
    const pane: PaneFacts = { id: 'p', owner: own('K'), hand: hand('paused') }
    const desk: DeskFacts = { id: 'cena', owner: own('A'), hand: hand('taken') }
    const before = JSON.stringify({ pane, desk })
    const a = effective(pane, desk, NONE)
    assert.deepEqual(effective(pane, desk, NONE), a)
    assert.equal(JSON.stringify({ pane, desk }), before)
  })

  test('portOf: held while the commander has the hand; routed only from outside (the "de si" request goes to the person)', () => {
    assert.deepEqual(portOf({ commander: 'A', via: 'desk', hand: 'owner' }), { heldBy: 'A', routeTo: 'A' })
    assert.deepEqual(portOf({ commander: 'K', via: 'pane', viewer: 'A', hand: 'owner' }), { heldBy: 'K', routeTo: 'K' })
    assert.deepEqual(portOf({ commander: 'A', via: 'self', hand: 'owner' }), { heldBy: 'A' })
    assert.deepEqual(portOf({ commander: 'A', via: 'desk', hand: 'user', handWhy: 'taken' }), {})
    assert.deepEqual(portOf({ commander: 'A', via: 'desk', hand: 'user', handWhy: 'paused' }), {})
    assert.deepEqual(portOf({ viewer: 'A', hand: 'user' }), {})
  })

  test('relationOf: the commander commands, the viewer sees, the rest nothing', () => {
    const e = effective({ id: 'p', owner: own('K') }, { id: 'cena', owner: own('A') }, NONE)
    assert.equal(relationOf(e, 'K'), 'command')
    assert.equal(relationOf(e, 'A'), 'view')
    assert.equal(relationOf(e, 'Z'), undefined)
    // Taken: the commander keeps its relation (its verbs answer with-user, not not-commanded).
    assert.equal(relationOf(effective({ id: 'p', owner: own('K'), hand: hand('taken') }, undefined, NONE), 'K'), 'command')
  })

  test('inventory: everything born on; the pane differs from the desk in three states; the desk lines are the desk\'s only', () => {
    assert.equal(capabilityOn('send', undefined), true)
    assert.equal(capabilityOn('send', { send: false }), false)
    assert.equal(capabilityOn('send', { send: false }, { send: true }), true)
    assert.equal(capabilityOn('answer', {}, { answer: false }), false)
    assert.equal(capabilityOn('give-revoke', { 'give-revoke': false }, { 'give-revoke': true }), false)
    assert.equal(capabilityOn('open-close', undefined, { 'open-close': false }), true)
    assert.equal(paneCapabilityState('send', undefined), 'desk')
    assert.equal(paneCapabilityState('send', { send: true }), 'on')
    assert.equal(paneCapabilityState('send', { send: false }), 'off')
  })

  test('who gives and revokes: the person always; the live desk owner, any pane of its desk; nobody else', () => {
    const desk: DeskFacts = { id: 'cena', owner: own('A') }
    assert.equal(mayGiveOrRevoke('user', undefined), true)
    assert.equal(mayGiveOrRevoke('A', desk), true)
    assert.equal(mayGiveOrRevoke('K', desk), false)
    assert.equal(mayGiveOrRevoke('A', { id: 'cena', owner: gone('A', 'Atrium') }), false)
    assert.equal(mayGiveOrRevoke('A', undefined), false)
    assert.equal(deskAcceptsOwner('queue'), true)
    assert.equal(deskAcceptsOwner('system'), false)
  })
})

describe('for-agents conductor registry', () => {
  const slotPane = (kind: string): ConductorTarget => ({ paneId: 's1', type: 'terminal', slot: { slotId: 's1', agent: kind } as unknown as SlotState })
  const terminal: Conductor = {
    id: 'terminal', match: t => (t.slot ? 0 : undefined), capabilities: [{ id: 'send', label: 'Enviar (terminal)' }, { id: 'keys', label: 'Digitar e teclar' }],
    send: async () => ({ value: undefined, proven: true }), read: async () => ({ text: 'tela' }), interrupt: async () => ({ value: { stopped: true }, proven: true }),
    verbs: [{ name: 'type', capability: 'keys', description: '', help: '', input: {}, run: async () => ({ text: 'terminal' }) }],
  }
  const claude: Conductor = {
    id: 'claude', match: t => ((t.slot as { agent?: string } | undefined)?.agent === 'claude' ? 10 : undefined), capabilities: [{ id: 'send', label: 'Enviar pedido' }, { id: 'answer', label: 'Responder' }],
    send: async () => ({ value: undefined, proven: true }), answer: async () => ({ value: undefined, proven: true }),
    verbs: [{ name: 'type', capability: 'keys', description: '', help: '', input: {}, run: async () => ({ text: 'claude' }) }],
  }

  test('the highest match wins; a missing act falls to the next one; no conductor: undefined', () => {
    const reg = new ConductorRegistry()
    reg.register(terminal)
    reg.register(claude)
    assert.deepEqual(reg.chain(slotPane('claude')).map(c => c.id), ['claude', 'terminal'])
    assert.equal(reg.pick(slotPane('claude'), 'send')?.id, 'claude')
    assert.equal(reg.pick(slotPane('claude'), 'answer')?.id, 'claude')
    assert.equal(reg.pick(slotPane('claude'), 'read')?.id, 'terminal')
    assert.equal(reg.pick(slotPane('claude'), 'interrupt')?.id, 'terminal')
    assert.equal(reg.pick(slotPane('claude'), 'detect'), undefined)
    assert.deepEqual(reg.chain(slotPane('codex')).map(c => c.id), ['terminal'])
    assert.equal(reg.pick(slotPane('codex'), 'answer'), undefined)
    assert.deepEqual(reg.chain({ paneId: 'note:1', type: 'note' }), [])
    assert.equal(reg.pick({ paneId: 'note:1', type: 'note' }, 'read'), undefined)
  })

  test('inventory lines and verbs come from the chain, the first one winning a shared id or name', () => {
    const reg = new ConductorRegistry()
    reg.register(terminal)
    reg.register(claude)
    assert.deepEqual(reg.capabilitiesOf(slotPane('claude')), [{ id: 'send', label: 'Enviar pedido' }, { id: 'answer', label: 'Responder' }, { id: 'keys', label: 'Digitar e teclar' }])
    assert.deepEqual(reg.verbsOf(slotPane('claude')).map(v => v.conductor.id), ['claude'])
    assert.deepEqual(reg.verbsOf(slotPane('soul')).map(v => v.conductor.id), ['terminal'])
  })

  test('a tie keeps the registration order; a throwing match is out; dispose takes it out; a duplicate id throws', () => {
    const reg = new ConductorRegistry()
    let changes = 0
    reg.onDidChange(() => changes++)
    const a: Conductor = { id: 'a', match: () => 5, capabilities: [] }
    const b: Conductor = { id: 'b', match: () => 5, capabilities: [] }
    const bad: Conductor = { id: 'bad', match: () => { throw new Error('x') }, capabilities: [] }
    const da = reg.register(a)
    reg.register(b)
    reg.register(bad)
    assert.deepEqual(reg.chain(slotPane('x')).map(c => c.id), ['a', 'b'])
    assert.throws(() => reg.register({ id: 'a', match: () => 1, capabilities: [] }), /já está registrado/)
    assert.throws(() => reg.register({ id: 'A b', match: () => 1, capabilities: [] }), /inválido/)
    da.dispose()
    assert.deepEqual(reg.chain(slotPane('x')).map(c => c.id), ['b'])
    assert.equal(changes, 4)
  })
})

describe('for-agents in both hosts', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const importsOf = (rel: string): string[] => [...readFileSync(join(root, rel), 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/g)].map(m => m[1]!)

  test('rules.ts imports nothing: the daemon and the renderer load it without anything of the other', () => {
    assert.deepEqual(importsOf('extensions/for-agents/rules.ts'), [])
  })

  test('the renderer entry reaches no daemon code; the conductor contract never reaches the renderer', () => {
    for (const spec of importsOf('extensions/for-agents/renderer.ts')) assert.ok(!/src\/|conductor-api|daemon/.test(spec), spec)
    for (const spec of importsOf('extensions/for-agents/conductor-api.ts')) assert.ok(!/app\/renderer/.test(spec), spec)
  })

  test('the indexes list for-agents in both hosts and the four conductors in the daemon only, after for-agents', () => {
    const d = daemonIndex.map(e => e.manifest.id)
    // The renderer index pulls the app's bundle (icons as .svg), so it is read as text, as ext.index.test.ts does.
    const rendererText = readFileSync(join(root, 'extensions/index.renderer.ts'), 'utf8')
    assert.ok(rendererText.includes(`'./for-agents/renderer.ts'`))
    const fa = d.indexOf('for-agents')
    assert.ok(fa >= 0)
    for (const id of ['conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex']) {
      assert.ok(d.indexOf(id) > fa, id)
      assert.ok(!rendererText.includes(`'./${id}/`), id)
      assert.deepEqual(daemonIndex.find(e => e.manifest.id === id)!.manifest.requires, ['for-agents'])
    }
  })
})

describe('for-agents and the conductors turned on and unused', () => {
  const NEW = ['for-agents', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex']
  const STAY = ["process.stdout.write('READY\\r\\n')", 'setInterval(() => {}, 1000)'].join('\n')
  /** The fields of a slot that differ between two runs by nature (ids, process, clock, the home's path). */
  const VOLATILE = new Set(['slotId', 'pid', 'cwd', 'folder', 'spawnedAt', 'idleSince', 'busySince', 'endedAt', 'memoryMB', 'createdAt', 'updatedAt', 'startedAt'])
  const stable = (s: SlotState): Record<string, unknown> => Object.fromEntries(Object.entries(s).filter(([k]) => !VOLATILE.has(k)))

  async function run(withNew: boolean): Promise<{ state: Record<string, unknown>; activated: string[]; verbs: number; objects: boolean }> {
    const home = tempHome()
    writeFileSync(join(home, 'stay.cjs'), STAY)
    const fake: AgentAdapter = {
      name: 'soul',
      plan: (input): LaunchPlan => {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
        delete env.NODE_TEST_CONTEXT
        return { command: process.execPath, args: [join(home, 'stay.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
      },
      sessionExists: async () => 'unknown',
      title: async (b) => b.title,
    }
    const door = new DoorHost({ log: () => {} })
    const host = new DaemonExtensionHost({ home, log: () => {}, door, extensions: withNew ? daemonIndex.filter(e => NEW.includes(e.manifest.id)) : [] })
    host.activate()
    const daemon = await startDaemon({
      home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, adapters: { soul: fake }, door,
      transformPlan: host.transformPlan, onSlot: host.emitSlot, log: () => {},
    })
    host.emitStarted()
    const store = new DisposableStore()
    try {
      const slots = door.apiFor('probe', store).slots
      const id = (await slots.create({ kind: 'soul', cwd: home, name: 'guia' })).slotId
      await waitUntil(() => slots.readScreen(id).data.includes('READY'), 30_000, 'READY')
      await sleep(300)
      const state = stable(slots.get(id)!)
      const objects = await import('node:fs/promises').then(fs => fs.access(join(home, 'objects', 'for-agents.json')).then(() => true, () => false))
      await slots.forget(id)
      return { state, activated: [...host.activated], verbs: door.verbs.list().length, objects }
    } finally {
      store.dispose()
      host.dispose()
      await daemon.close().catch(() => {})
      await removeHome(home)
    }
  }

  test('a slot\'s state is the same with and without them; they register nothing and write nothing', async () => {
    const without = await run(false)
    const withNew = await run(true)
    assert.deepEqual(withNew.activated, NEW)
    assert.deepEqual(withNew.state, without.state)
    assert.equal(withNew.state.held, undefined)
    assert.equal(withNew.state.attentionFor, undefined)
    assert.equal(withNew.verbs, without.verbs)
    assert.equal(withNew.objects, false)
  })
})
