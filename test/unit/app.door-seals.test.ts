// The boards behind the extensions' marks (agent door, slice R2): a seal on a desk pill, an emblem on a tab. Pure rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeskSealBoard, normalizeHue, normalizeSeal } from '../../app/renderer/door/desk-seal-rules.ts'
import { MAX_TAB_EMBLEMS, TabEmblemBoard, normalizeEmblem } from '../../app/renderer/door/tab-emblem-rules.ts'
import { DoorHost } from '../../app/renderer/door/host.ts'

test('hue: whole number 0-359, out of range wraps, junk is absent', () => {
  assert.equal(normalizeHue(200.4), 200)
  assert.equal(normalizeHue(360), 0)
  assert.equal(normalizeHue(-30), 330)
  assert.equal(normalizeHue(undefined), undefined)
  assert.equal(normalizeHue(Number.NaN), undefined)
})

test('seal: needs an icon name; the tooltip is trimmed', () => {
  assert.equal(normalizeSeal(undefined), undefined)
  assert.equal(normalizeSeal({ icon: '', tooltip: 'x' }), undefined)
  assert.deepEqual(normalizeSeal({ icon: 'robot', hue: 200, tooltip: '  Atrium  ' }), { icon: 'robot', hue: 200, tooltip: 'Atrium' })
  assert.deepEqual(normalizeSeal({ icon: 'robot', tooltip: 'a' }), { icon: 'robot', tooltip: 'a' })
})

test('seal: the label is optional, trimmed, and absent when empty (a seal without one stays as it was)', () => {
  assert.deepEqual(normalizeSeal({ icon: 'robot', label: '  Atrium ', tooltip: 'a' }), { icon: 'robot', label: 'Atrium', tooltip: 'a' })
  assert.deepEqual(normalizeSeal({ icon: 'robot', label: '   ', tooltip: 'a' }), { icon: 'robot', tooltip: 'a' })
  const b = new DeskSealBoard()
  b.set('a', 'desk-1', { icon: 'robot', tooltip: 'a' })
  const bare = b.signature
  assert.equal(b.set('a', 'desk-1', { icon: 'robot', label: 'Atrium', tooltip: 'a' }), true, 'a label is a change')
  assert.notEqual(b.signature, bare, 'the label is in the signature the pill measures and paints by')
  assert.equal(b.set('a', 'desk-1', { icon: 'robot', label: 'Atrium', tooltip: 'a' }), false)
  assert.equal(b.set('a', 'desk-1', { icon: 'robot', label: 'Outro', tooltip: 'a' }), true)
})

test('desk seals: one per extension per desk, a new one replaces', () => {
  const b = new DeskSealBoard()
  assert.equal(b.set('ext-a', 'desk-1', { icon: 'robot', hue: 10, tooltip: 'um' }), true)
  assert.equal(b.set('ext-a', 'desk-1', { icon: 'robot', hue: 10, tooltip: 'um' }), false, 'the same seal changes nothing')
  assert.equal(b.set('ext-a', 'desk-1', { icon: 'robot', hue: 10, tooltip: 'dois' }), true)
  assert.deepEqual(b.of('desk-1').map(p => [p.ext, p.seal.tooltip]), [['ext-a', 'dois']])
  assert.deepEqual(b.of('desk-2'), [])
})

test('desk seals: stable order by extension id, whatever the order they came in', () => {
  const b = new DeskSealBoard()
  for (const ext of ['zeta', 'alfa', 'mid']) b.set(ext, 'desk-1', { icon: 'x', tooltip: ext })
  assert.deepEqual(b.of('desk-1').map(p => p.ext), ['alfa', 'mid', 'zeta'])
  b.set('alfa', 'desk-1', undefined)
  b.set('alfa', 'desk-1', { icon: 'x', tooltip: 'volta' })
  assert.deepEqual(b.of('desk-1').map(p => p.ext), ['alfa', 'mid', 'zeta'])
})

test('desk seals: undefined takes the seal away; removing an owner takes all of its seals and only its seals', () => {
  const b = new DeskSealBoard()
  b.set('a', 'desk-1', { icon: 'x', tooltip: '1' })
  b.set('a', 'desk-2', { icon: 'x', tooltip: '2' })
  b.set('b', 'desk-1', { icon: 'x', tooltip: '3' })
  assert.equal(b.set('a', 'desk-2', undefined), true)
  assert.equal(b.set('a', 'desk-2', undefined), false)
  assert.equal(b.removeOwner('a'), true)
  assert.equal(b.removeOwner('a'), false)
  assert.deepEqual(b.of('desk-1').map(p => p.ext), ['b'])
  assert.deepEqual(b.of('desk-2'), [])
})

