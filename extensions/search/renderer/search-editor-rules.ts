// The pure rules of the search editor (a `.code-search` document opened in the note editor): what each line of the
// document is, which file a line belongs to, where a file label leads, the column a result line points at, the
// document's name in the search editors' folder and which old documents that folder drops. No DOM, no Monaco, no `node:`:
// main (saveEditor) and the renderer (search-editor.ts) both read it.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   extensions/search-result/src/extension.ts  (FILE_LINE_REGEX, RESULT_LINE_REGEX, parseSearchResults, relativePathToUri)
// Changes: a file label is `rel` with one project, `<project name>/rel` with several (VS Code writes `name • rel`), the
// absolute path outside every project; a label is resolved by trying each candidate in turn (the caller checks the disk).
import { serializeSearchConfiguration, type SearchConfiguration, type SearchEditorRange } from '../../../app/shared/vscode-search-editor-serialization.ts'
import { createPathOps } from '../../../app/shared/vscode-search-query.ts'

/** The language of `.code-search` documents. */
export const SEARCH_RESULT_LANGUAGE = 'search-result'
export const SEARCH_EDITOR_EXTENSION = '.code-search'
/** The folder (under the person's configuration folder) where the documents opened from the pad are written. */
export const SEARCH_EDITORS_DIR = 'search-editors'
/** How many documents that folder keeps: the oldest go when a new one is written. */
export const KEEP_SEARCH_EDITORS = 50
/** The largest document written (UTF-8 bytes). */
export const MAX_SEARCH_EDITOR_BYTES = 50 * 1024 * 1024
/** The answer of a `searchOnce` replaced by a newer call. */
export const SUPERSEDED_MESSAGE = 'Pesquisa substituída por outra.'

const FILE_LINE = /^(\S.*):$/
const RESULT_LINE = /^(\s+)(\d+)(: |  )(.*)$/
const COUNT_LINE = /^(?:\d+ resultados? - \d+ arquivos?|Nenhum resultado|O conjunto de resultados contém só parte das ocorrências\..*)$/

export type SearchEditorLine =
  | { kind: 'header' }
  | { kind: 'count' }
  | { kind: 'file'; label: string }
  /** `  12: text` (a match) or `  13  text` (context): `prefix` is the length of what comes before the text. */
  | { kind: 'result' | 'context'; lineNumber: number; prefix: number }
  | { kind: 'empty' }
  | { kind: 'text' }

/**
 * One line of the document. `inHeader`: the line is in the leading block of `#` lines (the query). The count line is
 * only recognized before the first file (`beforeFiles`).
 */
export function classifyLine(line: string, inHeader: boolean, beforeFiles = true): SearchEditorLine {
  if (inHeader && line.startsWith('#')) return { kind: 'header' }
  if (line.trim() === '') return { kind: 'empty' }
  const result = RESULT_LINE.exec(line)
  if (result) {
    const [, indent = '', num = '', sep = ''] = result
    return { kind: sep === ': ' ? 'result' : 'context', lineNumber: Number(num), prefix: indent.length + num.length + sep.length }
  }
  if (beforeFiles && COUNT_LINE.test(line)) return { kind: 'count' }
  const file = FILE_LINE.exec(line)
  if (file) return { kind: 'file', label: file[1] ?? '' }
  return { kind: 'text' }
}

/** Every line of the document classified: the header is the leading run of `#` lines. */
export function classifyLines(lines: readonly string[]): SearchEditorLine[] {
  const out: SearchEditorLine[] = []
  let inHeader = true
  let beforeFiles = true
  for (const line of lines) {
    if (inHeader && !line.startsWith('#')) inHeader = false
    const c = classifyLine(line, inHeader, beforeFiles)
    if (c.kind === 'file') beforeFiles = false
    out.push(c)
  }
  return out
}

/** The lines of the header (the leading `#` lines), for extractSearchQueryFromLines. */
export function headerLines(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (!line.startsWith('#')) break
    out.push(line)
  }
  return out
}

