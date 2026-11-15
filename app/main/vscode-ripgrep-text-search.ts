/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's ripgrep text search engine ("Search in files"): rg's arguments, the run per folder, and the parser
// that turns rg's JSON lines into matches with line/column ranges.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts
//       RipgrepTextSearchEngine, rgErrorMsgForDisplay, buildRegexParseError, RipgrepParser, bytesOrTextToString,
//       getNumLinesAndLastNewlineLength, getRgArgs, pushIncludeAndExcludeGlobs, spreadGlobComponents,
//       unicodeEscapesToPCRE2, fixRegexNewline, fixNewline, performBraceExpansionForRipgrep, IRgMessage/IRgMatch
//   src/vs/workbench/services/search/node/ripgrepSearchUtils.ts
//       anchorGlob, MAX_RIPGREP_SYMLINK_LOOPS, RipgrepSymlinkLoopDetector
//   src/vs/workbench/services/search/common/searchExtTypes.ts   TextSearchQuery2, TextSearchProviderFolderOptions,
//       TextSearchProviderOptions, TextSearchComplete2 (shapes only)
//   src/vs/workbench/services/search/common/searchExtConversionTypes.ts   newToOldPreviewOptions
// Changes, only what this project needs:
//   - a URI is an absolute path string; a result's `uri` is `path.join(folder, rg's path)`;
//   - the extension-API result types (TextSearchMatch2/TextSearchContext2 with vscode.Range) are not ported: the engine
//     reports the serializable ITextSearchMatch/ITextSearchContext of app/shared/vscode-search.ts, with `uri` set.
//     The byte-offset to line/column conversion, the submatches per line, multiline matches and the preview limits
//     (TextSearchMatch with matchLines/charsPerLine) are the origin's;
//   - Progress/CancellationToken become a callback and an AbortSignal; aborting kills the rg process this run spawned;
//   - the rg binary comes as a constructor argument (rgDiskPath is not ported); the output channel and console.error
//     become an optional `log` function; `localize` keeps the English text;
//   - `!`-prefixed exclude exceptions (the second rg run, getExcludeExceptionGlobs) are not ported, nor is the
//     `excludeExceptions` argument of getRgArgs;
//   - fixRegexNewline used the vscode-regexpp parser; here a small parser of the same JavaScript regex syntax builds
//     only the nodes the visitor looks at (characters, character classes and ranges, quantifiers, groups, lookbehinds),
//     and a pattern it cannot parse is returned unchanged, as the origin does when regexpp throws;
//   - getRgArgs works on a copy of the query: the origin rewrites the caller's query (`--`, multiline literal), which
//     then leaks into the run of the next folder.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createRegExp, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS, escapeRegExpCharacters, type ISearchRange,
  type ITextSearchCompleteMessage, type ITextSearchContext, type ITextSearchPreviewOptions, type ITextSearchResult,
  SearchError, SearchErrorCode, SearchRange, serializeSearchError, splitGlobAware, TextSearchCompleteMessageType,
  TextSearchMatch,
} from '../shared/vscode-search.ts'

// ---------- searchExtTypes.ts (shapes) ----------

export interface TextSearchQuery2 {
  pattern: string
  isMultiline?: boolean
  isRegExp?: boolean
  isCaseSensitive?: boolean
  isWordMatch?: boolean
}

export interface TextSearchProviderFolderOptions {
  /** Absolute path of the root folder to search within (rg's working directory). */
  folder: string
  includes: string[]
  excludes: string[]
  ignoreGlobCase?: boolean
  followSymlinks: boolean
  useIgnoreFiles: {
    /** Use ignore files (.gitignore, .ignore) in the folder. */
    local: boolean
    /** Use ignore files in the parent folders. */
    parent: boolean
    /** Use global ignore files. */
    global: boolean
  }
  /** rg's `--encoding`; empty or `utf8` lets rg detect it. */
  encoding: string
}

export interface TextSearchProviderOptions {
  folderOptions: TextSearchProviderFolderOptions[]
  maxResults: number
  previewOptions?: { matchLines?: number; charsPerLine?: number }
  maxFileSize?: number
  surroundingContext?: number
}

export interface RipgrepTextSearchOptions {
  folderOptions: TextSearchProviderFolderOptions
  numThreads?: number
  maxResults?: number
  previewOptions?: { matchLines?: number; charsPerLine?: number }
  maxFileSize?: number
  surroundingContext?: number
}

export interface TextSearchComplete2 {
  limitHit?: boolean
  message?: ITextSearchCompleteMessage[]
}

export type Maybe<T> = T | null | undefined

export function newToOldPreviewOptions(options: { matchLines?: number; charsPerLine?: number } | undefined): ITextSearchPreviewOptions {
  return {
    matchLines: options?.matchLines ?? DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS.matchLines,
    charsPerLine: options?.charsPerLine ?? DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS.charsPerLine,
  }
}

// ---------- ripgrepSearchUtils.ts ----------

/** rg globs are unanchored; a VS Code glob that does not start with `**` or `/` is relative to the folder. */
export function anchorGlob(glob: string): string {
  return glob.startsWith('**') || glob.startsWith('/') ? glob : `/${glob}`
}

