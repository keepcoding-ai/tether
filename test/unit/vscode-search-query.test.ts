// Tests for app/shared/vscode-search-query.ts. The cases come from VS Code's queryBuilder.test.ts
// (commit 9cc2376778e119f759ff710c1238fdc58d402d7a, src/vs/workbench/services/search/test/browser), adapted to string
// paths and to a configuration that is the same for every folder. Path-dependent cases run on both platforms.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QueryBuilder,
  createPathOps,
  escapeGlobPattern,
  type ISearchPathsInfo,
  type SearchConfig,
  type SearchFolder,
} from '../../app/shared/vscode-search-query.ts'
import { QueryType, type IExpression, type IPatternInfo } from '../../app/shared/vscode-search.ts'

const DEFAULT_CONFIG: SearchConfig = {
  exclude: {},
  useIgnoreFiles: true,
  useGlobalIgnoreFiles: true,
  useParentIgnoreFiles: true,
  followSymlinks: true,
  smartCase: false,
}

const PATTERN_INFO: IPatternInfo = { pattern: 'a' }

type Platform = 'win32' | 'posix'

function fixPath(platform: Platform, ...slashPathParts: string[]): string {
  const parts = [...slashPathParts]
  if (platform === 'win32' && parts.length && !/^c:/i.test(parts[0]!)) {
    parts.unshift('c:')
  }
  return createPathOps(platform).join(...parts)
}

function globalGlob(pattern: string): string[] {
  return [`**/${pattern}/**`, `**/${pattern}`]
}

function patternsToIExpression(...patterns: string[]): IExpression | undefined {
  return patterns.length ? patterns.reduce((glob, cur) => { glob[cur] = true; return glob }, {} as IExpression) : undefined
}

