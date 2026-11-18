/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Port of VS Code's search editor serialization: search results -> the text of a `.code-search` document (the
// `# Query:` header, then files and numbered lines) and the header read back. Pure: no DOM, no Monaco, no `node:`.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/contrib/searchEditor/browser/searchEditorSerialization.ts  (everything below)
//   src/vs/workbench/contrib/searchEditor/browser/constants.ts                  (SearchConfiguration)
// Changes:
//   Resources are absolute path strings; `labelFormatter` takes the path and returns the file label. Monaco `Range`
//   is a plain one-based `SearchEditorRange`. The "N results - M files" line and the invalid-escape error are in
//   Portuguese. `extractSearchQueryFromModel` is not ported: it is `extractSearchQueryFromLines` over the first
//   lines of the document, so the caller passes the lines itself.
//   `contentPatternToSearchConfiguration` takes `userDisabledExcludesAndIgnoreFiles` and `onlyOpenEditors` as
//   arguments (VS Code reads them from the query type, which this port's ITextQuery does not carry).
// Left out: notebooks and cells (notebookSearchConfig, cellMatchToSearchResultFormat), parseSavedSearchEditor (reads
// a file through a service).

import { searchMatchComparer, type FileMatch, type Match, type SearchResult, type SearchSortOrder } from './vscode-search-model.ts'
import type { ITextQuery } from './vscode-search.ts'

// Using \r\n on Windows inserts an extra newline between results.
const lineDelimiter = '\n'

/** One-based range in the serialized document. */
export interface SearchEditorRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface SearchConfiguration {
  query: string
  filesToInclude: string
  filesToExclude: string
  contextLines: number
  matchWholeWord: boolean
  isCaseSensitive: boolean
  isRegexp: boolean
  useExcludeSettingsAndIgnoreFiles: boolean
  showIncludesExcludes: boolean
  onlyOpenEditors: boolean
}

export interface SearchResultSerialization {
  text: string[]
  matchRanges: SearchEditorRange[]
}

const translateRangeLines = (n: number) => (range: SearchEditorRange): SearchEditorRange => ({
  startLineNumber: range.startLineNumber + n,
  startColumn: range.startColumn,
  endLineNumber: range.endLineNumber + n,
  endColumn: range.endColumn,
})

export function matchToSearchResultFormat(match: Match, longestLineNumber: number): { line: string; ranges: SearchEditorRange[]; lineNumber: string }[] {
  const getLinePrefix = (i: number) => `${match.range().startLineNumber + i}`

  const fullMatchLines = match.fullPreviewLines()

  const results: { line: string; ranges: SearchEditorRange[]; lineNumber: string }[] = []

  fullMatchLines.forEach((sourceLine, i) => {
    const lineNumber = getLinePrefix(i)
    const paddingStr = ' '.repeat(longestLineNumber - lineNumber.length)
    const prefix = `  ${paddingStr}${lineNumber}: `
    const prefixOffset = prefix.length

    // split instead of replace to avoid creating a new string object
    const line = prefix + (sourceLine.split(/\r?\n?$/, 1)[0] || '')

    const rangeOnThisLine = ({ start, end }: { start?: number; end?: number }): SearchEditorRange => ({
      startLineNumber: 1,
      startColumn: (start ?? 1) + prefixOffset,
      endLineNumber: 1,
      endColumn: (end ?? sourceLine.length + 1) + prefixOffset,
    })

    const matchRange = match.rangeInPreview()
    const matchIsSingleLine = matchRange.startLineNumber === matchRange.endLineNumber

    let lineRange: SearchEditorRange
    if (matchIsSingleLine) { lineRange = rangeOnThisLine({ start: matchRange.startColumn, end: matchRange.endColumn }) }
    else if (i === 0) { lineRange = rangeOnThisLine({ start: matchRange.startColumn }) }
    else if (i === fullMatchLines.length - 1) { lineRange = rangeOnThisLine({ end: matchRange.endColumn }) }
    else { lineRange = rangeOnThisLine({}) }

    results.push({ lineNumber, line, ranges: [lineRange] })
  })

  return results
}

export function fileMatchToSearchResultFormat(fileMatch: FileMatch, labelFormatter: (path: string) => string): SearchResultSerialization[] {
  const matches = fileMatch.matches()
  if (matches.length === 0) { return [] }
  matches.sort((a, b) => searchMatchComparer(a, b))
  return [matchesToSearchResultFormat(fileMatch.resource, matches, fileMatch.context, labelFormatter)]
}