/**
 * The number of symbolic link loops a single rg run may report before symbolic links stop being followed. rg only
 * detects links that point back to an ancestor, so a tree of cross-linked symbolic links makes it enumerate
 * exponentially many paths; regular folders report about one loop per self-referencing link.
 */
export const MAX_RIPGREP_SYMLINK_LOOPS = 1000

/** Counts the symbolic link loops that rg reports on stderr while following symbolic links. */
export class RipgrepSymlinkLoopDetector {
  private loopCount = 0
  private partialLine = ''

  /** @returns whether rg has reported more than {@link MAX_RIPGREP_SYMLINK_LOOPS} loops */
  handleStderr(data: string): boolean {
    const lines = (this.partialLine + data).split('\n')
    this.partialLine = lines.pop() ?? ''
    for (const line of lines) {
      if (line.includes('File system loop found')) {
        this.loopCount++
      }
    }
    return this.loopCount > MAX_RIPGREP_SYMLINK_LOOPS
  }
}

// ---------- ripgrepTextSearchEngine.ts ----------

export class RipgrepTextSearchEngine {
  private readonly rgPath: string
  private readonly log: (message: string) => void
  private readonly numThreads: number | undefined

  constructor(rgPath: string, log?: (message: string) => void, numThreads?: number) {
    this.rgPath = rgPath
    this.log = log ?? (() => {})
    this.numThreads = numThreads
  }

  /** One rg per folder, in parallel; `limitHit` when any folder hit it. */
  provideTextSearchResults(query: TextSearchQuery2, options: TextSearchProviderOptions, onResult: (result: ITextSearchResult) => void, signal?: AbortSignal): Promise<TextSearchComplete2> {
    return Promise.all(options.folderOptions.map(folderOption => {
      const extendedOptions: RipgrepTextSearchOptions = {
        folderOptions: folderOption,
        numThreads: this.numThreads,
        maxResults: options.maxResults,
        previewOptions: options.previewOptions,
        maxFileSize: options.maxFileSize,
        surroundingContext: options.surroundingContext,
      }
      return this.provideTextSearchResultsWithRgOptions(query, extendedOptions, onResult, signal)
    })).then(e => {
      const complete: TextSearchComplete2 = {
        limitHit: e.some(complete => !!complete && complete.limitHit),
      }
      const messages = e.flatMap(complete => complete?.message ?? [])
      if (messages.length) {
        complete.message = messages
      }
      return complete
    })
  }

  provideTextSearchResultsWithRgOptions(query: TextSearchQuery2, options: RipgrepTextSearchOptions, onResult: (result: ITextSearchResult) => void, signal?: AbortSignal): Promise<TextSearchComplete2> {
    return this.searchWithRipgrep(query, options, onResult, signal)
  }

  private searchWithRipgrep(query: TextSearchQuery2, options: RipgrepTextSearchOptions, onResult: (result: ITextSearchResult) => void, signal: AbortSignal | undefined): Promise<TextSearchComplete2> {
    this.log(`provideTextSearchResults ${query.pattern}, ${JSON.stringify({ ...options, folder: options.folderOptions.folder })}`)

    if (!query.pattern) {
      return Promise.resolve({ limitHit: false })
    }

    return new Promise((resolve, reject) => {
      const extendedOptions: RipgrepTextSearchOptions = { ...options, numThreads: this.numThreads }
      const rgArgs = getRgArgs(query, extendedOptions)
      const cwd = options.folderOptions.folder

      const escapedArgs = rgArgs.map(arg => arg.match(/^-/) ? arg : `'${arg}'`).join(' ')
      this.log(`${this.rgPath} ${escapedArgs}\n - cwd: ${cwd}`)

      let rgProc: Maybe<ChildProcess> = spawn(this.rgPath, rgArgs, { cwd, windowsHide: true })
      const proc = rgProc
      rgProc.on('error', e => {
        this.log('Error: ' + (e && e.message))
        reject(serializeSearchError(new SearchError(e && e.message, SearchErrorCode.rgProcessError)))
      })

      let gotResult = false
      const ripgrepParser = new RipgrepParser(options.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS, cwd, newToOldPreviewOptions(options.previewOptions))

      // When rg reports too many symbolic link loops, search the folder again without following symbolic links and
      // skip the results that were already reported
      const symlinkLoopDetector = options.folderOptions.followSymlinks ? new RipgrepSymlinkLoopDetector() : undefined
      const reportedPaths: string[] = []
      let isRetrying = false

      ripgrepParser.on('result', (match: ITextSearchResult) => {
        gotResult = true
        dataWithoutResult = ''
        if (symlinkLoopDetector) {
          reportedPaths.push(match.uri!)
        }
        onResult(match)
      })

      let isDone = false
      const cancel = () => {
        isDone = true
        // the process this run spawned, never one found by name
        proc.kill()
        ripgrepParser.cancel()
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) {
        cancel()
      }

      let limitHit = false
      ripgrepParser.on('hitLimit', () => {
        limitHit = true
        cancel()
      })

      let dataWithoutResult = ''
      rgProc.stdout!.on('data', (data: Buffer) => {
        ripgrepParser.handleData(data)
        if (!gotResult) {
          dataWithoutResult += data
        }
      })

      let gotData = false
      rgProc.stdout!.once('data', () => gotData = true)

      let stderr = ''
      rgProc.stderr!.on('data', (data: Buffer) => {
        const message = data.toString()
        this.log(message)
        if (stderr.length + message.length < 1e6) {
          stderr += message
        }
        if (!isDone && symlinkLoopDetector?.handleStderr(message)) {
          isRetrying = true
          cancel()
        }
      })

      rgProc.on('close', () => {
        signal?.removeEventListener('abort', cancel)
        this.log(gotData ? 'Got data from stdout' : 'No data from stdout')
        this.log(gotResult ? 'Got result from parser' : 'No result from parser')
        if (dataWithoutResult) {
          this.log(`Got data without result: ${dataWithoutResult}`)
        }
        this.log('')

        if (isRetrying && !signal?.aborted) {
          resolve(this.searchAgainWithoutFollowingSymlinks(query, options, onResult, signal, reportedPaths))
        } else if (isDone) {
          resolve({ limitHit })
        } else {
          // Trigger last result
          ripgrepParser.flush()
          rgProc = null
          let searchError: Maybe<SearchError>
          if (stderr && !gotData && (searchError = rgErrorMsgForDisplay(stderr))) {
            reject(serializeSearchError(new SearchError(searchError.message, searchError.code)))
          } else {
            resolve({ limitHit })
          }
        }
      })
    })
  }

