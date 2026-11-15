/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's text search manager: turns an ITextQuery into the engine's per-folder options, runs the engine
// (one rg per root), enforces the result limit, filters each result through the query's globs, and hands the results
// to the caller grouped per file, in batches.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/services/search/common/textSearchManager.ts
//       TextSearchManager, patternInfoToQuery, TextSearchResultsCollector, BatchedCollector
//   src/vs/workbench/services/search/node/textSearchManager.ts      NativeTextSearchManager (its toCanonicalName)
//   src/vs/workbench/services/textfile/common/encoding.ts           toCanonicalName
// Changes, only what this project needs:
//   - a URI is an absolute path string; CancellationToken(Source) becomes AbortSignal/AbortController;
//   - the provider is any object with the engine's provideTextSearchResults (RipgrepTextSearchEngine); AI search and
//     the extension-API result types are not ported: results are the serializable ones of app/shared/vscode-search.ts,
//     so extensionResultToFrontendResult only drops `uri`;
//   - the folder of a result is the deepest folder query that contains its path (FolderQuerySearchTree's lookup);
//   - sibling clauses are not evaluated (no readdir per result folder) and `!`-prefixed exclude exceptions are not
//     searched for (no excludeExceptions/nestedFolders in the folder options);
//   - a glob key that is an absolute path inside a folder is rewritten relative to that folder (forward slashes), for
//     rg and for the glob tester alike; an absolute key outside the folder is left as it is and matches nothing there.
import { basename } from 'node:path'
import {
  DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS, type IExpression, type IFileMatch, type IFolderQuery,
  type IPatternInfo, type ISearchCompleteStats, type ITextQuery, type ITextSearchMatch, type ITextSearchResult,
  type ITextSearchStats, QueryGlobTester, resolveExcludePatternsForProvider, resolvePatternsForProvider,
} from '../shared/vscode-search.ts'
import type { TextSearchComplete2, TextSearchProviderFolderOptions, TextSearchProviderOptions, TextSearchQuery2 } from './vscode-ripgrep-text-search.ts'

/** What the manager needs of a provider; RipgrepTextSearchEngine is one. */
export interface ITextSearchProvider {
  provideTextSearchResults(query: TextSearchQuery2, options: TextSearchProviderOptions, onResult: (result: ITextSearchResult) => void, signal?: AbortSignal): Promise<TextSearchComplete2>
}

/** encoding.ts: VS Code's encoding ids to the names rg (encoding_rs) knows. */
export function toCanonicalName(enc: string): string {
  switch (enc) {
    case 'shiftjis':
      return 'shift-jis'
    case 'utf16le':
      return 'utf-16le'
    case 'utf16be':
      return 'utf-16be'
    case 'big5hkscs':
      return 'big5-hkscs'
    case 'eucjp':
      return 'euc-jp'
    case 'euckr':
      return 'euc-kr'
    case 'koi8r':
      return 'koi8-r'
    case 'koi8u':
      return 'koi8-u'
    case 'macroman':
      return 'x-mac-roman'
    case 'utf8bom':
      return 'utf8'
    default: {
      const m = enc.match(/windows(\d+)/)
      if (m) {
        return 'windows-' + m[1]
      }
      return enc
    }
  }
}

const ignorePathCase = process.platform === 'win32' || process.platform === 'darwin'

function toSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** The path of `candidate` below `folder`, with forward slashes ('' for the folder itself), or undefined. */
function relativeInside(folder: string, candidate: string): string | undefined {
  const f = toSlashes(folder)
  const c = toSlashes(candidate)
  const fc = ignorePathCase ? f.toLowerCase() : f
  const cc = ignorePathCase ? c.toLowerCase() : c
  if (cc === fc) return ''
  if (cc.startsWith(fc + '/')) return c.substring(f.length + 1)
  return undefined
}

