// The search pad's fields (VS Code's searchWidget: the search field with its three toggles, the replace field with "preserve
// case" and "Substituir tudo", the details with "files to include/exclude"). The widget only holds and edits the query; the
// host (the pad) runs the search, shows the results and persists the state through the events.
// Origin: https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/{searchWidget,patternInputWidget,searchFindInput}.ts,
//   src/vs/base/browser/ui/findinput/{findInput,replaceInput}.ts
// Left out: the context view and its history dropdown, the keybinding service (the Alt shortcuts are read here), the
// "search on type" setting (the host debounces), the notebook filters.
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import { Emitter, type Event } from '../../../app/shared/vscode-event.ts'
import {
  arrowAction, fieldHeight, FieldHistory, lineCount, normalizeHistory, normalizeState, toggleForKey,
  type HistoryField, type SearchWidgetHistory, type SearchWidgetState,
} from './widget-rules.ts'

export type { SearchWidgetHistory, SearchWidgetState } from './widget-rules.ts'

/**
 * The field's metrics (kept in sync with widget.css): line height, and what a text area adds around its lines (3px of padding
 * and 1px of border, top and bottom: the box is border-box, so the height includes them, as the 26px input's does).
 */
const LINE_HEIGHT = 18
const FIELD_PADDING = 8
/** Width the toggles take at the right of a field, per toggle, plus the gap before the text. */
const TOGGLE_WIDTH = 22

type FlagKey = 'caseSensitive' | 'wholeWord' | 'regex' | 'preserveCase' | 'onlyOpenEditors' | 'onlyChangedFiles' | 'useExcludesAndIgnoreFiles'

interface Field {
  readonly key: HistoryField
  readonly el: HTMLTextAreaElement | HTMLInputElement
  readonly hist: FieldHistory
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  return e
}

export class SearchWidget {
  readonly element = el('div', 'srw')

  private s: SearchWidgetState
  private readonly cleanups: (() => void)[] = []
  private readonly emitters: Emitter<never>[] = []
  private disposed = false

  private readonly changeQuery = this.emitter<{ typed: boolean }>()
  private readonly submit = this.emitter<void>()
  private readonly changeReplace = this.emitter<void>()
  private readonly toggleReplace = this.emitter<boolean>()
  private readonly toggleDetails = this.emitter<boolean>()
  private readonly requestReplaceAll = this.emitter<void>()
  private readonly cancel = this.emitter<void>()
  private readonly focusResults = this.emitter<void>()
  private readonly changeState = this.emitter<void>()

  readonly onDidChangeQuery: Event<{ typed: boolean }> = this.changeQuery.event
  readonly onDidSubmit: Event<void> = this.submit.event
  readonly onDidChangeReplace: Event<void> = this.changeReplace.event
  readonly onDidToggleReplace: Event<boolean> = this.toggleReplace.event
  readonly onDidToggleDetails: Event<boolean> = this.toggleDetails.event
  readonly onDidRequestReplaceAll: Event<void> = this.requestReplaceAll.event
  readonly onDidCancel: Event<void> = this.cancel.event
  readonly onDidRequestFocusResults: Event<void> = this.focusResults.event
  readonly onDidChangeState: Event<void> = this.changeState.event

  private readonly searchField: Field
  private readonly replaceField: Field
  private readonly includeField: Field
  private readonly excludeField: Field
  private readonly fields: Field[]
  private readonly toggles = new Map<FlagKey, HTMLButtonElement>()
  private readonly arrow: HTMLButtonElement
  private readonly dots: HTMLButtonElement
  private readonly replaceAll: HTMLButtonElement
  private readonly replaceRow: HTMLElement
  private readonly details: HTMLElement
  private readonly message: HTMLElement
  private messageText: string | undefined
  private replaceAllEnabled = false

