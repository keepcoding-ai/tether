// The rows of a link's context menu (app/renderer/link-menu-rules.ts), pure: what each kind of link offers, the hints and the
// copy text.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPeekClick, linkCopyText, linkMenuPlan, paneOfLink, type LinkMenuLine } from '../../app/renderer/link-menu-rules.ts'

const labels = (plan: LinkMenuLine[]): string[] => plan.map(l => (l === 'sep' ? '-' : l.hint ? `${l.label} [${l.hint}]` : l.label))
const facts = { peekable: true, mac: false }

describe('link menu rows', () => {
  test('a pane link: go to the tab, peek, separator, copy', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'tether', url: 'tether://tab/abc123' }, facts)), ['Ir para a guia [Ctrl+clique]', 'Espiar [Alt+clique]', '-', 'Copiar link'])
  })
  test('a pane link of a slot the app does not know cannot be peeked', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'tether', url: 'tether://tab/abc123' }, { ...facts, peekable: false })), ['Ir para a guia [Ctrl+clique]', '-', 'Copiar link'])
  })
  test('a note link', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'tether', url: 'tether://note?path=C%3A%2Fa%2Fb.md' }, facts)), ['Abrir nota [Ctrl+clique]', 'Abrir ao lado', '-', 'Copiar link'])
  })
  test('an external link: only the system browser (the others belong to another slice)', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'external', url: 'http://localhost:9/x' }, facts)), ['Abrir no navegador do sistema [Ctrl+clique]', '-', 'Copiar link'])
  })
  test('a file and a folder', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'file', path: 'C:/a/b.ts' }, facts)), ['Abrir [Ctrl+clique]', 'Abrir ao lado', '-', 'Copiar caminho'])
    assert.deepEqual(labels(linkMenuPlan({ kind: 'file', path: 'C:/a', isDirectory: true }, facts)), ['Abrir pasta [Ctrl+clique]', '-', 'Copiar caminho'])
  })
  test('macOS reads Cmd and Option', () => {
    const plan = labels(linkMenuPlan({ kind: 'tether', url: 'tether://tab/abc123' }, { peekable: true, mac: true }))
    assert.deepEqual(plan.slice(0, 2), ['Ir para a guia [Cmd+clique]', 'Espiar [Opção+clique]'])
  })
  test('what is not followed has no menu', () => {
    assert.deepEqual(linkMenuPlan({ kind: 'anchor', id: 'x' }, facts), [])
    assert.deepEqual(linkMenuPlan({ kind: 'ignore' }, facts), [])
    assert.deepEqual(linkMenuPlan({ kind: 'tether', url: 'tether://nowhere' }, facts), [])
  })
})

describe('what the menu reads of a link', () => {
  test('the pane a link names', () => {
    assert.equal(paneOfLink({ kind: 'tether', url: 'tether://tab/abc123' }), 'abc123')
    assert.equal(paneOfLink({ kind: 'tether', url: 'tether://note?path=C%3A%2Fa.md' }), undefined)
    assert.equal(paneOfLink({ kind: 'external', url: 'http://x.y/z' }), undefined)
  })
  test('the copy text is the link or the path', () => {
    assert.equal(linkCopyText({ kind: 'external', url: 'http://x.y/z' }), 'http://x.y/z')
    assert.equal(linkCopyText({ kind: 'file', path: 'C:/a/b.ts', position: { line: 3 } }), 'C:/a/b.ts')
    assert.equal(linkCopyText({ kind: 'anchor', id: 'x' }), undefined)
  })
})

describe('Alt+click on a tab', () => {
  const ev = (o: Partial<{ button: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) =>
    ({ button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o })
  test('Alt alone with the main button peeks; any other combination is another gesture', () => {
    assert.equal(isPeekClick(ev({ altKey: true })), true)
    assert.equal(isPeekClick(ev({})), false)
    assert.equal(isPeekClick(ev({ altKey: true, ctrlKey: true })), false)
    assert.equal(isPeekClick(ev({ altKey: true, metaKey: true })), false)
    assert.equal(isPeekClick(ev({ altKey: true, shiftKey: true })), false)
    assert.equal(isPeekClick(ev({ altKey: true, button: 2 })), false)
  })
})
