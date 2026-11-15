// The replace preview's pure rules (extensions/search/renderer/preview-rules.ts) and its pane type in layout.json.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { REPLACE_PREVIEW_LAYOUT } from '../../extensions/search/layouts.ts'
import { manifest } from '../../extensions/search/manifest.ts'
import {
  baseName, newPreviewId, opensPreview, PREVIEW_COMPONENT, PREVIEW_PREFIX, PREVIEW_TAB, previewFate, previewSignature, previewTitle, shiftedLine,
} from '../../extensions/search/renderer/preview-rules.ts'

const r = (sl: number, sc: number, el: number, ec: number) => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec })

describe('replace preview: identity and title', () => {
  it('keeps its names (they are in layout.json)', () => {
    assert.equal(REPLACE_PREVIEW_LAYOUT.id, 'search.replace-preview')
    assert.equal(REPLACE_PREVIEW_LAYOUT.idPrefix, 'search-preview:')
    assert.equal(REPLACE_PREVIEW_LAYOUT.component, PREVIEW_COMPONENT)
    assert.equal(REPLACE_PREVIEW_LAYOUT.tabComponent, PREVIEW_TAB)
    assert.equal(REPLACE_PREVIEW_LAYOUT.affinity, 'desk')
    assert.ok(newPreviewId(1234).startsWith(PREVIEW_PREFIX))
    assert.deepEqual(manifest.contributes?.paneTypes, [REPLACE_PREVIEW_LAYOUT])
  })

  it('a saved pane comes back with its title and no params', () => {
    assert.deepEqual(REPLACE_PREVIEW_LAYOUT.optionsOf({ id: 'search-preview:x', title: 'a.ts ↔ a.ts (prévia da substituição)' }),
      { id: 'search-preview:x', component: PREVIEW_COMPONENT, tabComponent: PREVIEW_TAB, title: 'a.ts ↔ a.ts (prévia da substituição)', params: {} })
    assert.equal(REPLACE_PREVIEW_LAYOUT.optionsOf({ id: 'search-preview:y' }).title, 'Prévia da substituição')
  })

  it('titles the tab with the file name on both sides', () => {
    assert.equal(previewTitle('C:\\proj\\src\\main.ts'), 'main.ts ↔ main.ts (prévia da substituição)')
    assert.equal(previewTitle('/home/x/notes.md'), 'notes.md ↔ notes.md (prévia da substituição)')
    assert.equal(baseName('C:\\a\\b\\'), 'b')
  })
})

describe('replace preview: preview or file', () => {
  it('previews only with the replace field open, the setting on and not to the side', () => {
    assert.equal(opensPreview({ replaceShown: true, useReplacePreview: true, side: false }), true)
    assert.equal(opensPreview({ replaceShown: true, useReplacePreview: true, side: true }), false)
    assert.equal(opensPreview({ replaceShown: true, useReplacePreview: false, side: false }), false)
    assert.equal(opensPreview({ replaceShown: false, useReplacePreview: true, side: false }), false)
  })
})

describe('replace preview: rebuild or close', () => {
  const sig = previewSignature('disk', [{ range: r(1, 1, 1, 4), expected: 'foo', text: 'bar' }])
  it('closes when the field closed or the file left the results', () => {
    assert.equal(previewFate({ replaceShown: false, inResults: true, shown: sig, next: sig }), 'close')
    assert.equal(previewFate({ replaceShown: true, inResults: false, shown: sig, next: sig }), 'close')
  })
  it('rebuilds when the edits or the text changed, keeps otherwise', () => {
    assert.equal(previewFate({ replaceShown: true, inResults: true, shown: sig, next: sig }), 'keep')
    assert.equal(previewFate({ replaceShown: true, inResults: true, shown: undefined, next: sig }), 'rebuild')
    const otherText = previewSignature('disk', [{ range: r(1, 1, 1, 4), expected: 'foo', text: 'baz' }])
    const otherSource = previewSignature('model:7', [{ range: r(1, 1, 1, 4), expected: 'foo', text: 'bar' }])
    const fewer = previewSignature('disk', [])
    for (const next of [otherText, otherSource, fewer]) assert.equal(previewFate({ replaceShown: true, inResults: true, shown: sig, next }), 'rebuild')
  })
})

describe('replace preview: the activated line in the replaced text', () => {
  it('follows the line breaks the edits above it add or take away', () => {
    assert.equal(shiftedLine(5, []), 5)
    assert.equal(shiftedLine(5, [{ range: r(2, 1, 2, 4), text: 'a\nb' }]), 6)
    assert.equal(shiftedLine(5, [{ range: r(2, 1, 3, 4), text: 'x' }]), 4)
    assert.equal(shiftedLine(5, [{ range: r(2, 1, 2, 4), text: 'a\r\nb\r\nc' }, { range: r(4, 1, 4, 2), text: 'q' }]), 7)
  })
  it('ignores edits on the line itself or below, and lands on the start of an edit that covers it', () => {
    assert.equal(shiftedLine(5, [{ range: r(5, 3, 5, 6), text: 'a\nb' }, { range: r(8, 1, 8, 2), text: '\n\n' }]), 5)
    assert.equal(shiftedLine(5, [{ range: r(1, 1, 1, 2), text: '\n' }, { range: r(3, 2, 6, 1), text: 'z' }]), 4)
  })
})
