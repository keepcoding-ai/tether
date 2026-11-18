// The search results tree's pure rules (extensions/search/renderer/results-rules.ts): the rows built from the results model
// in list and tree view with the initial and remembered collapse, F4 / Shift+F4 in tree order with wrapping, the keyboard's
// targets, where the focus goes when its row is gone, the redraw's adaptive pace and what each row shows and says.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FileMatch, FolderMatch, Match, SearchModel, SearchSortOrder, type CollapseResults } from '../../app/shared/vscode-search-model.ts'
import { OneLineRange, QueryType, SearchRange, TextSearchMatch, type IFileMatch, type ITextQuery } from '../../app/shared/vscode-search.ts'
import {
  afterDismiss, ancestorIds, ariaLabel, countOf, flatRows, isCollapsed, matchParts, nameOf, navigate, nextInterval, pageTarget, parentIndex,
  preorder, REDRAW_MAX_MS, REDRAW_MIN_MS, redrawDelay, replaceLabel, showsReplace, stepMatch, survivor, treeElements,
  type BuildOptions, type CollapseMemory, type Indexed, type NavRow,
} from '../../extensions/search/renderer/results-rules.ts'

const R = '/r'

function textQuery(folders: string[], pattern: string): ITextQuery {
  return { type: QueryType.Text, contentPattern: { pattern }, folderQueries: folders.map(folder => ({ folder })) }
}

function aModel(folders: string[] = [R], pattern = 'x'): SearchModel {
  const model = new SearchModel({ caseInsensitive: false })
  model.query = textQuery(folders, pattern)
  return model
}

/** A raw file match with one match per given zero-based line, the text "a x b" with the "x" found. */
function raw(path: string, ...lines: number[]): IFileMatch {
  return { resource: path, results: lines.map(l => new TextSearchMatch('a x b', new OneLineRange(l, 2, 3))) }
}

const opts = (tree: boolean, collapseResults: CollapseResults = 'alwaysExpand'): BuildOptions => ({ tree, sortOrder: SearchSortOrder.Default, collapseResults })

const shape = (model: SearchModel, o: BuildOptions, memory: CollapseMemory = new Map()) =>
  flatRows(treeElements(model.searchResult, 1, o, memory)).map(r => `${'  '.repeat(r.level - 1)}${r.kind}:${r.kind === 'match' ? '' : r.id.replace(/^.*?\//, '/')}${r.expanded === undefined ? '' : r.expanded ? ' +' : ' -'}`)

const rows = (list: NavRow[]): Indexed<NavRow> => ({ length: list.length, at: i => list[i] })

