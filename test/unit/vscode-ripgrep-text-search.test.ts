// The ripgrep text search engine port (app/main/vscode-ripgrep-text-search.ts): rg's arguments and the JSON parser in
// isolation, and the engine against the real rg (the @vscode/ripgrep binary) over a temporary folder.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRipgrep } from '../../app/main/file-index.ts'
import {
  fixNewline, fixRegexNewline, getRgArgs, performBraceExpansionForRipgrep, RipgrepParser, RipgrepTextSearchEngine,
  rgErrorMsgForDisplay, unicodeEscapesToPCRE2, type RipgrepTextSearchOptions, type TextSearchProviderFolderOptions,
  type TextSearchQuery2,
} from '../../app/main/vscode-ripgrep-text-search.ts'
import {
  deserializeSearchError, type ITextSearchContext, type ITextSearchMatch, type ITextSearchResult, SearchErrorCode,
} from '../../app/shared/vscode-search.ts'

const folderOptions = (folder: string, extra: Partial<TextSearchProviderFolderOptions> = {}): TextSearchProviderFolderOptions => ({
  folder,
  includes: [],
  excludes: [],
  followSymlinks: false,
  useIgnoreFiles: { local: true, parent: true, global: true },
  encoding: '',
  ...extra,
})

describe('getRgArgs', () => {
  const args = (query: TextSearchQuery2, extra: Partial<RipgrepTextSearchOptions> = {}, folder: Partial<TextSearchProviderFolderOptions> = {}) =>
    getRgArgs(query, { folderOptions: folderOptions('/f', folder), ...extra })

  test('literal: --fixed-strings and the pattern after --', () => {
    assert.deepEqual(args({ pattern: '-x' }), [
      '--hidden', '--no-require-git', '--ignore-case', '--crlf', '--fixed-strings', '--no-config', '--json', '--', '-x', '.',
    ])
  })

  test('regex: --engine auto and --regexp, newlines fixed', () => {
    const a = args({ pattern: 'a\\nb', isRegExp: true, isCaseSensitive: true })
    assert.deepEqual(a, [
      '--hidden', '--no-require-git', '--case-sensitive', '--crlf', '--engine', 'auto', '--regexp', 'a\\r?\\nb', '--no-config', '--json', '--', '.',
    ])
  })

  test('whole word wraps the escaped literal in \\b', () => {
    const a = args({ pattern: 'a.b/c', isWordMatch: true })
    assert.equal(a[a.indexOf('--regexp') + 1], '\\ba\\.b/c\\b')
    assert.ok(!a.includes('--fixed-strings'))
  })

  test('a lone -- becomes a regex', () => {
    const query = { pattern: '--' }
    const a = args(query)
    assert.equal(a[a.indexOf('--regexp') + 1], '\\-\\-')
    assert.equal(query.pattern, '--', 'the caller\'s query is not rewritten')
  })

  test('multiline literal is escaped into a regex', () => {
    const a = args({ pattern: 'a.\nb', isMultiline: true })
    assert.equal(a[a.indexOf('--regexp') + 1], 'a\\.\\r?\\nb')
    assert.ok(a.includes('--multiline'))
  })

  test('folder options: globs, ignore files, follow, encoding, threads, size, context', () => {
    const a = args({ pattern: 'x' }, { numThreads: 2, maxFileSize: 1000, surroundingContext: 2 }, {
      includes: ['src/{a,b}/*.ts', '**/*.md'],
      excludes: ['**/node_modules', 'out'],
      useIgnoreFiles: { local: true, parent: false, global: false },
      followSymlinks: true,
      encoding: 'utf-16le',
      ignoreGlobCase: true,
    })
    assert.deepEqual(a, [
      '--hidden', '--no-require-git', '--ignore-case', '--glob-case-insensitive', '--ignore-file-case-insensitive',
      '-g', '!*', '-g', '/src', '-g', '/src/a', '-g', '/src/a/*.ts', '-g', '/src', '-g', '/src/b', '-g', '/src/b/*.ts',
      '-g', '**/*.md', '-g', '!**/node_modules', '-g', '!/out',
      '--max-filesize', '1000', '--no-ignore-parent', '--follow', '--encoding', 'utf-16le', '--threads', '2',
      '--crlf', '--fixed-strings', '--no-config', '--no-ignore-global', '--json',
      '--before-context', '2', '--after-context', '2', '--', 'x', '.',
    ])
  })

  test('no local ignore files: --no-ignore', () => {
    const a = args({ pattern: 'x' }, {}, { useIgnoreFiles: { local: false, parent: true, global: true } })
    assert.ok(a.includes('--no-ignore'))
    assert.ok(!a.includes('--no-ignore-parent'))
  })
})