/** Drops undefined values and prototypes, so plain objects can be compared. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null))
}

interface ExpectedFolder {
  folder: string
  includePattern?: IExpression
  excludePattern?: IExpression[]
}

function assertFolders(actual: { folder: string; includePattern?: IExpression; excludePattern?: { pattern: IExpression }[] }[], expected: ExpectedFolder[]): void {
  assert.deepEqual(
    plain(actual.map(fq => ({ folder: fq.folder, includePattern: fq.includePattern, excludePattern: fq.excludePattern?.length ? fq.excludePattern.map(e => e.pattern) : undefined }))),
    plain(expected.map(fq => ({ folder: fq.folder, includePattern: fq.includePattern, excludePattern: fq.excludePattern }))),
  )
}

function assertSearchPaths(actual: ISearchPathsInfo, expected: { searchPaths?: { searchPath: string; pattern?: IExpression }[]; pattern?: IExpression }, message?: string): void {
  assert.deepEqual(plain(actual.pattern ?? {}), plain(expected.pattern ?? {}), message)
  assert.equal(actual.searchPaths?.length, expected.searchPaths?.length, message)
  actual.searchPaths?.forEach((searchPath, i) => {
    const expectedSearchPath = expected.searchPaths![i]!
    assert.deepEqual(plain(searchPath.pattern), plain(expectedSearchPath.pattern), message)
    assert.equal(searchPath.searchPath, expectedSearchPath.searchPath, message)
  })
}

function makeEnv(platform: Platform, folders: SearchFolder[], overrides: { config?: Partial<SearchConfig>; openEditors?: string[]; userHome?: string } = {}) {
  const config: SearchConfig = { ...DEFAULT_CONFIG, ...overrides.config }
  const builder = new QueryBuilder({
    folders: () => folders,
    config: () => config,
    openEditors: () => overrides.openEditors ?? [],
    platform,
    userHome: overrides.userHome,
  })
  return { builder, config, folders }
}

function folderOf(platform: Platform, slashPath: string, name?: string): SearchFolder {
  const path = fixPath(platform, slashPath)
  return { path, name: name ?? createPathOps(platform).basename(path) }
}

for (const platform of ['posix', 'win32'] as const) {
  describe(`QueryBuilder (${platform})`, () => {
    const fix = (...parts: string[]) => fixPath(platform, ...parts)
    const ROOT_1 = fix('/foo/root1')

    function single(overrides: Parameters<typeof makeEnv>[2] = {}) {
      return makeEnv(platform, [folderOf(platform, '/foo/root1')], overrides).builder
    }

    test('simple text pattern', () => {
      const query = single().text(PATTERN_INFO)
      assert.equal(query.type, QueryType.Text)
      assert.deepEqual(plain(query.contentPattern), PATTERN_INFO)
      assert.deepEqual(query.folderQueries, [])
    })

    test('normalize literal newlines', () => {
      const qb = single()
      assert.deepEqual(plain(qb.text({ pattern: 'foo\nbar', isRegExp: true }).contentPattern), { pattern: 'foo\\nbar', isRegExp: true, isMultiline: true })
      assert.deepEqual(plain(qb.text({ pattern: 'foo\r\nbar', isRegExp: true }).contentPattern), { pattern: 'foo\\nbar', isRegExp: true, isMultiline: true })
      assert.deepEqual(plain(qb.text({ pattern: 'foo\nbar', isRegExp: false }).contentPattern), { pattern: 'foo\nbar', isRegExp: false, isMultiline: true })
    })

    test('does not mutate the input pattern', () => {
      const input: IPatternInfo = { pattern: 'a\nb', isRegExp: true }
      single().text(input)
      assert.equal(input.pattern, 'a\nb')
      assert.equal(input.isMultiline, undefined)
    })

    test('multiline is detected in regex sources', () => {
      const qb = single()
      assert.equal(qb.text({ pattern: 'a\\nb', isRegExp: true }).contentPattern.isMultiline, true)
      assert.equal(qb.text({ pattern: 'a\\rb', isRegExp: true }).contentPattern.isMultiline, true)
      assert.equal(qb.text({ pattern: 'a\\Wb', isRegExp: true }).contentPattern.isMultiline, true)
      assert.equal(qb.text({ pattern: 'a\\wb', isRegExp: true }).contentPattern.isMultiline, undefined)
      assert.equal(qb.text({ pattern: 'a\\nb', isRegExp: false }).contentPattern.isMultiline, undefined)
      assert.equal(qb.text({ pattern: 'ab', isMultiline: true }).contentPattern.isMultiline, true)
    })

    test('text query keeps the other options', () => {
      const query = single().text(PATTERN_INFO, [ROOT_1], {
        maxResults: 5, maxFileSize: 100, surroundingContext: 2, previewOptions: { matchLines: 1, charsPerLine: 2 },
        ignoreGlobCase: true, disregardExcludeSettings: true, disregardIgnoreFiles: true,
      })
      assert.equal(query.maxResults, 5)
      assert.equal(query.maxFileSize, 100)
      assert.equal(query.surroundingContext, 2)
      assert.deepEqual(query.previewOptions, { matchLines: 1, charsPerLine: 2 })
      assert.equal(query.ignoreGlobCase, true)
      assert.equal(query.userDisabledExcludesAndIgnoreFiles, true)
      assert.equal(query.folderQueries[0]!.ignoreGlobCase, true)
    })

    test('splits include pattern when expandPatterns enabled', () => {
      const query = single().text(PATTERN_INFO, [ROOT_1], { includePattern: '**/foo, **/bar', expandPatterns: true })
      assertFolders(query.folderQueries, [{ folder: ROOT_1 }])
      assert.deepEqual(plain(query.includePattern), { '**/foo': true, '**/foo/**': true, '**/bar': true, '**/bar/**': true })
    })

    test('does not split include pattern when expandPatterns disabled', () => {
      const query = single().text(PATTERN_INFO, [ROOT_1], { includePattern: '**/foo, **/bar' })
      assert.deepEqual(plain(query.includePattern), { '**/foo, **/bar': true })
    })

    test('includePattern array', () => {
      const qb = single()
      assert.deepEqual(plain(qb.text(PATTERN_INFO, [ROOT_1], { includePattern: ['**/foo', '**/bar'] }).includePattern), { '**/foo': true, '**/bar': true })
      assert.deepEqual(
        plain(qb.text(PATTERN_INFO, [ROOT_1], { includePattern: ['**/foo', '**/bar'], expandPatterns: true }).includePattern),
        { '**/foo': true, '**/foo/**': true, '**/bar': true, '**/bar/**': true },
      )
    })

    test('folderResources', () => {
      const query = single().text(PATTERN_INFO, [ROOT_1])
      assertFolders(query.folderQueries, [{ folder: ROOT_1 }])
      assert.equal(query.folderQueries[0]!.folderName, undefined)
    })

    test('folder queries carry the ignore and symlink settings of the configuration', () => {
      const { builder } = makeEnv(platform, [], { config: { useIgnoreFiles: false, useGlobalIgnoreFiles: true, useParentIgnoreFiles: false, followSymlinks: false } })
      const fq = builder.text(PATTERN_INFO, [ROOT_1]).folderQueries[0]!
      assert.equal(fq.disregardIgnoreFiles, true)
      assert.equal(fq.disregardGlobalIgnoreFiles, false)
      assert.equal(fq.disregardParentIgnoreFiles, true)
      assert.equal(fq.ignoreSymlinks, true)
      const overridden = builder.text(PATTERN_INFO, [ROOT_1], { disregardIgnoreFiles: false, ignoreSymlinks: false, fileEncoding: 'latin1' }).folderQueries[0]!
      assert.equal(overridden.disregardIgnoreFiles, false)
      assert.equal(overridden.ignoreSymlinks, false)
      assert.equal(overridden.fileEncoding, 'latin1')
    })

    test('simple exclude setting', () => {
      const exclude: IExpression = { 'bar/**': true, 'foo/**': { when: '$(basename).ts' } }
      const qb = single({ config: { exclude } })
      const query = qb.text(PATTERN_INFO, [ROOT_1], { expandPatterns: true }) // expandPatterns does not affect patterns from configuration
      assertFolders(query.folderQueries, [{ folder: ROOT_1, excludePattern: [exclude] }])
    })

    test('disregardExcludeSettings drops the configured excludes', () => {
      const qb = single({ config: { exclude: { 'bar/**': true } } })
      const query = qb.text(PATTERN_INFO, [ROOT_1], { disregardExcludeSettings: true })
      assertFolders(query.folderQueries, [{ folder: ROOT_1 }])
    })

    test('disregardSearchExcludeSettings keeps only files.exclude when it is known', () => {
      const qb = single({ config: { exclude: { 'a': true, 'b': true }, filesExclude: { 'a': true } } })
      assertFolders(qb.text(PATTERN_INFO, [ROOT_1], { disregardSearchExcludeSettings: true }).folderQueries, [{ folder: ROOT_1, excludePattern: [{ a: true }] }])
      assertFolders(qb.text(PATTERN_INFO, [ROOT_1]).folderQueries, [{ folder: ROOT_1, excludePattern: [{ a: true, b: true }] }])
    })

    test('keeps exclude exceptions from settings and escapes a leading ! in other exclude patterns', () => {
      const exclude: IExpression = { 'node_modules': true, '!node_modules/@types': true }
      const query = single({ config: { exclude } }).text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern: ['!literal', 'other'] }] })
      assertFolders(query.folderQueries, [{ folder: ROOT_1, excludePattern: [exclude] }])
      assert.deepEqual(plain(query.excludePattern), { '{!}literal': true, 'other': true })
    })

    test('simple include', () => {
      const qb = single()
      const expanded = qb.text(PATTERN_INFO, [ROOT_1], { includePattern: 'bar', expandPatterns: true })
      assertFolders(expanded.folderQueries, [{ folder: ROOT_1 }])
      assert.deepEqual(plain(expanded.includePattern), { '**/bar': true, '**/bar/**': true })

      const plainInclude = qb.text(PATTERN_INFO, [ROOT_1], { includePattern: 'bar' })
      assertFolders(plainInclude.folderQueries, [{ folder: ROOT_1 }])
      assert.deepEqual(plain(plainInclude.includePattern), { bar: true })
    })

    test('simple include with ./ syntax', () => {
      for (const includePattern of ['./bar', '.\\bar']) {
        const query = single().text(PATTERN_INFO, [ROOT_1], { includePattern, expandPatterns: true })
        assertFolders(query.folderQueries, [{ folder: ROOT_1, includePattern: { bar: true, 'bar/**': true } }])
        assert.equal(query.includePattern, undefined)
        assert.equal(query.usingSearchPaths, true)
      }
    })

    test('exclude setting and searchPath', () => {
      const exclude: IExpression = { 'foo/**/*.js': true, 'bar/**': { when: '$(basename).ts' } }
      const query = single({ config: { exclude } }).text(PATTERN_INFO, [ROOT_1], { includePattern: './foo', expandPatterns: true })
      assertFolders(query.folderQueries, [{ folder: ROOT_1, includePattern: { foo: true, 'foo/**': true }, excludePattern: [exclude] }])
    })

    test('multiroot exclude settings', () => {
      const ROOT_2 = fix('/project/root2')
      const ROOT_3 = fix('/project/root3')
      const folders = [folderOf(platform, '/foo/root1'), folderOf(platform, '/project/root2'), folderOf(platform, '/project/root3')]
      const exclude: IExpression = { 'foo/**/*.js': true }
      const { builder } = makeEnv(platform, folders, { config: { exclude } })

      const all = builder.text(PATTERN_INFO, [ROOT_1, ROOT_2, ROOT_3])
      assertFolders(all.folderQueries, [
        { folder: ROOT_1, excludePattern: [exclude] },
        { folder: ROOT_2, excludePattern: [exclude] },
        { folder: ROOT_3, excludePattern: [exclude] },
      ])
      assert.deepEqual(all.folderQueries.map(fq => fq.folderName), ['root1', 'root2', 'root3'])

      // the root excludes are merged when an include selects one root
      const one = builder.text(PATTERN_INFO, [ROOT_1, ROOT_2, ROOT_3], { includePattern: './root2/src', expandPatterns: true })
      assertFolders(one.folderQueries, [{ folder: ROOT_2, includePattern: { src: true, 'src/**': true }, excludePattern: [exclude] }])
      assert.equal(one.folderQueries[0]!.folderName, undefined)
    })

    test('simple exclude input pattern', () => {
      const query = single().text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern: 'foo' }], expandPatterns: true })
      assertFolders(query.folderQueries, [{ folder: ROOT_1 }])
      assert.deepEqual(plain(query.excludePattern), plain(patternsToIExpression(...globalGlob('foo'))))
    })

    test('exclude ./ syntax', () => {
      const cases: [string, string[]][] = [
        ['./!old', ['{!}old', '{!}old/**']],
        ['./bar', ['bar', 'bar/**']],
        ['./bar/**/*.ts', ['bar/**/*.ts', 'bar/**/*.ts/**']],
        ['.\\bar\\**\\*.ts', ['bar/**/*.ts', 'bar/**/*.ts/**']],
      ]
      for (const [pattern, expected] of cases) {
        const query = single().text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern }], expandPatterns: true })
        assertFolders(query.folderQueries, [{ folder: ROOT_1, excludePattern: [patternsToIExpression(...expected)!] }])
      }
    })

    test('a root excluded as a whole yields no folder query', () => {
      for (const pattern of ['./', ROOT_1]) {
        const query = single().text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern }], expandPatterns: true })
        assert.deepEqual(query.folderQueries, [], pattern)
      }
      // the parent folder is a different folder
      const parent = single().text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern: '..' }], expandPatterns: true })
      assertFolders(parent.folderQueries, [{ folder: ROOT_1 }])
    })

    test('an exclude folder root is kept on the folder exclude entry', () => {
      const root = fix('/elsewhere')
      const { builder } = makeEnv(platform, [], { config: { exclude: { z: true } } })
      const query = builder.text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ folder: root, pattern: 'x' }] })
      assert.deepEqual(query.folderQueries[0]!.excludePattern, [{ folder: root, pattern: { z: true } }])
      assert.deepEqual(plain(query.excludePattern), { x: true })
    })

    describe('parseSearchPaths', () => {
      function parseIncludes(qb: QueryBuilder, includePattern: string): ISearchPathsInfo {
        try {
          return qb.parseSearchPaths(includePattern)
        } catch {
          return { searchPaths: [] }
        }
      }

      test('simple includes', () => {
        const cases: [string, string[]][] = [
          ['a', ['**/a/**', '**/a']],
          ['a/b', ['**/a/b', '**/a/b/**']],
          ['a/b,  c', ['**/a/b', '**/c', '**/a/b/**', '**/c/**']],
          ['a,.txt', ['**/a', '**/a/**', '**/*.txt', '**/*.txt/**']],
          ['a,,,b', ['**/a', '**/a/**', '**/b', '**/b/**']],
          ['**/a,b/**', ['**/a', '**/a/**', '**/b/**']],
        ]
        for (const [includePattern, expectedPatterns] of cases) {
          const result = single().parseSearchPaths(includePattern)
          assert.deepEqual(plain(result.pattern), plain(patternsToIExpression(...expectedPatterns)), includePattern)
          assert.equal(result.searchPaths, undefined)
        }
      })

      test('braces are not split on their commas', () => {
        const result = single().parseSearchPaths('{a,b}/c, d')
        assert.deepEqual(plain(result.pattern), { '**/{a,b}/c': true, '**/{a,b}/c/**': true, '**/d': true, '**/d/**': true })
        assert.deepEqual(single().parseSearchPaths(['x,y']).pattern && Object.keys(single().parseSearchPaths(['x,y']).pattern!), ['**/x,y/**', '**/x,y'])
      })

      test('absolute includes', () => {
        const cases: [string, { searchPaths: { searchPath: string; pattern?: IExpression }[]; pattern?: IExpression }][] = [
          [fix('/foo/bar'), { searchPaths: [{ searchPath: fix('/foo/bar') }] }],
          [fix('/foo/bar') + ',' + 'a', { searchPaths: [{ searchPath: fix('/foo/bar') }], pattern: patternsToIExpression(...globalGlob('a')) }],
          [fix('/foo/bar') + ',' + fix('/1/2'), { searchPaths: [{ searchPath: fix('/foo/bar') }, { searchPath: fix('/1/2') }] }],
          [fix('/foo/bar') + ',' + fix('/foo/../foo/bar/fooar/..'), { searchPaths: [{ searchPath: fix('/foo/bar') }] }],
          [fix('/foo/bar/**/*.ts'), { searchPaths: [{ searchPath: fix('/foo/bar'), pattern: patternsToIExpression('**/*.ts', '**/*.ts/**') }] }],
          [fix('/foo/bar/*a/b/c'), { searchPaths: [{ searchPath: fix('/foo/bar'), pattern: patternsToIExpression('*a/b/c', '*a/b/c/**') }] }],
          [fix('/*a/b/c'), { searchPaths: [{ searchPath: fix('/'), pattern: patternsToIExpression('*a/b/c', '*a/b/c/**') }] }],
          [fix('/foo/{b,c}ar'), { searchPaths: [{ searchPath: fix('/foo'), pattern: patternsToIExpression('{b,c}ar', '{b,c}ar/**') }] }],
        ]
        for (const [includePattern, expected] of cases) {
          assertSearchPaths(parseIncludes(single(), includePattern), expected, includePattern)
        }
      })

      test('relative includes w/single root folder', () => {
        const cases: [string, { searchPaths: { searchPath: string; pattern?: IExpression }[] }][] = [
          ['./a', { searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('a', 'a/**') }] }],
          ['./a/', { searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('a', 'a/**') }] }],
          ['./a/*b/c', { searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('a/*b/c', 'a/*b/c/**') }] }],
          ['./a/*b/c, ' + fix('/project/foo'), { searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('a/*b/c', 'a/*b/c/**') }, { searchPath: fix('/project/foo') }] }],
          ['./a/b/,./c/d', { searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('a/b', 'a/b/**', 'c/d', 'c/d/**') }] }],
          ['../', { searchPaths: [{ searchPath: fix('/foo') }] }],
          ['..', { searchPaths: [{ searchPath: fix('/foo') }] }],
          ['..\\bar', { searchPaths: [{ searchPath: fix('/foo/bar') }] }],
        ]
        for (const [includePattern, expected] of cases) {
          assertSearchPaths(parseIncludes(single(), includePattern), expected, includePattern)
        }
      })

      test('relative includes w/two root folders', () => {
        const qb = makeEnv(platform, [folderOf(platform, '/foo/root1'), folderOf(platform, '/project/root2')]).builder
        const ROOT_2 = fix('/project/root2')
        const cases: [string, { searchPaths: { searchPath: string; pattern?: IExpression }[] }][] = [
          ['./root1', { searchPaths: [{ searchPath: ROOT_1 }] }],
          ['./root2', { searchPaths: [{ searchPath: ROOT_2 }] }],
          ['./root1/a/**/b, ./root2/**/*.txt', {
            searchPaths: [
              { searchPath: ROOT_1, pattern: patternsToIExpression('a/**/b', 'a/**/b/**') },
              { searchPath: ROOT_2, pattern: patternsToIExpression('**/*.txt', '**/*.txt/**') },
            ],
          }],
        ]
        for (const [includePattern, expected] of cases) {
          assertSearchPaths(parseIncludes(qb, includePattern), expected, includePattern)
        }
      })

      test('include ./foldername', () => {
        const qb = makeEnv(platform, [folderOf(platform, '/foo/root1', 'foldername'), folderOf(platform, '/project/root2')]).builder
        assertSearchPaths(parseIncludes(qb, './foldername'), { searchPaths: [{ searchPath: ROOT_1 }] })
        assertSearchPaths(parseIncludes(qb, './foldername/foo'), { searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('foo', 'foo/**') }] })
        // the folder name wins over the directory name
        assertSearchPaths(parseIncludes(qb, './root1'), { searchPaths: [] })
      })

      test('folder with slash in the name', () => {
        const ROOT_2 = fix('/project/root2')
        const qb = makeEnv(platform, [folderOf(platform, '/foo/root1', 'folder/one'), folderOf(platform, '/project/root2', 'folder/two+')]).builder
        const cases: [string, { searchPaths: { searchPath: string; pattern?: IExpression }[] }][] = [
          ['./folder/one', { searchPaths: [{ searchPath: ROOT_1 }] }],
          ['./folder/two+/foo/', { searchPaths: [{ searchPath: ROOT_2, pattern: patternsToIExpression('foo', 'foo/**') }] }],
          ['./folder/onesomethingelse', { searchPaths: [] }],
          ['./folder/onesomethingelse/foo', { searchPaths: [] }],
          ['./folder', { searchPaths: [] }],
        ]
        for (const [includePattern, expected] of cases) {
          assertSearchPaths(parseIncludes(qb, includePattern), expected, includePattern)
        }
      })

      test('relative includes w/multiple ambiguous root folders', () => {
        const ROOT_2 = fix('/project/rootB')
        const ROOT_3 = fix('/otherproject/rootB')
        const qb = makeEnv(platform, [folderOf(platform, '/foo/root1'), folderOf(platform, '/project/rootB'), folderOf(platform, '/otherproject/rootB')]).builder
        const cases: [string, { searchPaths?: { searchPath: string; pattern?: IExpression }[]; pattern?: IExpression }][] = [
          ['', { searchPaths: undefined }],
          ['./', { searchPaths: undefined }],
          ['./root1', { searchPaths: [{ searchPath: ROOT_1 }] }],
          ['./root1,./', { searchPaths: [{ searchPath: ROOT_1 }] }],
          ['./rootB', { searchPaths: [{ searchPath: ROOT_2 }, { searchPath: ROOT_3 }] }],
          ['./rootB/a/**/b, ./rootB/b/**/*.txt', {
            searchPaths: [
              { searchPath: ROOT_2, pattern: patternsToIExpression('a/**/b', 'a/**/b/**', 'b/**/*.txt', 'b/**/*.txt/**') },
              { searchPath: ROOT_3, pattern: patternsToIExpression('a/**/b', 'a/**/b/**', 'b/**/*.txt', 'b/**/*.txt/**') },
            ],
          }],
          ['./root1/**/foo/, bar/', {
            pattern: patternsToIExpression('**/bar', '**/bar/**'),
            searchPaths: [{ searchPath: ROOT_1, pattern: patternsToIExpression('**/foo', '**/foo/**') }],
          }],
        ]
        for (const [includePattern, expected] of cases) {
          assertSearchPaths(parseIncludes(qb, includePattern), expected, includePattern)
        }
      })

      test('the missing folder error names the folder', () => {
        const qb = makeEnv(platform, [folderOf(platform, '/foo/root1'), folderOf(platform, '/project/root2')]).builder
        assert.throws(() => qb.parseSearchPaths('./nope/x'), /nope\/x/)
      })

      test('includes with tilde', () => {
        const userHome = platform === 'win32' ? 'c:\\home' : '/'
        const qb = makeEnv(platform, [folderOf(platform, '/foo/root1')], { userHome }).builder
        const home = (rest: string) => createPathOps(platform).join(userHome, rest)
        const cases: [string, { searchPaths: { searchPath: string; pattern?: IExpression }[]; pattern?: IExpression }][] = [
          ['~/foo/bar', { searchPaths: [{ searchPath: home('/foo/bar') }] }],
          ['~/foo/bar, a', { searchPaths: [{ searchPath: home('/foo/bar') }], pattern: patternsToIExpression(...globalGlob('a')) }],
          [fix('/foo/~/bar'), { searchPaths: [{ searchPath: fix('/foo/~/bar') }] }],
        ]
        for (const [includePattern, expected] of cases) {
          assertSearchPaths(qb.parseSearchPaths(includePattern), expected, includePattern)
        }
        // without a home directory, ~ stays a plain glob segment
        assert.equal(single().parseSearchPaths('~/foo').searchPaths, undefined)
      })
    })

    describe('smartCase', () => {
      const text = (pattern: IPatternInfo, options = {}) => single().text(pattern, [], options).contentPattern

      test('no flags -> no change', () => {
        assert(!text({ pattern: 'a' }).isCaseSensitive)
      })
      test('maintains isCaseSensitive when smartCase not set', () => {
        assert(text({ pattern: 'a', isCaseSensitive: true }).isCaseSensitive)
      })
      test('maintains isCaseSensitive when smartCase set', () => {
        assert(text({ pattern: 'a', isCaseSensitive: true }, { isSmartCase: true }).isCaseSensitive)
      })
      test('smartCase determines not case sensitive', () => {
        assert(!text({ pattern: 'abcd' }, { isSmartCase: true }).isCaseSensitive)
      })
      test('smartCase determines case sensitive', () => {
        assert(text({ pattern: 'abCd' }, { isSmartCase: true }).isCaseSensitive)
      })
      test('smartCase determines not case sensitive (regex)', () => {
        assert(!text({ pattern: 'ab\\Sd', isRegExp: true }, { isSmartCase: true }).isCaseSensitive)
      })
      test('smartCase determines case sensitive (regex)', () => {
        assert(text({ pattern: 'ab[A-Z]d', isRegExp: true }, { isSmartCase: true }).isCaseSensitive)
      })
      test('config.smartCase applies when the option is absent, the option wins when present', () => {
        const { builder } = makeEnv(platform, [], { config: { smartCase: true } })
        assert(builder.text({ pattern: 'aB' }).contentPattern.isCaseSensitive)
        assert(!builder.text({ pattern: 'aB' }, [], { isSmartCase: false }).contentPattern.isCaseSensitive)
      })
    })

    describe('pattern processing', () => {
      const expanded = { '**/*.js/**': true, '**/*.js': true, '**/*.ts/**': true, '**/*.ts': true }

      test('text query with comma-separated includes with no workspace', () => {
        const query = single().text({ pattern: '' }, [], { includePattern: '*.js,*.ts', expandPatterns: true })
        assert.deepEqual(plain(query.includePattern), expanded)
        assert.equal(query.folderQueries.length, 0)
      })
      test('text query with comma-separated includes with workspace', () => {
        const query = single().text({ pattern: '' }, [ROOT_1], { includePattern: '*.js,*.ts', expandPatterns: true })
        assert.deepEqual(plain(query.includePattern), expanded)
        assert.equal(query.folderQueries.length, 1)
      })
      test('text query with comma-separated excludes globally', () => {
        const query = single().text({ pattern: '' }, [], { excludePattern: [{ pattern: '*.js,*.ts' }], expandPatterns: true })
        assert.deepEqual(plain(query.excludePattern), expanded)
        assert.equal(query.folderQueries.length, 0)
      })
      test('text query with comma-separated excludes globally in a workspace', () => {
        const query = single().text({ pattern: '' }, [ROOT_1], { excludePattern: [{ pattern: '*.js,*.ts' }], expandPatterns: true })
        assert.deepEqual(plain(query.excludePattern), expanded)
        assert.equal(query.folderQueries.length, 1)
      })
    })

    describe('onlyOpenEditors', () => {
      const SRC = fix('/foo/root1/src/a.ts')
      const JS = fix('/foo/root1/b.js')
      const OUTSIDE = fix('/other/dir/c.ts')

      test('searches the open files, each in its folder', () => {
        const qb = single({ openEditors: [SRC, JS, OUTSIDE] })
        const query = qb.text(PATTERN_INFO, [ROOT_1], { onlyOpenEditors: true })
        assertFolders(query.folderQueries, [
          { folder: ROOT_1, includePattern: { 'src/a.ts': true, 'b.js': true } },
          { folder: fix('/other/dir'), includePattern: { 'c.ts': true } },
        ])
        assert.equal(query.onlyOpenEditors, true)
        assert.equal(query.usingSearchPaths, true)
        assert.equal(query.excludePattern, undefined)
        assert.deepEqual(plain(query.includePattern), {})
      })

      test('respects the exclude and include fields', () => {
        const qb = single({ openEditors: [SRC, JS, OUTSIDE] })
        const excluded = qb.text(PATTERN_INFO, [ROOT_1], { onlyOpenEditors: true, excludePattern: [{ pattern: '*.js' }], expandPatterns: true })
        assertFolders(excluded.folderQueries, [
          { folder: ROOT_1, includePattern: { 'src/a.ts': true } },
          { folder: fix('/other/dir'), includePattern: { 'c.ts': true } },
        ])
        const included = qb.text(PATTERN_INFO, [ROOT_1], { onlyOpenEditors: true, includePattern: './src', expandPatterns: true })
        assertFolders(included.folderQueries, [{ folder: ROOT_1, includePattern: { 'src/a.ts': true } }])
      })

      test('nothing open excludes everything', () => {
        const query = single().text(PATTERN_INFO, [ROOT_1], { onlyOpenEditors: true })
        assert.deepEqual(query.folderQueries, [])
        assert.deepEqual(plain(query.excludePattern), { '**/*': true })
      })

      test('glob characters of the file name are escaped', () => {
        const qb = single({ openEditors: [fix('/foo/root1/a[1]*.ts')] })
        const query = qb.text(PATTERN_INFO, [ROOT_1], { onlyOpenEditors: true })
        assertFolders(query.folderQueries, [{ folder: ROOT_1, includePattern: { 'a[[]1[]][*].ts': true } }])
      })

      test('a folder name is matched ignoring case only on win32', () => {
        const upper = createPathOps(platform).join(ROOT_1, 'x.ts').toUpperCase()
        const query = single({ openEditors: [upper] }).text(PATTERN_INFO, [ROOT_1], { onlyOpenEditors: true })
        if (platform === 'win32') {
          assertFolders(query.folderQueries, [{ folder: ROOT_1, includePattern: { 'X.TS': true } }])
        } else {
          assertFolders(query.folderQueries, [{ folder: createPathOps(platform).dirname(upper), includePattern: { 'X.TS': true } }])
        }
      })
    })

    describe('pathIncludedInQuery (from outside, on a built query)', () => {
      const SRC = fix('/foo/root1/src/a.ts')
      const JS = fix('/foo/root1/b.js')
      const OUTSIDE = fix('/other/dir/c.ts')

      test('no include or exclude: every path is in', () => {
        const qb = single()
        const query = qb.text(PATTERN_INFO, [ROOT_1])
        for (const p of [SRC, JS, OUTSIDE]) assert.equal(qb.pathIncludedInQuery(query, p), true, p)
      })

      test('the exclude field takes a path out', () => {
        const qb = single()
        const query = qb.text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern: '*.js' }], expandPatterns: true })
        assert.equal(qb.pathIncludedInQuery(query, JS), false)
        assert.equal(qb.pathIncludedInQuery(query, SRC), true)
      })

      test('an include glob keeps only what it matches', () => {
        const qb = single()
        const query = qb.text(PATTERN_INFO, [ROOT_1], { includePattern: '*.ts', expandPatterns: true })
        assert.equal(qb.pathIncludedInQuery(query, SRC), true)
        assert.equal(qb.pathIncludedInQuery(query, JS), false)
      })

      test('globs are tested relative to the searched folder, not on the absolute path', () => {
        const qb = single()
        const root = fix('/work/.tmp/wt/x')
        const query = qb.text(PATTERN_INFO, [root], { excludePattern: [{ pattern: '*.tmp' }], expandPatterns: true })
        assert.equal(qb.pathIncludedInQuery(query, fix('/work/.tmp/wt/x/a.txt')), true)
        assert.equal(qb.pathIncludedInQuery(query, fix('/work/.tmp/wt/x/sub/a.txt')), true)
        assert.equal(qb.pathIncludedInQuery(query, fix('/work/.tmp/wt/x/a.txt.1.tmp')), false)
        assert.equal(qb.pathIncludedInQuery(query, fix('/work/.tmp/wt/x/cache.tmp/a.txt')), false)
        // outside every folder of the query the absolute path is what the globs see (a .tmp segment above excludes)
        assert.equal(qb.pathIncludedInQuery(query, fix('/other/.tmp/a.txt')), false)
        assert.equal(qb.pathIncludedInQuery(query, fix('/other/z.tmp')), false)
      })

      test('a relative folder exclusion (./sub) takes the files inside it out, like the bare name does', () => {
        const qb = single()
        const inSub = fix('/foo/root1/sub/d.txt')
        const other = fix('/foo/root1/keep/d.txt')
        for (const pattern of ['./sub', 'sub']) {
          const query = qb.text(PATTERN_INFO, [ROOT_1], { excludePattern: [{ pattern }], expandPatterns: true })
          assert.equal(qb.pathIncludedInQuery(query, inSub), false, pattern)
          assert.equal(qb.pathIncludedInQuery(query, other), true, pattern)
        }
      })

      test('a folder exclusion with its own folder is relative to that folder', () => {
        const qb = single()
        const query = {
          folderQueries: [{ folder: ROOT_1, excludePattern: [{ folder: fix('/foo/root1/src'), pattern: { 'gen/**': true } }] }],
        }
        assert.equal(qb.pathIncludedInQuery(query, fix('/foo/root1/src/gen/x.ts')), false)
        assert.equal(qb.pathIncludedInQuery(query, fix('/foo/root1/src/x.ts')), true)
        assert.equal(qb.pathIncludedInQuery(query, fix('/foo/root1/gen/x.ts')), true)
      })

      test('a folder include keeps only what it matches', () => {
        const qb = single()
        const query = { folderQueries: [{ folder: ROOT_1, includePattern: { '**/*.ts': true } }] }
        assert.equal(qb.pathIncludedInQuery(query, SRC), true)
        assert.equal(qb.pathIncludedInQuery(query, JS), false)
      })

      test('a search path keeps only the files under it', () => {
        const qb = single()
        const query = qb.text(PATTERN_INFO, [ROOT_1], { includePattern: './src', expandPatterns: true })
        assert.equal(query.usingSearchPaths, true)
        assert.equal(qb.pathIncludedInQuery(query, SRC), true)
        assert.equal(qb.pathIncludedInQuery(query, JS), false)
        assert.equal(qb.pathIncludedInQuery(query, OUTSIDE), false)
      })
    })

    describe('changedFiles', () => {
      test('searches only the changed files', () => {
        const query = single().text(PATTERN_INFO, [ROOT_1], { changedFiles: [fix('/foo/root1/a.ts'), fix('/foo/root1/sub/b.ts')] })
        assertFolders(query.folderQueries, [{ folder: ROOT_1, includePattern: { 'a.ts': true, 'sub/b.ts': true } }])
        assert.equal(query.usingSearchPaths, true)
      })

      test('an empty list excludes everything', () => {
        const query = single().text(PATTERN_INFO, [ROOT_1], { changedFiles: [] })
        assert.deepEqual(query.folderQueries, [])
        assert.deepEqual(plain(query.excludePattern), { '**/*': true })
      })

      test('files outside the search paths are dropped', () => {
        const query = single().text(PATTERN_INFO, [ROOT_1], {
          changedFiles: [fix('/foo/root1/src/a.ts'), fix('/foo/root1/lib/b.ts')],
          includePattern: './src',
          expandPatterns: true,
        })
        assertFolders(query.folderQueries, [{ folder: ROOT_1, includePattern: { 'src/a.ts': true } }])
      })
    })
  })
}

