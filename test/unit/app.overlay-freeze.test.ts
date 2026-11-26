import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isRelevant, sparing } from '../../app/renderer/overlay-freeze.ts'
import { FreezeRegistry } from '../../app/shared/freeze-rules.ts'

// No DOM shim in the unit suite: plain fakes with just the members isRelevant touches.
type Fake = { nodeType: 1; cls?: string; selectors?: string[]; inXterm?: boolean; contains?: string[] }
const el = (f: Partial<Fake> = {}): any => ({
  nodeType: 1,
  closest: (s: string) => (s === '.xterm' && f.inXterm ? {} : null),
  getAttribute: () => f.cls ?? null,
  matches: (s: string) => (f.selectors ?? []).some(x => s.split(/,\s*/).includes(x)),
  querySelector: (s: string) => ((f.contains ?? []).some(x => s.split(/,\s*/).includes(x)) ? {} : null),
})
const attr = (target: any, attributeName: string, oldValue: string | null = null): any => ({ type: 'attributes', target, attributeName, oldValue })
const child = (target: any, added: any[] = [], removed: any[] = []): any => ({ type: 'childList', target, addedNodes: added, removedNodes: removed })

test('class toggle inside xterm is ignored', () => {
  assert.equal(isRelevant(attr(el({ inXterm: true, cls: 'a b' }), 'class', 'a')), false)
  assert.equal(isRelevant(child(el({ inXterm: true }), [el({ selectors: ['.menu'] })])), false)
})

test('unrelated class toggle is ignored', () => {
  assert.equal(isRelevant(attr(el({ cls: 'tab active' }), 'class', 'tab')), false)
})

test('dialog open attribute is relevant', () => {
  assert.equal(isRelevant(attr(el({ selectors: ['dialog'] }), 'open')), true)
})

test('adding a node that contains .menu is relevant; plain node is not', () => {
  assert.equal(isRelevant(child(el(), [el({ contains: ['.menu'] })])), true)
  assert.equal(isRelevant(child(el(), [], [el({ selectors: ['#overlay'] })])), true)
  assert.equal(isRelevant(child(el(), [el()])), false)
})

test('pinned class change is relevant', () => {
  assert.equal(isRelevant(attr(el({ cls: 'wrap pinned' }), 'class', 'wrap')), true)
  assert.equal(isRelevant(attr(el({ cls: 'wrap' }), 'class', 'wrap pinned')), true)
})

test('drawer data-open is relevant', () => {
  assert.equal(isRelevant(attr(el(), 'data-open')), true)
})

// The quick view's card with a native surface in it (the browser's page lent to the modal card): the holds as
// watchOverlays takes them, over a tree of named places. A "surface" is the name of the place its host element sits in.
describe('the freeze with the peek card', () => {
  // The places: the desk behind, the drawer, the card (its body holds a lent page).
  const place = (name: string) => ({ contains: (other: string | null) => other === name })
  const desk = 'desk'
  const drawer = 'drawer'
  const card = 'card'

  test('sparing: the union of its parts; absent parts are skipped; none left spares nothing', () => {
    const s = sparing<string>(place(drawer), undefined, place(card))!
    assert.equal(s.contains(drawer), true)
    assert.equal(s.contains(card), true)
    assert.equal(s.contains(desk), false)
    assert.equal(sparing<string>(undefined, null), undefined)
  })

  test('the modal card freezes what is behind and spares the page in it', () => {
    const r = new FreezeRegistry<string>()
    r.hold('peek', sparing(place(card)))
    assert.equal(r.freezes(desk), true, 'the desk behind freezes')
    assert.equal(r.freezes(card), false, 'the page in the card lives')
  })

  test('a menu or a dialog over the card freezes the page in it too, and the page comes back when it closes', () => {
    const r = new FreezeRegistry<string>()
    r.hold('peek', sparing(place(card)))
    const menu = r.hold('menu')
    assert.equal(r.freezes(card), true, 'under the menu')
    menu()
    assert.equal(r.freezes(card), false, 'the menu closed: the page lives again')
    const dialog = r.hold('dialog')
    assert.equal(r.freezes(card), true, 'under the dialog')
    dialog()
    assert.equal(r.freezes(card), false)
  })

  test('the card over the open drawer: the drawer\'s surfaces freeze under the card, the card\'s page lives', () => {
    const r = new FreezeRegistry<string>()
    r.hold('drawer', sparing(place(drawer), place(card)))
    assert.equal(r.freezes(drawer), false, 'the drawer alone: its surfaces live')
    assert.equal(r.freezes(desk), true)
    const peek = r.hold('peek', sparing(place(card)))
    assert.equal(r.freezes(drawer), true, 'the card covers the drawer')
    assert.equal(r.freezes(card), false, 'neither hold freezes the card\'s page')
    peek()
    assert.equal(r.freezes(drawer), false, 'the card closed: the drawer lives again')
  })

  test('no hold at all (the docked card over the Regency holds none): nothing freezes', () => {
    const r = new FreezeRegistry<string>()
    assert.equal(r.freezes(card), false)
    assert.equal(r.freezes(desk), false)
  })
})
