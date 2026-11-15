// The search pad (VS Code's search view): the top bar, the fields (widget.ts), a thin progress bar, the message line and
// the results tree (results.ts), glued to the results model and to main's search service over `ext:search:*`.
// The flow is searchView.ts's: an edit of the fields runs the search (typing after a pause when "search on type" is on, a
// toggle or Enter at once); an empty term cancels and clears; a regex is checked here before it reaches the engine; each
// search has a growing id, a newer one replaces the running one (main cancels it; its late batches are dropped here).
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/searchView.ts            (triggerQueryChange, onQueryChanged, doSearch,
//                                                                     onSearchComplete, clearSearchResults, cancelSearch,
//                                                                     updateTextFromSelection, the result tree's open)
//   src/vs/workbench/contrib/search/browser/searchActionsTopBar.ts   (refresh, clear, collapse/expand, tree/list, cancel)
// Left out (next steps): replacing on disk, the open editors' unsaved text, "only open editors", "only changed files", the
// search editor.
import type { ContextMenuEntry, PadHost, PadView, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { createPathOps, QueryBuilder, type ITextQueryBuilderOptions, type QueryBuilderEnv, type SearchFolder } from '../../../app/shared/vscode-search-query.ts'
import { dirname, FileMatch, Match, SearchModel, SearchSortOrder, type RenderableMatch } from '../../../app/shared/vscode-search-model.ts'
import { DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS } from '../../../app/shared/vscode-search.ts'
import type { SearchChannels, SearchDone } from '../ipc.ts'
import { SearchResults, type ResultsSnapshot } from './results.ts'
import {
  completionMessage, countLine, engineErrorText, excludeExpression, NO_FOLDER_MESSAGE, readViewState, regexError,
  seedFromSelection, triggerOf, type MessageLine, type ViewMode,
} from './view-rules.ts'
import { SearchWidget, type SearchWidgetState } from './widget.ts'

const PLATFORM: 'win32' | 'posix' = /^win/i.test(navigator.platform) ? 'win32' : 'posix'
const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)
const IS_LINUX = /linux/i.test(navigator.platform)
/** The count on the message line follows a running search at most this often. */
const COUNT_EVERY_MS = 100
/** The fields' values enter their histories once the person stops changing the search for this long (VS Code's delayer). */
const HISTORY_DELAY_MS = 2000

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** The running search: its id and what the completion message needs. */
interface Live {
  id: number
  query: ReturnType<QueryBuilder['text']>
  include: string
  exclude: string
  useExcludes: boolean
  started: number
  /** A batch arrived (the previous search's results are gone). */
  added: boolean
  byUser: boolean
}

/** A search that ended, with how. */
interface Ended extends Live { done: Exclude<SearchDone, { kind: 'error' }> }

export interface SearchViewSnapshot {
  widget: ReturnType<SearchWidget['snapshot']>
  /** The message line, one entry per line. */
  message: string[]
  searching: boolean
  viewMode: ViewMode
  count: number
  fileCount: number
  /** How long the last finished search took, in ms. */
  lastSearchMs: number | undefined
  results: ResultsSnapshot
}

export class SearchView implements PadView {
  readonly element = el('div', 'srch')
  private readonly ui: TetherUi
  private readonly host: PadHost
  private readonly ipc: UiIpc<SearchChannels>
  private readonly model = new SearchModel({ caseInsensitive: CASE_INSENSITIVE })
  private readonly widget: SearchWidget
  private readonly results: SearchResults
  private readonly topbar = el('div', 'srch-topbar')
  private readonly progress = el('div', 'srch-progress')
  private readonly messageEl = el('div', 'srch-msg')
  private readonly body = el('div', 'srch-body')
  private readonly subs: IDisposable[] = []
  private readonly buttons: Record<'refresh' | 'clear' | 'view' | 'collapse' | 'cancel' | 'more', HTMLButtonElement>
  private viewMode: ViewMode
  private seq = 0
  private live: Live | undefined
  /** The last search that ended, while its results are shown (for the completion message). */
  private ended: Ended | undefined
  /** The message line follows the results' changes (a search ran and its results are shown). */
  private counting = false
  private message: MessageLine[] = []
  private typeTimer: ReturnType<typeof setTimeout> | undefined
  private countTimer: ReturnType<typeof setTimeout> | undefined
  private historyTimer: ReturnType<typeof setTimeout> | undefined
  private lastSearchMs: number | undefined
  private disposed = false

  constructor(ui: TetherUi, host: PadHost) {
    this.ui = ui
    this.host = host
    this.ipc = ui.ipc<SearchChannels>()
    const saved = readViewState(host.state)
    this.viewMode = saved.viewMode ?? (ui.settings.get<string>('defaultViewMode') === 'tree' ? 'tree' : 'list')
    this.widget = new SearchWidget(saved.widget, saved.history)
    this.model.replaceActive = saved.widget.replaceShown
    this.model.replaceString = saved.widget.replace
    this.model.preserveCase = saved.widget.preserveCase

    this.results = new SearchResults(ui, {
      model: this.model,
      viewMode: () => this.viewMode,
      sortOrder: () => SearchSortOrder.Default,
      collapseResults: () => {
        const v = ui.settings.get<string>('collapseResults')
        return v === 'auto' || v === 'alwaysCollapse' ? v : 'alwaysExpand'
      },
      showLineNumbers: () => ui.settings.get<boolean>('showLineNumbers') === true,
      open: (match, opts) => this.open(match, opts.side),
      replace: element => this.replace(element),
      dismiss: element => this.model.searchResult.remove(element),
      menu: element => this.rowMenu(element),
      describe: element => this.describe(element),
    })

    this.buttons = {
      refresh: this.button('srch-refresh', 'arrows-clockwise', 'Atualizar', () => this.refresh()),
      clear: this.button('srch-clear', 'broom', 'Limpar resultados da pesquisa', () => this.clear()),
      view: this.button('srch-view', 'tree-view', 'Ver como árvore', () => this.setViewMode(this.viewMode === 'tree' ? 'list' : 'tree')),
      collapse: this.button('srch-collapse', 'arrows-in-line-vertical', 'Recolher tudo', () => this.toggleCollapse()),
      cancel: this.button('srch-cancel', 'stop', 'Cancelar pesquisa', () => this.cancel()),
      more: this.button('srch-more', 'dots-three', 'Mais ações da prancheta', () => this.showMore()),
    }
    this.topbar.append(el('span', 'srch-title', 'Pesquisar'), el('span', 'srch-sp'), ...Object.values(this.buttons))
    this.messageEl.setAttribute('role', 'status')
    this.messageEl.setAttribute('aria-live', 'polite')
    this.progress.setAttribute('aria-hidden', 'true')
    this.body.append(this.results.element)
    this.element.append(this.topbar, this.widget.element, this.progress, this.messageEl, this.body)
    this.element.tabIndex = -1
    host.setMenuHosted(true)

    const w = this.widget
    this.subs.push(
      w.onDidChangeQuery(({ typed }) => this.onQueryEdit(typed ? 'typed' : 'toggle')),
      w.onDidSubmit(() => { this.widget.commitHistory(); this.host.persist(); this.onQueryEdit('submit') }),
      w.onDidCancel(() => this.cancel()),
      w.onDidChangeReplace(() => this.syncReplace()),
      w.onDidToggleReplace(() => this.syncReplace()),
      w.onDidRequestReplaceAll(() => this.replace('all')),
      w.onDidRequestFocusResults(() => this.results.focus()),
      w.onDidChangeState(() => this.host.persist()),
      this.results.onDidRequestFocusInput(() => this.widget.focusSearch()),
      this.results.onDidChangeCollapseState(() => this.updateTopbar()),
      this.ipc.on('progress', (id, matches) => this.onProgress(id, matches)),
      this.ipc.on('done', (id, result) => this.finish(id, result)),
      ui.settings.onChange('showLineNumbers', () => this.results.refresh()),
      ui.settings.onChange('collapseResults', () => this.results.refresh()),
    )
    // The results model announces every change (a batch, a dismissal): the tree redraws at its pace, the count follows.
    const onChange = this.model.searchResult.onChange(e => { this.results.update(e); this.onResultsChanged() })
    this.subs.push({ dispose: () => onChange.dispose() })
    // The tree is a virtual list over the space the fields leave: it measures again whenever that space changes.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.results.layout())
      ro.observe(this.body)
      this.subs.push({ dispose: () => ro.disconnect() })
    }
    this.renderMessage()
    this.updateTopbar()
  }

  // ---------- PadView ----------

  focus(): void {
    this.widget.focusSearch(true)
  }

  setVisible(visible: boolean): void {
    if (visible) requestAnimationFrame(() => { if (!this.disposed) this.results.layout() })
  }

  serialize(): unknown {
    return { widget: this.widget.state(), history: this.widget.history(), viewMode: this.viewMode }
  }

  menu(): ContextMenuEntry[] {
    return [{ icon: 'broom', label: 'Limpar histórico de pesquisa', run: () => this.clearHistory() }]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.typeTimer)
    clearTimeout(this.countTimer)
    clearTimeout(this.historyTimer)
    if (this.live) this.ipc.send('cancel', this.live.id)
    this.live = undefined
    for (const s of this.subs) s.dispose()
    this.subs.length = 0
    this.results.dispose()
    this.widget.dispose()
    this.model.dispose()
    this.element.remove()
  }

  // ---------- commands ----------

  /** "Pesquisar nos arquivos": the keyboard in the search field, its text selected; a one-line selection of the editor becomes the term. */
  focusSearch(selected?: string): void {
    const seed = selected === undefined ? undefined : seedFromSelection(selected, this.widget.state().regex)
    if (seed !== undefined && seed !== this.widget.state().search) {
      this.widget.setState({ search: seed })
      this.host.persist()
      this.onQueryEdit('typed')
    }
    this.widget.focusSearch(true)
    this.results.layout()
  }

  /** Runs the current search again. */
  refresh(): void {
    this.runSearch()
  }

  /** Cancels the running search, empties the search and replace fields, the tree and the message; the keyboard goes to the search field. */
  clear(): void {
    this.stopLive()
    this.widget.setState({ search: '', replace: '' })
    this.syncReplace()
    this.widget.setSearchMessage(undefined)
    this.clearResults()
    this.setMessage([])
    this.host.persist()
    this.widget.focusSearch()
  }

  /** The person cancels the running search: what arrived stays. */
  cancel(): void {
    const live = this.live
    if (!live) return
    live.byUser = true
    this.ipc.send('cancel', live.id)
    // Immediate on screen: the batches and the end of this id still on their way are dropped.
    this.finish(live.id, { kind: 'cancelled' })
  }

  collapseAll(): void { this.results.collapseAll(); this.updateTopbar() }
  expandAll(): void { this.results.expandAll(); this.updateTopbar() }

  setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return
    this.viewMode = mode
    this.results.refresh()
    this.updateTopbar()
    this.host.persist()
  }

  toggleDetails(): void {
    this.widget.setState({ detailsShown: !this.widget.state().detailsShown })
    this.host.persist()
  }

  clearHistory(): void {
    this.widget.clearHistory()
    this.host.persist()
  }

  /** F4 / Shift+F4: the next (previous) match is selected in the tree and opened; the keyboard goes to the editor. */
  step(backwards: boolean): void {
    const match = backwards ? this.results.previous() : this.results.next()
    if (match) this.open(match, false)
  }

  /** Replacing: the tree's and the widget's actions are tied here; the disk replace comes in the next step. */
  replace(_target: RenderableMatch | 'all'): void {}

  status(): { searching: boolean; count: number; fileCount: number; message: string[] } {
    return { searching: this.live !== undefined, count: this.model.searchResult.count(), fileCount: this.model.searchResult.fileCount(), message: this.message.map(l => l.text) }
  }

  snapshot(): SearchViewSnapshot {
    return {
      widget: this.widget.snapshot(),
      message: this.message.map(l => l.text),
      searching: this.live !== undefined,
      viewMode: this.viewMode,
      count: this.model.searchResult.count(),
      fileCount: this.model.searchResult.fileCount(),
      lastSearchMs: this.lastSearchMs,
      results: this.results.snapshot(),
    }
  }

  // ---------- the search ----------

  private onQueryEdit(source: 'typed' | 'toggle' | 'submit'): void {
    this.updateTopbar()
    const what = triggerOf(source,this.ui.settings.get<boolean>('searchOnType') !== false)
    if (what === 'none') return
    clearTimeout(this.typeTimer)
    this.typeTimer = undefined
    if (what === 'now') { this.runSearch(); return }
    const delay = this.ui.settings.get<number>('searchOnTypeDebouncePeriod') ?? 300
    this.typeTimer = setTimeout(() => { this.typeTimer = undefined; this.runSearch() }, Math.max(0, delay))
  }

  /** The window's project folders that exist, as the query builder takes them. */
  private folders(): SearchFolder[] {
    return this.ui.workspace.folders().filter(f => !f.missing).map(f => ({ path: f.path, name: f.name }))
  }

  private env(folders: SearchFolder[]): QueryBuilderEnv {
    const s = this.ui.settings
    return {
      folders: () => folders,
      config: () => ({
        exclude: excludeExpression(s.get<string>('exclude')),
        useIgnoreFiles: s.get<boolean>('useIgnoreFiles') !== false,
        useGlobalIgnoreFiles: s.get<boolean>('useGlobalIgnoreFiles') === true,
        useParentIgnoreFiles: s.get<boolean>('useParentIgnoreFiles') === true,
        followSymlinks: s.get<boolean>('followSymlinks') === true,
        smartCase: s.get<boolean>('smartCase') === true,
      }),
      openEditors: () => [],
      platform: PLATFORM,
    }
  }

  private runSearch(): void {
    if (this.disposed) return
    clearTimeout(this.typeTimer)
    this.typeTimer = undefined
    const s = this.widget.state()
    if (s.search === '') {
      this.stopLive()
      this.widget.setSearchMessage(undefined)
      this.clearResults()
      this.setMessage([])
      return
    }
    const folders = this.folders()
    if (folders.length === 0) {
      this.stopLive()
      this.widget.setSearchMessage(undefined)
      this.clearResults()
      this.setMessage([{ text: NO_FOLDER_MESSAGE, tone: 'info' }])
      return
    }
    if (s.regex) {
      // An invalid pattern never reaches the engine; what is shown stays (onQueryChanged returns on an invalid input).
      const error = regexError(s.search)
      if (error) { this.widget.setSearchMessage({ text: error, tone: 'error' }); return }
    }
    const query = this.buildQuery(s, folders)
    if (!query) return
    this.widget.setSearchMessage(undefined)
    this.stopLive()
    const id = ++this.seq
    this.live = { id, query, include: s.include, exclude: s.exclude, useExcludes: s.useExcludesAndIgnoreFiles, started: performance.now(), added: false, byUser: false }
    // New roots; the previous results stay on screen until the first batch (or the end) of this search.
    this.model.query = query
    this.setSearching(true)
    this.scheduleHistory()
    this.ipc.invoke('search', id, query).then(
      r => { if (!r.started) this.finish(id, { kind: 'error', message: r.message }) },
      err => this.finish(id, { kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
  }

  private buildQuery(s: SearchWidgetState, folders: SearchFolder[]): ReturnType<QueryBuilder['text']> | undefined {
    const settings = this.ui.settings
    const off = !s.useExcludesAndIgnoreFiles
    const options: ITextQueryBuilderOptions = {
      maxResults: settings.get<number>('maxResults') ?? undefined,
      disregardIgnoreFiles: off || undefined,
      disregardExcludeSettings: off || undefined,
      ignoreGlobCase: !IS_LINUX || undefined,
      excludePattern: [{ pattern: s.exclude }],
      includePattern: s.include,
      previewOptions: { ...DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS },
      isSmartCase: settings.get<boolean>('smartCase') === true,
      expandPatterns: true,
    }
    try {
      return new QueryBuilder(this.env(folders)).text(
        { pattern: s.search, isRegExp: s.regex, isCaseSensitive: s.caseSensitive, isWordMatch: s.wholeWord }, folders, options)
    } catch (e) {
      // A pattern the builder refuses (a missing folder in "./x", a bad glob): shown under the field, the results go.
      this.widget.setSearchMessage({ text: e instanceof Error ? e.message : String(e), tone: 'error' })
      this.stopLive()
      this.clearResults()
      this.setMessage([])
      return undefined
    }
  }

  private onProgress(id: number, matches: Parameters<SearchChannels['events']['progress']>[1]): void {
    if (this.disposed) return
    const run = this.live?.id === id ? this.live : undefined
    if (!run) return
    if (!run.added) {
      // The first batch replaces the previous search's results: the tree starts over (collapse state, scroll).
      run.added = true
      this.counting = true
      this.model.searchResult.add(matches)
      this.results.reset()
    } else {
      this.model.searchResult.add(matches)
    }
  }

  private finish(id: number, done: SearchDone): void {
    const live = this.live
    if (!live || live.id !== id || this.disposed) return
    this.live = undefined
    this.lastSearchMs = Math.round(performance.now() - live.started)
    this.setSearching(false)
    clearTimeout(this.countTimer)
    this.countTimer = undefined
    if (done.kind === 'error') {
      this.widget.setSearchMessage({ text: engineErrorText(done), tone: 'error' })
      this.clearResults()
      this.setMessage([])
      return
    }
    if (!live.added) {
      // Nothing arrived yet: the previous search's results are still in the model. They go; the roots of this search come
      // back for a batch still on its way.
      this.counting = false
      this.model.searchResult.clear()
      this.model.query = live.query
      this.results.reset()
    }
    this.ended = { ...live, done }
    this.counting = true
    this.results.refresh()
    this.showCompletion()
  }

  /** The message of the search that ended, over the results shown now. */
  private showCompletion(): void {
    const e = this.ended
    if (!e) return
    const r = this.model.searchResult
    this.setMessage(completionMessage({
      kind: e.done.kind, results: r.count(), files: r.fileCount(), include: e.include, exclude: e.exclude, useExcludes: e.useExcludes,
      ...(e.done.kind === 'done' ? { limitHit: e.done.limitHit, messages: e.done.messages } : {}), byUser: e.byUser,
    }))
  }

  /** Drops the running search without a word (a newer one, an empty term, clearing). */
  private stopLive(): void {
    this.ended = undefined
    const live = this.live
    if (!live) return
    this.live = undefined
    this.ipc.send('cancel', live.id)
    this.setSearching(false)
  }

  private clearResults(): void {
    this.ended = undefined
    this.counting = false
    clearTimeout(this.countTimer)
    this.countTimer = undefined
    this.model.searchResult.clear()
    this.results.reset()
    this.updateTopbar()
  }

  /** The results changed: during a search the count follows at most every COUNT_EVERY_MS; otherwise (a dismissal) at once. */
  private onResultsChanged(): void {
    if (this.disposed) return
    this.updateTopbar()
    if (!this.counting) return
    if (!this.live) { this.showCount(); return }
    if (this.countTimer !== undefined) return
    this.countTimer = setTimeout(() => { this.countTimer = undefined; if (this.live) this.showCount() }, COUNT_EVERY_MS)
  }

  private showCount(): void {
    const r = this.model.searchResult
    const useExcludes = this.live?.useExcludes ?? this.widget.state().useExcludesAndIgnoreFiles
    this.setMessage([{ text: countLine(r.count(), r.fileCount(), useExcludes), tone: 'info' }])
  }

  private scheduleHistory(): void {
    clearTimeout(this.historyTimer)
    this.historyTimer = setTimeout(() => {
      this.historyTimer = undefined
      if (this.disposed) return
      this.widget.commitHistory()
      this.host.persist()
    }, HISTORY_DELAY_MS)
  }

  // ---------- replace preview ----------

  /** The replace field, its "preserve case" and whether it is open go to the model; the tree shows the preview. */
  private syncReplace(): void {
    const s = this.widget.state()
    this.model.replaceActive = s.replaceShown
    this.model.preserveCase = s.preserveCase
    this.model.replaceString = s.replace
    this.results.refresh()
    this.updateReplaceAll()
  }

  private updateReplaceAll(): void {
    this.widget.setReplaceAllEnabled(this.model.searchResult.count() > 0 && this.widget.state().replaceShown)
  }

  // ---------- the tree's actions ----------

  /** Opens the match's file with its range selected; `root` is the project that holds it (else the file's folder). */
  private open(match: Match, side: boolean): void {
    const file = match.parent().resource
    const r = match.range()
    const root = this.ui.workspace.folderOf(file)?.path ?? dirname(file)
    void this.ui.openers.open(file, {
      side, root,
      position: { line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn },
    })
  }

  private rowMenu(element: RenderableMatch): ContextMenuEntry[] {
    const dismiss: ContextMenuEntry = { icon: 'x', label: 'Dispensar', run: () => this.model.searchResult.remove(element) }
    if (element instanceof Match) {
      return [{ icon: 'copy', label: 'Copiar', run: () => this.ui.shell.writeClipboard(element.fullPreviewLines().join('\n')) }, 'sep', dismiss]
    }
    const path = element.resource
    return [
      ...(path ? [{ icon: 'copy', label: 'Copiar caminho', run: () => this.ui.shell.writeClipboard(path) } satisfies ContextMenuEntry, 'sep' as const] : []),
      dismiss,
    ]
  }

  /** A file's folder relative to its project (list view only: the tree shows the folders); nothing beside a folder. */
  private describe(element: RenderableMatch): string {
    if (!(element instanceof FileMatch) || this.viewMode === 'tree') return ''
    const root = element.closestRoot?.resource ?? this.ui.workspace.folderOf(element.resource)?.path
    if (!root) return ''
    const rel = createPathOps(PLATFORM).relative(root, dirname(element.resource))
    return rel === '.' ? '' : rel
  }

  // ---------- drawing ----------

  private button(className: string, ic: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', `ib ${className}`)
    b.type = 'button'
    b.append(icon(ic))
    this.label(b, label)
    b.addEventListener('click', ev => { ev.stopPropagation(); onClick() })
    return b
  }

  private label(b: HTMLButtonElement, label: string): void {
    b.title = label
    b.setAttribute('aria-label', label)
  }

  private showMore(): void {
    const r = this.buttons.more.getBoundingClientRect()
    this.ui.menus.context(r.left, r.bottom + 4, [...this.host.menuItems(), 'sep', ...this.menu()])
  }

  private toggleCollapse(): void {
    if (this.results.isAllCollapsed()) this.expandAll()
    else this.collapseAll()
  }

  private setSearching(on: boolean): void {
    this.element.classList.toggle('searching', on)
    this.updateTopbar()
  }

  /** Which top bar actions make sense now, and the two that alternate (tree/list, collapse/expand). */
  private updateTopbar(): void {
    if (this.disposed) return
    const b = this.buttons
    const has = this.model.searchResult.count() > 0
    b.refresh.disabled = this.widget.state().search === ''
    b.clear.disabled = !has
    b.view.disabled = !has
    b.collapse.disabled = !has
    b.cancel.hidden = this.live === undefined
    const tree = this.viewMode === 'tree'
    b.view.replaceChildren(icon(tree ? 'list' : 'tree-view'))
    this.label(b.view, tree ? 'Ver como lista' : 'Ver como árvore')
    const collapsed = this.results.isAllCollapsed()
    b.collapse.replaceChildren(icon(collapsed ? 'arrows-out-line-vertical' : 'arrows-in-line-vertical'))
    this.label(b.collapse, collapsed ? 'Expandir tudo' : 'Recolher tudo')
    this.updateReplaceAll()
  }

  private setMessage(lines: MessageLine[]): void {
    this.message = lines
    this.renderMessage()
  }

  private renderMessage(): void {
    this.messageEl.replaceChildren(...this.message.map(l => el('div', `srch-msg-line ${l.tone}`, l.text)))
    this.messageEl.hidden = this.message.length === 0
  }
}