/** The expression with every key that is an absolute path inside `folder` rewritten relative to it. */
function relativizeExpression(expression: IExpression | undefined, folder: string): IExpression | undefined {
  if (!expression) return expression
  const result: IExpression = {}
  for (const key of Object.keys(expression)) {
    const rel = relativeInside(folder, key)
    result[rel === undefined || rel === '' ? key : rel] = expression[key]!
  }
  return result
}

interface FolderQueryInfo {
  queryTester: QueryGlobTester
  folder: string
  folderIdx: number
  /** The folder query with its globs relative to its folder. */
  folderQuery: IFolderQuery
  includePattern: IExpression | undefined
  excludePattern: IExpression | undefined
}

export class TextSearchManager {
  private collector: TextSearchResultsCollector | null = null
  private isLimitHit = false
  private resultCount = 0
  private readonly query: ITextQuery
  private readonly provider: ITextSearchProvider
  private readonly processType: ITextSearchStats['type']

  constructor(query: ITextQuery, provider: ITextSearchProvider, processType: ITextSearchStats['type'] = 'searchProcess') {
    this.query = query
    this.provider = provider
    this.processType = processType
  }

  /** The limit that the provider is given, and that is applied to the results it reports. */
  private get maxResults(): number {
    return this.query.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS
  }

  search(onProgress: (matches: IFileMatch[]) => void, signal?: AbortSignal): Promise<ISearchCompleteStats> {
    const folderQueries = this.query.folderQueries || []
    const tokenSource = new AbortController()
    const forwardAbort = () => tokenSource.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) tokenSource.abort()
    const dispose = () => signal?.removeEventListener('abort', forwardAbort)