  private async searchAgainWithoutFollowingSymlinks(query: TextSearchQuery2, options: RipgrepTextSearchOptions, onResult: (result: ITextSearchResult) => void, signal: AbortSignal | undefined, reportedPaths: readonly string[]): Promise<TextSearchComplete2> {
    const folder = options.folderOptions.folder
    this.log(`ripgrep reported more than ${MAX_RIPGREP_SYMLINK_LOOPS} symbolic link loops, searching ${folder} again without following symbolic links`)

    // rg reports the results of a file in the same order every time, so skip as many results of each file as were
    // already reported. This also covers a file whose results were only partially reported.
    const resultsToSkip = new Map<string, number>()
    for (const path of reportedPaths) {
      resultsToSkip.set(path, (resultsToSkip.get(path) ?? 0) + 1)
    }

    const complete = await this.searchWithRipgrep(
      query,
      { ...options, folderOptions: { ...options.folderOptions, followSymlinks: false } },
      result => {
        const toSkip = resultsToSkip.get(result.uri!)
        if (toSkip) {
          resultsToSkip.set(result.uri!, toSkip - 1)
        } else {
          onResult(result)
        }
      },
      signal,
    )

    return {
      ...complete,
      message: [
        ...complete.message ?? [],
        {
          type: TextSearchCompleteMessageType.Warning,
          text: `Symbolic links in '${folder}' were not followed because they form too many loops, so results may be incomplete. Exclude the folders that contain the loops or turn off the 'search.followSymlinks' setting to avoid this.`,
        },
      ],
    }
  }
}

/**
 * Reads stderr and returns an error for display, or undefined. rg writes to stderr for errors that are not fatal too;
 * only the ones listed here fail the search.
 */
export function rgErrorMsgForDisplay(msg: string): Maybe<SearchError> {
  const lines = msg.split('\n')
  const firstLine = lines[0]!.trim()

  if (lines.some(l => l.startsWith('regex parse error'))) {
    return new SearchError(buildRegexParseError(lines), SearchErrorCode.regexParseError)
  }

  const match = firstLine.match(/grep config error: unknown encoding: (.*)/)
  if (match) {
    return new SearchError(`Unknown encoding: ${match[1]}`, SearchErrorCode.unknownEncoding)
  }

  if (firstLine.startsWith('error parsing glob')) {
    // Uppercase first letter
    return new SearchError(firstLine.charAt(0).toUpperCase() + firstLine.substr(1), SearchErrorCode.globParseError)
  }

  if (firstLine.startsWith('the literal')) {
    // Uppercase first letter
    return new SearchError(firstLine.charAt(0).toUpperCase() + firstLine.substr(1), SearchErrorCode.invalidLiteral)
  }

  if (firstLine.startsWith('PCRE2: error compiling pattern')) {
    return new SearchError(firstLine, SearchErrorCode.regexParseError)
  }

  return undefined
}

function buildRegexParseError(lines: string[]): string {
  const errorMessage: string[] = ['Regex parse error']
  const pcre2ErrorLine = lines.filter(l => l.startsWith('PCRE2:'))
  if (pcre2ErrorLine.length >= 1) {
    const pcre2ErrorMessage = pcre2ErrorLine[0]!.replace('PCRE2:', '')
    if (pcre2ErrorMessage.indexOf(':') !== -1 && pcre2ErrorMessage.split(':').length >= 2) {
      const pcre2ActualErrorMessage = pcre2ErrorMessage.split(':')[1]
      errorMessage.push(':' + pcre2ActualErrorMessage)
    }
  }
  return errorMessage.join('')
}

