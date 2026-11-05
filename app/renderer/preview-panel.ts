// One dockview panel = the preview of one markdown file (app/shared/preview.ts), the VS Code "Open Preview":
//   - the markdown is rendered by markdown-it (app/shared/markdown-render.ts) into a sandboxed, script-less frame
//     (`sandbox="allow-same-origin"` without `allow-scripts`: nothing in the document can run, whatever the text
//     says; the parent reads and listens to the frame's DOM, the frame never reaches the app);
//   - the text is the open editor's, live (a short pause after the last keystroke), else the file's; a change on
//     disk refreshes it when no editor is open (the editor handles its own);
//   - scroll is synced both ways by source line (the blocks carry `data-line`), a double click goes to the line in
//     the editor, links open where they should (browser, anchor, file) and relative images load from the note's folder;
//   - the pane remembers its file and where it was scrolled in its params; the next launch reopens it.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon, setIcon } from './icons.ts'
import { colorizeCode, tokenColorsCss } from './monaco.ts'
import type { NotePanel } from './note-panel.ts'
import type { PreviewPane } from './preview-pane.ts'
import { previewShell, readPreviewTokens, tokensCss } from './preview-style.ts'
import { noteDirOf } from '../shared/notes.ts'
import { classifyLink } from '../shared/markdown-links.ts'
import { renderMarkdown, slugify } from '../shared/markdown-render.ts'
import { lineAtOffset, offsetOfLine, type LineBlock } from '../shared/markdown-scroll.ts'
import { previewParams, previewTitle } from '../shared/preview.ts'
import { terminalFontOptions, type TerminalAppearance } from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'

/** How long after the last keystroke the preview is drawn again. */
export const PREVIEW_DEBOUNCE_MS = 150
/** How often, at most, the scroll position is handed to the host to persist. */
const VIEW_THROTTLE_MS = 250
/** After the preview scrolled by the editor, its own scroll events count as the echo for this long. */
const SYNC_ECHO_MS = 160
/** A click inside the frame activates the pane after this (longer than a double click takes). */
const ACTIVATE_DELAY_MS = 450

export interface PreviewHost {
  getScheme(): ColorScheme
  getAppearance(): TerminalAppearance
  /** The open editor of the file, when there is one that has read it. */
  editorFor(path: string): NotePanel | undefined
  /** Opens a file next to the note (a relative link), like Quick Open: `line` is 1-based. */
  openFile(path: string, noteDir: string, line?: number): void
  openExternal(url: string): void
  /** The path or the scroll changed: persist the pane params with the layout. */
  onParamsChange(panel: PreviewPanel): void
  /** The pane got a click inside the frame, where dockview cannot see it: it becomes the active pane (false when it already is). */
  activate(panel: PreviewPanel): void
  /** Double click on the preview: the editor of the file is shown with its cursor on `line` (1-based), opened when there is none. */
  revealSource(panel: PreviewPanel, line: number): void
  /** Right-click on the tab, or inside the frame: the pane menu at page coordinates. */
  onTabMenu(id: string, x: number, y: number): void
  onClose(id: string): void
}

/** What a test reads of a preview. */
export interface PreviewSnapshot {
  id: string
  path: string
  /** The frame's sandbox flags (must never include allow-scripts). */
  sandbox: string
  /** Text of the rendered document. */
  text: string
  html: string
  scrollTop: number
  scrollHeight: number
  /** The source line at the top (0-based, fractional). */
  topLine: number
  blocks: number
  error: string | undefined
  rendered: number
}

