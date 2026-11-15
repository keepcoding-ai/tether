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
//   src/vs/workbench/contrib/search/browser/searchActionsRemoveReplace.ts (replace a match, a file, a folder; replace all)
// Replacing checks each range against the found text first (replace.ts): a file that changed after the search is skipped,
// stays in the tree and is named on the message line.
// The open editors' text is the search input for their files (buffer-search.ts, getLocalResults): searched in memory at
// the start, their files dropped from the disk's batches. While results are shown, each open model in the search is
// watched (FileMatch.bindModel): an edit recomputes its file 250 ms after the last change; a replace of one match
// recomputes the rest of its file (from its model, or from disk by `searchFile`), so the positions never go stale.
// The include field's two switches narrow the query: "only open editors" searches the files open in panes (searchView.ts
// onQueryChanged -> QueryBuilder onlyOpenEditors), "only changed files" asks main for the git changes of the projects first
// and searches just those (changedFiles); with both on, the open files that changed. The rows' menu copies (searchActionsCopy.ts),
// restricts the search to a folder or leaves it out (searchActionsFind.ts); the explorer's "Pesquisar na pasta…" comes through api.ts.
// With the replace field open, activating a match (not "to the side") shows the replace preview (preview-panel.ts) instead
// of opening the file, while the setting useReplacePreview is on; the preview follows the results and the replace term.
// Left out (next steps): the search editor.
import type { ContextMenuEntry, PadHost, PadView, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { monaco } from '../../../app/renderer/monaco.ts'
import { createPathOps, QueryBuilder, type ITextQueryBuilderOptions, type QueryBuilderEnv, type SearchFolder } from '../../../app/shared/vscode-search-query.ts'
import { dirname, editsOf, FileMatch, FolderMatch, Match, SearchModel, SearchResult, type RenderableMatch } from '../../../app/shared/vscode-search-model.ts'
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS, type IFileMatch, type ITextQuery, type ITextSearchResult } from '../../../app/shared/vscode-search.ts'
import type { SearchChannels, SearchDone } from '../ipc.ts'
import { applyFileResults, bufferInQuery, bufferResults, bufferSearch, matchCount, mergeDiskBatch, resourceOf } from './buffer-search.ts'
import { copyAllText, copyPathText, copyText, lineDelimiter } from './copy-rules.ts'
import type { ReplacePreview } from './preview-panel.ts'
import { opensPreview } from './preview-rules.ts'
import { applyReplace } from './replace.ts'
import { afterReplace, isQuietSingle, replaceAllConfirmation, replaceSummary, toRemove, type ReplaceOutcome } from './replace-rules.ts'
import { replaceLabel } from './results-rules.ts'
import { SearchResults, type ResultsSnapshot } from './results.ts'
import {
  completionMessage, countLine, engineErrorText, excludeExpression, folderPattern, mergePattern, NO_CHANGED_FILES_MESSAGE, NO_FOLDER_MESSAGE,
  NO_OPEN_EDITORS_MESSAGE, readSortOrder, readViewState, regexError, seedFromSelection, triggerOf, withLocalLimit, type MessageLine,
  type SearchScope, type ViewMode,
} from './view-rules.ts'
import { SearchWidget, type SearchWidgetState } from './widget.ts'

const PLATFORM: 'win32' | 'posix' = /^win/i.test(navigator.platform) ? 'win32' : 'posix'
const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)
const IS_LINUX = /linux/i.test(navigator.platform)
/** The count on the message line follows a running search at most this often. */
const COUNT_EVERY_MS = 100
/** The fields' values enter their histories once the person stops changing the search for this long (VS Code's delayer). */
const HISTORY_DELAY_MS = 2000
/** An edit of an open file recomputes its results once its text has been still for this long (FileMatch's scheduler). */
const MODEL_UPDATE_MS = 250

