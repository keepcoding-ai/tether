/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of the types and pure helpers of VS Code's text search ("Search in files"), shared by the main process (the
// ripgrep engine and the search manager) and the renderer (which shows the results).
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/services/search/common/search.ts
//       IPatternInfo, IFolderQuery, ITextQuery (cut), IFileMatch, ITextSearchMatch, ITextSearchContext, ISearchRange,
//       ITextSearchPreviewOptions, resultIsMatch, ISearchCompleteStats, ISearchComplete, SearchCompletionExitCode,
//       TextSearchMatch, SearchRange, OneLineRange, SearchErrorCode, SearchError, (de)serializeSearchError,
//       resolvePatternsForProvider, resolveExcludePatternsForProvider, QueryGlobTester (sync, without siblings),
//       DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS
//   src/vs/workbench/services/search/common/searchExtTypes.ts   TextSearchCompleteMessageType
//   src/vs/base/common/glob.ts       splitGlobAware, parse (regex path only), isExcludeException, withoutExcludeExceptions
//   src/vs/base/common/strings.ts    escapeRegExpCharacters, createRegExp, getNLines
// Changes, only what this project needs:
//   - a URI is an absolute path string (the platform's separator); `uri`/`resource` hold that path;
//   - `const enum`s are `as const` objects (erasable syntax only), with a type of the same name for their values;
//   - glob.parse keeps only the regex path (toRegExp/parseRegExp). The "trivia" fast paths, the LRU cache and the
//     relative-pattern wrapper are dropped: the fast paths are optimizations that match the same paths;
//   - sibling clauses (`{ when: "$(basename).ext" }`) are accepted in the expression type but never match: they need a
//     readdir per result folder, which this port does not do;
//   - `!`-prefixed exclude exceptions are dropped from the excludes (as the origin does for providers that do not
//     support them) and are not honored: the extra ripgrep run that re-includes them is not ported;
//   - notebook, AI search, file search, telemetry and configuration types are not ported.

// ---------- strings.ts ----------

export function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]/g, '\\$&')
}

export interface RegExpOptions {
  matchCase?: boolean
  wholeWord?: boolean
  multiline?: boolean
  global?: boolean
  unicode?: boolean
}

export function createRegExp(searchString: string, isRegex: boolean, options: RegExpOptions = {}): RegExp {
  if (!searchString) {
    throw new Error('Cannot create regex from empty string')
  }
  if (!isRegex) {
    searchString = escapeRegExpCharacters(searchString)
  }
  if (options.wholeWord) {
    if (!/\B/.test(searchString.charAt(0))) {
      searchString = '\\b' + searchString
    }
    if (!/\B/.test(searchString.charAt(searchString.length - 1))) {
      searchString = searchString + '\\b'
    }
  }
  let modifiers = ''
  if (options.global) modifiers += 'g'
  if (!options.matchCase) modifiers += 'i'
  if (options.multiline) modifiers += 'm'
  if (options.unicode) modifiers += 'u'
  return new RegExp(searchString, modifiers)
}

/** The first `n` lines of `str`, without the line break (nor a `\r` before it) that ends the last one. */
export function getNLines(str: string, n = 1): string {
  if (n === 0) {
    return ''
  }
  let idx = -1
  do {
    idx = str.indexOf('\n', idx + 1)
    n--
  } while (n > 0 && idx >= 0)
  if (idx === -1) {
    return str
  }
  if (str[idx - 1] === '\r') {
    idx--
  }
  return str.substr(0, idx)
}

// ---------- glob.ts ----------

interface SiblingClause {
  when: string
}

export interface IExpression {
  [pattern: string]: boolean | SiblingClause
}

export interface IGlobOptions {
  /** Whether glob pattern matching should be case insensitive. */
  ignoreCase?: boolean
}

export const GLOBSTAR = '**'
export const GLOB_SPLIT = '/'

const PATH_REGEX = '[/\\\\]' // any slash or backslash
const NO_PATH_REGEX = '[^/\\\\]' // any non-slash and non-backslash

function starsToRegExp(starCount: number, isLastPattern?: boolean): string {
  switch (starCount) {
    case 0:
      return ''
    case 1:
      return `${NO_PATH_REGEX}*?` // 1 star matches any number of characters except path separator (/ and \) - non greedy (?)
    default:
      // Matches: (Path Sep OR Path Val followed by Path Sep) 0-many times except when it's the last pattern,
      // in which case also matches (Path Sep followed by Path Val). Non-greedy: it could match too much.
      return `(?:${PATH_REGEX}|${NO_PATH_REGEX}+${PATH_REGEX}${isLastPattern ? `|${PATH_REGEX}${NO_PATH_REGEX}+` : ''})*?`
  }
}