describe('rows from the results model', () => {
  test('list view, one root: the root is left out, files at level 1, their matches at level 2', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/b/z.txt', 0), raw(R + '/a.txt', 3, 1)])
    const flat = flatRows(treeElements(m.searchResult, 1, opts(false), new Map()))
    assert.deepEqual(flat.map(r => [r.kind, r.level, r.count]), [['file', 1, 2], ['match', 2, 0], ['match', 2, 0], ['file', 1, 1], ['match', 2, 0]])
    assert.equal(flat[0]!.expanded, true)
    assert.equal(flat[1]!.expanded, undefined)
  })

  test('tree view: intermediate folders with the matches below them as count', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/b/z.txt', 0, 1), raw(R + '/b/c/y.txt', 2), raw(R + '/a.txt', 0)])
    const flat = flatRows(treeElements(m.searchResult, 1, opts(true), new Map()))
    assert.deepEqual(flat.filter(r => r.kind !== 'match').map(r => [r.kind, r.level, r.count]), [
      ['folder', 1, 3], ['folder', 2, 1], ['file', 3, 1], ['file', 2, 2], ['file', 1, 1],
    ])
  })

  test('two roots: a folder row per root, the files under it', () => {
    const m = aModel([R + '/p', R + '/q'])
    m.searchResult.add([raw(R + '/p/1.txt', 0), raw(R + '/q/2.txt', 0, 1)])
    const flat = flatRows(treeElements(m.searchResult, 1, opts(false), new Map()))
    assert.deepEqual(flat.filter(r => r.kind !== 'match').map(r => [r.kind, r.level, r.count]), [['folder', 1, 1], ['file', 2, 1], ['folder', 1, 2], ['file', 2, 2]])
  })

  test('auto: a file with more than 10 matches starts collapsed and carries no children', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/many.txt', ...Array.from({ length: 11 }, (_, i) => i)), raw(R + '/few.txt', 0)])
    const els = treeElements(m.searchResult, 1, opts(false, 'auto'), new Map())
    const many = els.find(e => e.element.id.endsWith('many.txt'))!
    assert.equal(many.collapsed, true)
    assert.deepEqual([...many.children!], [])
    assert.equal(flatRows(els).length, 3)
  })

  test('alwaysCollapse collapses every file; alwaysExpand none', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/a.txt', 0), raw(R + '/b.txt', 0)])
    assert.deepEqual(shape(m, opts(false, 'alwaysCollapse')), ['file:/r/a.txt -', 'file:/r/b.txt -'])
    assert.equal(shape(m, opts(false, 'alwaysExpand')).length, 4)
  })

  test('the first decision is remembered by id: a file that grows past 10 matches stays as it was', () => {
    const m = aModel()
    const memory: CollapseMemory = new Map()
    m.searchResult.add([raw(R + '/a.txt', 0)])
    treeElements(m.searchResult, 1, opts(false, 'auto'), memory)
    m.searchResult.add([raw(R + '/a.txt', ...Array.from({ length: 12 }, (_, i) => i + 1))])
    const file = m.searchResult.matches()[0]!
    assert.equal(file.count(), 13)
    assert.equal(isCollapsed(file, memory, 'auto'), false)
    // A person's collapse survives a rebuild; forgetting the memory (reset) goes back to the rule.
    memory.set(file.id(), true)
    assert.deepEqual(shape(m, opts(false, 'auto'), memory), ['file:/r/a.txt -'])
    assert.equal(isCollapsed(file, new Map(), 'auto'), true)
  })

  test('counts: a folder counts every match below it, a file its own, a match none', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/d/a.txt', 0, 1), raw(R + '/d/e/b.txt', 2)])
    const folder = [...preorder(m.searchResult, opts(true), false)][0] as FolderMatch
    assert.equal(countOf(folder), 3)
    const file = m.searchResult.matches()[0]!
    assert.equal(countOf(file), file.count())
    assert.equal(countOf(file.matches()[0]!), 0)
  })
})

describe('F4 / Shift+F4', () => {
  function sample(): { m: SearchModel; ids: string[] } {
    const m = aModel()
    m.searchResult.add([raw(R + '/a.txt', 0, 5), raw(R + '/b.txt', 2)])
    const ids = [...preorder(m.searchResult, opts(false))].map(e => e.id())
    return { m, ids }
  }
  const o = { tree: false, sortOrder: SearchSortOrder.Default }

  test('the tree order: each file, then its matches by position', () => {
    const { m } = sample()
    const kinds = [...preorder(m.searchResult, o)].map(e => e instanceof FileMatch ? 'file' : e instanceof Match ? `m${e.range().startLineNumber}` : 'folder')
    assert.deepEqual(kinds, ['file', 'm1', 'm6', 'file', 'm3'])
  })

  test('next: from nothing the first match; from a file its first match; from the last match back to the first', () => {
    const { m, ids } = sample()
    const sr = m.searchResult
    assert.equal(stepMatch(sr, o, undefined, false)?.id(), ids[1])
    assert.equal(stepMatch(sr, o, ids[0], false)?.id(), ids[1])
    assert.equal(stepMatch(sr, o, ids[1], false)?.id(), ids[2])
    assert.equal(stepMatch(sr, o, ids[2], false)?.id(), ids[4])
    assert.equal(stepMatch(sr, o, ids[3], false)?.id(), ids[4])
    assert.equal(stepMatch(sr, o, ids[4], false)?.id(), ids[1])
  })

  test('previous: the last match before; from a file the last match of the file before; from the first, the last', () => {
    const { m, ids } = sample()
    const sr = m.searchResult
    assert.equal(stepMatch(sr, o, ids[4], true)?.id(), ids[2])
    assert.equal(stepMatch(sr, o, ids[3], true)?.id(), ids[2])
    assert.equal(stepMatch(sr, o, ids[2], true)?.id(), ids[1])
    assert.equal(stepMatch(sr, o, ids[1], true)?.id(), ids[4])
    assert.equal(stepMatch(sr, o, ids[0], true)?.id(), ids[4])
    assert.equal(stepMatch(sr, o, undefined, true)?.id(), ids[4])
  })

  test('a single match wraps to itself; a row that is gone starts over; no results, nothing', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/a.txt', 0)])
    const only = m.searchResult.matches()[0]!.matches()[0]!
    assert.equal(stepMatch(m.searchResult, o, only.id(), false), only)
    assert.equal(stepMatch(m.searchResult, o, only.id(), true), only)
    assert.equal(stepMatch(m.searchResult, o, 'MATCH_gone', false), only)
    assert.equal(stepMatch(aModel().searchResult, o, undefined, false), undefined)
  })

  test('collapse does not hide a match from F4; what to expand is the chain above it', () => {
    const m = aModel()
    m.searchResult.add([raw(R + '/d/e/a.txt', 0)])
    const match = m.searchResult.matches()[0]!.matches()[0]!
    // Collapsed everywhere, the walk still finds it.
    assert.equal(stepMatch(m.searchResult, { tree: true, sortOrder: SearchSortOrder.Default }, undefined, false), match)
    const chain = ancestorIds(match)
    assert.equal(chain.at(-1), match.parent().id())
    assert.ok(chain.length >= 3, 'root, folders and the file')
    assert.ok(chain.every(id => !id.startsWith('MATCH_')))
  })
})