export class PreviewPanel implements IContentRenderer, PreviewPane {
  readonly kind = 'md' as const
  readonly element: HTMLElement
  id = ''
  path = ''
  /** The line (0-based) at the top, as last persisted or restored. */
  line: number | undefined
  private api: DockviewPanelApi | undefined
  private readonly host: PreviewHost
  private readonly frame: HTMLIFrameElement
  private readonly state: { root: HTMLElement; icon: HTMLElement; title: HTMLElement; text: HTMLElement }
  private disposed = false
  private frameReady = false
  private renderVersion = 0
  private renderCount = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private viewTimer: ReturnType<typeof setTimeout> | undefined
  /** What the frame's document holds (undefined: nothing drawn in this document yet) and the last HTML drawn in any document of this pane. */
  private lastHtml: string | undefined
  private renderedHtml: string | undefined
  private lastError: string | undefined
  private blocksCache: LineBlock[] | undefined
  /** Until when, and at which position, the document's scroll events are the echo of a scroll the editor asked for. */
  private suppressUntil = 0
  private expectedTop: number | undefined
  private watching = false
  private resizeObserver: ResizeObserver | undefined
  private firstRender = true
  private readonly disposers: Array<{ dispose(): void }> = []

  constructor(host: PreviewHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'preview-panel'
    this.element.dataset.preview = 'md'
    this.frame = document.createElement('iframe')
    this.frame.className = 'preview-frame'
    this.frame.title = 'Prévia de markdown'
    // No allow-scripts: not even an inline handler or a javascript: URL runs. allow-same-origin only lets the app read the frame's DOM.
    this.frame.setAttribute('sandbox', 'allow-same-origin')
    const root = document.createElement('div'); root.className = 'note-state'; root.hidden = true
    root.setAttribute('role', 'status')
    const card = document.createElement('div'); card.className = 'card'
    const ic = document.createElement('span'); ic.className = 'i'
    const title = document.createElement('h3')
    const text = document.createElement('p')
    card.append(ic, title, text)
    root.append(card)
    this.state = { root, icon: ic, title, text }
    this.element.append(this.frame, root)
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.previewId = this.id
    const preview = previewParams(params.params)
    if (!preview) {
      this.showState('warning', 'Prévia sem arquivo', 'Esta aba não aponta para nenhum arquivo.')
      return
    }
    this.path = preview.path
    this.line = preview.line
    this.disposers.push(params.api.onDidActiveChange(({ isActive }) => { if (isActive) requestAnimationFrame(() => this.focus()) }))
    this.frame.addEventListener('load', () => this.onFrameLoad())
    this.frame.srcdoc = previewShell()
    this.watch()
  }

  // ---------- the file ----------

  private watch(): void {
    if (this.watching || this.disposed || !this.path) return
    this.watching = true
    window.tether.noteWatch(this.path)
  }

  private unwatch(): void {
    if (!this.watching) return
    this.watching = false
    window.tether.noteUnwatch(this.path)
  }

  /** The preview now shows another file (the note was renamed or saved as). */
  setPath(path: string): void {
    if (path === this.path) return
    this.unwatch()
    this.path = path
    this.api?.setTitle(previewTitle(path))
    this.watch()
    this.host.onParamsChange(this)
    this.schedule(0)
  }

  watches(path: string): boolean { return path.toLowerCase() === this.path.toLowerCase() }

  /** The text of the editor that holds the file changed, finished loading, or went away; or the file changed on disk. */
  sourceChanged(): void { this.schedule(PREVIEW_DEBOUNCE_MS) }

  /** The file changed on disk: with an editor open it is the editor's business (its text will change); else read it. */
  diskChanged(): void { if (!this.host.editorFor(this.path)) this.schedule(0) }