/** The label of the file a line belongs to: the line itself when it is a file line, else the nearest file line above it. */
export function ownerOf(classified: readonly SearchEditorLine[], index: number): string | undefined {
  for (let i = Math.min(index, classified.length - 1); i >= 0; i--) {
    const c = classified[i]
    if (c?.kind === 'file') return c.label
    if (c?.kind === 'header' || c?.kind === 'count') return undefined
  }
  return undefined
}

export interface Root { path: string; name: string }

/**
 * The label of a file in the document: relative to its project with `/` (one project), `<project name>/rel` (several
 * projects), the absolute path when no project holds it.
 */
export function labelFor(path: string, roots: readonly Root[], platform: 'win32' | 'posix'): string {
  const ops = createPathOps(platform)
  let best: Root | undefined
  for (const r of roots) {
    if (ops.isEqualOrParent(path, r.path) && (!best || r.path.length > best.path.length)) best = r
  }
  if (!best) return path
  const rel = ops.relative(best.path, path).replace(/\\/g, '/')
  return roots.length > 1 ? `${best.name}/${rel}` : rel
}

/**
 * The paths a label may name, in the order to try them: an absolute label is itself; `<project name>/rel` names that
 * project first; then `rel` in each project, in order.
 */
export function labelCandidates(label: string, roots: readonly Root[], platform: 'win32' | 'posix'): string[] {
  const ops = createPathOps(platform)
  if (ops.isAbsolute(label)) return [ops.normalize(label)]
  const out: string[] = []
  const add = (p: string): void => { if (!out.some(o => ops.isEqual(o, p))) out.push(p) }
  const slash = label.indexOf('/')
  if (slash > 0) {
    const name = label.slice(0, slash)
    const rest = label.slice(slash + 1)
    const same = (a: string, b: string): boolean => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    if (rest !== '') for (const r of roots) if (same(r.name, name)) add(ops.join(r.path, rest))
  }
  for (const r of roots) add(ops.join(r.path, label))
  return out
}

/**
 * The column in the file a result line points at: the first match's start in the document (`matchColumn`, from its
 * decoration) less the line's prefix; column 1 without a known match, or for a context line.
 */
export function targetColumn(line: SearchEditorLine, matchColumn?: number): number {
  if (line.kind !== 'result' || matchColumn === undefined) return 1
  return Math.max(1, matchColumn - line.prefix)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `Pesquisa-AAAAMMDD-HHMMSS.code-search` in local time; `attempt` 2, 3… adds `-2`, `-3`… (the name was taken). */
export function searchEditorName(now: Date, attempt = 1): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  return `Pesquisa-${stamp}${attempt > 1 ? `-${attempt}` : ''}${SEARCH_EDITOR_EXTENSION}`
}

/**
 * The documents to delete so the folder keeps the `keep` most recent (by modification time, then name): only
 * `.code-search` files, never `spare` (the one just written).
 */
export function editorsToPrune(entries: readonly { name: string; mtimeMs: number }[], keep = KEEP_SEARCH_EDITORS, spare?: string): string[] {
  const docs = entries.filter(e => e.name.toLowerCase().endsWith(SEARCH_EDITOR_EXTENSION))
  docs.sort((a, b) => (b.name === spare ? 1 : 0) - (a.name === spare ? 1 : 0) || b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return docs.slice(Math.max(0, keep)).map(e => e.name).filter(n => n !== spare)
}

/**
 * The whole document: the header (the query, normalized) and a blank line over the body the serializer gave; the match
 * ranges move down by the header's lines.
 */
export function composeDocument(config: Partial<SearchConfiguration>, body: { text: string; matchRanges: readonly SearchEditorRange[] }): { text: string; matchRanges: SearchEditorRange[] } {
  const header = serializeSearchConfiguration(config)
  const offset = header.split('\n').length
  return {
    text: `${header}\n${body.text}`,
    matchRanges: body.matchRanges.map(r => ({ ...r, startLineNumber: r.startLineNumber + offset, endLineNumber: r.endLineNumber + offset })),
  }
}

/** The document of a search with nothing to show (no search ran, or nothing found). */
export function emptyDocument(config: Partial<SearchConfiguration>): { text: string; matchRanges: SearchEditorRange[] } {
  return composeDocument(config, { text: 'Nenhum resultado\n', matchRanges: [] })
}