describe('createPathOps', () => {
  test('posix', () => {
    const p = createPathOps('posix')
    assert.equal(p.normalize('/a//b/./c/../d/'), '/a/b/d')
    assert.equal(p.normalize('a/../..'), '..')
    assert.equal(p.normalize('/..'), '/')
    assert.equal(p.normalize(''), '.')
    assert.equal(p.join('/a', 'b', '../c'), '/a/c')
    assert.equal(p.dirname('/a/b'), '/a')
    assert.equal(p.dirname('/a'), '/')
    assert.equal(p.basename('/a/b.ts'), 'b.ts')
    assert.equal(p.relative('/a/b', '/a/c/d'), '../c/d')
    assert.equal(p.relative('/a', '/a'), '')
    assert.equal(p.isAbsolute('/a'), true)
    assert.equal(p.isAbsolute('c:\\a'), false)
    assert.equal(p.isAbsolute('./a'), false)
    assert.equal(p.isEqual('/a/B', '/a/b'), false)
    assert.equal(p.isEqualOrParent('/a/b/c', '/a/b'), true)
    assert.equal(p.isEqualOrParent('/a/bc', '/a/b'), false)
    assert.equal(p.isEqualOrParent('/a/B/c', '/a/b', true), true)
  })

  test('win32', () => {
    const p = createPathOps('win32')
    assert.equal(p.normalize('c:/a//b/./c/../d/'), 'c:\\a\\b\\d')
    assert.equal(p.normalize('c:\\..'), 'c:\\')
    assert.equal(p.normalize('c:/'), 'c:\\')
    assert.equal(p.normalize('\\\\server\\share\\x\\..\\y'), '\\\\server\\share\\y')
    assert.equal(p.join('c:', '/foo', 'bar'), 'c:\\foo\\bar')
    assert.equal(p.dirname('c:\\a\\b'), 'c:\\a')
    assert.equal(p.dirname('c:\\a'), 'c:\\')
    assert.equal(p.basename('c:\\a\\b.ts'), 'b.ts')
    assert.equal(p.relative('c:\\a\\b', 'c:\\A\\c\\d'), '..\\c\\d')
    assert.equal(p.relative('c:\\a', 'd:\\x'), 'd:\\x')
    assert.equal(p.isAbsolute('c:\\a'), true)
    assert.equal(p.isAbsolute('c:/a'), true)
    assert.equal(p.isAbsolute('\\a'), true)
    assert.equal(p.isAbsolute('c:a'), false)
    assert.equal(p.isAbsolute('.\\a'), false)
    assert.equal(p.isEqual('C:\\A\\b', 'c:/a/B/'), true)
    assert.equal(p.isEqualOrParent('C:\\A\\b\\c', 'c:\\a\\B'), true)
    assert.equal(p.isEqualOrParent('d:\\a\\b', 'c:\\a'), false)
  })
})

describe('escapeGlobPattern', () => {
  test('escapes ? * [ ]', () => {
    assert.equal(escapeGlobPattern('a?b*c[d]'), 'a[?]b[*]c[[]d[]]')
    assert.equal(escapeGlobPattern('plain/path.ts'), 'plain/path.ts')
  })
})
