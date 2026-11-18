/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's search results model: the tree result -> folder -> file -> match, with counts, removal, the
// replace text of each match and the sort orders the search view uses. Pure: no DOM, no Monaco, no `node:`.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/contrib/search/browser/searchTreeModel/match.ts              (MatchImpl, textSearchResultToMatches)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/fileMatch.ts          (FileMatchImpl)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/folderMatch.ts        (FolderMatchImpl, FolderMatchWithResourceImpl,
//                                                                                 FolderMatchWorkspaceRootImpl, FolderMatchNoRootImpl)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/textSearchHeading.ts  (TextSearchHeadingImpl,
//                                                                                 PlainTextSearchHeadingImpl: merged into SearchResult)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/searchResult.ts       (SearchResultImpl: merged into SearchResult)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/searchModel.ts        (SearchModelImpl: the replace state only)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/searchTreeCommon.ts   (prefixes, IChangeEvent, mergeSearchResultEvents,
//                                                                                 arrayContainsElementOrParent, createParentList,
//                                                                                 getFileMatches)
//   src/vs/workbench/contrib/search/browser/searchCompare.ts                      (searchMatchComparer, searchComparer)
//   src/vs/workbench/contrib/search/browser/searchView.ts                         (SearchViewDataSource getChildren and the
//                                                                                 create*Iterator helpers: childrenOf;
//                                                                                 originalShouldCollapse: shouldCollapse)
//   src/vs/workbench/services/search/common/searchHelpers.ts                      (editorMatchesToTextSearchResults,
//                                                                                 getTextSearchMatchWithModelContext)
//   src/vs/workbench/services/search/common/search.ts                             (SearchSortOrder)
//   src/vs/base/common/comparers.ts                                               (compareFileNames, compareFileExtensions,
//                                                                                 comparePaths)
//   src/vs/base/common/strings.ts                                                 (lcut)
//   src/vs/editor/common/core/range.ts                                            (Range.toString, compareRangesUsingStarts)
// Changes:
//   Resources are absolute path strings, not URIs. Path identity (equality, parent/child, map keys) accepts `\` and `/`
//   as separators and folds case when the SearchResult is built with `caseInsensitive: true` (VS Code's
//   IUriIdentityService.extUri). ResourceMap and TernarySearchTree.findSubstr become a Map keyed by the normalized
//   path and a walk up the ancestors. Labels (ILabelService) are the path basename.
//   The plain-text heading and the search result are one class (no AI heading); its PauseableEmitter is a pause
//   counter with the same merge.
//   `FileMatch.matches()` is sorted by position (VS Code returns insertion order and lets the tree sort).
//   `FileMatch.setResults()` replaces every match of the file at once, as updateMatchesForModel does when the file is
//   open in an editor; the caller computes the results from its buffer (see editorMatchesToTextSearchResults).
//   Replacing is data: `editsOf` says what to write; the caller writes it and then removes the elements.
//   `SearchModel` keeps only the replace state and the query; it never runs a search.
// Left out: editor decorations and highlights, model binding (bindModel, updateMatchesForModel as an event, the
// 250 ms update scheduler), match selection, notebooks, AI results, the replace service (replace, replaceAll,
// batchReplace), readonly matches, file stats (the Modified sort order falls back to the default, as VS Code does
// for a file without a stat), telemetry, SearchViewModelWorkbenchService, running searches, cached search complete.

import { Emitter, type Event } from './vscode-event.ts'
import {
  resultIsMatch,
  TextSearchMatch,
  SearchRange,
  type IFileMatch,
  type ISearchRange,
  type ITextQuery,
  type ITextSearchContext,
  type ITextSearchMatch,
  type ITextSearchPreviewOptions,
  type ITextSearchResult,
} from './vscode-search.ts'
import { ReplacePattern } from './vscode-search-replace.ts'

export type { Event } from './vscode-event.ts'

//#region common

export const SEARCH_MODEL_PREFIX = 'SEARCH_MODEL_'
export const SEARCH_RESULT_PREFIX = 'SEARCH_RESULT_'
export const FOLDER_MATCH_PREFIX = 'FOLDER_MATCH_'
export const FILE_MATCH_PREFIX = 'FILE_MATCH_'
export const MATCH_PREFIX = 'MATCH_'

/** One-based editor range (Monaco's IRange). */
export interface IRange {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

export interface IChangeEvent {
  elements: FileMatch[]
  added?: boolean
  removed?: boolean
  clearingAll?: boolean
}

export type RenderableMatch = FolderMatch | FileMatch | Match

export function mergeSearchResultEvents(events: IChangeEvent[]): IChangeEvent {
  const retEvent: IChangeEvent = {
    elements: [],
    added: false,
    removed: false,
  }
  events.forEach(e => {
    if (e.added) {
      retEvent.added = true
    }
    if (e.removed) {
      retEvent.removed = true
    }
    retEvent.elements = retEvent.elements.concat(e.elements)
  })
  return retEvent
}

export function arrayContainsElementOrParent(element: RenderableMatch, testArray: RenderableMatch[]): boolean {
  let current: RenderableMatch = element
  for (;;) {
    if (testArray.includes(current)) {
      return true
    }
    const parent: RenderableMatch | SearchResult = current.parent()
    if (parent instanceof SearchResult) {
      return false
    }
    current = parent
  }
}

export function createParentList(element: RenderableMatch): RenderableMatch[] {
  const parentArray: RenderableMatch[] = []
  let currElement: RenderableMatch | SearchResult = element
  while (!(currElement instanceof SearchResult)) {
    parentArray.push(currElement)
    currElement = currElement.parent()
  }
  return parentArray
}

export function getFileMatches(matches: (FileMatch | FolderMatchWithResource)[]): FileMatch[] {
  const folderMatches: FolderMatchWithResource[] = []
  const fileMatches: FileMatch[] = []
  matches.forEach(e => {
    if (e instanceof FileMatch) {
      fileMatches.push(e)
    } else {
      folderMatches.push(e)
    }
  })
  return fileMatches.concat(folderMatches.map(e => e.allDownstreamFileMatches()).flat())
}

//#endregion

//#region paths (stand-in for URI, ResourceMap, extUri and TernarySearchTree.forUris)

const DRIVE_ROOT = /^[A-Za-z]:\/$/

/** Path identity: `\` and `/` are the same separator; case folds when `caseInsensitive`. */
export class PathIdentity {
  readonly caseInsensitive: boolean

  constructor(caseInsensitive: boolean) {
    this.caseInsensitive = caseInsensitive
  }

  /** Map key: forward slashes, no trailing separator (except a root), case folded when case-insensitive. */
  key(path: string): string {
    let s = path.replace(/\\/g, '/')
    while (s.length > 1 && s.endsWith('/') && !DRIVE_ROOT.test(s)) {
      s = s.slice(0, -1)
    }
    return this.caseInsensitive ? s.toLowerCase() : s
  }

  isEqual(a: string, b: string): boolean {
    return this.key(a) === this.key(b)
  }

  isEqualOrParent(child: string, parent: string): boolean {
    const kc = this.key(child)
    const kp = this.key(parent)
    if (kc === kp) {
      return true
    }
    return kc.startsWith(kp.endsWith('/') ? kp : kp + '/')
  }

