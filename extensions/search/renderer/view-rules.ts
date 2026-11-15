// The search pad's pure rules (view.ts): when an edit of the fields runs a search, the texts of the message line (result
// counts, no results, limit hit, cancelled), the client-side check of a regular expression, the engine's errors in
// Portuguese, the exclude setting as a glob expression and the pad's saved state. No DOM: read by the view and the tests.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/searchView.ts    (triggerQueryChange, onSearchComplete, buildResultCountMessage,
//                                                             updateSearchResultCount)
//   src/vs/workbench/contrib/search/browser/searchWidget.ts  (validateSearchInput)
import { splitGlobAware, type IExpression } from '../../../app/shared/vscode-search.ts'
import { createPathOps, escapeGlobPattern } from '../../../app/shared/vscode-search-query.ts'
import { SearchSortOrder } from '../../../app/shared/vscode-search-model.ts'
import { normalizeHistory, normalizeState, type SearchWidgetHistory, type SearchWidgetState } from './widget-rules.ts'

export type ViewMode = 'list' | 'tree'

/** Version control folders and system litter: always out of a search that honours the exclusions (app/main/file-index.ts DEFAULT_EXCLUDES). */
export const ALWAYS_EXCLUDED = ['**/.git', '**/.svn', '**/.hg', '**/CVS', '**/.DS_Store', '**/Thumbs.db'] as const

export const NO_FOLDER_MESSAGE = 'Abra uma pasta para pesquisar nos arquivos.'
export const CANCELLED_MESSAGE = 'Pesquisa cancelada.'
export const LIMIT_HIT_MESSAGE = 'O conjunto de resultados contém só uma parte das correspondências. Refine a pesquisa para restringir os resultados.'
export const EXCLUDES_OFF_NOTE = 'exclusões das configurações e arquivos ignore desligados'
export const NO_OPEN_EDITORS_MESSAGE = 'Nenhum editor aberto para pesquisar.'
export const NO_CHANGED_FILES_MESSAGE = 'Nenhum arquivo alterado no git nestas pastas.'
export const OPEN_EDITORS_NOTE = 'só nos editores abertos'
export const CHANGED_FILES_NOTE = 'só nos arquivos alterados'

/** The restrictions of the include field's two switches that a search ran with. */
export interface SearchScope { onlyOpenEditors?: boolean; onlyChangedFiles?: boolean }

/** One line of the message under the fields. */
export interface MessageLine { text: string; tone: 'info' | 'warning' }

/** What an edit of the widget does: 'now' (a toggle, Enter), 'debounce' (typing with search on type), or nothing. */
export function triggerOf(source: 'typed' | 'toggle' | 'submit', searchOnType: boolean): 'now' | 'debounce' | 'none' {
  if (source === 'typed') return searchOnType ? 'debounce' : 'none'
  return 'now'
}

const count = (n: number): string => n.toLocaleString('pt-BR')

/** "N resultados em M arquivos", singular and plural (buildResultCountMessage). */
export function resultCountMessage(results: number, files: number): string {
  return `${count(results)} ${results === 1 ? 'resultado' : 'resultados'} em ${count(files)} ${files === 1 ? 'arquivo' : 'arquivos'}`
}

/** The line shown while results exist: the counts, and a note for each thing that narrowed or widened the search. */
export function countLine(results: number, files: number, useExcludes: boolean, scope: SearchScope = {}): string {
  let line = resultCountMessage(results, files)
  if (!useExcludes) line += ` — ${EXCLUDES_OFF_NOTE}`
  if (scope.onlyOpenEditors) line += ` — ${OPEN_EDITORS_NOTE}`
  if (scope.onlyChangedFiles) line += ` — ${CHANGED_FILES_NOTE}`
  return line
}

/** A search that found nothing (onSearchComplete): where it looked, and the hint that the exclusions were in force. */
export function noResultsMessage(o: { include: string; exclude: string; useExcludes: boolean }): string {
  const include = o.include.trim()
  const exclude = o.exclude.trim()
  let text = 'Nenhum resultado encontrado'
  if (include) text += ` em '${include}'`
  if (exclude) text += ` excluindo '${exclude}'`
  text += '.'
  if (o.useExcludes) text += ' As exclusões das configurações e os arquivos ignore estão valendo.'
  return text
}

export interface Completion {
  kind: 'done' | 'cancelled'
  results: number
  files: number
  include: string
  exclude: string
  useExcludes: boolean
  limitHit?: boolean
  /** The engine's own messages. */
  messages?: readonly { text: string; type: number }[]
  /** The person cancelled it (a search replaced by a newer one says nothing). */
  byUser?: boolean
  scope?: SearchScope
}

/** How a search ended, counting the results from the open editors too: their limit, or the cap on the disk's batches, is a limit hit. */
export function withLocalLimit<D extends { kind: string; limitHit?: boolean }>(done: D, localLimitHit: boolean): D {
  return done.kind === 'done' && localLimitHit && !done.limitHit ? { ...done, limitHit: true } : done
}