  constructor(initial?: Partial<SearchWidgetState>, history?: Partial<SearchWidgetHistory>) {
    this.s = normalizeState(initial)
    const h = normalizeHistory(history)
    const root = this.element

    // Left column: the arrow, as tall as the fields beside it.
    this.arrow = this.button('srw-arrow', 'Alternar substituição', '')
    this.arrow.setAttribute('aria-expanded', 'false')
    this.on(this.arrow, 'click', () => this.setReplaceShown(!this.s.replaceShown))

    const main = el('div', 'srw-main')
    const fieldsCol = el('div', 'srw-fields')
    main.append(this.arrow, fieldsCol)

    this.searchField = this.makeField('search', 'textarea', 'Pesquisar', 'Pesquisar', h.search)
    const searchBox = this.box(this.searchField, [
      this.toggle('caseSensitive', 'Aa', 'Diferenciar maiúsculas de minúsculas', 'Alt+C'),
      this.toggle('wholeWord', 'ab', 'Palavra inteira', 'Alt+W'),
      this.toggle('regex', '.*', 'Expressão regular', 'Alt+R'),
    ])
    this.message = el('div', 'srw-msg')
    this.message.hidden = true
    this.message.setAttribute('role', 'alert')

    this.replaceField = this.makeField('replace', 'textarea', 'Substituir', 'Substituir', h.replace)
    const replaceBox = this.box(this.replaceField, [this.toggle('preserveCase', 'AB', 'Preservar maiúsculas', 'Alt+P')])
    this.replaceAll = this.button('ib srw-replace-all', 'Substituir tudo', 'Ctrl+Alt+Enter')
    this.replaceAll.append(icon('checks'))
    this.replaceAll.disabled = true
    this.on(this.replaceAll, 'click', () => { if (this.replaceAllEnabled) this.requestReplaceAll.fire() })
    this.replaceRow = el('div', 'srw-replace-row')
    this.replaceRow.append(replaceBox, this.replaceAll)

    fieldsCol.append(searchBox, this.message, this.replaceRow)

    // The "…" that opens the details, at the right under the fields.
    this.dots = this.button('ib srw-dots', 'Alternar detalhes da pesquisa', '')
    this.dots.append(icon('dots-three'))
    this.dots.setAttribute('aria-expanded', 'false')
    this.on(this.dots, 'click', () => this.setDetailsShown(!this.s.detailsShown))
    const more = el('div', 'srw-more')
    more.append(this.dots)

    // The details: files to include (with "only changed files" and "only open editors"), files to exclude.
    this.includeField = this.makeField('include', 'input', 'arquivos a incluir', 'ex.: *.ts, src/**/include', h.include)
    this.excludeField = this.makeField('exclude', 'input', 'arquivos a excluir', 'ex.: *.ts, src/**/exclude', h.exclude)
    const includeBox = this.box(this.includeField, [
      this.toggle('onlyChangedFiles', 'git-diff', 'Pesquisar só nos arquivos alterados'),
      this.toggle('onlyOpenEditors', 'book-open', 'Pesquisar só nos editores abertos'),
    ])
    const excludeBox = this.box(this.excludeField, [
      this.toggle('useExcludesAndIgnoreFiles', 'gear-six', 'Usar exclusões das configurações e arquivos ignore'),
    ])
    this.details = el('div', 'srw-details')
    this.details.append(this.label('arquivos a incluir', this.includeField), includeBox, this.label('arquivos a excluir', this.excludeField), excludeBox)

    root.append(main, more, this.details)
    this.fields = [this.searchField, this.replaceField, this.includeField, this.excludeField]

    // Alt shortcuts, with the focus anywhere in the widget.
    this.on(root, 'keydown', e => {
      const name = toggleForKey(e as KeyboardEvent)
      if (!name) return
      if (name === 'preserveCase' && !this.s.replaceShown) return
      e.preventDefault()
      this.flip(name)
    })

    this.render()
  }

  // ---- public API ----

  state(): SearchWidgetState { return { ...this.s } }

  /** Programmatic change: the DOM follows, no event fires. */
  setState(partial: Partial<SearchWidgetState>): void {
    this.s = normalizeState({ ...this.s, ...partial })
    for (const f of this.fields) f.hist.reset()
    this.render()
  }

  history(): SearchWidgetHistory {
    return { search: this.searchField.hist.entries(), replace: this.replaceField.hist.entries(), include: this.includeField.hist.entries(), exclude: this.excludeField.hist.entries() }
  }

  clearHistory(): void { for (const f of this.fields) f.hist.clear() }

  focusSearch(select = false): void {
    this.searchField.el.focus()
    if (select) this.searchField.el.select()
  }

  focusReplace(): void {
    if (!this.s.replaceShown) this.setReplaceShown(true)
    this.replaceField.el.focus()
    this.replaceField.el.select()
  }

