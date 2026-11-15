// One dockview panel = one note: a Monaco editor (app/renderer/monaco.ts) over a markdown file. The pane has no
// slot in tetherd; its identity is the file (pane params, app/shared/notes.ts) and its text lives only on disk:
//   - every change is written after a short pause (atomic write in main), so a killed app loses at most the
//     last fraction of a second of typing; the page's unload flushes what is still pending;
//   - cursor, selections, scroll and folds (Monaco's view state) go to the pane params as they change, and the
//     host writes them with the layout: the next launch reopens the tab where it was, as it was;
//   - the file is watched: a change from outside reloads the text (cursor kept) when nothing is pending here,
//     and asks when both sides changed (app/shared/notes.ts externalChangeAction);
//   - while the editor has the focus, its actions are the app's commands (the host registers what `commands()`
//     returns), so the palette lists them with their chords.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import type { Command } from './commands.ts'
import { icon, setIcon } from './icons.ts'
import { defineTheme, type Editor, monaco, THEME_NAME, type ViewState } from './monaco.ts'
import { chordFromLabel, EDITOR_GROUP, editorCommandId } from './note-rules.ts'
import { terminalFontOptions, type TerminalAppearance } from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'
import type { NoteRead, NoteWritten } from '../shared/api.ts'
import { externalChangeAction, noteParams, noteTitle, type NoteView } from '../shared/notes.ts'
import { mountTabEmblem } from './tab-emblems.ts'

/** How long after the last keystroke the text is written. */
export const NOTE_SAVE_DEBOUNCE_MS = 300
/** How often, at most, the view state is handed to the host while the cursor moves. */
const VIEW_THROTTLE_MS = 250
/** For how long after loading the saved view is applied again on every layout (a viewport that was not final yet). */
const VIEW_SETTLE_MS = 3000
/** After a scroll that came from the preview, the editor's own scroll events count as its echo for this long. */
const SYNC_ECHO_MS = 160
/** A failed write is retried after this. */
const SAVE_RETRY_MS = 2000
/** How many of our own recent writes a watcher echo is matched against. */
const OWN_TEXTS_KEPT = 8

/** The files of the note panes (the note extension's side of the bus `ext:note:*`, extensions/note/ipc.ts). */
export interface NoteIo {
  read(path: string): Promise<NoteRead>
  /** Atomic write. */
  write(path: string, text: string): Promise<NoteWritten>
  /** The fire-and-forget write of a page going away (beforeunload cannot await). */
  flush(path: string, text: string): void
  /** Watches a file; a change on disk comes back as the extension's `changed` event. */
  watch(path: string): void
  unwatch(path: string): void
}

export interface NoteHost {
  io: NoteIo
  getScheme(): ColorScheme
  getAppearance(): TerminalAppearance
  /** The global word-wrap preference (settings.json `extensions.note.wordWrap`). */
  getWordWrap(): boolean
  /** Flips the global word-wrap preference; every editor follows through setWordWrap. */
  toggleWordWrap(): void
  /** The general minimap preference (settings.json `extensions.note.minimap`). */
  getMinimap(): boolean
  /** The general line-numbers preference (settings.json `extensions.note.lineNumbers`). */
  getLineNumbers(): boolean
  /** The editor's widget got or lost the keyboard. */
  onFocus(panel: NotePanel, focused: boolean): void
  /** The view state (or the path) changed: persist the pane params with the layout. */
  onViewChange(panel: NotePanel): void
  /** The text on disk and in the editor drifted apart or met again: the tab's mark follows. */
  onDirtyChange(panel: NotePanel): void
  /** The file changed outside while edits are pending here: the person decides. */
  askConflict(panel: NotePanel): Promise<'keep' | 'reload'>
  /** Right-click on the tab / the strip's "⋯". */
  onTabMenu(id: string, ev: MouseEvent): void
  /** The tab's inline rename finished with a new name. */
  onRename(id: string, name: string): void
  /** The tab's ×. */
  onClose(id: string): void
  /** The text in the editor changed, finished loading, or the editor went away: a preview of the file follows. */
  onSourceChange(panel: NotePanel): void
  /** The editor scrolled by the person (not echoing a preview's scroll): a preview of the file follows. */
  onScroll(panel: NotePanel): void
  /** The note now lives at another path (renamed or saved as). */
  onPathChange(panel: NotePanel, from: string): void
}

