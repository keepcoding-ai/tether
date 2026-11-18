// The open editors' text as search input (VS Code's getLocalResults): a file open in an editor is searched in its model,
// not on disk, and its results replace the disk's. Also the pieces that keep one file of the results in step with its
// text (FileMatch.bindModel/updateMatchesForModel): its results recomputed and put back into the results model. Pure over
// structural types (no DOM, no Monaco import): view.ts passes Monaco's models, the tests pass fakes.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/services/search/common/searchService.ts                 (getLocalResults, matches: the model's
//                                                                             findMatches, at most maxResults + 1, the
//                                                                             files searched in memory dropped from the
//                                                                             disk's progress)
//   src/vs/workbench/contrib/search/browser/searchTreeModel/fileMatch.ts     (updateMatchesForModel: the file's matches
//                                                                             replaced at once by the model's)
// Not in VS Code: the disk's batches are trimmed so that memory and disk together stay within maxResults; a file
// recomputed to no match leaves the results model (VS Code keeps an empty file match bound to its model).
import {
  editorMatchesToTextSearchResults, getTextSearchMatchWithModelContext, type FindMatchLike, type SearchResult, type TextModelLike,
} from '../../../app/shared/vscode-search-model.ts'
import { DEFAULT_MAX_SEARCH_RESULTS, resultIsMatch, type IFileMatch, type ITextQuery, type ITextSearchResult } from '../../../app/shared/vscode-search.ts'

/** Monaco's default word separators (editor.wordSeparators), used for "whole word" when the query names none. */
export const DEFAULT_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?'

/** The part of Monaco's ITextModel the buffer search reads. */
export interface BufferModel extends TextModelLike {
  readonly uri: { readonly scheme: string; readonly fsPath: string }
  findMatches(searchString: string, searchOnlyEditableRange: boolean, isRegex: boolean, matchCase: boolean,
    wordSeparators: string | null, captureMatches: boolean, limitResultCount?: number): FindMatchLike[]
}

/** The search's results in one model, and whether it held more than `max` matches (then only `max` are given). */
export function bufferSearch(model: BufferModel, query: ITextQuery, max = query.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS): { results: ITextSearchResult[]; limitHit: boolean } {
  const p = query.contentPattern
  const ask = Math.max(0, max) + 1
  let matches: FindMatchLike[]
  try {
    matches = model.findMatches(p.pattern, false, !!p.isRegExp, !!p.isCaseSensitive,
      p.isWordMatch ? (p.wordSeparators ?? DEFAULT_WORD_SEPARATORS) : null, false, ask)
  } catch {
    // A pattern JavaScript does not take (ripgrep's syntax): no results from memory; the disk was searched by rg.
    return { results: [], limitHit: false }
  }
  let limitHit = false
  if (matches.length >= ask) { limitHit = true; matches = matches.slice(0, ask - 1) }
  if (matches.length === 0) return { results: [], limitHit }
  const textResults = editorMatchesToTextSearchResults(matches, model, query.previewOptions)
  return { results: getTextSearchMatchWithModelContext(textResults, model, query), limitHit }
}

/** The search's results (matches and context lines) in one model. */
export function bufferResults(model: BufferModel, query: ITextQuery): ITextSearchResult[] {
  return bufferSearch(model, query).results
}

/** Whether a model takes part in the search: a file (not an in-memory or diff model) that the query's paths include. */
export function bufferInQuery(model: Pick<BufferModel, 'uri'>, included: (fsPath: string) => boolean): boolean {
  return model.uri.scheme === 'file' && included(model.uri.fsPath)
}

/**
 * A model's path as the disk search writes it: a path inside a searched folder is that folder's spelling plus the rest
 * (Monaco's fsPath lowers the drive letter), so both sources name a file the same way. Other paths stay as they are.
 */
export function resourceOf(fsPath: string, folders: readonly string[], caseInsensitive: boolean): string {
  const norm = (s: string): string => { const t = s.replaceAll('\\', '/'); return caseInsensitive ? t.toLowerCase() : t }
  const p = norm(fsPath)
  for (const folder of folders) {
    const f = norm(folder).replace(/\/+$/, '')
    if (p.length > f.length && p.startsWith(f) && p[f.length] === '/') return folder.replace(/[\\/]+$/, '') + fsPath.slice(f.length)
  }
  return fsPath
}

/** The matches a file's results count (each range of a match is one, as the engine counts them). */
export function matchCount(results: readonly ITextSearchResult[] | undefined): number {
  let n = 0
  for (const r of results ?? []) if (resultIsMatch(r)) n += r.rangeLocations.length
  return n
}

/**
 * A disk batch merged with what was searched in memory: the files searched in memory leave it (with or without matches
 * there), and the rest is trimmed so that the total stays within `remaining` matches.
 */
export function mergeDiskBatch(batch: readonly IFileMatch[], buffered: ReadonlySet<string>, key: (path: string) => string, remaining: number): { files: IFileMatch[]; count: number; trimmed: boolean } {
  const files: IFileMatch[] = []
  let count = 0
  let trimmed = false
  for (const f of batch) {
    if (buffered.has(key(f.resource))) continue
    const n = matchCount(f.results)
    if (count + n <= remaining) { files.push(f); count += n; continue }
    trimmed = true
    const room = remaining - count
    if (room <= 0) break
    const results: ITextSearchResult[] = []
    let left = room
    for (const r of f.results ?? []) {
      if (!resultIsMatch(r)) { results.push(r); continue }
      if (left <= 0) break
      const rangeLocations = r.rangeLocations.slice(0, left)
      left -= rangeLocations.length
      results.push({ ...r, rangeLocations })
    }
    files.push({ ...f, results })
    count += room
    break
  }
  return { files, count, trimmed }
}

/**
 * Puts a file's recomputed results into the results model: its matches are replaced at once (setResults), a file left
 * with no match leaves the tree, and a file not in the tree (it had none, or its folder went when it emptied) is added.
 */
export function applyFileResults(searchResult: SearchResult, path: string, results: ITextSearchResult[]): void {
  const existing = searchResult.getFolderMatch(path)?.getDownstreamFileMatch(path) ?? null
  if (matchCount(results) === 0) {
    if (existing) searchResult.remove(existing)
    return
  }
  if (existing) existing.setResults(results)
  else searchResult.add([{ resource: path, results }])
}