/** The switches of the include field that restrict a search. */
const scopeOf = (s: SearchWidgetState): SearchScope => ({ onlyOpenEditors: s.onlyOpenEditors, onlyChangedFiles: s.onlyChangedFiles })

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
  /** Which of the include field's switches narrowed this search. */
  scope: SearchScope
  started: number
  /** A batch arrived (the previous search's results are gone). */
  added: boolean
  byUser: boolean
  /** The keys (PathIdentity) of the files searched in memory: the disk's batches leave them out. */
  buffered: Set<string>
  /** Matches the disk's batches may still add (maxResults less what the open editors gave). */
  remaining: number
  /** The open editors hit the limit, or a disk batch was cut to it. */
  localLimitHit: boolean
}

/** The search whose results are on screen: what recomputes a file. */
interface Shown {
  query: ITextQuery
  included: (path: string) => boolean
}

type TextModel = monaco.editor.ITextModel

/** A search that ended, with how. */
interface Ended extends Live { done: Exclude<SearchDone, { kind: 'error' }> }

export interface SearchViewSnapshot {
  widget: ReturnType<SearchWidget['snapshot']>
  /** The message line, one entry per line. */
  message: string[]
  searching: boolean
  /** A replace is being confirmed or applied. */
  replacing: boolean
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
  private readonly preview: ReplacePreview
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
  /** Grows with every request to search (and whenever the running search is dropped): a changed-files answer for an older one is ignored. */
  private ticket = 0
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
  /** A replace is asking for confirmation or being applied: other replaces are ignored, a search waits for its end. */
  private busy: 'confirm' | 'apply' | undefined
  /** A search was asked for while a replace ran: it runs when the replace ends. */
  private searchAfter = false
  /** Grows whenever the results model is emptied or refilled: a replace that ends after that leaves the new results alone. */
  private epoch = 0
  /** The search the results on screen come from, while they are shown. */
  private shown: Shown | undefined
  /** The open models watched for edits; the watch of the models opened later. */
  private readonly bound = new Map<TextModel, { listener: IDisposable; timer: ReturnType<typeof setTimeout> | undefined }>()
  private modelWatch: IDisposable | undefined
  /** Files to recompute once the running search (or replace) ends. */
  private readonly pending = new Set<string>()
  /** The keys of files the person took out of the results as a whole (dismissed, replaced): an edit does not bring them back. */
  private readonly dropped = new Set<string>()