describe('regex helpers', () => {
  test('fixRegexNewline', () => {
    const cases: [string, string][] = [
      ['foo', 'foo'],
      ['foo\\n', 'foo\\r?\\n'],
      ['foo\\nbar\\n', 'foo\\r?\\nbar\\r?\\n'],
      ['[\\n]', '\\r?\\n'],
      ['[a-z\\n]', '(?:[a-z]|\\r?\\n)'],
      ['[^\\n]', '(?!\\r?\\n)'],
      ['[^a\\n]', '(?!\\r?\\n|[a])'],
      ['[^\\n]*', '.*'],
      ['[^a\\n]+', '[^a]+'],
      ['\\n+', '(?:\\r?\\n)+'],
      ['(a\\n)+', '(a(?:\\r?\\n))+'],
      ['(?<=\\n)x', '(?<=\\n)x'],
      ['(?<!a\\n)x\\n', '(?<!a\\n)x\\r?\\n'],
      ['\\\\n', '\\\\n'],
      ['(', '('], // unparsable: unchanged
    ]
    for (const [input, expected] of cases) {
      assert.equal(fixRegexNewline(input), expected, input)
    }
  })

  test('fixNewline', () => {
    assert.equal(fixNewline('a\nb'), 'a\\r?\\nb')
  })

  test('unicodeEscapesToPCRE2', () => {
    assert.equal(unicodeEscapesToPCRE2('\\u1234'), '\\x{1234}')
    assert.equal(unicodeEscapesToPCRE2('\\u{1234}'), '\\x{1234}')
    assert.equal(unicodeEscapesToPCRE2('\\\\u1234'), '\\\\u1234')
    assert.equal(unicodeEscapesToPCRE2('\\u{12345}'), '\\u{12345}')
  })

  test('performBraceExpansionForRipgrep', () => {
    assert.deepEqual(performBraceExpansionForRipgrep('a{b,c}d'), ['abd', 'acd'])
    assert.deepEqual(performBraceExpansionForRipgrep('{a,b}/{c,d}'), ['a/c', 'a/d', 'b/c', 'b/d'])
    assert.deepEqual(performBraceExpansionForRipgrep('a\\{b,c}'), ['a{b,c}'])
    assert.deepEqual(performBraceExpansionForRipgrep('{}x'), ['x'])
  })

  test('rgErrorMsgForDisplay', () => {
    assert.equal(rgErrorMsgForDisplay('rg: something not fatal\n'), undefined)
    assert.equal(rgErrorMsgForDisplay('error parsing glob \'[\': unclosed')?.message, 'Error parsing glob \'[\': unclosed')
    const e = rgErrorMsgForDisplay('rg: x\n\nregex parse error:\n    (\n\nPCRE2: error compiling pattern at offset 1: missing closing parenthesis\n')
    assert.equal(e?.message, 'Regex parse error: missing closing parenthesis')
    assert.equal(e?.code, SearchErrorCode.regexParseError)
  })
})

