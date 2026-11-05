/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of the search-session cache and the top-N selection VS Code's Quick Open uses for files.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68 (the scorer's commit)
//   src/vs/workbench/services/search/node/rawSearchService.ts
//       class Cache (resultsToSearchCache + scorerCache), getOrCreateCache / clearCache, getResultsFromCache
//       (a query that starts with a cached one is filtered from that row with isFilePatternMatch), sortResults
//       (compareItemsByFuzzyScore as the comparator of a top-N selection, maxResults as N)
//   src/vs/workbench/services/search/common/search.ts      isFilePatternMatch (fuzzy branch)
//   src/vs/base/common/arrays.ts                            top, topStep
//   src/vs/base/common/arraysFind.ts                        findFirstIdxMonotonousOrArrLen
// The model is VS Code's: the list is read when the box opens (the session), every keystroke is answered from it
// and from the rows of the earlier keystrokes, and the cache is dropped when the box closes (clearCache).
// Changes, only what this project needs:
//   - synchronous (`topAsync`'s yields to the event loop are dropped: this runs in a dedicated worker thread);
//   - the file match is `{ rel }` (path relative to the root) instead of IRawFileMatch;
//   - a row is stored for every query that was answered, and the longest cached query that prefixes the new one is
//     used (VS Code stores only the row of the search that read the folder, which its first-match loop then always
//     finds); the result is the same set of candidates, narrower;
//   - a quoted query (exact match) never uses a row: its candidates are not a subset of the previous query's;
//   - the candidates of a multi-word query are filtered per word (the scorer accepts the words in any order).
import { fuzzyContains, type FuzzyScorerCache, type IItemAccessor, prepareQuery, compareItemsByFuzzyScore } from '../shared/vscode-fuzzy-scorer.ts'
import { sep } from 'node:path'

// ---------- arraysFind.ts ----------

export function findFirstIdxMonotonousOrArrLen<T>(array: readonly T[], predicate: (item: T) => boolean, startIdx = 0, endIdxEx = array.length): number {
  let i = startIdx
  let j = endIdxEx
  while (i < j) {
    const k = Math.floor((i + j) / 2)
    if (predicate(array[k]!)) {
      j = k
    } else {
      i = k + 1
    }
  }
  return i
}

// ---------- arrays.ts ----------

/**
 * Returns the top N elements from the array.
 * Faster than sorting the entire array when the array is a lot larger than N.
 */
export function top<T>(array: ReadonlyArray<T>, compare: (a: T, b: T) => number, n: number): T[] {
  if (n === 0) {
    return []
  }
  const result = array.slice(0, n).sort(compare)
  topStep(array, compare, result, n, array.length)
  return result
}

function topStep<T>(array: ReadonlyArray<T>, compare: (a: T, b: T) => number, result: T[], i: number, m: number): void {
  for (const n = result.length; i < m; i++) {
    const element = array[i]!
    if (compare(element, result[n - 1]!) < 0) {
      result.pop()
      const j = findFirstIdxMonotonousOrArrLen(result, e => compare(element, e) < 0)
      result.splice(j, 0, element)
    }
  }
}

// ---------- rawSearchService.ts ----------

/** The part of a file match the cache needs. */
export interface RawFileMatch { rel: string }

/** search.ts isFilePatternMatch, fuzzy branch: the path contains the (normalized, lowercase) pattern as a subsequence. */
export function isFilePatternMatch(candidate: RawFileMatch, filePatternToUse: string): boolean {
  return fuzzyContains(candidate.rel, filePatternToUse)
}

/** rawSearchService.ts `Cache`: the rows by search value, and the scorer's cache, for one search session (one cacheKey). */
export class SearchCache<T extends RawFileMatch> {
  resultsToSearchCache = new Map<string, T[]>()
  scorerCache: FuzzyScorerCache = Object.create(null)

  /** getResultsFromCache: the candidates for `searchValue`, filtered from the best cached row (or from `all`). */
  getResultsFromCache(searchValue: string, all: readonly T[]): T[] {
    const hasPathSep = searchValue.indexOf(sep) >= 0
    let cached: readonly T[] = all
    if (!searchValue.includes('"')) {
      let bestLen = -1
      for (const [previousSearch, row] of this.resultsToSearchCache) {
        // If we narrow down, we might be able to reuse the cached results
        if (!searchValue.startsWith(previousSearch) || previousSearch.length <= bestLen || previousSearch.includes('"')) continue
        if (hasPathSep && previousSearch.indexOf(sep) < 0 && previousSearch !== '') continue // a path character widens the search: require it in the previous search too
        cached = row
        bestLen = previousSearch.length
      }
    }
    // Pattern match on results
    const prepared = prepareQuery(searchValue)
    const pieces = (prepared.values ?? [prepared]).map(p => p.normalizedLowercase)
    const results: T[] = []
    for (const entry of cached) {
      if (pieces.every(p => isFilePatternMatch(entry, p))) results.push(entry)
    }
    return results
  }

  put(searchValue: string, results: T[]): void {
    this.resultsToSearchCache.set(searchValue, results)
  }

  /** sortResults: the first `maxResults` of `results` in the order of the scorer's comparator (a top-N selection). */
  sortResults(results: T[], searchValue: string, maxResults: number, accessor: IItemAccessor<T>): T[] {
    // we use the same compare function that is used later when showing the results using fuzzy scoring
    // this is very important because we are also limiting the number of results by config.maxResults
    // and as such we want the top items to be included in this result set if the number of items
    // exceeds config.maxResults.
    const query = prepareQuery(searchValue)
    const compare = (matchA: T, matchB: T) => compareItemsByFuzzyScore(matchA, matchB, query, true, accessor, this.scorerCache)
    return top(results, compare, maxResults)
  }
}