/**
 * Turns rg's `--json` output into results. Data may arrive cut anywhere (in a line, in a UTF-8 sequence): bytes go
 * through a StringDecoder and the text after the last line break waits for the next chunk.
 * Events: `result` (ITextSearchResult with `uri`), `hitLimit` (after the line whose match reached maxResults).
 */
export class RipgrepParser extends EventEmitter {
  private remainder = ''
  private isDone = false
  private hitLimit = false
  private stringDecoder: StringDecoder
  private numResults = 0
  private maxResults: number
  private root: string
  private previewOptions: ITextSearchPreviewOptions

  constructor(maxResults: number, root: string, previewOptions: ITextSearchPreviewOptions) {
    super()
    this.maxResults = maxResults
    this.root = root
    this.previewOptions = previewOptions
    this.stringDecoder = new StringDecoder()
  }

  cancel(): void {
    this.isDone = true
  }

  flush(): void {
    this.handleDecodedData(this.stringDecoder.end())
  }

  override on(event: 'result', listener: (result: ITextSearchResult) => void): this
  override on(event: 'hitLimit', listener: () => void): this
  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    return this
  }

  handleData(data: Buffer | string): void {
    if (this.isDone) {
      return
    }
    const dataStr = typeof data === 'string' ? data : this.stringDecoder.write(data)
    this.handleDecodedData(dataStr)
  }

  private handleDecodedData(decodedData: string): void {
    // check for newline before appending to remainder
    let newlineIdx = decodedData.indexOf('\n')

    // If the previous data chunk didn't end in a newline, prepend it to this chunk
    const dataStr = this.remainder + decodedData

    if (newlineIdx >= 0) {
      newlineIdx += this.remainder.length
    } else {
      this.remainder = dataStr
      return
    }

    let prevIdx = 0
    while (newlineIdx >= 0) {
      this.handleLine(dataStr.substring(prevIdx, newlineIdx).trim())
      prevIdx = newlineIdx + 1
      newlineIdx = dataStr.indexOf('\n', prevIdx)
    }
    this.remainder = dataStr.substring(prevIdx)
  }

  private handleLine(outputLine: string): void {
    if (this.isDone || !outputLine) {
      return
    }

    let parsedLine: IRgMessage
    try {
      parsedLine = JSON.parse(outputLine)
    } catch {
      throw new Error(`malformed line from rg: ${outputLine}`)
    }

    if (parsedLine.type === 'match') {
      const matchPath = bytesOrTextToString(parsedLine.data.path)
      const uri = join(this.root, matchPath)
      const result = this.createTextSearchMatch(parsedLine.data, uri)
      this.onResult(result)

      if (this.hitLimit) {
        this.cancel()
        this.emit('hitLimit')
      }
    } else if (parsedLine.type === 'context') {
      const contextPath = bytesOrTextToString(parsedLine.data.path)
      const uri = join(this.root, contextPath)
      const result = this.createTextSearchContexts(parsedLine.data, uri)
      result.forEach(r => this.onResult(r))
    }
  }

  /**
   * rg gives the submatches as byte offsets into `lines` (the matched line, or lines when multiline). Each range is
   * computed from the text between the previous submatch's end and this one's start, decoded to a string: the line
   * count and the length of its last line move the position, so columns are UTF-16 code units, not bytes.
   */
  private createTextSearchMatch(data: IRgMatch, uri: string): TextSearchMatch {
    const lineNumber = data.line_number - 1
    const fullText = bytesOrTextToString(data.lines)
    const fullTextBytes = Buffer.from(fullText)

    let prevMatchEnd = 0
    let prevMatchEndCol = 0
    let prevMatchEndLine = lineNumber

    // certain regexes can match a line without rg emitting any submatch for it (vscode#100569)
    if (data.submatches.length === 0) {
      data.submatches.push(
        fullText.length
          ? { start: 0, end: 1, match: { text: fullText[0]! } }
          : { start: 0, end: 0, match: { text: '' } },
      )
    }

    const ranges: ISearchRange[] = []
    for (const match of data.submatches) {
      if (this.hitLimit) {
        continue
      }

      this.numResults++
      if (this.numResults >= this.maxResults) {
        // Finish the line, then report the result
        this.hitLimit = true
      }

      const matchText = bytesOrTextToString(match.match)

      const inBetweenText = fullTextBytes.slice(prevMatchEnd, match.start).toString()
      const inBetweenStats = getNumLinesAndLastNewlineLength(inBetweenText)
      const startCol = inBetweenStats.numLines > 0 ?
        inBetweenStats.lastLineLength :
        inBetweenStats.lastLineLength + prevMatchEndCol

      const stats = getNumLinesAndLastNewlineLength(matchText)
      const startLineNumber = inBetweenStats.numLines + prevMatchEndLine
      const endLineNumber = stats.numLines + startLineNumber
      const endCol = stats.numLines > 0 ?
        stats.lastLineLength :
        stats.lastLineLength + startCol

      prevMatchEnd = match.end
      prevMatchEndCol = endCol
      prevMatchEndLine = endLineNumber

      ranges.push(new SearchRange(startLineNumber, startCol, endLineNumber, endCol))
    }

    const result = new TextSearchMatch(fullText, ranges, this.previewOptions)
    result.uri = uri
    return result
  }

  private createTextSearchContexts(data: IRgMatch, uri: string): ITextSearchContext[] {
    const text = bytesOrTextToString(data.lines)
    const startLine = data.line_number
    return text
      .replace(/\r?\n$/, '')
      .split('\n')
      .map((line, i) => ({ uri, text: line, lineNumber: startLine + i }))
  }

  private onResult(match: ITextSearchResult): void {
    this.emit('result', match)
  }
}