/** Splits on `splitChar`, except inside `{...}` and `[...]`. */
export function splitGlobAware(pattern: string, splitChar: string): string[] {
  if (!pattern) {
    return []
  }
  const segments: string[] = []
  let inBraces = false
  let inBrackets = false
  let curVal = ''
  for (const char of pattern) {
    switch (char) {
      case splitChar:
        if (!inBraces && !inBrackets) {
          segments.push(curVal)
          curVal = ''
          continue
        }
        break
      case '{':
        inBraces = true
        break
      case '}':
        inBraces = false
        break
      case '[':
        inBrackets = true
        break
      case ']':
        inBrackets = false
        break
    }
    curVal += char
  }
  if (curVal) {
    segments.push(curVal)
  }
  return segments
}

function parseRegExp(pattern: string): string {
  if (!pattern) {
    return ''
  }
  let regEx = ''
  const segments = splitGlobAware(pattern, GLOB_SPLIT)

  // Special case where we only have globstars
  if (segments.every(segment => segment === GLOBSTAR)) {
    regEx = '.*'
  } else {
    let previousSegmentWasGlobStar = false
    segments.forEach((segment, index) => {
      if (segment === GLOBSTAR) {
        // more than one globstar after another is the same as one
        if (previousSegmentWasGlobStar) {
          return
        }
        regEx += starsToRegExp(2, index === segments.length - 1)
      } else {
        let inBraces = false
        let braceVal = ''
        let inBrackets = false
        let bracketVal = ''
        for (const char of segment) {
          // brace expansion
          if (char !== '}' && inBraces) {
            braceVal += char
            continue
          }
          // brackets: ] is literal only as the first character inside them
          if (inBrackets && (char !== ']' || !bracketVal)) {
            let res: string
            if (char === '-') {
              res = char // range operator
            } else if ((char === '^' || char === '!') && !bracketVal) {
              res = '^' // negation, only valid first
            } else if (char === GLOB_SPLIT) {
              res = '' // a path separator never matches inside a range (glob(7))
            } else {
              res = escapeRegExpCharacters(char)
            }
            bracketVal += res
            continue
          }
          switch (char) {
            case '{':
              inBraces = true
              continue
            case '[':
              inBrackets = true
              continue
            case '}': {
              const choices = splitGlobAware(braceVal, ',')
              regEx += `(?:${choices.map(choice => parseRegExp(choice)).join('|')})` // {foo,bar} => (?:foo|bar)
              inBraces = false
              braceVal = ''
              break
            }
            case ']': {
              regEx += '[' + bracketVal + ']'
              inBrackets = false
              bracketVal = ''
              break
            }
            case '?':
              regEx += NO_PATH_REGEX // one character except a path separator
              continue
            case '*':
              regEx += starsToRegExp(1)
              continue
            default:
              regEx += escapeRegExpCharacters(char)
          }
        }
        // The slash we split on, when more is to come and the rest is not a lone trailing globstar: `some/**/*.js`
        // must not match a folder called `something`.
        if (index < segments.length - 1 && (segments[index + 1] !== GLOBSTAR || index + 2 < segments.length)) {
          regEx += PATH_REGEX
        }
      }
      previousSegmentWasGlobStar = segment === GLOBSTAR
    })
  }
  return regEx
}

/** A parsed pattern: the pattern itself when the path matches, otherwise null. */
type ParsedStringPattern = (path: string, basename?: string) => string | null

/** A parsed expression: the first pattern of the expression that matches the path, otherwise null. */
export type ParsedExpression = (path: string, basename?: string) => string | null
export type ParsedPattern = (path: string, basename?: string) => boolean

const NULL: ParsedStringPattern = () => null

function parsePattern(pattern: string, options: IGlobOptions): ParsedStringPattern {
  if (!pattern) {
    return NULL
  }
  pattern = pattern.trim()
  try {
    const regExp = new RegExp(`^${parseRegExp(pattern)}$`, options.ignoreCase ? 'i' : undefined)
    return (path: string) => typeof path === 'string' && regExp.test(path) ? pattern : null
  } catch {
    return NULL
  }
}