/** What a test reads of a note. */
export interface NoteSnapshot {
  id: string
  path: string
  text: string
  savedText: string
  dirty: boolean
  cursor: { lineNumber: number; column: number } | undefined
  selections: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }[]
  scrollTop: number
  /** The source line at the top (0-based, fractional): what the preview follows. */
  topLine: number
  /** The editor's viewport and content heights (why a scroll was clamped). */
  viewport: { width: number; height: number; scrollHeight: number }
  focused: boolean
  error: string | undefined
}

export class NotePanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  path = ''
  /** The folder the file was opened from (Quick Open's root), when it was. */
  cwd: string | undefined
  editor: Editor | undefined
  private model: monaco.editor.ITextModel | undefined
  private api: DockviewPanelApi | undefined
  private readonly host: NoteHost
  private readonly editorHost: HTMLElement
  private readonly state: { root: HTMLElement; icon: HTMLElement; title: HTMLElement; text: HTMLElement }
  /** The text as last known to be on disk (what we wrote, or what we read). */
  private savedText = ''
  /** The last texts this tab wrote (newest last): a watcher event that reads one of them back is our own echo. */
  private readonly ownTexts: string[] = []
  private wasDirty = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private viewTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | undefined
  private initialView: NoteView | undefined
  private disposed = false
  private loaded = false
  private focused = false
  private watching = false
  private conflictOpen = false
  private lastError: string | undefined
  private readonly disposers: Array<{ dispose(): void }> = []

  constructor(host: NoteHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'note-panel'
    this.element.dataset.editor = 'note'
    this.editorHost = document.createElement('div')
    this.editorHost.className = 'note-editor'
    const root = document.createElement('div'); root.className = 'note-state'; root.hidden = true
    root.setAttribute('role', 'status')
    const card = document.createElement('div'); card.className = 'card'
    const ic = document.createElement('span'); ic.className = 'i'
    const title = document.createElement('h3')
    const text = document.createElement('p')
    card.append(ic, title, text)
    root.append(card)
    this.state = { root, icon: ic, title, text }
    this.element.append(this.editorHost, root)
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.noteId = this.id
    const note = noteParams(params.params)
    if (!note) {
      this.showState('warning', 'Nota sem arquivo', 'Esta aba não aponta para nenhum arquivo.')
      return
    }
    this.path = note.path
    this.cwd = note.cwd
    this.minimapOverride = note.minimap
    this.lineNumbersOverride = note.lineNumbers
    this.wordWrapOverride = note.wordWrap
    this.initialView = note.view
    this.createEditor()
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
    void this.load()
  }

  private createEditor(): void {
    const appearance = this.host.getAppearance()
    const font = terminalFontOptions(appearance)
    const theme = defineTheme(this.host.getScheme())
    const uri = monaco.Uri.file(this.path)
    // No language named: Monaco takes it from the file's extension (markdown for notes, the type for files Quick Open opens).
    this.model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('', undefined, uri)
    this.editor = monaco.editor.create(this.editorHost, {
      model: this.model,
      theme,
      automaticLayout: true,
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      fontWeight: String(font.fontWeight),
      fontLigatures: appearance.ligatures,
      lineHeight: Math.round(font.fontSize * font.lineHeight),
      wordWrap: this.wordWrapEnabled() ? 'on' : 'off',
      wrappingIndent: 'same',
      minimap: { enabled: this.minimapEnabled(), renderCharacters: false },
      folding: true,
      foldingHighlight: false,
      showFoldingControls: 'mouseover',
      lineNumbers: this.lineNumbersEnabled() ? 'on' : 'off',
      glyphMargin: false,
      renderWhitespace: 'selection',
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 8, bottom: 8 },
      multiCursorModifier: 'alt',
      columnSelection: false,
      stickyScroll: { enabled: true },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
      occurrencesHighlight: 'off',
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      acceptSuggestionOnEnter: 'off',
      tabCompletion: 'off',
      parameterHints: { enabled: false },
      links: true,
      dragAndDrop: true,
      fixedOverflowWidgets: true,
      ariaLabel: 'Nota',
      tabSize: 2,
      insertSpaces: true,
    })
    const editor = this.editor
    // Completion is on for JSON only (the language service completes settings.json from its schema); notes and other files keep it off.
    if (this.model.getLanguageId() === 'json') {
      editor.updateOptions({ quickSuggestions: { strings: true, other: true, comments: false }, suggestOnTriggerCharacters: true, acceptSuggestionOnEnter: 'on', tabCompletion: 'on' })
    }
    // A wheel turn is the person taking over the scroll: the saved view stops being re-applied.
    this.editorHost.addEventListener('wheel', () => { this.pendingView = undefined }, { passive: true })
    // VS Code's Alt+Z, which Monaco alone does not ship.
    editor.addAction({
      id: 'tether.toggleWordWrap', label: 'Alternar quebra de linha', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      run: () => this.host.toggleWordWrap(),
    })
    this.disposers.push(
      editor.onDidChangeModelContent(() => { this.pendingView = undefined; this.scheduleSave(); this.scheduleView(); this.syncDirty(); if (this.loaded) this.host.onSourceChange(this) }),
      editor.onDidChangeCursorSelection(e => { if (e.reason === monaco.editor.CursorChangeReason.Explicit) this.pendingView = undefined; this.scheduleView() }),
      editor.onDidScrollChange(() => { this.scheduleView(); this.scrolled() }),
      editor.onDidChangeHiddenAreas(() => this.scheduleView()),
      // The restored scroll is clamped to the viewport the editor had at the time (a tab still hidden, a window
      // the OS resizes right after): the saved view is applied again on the layouts that follow, for a moment.
      editor.onDidLayoutChange(() => this.reapplyPendingView()),
      editor.onDidFocusEditorWidget(() => { this.focused = true; this.host.onFocus(this, true) }),
      editor.onDidBlurEditorWidget(() => { this.focused = false; this.flushView(); this.host.onFocus(this, false) }),
    )
  }

  /** The saved view still to settle (dropped at the first thing the person does in the editor). */
  private pendingView: NoteView | undefined
  private pendingUntil = 0

  private reapplyPendingView(): void {
    if (!this.pendingView || !this.editor) return
    if (Date.now() > this.pendingUntil) { this.pendingView = undefined; return }
    try { this.editor.restoreViewState(this.pendingView as unknown as ViewState) } catch { this.pendingView = undefined }
  }

  // ---------- the file ----------

  private async load(): Promise<void> {
    const r = await this.host.io.read(this.path)
    if (this.disposed || !this.model || !this.editor) return
    if (r.ok) {
      this.savedText = r.text
      this.model.setValue(r.text)
      this.hideState()
    } else if (r.missing) {
      // Created a moment ago and already gone, or opened from a stale layout: an empty note that the first keystroke recreates.
      this.savedText = ''
      this.model.setValue('')
      this.hideState()
    } else {
      this.showState('x-circle', 'Não foi possível ler a nota', r.message)
    }
    this.loaded = true
    if (this.initialView) {
      try {
        this.editor.restoreViewState(this.initialView as unknown as ViewState)
        this.pendingView = this.initialView
        this.pendingUntil = Date.now() + VIEW_SETTLE_MS
      } catch (err) { console.warn(`nota ${this.id}: estado da visão ignorado`, err) }
    }
    this.syncDirty()
    this.watch()
    this.host.onSourceChange(this)
    if (this.pendingReveal) { const p = this.pendingReveal; this.pendingReveal = undefined; this.reveal(p) }
    if (this.api?.isActive) requestAnimationFrame(() => this.focus())
  }

  private pendingReveal: { line: number; column?: number } | undefined

  /** Puts the cursor at a line (and column), centred, as Quick Open's `file:42:7` asks; waits for the text when it is still loading. */
  reveal(pos: { line: number; column?: number }): void {
    if (!this.loaded || !this.editor || !this.model) { this.pendingReveal = pos; return }
    const lineNumber = Math.min(Math.max(1, pos.line), this.model.getLineCount())
    const column = Math.min(Math.max(1, pos.column ?? 1), this.model.getLineMaxColumn(lineNumber))
    this.pendingView = undefined
    this.editor.setPosition({ lineNumber, column })
    this.editor.revealPositionInCenter({ lineNumber, column })
    this.scheduleView()
  }

  // ---------- scroll sync with the preview ----------

  /** Until when the editor's scroll events are the echo of a preview's (they are not told back to it). */
  private syncSuppressUntil = 0

  /** Where the editor stopped after a scroll the preview asked for: its scroll event, whenever it comes, is the echo. */
  private expectedTop: number | undefined

  private scrolled(): void {
    const top = this.editor?.getScrollTop() ?? 0
    if (this.expectedTop !== undefined && Math.abs(top - this.expectedTop) <= 1.5) return
    this.expectedTop = undefined
    if (performance.now() >= this.syncSuppressUntil) this.host.onScroll(this)
  }

  get isDisposed(): boolean { return this.disposed }
  /** The editor is on screen (its tab is the visible one): a hidden editor has no viewport to scroll. */
  get isShown(): boolean { return this.editorHost.clientHeight > 0 }
  /** The text has been read from the file (the editor holds the file's content, not the empty start). */
  get isReady(): boolean { return this.loaded && !this.disposed }

  /** The source line at the top of the editor, 0-based and fractional (3.5: halfway down the fourth line), by what is drawn (wrapped and folded lines count as they look). */
  topLine(): number {
    const e = this.editor
    if (!e) return 0
    const first = e.getVisibleRanges()[0]?.startLineNumber ?? 1
    const top = e.getTopForLineNumber(first)
    const height = Math.max(1, e.getTopForLineNumber(first + 1) - top)
    const fraction = Math.min(1, Math.max(0, (e.getScrollTop() - top) / height))
    return first - 1 + fraction
  }

  /** Scrolls so that source line `line` (0-based, fractional) is at the top; the echo is not told back to the preview. */
  scrollToLine(line: number): void {
    const e = this.editor
    if (!e || !this.model) return
    const whole = Math.min(this.model.getLineCount() - 1, Math.max(0, Math.floor(line)))
    const top = e.getTopForLineNumber(whole + 1)
    const next = whole + 2 <= this.model.getLineCount() ? e.getTopForLineNumber(whole + 2) : top + e.getOption(monaco.editor.EditorOption.lineHeight)
    this.syncSuppressUntil = performance.now() + SYNC_ECHO_MS
    this.pendingView = undefined
    e.setScrollTop(top + Math.min(1, Math.max(0, line - whole)) * (next - top), monaco.editor.ScrollType.Immediate)
    this.expectedTop = e.getScrollTop()
  }

  private watch(): void {
    if (this.watching || this.disposed) return
    this.watching = true
    this.host.io.watch(this.path)
  }

  private unwatch(): void {
    if (!this.watching) return
    this.watching = false
    this.host.io.unwatch(this.path)
  }

  get text(): string { return this.model?.getValue() ?? '' }
  get dirty(): boolean { return this.loaded && this.text !== this.savedText }

  private syncDirty(): void {
    const d = this.dirty
    if (d === this.wasDirty) return
    this.wasDirty = d
    this.host.onDirtyChange(this)
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save() }, NOTE_SAVE_DEBOUNCE_MS)
  }

  /** Writes the text now (serialized: one write in flight; a change during it is written by the next debounce). */
  save(): Promise<void> {
    if (this.saving) return this.saving.then(() => this.save())
    if (!this.loaded || this.disposed) return Promise.resolve()
    const text = this.text
    if (text === this.savedText) return Promise.resolve()
    if (!this.bufferIsMine()) return Promise.resolve()
    this.saving = this.host.io.write(this.path, text).then(r => {
      this.saving = undefined
      if (r.ok) {
        this.savedText = text
        this.rememberOwn(text)
        if (this.lastError) { this.lastError = undefined; this.hideState() }
      } else {
        this.lastError = r.message
        console.error(`nota ${this.path}: não foi possível gravar: ${r.message}`)
        this.showState('warning', 'Não foi possível gravar a nota', `${r.message}\nO texto continua aqui; a gravação é tentada de novo.`)
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.scheduleSave() }, SAVE_RETRY_MS)
      }
      this.syncDirty()
    }, err => { this.saving = undefined; console.error(`nota ${this.path}: gravação falhou`, err) })
    return this.saving
  }

  /** The page is going away: whatever is pending is sent now (fire-and-forget; main writes it). */
  flush(): void {
    if (!this.loaded || this.disposed) return
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    const text = this.text
    if (text !== this.savedText && this.bufferIsMine()) { this.host.io.flush(this.path, text); this.savedText = text; this.rememberOwn(text) }
  }

  private rememberOwn(text: string): void {
    const i = this.ownTexts.indexOf(text)
    if (i >= 0) this.ownTexts.splice(i, 1)
    this.ownTexts.push(text)
    if (this.ownTexts.length > OWN_TEXTS_KEPT) this.ownTexts.shift()
  }

  /** The file changed on disk (main's watcher). */
  async onExternalChange(): Promise<void> {
    if (!this.loaded || this.disposed || !this.editor || !this.model || this.conflictOpen) return
    if (this.saving) await this.saving
    const r = await this.host.io.read(this.path)
    if (this.disposed || !r.ok) return // gone or unreadable: the next save recreates it
    // A write started during the read: its own event follows and is judged then.
    if (this.saving) return
    const action = externalChangeAction({ diskText: r.text, editorText: this.text, savedText: this.savedText, ownTexts: this.ownTexts })
    if (action === 'keep') {
      // Only the editor's own text counts as saved; an echo of an earlier write leaves the pending edits pending.
      if (r.text === this.text) this.savedText = r.text
      this.syncDirty()
      return
    }
    if (action === 'reload') { this.replaceText(r.text); return }
    this.conflictOpen = true
    try {
      const choice = await this.host.askConflict(this)
      if (this.disposed) return
      if (choice === 'reload') this.replaceText(r.text)
      else { this.savedText = ''; await this.save() } // the editor wins: written over the file
    } finally {
      this.conflictOpen = false
    }
  }

  /** The disk's text into the editor, as one undoable edit, with the cursor where it was (clamped by Monaco). */
  private replaceText(text: string): void {
    if (!this.editor || !this.model) return
    const view = this.editor.saveViewState()
    this.editor.executeEdits('disk', [{ range: this.model.getFullModelRange(), text }])
    this.editor.pushUndoStop()
    if (view) this.editor.restoreViewState(view)
    this.savedText = text
    this.syncDirty()
    this.scheduleView()
  }

  /** The note now lives at `path` (renamed or saved as): the watcher, the title and the params follow. */
  setPath(path: string): void {
    if (path === this.path) return
    this.unwatch()
    const from = this.path
    this.path = path
    this.rebindModel()
    this.api?.setTitle(noteTitle(path))
    this.watch()
    this.flushView()
    this.host.onPathChange(this, from)
  }

  /**
   * The buffer is Monaco's model, shared by uri between the tabs on one file: after the path changes, the model must be
   * the new file's. Kept under the old uri, a note opened later on the old name would pick this very buffer and the two
   * tabs would autosave each other's text into two files (the data loss of 09/11). Another tab already on the new file
   * shares its model (same file); else a fresh model takes this text. The old model goes when no editor shows it.
   */
  private rebindModel(): void {
    if (!this.editor || !this.model) return
    const uri = monaco.Uri.file(this.path)
    if (this.model.uri.toString() === uri.toString()) return
    const old = this.model
    const text = old.getValue()
    const view = this.editor.saveViewState()
    const existing = monaco.editor.getModel(uri)
    if (existing && existing.getValue() !== text) existing.setValue(text)
    this.model = existing ?? monaco.editor.createModel(text, undefined, uri)
    this.editor.setModel(this.model)
    if (view) this.editor.restoreViewState(view)
    if (!monaco.editor.getEditors().some(e => e.getModel() === old)) old.dispose()
  }

  /** The buffer is this note's file's (never write one file's text into another). */
  private bufferIsMine(): boolean {
    const mine = !!this.model && this.model.uri.toString() === monaco.Uri.file(this.path).toString()
    if (!mine) console.error(`nota ${this.path}: o texto em memória não é deste arquivo (${this.model?.uri.toString() ?? 'sem modelo'}); não gravado`)
    return mine
  }

  /** "Salvar como…": the text goes to `path`, which becomes the note's file. */
  async saveAs(path: string): Promise<boolean> {
    if (this.saving) await this.saving
    const text = this.text
    const r = await this.host.io.write(path, text)
    if (!r.ok) { console.error(`nota: salvar como ${path} falhou: ${r.message}`); return false }
    this.setPath(path)
    this.savedText = text
    this.syncDirty()
    return true
  }

  // ---------- view state ----------

  viewState(): NoteView | undefined {
    const v = this.editor?.saveViewState()
    return v ? (v as unknown as NoteView) : undefined
  }

  private scheduleView(): void {
    if (this.viewTimer || !this.loaded) return
    this.viewTimer = setTimeout(() => { this.viewTimer = undefined; this.flushView() }, VIEW_THROTTLE_MS)
  }

  private flushView(): void {
    if (this.viewTimer) { clearTimeout(this.viewTimer); this.viewTimer = undefined }
    if (this.loaded && !this.disposed) this.host.onViewChange(this)
  }

  // ---------- look ----------

  focus(): void { this.editor?.focus() }

  /** The wordWrap option the editor runs with right now ("on" / "off"). */
  wordWrapOption(): string { return this.editor ? String(this.editor.getOption(monaco.editor.EditorOption.wordWrap)) : '' }

  /** This editor's own minimap choice (undefined: follows the general setting). Persisted in the pane params. */
  minimapOverride: boolean | undefined

  /** Whether the minimap shows: the editor's own choice wins over the general setting. */
  minimapEnabled(): boolean { return this.minimapOverride ?? this.host.getMinimap() }

  /** What the editor really runs with: the minimap option and the width of Monaco's element (0 when hidden, or when the tab is not showing). */
  minimapShown(): { option: boolean; width: number } {
    const el = this.element.querySelector<HTMLElement>('.monaco-editor .minimap')
    return { option: !!this.editor?.getOption(monaco.editor.EditorOption.minimap).enabled, width: el ? el.offsetWidth : 0 }
  }

  /** Applies the effective minimap to the editor (after the general setting or the override changed). */
  refreshMinimap(): void { this.editor?.updateOptions({ minimap: { enabled: this.minimapEnabled(), renderCharacters: false } }) }

  /** "Minimapa deste editor": flips what the editor shows now as its own choice; undefined resets it to the general setting. */
  setMinimapOverride(value: boolean | undefined): void {
    this.minimapOverride = value
    this.refreshMinimap()
    this.flushView()
  }

  /** This editor's own line-numbers choice (undefined: follows the general setting). Persisted in the pane params. */
  lineNumbersOverride: boolean | undefined

  /** Whether the line numbers show: the editor's own choice wins over the general setting. */
  lineNumbersEnabled(): boolean { return this.lineNumbersOverride ?? this.host.getLineNumbers() }

  /** What the editor really runs with: the lineNumbers render type and the width of Monaco's gutter numbers (0 when hidden, or when the tab is not showing). */
  lineNumbersShown(): { option: number; width: number } {
    const el = this.element.querySelector<HTMLElement>('.monaco-editor .line-numbers')
    return { option: this.editor ? this.editor.getOption(monaco.editor.EditorOption.lineNumbers).renderType : -1, width: el ? el.offsetWidth : 0 }
  }

  /** Applies the effective line numbers to the editor (after the general setting or the override changed). */
  refreshLineNumbers(): void { this.editor?.updateOptions({ lineNumbers: this.lineNumbersEnabled() ? 'on' : 'off' }) }

  /** "Números de linha deste editor": sets the editor's own choice; undefined resets it to the general setting. */
  setLineNumbersOverride(value: boolean | undefined): void {
    this.lineNumbersOverride = value
    this.refreshLineNumbers()
    this.flushView()
  }

  /** This editor's own word-wrap choice (undefined: follows the general setting). Persisted in the pane params. */
  wordWrapOverride: boolean | undefined

  /** Whether long lines wrap: the editor's own choice wins over the general setting. */
  wordWrapEnabled(): boolean { return this.wordWrapOverride ?? this.host.getWordWrap() }

  /** Applies the effective word wrap to the editor (after the general setting or the override changed). */
  refreshWordWrap(): void { this.editor?.updateOptions({ wordWrap: this.wordWrapEnabled() ? 'on' : 'off' }) }

  /** "Quebra de linha deste editor": sets the editor's own choice; undefined resets it to the general setting. */
  setWordWrapOverride(value: boolean | undefined): void {
    this.wordWrapOverride = value
    this.refreshWordWrap()
    this.flushView()
  }

  setAppearance(appearance: TerminalAppearance): void {
    const font = terminalFontOptions(appearance)
    this.editor?.updateOptions({ fontFamily: font.fontFamily, fontSize: font.fontSize, fontWeight: String(font.fontWeight), fontLigatures: appearance.ligatures, lineHeight: Math.round(font.fontSize * font.lineHeight) })
  }

  private showState(ic: Parameters<typeof icon>[0], title: string, text: string): void {
    setIcon(this.state.icon, ic)
    this.state.title.textContent = title
    this.state.text.textContent = text
    this.state.root.hidden = false
  }

  private hideState(): void { this.state.root.hidden = true }

  // ---------- the editor's actions as commands ----------

  /** Every action the editor supports, as commands available while an editor has the focus (`focus === 'editor'`). */
  commands(): Command[] {
    const editor = this.editor
    if (!editor) return []
    const keybindings = (editor as unknown as { _standaloneKeybindingService?: { lookupKeybinding(id: string): { getLabel(): string | null } | undefined } })._standaloneKeybindingService
    const seen = new Set<string>()
    const out: Command[] = []
    for (const action of editor.getSupportedActions()) {
      if (!action.label) continue
      const id = editorCommandId(action.id)
      if (seen.has(id)) continue
      seen.add(id)
      const label = keybindings?.lookupKeybinding(action.id)?.getLabel() ?? undefined
      const chord = label ? chordFromLabel(label) : undefined
      out.push({
        id, title: action.label, group: EDITOR_GROUP, icon: 'note-pencil',
        ...(chord ? { displayChord: chord } : {}),
        when: ctx => ctx.focus === 'editor',
        run: () => { if (this.disposed) return; editor.focus(); return Promise.resolve(action.run()).then(() => undefined) },
      })
    }
    return out
  }

  // ---------- tests ----------

  snapshot(): NoteSnapshot {
    const pos = this.editor?.getPosition()
    return {
      id: this.id, path: this.path, text: this.text, savedText: this.savedText, dirty: this.dirty,
      cursor: pos ? { lineNumber: pos.lineNumber, column: pos.column } : undefined,
      selections: (this.editor?.getSelections() ?? []).map(s => ({ startLineNumber: s.startLineNumber, startColumn: s.startColumn, endLineNumber: s.endLineNumber, endColumn: s.endColumn })),
      scrollTop: this.editor?.getScrollTop() ?? 0,
      topLine: this.topLine(),
      viewport: { width: this.editor?.getLayoutInfo().width ?? 0, height: this.editor?.getLayoutInfo().height ?? 0, scrollHeight: this.editor?.getScrollHeight() ?? 0 },
      focused: this.focused,
      error: this.lastError,
    }
  }

  dispose(): void {
    if (this.disposed) return
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    if (this.viewTimer) { clearTimeout(this.viewTimer); this.viewTimer = undefined }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    // What is still pending goes to disk; the params get the last view state before the pane is serialized elsewhere (a move).
    if (this.loaded && this.text !== this.savedText && this.bufferIsMine()) { this.host.io.flush(this.path, this.text); this.savedText = this.text }
    if (this.loaded) this.host.onViewChange(this)
    this.disposed = true
    this.unwatch()
    for (const d of this.disposers.splice(0)) d.dispose()
    this.editor?.dispose()
    this.editor = undefined
    // Told after the editor is gone: the host drops the actions it had registered for this note.
    this.focused = false
    this.host.onFocus(this, false)
    this.host.onSourceChange(this)
    // The model is shared by uri: it goes when no editor shows it any more.
    if (this.model && !monaco.editor.getEditors().some(e => e.getModel() === this.model)) this.model.dispose()
    this.model = undefined
  }
}