/** The message lines once a search ends. */
export function completionMessage(c: Completion): MessageLine[] {
  const lines: MessageLine[] = []
  if (c.kind === 'cancelled') {
    if (c.results > 0) lines.push({ text: countLine(c.results, c.files, c.useExcludes, c.scope), tone: 'info' })
    if (c.byUser) lines.push({ text: CANCELLED_MESSAGE, tone: 'info' })
    return lines
  }
  if (c.results > 0) lines.push({ text: countLine(c.results, c.files, c.useExcludes, c.scope), tone: 'info' })
  else lines.push({ text: noResultsMessage(c), tone: 'info' })
  if (c.limitHit) lines.push({ text: LIMIT_HIT_MESSAGE, tone: 'warning' })
  for (const m of c.messages ?? []) if (m.text) lines.push({ text: m.text, tone: m.type === 2 ? 'warning' : 'info' })
  return lines
}

/** The browser's "Invalid regular expression: /x/u: " prefix, dropped from the detail. */
const REGEX_PREFIX = /^Invalid regular expression:\s*(\/.*\/[a-z]*:\s*)?/i

/** The check of a regular expression before searching (validateSearchInput): the error to show, or undefined when it is valid. */
export function regexError(pattern: string): string | undefined {
  if (pattern === '') return undefined
  try {
    new RegExp(pattern, 'u')
    return undefined
  } catch (e) {
    const detail = (e as Error).message.replace(REGEX_PREFIX, '').trim()
    return detail ? `Expressão regular inválida: ${detail}` : 'Expressão regular inválida.'
  }
}

/** The engine's error (`kind: 'error'`), in Portuguese when its code is a known one. */
export function engineErrorText(e: { message: string; code?: string }): string {
  const detail = e.message.trim()
  switch (e.code) {
    case 'regexParseError': return detail ? `Expressão regular inválida: ${detail}` : 'Expressão regular inválida.'
    case 'globParseError': return detail ? `Padrão de arquivos inválido: ${detail}` : 'Padrão de arquivos inválido.'
    case 'invalidLiteral': return detail ? `Texto de pesquisa inválido: ${detail}` : 'Texto de pesquisa inválido.'
    case 'unknownEncoding': return detail ? `Codificação desconhecida: ${detail}` : 'Codificação desconhecida.'
    default: return detail || 'A pesquisa falhou.'
  }
}

/** The `exclude` setting (globs separated by commas) plus the folders that are always out, as a glob expression. */
export function excludeExpression(setting: string | undefined): IExpression {
  const out: IExpression = {}
  for (const g of ALWAYS_EXCLUDED) out[g] = true
  for (const part of splitGlobAware(setting ?? '', ',')) {
    const g = part.trim()
    if (g) out[g] = true
  }
  return out
}

/** What the pad keeps in layout.json. */
export interface SearchViewState {
  widget: SearchWidgetState
  history: SearchWidgetHistory
  /** Unset: the `defaultViewMode` setting. */
  viewMode?: ViewMode
}

export function readViewState(raw: unknown): SearchViewState {
  const src = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const out: SearchViewState = {
    widget: normalizeState(src.widget as Partial<SearchWidgetState> | undefined),
    history: normalizeHistory(src.history as Partial<SearchWidgetHistory> | undefined),
  }
  if (src.viewMode === 'list' || src.viewMode === 'tree') out.viewMode = src.viewMode
  return out
}

/** The `sortOrder` setting as the results model takes it; an unknown value is the default order. */
export function readSortOrder(value: unknown): SearchSortOrder {
  const known = Object.values(SearchSortOrder) as string[]
  return typeof value === 'string' && known.includes(value) ? value as SearchSortOrder : SearchSortOrder.Default
}

/** A project as the include/exclude fields name it. */
export interface RootRef { path: string; name: string }

/**
 * A folder as the include/exclude field understands it (resolveResourcesForSearchIncludes): relative to the project when
 * there is one ("./src", "./" for the project itself), "./name/src" ("./name") with several projects, and the absolute path
 * when another project has the same name. `?*[]` are escaped as the origin does. Undefined when no project holds the folder.
 */
export function folderPattern(folder: string, roots: readonly RootRef[], platform: 'win32' | 'posix'): string | undefined {
  const ops = createPathOps(platform)
  const owner = [...roots]
    .filter(r => ops.isEqualOrParent(folder, r.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!owner) return undefined
  const rel = ops.relative(owner.path, folder).replace(/\\/g, '/')
  const inside = rel === '' || rel === '.' ? '' : rel
  let pattern: string
  if (roots.length === 1) pattern = inside === '' ? './' : `./${inside}`
  else if (roots.filter(r => r.name === owner.name).length === 1) pattern = inside === '' ? `./${owner.name}` : `./${owner.name}/${inside}`
  else pattern = folder
  return escapeGlobPattern(pattern)
}

/** Adds a glob to a comma separated field unless it is already there (mergeSearchPatternIfNotExists). */
export function mergePattern(current: string, pattern: string): string {
  if (current.trim() === '') return pattern
  const existing = splitGlobAware(current, ',').map(p => p.trim()).filter(p => p !== '')
  return existing.includes(pattern) ? current : `${current}, ${pattern}`
}

/** A single-line selection becomes the search term (updateTextFromSelection); escaped when the regex toggle is on. */
export function seedFromSelection(selected: string, regex: boolean): string | undefined {
  if (selected === '' || /[\r\n]/.test(selected)) return undefined
  return regex ? selected.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&') : selected
}