  hasFocus(): boolean { return this.element.contains(document.activeElement) }

  setReplaceAllEnabled(enabled: boolean): void {
    this.replaceAllEnabled = enabled
    this.replaceAll.disabled = !enabled
  }

  setSearchMessage(message: { text: string; tone: 'error' | 'warning' } | undefined): void {
    this.messageText = message?.text
    this.message.hidden = !message
    this.message.textContent = message?.text ?? ''
    this.message.classList.toggle('warning', message?.tone === 'warning')
    this.searchField.el.classList.toggle('invalid', message?.tone === 'error')
  }

  commitHistory(): void {
    this.searchField.hist.add(this.s.search)
    this.replaceField.hist.add(this.s.replace)
    this.includeField.hist.add(this.s.include)
    this.excludeField.hist.add(this.s.exclude)
  }

  snapshot(): SearchWidgetState & { searchMessage?: string; replaceAllEnabled: boolean } {
    const out: SearchWidgetState & { searchMessage?: string; replaceAllEnabled: boolean } = { ...this.s, replaceAllEnabled: this.replaceAllEnabled }
    if (this.messageText !== undefined) out.searchMessage = this.messageText
    return out
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const c of this.cleanups.splice(0)) c()
    for (const e of this.emitters) e.dispose()
    this.element.remove()
  }

  // ---- building ----

  private emitter<E>(): Emitter<E> {
    const e = new Emitter<E>()
    this.emitters.push(e as unknown as Emitter<never>)
    return e
  }

  /** Adds a listener that dispose removes. */
  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void {
    target.addEventListener(type, fn)
    this.cleanups.push(() => target.removeEventListener(type, fn))
  }

  private button(className: string, label: string, shortcut: string): HTMLButtonElement {
    const b = el('button', className)
    b.type = 'button'
    if (label) {
      b.setAttribute('aria-label', label)
      b.title = shortcut ? `${label} (${shortcut})` : label
    }
    return b
  }

  private label(text: string, field: Field): HTMLElement {
    const l = el('label', 'srw-label')
    l.textContent = text
    l.htmlFor = (field.el.id ||= `srw-${field.key}-${Math.random().toString(36).slice(2, 8)}`)
    return l
  }

  /** A toggle inside a field: a text glyph (Aa, ab, .*, AB) or, when the content is an icon name, an icon. */
  private toggle(key: FlagKey, content: string, label: string, shortcut = ''): HTMLButtonElement {
    const b = this.button('srw-t', label, shortcut)
    if (content === 'ab') {
      const g = el('span', 'srw-glyph srw-ab')
      g.textContent = content
      b.append(g)
    } else if (content === 'Aa' || content === '.*' || content === 'AB') {
      const g = el('span', 'srw-glyph')
      g.textContent = content
      b.append(g)
    } else {
      b.append(icon(content as IconName))
    }
    b.setAttribute('aria-pressed', 'false')
    this.on(b, 'click', () => this.flip(key))
    this.toggles.set(key, b)
    return b
  }

  private box(field: Field, toggles: HTMLButtonElement[]): HTMLElement {
    const box = el('div', 'srw-box')
    const group = el('div', 'srw-toggles')
    group.append(...toggles)
    box.style.setProperty('--srw-pad', `${toggles.length * TOGGLE_WIDTH + 6}px`)
    box.append(field.el, group)
    return box
  }

  private makeField(key: HistoryField, tag: 'textarea' | 'input', label: string, placeholder: string, entries: string[]): Field {
    const e = tag === 'textarea' ? el('textarea', 'srw-field') : el('input', 'srw-field')
    if (e instanceof HTMLTextAreaElement) {
      e.rows = 1
      // No soft wrap: the lines are the text's own, so the arrows, the height and the caret rules agree.
      e.wrap = 'off'
    } else {
      e.type = 'text'
    }
    e.spellcheck = false
    e.autocomplete = 'off'
    e.placeholder = placeholder
    e.setAttribute('aria-label', label)
    e.title = label
    const field: Field = { key, el: e, hist: new FieldHistory(entries) }
    this.on(e, 'input', () => { field.hist.reset(); this.edited(field) })
    this.on(e, 'keydown', ev => this.onFieldKey(field, ev))
    return field
  }

  // ---- behavior ----

  private onFieldKey(field: Field, e: KeyboardEvent): void {
    if (e.isComposing) return
    const { el: input } = field
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    const multi = input instanceof HTMLTextAreaElement
    switch (e.key) {
      case 'Enter':
        if (field.key === 'replace' && e.ctrlKey && e.altKey) { e.preventDefault(); this.requestReplaceAll.fire(); return }
        if (multi && (e.ctrlKey || e.shiftKey) && !e.altKey) {
          // Ctrl+Enter and Shift+Enter break the line (a text area would only do it for Enter).
          e.preventDefault()
          input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end')
          field.hist.reset()
          this.edited(field)
          return
        }
        if (bare) { e.preventDefault(); this.submit.fire() }
        return
      case 'Escape':
        if (bare) { e.preventDefault(); this.cancel.fire() }
        return
      case 'ArrowDown':
      case 'ArrowUp': {
        if (e.key === 'ArrowDown' && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { e.preventDefault(); this.focusResults.fire(); return }
        if (!bare) return
        const dir = e.key === 'ArrowUp' ? 'up' : 'down'
        if (arrowAction(dir, input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0) === 'caret') return
        const value = dir === 'up' ? field.hist.previous(input.value) : field.hist.next()
        if (value !== undefined) {
          e.preventDefault()
          // Going up leaves the caret at the start (the next ↑ walks on), going down at the end.
          this.recall(field, value, dir === 'up' ? 'start' : 'end')
        } else if (dir === 'down' && this.isLastVisible(field)) {
          e.preventDefault()
          this.focusResults.fire()
        }
        return
      }
    }
  }

  private isLastVisible(field: Field): boolean {
    const last = this.s.detailsShown ? this.excludeField : this.s.replaceShown ? this.replaceField : this.searchField
    return last === field
  }

  /** Puts an older entry (or the draft) in the field. It counts as a typed change for the host but keeps the history position. */
  private recall(field: Field, value: string, caret: 'start' | 'end'): void {
    field.el.value = value
    const at = caret === 'start' ? 0 : value.length
    field.el.setSelectionRange(at, at)
    this.edited(field)
  }

  /** The field's text changed (typed, broke a line or recalled): read it, resize it, tell the host. */
  private edited(field: Field): void {
    this.s[field.key] = field.el.value
    this.autosize(field)
    if (field.key === 'replace') this.changeReplace.fire()
    else this.changeQuery.fire({ typed: true })
    this.changeState.fire()
  }

  private autosize(field: Field): void {
    const e = field.el
    if (!(e instanceof HTMLTextAreaElement)) return
    const { height, scrolls } = fieldHeight(lineCount(e.value), LINE_HEIGHT, FIELD_PADDING)
    e.style.height = `${height}px`
    e.classList.toggle('scrolls', scrolls)
  }

  private flip(key: FlagKey): void {
    this.s[key] = !this.s[key]
    this.renderToggles()
    if (key === 'preserveCase') this.changeReplace.fire()
    else this.changeQuery.fire({ typed: false })
    this.changeState.fire()
  }

  private setReplaceShown(shown: boolean): void {
    if (this.s.replaceShown === shown) return
    this.s.replaceShown = shown
    this.render()
    this.toggleReplace.fire(shown)
    this.changeState.fire()
  }

  private setDetailsShown(shown: boolean): void {
    if (this.s.detailsShown === shown) return
    this.s.detailsShown = shown
    this.render()
    this.toggleDetails.fire(shown)
    this.changeState.fire()
  }

  // ---- drawing (from the state, never fires) ----

  private renderToggles(): void {
    for (const [key, b] of this.toggles) b.setAttribute('aria-pressed', String(this.s[key]))
  }

  private render(): void {
    for (const f of this.fields) {
      if (f.el.value !== this.s[f.key]) f.el.value = this.s[f.key]
      this.autosize(f)
    }
    this.renderToggles()
    this.replaceRow.hidden = !this.s.replaceShown
    this.details.hidden = !this.s.detailsShown
    this.arrow.setAttribute('aria-expanded', String(this.s.replaceShown))
    this.dots.setAttribute('aria-expanded', String(this.s.detailsShown))
    this.element.classList.toggle('replace-shown', this.s.replaceShown)
    this.arrow.replaceChildren(icon(this.s.replaceShown ? 'caret-down' : 'caret-right'))
  }
}