function parsedExpression(expression: IExpression, options: IGlobOptions): ParsedExpression {
  const parsedPatterns = Object.getOwnPropertyNames(expression)
    .map(pattern => {
      const value = expression[pattern]
      // false disables the pattern; a sibling clause needs the folder's listing, which this port never has
      return value === true ? parsePattern(pattern, options) : NULL
    })
    .filter(p => p !== NULL)
  if (!parsedPatterns.length) {
    return NULL
  }
  return (path: string, basename?: string) => {
    for (const p of parsedPatterns) {
      const result = p(path, basename)
      if (typeof result === 'string') {
        return result // the first pattern that matches
      }
    }
    return null
  }
}

/**
 * Simplified glob matching: `*`, `?`, `**`, `{a,b}`, `[0-9]`, `[!0-9]`. Both `/` and `\` separate path segments in
 * the matched path; only `/` separates them in the pattern.
 */
export function parse(pattern: string, options?: IGlobOptions): ParsedPattern
export function parse(expression: IExpression, options?: IGlobOptions): ParsedExpression
export function parse(arg1: string | IExpression, options: IGlobOptions = {}): ParsedPattern | ParsedExpression {
  if (!arg1) {
    return () => false
  }
  if (typeof arg1 === 'string') {
    const parsed = parsePattern(arg1, options)
    return (path: string, basename?: string) => !!parsed(path, basename)
  }
  return parsedExpression(arg1, options)
}

export function match(pattern: string, path: string, options?: IGlobOptions): boolean {
  if (!pattern || typeof path !== 'string') {
    return false
  }
  return parse(pattern, options)(path)
}

const EXCLUDE_EXCEPTION_PREFIX = '!'

/** Whether an exclude pattern is a `!`-prefixed exception, which re-includes what other excludes exclude. */
export function isExcludeException(pattern: string): boolean {
  return pattern.trimStart().startsWith(EXCLUDE_EXCEPTION_PREFIX)
}

/** The expression without its `!`-prefixed exceptions. */
export function withoutExcludeExceptions(expression: IExpression): IExpression {
  const result: IExpression = {}
  for (const key of Object.keys(expression)) {
    if (!isExcludeException(key)) {
      result[key] = expression[key]!
    }
  }
  return result
}

// ---------- search.ts ----------

export const DEFAULT_MAX_SEARCH_RESULTS = 20000

// Warning: the search editor detects offsets with this pattern (and so does the search-result extension)
const SEARCH_ELIDED_PREFIX = '⟪ '
const SEARCH_ELIDED_SUFFIX = ' characters skipped ⟫'
const SEARCH_ELIDED_MIN_LEN = (SEARCH_ELIDED_PREFIX.length + SEARCH_ELIDED_SUFFIX.length + 5) * 2

export const DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS = {
  matchLines: 100,
  charsPerLine: 10000,
}

export const QueryType = {
  File: 1,
  Text: 2,
  aiText: 3,
} as const
export type QueryType = typeof QueryType[keyof typeof QueryType]

export interface ExcludeGlobPattern {
  folder?: string
  pattern: IExpression
}

export interface IFolderQuery {
  /** Absolute path of the folder. */
  folder: string
  folderName?: string
  excludePattern?: ExcludeGlobPattern[]
  includePattern?: IExpression
  ignoreGlobCase?: boolean
  fileEncoding?: string
  disregardIgnoreFiles?: boolean
  disregardGlobalIgnoreFiles?: boolean
  disregardParentIgnoreFiles?: boolean
  /** Do not follow symbolic links (ripgrep's `--follow` is passed unless this is set). */
  ignoreSymlinks?: boolean
}

export interface IPatternInfo {
  pattern: string
  isRegExp?: boolean
  isWordMatch?: boolean
  wordSeparators?: string
  isMultiline?: boolean
  isUnicode?: boolean
  isCaseSensitive?: boolean
}

export interface ITextQuery {
  type: typeof QueryType.Text
  folderQueries: IFolderQuery[]
  /** Included files; overrides ignore files when applicable. */
  includePattern?: IExpression
  excludePattern?: IExpression
  ignoreGlobCase?: boolean
  maxResults?: number
  contentPattern: IPatternInfo
  previewOptions?: ITextSearchPreviewOptions
  maxFileSize?: number
  surroundingContext?: number
}

export interface ITextSearchPreviewOptions {
  matchLines: number
  charsPerLine: number
}