describe('keyboard', () => {
  // folder (open) > file (open) > 2 matches; file (collapsed)
  const list = rows([
    { level: 1, collapsible: true, expanded: true },
    { level: 2, collapsible: true, expanded: true },
    { level: 3, collapsible: false, expanded: false },
    { level: 3, collapsible: false, expanded: false },
    { level: 2, collapsible: true, expanded: false },
  ])

  test('up, down, Home, End; up on the first row leaves the tree', () => {
    assert.deepEqual(navigate(list, 0, 'ArrowDown'), { type: 'focus', index: 1 })
    assert.deepEqual(navigate(list, 4, 'ArrowDown'), { type: 'none' })
    assert.deepEqual(navigate(list, 2, 'ArrowUp'), { type: 'focus', index: 1 })
    assert.deepEqual(navigate(list, 0, 'ArrowUp'), { type: 'leave' })
    assert.deepEqual(navigate(list, 3, 'Home'), { type: 'focus', index: 0 })
    assert.deepEqual(navigate(list, 1, 'End'), { type: 'focus', index: 4 })
  })

  test('right expands or goes to the first child; left collapses or goes to the parent', () => {
    assert.deepEqual(navigate(list, 4, 'ArrowRight'), { type: 'expand' })
    assert.deepEqual(navigate(list, 1, 'ArrowRight'), { type: 'focus', index: 2 })
    assert.deepEqual(navigate(list, 2, 'ArrowRight'), { type: 'none' })
    assert.deepEqual(navigate(list, 1, 'ArrowLeft'), { type: 'collapse' })
    assert.deepEqual(navigate(list, 3, 'ArrowLeft'), { type: 'focus', index: 1 })
    assert.deepEqual(navigate(list, 4, 'ArrowLeft'), { type: 'focus', index: 0 })
    assert.equal(parentIndex(list, 0), -1)
  })

  test('Enter opens a match and toggles a folder or file', () => {
    assert.deepEqual(navigate(list, 2, 'Enter'), { type: 'open' })
    assert.deepEqual(navigate(list, 4, 'Enter'), { type: 'toggle' })
    assert.deepEqual(navigate(list, 9, 'Enter'), { type: 'none' })
  })

  test('PageDown/PageUp: first to the edge of the view, then a page further, clamped', () => {
    assert.equal(pageTarget(2, 100, 0, 9, 10, true), 9)
    assert.equal(pageTarget(9, 100, 0, 9, 10, true), 18)
    assert.equal(pageTarget(95, 100, 90, 99, 10, true), 99)
    assert.equal(pageTarget(5, 100, 0, 9, 10, false), 0)
    assert.equal(pageTarget(0, 100, 0, 9, 10, false), 0)
    assert.equal(pageTarget(0, 0, 0, 0, 10, true), -1)
  })
})

