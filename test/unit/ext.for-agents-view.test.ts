// Tether for agents, slice U1: the view model of the marks (extensions/for-agents/renderer/view-model.ts), one case per state of
// the approved preview: the four pills of section 1 and the seven tabs of section 2, plus the status bar line, the hand
// paused, the desk taken and the cut at three emblems. A = Atrium (the owner of desk 'kai-aware'), K = Kai.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentHue } from '../../app/shared/agent-color.ts'
import { clockOf, computeView, MAX_EMBLEMS, type PaneMarks, type ViewInput } from '../../extensions/for-agents/renderer/view-model.ts'
import type { Hand, LastAct, Ownership } from '../../extensions/for-agents/rules.ts'

const T = '2026-11-21T14:02:00'
const own = (owner: string, extra: Partial<Ownership> = {}): Ownership => ({ owner, since: T, givenBy: 'user', ...extra })
const gone = (owner: string, name: string): Ownership => own(owner, { ended: { at: T, name } })
const hand = (why: Hand['why']): Hand => ({ with: 'user', why, by: 'gesture', since: T })
const NAMES: Record<string, string> = { A: 'Atrium', K: 'Kai' }

interface Spec {
  panes?: Array<{ id: string; type?: string; deskId?: string }>
  desks?: string[]
  paneOwner?: Record<string, Ownership>
  paneHand?: Record<string, Hand>
  paneLast?: Record<string, LastAct>
  frozen?: string[]
  deskOwner?: Record<string, Ownership>
  deskHand?: Record<string, Hand>
}
const input = (s: Spec): ViewInput => ({
  panes: (s.panes ?? []).map(p => ({ id: p.id, type: p.type ?? 'terminal', deskId: p.deskId })),
  desks: (s.desks ?? []).map(id => ({ id })),
  paneOwner: new Map(Object.entries(s.paneOwner ?? {})),
  paneHand: new Map(Object.entries(s.paneHand ?? {})),
  paneLast: new Map(Object.entries(s.paneLast ?? {})),
  frozen: new Set(s.frozen ?? []),
  deskOwner: new Map(Object.entries(s.deskOwner ?? {})),
  deskHand: new Map(Object.entries(s.deskHand ?? {})),
  nameOf: id => NAMES[id],
})
const marksOf = (s: Spec, id: string): PaneMarks | undefined => computeView(input(s)).panes.get(id)
const kinds = (m: PaneMarks | undefined): string[] => (m?.emblems ?? []).map(e => e.kind)

describe('the four pills (section 1)', () => {
  test('geral: a common desk has no seal', () => {
    assert.equal(computeView(input({ desks: ['geral'] })).seals.size, 0)
  })

  test('kai-aware: a desk with an owner has the solid seal, the name and the hue of the owner, and a click that goes to the owner', () => {
    const seal = computeView(input({ desks: ['kai-aware'], deskOwner: { 'kai-aware': own('A') } })).seals.get('kai-aware')!
    assert.deepEqual(seal, { icon: 'robot', hue: agentHue('A'), label: 'Atrium', variant: 'solid', tooltip: 'Dono: Atrium · clique: ir para Atrium', focus: 'A' })
  })

  test('bancada: the owner of another desk has its seal; nothing here carries the orange', () => {
    const v = computeView(input({ desks: ['kai-aware', 'bancada'], deskOwner: { 'kai-aware': own('A'), bancada: own('K') } }))
    assert.equal(v.seals.get('bancada')!.label, 'Kai')
    assert.equal(v.seals.get('bancada')!.hue, agentHue('K'))
    const hues = [...v.seals.values()].map(s => s.hue)
    assert.ok(hues.every(h => h >= 170 && h <= 330), 'every hue is an agent hue: never the orange (about 22) nor the green (about 140)')
  })

  test('migração: an owner that ended gives the struck seal with its stored name, and nothing to click', () => {
    const seal = computeView(input({ desks: ['migracao'], deskOwner: { migracao: gone('A', 'Atrium') } })).seals.get('migracao')!
    assert.equal(seal.variant, 'struck')
    assert.equal(seal.label, 'Atrium')
    assert.equal(seal.focus, undefined)
    assert.match(seal.tooltip, /Atrium encerrou/)
  })

  test('an owner not found among the agents is shown by its id', () => {
    const seal = computeView(input({ desks: ['d'], deskOwner: { d: own('zz') } })).seals.get('d')!
    assert.equal(seal.label, 'zz')
  })
})