/** Zero-based lines and columns; columns count UTF-16 code units, as JavaScript strings do. */
export interface ISearchRange {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

export interface SearchRangeSetPairing {
  source: ISearchRange
  preview: ISearchRange
}

export interface ITextSearchMatch {
  uri?: string
  rangeLocations: SearchRangeSetPairing[]
  previewText: string
}

/** A line of context around a match. `lineNumber` is one-based (ripgrep's), unlike the zero-based match ranges. */
export interface ITextSearchContext {
  uri?: string
  text: string
  lineNumber: number
}

export type ITextSearchResult = ITextSearchMatch | ITextSearchContext

export function resultIsMatch(result: ITextSearchResult): result is ITextSearchMatch {
  return !!(result as ITextSearchMatch).rangeLocations && !!(result as ITextSearchMatch).previewText
}

export interface IFileMatch {
  /** Absolute path of the file. */
  resource: string
  results?: ITextSearchResult[]
}

export const TextSearchCompleteMessageType = {
  Information: 1,
  Warning: 2,
} as const
export type TextSearchCompleteMessageType = typeof TextSearchCompleteMessageType[keyof typeof TextSearchCompleteMessageType]

export interface ITextSearchCompleteMessage {
  text: string
  type: TextSearchCompleteMessageType
  trusted?: boolean
}

export interface ITextSearchStats {
  type: 'textSearchProvider' | 'searchProcess' | 'aiTextSearchProvider'
}

export interface ISearchCompleteStats {
  limitHit?: boolean
  messages: ITextSearchCompleteMessage[]
  stats?: ITextSearchStats
}

export const SearchCompletionExitCode = {
  Normal: 0,
  NewSearchStarted: 1,
} as const
export type SearchCompletionExitCode = typeof SearchCompletionExitCode[keyof typeof SearchCompletionExitCode]

export interface ISearchComplete extends ISearchCompleteStats {
  results: IFileMatch[]
  exit?: SearchCompletionExitCode
}

export class SearchRange implements ISearchRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number

  constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
    this.startLineNumber = startLineNumber
    this.startColumn = startColumn
    this.endLineNumber = endLineNumber
    this.endColumn = endColumn
  }
}

export class OneLineRange extends SearchRange {
  constructor(lineNumber: number, startColumn: number, endColumn: number) {
    super(lineNumber, startColumn, lineNumber, endColumn)
  }
}

function isSingleLineRangeList(ranges: ISearchRange[]): boolean {
  const line = ranges[0]!.startLineNumber
  for (const r of ranges) {
    if (r.startLineNumber !== line || r.endLineNumber !== line) {
      return false
    }
  }
  return true
}

/**
 * A match with its preview. With a one-line preview of single-line ranges, the text is cut around each range
 * (`charsPerLine / 5` characters before it, `charsPerLine` from its start) and long gaps between ranges are elided;
 * the preview ranges are shifted to point into the cut text. Otherwise the whole text is the preview and the preview
 * ranges are the source ranges with lines counted from the first match line.
 */
export class TextSearchMatch implements ITextSearchMatch {
  uri?: string
  rangeLocations: SearchRangeSetPairing[] = []
  previewText: string

  constructor(text: string, ranges: ISearchRange | ISearchRange[], previewOptions?: ITextSearchPreviewOptions) {
    const rangesArr = Array.isArray(ranges) ? ranges : [ranges]

    if (previewOptions && previewOptions.matchLines === 1 && isSingleLineRangeList(rangesArr)) {
      text = getNLines(text, previewOptions.matchLines)

      let result = ''
      let shift = 0
      let lastEnd = 0
      const leadingChars = Math.floor(previewOptions.charsPerLine / 5)
      for (const range of rangesArr) {
        const previewStart = Math.max(range.startColumn - leadingChars, 0)
        const previewEnd = range.startColumn + previewOptions.charsPerLine
        if (previewStart > lastEnd + leadingChars + SEARCH_ELIDED_MIN_LEN) {
          const elision = SEARCH_ELIDED_PREFIX + (previewStart - lastEnd) + SEARCH_ELIDED_SUFFIX
          result += elision + text.slice(previewStart, previewEnd)
          shift += previewStart - (lastEnd + elision.length)
        } else {
          result += text.slice(lastEnd, previewEnd)
        }
        lastEnd = previewEnd
        this.rangeLocations.push({
          source: range,
          preview: new OneLineRange(0, range.startColumn - shift, range.endColumn - shift),
        })
      }
      this.previewText = result
    } else {
      const firstMatchLine = rangesArr[0]!.startLineNumber
      this.rangeLocations = rangesArr.map(r => ({
        preview: new SearchRange(r.startLineNumber - firstMatchLine, r.startColumn, r.endLineNumber - firstMatchLine, r.endColumn),
        source: r,
      }))
      this.previewText = text
    }
  }
}