  /** Keys of `path` and of each ancestor, deepest first. */
  ancestorKeys(path: string): string[] {
    const keys: string[] = []
    let current = path
    for (;;) {
      keys.push(this.key(current))
      const parent = dirname(current)
      if (this.key(parent) === this.key(current)) {
        return keys
      }
      current = parent
    }
  }
}

function stripTrailingSeparators(path: string): string {
  let s = path
  while (s.length > 1 && (s.endsWith('/') || s.endsWith('\\')) && !DRIVE_ROOT.test(s.replace(/\\/g, '/'))) {
    s = s.slice(0, -1)
  }
  return s
}

/** Parent folder of `path`, keeping its separators; a root is its own parent. */
export function dirname(path: string): string {
  const p = stripTrailingSeparators(path)
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) {
    return p
  }
  if (i === 0) {
    return p.slice(0, 1)
  }
  if (i === 2 && p[1] === ':') {
    return p.slice(0, 3)
  }
  return p.slice(0, i)
}

export function basename(path: string): string {
  const p = stripTrailingSeparators(path)
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

//#endregion

//#region strings.ts lcut, range.ts helpers

/**
 * Given a string and a max length returns a shortened version keeping the end. Shortening happens at favorable
 * positions, such as whitespace or punctuation characters. Leading whitespace is always trimmed.
 */
export function lcut(text: string, n: number, prefix = ''): string {
  const trimmed = text.trimStart()

  if (trimmed.length < n) {
    return trimmed
  }

  const re = /\b/g
  let i = 0
  while (re.test(trimmed)) {
    if (trimmed.length - re.lastIndex < n) {
      break
    }

    i = re.lastIndex
    re.lastIndex += 1
  }

  if (i === 0) {
    return trimmed
  }

  return prefix + trimmed.substring(i).trimStart()
}

function rangeToString(r: IRange): string {
  return '[' + r.startLineNumber + ',' + r.startColumn + ' -> ' + r.endLineNumber + ',' + r.endColumn + ']'
}

/** Range.compareRangesUsingStarts: by start line, start column, end line, end column. */
export function compareRangesUsingStarts(a: IRange, b: IRange): number {
  if (a.startLineNumber !== b.startLineNumber) return a.startLineNumber - b.startLineNumber
  if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn
  if (a.endLineNumber !== b.endLineNumber) return a.endLineNumber - b.endLineNumber
  return a.endColumn - b.endColumn
}

//#endregion

//#region match.ts

export function textSearchResultToMatches(rawMatch: ITextSearchMatch, fileMatch: FileMatch): Match[] {
  const previewLines = rawMatch.previewText.split('\n')
  return rawMatch.rangeLocations.map(rangeLocation => {
    const previewRange: ISearchRange = rangeLocation.preview
    return new Match(fileMatch, previewLines, previewRange, rangeLocation.source)
  })
}

export interface MatchPreview {
  before: string
  fullBefore: string
  inside: string
  after: string
}

function computeReplaceString(match: Match, replacePattern: ReplacePattern | null, preserveCase: boolean): string {
  if (!replacePattern) {
    throw new Error('searchModel.replacePattern must be set before accessing replaceString')
  }

  const fullMatchText = match.fullMatchText()
  let replaceString = replacePattern.getReplaceString(fullMatchText, preserveCase)
  if (replaceString !== null) {
    return replaceString
  }

  // Search/find normalize line endings - check whether \r prevents regex from matching
  const fullMatchTextWithoutCR = fullMatchText.replace(/\r\n/g, '\n')
  if (fullMatchTextWithoutCR !== fullMatchText) {
    replaceString = replacePattern.getReplaceString(fullMatchTextWithoutCR, preserveCase)
    if (replaceString !== null) {
      return replaceString
    }
  }

  // If match string is not matching then regex pattern has a lookahead expression
  const contextMatchTextWithSurroundingContent = match.fullMatchText(true)
  replaceString = replacePattern.getReplaceString(contextMatchTextWithSurroundingContent, preserveCase)
  if (replaceString !== null) {
    return replaceString
  }

  // Search/find normalize line endings, this time in full context
  const contextMatchTextWithoutCR = contextMatchTextWithSurroundingContent.replace(/\r\n/g, '\n')
  if (contextMatchTextWithoutCR !== contextMatchTextWithSurroundingContent) {
    replaceString = replacePattern.getReplaceString(contextMatchTextWithoutCR, preserveCase)
    if (replaceString !== null) {
      return replaceString
    }
  }

  // Match string is still not matching. Could be unsupported matches (multi-line).
  return replacePattern.pattern
}

export class Match {
  private static readonly MAX_PREVIEW_CHARS = 250

  private readonly _parent: FileMatch
  private readonly _fullPreviewLines: string[]
  private readonly _id: string
  private readonly _range: IRange
  private readonly _oneLinePreviewText: string
  private readonly _rangeInPreviewText: ISearchRange
  // For replace
  private readonly _fullPreviewRange: ISearchRange
  private _preview: MatchPreview | undefined

  /** `fullPreviewRange` and `documentRange` are zero-based, as the search engine reports them. */
  constructor(parent: FileMatch, fullPreviewLines: string[], fullPreviewRange: ISearchRange, documentRange: ISearchRange) {
    this._parent = parent
    this._fullPreviewLines = fullPreviewLines
    this._oneLinePreviewText = fullPreviewLines[fullPreviewRange.startLineNumber] ?? ''
    const adjustedEndCol = fullPreviewRange.startLineNumber === fullPreviewRange.endLineNumber
      ? fullPreviewRange.endColumn
      : this._oneLinePreviewText.length
    this._rangeInPreviewText = new SearchRange(1, fullPreviewRange.startColumn + 1, 1, adjustedEndCol + 1)

    this._range = {
      startLineNumber: documentRange.startLineNumber + 1,
      startColumn: documentRange.startColumn + 1,
      endLineNumber: documentRange.endLineNumber + 1,
      endColumn: documentRange.endColumn + 1,
    }

    this._fullPreviewRange = fullPreviewRange

    this._id = MATCH_PREFIX + this._parent.resource + '>' + rangeToString(this._range) + this.getMatchString()
  }

  id(): string {
    return this._id
  }

  parent(): FileMatch {
    return this._parent
  }

  text(): string {
    return this._oneLinePreviewText
  }

  /** One-based document range. */
  range(): IRange {
    return this._range
  }

  preview(): MatchPreview {
    if (this._preview) {
      return this._preview
    }
    const fullBefore = this._oneLinePreviewText.substring(0, this._rangeInPreviewText.startColumn - 1)
    const before = lcut(fullBefore, 26, '…')

    let inside = this.getMatchString()
    let after = this._oneLinePreviewText.substring(this._rangeInPreviewText.endColumn - 1)

    let charsRemaining = Match.MAX_PREVIEW_CHARS - before.length
    inside = inside.substring(0, Math.max(0, charsRemaining))
    charsRemaining -= inside.length
    after = after.substring(0, Math.max(0, charsRemaining))

    this._preview = { before, fullBefore, inside, after }
    return this._preview
  }

  get replaceString(): string {
    const searchModel = this.parent().parent().searchModel
    if (!searchModel) {
      throw new Error('searchModel.replacePattern must be set before accessing replaceString')
    }
    return computeReplaceString(this, searchModel.replacePattern, searchModel.preserveCase)
  }

  fullMatchText(includeSurrounding = false): string {
    let thisMatchPreviewLines: string[]
    if (includeSurrounding) {
      thisMatchPreviewLines = this._fullPreviewLines
    } else {
      thisMatchPreviewLines = this._fullPreviewLines.slice(this._fullPreviewRange.startLineNumber, this._fullPreviewRange.endLineNumber + 1)
      const last = thisMatchPreviewLines.length - 1
      thisMatchPreviewLines[last] = (thisMatchPreviewLines[last] ?? '').slice(0, this._fullPreviewRange.endColumn)
      thisMatchPreviewLines[0] = (thisMatchPreviewLines[0] ?? '').slice(this._fullPreviewRange.startColumn)
    }

    return thisMatchPreviewLines.join('\n')
  }

  /** The match range in the preview lines; columns converted to the editor's base 1, lines left as they are. */
  rangeInPreview(): ISearchRange {
    return {
      ...this._fullPreviewRange,
      startColumn: this._fullPreviewRange.startColumn + 1,
      endColumn: this._fullPreviewRange.endColumn + 1,
    }
  }

  fullPreviewLines(): string[] {
    return this._fullPreviewLines.slice(this._fullPreviewRange.startLineNumber, this._fullPreviewRange.endLineNumber + 1)
  }

  getMatchString(): string {
    return this._oneLinePreviewText.substring(this._rangeInPreviewText.startColumn - 1, this._rangeInPreviewText.endColumn - 1)
  }
}

//#endregion

//#region fileMatch.ts

export interface FileMatchChangeEvent {
  didRemove?: boolean
  forceUpdateModel?: boolean
}

export class FileMatch {
  private readonly _onChange = new Emitter<FileMatchChangeEvent>()
  readonly onChange: Event<FileMatchChangeEvent> = this._onChange.event

  private readonly _onDispose = new Emitter<void>()
  readonly onDispose: Event<void> = this._onDispose.event

  private readonly _resource: string
  private readonly _parent: FolderMatch
  private readonly _closestRoot: FolderMatchWorkspaceRoot | null
  private readonly rawMatch: IFileMatch
  private _textMatches = new Map<string, Match>()
  private readonly _removedTextMatches = new Set<string>()
  private readonly _context = new Map<number, string>()
  private _disposed = false

  get context(): Map<number, string> {
    return new Map(this._context)
  }

  constructor(parent: FolderMatch, rawMatch: IFileMatch, closestRoot: FolderMatchWorkspaceRoot | null) {
    this._parent = parent
    this.rawMatch = rawMatch
    this._resource = rawMatch.resource
    this._closestRoot = closestRoot
  }

  get closestRoot(): FolderMatchWorkspaceRoot | null {
    return this._closestRoot
  }

  createMatches(): void {
    if (this.rawMatch.results) {
      this.rawMatch.results
        .filter(resultIsMatch)
        .forEach(rawMatch => {
          textSearchResultToMatches(rawMatch, this).forEach(m => this.add(m))
        })
      // Not in VS Code (which adds context only when a later batch hits an existing file): keep the context lines
      // that came with the first batch too.
      this.addContext(this.rawMatch.results)
    }
  }

  /**
   * Replaces every match of the file with `results` (matches and context lines), as VS Code's updateMatchesForModel
   * does when the file is open in an editor. Matches the user removed stay removed. The file leaves its folder when
   * no match is left and comes back when a later call brings matches.
   */
  setResults(results: ITextSearchResult[]): void {
    this._textMatches = new Map<string, Match>()
    results.filter(resultIsMatch).forEach(textSearchResult => {
      textSearchResultToMatches(textSearchResult, this).forEach(match => {
        if (!this._removedTextMatches.has(match.id())) {
          this.add(match)
        }
      })
    })
    this._context.clear()
    this.addContext(results)
    this._onChange.fire({ forceUpdateModel: true })
  }

  id(): string {
    return FILE_MATCH_PREFIX + this.resource
  }

  parent(): FolderMatch {
    return this._parent
  }

  get hasChildren(): boolean {
    return this._textMatches.size > 0
  }

  /** The matches, sorted by position in the file. */
  matches(): Match[] {
    return [...this._textMatches.values()].sort((a, b) => compareRangesUsingStarts(a.range(), b.range()))
  }

  remove(matches: Match | Match[]): void {
    if (!Array.isArray(matches)) {
      matches = [matches]
    }

    for (const match of matches) {
      this._textMatches.delete(match.id())
      this._removedTextMatches.add(match.id())
    }

    this._onChange.fire({ didRemove: true })
  }

  count(): number {
    return this._textMatches.size
  }

  /** Absolute path of the file. */
  get resource(): string {
    return this._resource
  }

  name(): string {
    return basename(this.resource)
  }

  addContext(results: ITextSearchResult[] | undefined): void {
    if (!results) { return }

    const contexts = results.filter((result): result is ITextSearchContext => !resultIsMatch(result))

    contexts.forEach(context => this._context.set(context.lineNumber, context.text))
  }

  add(match: Match, trigger?: boolean): void {
    this._textMatches.set(match.id(), match)
    if (trigger) {
      this._onChange.fire({ forceUpdateModel: true })
    }
  }

  get isDisposed(): boolean {
    return this._disposed
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onDispose.fire()
    this._onChange.dispose()
    this._onDispose.dispose()
  }
}

//#endregion

//#region folderMatch.ts

export class FolderMatch {
  protected readonly _onChange = new Emitter<IChangeEvent>()
  readonly onChange: Event<IChangeEvent> = this._onChange.event

  private readonly _onDispose = new Emitter<void>()
  readonly onDispose: Event<void> = this._onDispose.event

  protected readonly _resource: string | null
  protected readonly _index: number
  protected readonly _query: ITextQuery
  private readonly _parent: SearchResult | FolderMatch
  protected readonly _searchResult: SearchResult
  private readonly _closestRoot: FolderMatchWorkspaceRoot | null
  private readonly _id: string
  protected readonly _fileMatches = new Map<string, FileMatch>()
  protected readonly _folderMatches = new Map<string, FolderMatchWithResource>()
  protected readonly _unDisposedFileMatches = new Map<string, FileMatch>()
  private _disposed = false

  constructor(resource: string | null, id: string, index: number, query: ITextQuery, parent: SearchResult | FolderMatch, searchResult: SearchResult, closestRoot: FolderMatchWorkspaceRoot | null) {
    this._resource = resource
    this._index = index
    this._query = query
    this._parent = parent
    this._searchResult = searchResult
    this._closestRoot = closestRoot
    this._id = FOLDER_MATCH_PREFIX + id
  }

  protected get paths(): PathIdentity {
    return this._searchResult.paths
  }

  get searchModel(): SearchModel | null {
    return this._searchResult.searchModel
  }

  get closestRoot(): FolderMatchWorkspaceRoot | null {
    return this._closestRoot
  }

  id(): string {
    return this._id
  }

  get resource(): string | null {
    return this._resource
  }

  index(): number {
    return this._index
  }

  name(): string {
    return this.resource ? basename(this.resource) : ''
  }

  parent(): SearchResult | FolderMatch {
    return this._parent
  }

  get hasChildren(): boolean {
    return this._fileMatches.size > 0 || this._folderMatches.size > 0
  }

  createIntermediateFolderMatch(resource: string, id: string, index: number, query: ITextQuery, baseWorkspaceFolder: FolderMatchWorkspaceRoot): FolderMatchWithResource {
    const folderMatch = new FolderMatchWithResource(resource, id, index, query, this, this._searchResult, baseWorkspaceFolder)
    this.configureIntermediateMatch(folderMatch)
    this.doAddFolder(folderMatch)
    return folderMatch
  }

  configureIntermediateMatch(folderMatch: FolderMatchWithResource): void {
    folderMatch.onChange(event => this.onFolderChange(folderMatch, event))
  }

  clear(clearingAll = false): void {
    const changed: FileMatch[] = this.allDownstreamFileMatches()
    this.disposeMatches()
    this._onChange.fire({ elements: changed, removed: true, added: false, clearingAll })
  }

  remove(matches: FileMatch | FolderMatchWithResource | (FileMatch | FolderMatchWithResource)[]): void {
    if (!Array.isArray(matches)) {
      matches = [matches]
    }
    const allMatches = getFileMatches(matches)
    this.doRemoveFile(allMatches)
  }

  /** Direct children: files first, then folders. */
  matches(): (FileMatch | FolderMatchWithResource)[] {
    return [...this.fileMatchesIterator(), ...this.folderMatchesIterator()]
  }

  fileMatchesIterator(): IterableIterator<FileMatch> {
    return this._fileMatches.values()
  }

  folderMatchesIterator(): IterableIterator<FolderMatchWithResource> {
    return this._folderMatches.values()
  }

  isEmpty(): boolean {
    return (this.fileCount() + this.folderCount()) === 0
  }

  getDownstreamFileMatch(resource: string): FileMatch | null {
    const directChildFileMatch = this._fileMatches.get(this.paths.key(resource))
    if (directChildFileMatch) {
      return directChildFileMatch
    }

    const folderMatch = this.getFolderMatch(resource)
    const match = folderMatch?.getDownstreamFileMatch(resource)
    if (match) {
      return match
    }

    return null
  }

  allDownstreamFileMatches(): FileMatch[] {
    let recursiveChildren: FileMatch[] = []
    for (const elem of this.folderMatchesIterator()) {
      recursiveChildren = recursiveChildren.concat(elem.allDownstreamFileMatches())
    }

    return [...this.fileMatchesIterator(), ...recursiveChildren]
  }

  /** Direct child files. */
  fileCount(): number {
    return this._fileMatches.size
  }

  /** Direct child folders. */
  folderCount(): number {
    return this._folderMatches.size
  }

  /** Direct children (files and folders). */
  count(): number {
    return this.fileCount() + this.folderCount()
  }

  recursiveFileCount(): number {
    return this.allDownstreamFileMatches().length
  }

  recursiveMatchCount(): number {
    return this.allDownstreamFileMatches().reduce<number>((prev, match) => prev + match.count(), 0)
  }

  get query(): ITextQuery | null {
    return this._query
  }

  doAddFile(fileMatch: FileMatch): void {
    const key = this.paths.key(fileMatch.resource)
    this._fileMatches.set(key, fileMatch)
    this._unDisposedFileMatches.delete(key)
  }

  protected uriHasParent(parent: string, child: string): boolean {
    return this.paths.isEqualOrParent(child, parent) && !this.paths.isEqual(child, parent)
  }

  private isInParentChain(folderMatch: FolderMatchWithResource): boolean {
    let matchItem: FolderMatch | SearchResult = this
    while (matchItem instanceof FolderMatch) {
      if (matchItem.id() === folderMatch.id()) {
        return true
      }
      matchItem = matchItem.parent()
    }
    return false
  }

  /** The direct child folder that is `resource` or one of its ancestors (TernarySearchTree.findSubstr). */
  getFolderMatch(resource: string): FolderMatchWithResource | undefined {
    if (this._folderMatches.size === 0) {
      return undefined
    }
    for (const key of this.paths.ancestorKeys(resource)) {
      const folderMatch = this._folderMatches.get(key)
      if (folderMatch) {
        return folderMatch
      }
    }
    return undefined
  }

  doAddFolder(folderMatch: FolderMatchWithResource): void {
    if (this.resource && !this.uriHasParent(this.resource, folderMatch.resource)) {
      throw Error(`${folderMatch.resource} does not belong as a child of ${this.resource}`)
    } else if (this.isInParentChain(folderMatch)) {
      throw Error(`${folderMatch.resource} is a parent of ${this.resource}`)
    }

    this._folderMatches.set(this.paths.key(folderMatch.resource), folderMatch)
  }

  onFileChange(fileMatch: FileMatch, removed = false): void {
    let added = false
    if (!this._fileMatches.has(this.paths.key(fileMatch.resource))) {
      this.doAddFile(fileMatch)
      added = true
    }
    if (fileMatch.count() === 0) {
      this.doRemoveFile([fileMatch], false, false)
      added = false
      removed = true
    }
    this._onChange.fire({ elements: [fileMatch], added, removed })
  }

  onFolderChange(folderMatch: FolderMatchWithResource, event: IChangeEvent): void {
    const key = this.paths.key(folderMatch.resource)
    if (!this._folderMatches.has(key)) {
      this.doAddFolder(folderMatch)
    }
    if (folderMatch.isEmpty()) {
      this._folderMatches.delete(key)
      folderMatch.dispose()
    }

    this._onChange.fire(event)
  }

  doRemoveFile(fileMatches: FileMatch[], dispose = true, trigger = true): void {
    const removed: FileMatch[] = []
    for (const match of fileMatches) {
      const key = this.paths.key(match.resource)
      if (this._fileMatches.get(key)) {
        this._fileMatches.delete(key)
        if (dispose) {
          match.dispose()
        } else {
          this._unDisposedFileMatches.set(key, match)
        }
        removed.push(match)
      } else {
        const folder = this.getFolderMatch(match.resource)
        if (folder) {
          folder.doRemoveFile([match], dispose, trigger)
        } else {
          throw Error(`FileMatch ${match.resource} is not located within FolderMatch ${this.resource}`)
        }
      }
    }

    if (trigger) {
      this._onChange.fire({ elements: removed, removed: true })
    }
  }

  addFileMatch(raw: IFileMatch[], silent: boolean): void {
    // when adding a fileMatch that has intermediate directories
    const added: FileMatch[] = []
    const updated: FileMatch[] = []

    raw.forEach(rawFileMatch => {
      const existingFileMatch = this.getDownstreamFileMatch(rawFileMatch.resource)
      if (existingFileMatch) {
        if (rawFileMatch.results) {
          rawFileMatch
            .results
            .filter(resultIsMatch)
            .forEach(m => {
              textSearchResultToMatches(m, existingFileMatch).forEach(m => existingFileMatch.add(m))
            })
        }

        updated.push(existingFileMatch)

        if (rawFileMatch.results && rawFileMatch.results.length > 0) {
          existingFileMatch.addContext(rawFileMatch.results)
        }
      } else if (this instanceof FolderMatchWorkspaceRoot || this instanceof FolderMatchNoRoot) {
        const fileMatch = this.createAndConfigureFileMatch(rawFileMatch)
        added.push(fileMatch)
      }
    })

    const elements = [...added, ...updated]
    if (!silent && elements.length) {
      this._onChange.fire({ elements, added: !!added.length })
    }
  }

  disposeMatches(): void {
    // VS Code only clears the child folders (disposeMatches) and keeps them in its lookup tree; here the lookup is the
    // child map itself, so the children are disposed and forgotten.
    ;[...this._fileMatches.values()].forEach(fileMatch => fileMatch.dispose())
    ;[...this._folderMatches.values()].forEach(folderMatch => folderMatch.dispose())
    ;[...this._unDisposedFileMatches.values()].forEach(fileMatch => fileMatch.dispose())
    this._fileMatches.clear()
    this._folderMatches.clear()
    this._unDisposedFileMatches.clear()
  }

  get isDisposed(): boolean {
    return this._disposed
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this.disposeMatches()
    this._onDispose.fire()
    this._onChange.dispose()
    this._onDispose.dispose()
  }
}

export class FolderMatchWithResource extends FolderMatch {
  constructor(resource: string, id: string, index: number, query: ITextQuery, parent: SearchResult | FolderMatch, searchResult: SearchResult, closestRoot: FolderMatchWorkspaceRoot | null) {
    super(resource, id, index, query, parent, searchResult, closestRoot)
  }

  override get resource(): string {
    return this._resource!
  }
}

/**
 * FolderMatchWorkspaceRoot => folder for workspace root
 */
export class FolderMatchWorkspaceRoot extends FolderMatchWithResource {
  constructor(resource: string, id: string, index: number, query: ITextQuery, parent: SearchResult) {
    super(resource, id, index, query, parent, parent, null)
  }

  private createFileMatch(parent: FolderMatch, rawFileMatch: IFileMatch, closestRoot: FolderMatchWorkspaceRoot | null): FileMatch {
    const fileMatch = new FileMatch(parent, rawFileMatch, closestRoot)
    fileMatch.createMatches()
    parent.doAddFile(fileMatch)
    fileMatch.onChange(({ didRemove }) => parent.onFileChange(fileMatch, didRemove))
    return fileMatch
  }

  createAndConfigureFileMatch(rawFileMatch: IFileMatch): FileMatch {
    if (!this.uriHasParent(this.resource, rawFileMatch.resource)) {
      throw Error(`${rawFileMatch.resource} is not a descendant of ${this.resource}`)
    }

    const fileMatchParentParts: string[] = []
    let uri = dirname(rawFileMatch.resource)

    while (!this.paths.isEqual(this.resource, uri)) {
      fileMatchParentParts.unshift(uri)
      const prevUri = uri
      uri = dirname(uri)
      if (this.paths.isEqual(prevUri, uri)) {
        throw Error(`${rawFileMatch.resource} is not correctly configured as a child of ${this.resource}`)
      }
    }

    const root = this.closestRoot ?? this
    let parent: FolderMatchWithResource = this
    for (const part of fileMatchParentParts) {
      let folderMatch: FolderMatchWithResource | undefined = parent.getFolderMatch(part)
      if (!folderMatch) {
        folderMatch = parent.createIntermediateFolderMatch(part, part, -1, this._query, root)
      }
      parent = folderMatch
    }
    return this.createFileMatch(parent, rawFileMatch, root)
  }
}

/** The "other files" folder: files outside every workspace root, kept flat. */
export class FolderMatchNoRoot extends FolderMatch {
  constructor(id: string, index: number, query: ITextQuery, parent: SearchResult) {
    super(null, id, index, query, parent, parent, null)
  }

  createAndConfigureFileMatch(rawFileMatch: IFileMatch): FileMatch {
    const fileMatch = new FileMatch(this, rawFileMatch, null)
    fileMatch.createMatches()
    this.doAddFile(fileMatch)
    fileMatch.onChange(({ didRemove }) => this.onFileChange(fileMatch, didRemove))
    return fileMatch
  }
}

//#endregion

//#region searchResult.ts + textSearchHeading.ts

let searchResultCounter = 0

export interface SearchResultOptions {
  /** Folds case when comparing paths (Windows, macOS default volumes). */
  caseInsensitive: boolean
}

export class SearchResult {
  private readonly _onChange = new Emitter<IChangeEvent>()
  readonly onChange: Event<IChangeEvent> = this._onChange.event
  private _pauseDepth = 0
  private readonly _pausedEvents: IChangeEvent[] = []

  readonly searchModel: SearchModel | null
  readonly paths: PathIdentity
  private readonly _id: string
  private _isDirty = false
  private _query: ITextQuery | null = null
  private readonly _pastFolderMatches = new Set<FolderMatch>()
  private _folderMatches: FolderMatchWorkspaceRoot[] = []
  private _otherFilesMatch: FolderMatchNoRoot | null = null
  private _folderMatchesMap = new Map<string, FolderMatchWorkspaceRoot>()

  constructor(searchModel: SearchModel | null, options: SearchResultOptions) {
    this.searchModel = searchModel
    this.paths = new PathIdentity(options.caseInsensitive)
    this._id = SEARCH_RESULT_PREFIX + (++searchResultCounter)
    this.onChange(e => {
      if (e.removed) {
        this._isDirty = !this.isEmpty()
      }
    })
  }

  private fire(e: IChangeEvent): void {
    if (this._pauseDepth > 0) {
      this._pausedEvents.push(e)
      return
    }
    this._onChange.fire(e)
  }

  private pause(): void {
    this._pauseDepth++
  }

  private resume(): void {
    if (this._pauseDepth === 0 || --this._pauseDepth > 0) {
      return
    }
    if (this._pausedEvents.length > 0) {
      const events = this._pausedEvents.splice(0)
      this._onChange.fire(mergeSearchResultEvents(events))
    }
  }

  id(): string {
    return this._id
  }

  parent(): null {
    return null
  }

  get hasChildren(): boolean {
    return this._folderMatches.length > 0
  }

  /** True when the user removed some results and others are left. */
  get isDirty(): boolean {
    return this._isDirty
  }

  /** The deepest workspace root holding `resource`, else the "other files" folder. */
  getFolderMatch(resource: string): FolderMatch | undefined {
    const folderMatch = this.findFolderSubstr(resource)
    if (!folderMatch && this._otherFilesMatch) {
      return this._otherFilesMatch
    }
    return folderMatch
  }

  findFolderSubstr(resource: string): FolderMatchWorkspaceRoot | undefined {
    if (this._folderMatchesMap.size === 0) {
      return undefined
    }
    for (const key of this.paths.ancestorKeys(resource)) {
      const folderMatch = this._folderMatchesMap.get(key)
      if (folderMatch) {
        return folderMatch
      }
    }
    return undefined
  }

  add(allRaw: IFileMatch[], silent = false): void {
    // Split up raw into a list per folder so we can do a batch add per folder.
    const { byFolder, other } = this.groupFilesByFolder(allRaw)
    byFolder.forEach(raw => {
      if (!raw.length) {
        return
      }
      const folderMatch = this.getFolderMatch(raw[0]!.resource)
      folderMatch?.addFileMatch(raw, silent)
    })

    this._otherFilesMatch?.addFileMatch(other, silent)
    this.disposePastResults()
  }

  /**
   * Removes files and folders (a folder is cleared; an emptied intermediate folder leaves its parent).
   * Not in VS Code's SearchResult.remove: a Match is accepted too and removed from its file.
   */
  remove(matches: RenderableMatch | RenderableMatch[]): void {
    if (!Array.isArray(matches)) {
      matches = [matches]
    }

    matches.forEach(m => {
      if (m instanceof FolderMatch) {
        m.clear()
      } else if (m instanceof Match) {
        m.parent().remove(m)
      }
    })

    const fileMatches = matches.filter((m): m is FileMatch => m instanceof FileMatch)

    const { byFolder, other } = this.groupFilesByFolder(fileMatches)
    byFolder.forEach(matches => {
      if (!matches.length) {
        return
      }
      this.getFolderMatch(matches[0]!.resource)?.remove(matches)
    })

    if (other.length) {
      this.getFolderMatch(other[0]!.resource)?.remove(other)
    }
  }

  /** Removes a mix of matches, files and folders, skipping any element whose ancestor is also removed; one merged event. */
  batchRemove(elementsToRemove: RenderableMatch[]): void {
    // need to check that we aren't trying to remove elements twice
    const removedElems: RenderableMatch[] = []

    try {
      this.pause()
      elementsToRemove.forEach(currentElement => {
        if (!arrayContainsElementOrParent(currentElement, removedElems)) {
          if (currentElement instanceof FileMatch) {
            currentElement.parent().remove(currentElement)
          } else if (currentElement instanceof Match) {
            currentElement.parent().remove(currentElement)
          } else if (currentElement instanceof FolderMatchWithResource) {
            currentElement.parent().remove(currentElement)
          } else if (currentElement instanceof FolderMatchNoRoot) {
            this.remove(currentElement)
          }
          removedElems.push(currentElement)
        }
      })
    } finally {
      this.resume()
    }
  }

  private groupFilesByFolder<T extends IFileMatch | FileMatch>(fileMatches: T[]): { byFolder: Map<string, T[]>; other: T[] } {
    const rawPerFolder = new Map<string, T[]>()
    const otherFileMatches: T[] = []
    this._folderMatches.forEach(fm => rawPerFolder.set(this.paths.key(fm.resource), []))

    fileMatches.forEach(rawFileMatch => {
      const folderMatch = this.getFolderMatch(rawFileMatch.resource)
      if (!folderMatch) {
        // foldermatch was previously removed by user or disposed for some reason
        return
      }

      const resource = folderMatch.resource
      if (resource) {
        rawPerFolder.get(this.paths.key(resource))!.push(rawFileMatch)
      } else {
        otherFileMatches.push(rawFileMatch)
      }
    })

    return {
      byFolder: rawPerFolder,
      other: otherFileMatches,
    }
  }

  isEmpty(): boolean {
    return this.folderMatches().every(folderMatch => folderMatch.isEmpty())
  }

  get query(): ITextQuery | null {
    return this._query
  }

  /**
   * One workspace root per folder query, plus the "other files" folder. The previous roots keep their results until
   * the next `add` or `clear`, so the view does not flash empty while a new search starts.
   */
  set query(query: ITextQuery | null) {
    this.clearQuery()

    if (!query) {
      return
    }

    this._folderMatches = (query.folderQueries || [])
      .map(fq => fq.folder)
      .map((resource, index) => this._createBaseFolderMatch(resource, resource, index, query) as FolderMatchWorkspaceRoot)

    this._folderMatches.forEach(fm => this._folderMatchesMap.set(this.paths.key(fm.resource), fm))

    this._otherFilesMatch = this._createBaseFolderMatch(null, 'otherFiles', this._folderMatches.length + 1, query) as FolderMatchNoRoot

    this._query = query
  }

  private _createBaseFolderMatch(resource: string | null, id: string, index: number, query: ITextQuery): FolderMatch {
    const folderMatch = resource
      ? new FolderMatchWorkspaceRoot(resource, id, index, query, this)
      : new FolderMatchNoRoot(id, index, query, this)
    folderMatch.onChange(event => this.fire(event))
    return folderMatch
  }

  private clearQuery(): void {
    // When updating the query we could change the roots, so keep a reference to them to clean up when we trigger `disposePastResults`
    for (const folderMatch of this.folderMatches()) {
      this._pastFolderMatches.add(folderMatch)
    }
    this._folderMatchesMap = new Map()
  }

  folderMatches(): FolderMatch[] {
    return this._otherFilesMatch
      ? [...this._folderMatches, this._otherFilesMatch]
      : this._folderMatches
  }

  private disposeMatches(): void {
    this.folderMatches().forEach(folderMatch => {
      this._pastFolderMatches.delete(folderMatch)
      folderMatch.dispose()
    })

    this._folderMatches = []
    this._otherFilesMatch = null
    this._folderMatchesMap = new Map()
  }

  private disposePastResults(): void {
    const oldFolderMatches = [...this._pastFolderMatches]
    this._pastFolderMatches.clear()
    oldFolderMatches.forEach(match => match.clear())
    oldFolderMatches.forEach(match => match.dispose())
    this._isDirty = false
  }

  /** Every file with matches, across all roots. */
  matches(): FileMatch[] {
    const matches: FileMatch[][] = []
    this.folderMatches().forEach(folderMatch => {
      matches.push(folderMatch.allDownstreamFileMatches())
    })
    return ([] as FileMatch[]).concat(...matches)
  }

  fileCount(): number {
    return this.folderMatches().reduce<number>((prev, match) => prev + match.recursiveFileCount(), 0)
  }

  count(): number {
    return this.matches().reduce<number>((prev, match) => prev + match.count(), 0)
  }

  /** Drops every result and every root: set `query` again before the next `add`. */
  clear(clearAll = true): void {
    this.folderMatches().forEach(folderMatch => folderMatch.clear(clearAll))
    this.disposeMatches()
    this.disposePastResults()
  }

  dispose(): void {
    this.disposeMatches()
    this.disposePastResults()
    this._onChange.dispose()
  }
}

//#endregion

//#region searchModel.ts (replace state only)

let searchModelCounter = 0

export class SearchModel {
  private readonly _searchResult: SearchResult
  private _searchQuery: ITextQuery | null = null
  private _replaceActive = false
  private _replaceString: string | null = null
  private _replacePattern: ReplacePattern | null = null
  private _preserveCase = false
  private readonly _id: string

  private readonly _onReplaceTermChanged = new Emitter<void>()
  readonly onReplaceTermChanged: Event<void> = this._onReplaceTermChanged.event

  private readonly _onSearchResultChanged = new Emitter<IChangeEvent>()
  readonly onSearchResultChanged: Event<IChangeEvent> = this._onSearchResultChanged.event

  constructor(options: SearchResultOptions) {
    this._searchResult = new SearchResult(this, options)
    this._searchResult.onChange(e => this._onSearchResultChanged.fire(e))
    this._id = SEARCH_MODEL_PREFIX + (++searchModelCounter)
  }

  id(): string {
    return this._id
  }

  isReplaceActive(): boolean {
    return this._replaceActive
  }

  get replaceActive(): boolean {
    return this._replaceActive
  }

  set replaceActive(replaceActive: boolean) {
    this._replaceActive = replaceActive
  }

  get replacePattern(): ReplacePattern | null {
    return this._replacePattern
  }

  /** Whether the replace string refers to capture groups (`$1`, `$&`, ...): only with a regex query. */
  get hasParameters(): boolean {
    return !!this._replacePattern?.hasParameters
  }

  get replaceString(): string {
    return this._replaceString || ''
  }

  set replaceString(replaceString: string) {
    this._replaceString = replaceString
    if (this._searchQuery) {
      this._replacePattern = new ReplacePattern(replaceString, this._searchQuery.contentPattern)
    }
    this._onReplaceTermChanged.fire()
  }

  set preserveCase(value: boolean) {
    this._preserveCase = value
  }

  get preserveCase(): boolean {
    return this._preserveCase
  }

  get searchResult(): SearchResult {
    return this._searchResult
  }

  get query(): ITextQuery | null {
    return this._searchQuery
  }

  /**
   * What `search()` does before it starts the engine: remembers the query, gives it to the result (new roots) and
   * rebuilds the replace pattern. Whoever runs the search then feeds `searchResult.add`.
   */
  set query(query: ITextQuery | null) {
    this._searchQuery = query
    this._searchResult.query = query
    this._replacePattern = query ? new ReplacePattern(this.replaceString, query.contentPattern) : null
  }

  dispose(): void {
    this._searchResult.dispose()
    this._onReplaceTermChanged.dispose()
    this._onSearchResultChanged.dispose()
  }
}

//#endregion

//#region searchCompare.ts

export const SearchSortOrder = {
  Default: 'default',
  FileNames: 'fileNames',
  Type: 'type',
  /** Needs file stats, which this port does not keep: sorts as Default (VS Code does the same for a file without a stat). */
  Modified: 'modified',
  CountDescending: 'countDescending',
  CountAscending: 'countAscending',
} as const
export type SearchSortOrder = typeof SearchSortOrder[keyof typeof SearchSortOrder]

let fileNameCollator: { collator: Intl.Collator; collatorIsNumeric: boolean } | undefined

// A collator with numeric sorting enabled, and no sensitivity to case, accents or diacritics.
function intlFileNameCollatorBaseNumeric(): { collator: Intl.Collator; collatorIsNumeric: boolean } {
  if (!fileNameCollator) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    fileNameCollator = { collator, collatorIsNumeric: collator.resolvedOptions().numeric }
  }
  return fileNameCollator
}