    return new Promise<ISearchCompleteStats>((resolve, reject) => {
      this.collector = new TextSearchResultsCollector(onProgress)

      let isCanceled = false
      const onResult = (result: ITextSearchResult, folderIdx: number) => {
        if (isCanceled) {
          return
        }
        if (!this.isLimitHit) {
          const isMatch = isTextSearchMatch(result)
          const resultSize = this.resultSize(result)
          if (isMatch && this.resultCount + resultSize > this.maxResults) {
            this.isLimitHit = true
            isCanceled = true
            tokenSource.abort()
            result = this.trimResultToSize(result as ITextSearchMatch, this.maxResults - this.resultCount)
          }
          const newResultSize = this.resultSize(result)
          this.resultCount += newResultSize
          if (newResultSize > 0 || !isMatch) {
            this.collector!.add(result, folderIdx)
          }
        }
      }

      this.doSearch(folderQueries, onResult, tokenSource.signal).then(result => {
        dispose()
        this.collector!.flush()
        resolve({
          limitHit: this.isLimitHit || result?.limitHit,
          messages: this.getMessagesFromResults(result),
          stats: { type: this.processType },
        })
      }, (err: unknown) => {
        dispose()
        reject(new Error(err instanceof Error ? err.message : String(err)))
      })
    })
  }

  private getMessagesFromResults(result: TextSearchComplete2 | null | undefined) {
    if (!result?.message) { return [] }
    if (Array.isArray(result.message)) { return result.message }
    return [result.message]
  }

  private resultSize(result: ITextSearchResult): number {
    if (isTextSearchMatch(result)) {
      return result.rangeLocations.length
    }
    // context lines do not count towards the result count (vscode#104400)
    return 0
  }

  private trimResultToSize(result: ITextSearchMatch, size: number): ITextSearchMatch {
    return { ...result, rangeLocations: result.rangeLocations.slice(0, size) }
  }

  private async doSearch(folderQueries: IFolderQuery[], onResult: (result: ITextSearchResult, folderIdx: number) => void, signal: AbortSignal): Promise<TextSearchComplete2 | null | undefined> {
    const infos: FolderQueryInfo[] = folderQueries.map((fq, i) => {
      const includePattern = relativizeExpression(this.query.includePattern, fq.folder)
      const excludePattern = relativizeExpression(this.query.excludePattern, fq.folder)
      const folderQuery: IFolderQuery = {
        ...fq,
        includePattern: relativizeExpression(fq.includePattern, fq.folder),
        excludePattern: fq.excludePattern?.map(e => ({ ...e, pattern: relativizeExpression(e.pattern, fq.folder)! })),
      }
      const queryTester = new QueryGlobTester({ includePattern, excludePattern, ignoreGlobCase: this.query.ignoreGlobCase }, folderQuery)
      return { queryTester, folder: fq.folder, folderIdx: i, folderQuery, includePattern, excludePattern }
    })

    // The deepest folder query that contains the path
    const findFolder = (path: string): { info: FolderQueryInfo; relativePath: string } | undefined => {
      let best: { info: FolderQueryInfo; relativePath: string } | undefined
      for (const info of infos) {
        const relativePath = relativeInside(info.folder, path)
        if (relativePath !== undefined && (!best || toSlashes(info.folder).length > toSlashes(best.info.folder).length)) {
          best = { info, relativePath }
        }
      }
      return best
    }

    const report = (result: ITextSearchResult) => {
      if (result.uri === undefined) {
        throw Error('Text search result URI is undefined. Please check provider implementation.')
      }
      const found = findFolder(result.uri)
      if (found && found.relativePath) {
        if (found.info.queryTester.includedInQuery(found.relativePath, basename(found.relativePath))) {
          onResult(result, found.info.folderIdx)
        }
      }
    }

    const searchOptions: TextSearchProviderOptions = {
      folderOptions: infos.map(info => this.getSearchOptionsForFolder(info)),
      maxFileSize: this.query.maxFileSize,
      maxResults: this.maxResults,
      previewOptions: this.query.previewOptions ?? DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS,
      surroundingContext: this.query.surroundingContext ?? 0,
    }

    return this.provider.provideTextSearchResults(patternInfoToQuery(this.query.contentPattern), searchOptions, report, signal)
  }

  private getSearchOptionsForFolder(info: FolderQueryInfo): TextSearchProviderFolderOptions {
    const fq = info.folderQuery
    const includes = resolvePatternsForProvider(info.includePattern, fq.includePattern)

    let excludePattern = fq.excludePattern?.map(e => ({
      folder: e.folder,
      patterns: resolveExcludePatternsForProvider(info.excludePattern, e.pattern),
    }))
    if (!excludePattern || excludePattern.length === 0) {
      excludePattern = [{
        folder: undefined,
        patterns: resolveExcludePatternsForProvider(info.excludePattern, undefined),
      }]
    }
    const excludes = excludePattern.flatMap(e => e.patterns)

    return {
      folder: fq.folder,
      excludes,
      includes,
      useIgnoreFiles: {
        local: !fq.disregardIgnoreFiles,
        parent: !fq.disregardParentIgnoreFiles,
        global: !fq.disregardGlobalIgnoreFiles,
      },
      followSymlinks: !fq.ignoreSymlinks,
      encoding: (fq.fileEncoding && toCanonicalName(fq.fileEncoding)) ?? '',
      ignoreGlobCase: this.query.ignoreGlobCase || fq.ignoreGlobCase,
    }
  }
}

function isTextSearchMatch(result: ITextSearchResult): result is ITextSearchMatch {
  return 'rangeLocations' in result
}

export function patternInfoToQuery(patternInfo: IPatternInfo): TextSearchQuery2 {
  return {
    isCaseSensitive: patternInfo.isCaseSensitive || false,
    isRegExp: patternInfo.isRegExp || false,
    isWordMatch: patternInfo.isWordMatch || false,
    isMultiline: patternInfo.isMultiline || false,
    pattern: patternInfo.pattern,
  }
}

/**
 * Groups consecutive results of the same file (and folder) into one IFileMatch, and hands them on through a
 * BatchedCollector of 512. This relies on rg reporting the results one file at a time.
 */
