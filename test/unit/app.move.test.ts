// The "Mover…" dialog's rules (app/renderer/move-rules.ts), pure: the destination tree built from the desks, their
// frames and the drawer (mini-map from the real dockview layout), the search filter, which zones can be chosen, and
// the placement → move-op mapping the renderer runs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTree, fold, groupsOf, matchRange, miniLayout, moveOpOf, summaryOf, visibleRows, zoneAllowed,
  type FrameViewJSON, type MoveSource, type ScopeModel,
} from '../../app/renderer/move-rules.ts'

/** A dockview frame JSON: `cols` side by side, each a column of groups, each group a list of pane ids. */
function view(cols: string[][][], titles: Record<string, string> = {}): FrameViewJSON {
  const leaf = (ids: string[], i: number) => ({ type: 'leaf' as const, size: 100, data: { id: `g-${ids[0]}-${i}`, views: ids, activeView: ids[0] } })
  const root = {
    type: 'branch' as const, size: 300,
    data: cols.map((col, ci) => col.length === 1 ? leaf(col[0]!, ci) : { type: 'branch' as const, size: 100, data: col.map((ids, gi) => leaf(ids, ci * 10 + gi)) }),
  }
  const panels: FrameViewJSON['panels'] = {}
  for (const id of cols.flat(2)) panels[id] = { title: titles[id] ?? id }
  return { grid: { root, orientation: 'HORIZONTAL' }, panels }
}

const tree = (): ScopeModel[] => buildTree({
  drawer: { frames: [{ id: 'frame-1', view: view([[['d1']]]) }] },
  desks: [
    { id: 'desk-1', name: 'tether', color: 'purple', frames: [
      { id: 'frame-1', view: view([[['src', 'tab2']], [['sh1'], ['sh2']]], { src: 'atrium · Claude', sh1: 'pwsh · tether' }) },
      { id: 'frame-2', view: view([[['solo']]]) },
    ] },
    { id: 'desk-2', name: 'Cliente Á', color: 'blue', frames: [{ id: 'frame-1', view: view([[['c1']], [['c2']]], { c1: 'Claude · proposta' }) }] },
    { id: 'desk-3', name: 'Vazia', color: 'green', frames: [{ id: 'frame-1', view: { grid: { root: { type: 'branch', size: 1, data: [{ type: 'leaf', size: 1, data: { id: 'frame-1', component: 'frame' } }] }, orientation: 'HORIZONTAL' }, panels: {} } }] },
  ],
  currentDesk: 'desk-1',
})

const SRC: MoveSource = { slotId: 'src', title: 'atrium · Claude', scope: 'desk-1', frameId: 'frame-1' }

describe('tree model', () => {
  test('drawer first, then the desks in order, the current one marked; frames named by place', () => {
    const t = tree()
    assert.deepEqual(t.map(s => [s.id, s.kind, s.current]), [['drawer', 'drawer', false], ['desk-1', 'desk', true], ['desk-2', 'desk', false], ['desk-3', 'desk', false]])
    assert.deepEqual(t[1]!.frames.map(f => f.name), ['Quadro 1', 'Quadro 2'])
    assert.equal(t[1]!.color, 'purple')
  })

  test('an empty desk lists no frame (its edges are the destination)', () => {
    assert.deepEqual(tree()[3]!.frames, [])
  })

  test('mini-map follows the real split: a row of a group and a column of two groups', () => {
    const f = tree()[1]!.frames[0]!
    assert.equal(f.layout.kind, 'split')
    if (f.layout.kind !== 'split') return
    assert.equal(f.layout.dir, 'row')
    assert.equal(f.layout.children[0]!.kind, 'group')
    const col = f.layout.children[1]!
    assert.equal(col.kind === 'split' && col.dir, 'column')
    assert.deepEqual(groupsOf(f.layout).map(g => g.panes.map(p => p.id)), [['src', 'tab2'], ['sh1'], ['sh2']])
    assert.deepEqual(f.panes.map(p => p.title), ['atrium · Claude', 'tab2', 'pwsh · tether', 'sh2'])
  })

  test('live titles win over the JSON ones', () => {
    const m = miniLayout(view([[['a']]], { a: 'velho' }), id => id === 'a' ? 'novo' : undefined)
    assert.equal(groupsOf(m)[0]!.panes[0]!.title, 'novo')
  })

  test('vertical root: the root lays its children in a column', () => {
    const v = view([[['a']], [['b']]])
    v.grid.orientation = 'VERTICAL'
    const m = miniLayout(v)
    assert.equal(m.kind === 'split' && m.dir, 'column')
  })
})