export function matchesToSearchResultFormat(resource: string, sortedMatches: Match[], matchContext: Map<number, string>, labelFormatter: (path: string) => string, shouldUseHeader = true): SearchResultSerialization {
  const longestLineNumber = (sortedMatches[sortedMatches.length - 1]?.range().endLineNumber ?? 0).toString().length

  const text: string[] = shouldUseHeader ? [`${labelFormatter(resource)}:`] : []
  const matchRanges: SearchEditorRange[] = []

  const targetLineNumberToOffset: Record<string, number> = {}

  const context: { line: string; lineNumber: number }[] = []
  matchContext.forEach((line, lineNumber) => context.push({ line, lineNumber }))
  context.sort((a, b) => a.lineNumber - b.lineNumber)

  let lastLine: number | undefined = undefined

  const seenLines = new Set<string>()
  sortedMatches.forEach(match => {
    matchToSearchResultFormat(match, longestLineNumber).forEach(match => {
      if (!seenLines.has(match.lineNumber)) {
        while (context.length && context[0]!.lineNumber < +match.lineNumber) {
          const { line, lineNumber } = context.shift()!
          if (lastLine !== undefined && lineNumber !== lastLine + 1) {
            text.push('')
          }
          text.push(`  ${' '.repeat(longestLineNumber - `${lineNumber}`.length)}${lineNumber}  ${line}`)
          lastLine = lineNumber
        }

        targetLineNumberToOffset[match.lineNumber] = text.length
        seenLines.add(match.lineNumber)
        text.push(match.line)
        lastLine = +match.lineNumber
      }

      matchRanges.push(...match.ranges.map(translateRangeLines(targetLineNumberToOffset[match.lineNumber]!)))
    })
  })

  // Trailing context lines are not padded, as in VS Code.
  while (context.length) {
    const { line, lineNumber } = context.shift()!
    text.push(`  ${lineNumber}  ${line}`)
  }

  return { text, matchRanges }
}

export function contentPatternToSearchConfiguration(pattern: ITextQuery, includes: string, excludes: string, contextLines: number, userDisabledExcludesAndIgnoreFiles?: boolean, onlyOpenEditors?: boolean): SearchConfiguration {
  return {
    query: pattern.contentPattern.pattern,
    isRegexp: !!pattern.contentPattern.isRegExp,
    isCaseSensitive: !!pattern.contentPattern.isCaseSensitive,
    matchWholeWord: !!pattern.contentPattern.isWordMatch,
    filesToExclude: excludes,
    filesToInclude: includes,
    showIncludesExcludes: !!(includes || excludes || userDisabledExcludesAndIgnoreFiles),
    useExcludeSettingsAndIgnoreFiles: userDisabledExcludesAndIgnoreFiles === undefined ? true : !userDisabledExcludesAndIgnoreFiles,
    contextLines,
    onlyOpenEditors: !!onlyOpenEditors,
  }
}

export function serializeSearchConfiguration(config: Partial<SearchConfiguration>): string {
  const escapeNewlines = (str: string) => str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')

  const flags = [
    config.isCaseSensitive && 'CaseSensitive',
    config.matchWholeWord && 'WordMatch',
    config.isRegexp && 'RegExp',
    config.onlyOpenEditors && 'OpenEditors',
    (config.useExcludeSettingsAndIgnoreFiles === false) && 'IgnoreExcludeSettings',
  ].filter((flag): flag is string => !!flag)

  const lines: (string | false | undefined)[] = [
    `# Query: ${escapeNewlines(config.query ?? '')}`,
    (config.isCaseSensitive || config.matchWholeWord || config.isRegexp || config.useExcludeSettingsAndIgnoreFiles === false)
      && `# Flags: ${flags.join(' ')}`,
    config.filesToInclude ? `# Including: ${config.filesToInclude}` : undefined,
    config.filesToExclude ? `# Excluding: ${config.filesToExclude}` : undefined,
    config.contextLines ? `# ContextLines: ${config.contextLines}` : undefined,
    '',
  ]
  return lines.filter((line): line is string => line !== false && line !== undefined).join(lineDelimiter)
}

export function defaultSearchConfig(): SearchConfiguration {
  return {
    query: '',
    filesToInclude: '',
    filesToExclude: '',
    isRegexp: false,
    isCaseSensitive: false,
    useExcludeSettingsAndIgnoreFiles: true,
    matchWholeWord: false,
    contextLines: 0,
    showIncludesExcludes: false,
    onlyOpenEditors: false,
  }
}