function bytesOrTextToString(obj: IRgBytesOrText): string {
  return 'bytes' in obj && obj.bytes ?
    Buffer.from(obj.bytes, 'base64').toString() :
    (obj as { text: string }).text
}

function getNumLinesAndLastNewlineLength(text: string): { numLines: number; lastLineLength: number } {
  const re = /\n/g
  let numLines = 0
  let lastNewlineIdx = -1
  let match: ReturnType<typeof re.exec>
  while ((match = re.exec(text))) {
    numLines++
    lastNewlineIdx = match.index
  }
  const lastLineLength = lastNewlineIdx >= 0 ?
    text.length - lastNewlineIdx - 1 :
    text.length
  return { numLines, lastLineLength }
}

/** rg's arguments for one folder. Exported for testing. */
export function getRgArgs(query: TextSearchQuery2, options: RipgrepTextSearchOptions): string[] {
  query = { ...query }
  const args = ['--hidden', '--no-require-git']
  args.push(query.isCaseSensitive ? '--case-sensitive' : '--ignore-case')

  if (options.folderOptions.ignoreGlobCase) {
    args.push('--glob-case-insensitive')
    args.push('--ignore-file-case-insensitive')
  }

  pushIncludeAndExcludeGlobs(args, options)

  if (options.maxFileSize) {
    args.push('--max-filesize', options.maxFileSize + '')
  }

  if (options.folderOptions.useIgnoreFiles.local) {
    if (!options.folderOptions.useIgnoreFiles.parent) {
      args.push('--no-ignore-parent')
    }
  } else {
    // Don't use .gitignore or .ignore
    args.push('--no-ignore')
  }

  if (options.folderOptions.followSymlinks) {
    args.push('--follow')
  }

  if (options.folderOptions.encoding && options.folderOptions.encoding !== 'utf8') {
    args.push('--encoding', options.folderOptions.encoding)
  }

  if (options.numThreads) {
    args.push('--threads', `${options.numThreads}`)
  }

  // rg takes a lone `--` as the end of its options (`-`, `---` and `--flag` are fine as patterns)
  if (query.pattern === '--') {
    query.isRegExp = true
    query.pattern = '\\-\\-'
  }

  if (query.isMultiline && !query.isRegExp) {
    query.pattern = escapeRegExpCharacters(query.pattern)
    query.isRegExp = true
  }

  // Allow $ to match \r\n
  args.push('--crlf')

  if (query.isRegExp) {
    query.pattern = unicodeEscapesToPCRE2(query.pattern)
    args.push('--engine', 'auto')
  }

  let searchPatternAfterDoubleDashes: Maybe<string>
  if (query.isWordMatch) {
    const regexp = createRegExp(query.pattern, !!query.isRegExp, { wholeWord: query.isWordMatch })
    const regexpStr = regexp.source.replace(/\\\//g, '/') // RegExp.source escapes slashes
    args.push('--regexp', regexpStr)
  } else if (query.isRegExp) {
    let fixedRegexpQuery = fixRegexNewline(query.pattern)
    fixedRegexpQuery = fixNewline(fixedRegexpQuery)
    args.push('--regexp', fixedRegexpQuery)
  } else {
    searchPatternAfterDoubleDashes = query.pattern
    args.push('--fixed-strings')
  }

  args.push('--no-config')
  if (!options.folderOptions.useIgnoreFiles.global) {
    args.push('--no-ignore-global')
  }

  args.push('--json')

  if (query.isMultiline) {
    args.push('--multiline')
  }

  if (options.surroundingContext) {
    args.push('--before-context', options.surroundingContext + '')
    args.push('--after-context', options.surroundingContext + '')
  }

  // Folder to search
  args.push('--')

  if (searchPatternAfterDoubleDashes) {
    // Put the query after --, in case the query starts with a dash
    args.push(searchPatternAfterDoubleDashes)
  }

  args.push('.')

  return args
}

/**
 * Includes that start with `**` go to rg as they are. Any other include excludes everything (`!*`) and re-includes
 * the include and each folder that leads to it (rg does not descend into a folder that a glob excludes), anchored to
 * the folder. Excludes are anchored and negated.
 */
function pushIncludeAndExcludeGlobs(args: string[], options: RipgrepTextSearchOptions): void {
  const doubleStarIncludes: string[] = []
  const otherIncludes: string[] = []
  for (const include of options.folderOptions.includes) {
    (include.startsWith('**') ? doubleStarIncludes : otherIncludes).push(include)
  }

  if (otherIncludes.length) {
    const uniqueOthers = new Set<string>(otherIncludes)
    args.push('-g', '!*')
    uniqueOthers.forEach(otherInclude => {
      spreadGlobComponents(otherInclude)
        .map(anchorGlob)
        .forEach(globArg => {
          args.push('-g', globArg)
        })
    })
  }

  doubleStarIncludes.forEach(globArg => {
    args.push('-g', globArg)
  })

  options.folderOptions.excludes
    .map(anchorGlob)
    .forEach(rgGlob => args.push('-g', `!${rgGlob}`))
}

/** `"foo/*bar/something"` -> `["foo", "foo/*bar", "foo/*bar/something"]` */
function spreadGlobComponents(globComponent: string): string[] {
  const globComponentWithBraceExpansion = performBraceExpansionForRipgrep(globComponent)
  return globComponentWithBraceExpansion.flatMap(globArg => {
    const components = splitGlobAware(globArg, '/')
    return components.map((_, i) => components.slice(0, i + 1).join('/'))
  })
}

/** `ሴ` and `\u{1234}` (JavaScript) -> `\x{1234}` (PCRE2), unless the backslash itself is escaped. */
export function unicodeEscapesToPCRE2(pattern: string): string {
  // Match ሴ
  const unicodePattern = /((?:[^\\]|^)(?:\\\\)*)\\u([a-z0-9]{4})/gi
  while (pattern.match(unicodePattern)) {
    pattern = pattern.replace(unicodePattern, `$1\\x{$2}`)
  }

  // Match \u{1234}; with 5-6 characters it is left alone, because \x only takes 4 characters
  const unicodePatternWithBraces = /((?:[^\\]|^)(?:\\\\)*)\\u\{([a-z0-9]{4})\}/gi
  while (pattern.match(unicodePatternWithBraces)) {
    pattern = pattern.replace(unicodePatternWithBraces, `$1\\x{$2}`)
  }

  return pattern
}

export interface IRgMessage {
  type: 'match' | 'context' | string
  data: IRgMatch
}

export interface IRgMatch {
  path: IRgBytesOrText
  lines: IRgBytesOrText
  line_number: number
  absolute_offset: number
  submatches: IRgSubmatch[]
}

export interface IRgSubmatch {
  match: IRgBytesOrText
  start: number
  end: number
}

export type IRgBytesOrText = { bytes: string } | { text: string }

// ---------- fixRegexNewline: the part of vscode-regexpp's AST and visitor it uses ----------

interface ReCharacter { type: 'Character'; raw: string; start: number; end: number }
/** \d, \w, `.`, back-references, `^`, `$`, \b: never `\n`, and the visitor ignores them. */
interface ReOther { type: 'Other'; start: number; end: number }
interface ReCharacterClassRange { type: 'CharacterClassRange'; min: ReCharacter | ReOther; max: ReCharacter | ReOther; start: number; end: number }
interface ReCharacterClass { type: 'CharacterClass'; negate: boolean; elements: (ReCharacter | ReOther | ReCharacterClassRange)[]; parent: ReNode | undefined; start: number; end: number }
interface ReGroup { type: 'Group'; alternatives: ReNode[][]; start: number; end: number }
interface ReAssertion { type: 'Assertion'; kind: 'lookahead' | 'lookbehind' | 'other'; alternatives: ReNode[][]; start: number; end: number }
interface ReQuantifier { type: 'Quantifier'; element: ReNode; start: number; end: number }
type ReNode = ReCharacter | ReOther | ReCharacterClass | ReCharacterClassRange | ReGroup | ReAssertion | ReQuantifier

const CLASS_ESCAPES = 'dDwWsS'

/** Parses JavaScript (non-unicode, Annex B) regex syntax into the nodes above; throws on what regexpp rejects. */
function parseRegexPattern(pattern: string): ReNode[][] {
  let i = 0
  const fail = (): never => { throw new Error(`invalid regex at ${i}`) }

  const parseQuantifierAt = (at: number): number => {
    // the end of a quantifier that starts at `at`, or -1
    const c = pattern[at]
    if (c === '*' || c === '+' || c === '?') return at + 1
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at))
      if (m) {
        if (m[3] && Number(m[3]) < Number(m[1])) fail()
        return at + m[0].length
      }
    }
    return -1
  }

  const parseEscape = (): ReCharacter | ReOther => {
    const start = i
    if (i + 1 >= pattern.length) fail()
    const c = pattern[i + 1]!
    i += 2
    if (CLASS_ESCAPES.includes(c) || c === 'b' || c === 'B' || /[1-9]/.test(c)) {
      return { type: 'Other', start, end: i }
    }
    return { type: 'Character', raw: pattern.slice(start, i), start, end: i }
  }

  const parseClass = (parent: ReNode | undefined): ReCharacterClass => {
    const start = i
    i++ // [
    let negate = false
    if (pattern[i] === '^') { negate = true; i++ }
    const elements: (ReCharacter | ReOther | ReCharacterClassRange)[] = []
    const atom = (): ReCharacter | ReOther => {
      if (pattern[i] === '\\') {
        const e = parseEscape()
        // \b is a backspace character inside a class
        return e
      }
      const s = i
      i++
      return { type: 'Character', raw: pattern.slice(s, i), start: s, end: i }
    }
    while (true) {
      if (i >= pattern.length) fail()
      if (pattern[i] === ']') { i++; break }
      const min = atom()
      if (pattern[i] === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
        const save = i
        i++
        const max = atom()
        const isSet = (n: ReCharacter | ReOther) => n.type === 'Other' || (n.raw.length === 2 && CLASS_ESCAPES.includes(n.raw[1]!))
        if (isSet(min) || isSet(max)) {
          // Annex B: a class escape on either side makes `-` a literal
          elements.push(min, { type: 'Character', raw: '-', start: save, end: save + 1 }, max)
        } else {
          elements.push({ type: 'CharacterClassRange', min, max, start: min.start, end: max.end })
        }
      } else {
        elements.push(min)
      }
    }
    return { type: 'CharacterClass', negate, elements, parent, start, end: i }
  }

  const parseAlternatives = (closing: boolean): ReNode[][] => {
    const alternatives: ReNode[][] = [[]]
    while (i < pattern.length) {
      const c = pattern[i]!
      if (c === ')') {
        if (!closing) fail()
        return alternatives
      }
      if (c === '|') { i++; alternatives.push([]); continue }
      const current = alternatives[alternatives.length - 1]!
      const start = i
      let node: ReNode
      let quantifiable = true
      if (c === '\\') {
        node = parseEscape()
        if (node.type === 'Other' && /[bB]/.test(pattern[start + 1]!)) quantifiable = false
      } else if (c === '[') {
        // the parent (a quantifier) is set below, once the quantifier is known
        node = parseClass(undefined)
      } else if (c === '(') {
        i++
        let kind: 'group' | 'capture' | 'lookahead' | 'lookbehind' = 'capture'
        if (pattern[i] === '?') {
          const rest = pattern.slice(i)
          if (rest.startsWith('?:')) { kind = 'group'; i += 2 } else if (rest.startsWith('?=') || rest.startsWith('?!')) { kind = 'lookahead'; i += 2 } else if (rest.startsWith('?<=') || rest.startsWith('?<!')) { kind = 'lookbehind'; i += 3 } else {
            const m = /^\?<([A-Za-z_$][\w$]*)>/.exec(rest)
            if (!m) fail()
            i += m![0].length
          }
        }
        const alternatives = parseAlternatives(true)
        if (pattern[i] !== ')') fail()
        i++
        if (kind === 'lookahead' || kind === 'lookbehind') {
          node = { type: 'Assertion', kind, alternatives, start, end: i }
          quantifiable = kind === 'lookahead' // Annex B allows quantified lookaheads only
        } else {
          node = { type: 'Group', alternatives, start, end: i }
        }
      } else if (c === '^' || c === '$') {
        i++
        node = { type: 'Other', start, end: i }
        quantifiable = false
      } else if (c === '.') {
        i++
        node = { type: 'Other', start, end: i }
      } else if (c === '*' || c === '+' || c === '?' || (c === '{' && parseQuantifierAt(i) >= 0)) {
        return fail() // nothing to repeat
      } else {
        i++
        node = { type: 'Character', raw: c, start, end: i }
      }
      const qEnd = parseQuantifierAt(i)
      if (qEnd >= 0) {
        if (!quantifiable) fail()
        i = qEnd
        if (pattern[i] === '?') i++ // lazy
        const quantifier: ReQuantifier = { type: 'Quantifier', element: node, start, end: i }
        if (node.type === 'CharacterClass') node.parent = quantifier
        node = quantifier
      }
      current.push(node)
    }
    if (closing) fail()
    return alternatives
  }

  return parseAlternatives(false)
}

