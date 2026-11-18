// The replace preview (VS Code's "Replace Preview"): with the replace field open, activating a match shows its file before
// and after the replacements, side by side, in a read-only Monaco diff editor, in ONE pane per window that every next
// activation reuses. Left: the file's text now (the open editor's model when there is one, else the disk, read by main's
// `readText`). Right: the same text with every match of that file that is in the results replaced (editsOf over the
// results model, guarded and applied to a model of the pane's own). The pane follows the replace term and the file's
// results (rebuilt PREVIEW_DELAY_MS after the last change) and closes once its file leaves the results or the replace
// field closes. It is never restored from layout.json: a pane of the type created by the layout closes itself.
// Its two models use their own URI scheme, so the search never takes them for an open file (buffer-search, replace.ts).
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/replaceService.ts   (openReplacePreview, updateReplacePreview,
//                                                                ReplacePreviewModel)
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import type { Target } from '../../../app/renderer/create.ts'
import type { PaneType, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon } from '../../../app/renderer/icons.ts'
import { defineTheme, languageIdFor, monaco } from '../../../app/renderer/monaco.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import { terminalFontOptions, type TerminalAppearance } from '../../../app/shared/terminal-theme.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { editsOf, type FileMatch, type Match, type SearchModel } from '../../../app/shared/vscode-search-model.ts'
import type { SearchChannels } from '../ipc.ts'
import { REPLACE_PREVIEW_LAYOUT } from '../layouts.ts'
import {
  baseName, newPreviewId, PREVIEW_DELAY_MS, PREVIEW_PREFIX, PREVIEW_TYPE, previewFate, previewSignature, previewTitle, shiftedLine,
} from './preview-rules.ts'
import { guardModel, type ReplaceEdit } from './replace-rules.ts'

const SCHEME = 'search-preview'
/** How long a closed preview's models wait before they are disposed (a diff in flight in the worker finishes first). */
const MODEL_GRACE_MS = 1000
const CHANGED_MESSAGE = 'O arquivo mudou desde a pesquisa: a prévia não pode ser montada. Atualize a pesquisa.'

/** What the preview reads from the search pad. */
export interface PreviewSource {
  readonly model: SearchModel
  /** The file's entry in the results, when it has one. */
  fileOf(path: string): FileMatch | null
  /** A search runs or a replace is being applied: the results are not final yet. */
  busy(): boolean
  replaceShown(): boolean
}

export interface PreviewSnapshot {
  /** The panes of the type in the window (at most one). */
  panes: string[]
  id?: string
  title?: string
  tooltip?: string
  path?: string
  error?: string
  original?: string
  modified?: string
  language?: string
  /** The activated match's line, in the original text and in the replaced one. */
  line?: number
  modifiedLine?: number
  /** The first and last visible line of each side. */
  visible?: { original: [number, number]; modified: [number, number] }
  sideBySide?: boolean
}

let modelSeq = 0
const previewUri = (side: 'original' | 'modified', path: string): monaco.Uri =>
  monaco.Uri.from({ scheme: SCHEME, path: `/${++modelSeq}/${side}/${baseName(path)}` })

const languageOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? languageIdFor(name.slice(dot + 1)) : undefined) ?? 'plaintext'
}

const fontOptions = (a: TerminalAppearance): monaco.editor.IEditorOptions => {
  const font = terminalFontOptions(a)
  return { fontFamily: font.fontFamily, fontSize: font.fontSize, fontWeight: String(font.fontWeight), lineHeight: Math.round(font.fontSize * font.lineHeight) }
}

/** The pane's content: the diff editor (created on the first content), or a message in its place. */
class PreviewPanel implements IContentRenderer {
  readonly element = document.createElement('div')
  id = ''
  private readonly owner: ReplacePreview
  private readonly diffHost = document.createElement('div')
  private readonly messageEl = document.createElement('div')
  private diff: monaco.editor.IStandaloneDiffEditor | undefined
  private original: monaco.editor.ITextModel | undefined
  private modified: monaco.editor.ITextModel | undefined
  private readonly marks: monaco.editor.IEditorDecorationsCollection[] = []
  private disposed = false
  /** What is shown, for the test hook. */
  state: { path?: string; error?: string; line?: number; modifiedLine?: number } = {}

  constructor(owner: ReplacePreview) {
    this.owner = owner
    this.element.className = 'srp-pane'
    this.diffHost.className = 'srp-diff'
    this.messageEl.className = 'srp-msg'
    this.messageEl.setAttribute('role', 'status')
    this.messageEl.hidden = true
    this.element.append(this.diffHost, this.messageEl)
  }