/** The note's tab: icon, file name, the dirty mark, the ×; double-click renames the file, right-click opens the menu. */
export class NoteTab implements ITabRenderer {
  readonly element: HTMLElement
  private unmountEmblem: (() => void) | undefined
  private api: DockviewPanelApi | undefined
  private readonly text: HTMLElement
  private readonly dirtyMark: HTMLElement
  private readonly host: NoteHost
  private readonly isDirty: (id: string) => boolean
  private disposers: Array<{ dispose(): void }> = []

  constructor(host: NoteHost, isDirty: (id: string) => boolean) {
    this.host = host
    this.isDirty = isDirty
    this.element = document.createElement('div')
    this.element.className = 'tether-tab note'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('note-pencil'))
    this.text = document.createElement('span'); this.text.className = 'text'
    this.dirtyMark = document.createElement('span'); this.dirtyMark.className = 'dirty'; this.dirtyMark.hidden = true
    this.dirtyMark.title = 'Gravando…'
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar nota'; close.setAttribute('aria-label', 'Fechar nota')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, this.text, this.dirtyMark, close)
    this.element.addEventListener('dblclick', ev => { ev.preventDefault(); ev.stopPropagation(); this.startRename() })
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.unmountEmblem?.()
    this.unmountEmblem = mountTabEmblem(this.element.querySelector<HTMLElement>('.kind')!, params.api, params.params)
    this.element.dataset.slot = params.api.id
    this.disposers.push(params.api.onDidTitleChange(() => this.render()))
    this.render()
  }

  render(): void {
    if (!this.api) return
    const path = noteParams(this.api.getParameters?.() ?? undefined)?.path
    this.text.textContent = this.api.title ?? this.api.id
    this.dirtyMark.hidden = !this.isDirty(this.api.id)
    this.element.title = `${this.api.title ?? this.api.id}\nNota${path ? `\n${path}` : ''}`
  }

  /** Inline rename of the file (Enter saves, Esc cancels, leaving the field saves; `.md` is added when missing). */
  startRename(): void {
    if (!this.api || this.element.querySelector('input.rename')) return
    const id = this.api.id
    const current = this.api.title ?? ''
    const input = document.createElement('input')
    input.className = 'rename'
    input.type = 'text'
    input.value = current
    input.title = 'Enter salva, Esc cancela'
    input.setAttribute('aria-label', 'Nome da nota')
    let done = false
    const finish = (save: boolean): void => {
      if (done) return
      done = true
      const name = input.value.trim()
      input.replaceWith(this.text)
      if (save && name && name !== current) this.host.onRename(id, name)
    }
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'] as const) input.addEventListener(type, ev => ev.stopPropagation())
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    this.text.replaceWith(input)
    input.focus()
    const dot = current.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : current.length)
  }

  dispose(): void {
    this.unmountEmblem?.()
    this.unmountEmblem = undefined
    for (const d of this.disposers) d.dispose()
    this.disposers = []
  }
}

export { THEME_NAME }
