// The pane header's collapsed/expanded state lives in the pane's layout params (app/renderer/pane-details.ts).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { detailsLabel, detailsOpen, withDetails } from '../../app/renderer/pane-details.ts'
import { shortcutHint, shortcutOf } from '../../app/renderer/shortcuts.ts'

describe('pane details params', () => {
  test('collapsed by default: no params, no key, or a stray value', () => {
    assert.equal(detailsOpen(undefined), false)
    assert.equal(detailsOpen({}), false)
    assert.equal(detailsOpen({ slotId: 'a', hint: { kind: 'shell' } }), false)
    assert.equal(detailsOpen({ details: 'yes' }), false)
    assert.equal(detailsOpen({ details: 1 }), false)
    assert.equal(detailsOpen({ details: false }), false)
  })

  test('only an explicit true expands', () => {
    assert.equal(detailsOpen({ details: true }), true)
  })

  test('withDetails keeps the other params and always writes the boolean', () => {
    const base = { slotId: 'a', hint: { kind: 'claude' as const } }
    assert.deepEqual(withDetails(base, true), { ...base, details: true })
    // False is written, not dropped: dockview merges parameters, so a missing key would keep a previous true.
    assert.deepEqual(withDetails({ ...base, details: true }, false), { ...base, details: false })
    assert.deepEqual(withDetails(undefined, true), { details: true })
    assert.deepEqual(base, { slotId: 'a', hint: { kind: 'claude' } }, 'the input is not mutated')
  })

  test('round-trips through a saved layout (JSON)', () => {
    const saved = JSON.parse(JSON.stringify(withDetails({ slotId: 'a' }, true)))
    assert.equal(detailsOpen(saved), true)
  })

  test('the label names the next state', () => {
    assert.equal(detailsLabel(false), 'Mostrar barra de status')
    assert.equal(detailsLabel(true), 'Ocultar barra de status')
  })

  test('the shortcut is Ctrl+Shift+H and leaves DevTools (Ctrl+Shift+I) alone', () => {
    assert.equal(shortcutHint('pane.details', false), 'Ctrl+Shift+H')
    const ev = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }
    assert.equal(shortcutOf({ ...ev, code: 'KeyH' }, false), 'pane.details')
    assert.equal(shortcutOf({ ...ev, code: 'KeyI' }), undefined)
  })
})