/** Compares filenames without distinguishing the name from the extension. Disambiguates by unicode comparison. */
export function compareFileNames(one: string | null | undefined, other: string | null | undefined): number {
  const a = one || ''
  const b = other || ''
  const { collator, collatorIsNumeric } = intlFileNameCollatorBaseNumeric()
  const result = collator.compare(a, b)

  // Using the numeric option will make compare(`foo1`, `foo01`) === 0. Disambiguate.
  if (collatorIsNumeric && result === 0 && a !== b) {
    return a < b ? -1 : 1
  }

  return result
}

const FileNameMatch = /^(.*?)(\.([^.]*))?$/

function extractNameAndExtension(str?: string | null): [string, string] {
  const match = str ? FileNameMatch.exec(str) : null
  return [(match && match[1]) || '', (match && match[3]) || '']
}

/** Compares filenames by extension, then by name. */
export function compareFileExtensions(one: string | null, other: string | null): number {
  const [oneName, oneExtension] = extractNameAndExtension(one)
  const [otherName, otherExtension] = extractNameAndExtension(other)
  const { collator, collatorIsNumeric } = intlFileNameCollatorBaseNumeric()

  let result = collator.compare(oneExtension, otherExtension)

  if (result === 0) {
    // Using the numeric option will  make compare(`foo1`, `foo01`) === 0. Disambiguate.
    if (collatorIsNumeric && oneExtension !== otherExtension) {
      return oneExtension < otherExtension ? -1 : 1
    }

    // Extensions are equal, compare filenames
    result = collator.compare(oneName, otherName)

    if (collatorIsNumeric && result === 0 && oneName !== otherName) {
      return oneName < otherName ? -1 : 1
    }
  }

  return result
}