// The desk of section 2: kai-aware, owned by Atrium (pane 'A' is where it runs).
const kaiAware = (extra: Spec = {}): Spec => ({
  desks: ['kai-aware'],
  deskOwner: { 'kai-aware': own('A') },
  ...extra,
  panes: extra.panes ?? [],
})
const inDesk = (id: string, type = 'terminal') => ({ id, type, deskId: 'kai-aware' })

describe('the seven tabs (section 2)', () => {
  test('1 · the owner pane: the crown in the hue of the owner, no letter, no line', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('A')] }), 'A')!
    assert.deepEqual(m.emblems, [{ kind: 'crown', icon: 'crown-simple', hue: agentHue('A'), tooltip: 'Atrium · dono da mesa' }])
    assert.equal(m.line, undefined)
    assert.equal(m.head, undefined, 'it is nobody\'s: the status bar says nothing')
  })

  test('2 · commanded by the desk: no emblem, only the line in the hue of the owner', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('p2')] }), 'p2')!
    assert.deepEqual(m.emblems, [])
    assert.equal(m.line, agentHue('A'))
  })

  test('3 · given to another agent: the letter of Kai and the eye "Atrium vê"; no line (the pane beats the desk)', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('p3')], paneOwner: { p3: own('K', { givenBy: 'A' }) } }), 'p3')!
    assert.deepEqual(m.emblems, [
      { kind: 'owner', icon: '', label: 'K', hue: agentHue('K'), tooltip: 'Dono: Kai' },
      { kind: 'viewer', icon: 'eye', tooltip: 'Atrium vê' },
    ])
    assert.equal(m.line, undefined)
  })

  test('4 · the agent\'s own pane ("de si"): the letter and the arrow, in a desk of someone else', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('K')], paneOwner: { K: own('K') } }), 'K')!
    assert.deepEqual(m.emblems, [
      { kind: 'owner', icon: '', label: 'K', hue: agentHue('K'), tooltip: 'Kai, de si' },
      { kind: 'self', icon: 'arrow-u-down-left', tooltip: 'de si' },
    ])
    assert.equal(m.line, undefined)
    assert.match(m.head!.text, /^Kai · de si/)
  })

  test('5 · waits for the owner: the tab gets no mark of its own (the diamond is the core\'s); it keeps the line of the desk', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('p5')] }), 'p5')!
    assert.deepEqual(m.emblems, [])
    assert.equal(m.line, agentHue('A'))
  })

  test('6 · the owner ended: the struck letter of Kai, no line, no eye, and nothing commands', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('p6')], paneOwner: { p6: gone('K', 'Kai') } }), 'p6')!
    assert.deepEqual(m.emblems, [{ kind: 'ended', icon: '', label: 'K', hue: agentHue('K'), variant: 'struck', tooltip: 'Kai encerrou' }])
    assert.equal(m.line, undefined)
    assert.equal(m.head, undefined)
  })

  test('7 · taken by the person: the hand, no colour, no line, in a note too', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('p7', 'note')], paneHand: { p7: hand('taken') } }), 'p7')!
    assert.deepEqual(kinds(m), ['hand'])
    assert.equal(m.emblems[0]!.icon, 'hand-grabbing')
    assert.equal(m.emblems[0]!.hue, undefined, 'the hand has no hue')
    assert.equal(m.line, undefined)
    assert.equal(m.head, undefined, 'a note has no status bar')
  })
})