export class TextSearchResultsCollector {
  private _batchedCollector: BatchedCollector<IFileMatch>
  private _currentFolderIdx = -1
  private _currentUri: string | undefined
  private _currentFileMatch: IFileMatch | null = null
  private _onResult: (result: IFileMatch[]) => void

  constructor(onResult: (result: IFileMatch[]) => void) {
    this._onResult = onResult
    this._batchedCollector = new BatchedCollector<IFileMatch>(512, items => this.sendItems(items))
  }

  add(data: ITextSearchResult, folderIdx: number): void {
    if (this._currentFileMatch && (this._currentFolderIdx !== folderIdx || this._currentUri !== data.uri)) {
      this.pushToCollector()
      this._currentFileMatch = null
    }

    if (!this._currentFileMatch) {
      this._currentFolderIdx = folderIdx
      this._currentUri = data.uri
      this._currentFileMatch = {
        resource: data.uri!,
        results: [],
      }
    }

    this._currentFileMatch.results!.push(extensionResultToFrontendResult(data))
  }

  private pushToCollector(): void {
    const size = this._currentFileMatch && this._currentFileMatch.results ?
      this._currentFileMatch.results.length :
      0
    this._batchedCollector.addItem(this._currentFileMatch!, size)
  }

  flush(): void {
    this.pushToCollector()
    this._batchedCollector.flush()
  }

  private sendItems(items: IFileMatch[]): void {
    this._onResult(items)
  }
}

/** The result without its `uri` (the file match carries it). */
function extensionResultToFrontendResult(data: ITextSearchResult): ITextSearchResult {
  if (isTextSearchMatch(data)) {
    return { previewText: data.previewText, rangeLocations: data.rangeLocations }
  }
  return { text: data.text, lineNumber: data.lineNumber }
}

/**
 * Collects items that have a size. Until the sizes add up to START_BATCH_AFTER_COUNT, the callback gets every item
 * at once; after that, batches of `maxBatchSize`, or whatever was collected when a batch does not fill in TIMEOUT ms.
 */
export class BatchedCollector<T> {
  static readonly TIMEOUT = 4000

  // After START_BATCH_AFTER_COUNT items have been collected, stop flushing on every item
  static readonly START_BATCH_AFTER_COUNT = 50

  private totalNumberCompleted = 0
  private batch: T[] = []
  private batchSize = 0
  private timeoutHandle: ReturnType<typeof setTimeout> | undefined
  private maxBatchSize: number
  private cb: (items: T[]) => void

  constructor(maxBatchSize: number, cb: (items: T[]) => void) {
    this.maxBatchSize = maxBatchSize
    this.cb = cb
  }

  addItem(item: T, size: number): void {
    if (!item) {
      return
    }
    this.addItemToBatch(item, size)
  }

  addItems(items: T[], size: number): void {
    if (!items) {
      return
    }
    this.addItemsToBatch(items, size)
  }

  private addItemToBatch(item: T, size: number): void {
    this.batch.push(item)
    this.batchSize += size
    this.onUpdate()
  }

  private addItemsToBatch(item: T[], size: number): void {
    this.batch = this.batch.concat(item)
    this.batchSize += size
    this.onUpdate()
  }

  private onUpdate(): void {
    if (this.totalNumberCompleted < BatchedCollector.START_BATCH_AFTER_COUNT) {
      // Flush because we aren't batching yet
      this.flush()
    } else if (this.batchSize >= this.maxBatchSize) {
      // Flush because the batch is full
      this.flush()
    } else if (!this.timeoutHandle) {
      // No timeout running, start a timeout to flush
      this.timeoutHandle = setTimeout(() => {
        this.flush()
      }, BatchedCollector.TIMEOUT)
    }
  }

  flush(): void {
    if (this.batchSize) {
      this.totalNumberCompleted += this.batchSize
      this.cb(this.batch)
      this.batch = []
      this.batchSize = 0

      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle)
        this.timeoutHandle = undefined
      }
    }
  }
}