  constructor(ui: TetherUi, host: PadHost, preview: ReplacePreview) {
    this.ui = ui
    this.host = host
    this.preview = preview
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
      sortOrder: () => readSortOrder(ui.settings.get<string>('sortOrder')),
      collapseResults: () => {
        const v = ui.settings.get<string>('collapseResults')
        return v === 'auto' || v === 'alwaysCollapse' ? v : 'alwaysExpand'
      },
      showLineNumbers: () => ui.settings.get<boolean>('showLineNumbers') === true,
      open: (match, opts) => this.open(match, opts.side),
      replace: element => this.replace(element),
      dismiss: element => this.dismiss(element),
      copy: element => this.copyRow(element),
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
      ui.settings.onChange('sortOrder', () => this.results.refresh()),
      preview.attach({
        model: this.model,
        fileOf: path => this.fileOf(path),
        busy: () => this.mustWait(),
        replaceShown: () => this.widget.state().replaceShown,
      }),
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
    this.unbindModels()
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

  /** F4 / Shift+F4: the next (previous) match is selected in the tree and opened (the keyboard goes to the editor), or shown in the replace preview. */
  step(backwards: boolean): void {
    const match = backwards ? this.results.previous() : this.results.next()
    if (match) this.open(match, false)
  }

  /** "Substituir nos arquivos": the pad with the replace field open and the keyboard in it. */
  focusReplace(): void {
    this.widget.focusReplace()
    this.results.layout()
  }

  /**
   * Replaces a match, a file, a folder or everything (asked first). Only while the replace field is open; while a replace
   * or a search runs nothing is replaced (the edits are computed from the results on screen).
   */
  replace(target: RenderableMatch | 'all'): void {
    if (this.disposed || this.busy || this.live || !this.model.replaceActive || !this.model.replacePattern) return
    if (this.model.searchResult.count() === 0) return
    if (target === 'all') { void this.confirmReplaceAll(); return }
    void this.runReplace(target)
  }

  /** The row the tree's keyboard is on. */
  replaceFocused(): void {
    const e = this.results.focused()
    if (e) this.replace(e)
  }

  status(): { searching: boolean; replacing: 'confirm' | 'apply' | undefined; count: number; fileCount: number; message: string[] } {
    return {
      searching: this.live !== undefined, replacing: this.busy, count: this.model.searchResult.count(), fileCount: this.model.searchResult.fileCount(),
      message: this.message.map(l => l.text),
    }
  }

  snapshot(): SearchViewSnapshot {
    return {
      widget: this.widget.snapshot(),
      message: this.message.map(l => l.text),
      searching: this.live !== undefined,
      replacing: this.busy !== undefined,
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

  /** The files open in the window's panes (a note, a preview), each once. */
  private openFiles(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const pane of this.ui.panes.all()) {
      if (!pane.file) continue
      const key = this.model.searchResult.paths.key(pane.file)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(pane.file)
    }
    return out
  }

  /** `changed`: the git changes, when "only changed files" is on; the open files are then narrowed to them (the builder lets "open editors" win over "changed files"). */
  private env(folders: SearchFolder[], changed?: readonly string[]): QueryBuilderEnv {
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
      openEditors: () => {
        const open = this.openFiles()
        if (!changed) return open
        const keys = new Set(changed.map(p => this.model.searchResult.paths.key(p)))
        return open.filter(p => keys.has(this.model.searchResult.paths.key(p)))
      },
      platform: PLATFORM,
    }
  }

  private runSearch(): void {
    if (this.disposed) return
    clearTimeout(this.typeTimer)
    this.typeTimer = undefined
    const ticket = ++this.ticket
    if (this.busy) { this.searchAfter = true; return }
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
    if (s.onlyOpenEditors && this.openFiles().length === 0) {
      this.stopLive()
      this.widget.setSearchMessage(undefined)
      this.clearResults()
      this.setMessage([{ text: NO_OPEN_EDITORS_MESSAGE, tone: 'info' }])
      return
    }
    if (!s.onlyChangedFiles) { this.startSearch(s, folders, undefined); return }
    // The git changes come from main; only the newest request goes on with them.
    this.ipc.invoke('changedFiles', folders.map(f => f.path)).then(
      changed => {
        if (ticket !== this.ticket || this.disposed) return
        if (this.busy) { this.searchAfter = true; return }
        if (changed.length === 0) {
          this.stopLive()
          this.widget.setSearchMessage(undefined)
          this.clearResults()
          this.setMessage([{ text: NO_CHANGED_FILES_MESSAGE, tone: 'info' }])
          return
        }
        this.startSearch(s, folders, changed)
      },
      err => {
        if (ticket !== this.ticket || this.disposed) return
        this.widget.setSearchMessage({ text: err instanceof Error ? err.message : String(err), tone: 'error' })
      },
    )
  }

  /** Builds the query from the fields and starts it; `changed` is the git changes when "only changed files" is on. */
  private startSearch(s: SearchWidgetState, folders: SearchFolder[], changed: readonly string[] | undefined): void {
    const built = this.buildQuery(s, folders, changed)
    if (!built) return
    const { query, builder } = built
    if (query.folderQueries.length === 0) {
      // Nothing the switches allow lies in the projects (the open files that also changed: none): there is nothing to ask the engine.
      this.stopLive()
      this.widget.setSearchMessage(undefined)
      this.clearResults()
      this.setMessage(completionMessage({ kind: 'done', results: 0, files: 0, include: s.include, exclude: s.exclude, useExcludes: s.useExcludesAndIgnoreFiles, scope: scopeOf(s) }))
      return
    }
    this.widget.setSearchMessage(undefined)
    this.stopLive()
    const id = ++this.seq
    const shown: Shown = { query, included: path => builder.pathIncludedInQuery(query, path) }
    // The open editors first, from their text (getLocalResults); their files stay out of the disk's batches.
    const local = this.searchBuffers(shown)
    this.live = {
      id, query, include: s.include, exclude: s.exclude, useExcludes: s.useExcludesAndIgnoreFiles, scope: scopeOf(s), started: performance.now(), added: false, byUser: false,
      buffered: local.keys, remaining: local.remaining, localLimitHit: local.limitHit,
    }
    // New roots; the previous results stay on screen until the first batch (or the end) of this search.
    this.model.query = query
    this.dropped.clear()
    this.bindModels(shown)
    this.setSearching(true)
    this.scheduleHistory()
    if (local.files.length > 0) this.addBatch(this.live, local.files)
    this.ipc.invoke('search', id, query).then(
      r => { if (!r.started) this.finish(id, { kind: 'error', message: r.message }) },
      err => this.finish(id, { kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
  }

  private buildQuery(s: SearchWidgetState, folders: SearchFolder[], changed: readonly string[] | undefined): { query: ReturnType<QueryBuilder['text']>; builder: QueryBuilder } | undefined {
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
      ...(s.onlyOpenEditors ? { onlyOpenEditors: true } : {}),
      ...(changed ? { changedFiles: [...changed] } : {}),
    }
    try {
      const builder = new QueryBuilder(this.env(folders, changed))
      const query = builder.text({ pattern: s.search, isRegExp: s.regex, isCaseSensitive: s.caseSensitive, isWordMatch: s.wholeWord }, folders, options)
      return { query, builder }
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
    const merged = mergeDiskBatch(matches, run.buffered, p => this.model.searchResult.paths.key(p), run.remaining)
    run.remaining -= merged.count
    if (merged.trimmed) run.localLimitHit = true
    if (merged.files.length > 0) this.addBatch(run, merged.files)
  }

  /** A batch of the running search enters the results; the first one replaces the previous search's. */
  private addBatch(run: Live, matches: IFileMatch[]): void {
    if (!run.added) {
      // The first batch replaces the previous search's results: the tree starts over (collapse state, scroll).
      run.added = true
      this.epoch++
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
    done = withLocalLimit(done, live.localLimitHit)
    if (!live.added) {
      // Nothing arrived yet: the previous search's results are still in the model. They go; the roots of this search come
      // back for a batch still on its way.
      this.counting = false
      this.epoch++
      this.model.searchResult.clear()
      this.model.query = live.query
      this.results.reset()
    }
    this.ended = { ...live, done }
    this.counting = true
    this.results.refresh()
    this.showCompletion()
    this.runPending()
    this.preview.changed()
  }

  // ---------- the open editors' text ----------

  /** The open models in the search, searched in memory: their results, the keys of their files, what the limit leaves, and whether they hit it. */
  private searchBuffers(shown: Shown): { files: IFileMatch[]; keys: Set<string>; remaining: number; limitHit: boolean } {
    const files: IFileMatch[] = []
    const keys = new Set<string>()
    let remaining = shown.query.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS
    let limitHit = false
    for (const model of monaco.editor.getModels()) {
      const path = this.pathOf(model, shown)
      if (path === undefined) continue
      keys.add(this.model.searchResult.paths.key(path))
      if (limitHit) continue
      const r = bufferSearch(model, shown.query, remaining)
      remaining -= matchCount(r.results)
      if (r.limitHit) limitHit = true
      if (r.results.length > 0) files.push({ resource: path, results: r.results })
    }
    return { files, keys, remaining: Math.max(0, remaining), limitHit }
  }

  /** The model's file as the results name it, when the model takes part in the search. */
  private pathOf(model: TextModel, shown: Shown): string | undefined {
    if (model.uri.scheme !== 'file') return undefined
    const path = resourceOf(model.uri.fsPath, shown.query.folderQueries.map(f => f.folder), CASE_INSENSITIVE)
    return bufferInQuery(model, () => shown.included(path)) ? path : undefined
  }

  /** Watches the open models in the search, and the models opened from now on, for edits. */
  private bindModels(shown: Shown): void {
    this.unbindModels()
    this.shown = shown
    for (const model of monaco.editor.getModels()) this.bindModel(model)
    this.modelWatch = monaco.editor.onDidCreateModel(model => this.bindModel(model))
  }

  /** An edit recomputes the model's file once the text has been still for MODEL_UPDATE_MS (one timer per model). */
  private bindModel(model: TextModel): void {
    const shown = this.shown
    if (!shown || this.bound.has(model) || this.pathOf(model, shown) === undefined) return
    const entry: { listener: IDisposable; timer: ReturnType<typeof setTimeout> | undefined } = { listener: { dispose: () => {} }, timer: undefined }
    const change = model.onDidChangeContent(() => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        const path = this.shown && !model.isDisposed() ? this.pathOf(model, this.shown) : undefined
        if (path !== undefined) void this.recompute(path)
      }, MODEL_UPDATE_MS)
    })
    const gone = model.onWillDispose(() => this.unbindModel(model))
    entry.listener = { dispose: () => { change.dispose(); gone.dispose() } }
    this.bound.set(model, entry)
  }

  private unbindModel(model: TextModel): void {
    const entry = this.bound.get(model)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.listener.dispose()
    this.bound.delete(model)
  }

  /** Stops watching the models (results cleared, a new search, the pad gone). */
  private unbindModels(): void {
    this.modelWatch?.dispose()
    this.modelWatch = undefined
    for (const model of [...this.bound.keys()]) this.unbindModel(model)
    this.shown = undefined
    this.pending.clear()
  }

  /**
   * Recomputes one file of the results from its text now: an open model is searched in memory, a closed file again on
   * disk (`searchFile`). While a search or a replace runs it waits for its end.
   */
  private async recompute(path: string): Promise<void> {
    const shown = this.shown
    if (!shown || this.disposed) return
    if (this.mustWait()) { this.pending.add(path); return }
    if (this.dropped.has(this.model.searchResult.paths.key(path))) return
    const epoch = this.epoch
    const model = monaco.editor.getModel(monaco.Uri.file(path))
    let results: ITextSearchResult[]
    if (model) results = bufferResults(model, shown.query)
    else {
      try {
        results = (await this.ipc.invoke('searchFile', shown.query, path))?.results ?? []
      } catch {
        return // refused or failed: the file keeps the results it has
      }
    }
    if (this.disposed || epoch !== this.epoch || this.shown !== shown) return
    if (this.mustWait()) { this.pending.add(path); return }
    applyFileResults(this.model.searchResult, path, results)
  }

  /** A search runs or a replace is being applied: the results are not touched until it ends. */
  private mustWait(): boolean {
    return this.live !== undefined || this.busy === 'apply'
  }

  /** The files that waited for a search or a replace to end. */
  private runPending(): void {
    if (this.pending.size === 0 || this.live || this.busy) return
    const paths = [...this.pending]
    this.pending.clear()
    for (const p of paths) void this.recompute(p)
  }

  /** The person dismisses a row: a file or a folder leaves for good (an edit of its text does not bring it back). */
  private dismiss(element: RenderableMatch): void {
    if (!(element instanceof Match)) {
      const files = element instanceof FileMatch ? [element] : element.allDownstreamFileMatches()
      for (const f of files) this.dropped.add(this.model.searchResult.paths.key(f.resource))
    }
    this.model.searchResult.remove(element)
  }

  /** The message of the search that ended, over the results shown now. */
  private showCompletion(): void {
    const e = this.ended
    if (!e) return
    const r = this.model.searchResult
    this.setMessage(completionMessage({
      kind: e.done.kind, results: r.count(), files: r.fileCount(), include: e.include, exclude: e.exclude, useExcludes: e.useExcludes, scope: e.scope,
      ...(e.done.kind === 'done' ? { limitHit: e.done.limitHit, messages: e.done.messages } : {}), byUser: e.byUser,
    }))
  }

  /** Drops the running search without a word (a newer one, an empty term, clearing). */
  private stopLive(): void {
    this.ticket++
    this.ended = undefined
    const live = this.live
    if (!live) return
    this.live = undefined
    this.ipc.send('cancel', live.id)
    this.setSearching(false)
  }

  private clearResults(): void {
    this.epoch++
    this.unbindModels()
    this.dropped.clear()
    this.ended = undefined
    this.counting = false
    clearTimeout(this.countTimer)
    this.countTimer = undefined
    this.model.searchResult.clear()
    this.results.reset()
    this.preview.close()
    this.updateTopbar()
  }

  /** The results changed: during a search the count follows at most every COUNT_EVERY_MS; otherwise (a dismissal) at once. */
  private onResultsChanged(): void {
    if (this.disposed) return
    this.updateTopbar()
    this.preview.changed()
    if (!this.counting) return
    if (!this.live) { this.showCount(); return }
    if (this.countTimer !== undefined) return
    this.countTimer = setTimeout(() => { this.countTimer = undefined; if (this.live) this.showCount() }, COUNT_EVERY_MS)
  }

  private showCount(): void {
    const r = this.model.searchResult
    const useExcludes = this.live?.useExcludes ?? this.widget.state().useExcludesAndIgnoreFiles
    this.setMessage([{ text: countLine(r.count(), r.fileCount(), useExcludes, (this.live ?? this.ended)?.scope ?? scopeOf(this.widget.state())), tone: 'info' }])
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
    // The preview shows what the replace field would do: it closes with the field and follows its term.
    if (s.replaceShown) this.preview.changed()
    else this.preview.close()
  }

  private updateReplaceAll(): void {
    this.widget.setReplaceAllEnabled(this.model.searchResult.count() > 0 && this.widget.state().replaceShown && this.busy === undefined)
  }

  // ---------- replacing ----------

  private async confirmReplaceAll(): Promise<void> {
    const r = this.model.searchResult
    this.busy = 'confirm'
    this.updateReplaceAll()
    let ok = false
    try {
      const answer = await this.ui.dialogs.ask(replaceAllConfirmation(r.count(), r.fileCount(), this.model.replaceString))
      ok = answer.choice === 'replace'
    } finally {
      this.busy = undefined
    }
    if (ok && !this.disposed && this.model.replaceActive && this.model.replacePattern) await this.runReplace(r)
    else this.afterReplace()
  }

  private async runReplace(target: RenderableMatch | SearchResult): Promise<void> {
    const files = editsOf(target, this.model)
    if (files.length === 0) { this.afterReplace(); return }
    // What leaves the tree once written: the match itself, or the files (those of a folder, or all of them).
    const targets: { path: string; element: RenderableMatch }[] = target instanceof Match
      ? [{ path: target.parent().resource, element: target }]
      : (target instanceof FileMatch ? [target] : target instanceof SearchResult ? target.matches() : target.allDownstreamFileMatches())
          .map(f => ({ path: f.resource, element: f }))
    const epoch = this.epoch
    this.busy = 'apply'
    this.setSearching(this.live !== undefined)
    this.updateReplaceAll()
    let outcomes: ReplaceOutcome[]
    try {
      outcomes = await applyReplace(files, this.ipc)
    } finally {
      this.busy = undefined
      this.setSearching(this.live !== undefined)
    }
    if (this.disposed) return
    if (epoch === this.epoch) {
      const gone = toRemove(targets, outcomes)
      if (gone.length > 0) this.model.searchResult.batchRemove(gone)
      // A file with matches left after one was replaced is searched again: their positions moved with the new text.
      const todo = afterReplace(target instanceof Match ? 'match' : 'many', outcomes, p => this.fileOf(p) !== null)
      for (const p of todo.dropped) this.dropped.add(this.model.searchResult.paths.key(p))
      for (const p of todo.recompute) this.pending.add(p)
      // A single match replaced keeps the count line, unless nothing is left to count.
      if (isQuietSingle(target instanceof Match ? 'match' : 'many', outcomes) && this.model.searchResult.count() > 0) this.showCount()
      else this.setMessage(replaceSummary(outcomes))
    }
    this.afterReplace()
  }

  /** A replace ended: the actions come back, and a search asked for meanwhile runs now. */
  private afterReplace(): void {
    this.updateReplaceAll()
    this.preview.changed()
    if (this.searchAfter && !this.disposed) { this.searchAfter = false; this.runSearch(); return }
    this.runPending()
  }

  /** The file's entry in the results, when it has one. */
  private fileOf(path: string): FileMatch | null {
    return this.model.searchResult.getFolderMatch(path)?.getDownstreamFileMatch(path) ?? null
  }

  // ---------- the tree's actions ----------

  /**
   * Opens the match's file with its range selected; `root` is the project that holds it (else the file's folder). With the
   * replace field open (and useReplacePreview on) a match activated in place shows the replace preview instead.
   */
  private open(match: Match, side: boolean): void {
    if (opensPreview({ replaceShown: this.model.replaceActive, useReplacePreview: this.ui.settings.get<boolean>('useReplacePreview') !== false, side })) {
      this.preview.show(match)
      return
    }
    const file = match.parent().resource
    const r = match.range()
    const root = this.ui.workspace.folderOf(file)?.path ?? dirname(file)
    void this.ui.openers.open(file, {
      side, root,
      position: { line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn },
    })
  }

  /** The row's context menu: replace and dismiss, the folder's restrict/exclude, then the copies. */
  private rowMenu(element: RenderableMatch): ContextMenuEntry[] {
    const out: ContextMenuEntry[] = []
    // The replace entry only while the replace field is open (as the row buttons).
    if (this.model.replaceActive) {
      out.push({ icon: 'swap', label: replaceLabel(element instanceof Match ? 'match' : element instanceof FileMatch ? 'file' : 'folder'), run: () => this.replace(element) })
    }
    out.push({ icon: 'x', label: 'Dispensar', run: () => this.dismiss(element) })
    const path = copyPathText(element)
    // The folder of files outside every project has no path to restrict the search to.
    if (element instanceof FolderMatch && path) {
      out.push(
        'sep',
        { icon: 'folder-open', label: 'Restringir a pesquisa à pasta', run: () => this.restrictToFolder(path) },
        { icon: 'eye-closed', label: 'Excluir a pasta da pesquisa', run: () => this.excludeFolder(path) },
      )
    }
    out.push('sep', { icon: 'copy', label: 'Copiar', run: () => this.copyRow(element) })
    if (path) out.push({ icon: 'copy', label: 'Copiar caminho', run: () => this.ui.shell.writeClipboard(path) })
    out.push({ icon: 'copy', label: 'Copiar tudo', run: () => this.copyAll() })
    return out
  }

  /** "Copiar": the row as text (a match, a file with its matches, a folder with its files). */
  private copyRow(element: RenderableMatch): void {
    const text = copyText(element, lineDelimiter(PLATFORM))
    if (text !== undefined) this.ui.shell.writeClipboard(text)
  }

  /** "Copiar tudo": every root of the results. */
  private copyAll(): void {
    const text = copyAllText(this.model.searchResult, lineDelimiter(PLATFORM))
    if (text !== undefined) this.ui.shell.writeClipboard(text)
  }

  /** "Restringir a pesquisa à pasta": the include field becomes the folder, the details open and the search runs again. */
  private restrictToFolder(path: string): void {
    const pattern = folderPattern(path, this.folders(), PLATFORM)
    if (pattern === undefined) return
    this.widget.setState({ include: pattern, detailsShown: true })
    this.host.persist()
    this.onQueryEdit('toggle')
  }

  /** "Excluir a pasta da pesquisa": the folder joins the exclude field (once) and the search runs again. */
  private excludeFolder(path: string): void {
    const pattern = folderPattern(path, this.folders(), PLATFORM)
    if (pattern === undefined) return
    this.widget.setState({ exclude: mergePattern(this.widget.state().exclude, pattern), detailsShown: true })
    this.host.persist()
    this.onQueryEdit('toggle')
  }

  /** The explorer's "Pesquisar na pasta…": the include field becomes the folder, the details open, the keyboard goes to the search field. */
  findInFolder(path: string): void {
    const pattern = folderPattern(path, this.folders(), PLATFORM)
    if (pattern === undefined) return
    this.widget.setState({ include: pattern, detailsShown: true })
    this.host.persist()
    if (this.widget.state().search !== '') this.onQueryEdit('toggle')
    this.widget.focusSearch(true)
    this.results.layout()
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

  /** The progress bar: a search running, or a replace being applied. */
  private setSearching(on: boolean): void {
    this.element.classList.toggle('searching', on || this.busy === 'apply')
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