describe('RipgrepParser', () => {
  const root = join(tmpdir(), 'root')
  const preview = { matchLines: 100, charsPerLine: 10000 }
  const matchLine = (path: string, text: string, line: number, submatches: [number, number][]) => JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: submatches.map(([start, end]) => ({ match: { text: Buffer.from(text).subarray(start, end).toString() }, start, end })),
    },
  }) + '\n'

  test('JSON cut in the middle of a line and of a UTF-8 sequence', () => {
    const text = 'olá ação alvo\n'
    const start = Buffer.from('olá ação ').length
    const data = Buffer.from(
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.txt' } } }) + '\n' +
      matchLine('a.txt', text, 3, [[start, start + 4]]) +
      matchLine('b.txt', 'x\n', 1, [[0, 1]]),
    )
    const results: ITextSearchMatch[] = []
    const parser = new RipgrepParser(1000, root, preview)
    parser.on('result', r => results.push(r as ITextSearchMatch))
    // split inside "á" (two bytes) and at other arbitrary places
    const accent = data.indexOf(Buffer.from('á'))
    const firstBreak = data.indexOf('\n', data.indexOf('"match"'))
    const cuts = [5, accent + 1, firstBreak - 2, firstBreak + 7, data.length - 3]
    let prev = 0
    for (const cut of cuts) {
      parser.handleData(data.subarray(prev, cut))
      prev = cut
      if (cut < firstBreak) assert.equal(results.length, 0, 'nothing before the line break of the first match')
    }
    assert.equal(results.length, 1)
    parser.handleData(data.subarray(prev))
    parser.flush()
    assert.equal(results.length, 2)
    const first = results[0]!
    assert.equal(first.uri, join(root, 'a.txt'))
    assert.equal(first.previewText, text)
    assert.deepEqual({ ...first.rangeLocations[0]!.source }, { startLineNumber: 2, startColumn: 9, endLineNumber: 2, endColumn: 13 })
    assert.equal(text.slice(9, 13), 'alvo')
  })

  test('maxResults: finishes the line, then hitLimit', () => {
    const parser = new RipgrepParser(2, root, preview)
    const results: ITextSearchMatch[] = []
    let hit = 0
    parser.on('result', r => results.push(r as ITextSearchMatch))
    parser.on('hitLimit', () => hit++)
    parser.handleData(matchLine('a', 'x x x\n', 1, [[0, 1], [2, 3], [4, 5]]) + matchLine('a', 'x\n', 2, [[0, 1]]))
    assert.equal(hit, 1)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.rangeLocations.length, 2)
  })

  test('context lines are one-based and split per line', () => {
    const parser = new RipgrepParser(10, root, preview)
    const results: ITextSearchResult[] = []
    parser.on('result', r => results.push(r))
    parser.handleData(JSON.stringify({ type: 'context', data: { path: { text: 'a' }, lines: { text: 'one\r\ntwo\n' }, line_number: 4, absolute_offset: 0, submatches: [] } }) + '\n')
    assert.deepEqual(results.map(r => [(r as ITextSearchContext).text, (r as ITextSearchContext).lineNumber]), [['one\r', 4], ['two', 5]])
  })

  test('a one-line preview is cut around the match', () => {
    const parser = new RipgrepParser(10, root, { matchLines: 1, charsPerLine: 10 })
    const results: ITextSearchMatch[] = []
    parser.on('result', r => results.push(r as ITextSearchMatch))
    const text = 'a'.repeat(200) + 'MATCH' + 'b'.repeat(50) + '\n'
    parser.handleData(matchLine('a', text, 1, [[200, 205]]))
    const r = results[0]!
    const elision = '⟪ 198 characters skipped ⟫'
    assert.equal(r.previewText, elision + 'aaMATCHbbbbb')
    const start = elision.length + 2
    assert.deepEqual({ ...r.rangeLocations[0]!.preview }, { startLineNumber: 0, startColumn: start, endLineNumber: 0, endColumn: start + 5 })
    assert.equal(r.previewText.slice(start, start + 5), 'MATCH')
    assert.equal(r.rangeLocations[0]!.source.startColumn, 200)
  })
})