test('desk seals: listeners hear real changes only, and the signature follows', () => {
  const b = new DeskSealBoard()
  let heard = 0
  const sub = b.onChange(() => { heard++ })
  const empty = b.signature
  b.set('a', 'desk-1', { icon: 'x', tooltip: '1' })
  b.set('a', 'desk-1', { icon: 'x', tooltip: '1' })
  assert.equal(heard, 1)
  assert.notEqual(b.signature, empty)
  b.removeOwner('a')
  assert.equal(heard, 2)
  assert.equal(b.signature, empty)
  sub.dispose()
  b.set('a', 'desk-1', { icon: 'x', tooltip: '1' })
  assert.equal(heard, 2)
})

test('desk seals: a listener that throws does not stop the others', () => {
  const b = new DeskSealBoard()
  const quiet = console.error
  console.error = () => {}
  try {
    let heard = 0
    b.onChange(() => { throw new Error('boom') })
    b.onChange(() => { heard++ })
    b.set('a', 'desk-1', { icon: 'x', tooltip: '' })
    assert.equal(heard, 1)
  } finally { console.error = quiet }
})

test('emblems: one per extension per pane, ordered by extension id, replaced by a new one', () => {
  const touched: Array<string | undefined> = []
  const b = new TabEmblemBoard(id => touched.push(id))
  b.set('zeta', 'p1', { icon: 'x', tooltip: 'z' })
  b.set('alfa', 'p1', { icon: 'x', tooltip: 'a' })
  assert.deepEqual(b.of('p1').map(p => p.ext), ['alfa', 'zeta'])
  assert.equal(b.set('alfa', 'p1', { icon: 'x', tooltip: 'a' }), false)
  assert.equal(b.set('alfa', 'p1', { icon: 'y', tooltip: 'a' }), true)
  assert.deepEqual(touched, ['p1', 'p1', 'p1'])
  assert.equal(b.of('p1').length, 2)
})

test('emblems: a new click handler counts as a change (the tab rebinds it)', () => {
  const b = new TabEmblemBoard()
  assert.equal(b.set('a', 'p1', { icon: 'x', tooltip: 't', onActivate: () => {} }), true)
  assert.equal(b.set('a', 'p1', { icon: 'x', tooltip: 't', onActivate: () => {} }), true)
})

test('emblems: removal by owner, per pane touched; the board empties', () => {
  const touched: Array<string | undefined> = []
  const b = new TabEmblemBoard(id => touched.push(id))
  b.set('a', 'p1', { icon: 'x', tooltip: '' })
  b.set('a', 'p2', { icon: 'x', tooltip: '' })
  b.set('b', 'p2', { icon: 'x', tooltip: '' })
  touched.length = 0
  assert.equal(b.removeOwner('a'), true)
  assert.deepEqual(touched.sort(), ['p1', 'p2'])
  assert.equal(b.size, 1)
  assert.deepEqual(b.of('p2').map(p => p.ext), ['b'])
  assert.equal(b.set('b', 'p2', undefined), true)
  assert.equal(b.size, 0)
})

test('emblem: needs an icon name; an absent click stays absent', () => {
  assert.equal(normalizeEmblem({ icon: '', tooltip: 'x' }), undefined)
  assert.deepEqual(normalizeEmblem({ icon: 'k', hue: 361, tooltip: ' t ' }), { icon: 'k', hue: 1, tooltip: 't' })
})

test('seal K1.2: variant only when struck; the click stays as given; both are changes the pill repaints by', () => {
  const click = (): void => {}
  assert.deepEqual(normalizeSeal({ icon: 'robot', tooltip: 'a', variant: 'solid' }), { icon: 'robot', tooltip: 'a' }, 'solid is the default: not kept')
  assert.deepEqual(normalizeSeal({ icon: 'robot', tooltip: 'a', variant: 'struck' }), { icon: 'robot', tooltip: 'a', variant: 'struck' })
  assert.equal(normalizeSeal({ icon: 'robot', tooltip: 'a', onActivate: click })!.onActivate, click)
  const b = new DeskSealBoard()
  b.set('a', 'desk-1', { icon: 'robot', label: 'Atrium', tooltip: 'a' })
  const solid = b.signature
  assert.equal(b.set('a', 'desk-1', { icon: 'robot', label: 'Atrium', tooltip: 'a', variant: 'struck' }), true)
  assert.notEqual(b.signature, solid, 'struck is in the signature')
  const struck = b.signature
  assert.equal(b.set('a', 'desk-1', { icon: 'robot', label: 'Atrium', tooltip: 'a', variant: 'struck', onActivate: click }), true)
  assert.notEqual(b.signature, struck, 'clickable is in the signature (the glyph gets its handler)')
  const clickable = b.signature
  assert.equal(b.set('a', 'desk-1', { icon: 'robot', label: 'Atrium', tooltip: 'a', variant: 'struck', onActivate: () => {} }), true, 'a new handler is a change')
  assert.equal(b.signature, clickable, 'but not a repaint: the pill calls the handler in force at the click')
  assert.equal(b.of('desk-1')[0]!.seal.variant, 'struck')
})