type ReContextNode = ReQuantifier | ReCharacterClass | ReCharacterClassRange | ReAssertion

const isLookBehind = (node: ReContextNode) => node.type === 'Assertion' && node.kind === 'lookbehind'

/**
 * Makes `\n` in a regex match `\r\n` too: `\n` -> `\r?\n`; inside a class, the class becomes an alternation (or, when
 * negated, a lookahead, or `.`/a negated class when quantified); nothing changes inside a lookbehind (vscode#100569).
 * The context stack follows regexpp's visitor: quantifiers, classes and ranges are unshifted on enter and shifted on
 * leave; a lookbehind is pushed at the end and removed on leave only when it is first.
 */
export function fixRegexNewline(pattern: string): string {
  let re: ReNode[][]
  try {
    re = parseRegexPattern(pattern)
  } catch {
    return pattern
  }

  let output = ''
  let lastEmittedIndex = 0
  const replace = (start: number, end: number, text: string) => {
    output += pattern.slice(lastEmittedIndex, start) + text
    lastEmittedIndex = end
  }

  const context: ReContextNode[] = []
  const onCharacterEnter = (char: ReCharacter) => {
    if (char.raw !== '\\n') {
      return
    }
    const parent = context[0]
    if (!parent) {
      // simple char, \n -> \r?\n
      replace(char.start, char.end, '\\r?\\n')
    } else if (context.some(isLookBehind)) {
      // no-op in a lookbehind
    } else if (parent.type === 'CharacterClass') {
      if (parent.negate) {
        // negative bracket expr, [^a-z\n] -> (?![a-z]|\r?\n)
        const otherContent = pattern.slice(parent.start + 2, char.start) + pattern.slice(char.end, parent.end - 1)
        if (parent.parent?.type === 'Quantifier') {
          // A lookahead cannot be quantified, but `.` already does not match new lines, so use it (with any other
          // negations) instead
          replace(parent.start, parent.end, otherContent ? `[^${otherContent}]` : '.')
        } else {
          replace(parent.start, parent.end, '(?!\\r?\\n' + (otherContent ? `|[${otherContent}]` : '') + ')')
        }
      } else {
        // positive bracket expr, [a-z\n] -> (?:[a-z]|\r?\n)
        const otherContent = pattern.slice(parent.start + 1, char.start) + pattern.slice(char.end, parent.end - 1)
        replace(parent.start, parent.end, otherContent === '' ? '\\r?\\n' : `(?:[${otherContent}]|\\r?\\n)`)
      }
    } else if (parent.type === 'Quantifier') {
      replace(char.start, char.end, '(?:\\r?\\n)')
    }
  }

  const visit = (node: ReNode): void => {
    switch (node.type) {
      case 'Character':
        onCharacterEnter(node)
        break
      case 'Other':
        break
      case 'Quantifier':
        context.unshift(node)
        visit(node.element)
        context.shift()
        break
      case 'CharacterClass':
        context.unshift(node)
        node.elements.forEach(visit)
        context.shift()
        break
      case 'CharacterClassRange':
        context.unshift(node)
        visit(node.min)
        visit(node.max)
        context.shift()
        break
      case 'Group':
        node.alternatives.forEach(a => a.forEach(visit))
        break
      case 'Assertion':
        if (isLookBehind(node)) {
          context.push(node)
        }
        node.alternatives.forEach(a => a.forEach(visit))
        if (context[0] === node) {
          context.shift()
        }
        break
    }
  }

  re.forEach(a => a.forEach(visit))
  output += pattern.slice(lastEmittedIndex)
  return output
}

