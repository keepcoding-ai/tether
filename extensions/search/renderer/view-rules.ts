// The search pad's pure rules (view.ts): when an edit of the fields runs a search, the texts of the message line (result
// counts, no results, limit hit, cancelled), the client-side check of a regular expression, the engine's errors in
// Portuguese, the exclude setting as a glob expression and the pad's saved state. No DOM: read by the view and the tests.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/searchView.ts    (triggerQueryChange, onSearchComplete, buildResultCountMessage,
//                                                             updateSearchResultCount)
//   src/vs/workbench/contrib/search/browser/searchWidget.ts  (validateSearchInput)
import { splitGlobAware, type IExpression } from '../../../app/shared/vscode-search.ts'
import { normalizeHistory, normalizeState, type SearchWidgetHistory, type SearchWidgetState } from './widget-rules.ts'

export type ViewMode = 'list' | 'tree'

/** Version control folders and system litter: always out of a search that honours the exclusions (app/main/file-index.ts DEFAULT_EXCLUDES). */
export const ALWAYS_EXCLUDED = ['**/.git', '**/.svn', '**/.hg', '**/CVS', '**/.DS_Store', '**/Thumbs.db'] as const

export const NO_FOLDER_MESSAGE = 'Abra uma pasta para pesquisar nos arquivos.'
export const CANCELLED_MESSAGE = 'Pesquisa cancelada.'
export const LIMIT_HIT_MESSAGE = 'O conjunto de resultados contém só uma parte das correspondências. Refine a pesquisa para restringir os resultados.'
export const EXCLUDES_OFF_NOTE = 'exclusões das configurações e arquivos ignore desligados'

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

/** The line shown while results exist: the counts, and a note when the exclusions and ignore files are off. */
export function countLine(results: number, files: number, useExcludes: boolean): string {
  const base = resultCountMessage(results, files)
  return useExcludes ? base : `${base} — ${EXCLUDES_OFF_NOTE}`
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
}

/** The message lines once a search ends. */
export function completionMessage(c: Completion): MessageLine[] {
  const lines: MessageLine[] = []
  if (c.kind === 'cancelled') {
    if (c.results > 0) lines.push({ text: countLine(c.results, c.files, c.useExcludes), tone: 'info' })
    if (c.byUser) lines.push({ text: CANCELLED_MESSAGE, tone: 'info' })
    return lines
  }
  if (c.results > 0) lines.push({ text: countLine(c.results, c.files, c.useExcludes), tone: 'info' })
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

/** A single-line selection becomes the search term (updateTextFromSelection); escaped when the regex toggle is on. */
export function seedFromSelection(selected: string, regex: boolean): string | undefined {
  if (selected === '' || /[\r\n]/.test(selected)) return undefined
  return regex ? selected.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&') : selected
}