export function extractSearchQueryFromLines(lines: string[]): SearchConfiguration {
  const query = defaultSearchConfig()

  const unescapeNewlines = (str: string) => {
    let out = ''
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\\') {
        i++
        const escaped = str[i]

        if (escaped === 'n') {
          out += '\n'
        } else if (escaped === '\\') {
          out += '\\'
        } else {
          throw Error('Todas as barras invertidas na Query devem ser escapadas (\\\\)')
        }
      } else {
        out += str[i]
      }
    }
    return out
  }

  const parseYML = /^# ([^:]*): (.*)$/
  for (const line of lines) {
    const parsed = parseYML.exec(line)
    if (!parsed) { continue }
    const key = parsed[1]
    const value = parsed[2] ?? ''
    switch (key) {
      case 'Query': query.query = unescapeNewlines(value); break
      case 'Including': query.filesToInclude = value; break
      case 'Excluding': query.filesToExclude = value; break
      case 'ContextLines': query.contextLines = +value; break
      case 'Flags': {
        query.isRegexp = value.indexOf('RegExp') !== -1
        query.isCaseSensitive = value.indexOf('CaseSensitive') !== -1
        query.useExcludeSettingsAndIgnoreFiles = value.indexOf('IgnoreExcludeSettings') === -1
        query.matchWholeWord = value.indexOf('WordMatch') !== -1
        query.onlyOpenEditors = value.indexOf('OpenEditors') !== -1
      }
    }
  }

  query.showIncludesExcludes = !!(query.filesToInclude || query.filesToExclude || !query.useExcludeSettingsAndIgnoreFiles)

  return query
}

export function serializeSearchResultForEditor(
  searchResult: SearchResult,
  rawIncludePattern: string,
  rawExcludePattern: string,
  contextLines: number,
  labelFormatter: (path: string) => string,
  sortOrder: SearchSortOrder,
  limitHit?: boolean,
): { matchRanges: SearchEditorRange[]; text: string; config: Partial<SearchConfiguration> } {
  if (!searchResult.query) { throw Error('Internal Error: Expected query, got null') }
  const config = contentPatternToSearchConfiguration(searchResult.query, rawIncludePattern, rawExcludePattern, contextLines)

  const fileCount = searchResult.fileCount()
  const count = searchResult.count()
  const filecount = fileCount > 1 ? `${fileCount} arquivos` : '1 arquivo'
  const resultcount = count > 1 ? `${count} resultados` : '1 resultado'

  const info = [count ? `${resultcount} - ${filecount}` : 'Nenhum resultado']
  if (limitHit) {
    info.push('O conjunto de resultados contém só parte das ocorrências. Refine a pesquisa para restringir os resultados.')
  }
  info.push('')

  const allResults = flattenSearchResultSerializations(
    searchResult.folderMatches()
      .sort((a, b) => searchMatchComparer(a, b, sortOrder))
      .flatMap(folderMatch => folderMatch.allDownstreamFileMatches()
        .sort((a, b) => searchMatchComparer(a, b, sortOrder))
        .flatMap(fileMatch => fileMatchToSearchResultFormat(fileMatch, labelFormatter))),
  )

  return {
    matchRanges: allResults.matchRanges.map(translateRangeLines(info.length)),
    text: info.concat(allResults.text).join(lineDelimiter),
    config,
  }
}

export function flattenSearchResultSerializations(serializations: SearchResultSerialization[]): SearchResultSerialization {
  const text: string[] = []
  const matchRanges: SearchEditorRange[] = []

  serializations.forEach(serialized => {
    serialized.matchRanges.map(translateRangeLines(text.length)).forEach(range => matchRanges.push(range))
    serialized.text.forEach(line => text.push(line))
    text.push('') // new line
  })

  return { text, matchRanges }
}

export function parseSerializedSearchEditor(text: string): { config: SearchConfiguration; text: string } {
  const headerlines: string[] = []
  const bodylines: string[] = []

  let inHeader = true
  for (const line of text.split(/\r?\n/g)) {
    if (inHeader) {
      headerlines.push(line)
      if (line === '') {
        inHeader = false
      }
    } else {
      bodylines.push(line)
    }
  }

  return { config: extractSearchQueryFromLines(headerlines), text: bodylines.join('\n') }
}