describe('search', () => {
  const open = new Set(['desk-1'])
  test('no query: scopes, and the frames of the open ones', () => {
    const rows = visibleRows(tree(), '', open)
    assert.deepEqual(rows.map(r => r.kind === 'scope' ? r.scope.id : `${r.scope.id}/${r.frame.id}`), ['drawer', 'desk-1', 'desk-1/frame-1', 'desk-1/frame-2', 'desk-2', 'desk-3'])
  })

  test('a pane title hit keeps its scope (opened) and its frame, listing the matching panes', () => {
    const rows = visibleRows(tree(), 'proposta', new Set())
    assert.deepEqual(rows.map(r => r.kind === 'scope' ? `${r.scope.id}:${r.open}` : r.frame.id), ['desk-2:true', 'frame-1'])
    const f = rows[1]!
    assert.deepEqual(f.kind === 'frame' && f.matches.map(m => m.id), ['c1'])
  })

  test('a scope hit shows all its frames; accents and case do not matter', () => {
    const rows = visibleRows(tree(), 'cliente a', new Set())
    assert.deepEqual(rows.map(r => r.kind === 'scope' ? r.scope.id : r.frame.id), ['desk-2', 'frame-1'])
    assert.equal(fold('Á'), 'a')
  })

  test('a frame name hit keeps every scope with that frame', () => {
    const rows = visibleRows(tree(), 'quadro 2', new Set())
    assert.deepEqual(rows.map(r => r.kind === 'scope' ? r.scope.id : r.frame.id), ['desk-1', 'frame-2'])
  })

  test('nothing found: no rows', () => {
    assert.deepEqual(visibleRows(tree(), 'zzz', open), [])
  })

  test('matchRange maps the folded hit back to the original text', () => {
    assert.deepEqual(matchRange('Cliente Á', 'te a'), [5, 9])
    assert.equal(matchRange('abc', ''), undefined)
    assert.equal(matchRange('abc', 'x'), undefined)
  })
})

