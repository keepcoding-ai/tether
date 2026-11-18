// The text the results tree copies (extensions/search/renderer/copy-rules.ts): a match, a file, a folder and everything, in
// the platform's line break; the path of a row.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FileMatch, FolderMatch, Match, SearchModel } from '../../app/shared/vscode-search-model.ts'
import { OneLineRange, QueryType, SearchRange, TextSearchMatch, type IFileMatch } from '../../app/shared/vscode-search.ts'
import { allFolderMatchesToString, copyAllText, copyPathText, copyText, fileMatchToString, lineDelimiter, matchToString } from '../../extensions/search/renderer/copy-rules.ts'

const model = (folders: string[]): SearchModel => {
  const m = new SearchModel({ caseInsensitive: false })
  m.query = { type: QueryType.Text, contentPattern: { pattern: 'x' }, folderQueries: folders.map(folder => ({ folder })) }
  return m
}

/** A one-line match: `text` on zero-based `line`, the hit at columns 2..3. */
const hit = (line: number, text = 'a x b'): TextSearchMatch => new TextSearchMatch(text, new OneLineRange(line, 2, 3))
const raw = (resource: string, ...results: TextSearchMatch[]): IFileMatch => ({ resource, results })

const firstFile = (m: SearchModel): FileMatch => m.searchResult.matches()[0]!
const firstMatch = (m: SearchModel): Match => firstFile(m).matches()[0]!

describe('copy: line break', () => {
  test('CRLF on Windows, LF elsewhere', () => {
    assert.equal(lineDelimiter('win32'), '\r\n')
    assert.equal(lineDelimiter('posix'), '\n')
  })
})

describe('copy: a match', () => {
  test('one line: "line,column: text" with one-based numbers', () => {
    const m = model(['/r'])
    m.searchResult.add([raw('/r/a.txt', hit(4))])
    assert.equal(matchToString(firstMatch(m)), '5,3: a x b')
  })

  test('several lines: the next prefixes are just the line, all padded to the widest', () => {
    const m = model(['/r'])
    m.searchResult.add([raw('/r/a.txt', new TextSearchMatch('ab\ncd\nef', new SearchRange(8, 1, 10, 1)))])
    // The first prefix "9,2" is the widest; the next ones are numbered startLine + i, as the origin does.
    assert.equal(matchToString(firstMatch(m)), '9,2: ab\n10:  cd\n11:  ef')
  })

  test('indented for the file listing', () => {
    const m = model(['/r'])
    m.searchResult.add([raw('/r/a.txt', hit(0))])
    assert.equal(matchToString(firstMatch(m), 2), '  1,3: a x b')
  })
})

describe('copy: a file, a folder, everything', () => {
  const build = (): SearchModel => {
    const m = model(['/r'])
    m.searchResult.add([raw('/r/b.txt', hit(1)), raw('/r/a.txt', hit(2), hit(0)), raw('/r/d/c.txt', hit(0))])
    return m
  }

  test('a file: its path, then its matches in position order, indented by two', () => {
    const m = build()
    const a = m.searchResult.matches().find(f => f.resource === '/r/a.txt')!
    assert.equal(fileMatchToString(a, '\n').text, '/r/a.txt\n  1,3: a x b\n  3,3: a x b')
    assert.equal(copyText(a, '\r\n'), '/r/a.txt\r\n  1,3: a x b\r\n  3,3: a x b')
  })

  test('a folder: its subfolders then its files, separated by a blank line', () => {
    const m = build()
    const root = m.searchResult.folderMatches()[0]!
    assert.equal(copyText(root, '\n'), '/r/d/c.txt\n  1,3: a x b\n\n/r/a.txt\n  1,3: a x b\n  3,3: a x b\n\n/r/b.txt\n  2,3: a x b')
    const sub = root.matches().find(x => x instanceof FolderMatch) as FolderMatch
    assert.equal(copyText(sub, '\r\n'), '/r/d/c.txt\r\n  1,3: a x b')
  })

  test('everything: every root with matches; the line break is the platform\'s', () => {
    const m = model(['/r', '/s'])
    m.searchResult.add([raw('/r/a.txt', hit(0)), raw('/s/b.txt', hit(0))])
    assert.equal(copyAllText(m.searchResult, '\r\n'), '/r/a.txt\r\n  1,3: a x b\r\n\r\n/s/b.txt\r\n  1,3: a x b')
    assert.equal(allFolderMatchesToString([], '\n'), '')
  })

  test('nothing to copy is undefined', () => {
    assert.equal(copyAllText(model(['/r']).searchResult, '\n'), undefined)
  })
})

describe('copy: the path of a row', () => {
  test('a match gives its file, a file its path, a folder its path', () => {
    const m = model(['/r'])
    m.searchResult.add([raw('/r/d/c.txt', hit(0))])
    assert.equal(copyPathText(firstMatch(m)), '/r/d/c.txt')
    assert.equal(copyPathText(firstFile(m)), '/r/d/c.txt')
    assert.equal(copyPathText(m.searchResult.folderMatches()[0]!), '/r')
  })

  test('files outside every project share a folder with no path', () => {
    const m = model(['/r'])
    m.searchResult.add([raw('/elsewhere/x.txt', hit(0))])
    const other = m.searchResult.folderMatches().find(f => f.resource === null)!
    assert.equal(copyPathText(other), undefined)
  })
})