export const SearchErrorCode = {
  unknownEncoding: 1,
  regexParseError: 2,
  globParseError: 3,
  invalidLiteral: 4,
  rgProcessError: 5,
  other: 6,
  canceled: 7,
} as const
export type SearchErrorCode = typeof SearchErrorCode[keyof typeof SearchErrorCode]

export class SearchError extends Error {
  readonly code?: SearchErrorCode

  constructor(message: string, code?: SearchErrorCode) {
    super(message)
    this.code = code
  }
}

/** Reads back the error that crossed a process boundary as `{ message, code }` JSON in the message. */
export function deserializeSearchError(error: Error): SearchError {
  const errorMsg = error.message
  if (error.name === 'AbortError' || errorMsg === 'Canceled') {
    return new SearchError(errorMsg, SearchErrorCode.canceled)
  }
  try {
    const details = JSON.parse(errorMsg) as { message: string; code?: SearchErrorCode }
    return new SearchError(details.message, details.code)
  } catch {
    return new SearchError(errorMsg, SearchErrorCode.other)
  }
}

export function serializeSearchError(searchError: SearchError): Error {
  const details = { message: searchError.message, code: searchError.code }
  return new Error(JSON.stringify(details))
}

/** The patterns that the provider handles: the enabled (`true`) ones of both expressions; sibling clauses are dropped. */
export function resolvePatternsForProvider(globalPattern: IExpression | undefined, folderPattern: IExpression | undefined): string[] {
  const merged: IExpression = {
    ...(globalPattern || {}),
    ...(folderPattern || {}),
  }
  return Object.keys(merged).filter(key => {
    const value = merged[key]
    return typeof value === 'boolean' && value
  })
}

/** The exclude patterns that the provider handles, without the `!`-prefixed exceptions. */
export function resolveExcludePatternsForProvider(globalPattern: IExpression | undefined, folderPattern: IExpression | undefined): string[] {
  return resolvePatternsForProvider(globalPattern, folderPattern).filter(pattern => !isExcludeException(pattern))
}

/**
 * Tests a folder-relative path against the include and exclude expressions of a query and a folder query. The excludes
 * of each `excludePattern` entry of the folder are merged with the query's; the path is included when at least one of
 * the merged expressions does not exclude it and the include expression (if any) matches it.
 */
export class QueryGlobTester {
  private _excludeExpression: IExpression[]
  private _parsedExcludeExpression: ParsedExpression[]
  private _parsedIncludeExpression: ParsedExpression | null = null

  constructor(config: Pick<ITextQuery, 'excludePattern' | 'includePattern' | 'ignoreGlobCase'>, folderQuery: IFolderQuery) {
    const globOptions = config.ignoreGlobCase || folderQuery.ignoreGlobCase ? { ignoreCase: true } : undefined

    this._excludeExpression = folderQuery.excludePattern?.map(excludePattern => ({
      ...(config.excludePattern || {}),
      ...(excludePattern.pattern || {}),
    })) ?? []
    if (this._excludeExpression.length === 0) {
      // even without folder excludes, the global excludes apply
      this._excludeExpression = [config.excludePattern || {}]
    }
    this._parsedExcludeExpression = this._excludeExpression.map(e => parse(withoutExcludeExceptions(e), globOptions))

    // An empty include expression includes nothing, so no {} shortcut
    let includeExpression: IExpression | undefined = config.includePattern
    if (folderQuery.includePattern) {
      includeExpression = includeExpression ? { ...includeExpression, ...folderQuery.includePattern } : folderQuery.includePattern
    }
    if (includeExpression) {
      this._parsedIncludeExpression = parse(includeExpression, globOptions)
    }
  }

  matchesExcludesSync(testPath: string, basename?: string): boolean {
    return this._parsedExcludeExpression.some(e => typeof e(testPath, basename) === 'string')
  }

  includedInQuery(testPath: string, basename?: string): boolean {
    const isIncluded = () => this._parsedIncludeExpression ? !!this._parsedIncludeExpression(testPath, basename) : true
    return this._parsedExcludeExpression.some(e => e(testPath, basename) ? false : isIncluded())
  }
}