/** A literal line break in the pattern also matches `\r\n`. */
export function fixNewline(pattern: string): string {
  return pattern.replace(/\n/g, '\\r?\\n')
}

// ---------- brace expansion for ripgrep ----------

/**
 * Splits the pattern at its first brace group. A `\` escapes the brace after it; escapes inside the group are kept
 * for whatever processes the parts later; a second unescaped `{` before the `}` would be nesting, which rg rejects,
 * so nothing is split then.
 */
function getEscapeAwareSplitStringForRipgrep(pattern: string): { fixedStart?: string; strInBraces: string; fixedEnd?: string } {
  let inBraces = false
  let escaped = false
  let fixedStart = ''
  let strInBraces = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    switch (char) {
      case '\\':
        if (escaped) {
          // keep both slashes: the later glob processing reads them as one escaped slash
          if (inBraces) {
            strInBraces += '\\' + char
          } else {
            fixedStart += '\\' + char
          }
          escaped = false
        } else {
          escaped = true
        }
        break
      case '{':
        if (escaped) {
          // an escaped opening brace is literal: drop the `\`
          if (inBraces) {
            strInBraces += char
          } else {
            fixedStart += char
          }
          escaped = false
        } else {
          if (inBraces) {
            // nested alternate group, invalid for rg: return the pattern with the escaped braces resolved
            return { strInBraces: fixedStart + '{' + strInBraces + '{' + pattern.substring(i + 1) }
          } else {
            inBraces = true
          }
        }
        break
      case '}':
        if (escaped) {
          if (inBraces) {
            strInBraces += char
          } else {
            fixedStart += char
          }
          escaped = false
        } else if (inBraces) {
          // the end of a valid group
          return { fixedStart, strInBraces, fixedEnd: pattern.substring(i + 1) }
        } else {
          // a literal `}` outside braces
          fixedStart += char
        }
        break
      default:
        // an escape of anything else is kept for later
        if (inBraces) {
          strInBraces += (escaped ? '\\' : '') + char
        } else {
          fixedStart += (escaped ? '\\' : '') + char
        }
        escaped = false
        break
    }
  }

  // no closing brace: nothing to split
  return { strInBraces: fixedStart + (inBraces ? ('{' + strInBraces) : '') }
}

/** Expands `{a,b}` groups into separate globs (one level of nesting). Exported for testing. */
export function performBraceExpansionForRipgrep(pattern: string): string[] {
  const { fixedStart, strInBraces, fixedEnd } = getEscapeAwareSplitStringForRipgrep(pattern)
  if (fixedStart === undefined || fixedEnd === undefined) {
    return [strInBraces]
  }

  let arr = splitGlobAware(strInBraces, ',')
  if (!arr.length) {
    // empty braces
    arr = ['']
  }

  const ends = performBraceExpansionForRipgrep(fixedEnd)
  return arr.flatMap(elem => {
    const start = fixedStart + elem
    return ends.map(end => start + end)
  })
}