  private schedule(ms: number): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, ms)
  }

  private async currentText(): Promise<string | undefined> {
    const editor = this.host.editorFor(this.path)
    if (editor) return editor.text
    const r = await window.tether.noteRead(this.path)
    if (r.ok) return r.text
    if (r.missing) { this.showState('file-text', 'Arquivo não encontrado', this.path); return undefined }
    this.showState('x-circle', 'Não foi possível ler o arquivo', r.message)
    return undefined
  }

  /** Reads the text and draws it; a newer request makes an older one stop before touching the frame. */
  async refresh(): Promise<void> {
    if (this.disposed || !this.frameReady) return
    const version = ++this.renderVersion
    try {
      const text = await this.currentText()
      if (text === undefined || version !== this.renderVersion || this.disposed) return
      const html = await renderMarkdown(text, { noteDir: noteDirOf(this.path), highlight: colorizeCode })
      if (version !== this.renderVersion || this.disposed) return
      this.hideState()
      this.lastError = undefined
      this.apply(html)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error(`prévia ${this.path}: ${this.lastError}`)
      this.showState('warning', 'Não foi possível desenhar a prévia', this.lastError)
    }
  }

  // ---------- the frame ----------

  private get doc(): Document | null { return this.frame.contentDocument }
  private get win(): Window | null { return this.frame.contentWindow }

  private onFrameLoad(): void {
    const doc = this.doc
    const win = this.win
    if (!doc || !win || this.disposed) return
    // A frame that is moved in the page (the pane dragged to another group, a split) loads its document again, empty:
    // what was drawn is gone and what was measured is stale.
    this.frameReady = true
    this.lastHtml = undefined
    this.blocksCache = undefined
    this.firstRender = true
    this.resizeObserver?.disconnect()
    this.paintStyle()
    // The document just drawn is put back at once, before the render of the text (a frame that reloaded would flash empty).
    const root = doc.getElementById('root')
    if (root && this.renderedHtml !== undefined) {
      root.innerHTML = this.renderedHtml
      this.lastHtml = this.renderedHtml
      if (this.line !== undefined) this.scrollToLine(this.line)
    }
    doc.addEventListener('click', ev => this.onClick(ev))
    doc.addEventListener('auxclick', ev => { if (ev.button === 1) this.onClick(ev) })
    doc.addEventListener('dblclick', ev => this.onDoubleClick(ev))
    // dockview re-attaches the pane's element when the pane is activated, and an iframe loads its document again each time it
    // is re-attached: activating on the press would swallow the rest of the click. The pane is activated once the click is over
    // (later than a double click takes, which activates the editor itself).
    doc.addEventListener('click', () => this.activateLater())
    doc.addEventListener('keydown', ev => this.forwardKey(ev))
    doc.addEventListener('contextmenu', ev => {
      ev.preventDefault()
      const f = this.frame.getBoundingClientRect()
      this.host.onTabMenu(this.id, f.left + ev.clientX, f.top + ev.clientY)
    })
    win.addEventListener('scroll', () => this.onScroll(), { passive: true })
    // Images and fonts settling, a resized pane: the measured blocks are stale.
    this.resizeObserver = new ResizeObserver(() => { this.blocksCache = undefined })
    this.resizeObserver.observe(doc.documentElement)
    this.schedule(0)
  }

  /** The tokens (colours, fonts) of the app as painted now, and the code colours of the editor's theme. */
  private paintStyle(): void {
    const doc = this.doc
    if (!doc) return
    const font = terminalFontOptions(this.host.getAppearance()).fontFamily
    const set = (id: string, css: string): void => { const el = doc.getElementById(id); if (el && el.textContent !== css) el.textContent = css }
    set('tokens', tokensCss(readPreviewTokens(), this.host.getScheme(), font))
    set('syntax', tokenColorsCss())
    this.blocksCache = undefined
  }

  /** The scheme or the terminal font changed: repaint (the code colours depend on the theme: draw again). */
  restyle(): void {
    if (!this.frameReady) return
    this.paintStyle()
    this.lastHtml = undefined
    this.schedule(0)
  }

  private apply(html: string): void {
    const doc = this.doc
    const root = doc?.getElementById('root')
    if (!doc || !root) return
    this.paintStyle()
    const editor = this.host.editorFor(this.path)
    // Keep the place: the line at the top before, put back at the top after (content above may have changed height).
    const keep = this.firstRender ? this.line : (this.measure().length > 0 ? this.topLine() : this.line)
    if (html !== this.lastHtml) {
      root.innerHTML = html
      this.lastHtml = html
      this.renderedHtml = html
      this.blocksCache = undefined
    }
    this.renderCount++
    if (editor?.isReady && editor.isShown) this.syncFromEditor(editor)
    else if (keep !== undefined) this.scrollToLine(keep)
    this.firstRender = false
  }

  // ---------- scroll ----------

  private measure(): LineBlock[] {
    if (this.blocksCache) return this.blocksCache
    if (!this.frameReady) return []
    const doc = this.doc
    const win = this.win
    if (!doc || !win) return []
    const scrollTop = win.scrollY
    const blocks: LineBlock[] = []
    for (const el of doc.querySelectorAll<HTMLElement>('[data-line]')) {
      const start = Number(el.dataset.line)
      const end = Number(el.dataset.lineEnd)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      const r = el.getBoundingClientRect()
      blocks.push({ start, end, top: r.top + scrollTop, height: r.height })
    }
    this.blocksCache = blocks
    return blocks
  }

  /** The source line at the top of the preview (0-based, fractional). */
  topLine(): number {
    const win = this.win
    return win ? lineAtOffset(this.measure(), win.scrollY) ?? 0 : 0
  }

  scrollToLine(line: number): void {
    const win = this.win
    if (!win) return
    const y = offsetOfLine(this.measure(), line)
    if (y === undefined) return
    this.suppressUntil = performance.now() + SYNC_ECHO_MS
    win.scrollTo({ top: Math.max(0, y), behavior: 'instant' })
    // The event arrives a frame later (much later in a window that is not painting): the position tells the echo from the person.
    this.expectedTop = win.scrollY
  }

  /** The editor scrolled: the preview follows. */
  editorScrolled(editor: NotePanel): void {
    this.suppressUntil = 0
    this.syncFromEditor(editor)
  }

  private syncFromEditor(editor: NotePanel): void { this.scrollToLine(editor.topLine()) }

  private onScroll(): void {
    this.scheduleParams()
    this.line = this.topLine()
    const top = this.win?.scrollY ?? 0
    if (this.expectedTop !== undefined && Math.abs(top - this.expectedTop) <= 1.5) return // the echo of the editor's own scroll
    this.expectedTop = undefined
    if (performance.now() < this.suppressUntil) return
    const editor = this.host.editorFor(this.path)
    if (editor?.isShown) editor.scrollToLine(this.topLine())
  }

  private scheduleParams(): void {
    if (this.viewTimer || this.disposed) return
    this.viewTimer = setTimeout(() => { this.viewTimer = undefined; this.flushParams() }, VIEW_THROTTLE_MS)
  }

  private flushParams(): void {
    if (this.viewTimer) { clearTimeout(this.viewTimer); this.viewTimer = undefined }
    if (this.disposed || !this.frameReady) return
    this.line = this.topLine()
    this.host.onParamsChange(this)
  }

  // ---------- clicks and keys ----------

  private onClick(ev: MouseEvent): void {
    const link = (ev.target as Element | null)?.closest?.('a')
    if (!link) return
    // Nothing navigates inside the frame: every link is decided here.
    ev.preventDefault()
    const href = link.getAttribute('href')
    if (!href) return
    const target = classifyLink(href, noteDirOf(this.path))
    if (target.kind === 'external') this.host.openExternal(target.url)
    else if (target.kind === 'anchor') this.scrollToAnchor(target.id)
    else if (target.kind === 'file') this.host.openFile(target.path, noteDirOf(this.path), target.line)
  }

  private scrollToAnchor(id: string): void {
    const doc = this.doc
    if (!doc) return
    const el = doc.getElementById(id) ?? doc.getElementById(slugify(id)) ?? doc.getElementById(id.toLowerCase())
    if (!el) return
    this.suppressUntil = 0
    el.scrollIntoView({ block: 'start', behavior: 'instant' })
  }

  private onDoubleClick(ev: MouseEvent): void {
    if ((ev.target as Element | null)?.closest?.('a')) return
    const win = this.win
    if (!win) return
    const line = lineAtOffset(this.measure(), ev.clientY + win.scrollY)
    if (line === undefined) return
    if (this.activateTimer) { clearTimeout(this.activateTimer); this.activateTimer = undefined }
    this.host.revealSource(this, Math.floor(line) + 1)
  }

  private activateTimer: ReturnType<typeof setTimeout> | undefined
  private activateLater(): void {
    if (this.activateTimer) clearTimeout(this.activateTimer)
    this.activateTimer = setTimeout(() => { this.activateTimer = undefined; if (!this.disposed) this.host.activate(this) }, ACTIVATE_DELAY_MS)
  }

  /** Keys pressed inside the frame never reach the page's listeners: the app's chords are replayed on the document. */
  private forwardKey(ev: KeyboardEvent): void {
    const copy = new KeyboardEvent('keydown', {
      key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, repeat: ev.repeat, bubbles: true, cancelable: true,
    })
    this.frame.dispatchEvent(copy)
    if (copy.defaultPrevented) ev.preventDefault()
  }

  // ---------- look ----------

  focus(): void { this.win?.focus() }

  private showState(ic: Parameters<typeof icon>[0], title: string, text: string): void {
    setIcon(this.state.icon, ic)
    this.state.title.textContent = title
    this.state.text.textContent = text
    this.state.root.hidden = false
  }

  private hideState(): void { this.state.root.hidden = true }

  // ---------- tests ----------

  snapshot(): PreviewSnapshot {
    const doc = this.doc
    const win = this.win
    return {
      id: this.id, path: this.path, sandbox: this.frame.getAttribute('sandbox') ?? '',
      text: doc?.getElementById('root')?.textContent ?? '',
      html: doc?.getElementById('root')?.innerHTML ?? '',
      scrollTop: win?.scrollY ?? 0,
      scrollHeight: doc?.documentElement?.scrollHeight ?? 0,
      topLine: this.frameReady ? this.topLine() : 0,
      blocks: this.frameReady ? this.measure().length : 0,
      error: this.lastError,
      rendered: this.renderCount,
    }
  }

  /** Where a test clicks: the frame's rectangle and the element's, in page coordinates. */
  rectOf(selector: string): { x: number; y: number; width: number; height: number } | undefined {
    const el = this.doc?.querySelector(selector)
    if (!el) return undefined
    const f = this.frame.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: f.left + r.left, y: f.top + r.top, width: r.width, height: r.height }
  }

  dispose(): void {
    if (this.disposed) return
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.frameReady) this.flushParams()
    this.disposed = true
    this.unwatch()
    for (const d of this.disposers.splice(0)) d.dispose()
    this.resizeObserver?.disconnect()
    this.frame.srcdoc = ''
  }
}

/** The preview's tab: the eye, "Prévia: nome.md", the ×; right-click opens the pane menu. */
export class PreviewTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly text: HTMLElement
  private readonly host: PreviewHost
  private disposers: Array<{ dispose(): void }> = []

  constructor(host: PreviewHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'tether-tab note preview'
    const kind = document.createElement('span'); kind.className = 'kind'; kind.append(icon('eye'))
    this.text = document.createElement('span'); this.text.className = 'text'
    const close = document.createElement('button')
    close.className = 'close'; close.title = 'Fechar prévia'; close.setAttribute('aria-label', 'Fechar prévia')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, this.text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev.clientX, ev.clientY) })
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
    this.disposers.push(params.api.onDidTitleChange(() => this.render()))
    this.render()
  }

  render(): void {
    if (!this.api) return
    const preview = previewParams(this.api.getParameters?.() ?? undefined)
    const path = preview?.path
    this.text.textContent = this.api.title ?? this.api.id
    this.element.title = `${this.api.title ?? this.api.id}\n${preview?.kind === 'html' ? 'Prévia de HTML' : 'Prévia de markdown'}${path ? `\n${path}` : ''}`
  }

  dispose(): void {
    for (const d of this.disposers) d.dispose()
    this.disposers = []
  }
}