  init(params: GroupPanelPartInitParameters): void {
    this.id = params.api.id
    this.element.dataset.preview = this.id
    this.owner.attachPanel(this)
  }

  /** The text before and after the replacements, the activated line highlighted on both sides and brought into view. */
  show(o: { path: string; text: string; edits: readonly ReplaceEdit[]; line: number; reveal: boolean }): void {
    if (this.disposed) return
    const language = languageOf(o.path)
    if (!this.original || !this.modified) {
      this.original = monaco.editor.createModel(o.text, language, previewUri('original', o.path))
      this.modified = monaco.editor.createModel(o.text, language, previewUri('modified', o.path))
    } else {
      if (this.original.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(this.original, language)
        monaco.editor.setModelLanguage(this.modified, language)
      }
      this.original.setValue(o.text)
      this.modified.setValue(o.text)
    }
    const guarded = guardModel(this.modified, o.edits)
    if (!guarded) { this.showError(o.path, CHANGED_MESSAGE); return }
    this.modified.applyEdits(guarded.map(e => ({
      range: new monaco.Range(e.range.startLineNumber, e.range.startColumn, e.range.endLineNumber, e.range.endColumn),
      text: e.text,
    })))
    const diff = this.ensureDiff()
    if (diff.getModel()?.original !== this.original) diff.setModel({ original: this.original, modified: this.modified })
    this.messageEl.hidden = true
    this.diffHost.hidden = false
    const modifiedLine = Math.min(shiftedLine(o.line, guarded), this.modified.getLineCount())
    const line = Math.min(o.line, this.original.getLineCount())
    this.state = { path: o.path, line, modifiedLine }
    this.highlight(line, modifiedLine)
    const scroll = monaco.editor.ScrollType.Immediate
    if (o.reveal) {
      diff.getOriginalEditor().revealLineInCenter(line, scroll)
      diff.getModifiedEditor().revealLineInCenter(modifiedLine, scroll)
    } else {
      diff.getModifiedEditor().revealLineInCenterIfOutsideViewport(modifiedLine, scroll)
    }
  }

  /** A message in place of the diff (the file could not be read, or its text no longer holds the matches). */
  showError(path: string, message: string): void {
    if (this.disposed) return
    this.state = { path, error: message }
    this.messageEl.textContent = message
    this.messageEl.hidden = false
    this.diffHost.hidden = true
  }

  setAppearance(a: TerminalAppearance): void {
    this.diff?.updateOptions(fontOptions(a))
  }

  snapshot(): Pick<PreviewSnapshot, 'original' | 'modified' | 'language' | 'visible' | 'sideBySide'> {
    const diff = this.diff
    const range = (e: monaco.editor.ICodeEditor): [number, number] => {
      const r = e.getVisibleRanges()
      return [r[0]?.startLineNumber ?? 0, r[r.length - 1]?.endLineNumber ?? 0]
    }
    return {
      ...(this.original && !this.state.error ? { original: this.original.getValue(), language: this.original.getLanguageId() } : {}),
      ...(this.modified && !this.state.error ? { modified: this.modified.getValue() } : {}),
      ...(diff && !this.state.error ? {
        visible: { original: range(diff.getOriginalEditor()), modified: range(diff.getModifiedEditor()) },
        sideBySide: diff.getOriginalEditor().getLayoutInfo().width > 0,
      } : {}),
    }
  }

  private ensureDiff(): monaco.editor.IStandaloneDiffEditor {
    if (this.diff) return this.diff
    const diff = monaco.editor.createDiffEditor(this.diffHost, {
      theme: defineTheme(this.owner.ui.theme.scheme()),
      ...fontOptions(this.owner.ui.theme.appearance()),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      enableSplitViewResizing: true,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      glyphMargin: false,
      folding: false,
      lineNumbers: 'on',
      renderLineHighlight: 'none',
      stickyScroll: { enabled: false },
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      links: false,
      contextmenu: false,
      fixedOverflowWidgets: true,
      padding: { top: 6, bottom: 6 },
      unicodeHighlight: { ambiguousCharacters: false },
    })
    this.diff = diff
    return diff
  }