function comparePathComponents(one: string, other: string, caseSensitive = false): number {
  if (!caseSensitive) {
    one = one && one.toLowerCase()
    other = other && other.toLowerCase()
  }

  if (one === other) {
    return 0
  }

  return one < other ? -1 : 1
}

/** Compares paths component by component; `\` and `/` both separate. */
export function comparePaths(one: string, other: string, caseSensitive = false): number {
  const oneParts = one.split(/[\\/]/)
  const otherParts = other.split(/[\\/]/)

  const lastOne = oneParts.length - 1
  const lastOther = otherParts.length - 1
  let endOne: boolean, endOther: boolean

  for (let i = 0; ; i++) {
    endOne = lastOne === i
    endOther = lastOther === i

    if (endOne && endOther) {
      return compareFileNames(oneParts[i], otherParts[i])
    } else if (endOne) {
      return -1
    } else if (endOther) {
      return 1
    }

    const result = comparePathComponents(oneParts[i]!, otherParts[i]!, caseSensitive)

    if (result !== 0) {
      return result
    }
  }
}

/**
 * Compares instances of the same match type. Different match types should not be siblings
 * and their sort order is undefined.
 */
export function searchMatchComparer(elementA: RenderableMatch, elementB: RenderableMatch, sortOrder: SearchSortOrder = SearchSortOrder.Default): number {
  if (elementA instanceof FileMatch && elementB instanceof FolderMatch) {
    return 1
  }

  if (elementB instanceof FileMatch && elementA instanceof FolderMatch) {
    return -1
  }

  if (elementA instanceof FolderMatch && elementB instanceof FolderMatch) {
    const elemAIndex = elementA.index()
    const elemBIndex = elementB.index()
    if (elemAIndex !== -1 && elemBIndex !== -1) {
      return elemAIndex - elemBIndex
    }

    switch (sortOrder) {
      case SearchSortOrder.CountDescending:
        return elementB.count() - elementA.count()
      case SearchSortOrder.CountAscending:
        return elementA.count() - elementB.count()
      case SearchSortOrder.Type:
        return compareFileExtensions(elementA.name(), elementB.name())
      case SearchSortOrder.FileNames:
        return compareFileNames(elementA.name(), elementB.name())
      // Fall through otherwise
      default:
        if (!elementA.resource || !elementB.resource) {
          return 0
        }
        return comparePaths(elementA.resource, elementB.resource) || compareFileNames(elementA.name(), elementB.name())
    }
  }

  if (elementA instanceof FileMatch && elementB instanceof FileMatch) {
    switch (sortOrder) {
      case SearchSortOrder.CountDescending:
        return elementB.count() - elementA.count()
      case SearchSortOrder.CountAscending:
        return elementA.count() - elementB.count()
      case SearchSortOrder.Type:
        return compareFileExtensions(elementA.name(), elementB.name())
      case SearchSortOrder.FileNames:
        return compareFileNames(elementA.name(), elementB.name())
      // Modified needs a file stat; without one VS Code falls through to the default, as here.
      default:
        return comparePaths(elementA.resource, elementB.resource) || compareFileNames(elementA.name(), elementB.name())
    }
  }

  if (elementA instanceof Match && elementB instanceof Match) {
    return compareRangesUsingStarts(elementA.range(), elementB.range())
  }

  return 0
}