describe('zones and the move op', () => {
  const t = tree()
  const g = (scope: string, frame: string, i: number) => groupsOf(t.find(s => s.id === scope)!.frames.find(f => f.id === frame)!.layout)[i]!.id

  test('pane → another desk\'s frame, to the right of a group', () => {
    const op = moveOpOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-1', group: g('desk-2', 'frame-1', 1), zone: 'right' })
    assert.deepEqual(op, { op: 'pane-beside', slotId: 'src', from: 'desk-1', scope: 'desk-2', frameId: 'frame-1', reference: 'c2', direction: 'right' })
  })

  test('as a tab; top/bottom map to above/below', () => {
    assert.equal(moveOpOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-1', group: g('desk-2', 'frame-1', 0), zone: 'tab' })?.op === 'pane-beside' && 'within', 'within')
    const up = moveOpOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-1', group: g('desk-2', 'frame-1', 0), zone: 'top' })
    assert.equal(up?.op === 'pane-beside' && up.direction, 'above')
    const down = moveOpOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-1', group: g('desk-2', 'frame-1', 0), zone: 'bottom' })
    assert.equal(down?.op === 'pane-beside' && down.direction, 'below')
  })

  test('"Como aba" of the source\'s own group is off; its edges split it out (the reference is another pane)', () => {
    const own = { scope: 'desk-1', frameId: 'frame-1', group: g('desk-1', 'frame-1', 0) }
    assert.equal(zoneAllowed(t, 'pane', SRC, { ...own, zone: 'tab' }), false)
    const op = moveOpOf(t, 'pane', SRC, { ...own, zone: 'left' })
    assert.equal(op?.op === 'pane-beside' && op.reference, 'tab2')
  })

  test('a group that is the source alone: every zone is off', () => {
    const alone: MoveSource = { slotId: 'solo', title: 'solo', scope: 'desk-1', frameId: 'frame-2' }
    for (const zone of ['tab', 'left', 'right', 'top', 'bottom'] as const) assert.equal(zoneAllowed(t, 'pane', alone, { scope: 'desk-1', frameId: 'frame-2', group: g('desk-1', 'frame-2', 0), zone }), false, zone)
  })

  test('pane → a desk or the drawer: a new frame at the edge; never as a tab', () => {
    assert.deepEqual(moveOpOf(t, 'pane', SRC, { scope: 'drawer', zone: 'bottom' }), { op: 'pane-new-frame', slotId: 'src', from: 'desk-1', scope: 'drawer', direction: 'below' })
    assert.deepEqual(moveOpOf(t, 'pane', SRC, { scope: 'desk-3', zone: 'left' }), { op: 'pane-new-frame', slotId: 'src', from: 'desk-1', scope: 'desk-3', direction: 'left' })
    assert.equal(moveOpOf(t, 'pane', SRC, { scope: 'drawer', zone: 'tab' }), undefined)
  })

  test('out of the drawer into a new frame on a desk', () => {
    const fromDrawer: MoveSource = { slotId: 'd1', title: 'd1', scope: 'drawer', frameId: 'frame-1' }
    assert.deepEqual(moveOpOf(t, 'pane', fromDrawer, { scope: 'desk-2', zone: 'right' }), { op: 'pane-new-frame', slotId: 'd1', from: 'drawer', scope: 'desk-2', direction: 'right' })
  })

  test('frame mode: beside another frame, never as a tab, never on itself; at a desk edge', () => {
    assert.deepEqual(moveOpOf(t, 'frame', SRC, { scope: 'desk-2', frameId: 'frame-1', zone: 'left' }), { op: 'frame-beside', frameId: 'frame-1', from: 'desk-1', scope: 'desk-2', referenceFrame: 'frame-1', direction: 'left' })
    assert.equal(zoneAllowed(t, 'frame', SRC, { scope: 'desk-2', frameId: 'frame-1', zone: 'tab' }), false)
    assert.equal(zoneAllowed(t, 'frame', SRC, { scope: 'desk-1', frameId: 'frame-1', zone: 'right' }), false)
    assert.equal(zoneAllowed(t, 'frame', SRC, { scope: 'desk-1', frameId: 'frame-2', zone: 'right' }), true)
    assert.deepEqual(moveOpOf(t, 'frame', SRC, { scope: 'desk-2', zone: 'top' }), { op: 'frame-new', frameId: 'frame-1', from: 'desk-1', scope: 'desk-2', direction: 'above' })
  })

  test('frame mode: the only frame of a scope to that scope\'s own edge stays where it is (off)', () => {
    const only: MoveSource = { slotId: 'c1', title: 'c1', scope: 'desk-2', frameId: 'frame-1' }
    assert.equal(zoneAllowed(t, 'frame', only, { scope: 'desk-2', zone: 'left' }), false)
    assert.equal(zoneAllowed(t, 'frame', only, { scope: 'drawer', zone: 'left' }), true)
  })

  test('an unknown scope, frame or group is never a destination', () => {
    assert.equal(moveOpOf(t, 'pane', SRC, { scope: 'nope', zone: 'left' }), undefined)
    assert.equal(moveOpOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-9', group: 'x', zone: 'left' }), undefined)
    assert.equal(moveOpOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-1', group: 'x', zone: 'left' }), undefined)
  })
})

describe('summary', () => {
  const t = tree()
  test('pane to a frame: subject, scope › frame (pane), the zone', () => {
    const g1 = groupsOf(t[2]!.frames[0]!.layout)[0]!.id
    const s = summaryOf(t, 'pane', SRC, { scope: 'desk-2', frameId: 'frame-1', group: g1, zone: 'right' })
    assert.deepEqual(s, { subject: 'atrium · Claude', scope: 'Cliente Á', where: ' › Quadro 1 (Claude · proposta)', zone: 'à direita', tail: '' })
  })

  test('to a desk / the drawer: "novo quadro …" of it; without a zone, the invitation', () => {
    assert.equal(summaryOf(t, 'pane', SRC, { scope: 'drawer', zone: 'left' }).zone, 'novo quadro à esquerda')
    assert.equal(summaryOf(t, 'pane', SRC, { scope: 'drawer', zone: 'left' }).tail, ' da gaveta')
    assert.equal(summaryOf(t, 'frame', SRC, { scope: 'desk-2', zone: 'left' }).tail, ' da mesa')
    assert.equal(summaryOf(t, 'frame', SRC, { scope: 'desk-2', frameId: 'frame-1', zone: 'left' }).zone, 'à esquerda do quadro')
    assert.equal(summaryOf(t, 'frame', SRC, { scope: 'desk-2' }).subject, 'tether › Quadro 1')
    assert.equal(summaryOf(t, 'pane', SRC, { scope: 'desk-2' }).zone, undefined)
  })
})