describe('the rest of the states', () => {
  test('a pane in no desk (the drawer) and with no data has no marks at all', () => {
    assert.equal(marksOf({ panes: [{ id: 'x' }] }, 'x'), undefined)
  })

  test('a pane given to an agent in a desk with no owner: the letter, no eye, no line', () => {
    const m = marksOf({ desks: ['d'], panes: [{ id: 'p', deskId: 'd' }], paneOwner: { p: own('K') } }, 'p')!
    assert.deepEqual(kinds(m), ['owner'])
    assert.equal(m.line, undefined)
  })

  test('paused: the pause glyph in place of the hand; a frozen owner pauses every pane of it', () => {
    const m = marksOf(kaiAware({ panes: [inDesk('p')], paneHand: { p: hand('paused') } }), 'p')!
    assert.equal(m.emblems[0]!.icon, 'pause')
    assert.equal(m.line, undefined)
    const frozen = marksOf(kaiAware({ panes: [inDesk('p')], frozen: ['A'] }), 'p')!
    assert.deepEqual(kinds(frozen), ['hand'])
    assert.equal(frozen.emblems[0]!.icon, 'pause')
    assert.equal(frozen.head!.text, 'pausada por você')
  })

  test('the desk taken: the panes it commands show the hand; the one given to Kai does not', () => {
    const s = kaiAware({ panes: [inDesk('p'), inDesk('q')], deskHand: { 'kai-aware': hand('taken') }, paneOwner: { q: own('K') } })
    assert.deepEqual(kinds(marksOf(s, 'p')), ['hand'])
    assert.deepEqual(kinds(marksOf(s, 'q')), ['owner', 'viewer'])
  })

  test('a desk whose owner ended: the panes back with the person carry no mark of their own', () => {
    const m = marksOf({ desks: ['d'], deskOwner: { d: gone('A', 'Atrium') }, panes: [{ id: 'p', deskId: 'd' }] }, 'p')
    assert.equal(m, undefined)
  })

  test('the owner pane of a desk it does not live in keeps its crown', () => {
    const m = marksOf({ desks: ['d'], deskOwner: { d: own('A') }, panes: [{ id: 'A' }] }, 'A')!
    assert.deepEqual(kinds(m), ['crown'])
  })

  test('at most three emblems: the eye gives way first', () => {
    // A owns desk 'd' and its pane is given to Kai (crown, letter), in desk 'e' owned by B (the eye), and the hand is taken.
    const s: Spec = {
      desks: ['d', 'e'], panes: [{ id: 'A', deskId: 'e' }],
      deskOwner: { d: own('A'), e: own('B') }, paneOwner: { A: own('K') }, paneHand: { A: hand('taken') },
    }
    const m = marksOf(s, 'A')!
    assert.equal(m.emblems.length, MAX_EMBLEMS)
    assert.deepEqual(kinds(m), ['crown', 'owner', 'hand'])
  })
})

describe('the status bar line', () => {
  const last = (verb: string, by = 'A'): LastAct => ({ by, verb, at: T })
  const hhmm = clockOf(T)

  test('commanded by the desk: "Atrium pela mesa · enviou pedido 14:02", in the hue of the owner', () => {
    const h = marksOf(kaiAware({ panes: [inDesk('p')], paneLast: { p: last('send') } }), 'p')!.head!
    assert.equal(hhmm, '14:02')
    assert.deepEqual(h, { icon: 'robot', hue: agentHue('A'), text: 'Atrium pela mesa · enviou pedido 14:02', tooltip: 'Quem comanda e a última coisa que fez' })
  })

  test('given: just the name; with no last act: the who alone', () => {
    assert.equal(marksOf(kaiAware({ panes: [inDesk('p')], paneOwner: { p: own('K') } }), 'p')!.head!.text, 'Kai')
    assert.equal(marksOf(kaiAware({ panes: [inDesk('p')] }), 'p')!.head!.text, 'Atrium pela mesa')
  })

  test('a last act of another owner is not told as this one\'s; an unknown verb is shown as it came', () => {
    assert.equal(marksOf(kaiAware({ panes: [inDesk('p')], paneLast: { p: last('send', 'K') } }), 'p')!.head!.text, 'Atrium pela mesa')
    assert.equal(marksOf(kaiAware({ panes: [inDesk('p')], paneLast: { p: last('wiggle') } }), 'p')!.head!.text, 'Atrium pela mesa · wiggle 14:02')
  })

  test('with the person: "com você", with no hue', () => {
    const h = marksOf(kaiAware({ panes: [inDesk('p')], paneHand: { p: hand('taken') }, paneLast: { p: last('send') } }), 'p')!.head!
    assert.equal(h.text, 'com você')
    assert.equal(h.hue, undefined)
  })

  test('only a terminal has a status bar', () => {
    assert.equal(marksOf(kaiAware({ panes: [inDesk('n', 'note')] }), 'n')!.head, undefined)
  })

  test('no owner, no line', () => {
    assert.equal(marksOf({ panes: [{ id: 'p' }] }, 'p'), undefined)
  })
})