  private highlight(line: number, modifiedLine: number): void {
    const diff = this.diff
    if (!diff) return
    for (const m of this.marks.splice(0)) m.clear()
    const mark = (e: monaco.editor.ICodeEditor, l: number): monaco.editor.IEditorDecorationsCollection =>
      e.createDecorationsCollection([{ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'srp-line', linesDecorationsClassName: 'srp-line-gutter' } }])
    this.marks.push(mark(diff.getOriginalEditor(), line), mark(diff.getModifiedEditor(), modifiedLine))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const m of this.marks.splice(0)) m.clear()
    // The editor lets go of the models before they go. The models outlive it by MODEL_GRACE_MS: a diff still being computed
    // in the editor worker comes back empty for a model disposed meanwhile, and Monaco then throws "no diff result".
    this.diff?.setModel(null)
    this.diff?.dispose()
    const models = [this.original, this.modified]
    setTimeout(() => { for (const m of models) if (m && !m.isDisposed()) m.dispose() }, MODEL_GRACE_MS)
    this.diff = undefined
    this.original = undefined
    this.modified = undefined
    this.owner.detachPanel(this)
  }
}

/** The pane's tab: the swap icon, `<name> ↔ <name> (prévia da substituição)`, the ×; the path in the tooltip. */
class PreviewTab implements ITabRenderer {
  readonly element = document.createElement('div')
  private readonly text = document.createElement('span')
  private api: DockviewPanelApi | undefined
  private readonly owner: ReplacePreview

  constructor(owner: ReplacePreview) {
    this.owner = owner
    this.element.className = 'tether-tab srp-tab'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('swap'))
    this.text.className = 'text'
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar a prévia da substituição')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.owner.ui.panes.close(this.api.id) })
    this.element.append(kind, this.text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.owner.ui.panes.showTabMenu(this.api.id, ev.clientX, ev.clientY) })
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
    this.owner.attachTab(params.api.id, this)
    this.setLabel(params.title, '')
  }

  setLabel(title: string, tooltip: string): void {
    this.text.textContent = title
    this.element.title = tooltip ? `${title}\n${tooltip}` : title
  }

  dispose(): void {
    if (this.api) this.owner.detachTab(this.api.id, this)
  }
}

/** The window's replace preview: at most one pane, reused by every activation, rebuilt and closed with the results. */
export class ReplacePreview {
  readonly ui: TetherUi
  private readonly ipc: UiIpc<SearchChannels>
  private source: PreviewSource | undefined
  /** The pane this controller opened (a pane of the type with another id came from layout.json). */
  private paneId: string | undefined
  private panel: PreviewPanel | undefined
  private readonly tabs = new Map<string, PreviewTab>()
  /** The file and the activated line shown; `reveal`: the next build brings the line into view. */
  private current: { path: string; line: number; reveal: boolean } | undefined
  /** previewSignature of what is shown (undefined: build it at the next chance). */
  private shown: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Grows with every build: a disk read that answers after a newer build is dropped. */
  private token = 0
  private readonly subs: IDisposable[] = []

  constructor(ui: TetherUi) {
    this.ui = ui
    this.ipc = ui.ipc<SearchChannels>()
    this.subs.push(
      ui.theme.onChange(scheme => { if (this.panel) monaco.editor.setTheme(defineTheme(scheme)) }),
      ui.theme.onAppearance(a => this.panel?.setAppearance(a)),
    )
  }

  /** The pane type, registered by the extension's renderer entry. */
  paneType(): PaneType {
    return {
      ...REPLACE_PREVIEW_LAYOUT, hasSlot: false, icon: 'swap',
      create: () => new PreviewPanel(this),
      createTab: () => new PreviewTab(this),
      has: id => id.startsWith(PREVIEW_PREFIX) && (this.panel?.id === id || this.tabs.has(id)),
      contextFlags: () => ['search.replacePreview'],
    }
  }

  /** The search pad whose results the preview shows (one per window). */
  attach(source: PreviewSource): IDisposable {
    this.source = source
    return { dispose: () => { if (this.source === source) { this.source = undefined; this.close() } } }
  }

  isOpen(): boolean {
    return this.paneId !== undefined && this.ui.panes.find(this.paneId) !== undefined
  }

  /**
   * Shows the match's file in the preview: the pane opens beside the desk's active pane the first time (it never goes to a
   * pad), later it is reused and brought forward. The keyboard stays where it was (the results tree keeps walking).
   */
  show(match: Match): void {
    const path = match.parent().resource
    const keyboard = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    this.current = { path, line: match.range().startLineNumber, reveal: true }
    this.shown = undefined
    const title = previewTitle(path)
    const existing = this.paneId ? this.ui.panes.find(this.paneId) : undefined
    if (existing) {
      existing.api.setTitle(title)
      if (!existing.api.isActive) existing.api.setActive()
    } else {
      const id = newPreviewId()
      this.paneId = id
      const reference = this.ui.panes.deskActiveId()
      const where: { target?: Target; reference?: string } = reference ? { target: { level: 'pane', placement: 'right' }, reference } : {}
      this.ui.panes.open({ id, component: REPLACE_PREVIEW_LAYOUT.component, tabComponent: REPLACE_PREVIEW_LAYOUT.tabComponent, title, params: {} }, where)
      this.ui.layout.scheduleSave()
    }
    this.tabs.get(this.paneId ?? '')?.setLabel(title, path)
    const restore = (): void => {
      if (keyboard && keyboard.isConnected && document.activeElement !== keyboard) keyboard.focus({ preventScroll: true })
    }
    restore()
    requestAnimationFrame(restore)
    clearTimeout(this.timer)
    this.timer = undefined
    void this.build()
  }

