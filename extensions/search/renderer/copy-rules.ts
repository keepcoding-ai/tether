// What the results tree's "Copiar" puts on the clipboard (pure; no DOM): a match as "line,column: text", a file as its path
// and its matches indented, a folder as its files, and "Copiar tudo" as every root. Read by the pad (view.ts) and the tests.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/searchActionsCopy.ts  (matchToString, fileMatchToString, folderMatchToString,
//                                                                  allFolderMatchesToString, copyMatchCommand, copyPathCommand)
import { FileMatch, FolderMatch, Match, searchMatchComparer, type RenderableMatch, type SearchResult } from '../../../app/shared/vscode-search-model.ts'

export type Platform = 'win32' | 'posix'

/** The line break between the lines of a copy: the platform's own, as the origin's `lineDelimiter`. */
export function lineDelimiter(platform: Platform): string {
  return platform === 'win32' ? '\r\n' : '\n'
}

/**
 * A match: "line,column: text" for its first line, "line: text" for the next ones, the prefixes padded to the widest so the
 * text lines up. Lines of one match are joined with "\n" whatever the platform (the origin does).
 */
export function matchToString(match: Match, indent = 0): string {
  const range = match.range()
  const first = `${range.startLineNumber},${range.startColumn}`
  const other = (i: number): string => String(range.startLineNumber + i)
  const lines = match.fullPreviewLines()
  const prefixOf = (i: number): string => (i === 0 ? first : other(i))
  const widest = lines.reduce((largest, _, i) => Math.max(largest, prefixOf(i).length), 0)
  return lines
    .map((line, i) => `${' '.repeat(indent)}${prefixOf(i)}: ${' '.repeat(widest - prefixOf(i).length)}${line}`)
    .join('\n')
}

/** A file: its path, then its matches (in position order) indented by two. */
export function fileMatchToString(file: FileMatch, eol: string): { text: string; count: number } {
  const rows = file.matches().sort((a, b) => searchMatchComparer(a, b)).map(m => matchToString(m, 2))
  return { text: `${file.resource}${eol}${rows.join(eol)}`, count: rows.length }
}

/** A folder: its files and subfolders in the tree's order, separated by a blank line. */
export function folderMatchToString(folder: FolderMatch, eol: string): { text: string; count: number } {
  const parts: string[] = []
  let count = 0
  for (const child of [...folder.matches()].sort((a, b) => searchMatchComparer(a, b))) {
    const r = child instanceof FileMatch ? fileMatchToString(child, eol) : folderMatchToString(child, eol)
    count += r.count
    parts.push(r.text)
  }
  return { text: parts.join(eol + eol), count }
}

/** Every root of the results that has matches, separated by a blank line. */
export function allFolderMatchesToString(roots: readonly FolderMatch[], eol: string): string {
  const parts: string[] = []
  for (const root of [...roots].sort((a, b) => searchMatchComparer(a, b))) {
    const r = folderMatchToString(root, eol)
    if (r.count > 0) parts.push(r.text)
  }
  return parts.join(eol + eol)
}

/** "Copiar" on a row: the match, the file or the folder as text; undefined when there is nothing to copy. */
export function copyText(element: RenderableMatch, eol: string): string | undefined {
  const text = element instanceof Match ? matchToString(element)
    : element instanceof FileMatch ? fileMatchToString(element, eol).text
      : folderMatchToString(element, eol).text
  return text === '' ? undefined : text
}

/** "Copiar tudo": the whole result. */
export function copyAllText(result: SearchResult, eol: string): string | undefined {
  const text = allFolderMatchesToString(result.folderMatches(), eol)
  return text === '' ? undefined : text
}

/** "Copiar caminho": the path of the row's file (a match's file) or folder; undefined for the folder of files outside every project. */
export function copyPathText(element: RenderableMatch): string | undefined {
  if (element instanceof Match) return element.parent().resource
  return element.resource ?? undefined
}
