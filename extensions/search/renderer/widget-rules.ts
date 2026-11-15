// The rules of the search pad's fields (widget.ts), pure and testable under Node: the history of a field (VS Code's
// HistoryNavigator, as the search widget uses it), when an arrow key walks the history or moves the caret (VS Code's
// stopPropagationForMultiLineUpwards/Downwards), the initial state, the Alt shortcuts and the height of a growing field.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/searchWidget.ts, src/vs/base/common/history.ts, searchHistoryService.ts

export interface SearchWidgetState {
  search: string
  replace: string
  replaceShown: boolean
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  preserveCase: boolean
  detailsShown: boolean
  include: string
  exclude: string
  onlyOpenEditors: boolean
  onlyChangedFiles: boolean
  /** "Usar exclusões das configurações e arquivos ignore": on by default. */
  useExcludesAndIgnoreFiles: boolean
}

export interface SearchWidgetHistory { search: string[]; replace: string[]; include: string[]; exclude: string[] }

export type HistoryField = keyof SearchWidgetHistory

/** The most entries a field's history keeps (the oldest are forgotten). */
export const HISTORY_LIMIT = 100

const STRING_KEYS = ['search', 'replace', 'include', 'exclude'] as const
const FLAG_KEYS = ['replaceShown', 'caseSensitive', 'wholeWord', 'regex', 'preserveCase', 'detailsShown', 'onlyOpenEditors', 'onlyChangedFiles', 'useExcludesAndIgnoreFiles'] as const

export const defaultState = (): SearchWidgetState => ({
  search: '', replace: '', replaceShown: false, caseSensitive: false, wholeWord: false, regex: false, preserveCase: false,
  detailsShown: false, include: '', exclude: '', onlyOpenEditors: false, onlyChangedFiles: false, useExcludesAndIgnoreFiles: true,
})

/** Fills the missing (or ill-typed, e.g. read back from a saved file) values of a state with the defaults. */
export function normalizeState(partial?: Partial<SearchWidgetState> | null): SearchWidgetState {
  const out = defaultState()
  if (!partial || typeof partial !== 'object') return out
  const src = partial as Record<string, unknown>
  const dst = out as unknown as Record<string, string | boolean>
  for (const k of STRING_KEYS) if (typeof src[k] === 'string') dst[k] = src[k]
  for (const k of FLAG_KEYS) if (typeof src[k] === 'boolean') dst[k] = src[k]
  return out
}

/** A list read back from a saved file: only non-empty strings, no consecutive repeat, the newest HISTORY_LIMIT. */
export function normalizeHistoryList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const v of list) if (typeof v === 'string' && v !== '' && out[out.length - 1] !== v) out.push(v)
  return out.slice(-HISTORY_LIMIT)
}

export function normalizeHistory(partial?: Partial<SearchWidgetHistory> | null): SearchWidgetHistory {
  return {
    search: normalizeHistoryList(partial?.search), replace: normalizeHistoryList(partial?.replace),
    include: normalizeHistoryList(partial?.include), exclude: normalizeHistoryList(partial?.exclude),
  }
}

/**
 * The history of one field. The position is an index into the entries; one past the last means "editing": the user is on
 * the text being typed, which is kept (the draft) while an older entry is shown and comes back when the walk passes the end.
 */
export class FieldHistory {
  private items: string[]
  private pos: number
  private draft = ''

  constructor(items: readonly string[] = []) {
    this.items = normalizeHistoryList(items)
    this.pos = this.items.length
  }

  entries(): string[] { return [...this.items] }

  /** True when the position is the text being typed (not an older entry). */
  get editing(): boolean { return this.pos === this.items.length }

  /** Records a value (empty ones and a repeat of the newest are skipped) and goes back to "editing". */
  add(value: string): void {
    if (value !== '' && this.items[this.items.length - 1] !== value) {
      this.items.push(value)
      if (this.items.length > HISTORY_LIMIT) this.items.splice(0, this.items.length - HISTORY_LIMIT)
    }
    this.reset()
  }

  /** The text was typed (not recalled): the walk starts over from it. */
  reset(): void {
    this.pos = this.items.length
    this.draft = ''
  }

  /** The entry before the position, or undefined when there is none (the oldest is shown). `current` is kept as the draft when leaving "editing". */
  previous(current: string): string | undefined {
    if (this.pos === 0 || this.items.length === 0) return undefined
    if (this.editing) this.draft = current
    this.pos--
    return this.items[this.pos]
  }

  /** The entry after the position (the draft after the newest), or undefined when already editing. */
  next(): string | undefined {
    if (this.editing) return undefined
    this.pos++
    return this.editing ? this.draft : this.items[this.pos]
  }

  clear(): void {
    this.items = []
    this.reset()
  }
}

/**
 * What ↑/↓ does in a field: 'history' when the caret is on the first line (↑) or the last one (↓) so the key has no line to
 * move to, else 'caret' (the field moves its own caret). Lines are the text's own (the fields do not soft-wrap).
 */
export function arrowAction(key: 'up' | 'down', value: string, selStart: number, selEnd: number): 'history' | 'caret' {
  if (key === 'up') return value.slice(0, Math.max(0, selStart)).includes('\n') ? 'caret' : 'history'
  return value.indexOf('\n', selEnd) === -1 ? 'history' : 'caret'
}

/** The number of lines of a field's text (an empty text is one line). */
export function lineCount(value: string): number {
  let n = 1
  for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) n++
  return n
}

/** A field grows with its lines up to this many, then scrolls. */
export const MAX_FIELD_LINES = 6

/** The height of a growing field for a text of `lines` lines: from one line up to MAX_FIELD_LINES, then it scrolls. */
export function fieldHeight(lines: number, lineHeight: number, verticalPadding: number): { height: number; scrolls: boolean } {
  const n = Math.max(1, Math.min(MAX_FIELD_LINES, Math.floor(lines) || 1))
  return { height: n * lineHeight + verticalPadding, scrolls: lines > MAX_FIELD_LINES }
}

export type ToggleName = 'caseSensitive' | 'wholeWord' | 'regex' | 'preserveCase'

/** The toggle an Alt+letter shortcut flips (read from the physical key: Alt+letter types other characters on some layouts). */
export function toggleForKey(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ToggleName | undefined {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return undefined
  switch (e.code) {
    case 'KeyC': return 'caseSensitive'
    case 'KeyW': return 'wholeWord'
    case 'KeyR': return 'regex'
    case 'KeyP': return 'preserveCase'
    default: return undefined
  }
}