  /** The results or the replace term changed: the preview is rebuilt (or closed) once things are still for PREVIEW_DELAY_MS. */
  changed(): void {
    if (!this.current || this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.build() }, PREVIEW_DELAY_MS)
  }

  /** Closes the preview pane (the replace field closed, the results cleared). */
  close(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.current = undefined
    this.shown = undefined
    this.token++
    const id = this.paneId
    this.paneId = undefined
    if (id && this.ui.panes.find(id)) this.ui.panes.close(id)
  }

  snapshot(): PreviewSnapshot {
    const panes = this.ui.panes.all().filter(p => p.type === PREVIEW_TYPE || p.id.startsWith(PREVIEW_PREFIX)).map(p => p.id)
    const id = this.paneId
    const live = id ? this.ui.panes.find(id) : undefined
    const panel = this.panel && this.panel.id === id ? this.panel : undefined
    return {
      panes,
      ...(id && live ? { id, title: live.api.title ?? '', tooltip: this.tabs.get(id)?.element.title ?? '' } : {}),
      ...(panel ? { ...panel.state, ...panel.snapshot() } : {}),
    }
  }

  dispose(): void {
    for (const s of this.subs.splice(0)) s.dispose()
    this.close()
  }

  // ---------- the pane's parts ----------

  attachPanel(panel: PreviewPanel): void {
    if (panel.id !== this.paneId) {
      // Restored from layout.json: the preview has nothing to show there, the pane goes at once.
      setTimeout(() => { if (this.ui.panes.find(panel.id)) this.ui.panes.close(panel.id) }, 0)
      return
    }
    this.panel = panel
    if (this.current) { this.shown = undefined; void this.build() }
  }

  detachPanel(panel: PreviewPanel): void {
    if (this.panel !== panel) return
    this.panel = undefined
    if (this.paneId === panel.id) {
      // The person closed the tab: nothing to follow any more.
      clearTimeout(this.timer)
      this.timer = undefined
      this.paneId = undefined
      this.current = undefined
      this.shown = undefined
      this.token++
    }
  }

  attachTab(id: string, tab: PreviewTab): void {
    this.tabs.set(id, tab)
    if (id === this.paneId && this.current) tab.setLabel(previewTitle(this.current.path), this.current.path)
  }

  detachTab(id: string, tab: PreviewTab): void {
    if (this.tabs.get(id) === tab) this.tabs.delete(id)
  }

  // ---------- building ----------

  /** Builds what the preview shows from the results now, or closes it when its file left them. */
  private async build(): Promise<void> {
    const source = this.source
    const cur = this.current
    if (!cur) return
    if (!source) { this.close(); return }
    if (source.busy()) { this.changed(); return }
    const file = source.fileOf(cur.path)
    let edits: ReplaceEdit[] = []
    try {
      edits = file ? editsOf(file, source.model)[0]?.edits ?? [] : []
    } catch {
      edits = []
    }
    const open = monaco.editor.getModel(monaco.Uri.file(cur.path))
    const signature = previewSignature(open ? `model:${open.getVersionId()}` : 'disk', edits)
    const fate = previewFate({ replaceShown: source.replaceShown(), inResults: file !== null && file.count() > 0, shown: this.shown, next: signature })
    if (fate === 'close') { this.close(); return }
    const panel = this.panel
    if (fate === 'keep' || !panel) return
    const token = ++this.token
    const reveal = cur.reveal
    let text: string
    if (open) text = open.getValue()
    else {
      let r: Awaited<ReturnType<SearchChannels['invoke']['readText']>>
      try {
        r = await this.ipc.invoke('readText', cur.path)
      } catch (e) {
        r = { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
      if (token !== this.token || this.current !== cur || this.panel !== panel) return
      if (!r.ok) { panel.showError(cur.path, r.message); this.shown = signature; return }
      text = r.text
    }
    cur.reveal = false
    this.shown = signature
    panel.show({ path: cur.path, text, edits, line: cur.line, reveal })
  }
}