describe('RipgrepTextSearchEngine (real rg)', () => {
  const rg = findRipgrep()
  let dir = ''

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tether-rg-text-'))
    const write = (rel: string, content: string) => {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content)
    }
    write('a.txt', 'hello world\nfoo123 bar45\nHello again\ncategory cat\n')
    write('multi.txt', 'ab ab ab\n')
    write('unicode.txt', 'ação 😀 alvo final\n')
    write('crlf.txt', 'one\r\ntwo\r\nthree\r\n')
    write('ml.txt', 'start\nfoo\nbar\nend\n')
    write('src/code.ts', 'needle in ts\n')
    write('src/code.js', 'needle in js\n')
    write('docs/readme.md', 'needle in md\n')
    write('ignored/secret.txt', 'needle ignored\n')
    write('.gitignore', 'ignored/\n')
    write('ctx.txt', 'l1\nl2\nTARGET\nl4\nl5\n')
    write('many.txt', Array.from({ length: 10 }, (_, i) => `rep ${i}`).join('\n') + '\n')
    write('bad.txt', 'x\n')
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function search(query: TextSearchQuery2, folder: Partial<TextSearchProviderFolderOptions> = {}, extra: { maxResults?: number; surroundingContext?: number; signal?: AbortSignal } = {}) {
    const engine = new RipgrepTextSearchEngine(rg!)
    const results: ITextSearchResult[] = []
    const complete = await engine.provideTextSearchResults(query, {
      folderOptions: [folderOptions(dir, folder)],
      maxResults: extra.maxResults ?? 20000,
      surroundingContext: extra.surroundingContext,
    }, r => results.push(r), extra.signal)
    const matches = results.filter((r): r is ITextSearchMatch => 'rangeLocations' in r)
    return { complete, results, matches }
  }
  const rel = (m: ITextSearchResult) => m.uri!.substring(dir.length + 1).replace(/\\/g, '/')
  const texts = (m: ITextSearchMatch) => m.rangeLocations.map(r => {
    const lines = m.previewText.split('\n')
    const s = r.preview
    return s.startLineNumber === s.endLineNumber
      ? lines[s.startLineNumber]!.slice(s.startColumn, s.endColumn)
      : [lines[s.startLineNumber]!.slice(s.startColumn), ...lines.slice(s.startLineNumber + 1, s.endLineNumber), lines[s.endLineNumber]!.slice(0, s.endColumn)].join('\n')
  })

  test('rg is installed', () => {
    assert.ok(rg, '@vscode/ripgrep binary')
  })

  test('literal', async () => {
    const { matches, complete } = await search({ pattern: 'hello world' })
    assert.equal(complete.limitHit, false)
    assert.equal(matches.length, 1)
    assert.equal(rel(matches[0]!), 'a.txt')
    assert.deepEqual({ ...matches[0]!.rangeLocations[0]!.source }, { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 11 })
  })

  test('regex with groups', async () => {
    const { matches } = await search({ pattern: '(foo|bar)\\d+', isRegExp: true })
    assert.equal(matches.length, 1)
    assert.deepEqual(texts(matches[0]!), ['foo123', 'bar45'])
    assert.equal(matches[0]!.rangeLocations[1]!.source.startColumn, 7)
  })

  test('case sensitivity', async () => {
    const insensitive = await search({ pattern: 'hello' })
    assert.equal(insensitive.matches.length, 2)
    const sensitive = await search({ pattern: 'Hello', isCaseSensitive: true })
    assert.equal(sensitive.matches.length, 1)
    assert.equal(sensitive.matches[0]!.rangeLocations[0]!.source.startLineNumber, 2)
  })

  test('whole word', async () => {
    const { matches } = await search({ pattern: 'cat', isWordMatch: true })
    assert.equal(matches.length, 1)
    assert.equal(matches[0]!.rangeLocations.length, 1)
    assert.equal(matches[0]!.rangeLocations[0]!.source.startColumn, 9)
  })

  test('several matches on one line', async () => {
    const { matches } = await search({ pattern: 'ab', isCaseSensitive: true })
    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0]!.rangeLocations.map(r => r.source.startColumn), [0, 3, 6])
  })

  test('accents and emoji before the match: columns in UTF-16 units, not bytes', async () => {
    const { matches } = await search({ pattern: 'alvo' })
    const m = matches[0]!
    const line = 'ação 😀 alvo final'
    const src = m.rangeLocations[0]!.source
    assert.equal(src.startColumn, line.indexOf('alvo'))
    assert.equal(line.slice(src.startColumn, src.endColumn), 'alvo')
    assert.deepEqual(texts(m), ['alvo'])
  })

  test('CRLF: $ matches before \\r\\n and \\n matches \\r\\n', async () => {
    const end = await search({ pattern: 'two$', isRegExp: true })
    assert.equal(end.matches.length, 1)
    assert.equal(rel(end.matches[0]!), 'crlf.txt')
    const across = await search({ pattern: 'one\\ntwo', isRegExp: true, isMultiline: true })
    assert.equal(across.matches.length, 1)
    assert.deepEqual({ ...across.matches[0]!.rangeLocations[0]!.source }, { startLineNumber: 0, startColumn: 0, endLineNumber: 1, endColumn: 3 })
  })

  test('multiline literal', async () => {
    const { matches } = await search({ pattern: 'foo\nbar', isMultiline: true })
    assert.equal(matches.length, 1)
    assert.equal(rel(matches[0]!), 'ml.txt')
    assert.deepEqual({ ...matches[0]!.rangeLocations[0]!.source }, { startLineNumber: 1, startColumn: 0, endLineNumber: 2, endColumn: 3 })
    assert.deepEqual(texts(matches[0]!), ['foo\nbar'])
  })

  test('include and exclude globs', async () => {
    const included = await search({ pattern: 'needle' }, { includes: ['src/**'] })
    assert.deepEqual(included.matches.map(rel).sort(), ['src/code.js', 'src/code.ts'])
    const excluded = await search({ pattern: 'needle' }, { excludes: ['**/*.js', 'docs'] })
    assert.deepEqual(excluded.matches.map(rel).sort(), ['src/code.ts'])
    const star = await search({ pattern: 'needle' }, { includes: ['**/*.md'] })
    assert.deepEqual(star.matches.map(rel), ['docs/readme.md'])
  })

  test('.gitignore respected, or not', async () => {
    const respected = await search({ pattern: 'needle ignored' })
    assert.equal(respected.matches.length, 0)
    const disregarded = await search({ pattern: 'needle ignored' }, { useIgnoreFiles: { local: false, parent: false, global: false } })
    assert.deepEqual(disregarded.matches.map(rel), ['ignored/secret.txt'])
  })

  test('context lines', async () => {
    const { results } = await search({ pattern: 'TARGET' }, {}, { surroundingContext: 1 })
    const mine = results.filter(r => rel(r) === 'ctx.txt')
    assert.equal(mine.length, 3)
    assert.deepEqual(mine.map(r => 'text' in r ? [r.text, r.lineNumber] : 'match'), [['l2', 2], 'match', ['l4', 4]])
  })

  test('result limit: limitHit', async () => {
    const { matches, complete } = await search({ pattern: 'rep' }, {}, { maxResults: 3 })
    assert.equal(complete.limitHit, true)
    assert.equal(matches.length, 3)
  })

  test('AbortSignal: rg is killed and the promise resolves', async () => {
    const big = mkdtempSync(join(tmpdir(), 'tether-rg-cancel-'))
    try {
      for (let i = 0; i < 400; i++) writeFileSync(join(big, `f${i}.txt`), 'zz\n'.repeat(200))
      const engine = new RipgrepTextSearchEngine(rg!)
      const controller = new AbortController()
      let count = 0
      const complete = await engine.provideTextSearchResults({ pattern: 'zz' }, { folderOptions: [folderOptions(big)], maxResults: 1e9 }, () => {
        count++
        if (count === 1) controller.abort()
      }, controller.signal)
      assert.equal(complete.limitHit, false)
      assert.ok(count < 400, `stopped early (${count} results)`)

      // already aborted: resolves without results
      let late = 0
      await engine.provideTextSearchResults({ pattern: 'zz' }, { folderOptions: [folderOptions(big)], maxResults: 1e9 }, () => late++, AbortSignal.abort())
      assert.equal(late, 0)
    } finally {
      rmSync(big, { recursive: true, force: true })
    }
  })

  test('invalid regex: readable error', async () => {
    await assert.rejects(search({ pattern: '(', isRegExp: true }), (err: Error) => {
      const e = deserializeSearchError(err)
      assert.equal(e.code, SearchErrorCode.regexParseError)
      assert.equal(e.message, 'Regex parse error: missing closing parenthesis')
      return true
    })
  })

  test('missing rg binary: rgProcessError', async () => {
    const engine = new RipgrepTextSearchEngine(join(dir, 'no-such-rg.exe'))
    await assert.rejects(engine.provideTextSearchResults({ pattern: 'x' }, { folderOptions: [folderOptions(dir)], maxResults: 10 }, () => {}), (err: Error) => {
      assert.equal(deserializeSearchError(err).code, SearchErrorCode.rgProcessError)
      return true
    })
  })
})