/** Orders any two elements of the same result by walking down from their roots to where their ancestry differs. */
export function searchComparer(elementA: RenderableMatch, elementB: RenderableMatch, sortOrder: SearchSortOrder = SearchSortOrder.Default): number {
  const elemAParents = createParentList(elementA)
  const elemBParents = createParentList(elementB)

  let i = elemAParents.length - 1
  let j = elemBParents.length - 1
  while (i >= 0 && j >= 0) {
    const a = elemAParents[i]!
    const b = elemBParents[j]!
    if (a.id() !== b.id()) {
      return searchMatchComparer(a, b, sortOrder)
    }
    i--
    j--
  }
  const elemAAtEnd = i === 0
  const elemBAtEnd = j === 0

  if (elemAAtEnd && !elemBAtEnd) {
    return 1
  } else if (!elemAAtEnd && elemBAtEnd) {
    return -1
  }
  return 0
}

//#endregion

//#region searchView.ts: children for the tree, initial collapse

export interface ChildrenOptions {
  /** Tree view (folders and their direct children) instead of the list view (each root lists all its files). */
  tree: boolean
  sortOrder: SearchSortOrder
}

/**
 * The children the search tree shows under `element` (SearchViewDataSource.getChildren): the result lists its
 * non-empty roots, or the children of the only one; a folder lists its direct children (tree) or every file below it
 * (list), sorted by `sortOrder`; a file lists its matches by position.
 */