describe('where the focus goes', () => {
  const list = rows([
    { level: 1, collapsible: true, expanded: true },
    { level: 2, collapsible: false, expanded: false },
    { level: 2, collapsible: false, expanded: false },
    { level: 1, collapsible: true, expanded: true },
    { level: 2, collapsible: false, expanded: false },
  ])

  test('dismissing a file goes past its matches to the next row; the last row gives way to the one above', () => {
    assert.equal(afterDismiss(list, 0), 3)
    assert.equal(afterDismiss(list, 1), 2)
    assert.equal(afterDismiss(list, 4), 3)
    assert.equal(afterDismiss(rows([{ level: 1, collapsible: false, expanded: false }]), 0), -1)
  })

  test('a row gone in a redraw: the focus stays at the same index, capped at the end, none when empty', () => {
    assert.equal(survivor(2, 5), 2)
    assert.equal(survivor(4, 3), 2)
    assert.equal(survivor(0, 0), -1)
  })
})

describe('the redraw pace', () => {
  test('a slow rebuild doubles the interval, up to the cap; a fast one keeps it', () => {
    assert.equal(nextInterval(REDRAW_MIN_MS, 10), REDRAW_MIN_MS)
    assert.equal(nextInterval(REDRAW_MIN_MS, 51), 200)
    assert.equal(nextInterval(400, 80), REDRAW_MAX_MS)
    assert.equal(nextInterval(REDRAW_MAX_MS, 500), REDRAW_MAX_MS)
  })

  test('the first rebuild runs at once; the next waits out the interval', () => {
    assert.equal(redrawDelay(1000, undefined, 100), 0)
    assert.equal(redrawDelay(1030, 1000, 100), 70)
    assert.equal(redrawDelay(1200, 1000, 100), 0)
  })
})

describe('what a row shows and says', () => {
  function withMatch(): { m: SearchModel; match: Match; file: FileMatch } {
    const m = aModel([R], 'x')
    m.searchResult.add([{ resource: R + '/src/x.ts', results: [new TextSearchMatch('let x = 1', new OneLineRange(11, 4, 5))] }])
    const file = m.searchResult.matches()[0]!
    return { m, file, match: file.matches()[0]! }
  }

  test('a match: before, the found text, after, its line; the title is the whole line', () => {
    const { match } = withMatch()
    const p = matchParts(match, false)
    assert.deepEqual([p.before, p.inside, p.after, p.line, p.extraLines, p.title, p.replacement], ['let ', 'x', ' = 1', 12, 0, 'let x = 1', undefined])
  })

  test('the replace preview: only with replace on and a text typed; the title shows the replaced line', () => {
    const { m, match } = withMatch()
    assert.equal(showsReplace(m), false)
    m.replaceActive = true
    assert.equal(showsReplace(m), false)
    m.replaceString = 'y'
    assert.equal(showsReplace(m), true)
    const p = matchParts(match, true)
    assert.equal(p.replacement, 'y')
    assert.equal(p.title, 'let y = 1')
  })

  test('a match spanning lines tells how many more', () => {
    const m = aModel()
    m.searchResult.add([{ resource: R + '/f.txt', results: [new TextSearchMatch('ab\ncd', new SearchRange(4, 1, 5, 1))] }])
    const p = matchParts(m.searchResult.matches()[0]!.matches()[0]!, false)
    assert.equal(p.line, 5)
    assert.equal(p.extraLines, 1)
  })

  test('accessible labels: file, folder, files outside the projects, match, match with replace', () => {
    const { m, match, file } = withMatch()
    assert.equal(ariaLabel(file, false), '1 resultado no arquivo x.ts')
    assert.equal(ariaLabel(match, false), 'linha 12: let x = 1')
    m.replaceActive = true
    m.replaceString = 'y'
    assert.equal(ariaLabel(match, true), 'linha 12: let x = 1, substituir "x" por "y"')
    const two = aModel([R + '/p', R + '/q'])
    two.searchResult.add([raw(R + '/p/a.txt', 0, 1), raw('/elsewhere/b.txt', 0)])
    const [p, other] = two.searchResult.folderMatches().filter(f => !f.isEmpty())
    assert.equal(ariaLabel(p!, false), '2 resultados na pasta p')
    assert.equal(ariaLabel(other!, false), '1 resultado fora dos projetos')
    assert.equal(nameOf(other!), 'Outros arquivos')
    assert.equal(nameOf(p!), 'p')
  })

  test('the replace action names what it replaces', () => {
    assert.equal(replaceLabel('match'), 'Substituir')
    assert.equal(replaceLabel('file'), 'Substituir tudo neste arquivo')
    assert.equal(replaceLabel('folder'), 'Substituir tudo nesta pasta')
  })
})
