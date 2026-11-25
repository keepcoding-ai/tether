// The rows of a link's context menu (app/renderer/link-menu-rules.ts), pure: what each kind of link offers, the hints and the
// copy text.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPeekClick, linkCopyText, linkMenuPlan, paneOfLink, relativeCopyText, relativeToFolder, type LinkMenuLine } from '../../app/renderer/link-menu-rules.ts'

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
  test('an external link with no browser connected to the Bridge: the system browser and copy', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'external', url: 'http://localhost:9/x' }, facts)), ['Abrir no navegador do sistema [Ctrl+clique]', '-', 'Copiar link'])
    assert.deepEqual(labels(linkMenuPlan({ kind: 'external', url: 'https://a.b/' }, { ...facts, bridgeBrowser: '' })), ['Abrir no navegador do sistema [Ctrl+clique]', '-', 'Copiar link'])
  })
  test('an external link with a browser connected: the Bridge row after the system browser, named after it, before copy', () => {
    const plan = linkMenuPlan({ kind: 'external', url: 'https://a.b/c?d=1' }, { ...facts, mac: true, bridgeBrowser: 'Chrome' })
    assert.deepEqual(labels(plan), ['Abrir no navegador do sistema [Cmd+clique]', 'Abrir no Chrome pelo Bridge', '-', 'Copiar link'])
    assert.deepEqual(plan.map(l => (l === 'sep' ? '-' : l.action)), ['follow', 'bridge', '-', 'copy'])
    assert.equal(labels(linkMenuPlan({ kind: 'external', url: 'http://x.y' }, { ...facts, bridgeBrowser: 'Edge' }))[1], 'Abrir no Edge pelo Bridge')
  })
  test('the tether browser rows come only with the opener published, right after the system browser and before the Bridge row', () => {
    const link = { kind: 'external', url: 'https://a.b/' } as const
    assert.ok(!labels(linkMenuPlan(link, facts)).some(l => l.includes('tether')))
    const plan = linkMenuPlan(link, { ...facts, tetherBrowser: true, bridgeBrowser: 'Chrome' })
    assert.deepEqual(plan.map(l => (l === 'sep' ? '-' : l.action)), ['follow', 'browser', 'browser-side', 'bridge', '-', 'copy'])
    assert.deepEqual(labels(plan).slice(0, 3), ['Abrir no navegador do sistema [Ctrl+clique]', 'Abrir no navegador do tether', 'Abrir ao lado'])
    for (const target of [{ kind: 'tether', url: 'tether://tab/abc' }, { kind: 'channel', id: 'c1' }, { kind: 'file', path: 'C:/a/b.ts' }] as const) {
      assert.ok(!labels(linkMenuPlan(target, { ...facts, tetherBrowser: true })).some(l => l.includes('navegador do tether')), target.kind)
    }
  })
  test('the Bridge row belongs to http(s) links only', () => {
    const f = { ...facts, bridgeBrowser: 'Chrome' }
    for (const target of [{ kind: 'tether', url: 'tether://tab/abc' }, { kind: 'channel', id: 'c1' }, { kind: 'file', path: 'C:/a/b.ts' }] as const) {
      assert.ok(!labels(linkMenuPlan(target, f)).some(l => l.includes('Bridge')), target.kind)
    }
  })
  test('a file and a folder', () => {
    // No folder of reference, no explorer: only the rows that always make sense.
    assert.deepEqual(labels(linkMenuPlan({ kind: 'file', path: 'C:/a/b.ts' }, facts)),
      ['Abrir [Ctrl+clique]', 'Abrir ao lado', '-', 'Mostrar na pasta do sistema', '-', 'Copiar caminho'])
    assert.deepEqual(labels(linkMenuPlan({ kind: 'file', path: 'C:/a', isDirectory: true }, facts)), ['Abrir pasta [Ctrl+clique]', '-', 'Copiar caminho'])
  })
  test('a file under the tab folder gets the full list, in the approved order', () => {
    const plan = linkMenuPlan({ kind: 'file', path: 'C:/proj/src/a.ts', position: { line: 4 } }, { ...facts, explorerRoots: ['C:/proj'], baseDir: 'C:\\proj' })
    assert.deepEqual(labels(plan), [
      'Abrir [Ctrl+clique]', 'Abrir ao lado', '-', 'Mostrar no explorador do tether', 'Mostrar na pasta do sistema', '-', 'Copiar caminho', 'Copiar caminho relativo',
    ])
  })
  test('the relative row is absent with no folder, outside it, or on the folder itself', () => {
    const file = (path: string): LinkMenuLine[] => linkMenuPlan({ kind: 'file', path }, { ...facts, baseDir: 'C:/proj' })
    const has = (plan: LinkMenuLine[]): boolean => labels(plan).includes('Copiar caminho relativo')
    assert.equal(has(file('C:/proj/a.ts')), true)
    assert.equal(has(file('C:/other/a.ts')), false)
    assert.equal(has(file('C:/project/a.ts')), false, 'a sibling that shares a prefix is outside')
    assert.equal(has(file('C:/proj')), false)
    assert.equal(has(linkMenuPlan({ kind: 'file', path: 'C:/proj/a.ts' }, facts)), false)
  })
  test('a folder link gets no new rows', () => {
    assert.deepEqual(labels(linkMenuPlan({ kind: 'file', path: 'C:/proj/src', isDirectory: true }, { ...facts, explorerRoots: ['C:/proj'], baseDir: 'C:/proj' })), ['Abrir pasta [Ctrl+clique]', '-', 'Copiar caminho'])
  })
  test('the explorer row shows only when a folder the explorer shows holds the file', () => {
    const has = (path: string, roots: readonly string[] | undefined, caseInsensitive = false): boolean =>
      labels(linkMenuPlan({ kind: 'file', path }, { ...facts, ...(roots ? { explorerRoots: roots } : {}), caseInsensitive })).includes('Mostrar no explorador do tether')
    assert.equal(has('C:/proj/a.ts', ['C:/proj']), true)
    assert.equal(has('C:/other/a.ts', ['C:/proj']), false, 'outside every folder')
    assert.equal(has('C:/project/a.ts', ['C:/proj']), false, 'a sibling that shares a prefix')
    assert.equal(has('C:/proj', ['C:/proj']), false, 'the folder itself')
    assert.equal(has('C:/x/b.ts', ['C:/proj', 'C:/x']), true, 'any of the folders')
    assert.equal(has('C:/proj/a.ts', []), false, 'no folders')
    assert.equal(has('C:/proj/a.ts', undefined), false, 'explorer off')
    assert.equal(has('C:/PROJ/a.ts', ['C:/proj'], true), true)
    assert.equal(has('C:/PROJ/a.ts', ['C:/proj'], false), false)
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

describe('relative paths', () => {
  test('under the folder, with / separators; case only matters where the system says so', () => {
    assert.equal(relativeToFolder('C:\\Proj\\', 'C:\\Proj\\src\\a.ts', false), 'src/a.ts')
    assert.equal(relativeToFolder('C:/proj', 'C:/Proj/a.ts', true), 'a.ts')
    assert.equal(relativeToFolder('C:/proj', 'C:/Proj/a.ts', false), undefined)
    assert.equal(relativeCopyText({ kind: 'file', path: '/w/x/y.md' }, { baseDir: '/w' }), 'x/y.md')
    assert.equal(relativeCopyText({ kind: 'external', url: 'http://a.b' }, { baseDir: '/w' }), undefined)
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