export function childrenOf(element: SearchResult | RenderableMatch, options: ChildrenOptions): RenderableMatch[] {
  if (element instanceof SearchResult) {
    const folderMatches = element.folderMatches()
      .filter(fm => !fm.isEmpty())
      .sort((a, b) => searchMatchComparer(a, b))

    if (folderMatches.length === 1) {
      return folderChildren(folderMatches[0]!, options)
    }
    return folderMatches
  } else if (element instanceof FolderMatch) {
    return folderChildren(element, options)
  } else if (element instanceof FileMatch) {
    return element.matches().sort((a, b) => searchMatchComparer(a, b))
  }
  return []
}

function folderChildren(folderMatch: FolderMatch, options: ChildrenOptions): (FolderMatch | FileMatch)[] {
  const matchArray: (FolderMatch | FileMatch)[] = options.tree ? folderMatch.matches() : folderMatch.allDownstreamFileMatches()
  return matchArray.sort((a, b) => searchMatchComparer(a, b, options.sortOrder))
}

export function hasChildren(element: SearchResult | RenderableMatch): boolean {
  if (element instanceof Match) {
    return false
  }
  return element.hasChildren
}

/** `search.collapseResults` */
export type CollapseResults = 'auto' | 'alwaysCollapse' | 'alwaysExpand'

