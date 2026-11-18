import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRelevant } from '../../app/renderer/overlay-freeze.ts'

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