test('emblems K1.3: a letter in place of the icon, one character; struck kept, solid not', () => {
  assert.deepEqual(normalizeEmblem({ icon: '', label: ' Kai ', tooltip: 'Dada a Kai' }), { icon: '', tooltip: 'Dada a Kai', label: 'K' })
  assert.deepEqual(normalizeEmblem({ icon: 'eye', label: '   ', tooltip: 'x' }), { icon: 'eye', tooltip: 'x' }, 'a blank label is no label')
  assert.equal(normalizeEmblem({ icon: '', label: '', tooltip: 'x' }), undefined, 'nothing to draw')
  assert.equal(normalizeEmblem({ icon: '', label: '🤖x', tooltip: '' })!.label, '🤖', 'a whole code point')
  assert.deepEqual(normalizeEmblem({ icon: 'x', tooltip: '', variant: 'solid' }), { icon: 'x', tooltip: '' })
  assert.deepEqual(normalizeEmblem({ icon: 'x', tooltip: '', variant: 'struck' }), { icon: 'x', tooltip: '', variant: 'struck' })
})

test('emblems K1.3: several per extension, in the order given, up to three; one call replaces the set', () => {
  const touched: string[] = []
  const b = new TabEmblemBoard(id => touched.push(id!))
  assert.equal(MAX_TAB_EMBLEMS, 3)
  assert.equal(b.setMany('for-agents', 'p1', [{ icon: '', label: 'K', tooltip: 'Kai' }, { icon: 'eye', tooltip: 'Atrium vê' }, { icon: 'x', tooltip: '3' }, { icon: 'x', tooltip: '4' }]), true)
  assert.deepEqual(b.of('p1').map(p => p.emblem.label ?? p.emblem.tooltip), ['K', 'Atrium vê', '3'], 'the fourth is dropped')
  b.set('alfa', 'p1', { icon: 'x', tooltip: 'alfa' })
  assert.deepEqual(b.of('p1').map(p => p.ext), ['alfa', 'for-agents', 'for-agents', 'for-agents'], 'grouped by extension id')
  assert.equal(b.setMany('for-agents', 'p1', [{ icon: '', label: 'K', tooltip: 'Kai' }, { icon: 'eye', tooltip: 'Atrium vê' }, { icon: 'x', tooltip: '3' }]), false, 'the same set changes nothing')
  assert.equal(b.set('for-agents', 'p1', { icon: 'eye', tooltip: 'só um' }), true, 'setEmblem replaces the set by one')
  assert.equal(b.of('p1').filter(p => p.ext === 'for-agents').length, 1)
  assert.equal(b.setMany('for-agents', 'p1', []), true, 'an empty list takes them away')
  assert.equal(b.setMany('for-agents', 'p1', undefined), false)
  assert.deepEqual(b.of('p1').map(p => p.ext), ['alfa'])
})

test('tab line K1.4: one hue per extension per pane, the first extension by id draws, it goes with the extension', () => {
  const touched: string[] = []
  const b = new TabEmblemBoard(id => touched.push(id!))
  assert.equal(b.lineOf('p1'), undefined)
  assert.equal(b.size, 0)
  assert.equal(b.setLine('zeta', 'p1', 300.4), true)
  assert.equal(b.lineOf('p1'), 300)
  assert.equal(b.size, 1, 'a line alone counts as a marked pane (the painter watches)')
  assert.equal(b.setLine('zeta', 'p1', 300), false)
  b.setLine('alfa', 'p1', 200)
  assert.equal(b.lineOf('p1'), 200, 'the first by id')
  assert.equal(b.removeOwner('alfa'), true)
  assert.equal(b.lineOf('p1'), 300)
  assert.equal(b.setLine('zeta', 'p1', undefined), true)
  assert.equal(b.lineOf('p1'), undefined)
  assert.equal(b.size, 0)
  assert.equal(b.setLine('zeta', 'p1', Number.NaN), false, 'junk is no line')
  assert.deepEqual(touched, ['p1', 'p1', 'p1', 'p1'])
})

test('door host K1.3-K1.4: the pane marks go with their extension (removeOwner)', () => {
  const door = new DoorHost()
  door.setEmblems('for-agents', 'p1', [{ icon: '', label: 'K', tooltip: 'Kai' }])
  door.setTabLine('for-agents', 'p1', 200)
  door.removeOwner('for-agents')
})