/**
 * Whether a tree node starts collapsed (SearchView.originalShouldCollapse): always with `alwaysCollapse`; with
 * `auto`, an element with more than 10 children (a file's matches, a folder's direct children).
 */
export function shouldCollapse(element: RenderableMatch, collapseResults: CollapseResults): boolean {
  return collapseResults === 'alwaysCollapse' ||
    (!(element instanceof Match) && element.count() > 10 && collapseResults !== 'alwaysExpand')
}

//#endregion

//#region replace as data

export interface MatchEdit {
  /** One-based document range of the match. */
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  /** fullMatchText(): what the file holds there now. */
  expected: string
  /** replaceString: what goes in its place. */
  text: string
}

export interface FileEdits {
  path: string
  edits: MatchEdit[]
}

function editOf(match: Match, model: SearchModel): MatchEdit {
  const r = match.range()
  return {
    range: { startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn },
    expected: match.fullMatchText(),
    text: computeReplaceString(match, model.replacePattern, model.preserveCase),
  }
}

function fileEditsOf(fileMatch: FileMatch, model: SearchModel): FileEdits {
  return { path: fileMatch.resource, edits: fileMatch.matches().map(m => editOf(m, model)) }
}

/**
 * What replacing `element` writes, per file, matches in document order. The model must have a replace pattern
 * (a query was set). After writing, the caller removes `element` from the model with `remove`.
 */
export function editsOf(element: Match | FileMatch | FolderMatch | SearchResult, model: SearchModel): FileEdits[] {
  if (element instanceof Match) {
    return [{ path: element.parent().resource, edits: [editOf(element, model)] }]
  }
  const files = element instanceof FileMatch
    ? [element]
    : element instanceof FolderMatch ? element.allDownstreamFileMatches() : element.matches()
  return files.map(f => fileEditsOf(f, model)).filter(f => f.edits.length > 0)
}

//#endregion

//#region searchHelpers.ts (structural stand-ins for Monaco's FindMatch and ITextModel)

/** The part of Monaco's FindMatch these helpers read. */
export interface FindMatchLike {
  readonly range: IRange
  readonly matches?: string[] | null
}

/** The part of Monaco's ITextModel these helpers read; line numbers are one-based. */
export interface TextModelLike {
  getLineContent(lineNumber: number): string
  getLineCount(): number
}

function editorMatchToTextSearchResult(matches: FindMatchLike[], model: Pick<TextModelLike, 'getLineContent'>, previewOptions?: ITextSearchPreviewOptions): TextSearchMatch {
  const firstLine = matches[0]!.range.startLineNumber
  const lastLine = matches[matches.length - 1]!.range.endLineNumber

  const lineTexts: string[] = []
  for (let i = firstLine; i <= lastLine; i++) {
    lineTexts.push(model.getLineContent(i))
  }

  return new TextSearchMatch(
    lineTexts.join('\n') + '\n',
    matches.map(m => new SearchRange(m.range.startLineNumber - 1, m.range.startColumn - 1, m.range.endLineNumber - 1, m.range.endColumn - 1)),
    previewOptions)
}

/**
 * Combine a set of FindMatches into a set of TextSearchResults. They should be grouped by matches that start on the same line that the previous match ends on.
 */
export function editorMatchesToTextSearchResults(matches: FindMatchLike[], model: Pick<TextModelLike, 'getLineContent'>, previewOptions?: ITextSearchPreviewOptions): TextSearchMatch[] {
  let previousEndLine = -1
  const groupedMatches: FindMatchLike[][] = []
  let currentMatches: FindMatchLike[] = []
  matches.forEach(match => {
    if (match.range.startLineNumber !== previousEndLine) {
      currentMatches = []
      groupedMatches.push(currentMatches)
    }

    currentMatches.push(match)
    previousEndLine = match.range.endLineNumber
  })

  return groupedMatches.map(sameLineMatches => {
    return editorMatchToTextSearchResult(sameLineMatches, model, previewOptions)
  })
}

/** Interleaves `query.surroundingContext` lines of context (one-based line numbers) around the matches. */
export function getTextSearchMatchWithModelContext(matches: ITextSearchMatch[], model: TextModelLike, query: { surroundingContext?: number }): ITextSearchResult[] {
  const results: ITextSearchResult[] = []

  let prevLine = -1
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!
    const { start: matchStartLine, end: matchEndLine } = getMatchStartEnd(current)
    if (typeof query.surroundingContext === 'number' && query.surroundingContext > 0) {
      const beforeContextStartLine = Math.max(prevLine + 1, matchStartLine - query.surroundingContext)
      for (let b = beforeContextStartLine; b < matchStartLine; b++) {
        results.push({
          text: model.getLineContent(b + 1),
          lineNumber: b + 1,
        })
      }
    }

    results.push(current)

    const nextMatch = matches[i + 1]
    const nextMatchStartLine = nextMatch ? getMatchStartEnd(nextMatch).start : Number.MAX_VALUE
    if (typeof query.surroundingContext === 'number' && query.surroundingContext > 0) {
      const afterContextToLine = Math.min(nextMatchStartLine - 1, matchEndLine + query.surroundingContext, model.getLineCount() - 1)
      for (let a = matchEndLine + 1; a <= afterContextToLine; a++) {
        results.push({
          text: model.getLineContent(a + 1),
          lineNumber: a + 1,
        })
      }
    }

    prevLine = matchEndLine
  }

  return results
}

function getMatchStartEnd(match: ITextSearchMatch): { start: number; end: number } {
  const matchRanges = match.rangeLocations.map(e => e.source)
  const matchStartLine = matchRanges[0]!.startLineNumber
  const matchEndLine = matchRanges[matchRanges.length - 1]!.endLineNumber

  return {
    start: matchStartLine,
    end: matchEndLine,
  }
}

//#endregion
