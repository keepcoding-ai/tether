// One dockview panel = the rendered page of one .html file, running (F5, "prévia de HTML"). The page is the author's: its
// scripts run, nothing of the app's look is injected. It lives in a `<webview>`, a separate sandboxed process with a session of its own
// and no way back to the app (main locks it: app/main/html-preview-main.ts; the file policy is app/main/html-preview-policy.ts):
//   - the strip above the page carries "Ver código" (the file in a note tab), "Abrir no navegador" and a reload button;
//   - live: the page reloads when its file, or any file of its folder it loaded (main reports them), changes on disk; the
//     scroll position survives the reload;
//   - the pane remembers its file and its scroll in its params; the next launch reopens it.
// The pane is `renderer: 'always'` for dockview: an `<iframe>`/`<webview>` that is detached and re-attached loads again,
// and a running page must not restart when the pane is activated or dragged to another group.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer } from 'dockview-core'
import { icon, setIcon } from './icons.ts'
import type { NoteIo, NotePanel } from './note-panel.ts'
import type { PreviewPane } from './preview-pane.ts'
import type { PreviewKey, PreviewReport } from '../shared/api.ts'
import { blockedLabel, fromFileUrl, pathKey, previewPartition, toFileUrl } from '../shared/html-preview.ts'
import { noteTitle } from '../shared/notes.ts'
import { previewParams, previewTitle } from '../shared/preview.ts'
import { followActive } from './focus-follow.ts'

/** After the last change of a watched file the page reloads (an editor writes in two steps; a build touches many files). */
export const HTML_RELOAD_DEBOUNCE_MS = 200
/** How often the page's scroll is read to be persisted with the layout. */
const SCROLL_POLL_MS = 1000
/** After a reload the saved scroll is applied again as the page lays out (late images, scripts). */
const SCROLL_RESTORE_MS = [0, 120, 400, 1000]

/** The parts of Electron's `<webview>` this pane uses (the renderer's typings do not include Electron's). */
interface WebviewElement extends HTMLElement {
  src: string
  getURL(): string
  getWebContentsId(): number
  reloadIgnoringCache(): void
  stop(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  isLoading(): boolean
}

export interface HtmlPreviewHost {
  io: NoteIo
  /** The path or the scroll changed: persist the pane params with the layout. */
  onParamsChange(panel: HtmlPreviewPanel): void
  /** "Ver código": the file in a note tab (the editor, not the preview), in the pane's group. */
  viewSource(panel: HtmlPreviewPanel, path: string): void
  /** "Abrir no navegador": the file with the system's browser. */
  openInBrowser(path: string): void
  /** The pane got the keyboard inside the page, where dockview cannot see it: it becomes the active pane. */
  activate(panel: HtmlPreviewPanel): void
  /** A chord pressed inside the page, replayed on the pane element so the app's key handling sees it. */
  onTabMenu(id: string, x: number, y: number): void
}

/** What a test reads of an HTML preview. */
export interface HtmlPreviewSnapshot {
  id: string
  kind: 'html'
  path: string
  /** The page showing now (it can differ from `path` after a link inside the folder). */
  currentPath: string
  url: string
  partition: string
  /** The webview's guest WebContents id (main side), once it exists. */
  contentsId: number | undefined
  /** Files of the page's folder it loaded (main's report) and what the policy refused. */
  files: string[]
  blocked: Array<{ url: string; reason: string }>
  /** How many times the page was loaded or reloaded by this pane. */
  loads: number
  scroll: { x: number; y: number }
  state: string | undefined
  visible: boolean
}

export class HtmlPreviewPanel implements IContentRenderer, PreviewPane {
  readonly kind = 'html' as const
  readonly element: HTMLElement
  id = ''
  path = ''
  private api: DockviewPanelApi | undefined
  private readonly host: HtmlPreviewHost
  private readonly strip: { root: HTMLElement; name: HTMLElement; blocked: HTMLElement; blockedText: HTMLElement }
  private readonly state: { root: HTMLElement; icon: HTMLElement; title: HTMLElement; text: HTMLElement }
  private readonly body: HTMLElement
  private webview: WebviewElement | undefined
  private partition = ''
  private disposed = false
  private ready = false
  /** Partitions handed out (a fresh guest gets a fresh session) and pages loaded or reloaded. */
  private generation = 0
  private loads = 0
  private currentPath = ''
  private scroll = { x: 0, y: 0 }
  /** Applied (and re-applied for a moment) once the page has loaded: the saved scroll of a reload or a resume. */
  private pendingScroll: { x: number; y: number } | undefined
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private files: string[] = []
  private blocked: Array<{ url: string; reason: string }> = []
  /** What this pane watches: path key → the path as given to the watcher (unwatched with the same spelling). */
  private watched = new Map<string, string>()
  private stateName: string | undefined
  private readonly disposers: Array<{ dispose(): void }> = []

  constructor(host: HtmlPreviewHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'preview-panel html-preview'
    this.element.dataset.preview = 'html'

    const strip = document.createElement('div'); strip.className = 'hp-strip'
    const kind = document.createElement('span'); kind.className = 'hp-kind'; kind.append(icon('file-html'))
    const name = document.createElement('span'); name.className = 'hp-name'
    const blocked = document.createElement('span'); blocked.className = 'hp-blocked'; blocked.hidden = true
    const blockedText = document.createElement('span')
    blocked.append(icon('shield-warning'), blockedText)
    const spacer = document.createElement('span'); spacer.className = 'hp-spacer'
    strip.append(kind, name, blocked, spacer,
      this.button('reload', 'arrow-clockwise', '', 'Recarregar a página', () => this.reload()),
      this.button('source', 'brackets-curly', 'Ver código', 'Ver código: abre o arquivo no editor', () => this.host.viewSource(this, this.currentPath || this.path)),
      this.button('browser', 'arrow-square-out', 'Abrir no navegador', 'Abrir no navegador: o arquivo no navegador do sistema', () => this.host.openInBrowser(this.currentPath || this.path)))
    this.strip = { root: strip, name, blocked, blockedText }

    this.body = document.createElement('div'); this.body.className = 'hp-body'
    const root = document.createElement('div'); root.className = 'note-state'; root.hidden = true
    root.setAttribute('role', 'status')
    const card = document.createElement('div'); card.className = 'card'
    const ic = document.createElement('span'); ic.className = 'i'
    const title = document.createElement('h3')
    const text = document.createElement('p')
    card.append(ic, title, text)
    root.append(card)
    this.state = { root, icon: ic, title, text }
    this.body.append(root)
    this.element.append(strip, this.body)
    strip.addEventListener('contextmenu', ev => { ev.preventDefault(); if (this.api) this.host.onTabMenu(this.api.id, ev.clientX, ev.clientY) })
  }

  private button(action: string, ic: Parameters<typeof icon>[0], label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'hp-btn'; b.dataset.action = action; b.title = title; b.setAttribute('aria-label', label || title)
    b.append(icon(ic))
    if (label) { const t = document.createElement('span'); t.textContent = label; b.append(t) }
    b.addEventListener('click', ev => { ev.stopPropagation(); run() })
    return b
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
    this.currentPath = preview.path
    if (preview.scroll) { this.scroll = preview.scroll; this.pendingScroll = preview.scroll }
    this.disposers.push(followActive(params.api, () => this.focus()))
    this.paintStrip()
    this.watch(this.path)
    this.mount()
    this.pollTimer = setInterval(() => { void this.pollScroll() }, SCROLL_POLL_MS)
  }

  // ---------- the webview ----------

  /** Creates the guest: the partition and the file are attributes, set before the element enters the page (main checks both on attach). */
  private mount(): void {
    this.unmount()
    this.partition = previewPartition(this.id, ++this.generation)
    const wv = document.createElement('webview') as WebviewElement
    wv.className = 'hp-view'
    wv.setAttribute('partition', this.partition)
    wv.setAttribute('src', toFileUrl(this.path))
    // Popups are only ever answered by main's window-open handler (always "deny"; http(s) goes to the system browser).
    wv.setAttribute('allowpopups', 'true')
    this.ready = false
    this.currentPath = this.path
    const on = (type: string, fn: (ev: Event & Record<string, unknown>) => void): void => wv.addEventListener(type, fn as EventListener)
    on('dom-ready', () => { this.ready = true; this.hideState() })
    on('did-start-loading', () => { this.ready = false })
    on('did-finish-load', () => { this.ready = true; this.loads++; this.restoreScroll() })
    on('did-navigate', ev => {
      const url = String(ev.url ?? wv.getURL())
      const path = fromFileUrl(url)
      if (path) { this.currentPath = path; this.paintStrip() }
    })
    on('did-fail-load', ev => {
      // -3: the load was aborted by a newer one (a reload, a navigation): not a failure.
      if (ev.isMainFrame !== true || ev.errorCode === -3) return
      if (ev.errorCode === -6) this.showState('file-text', 'Arquivo não encontrado', this.path)
      else this.showState('x-circle', 'Não foi possível abrir a página', `${String(ev.errorDescription ?? '')} (${String(ev.errorCode)})`)
    })
    on('render-process-gone', () => { this.ready = false; this.showState('warning', 'A página parou de funcionar', 'Use "Recarregar a página" para abri-la de novo.') })
    // A click or a key inside the page never reaches dockview: the pane becomes the active one when the page takes the focus.
    on('focus', () => this.host.activate(this))
    this.webview = wv
    this.body.prepend(wv)
  }

  private unmount(): void {
    const wv = this.webview
    this.webview = undefined
    this.ready = false
    if (!wv) return
    try { wv.stop() } catch { /* not attached yet */ }
    wv.remove()
  }

  /** Loads the page again, ignoring the cache, keeping the scroll. */
  reload(): void {
    const wv = this.webview
    if (!wv || this.disposed) return
    this.hideState()
    // Where the page is now (read first: the poll stands down while a restore is pending), then back to it after the load.
    const go = (): void => { this.pendingScroll = this.scroll; this.reloadNow() }
    if (this.ready) void this.pollScroll().finally(go)
    else go()
  }

  private reloadNow(): void {
    const wv = this.webview
    if (!wv || this.disposed) return
    try { wv.reloadIgnoringCache() } catch { this.mount() } // the guest is gone (render process crashed before attach): a fresh one
  }

  private restoreScroll(): void {
    const target = this.pendingScroll
    const wv = this.webview
    if (!target || !wv) return
    this.pendingScroll = undefined
    const code = `(function(x, y) { var go = function() { window.scrollTo({ left: x, top: y, behavior: 'instant' }) }; go(); ${JSON.stringify(SCROLL_RESTORE_MS)}.forEach(function(ms) { setTimeout(go, ms) }) })(${Math.round(target.x)}, ${Math.round(target.y)})`
    void wv.executeJavaScript(code).catch(() => { /* the page went away meanwhile */ })
  }

  /** Reads where the page is scrolled; persists it with the layout when it moved. */
  private async pollScroll(): Promise<void> {
    const wv = this.webview
    if (!wv || !this.ready || this.disposed || this.pendingScroll || !(this.api?.isVisible ?? true)) return
    try {
      const r = await wv.executeJavaScript('[Math.round(window.scrollX), Math.round(window.scrollY)]')
      if (!Array.isArray(r) || typeof r[0] !== 'number' || typeof r[1] !== 'number') return
      if (this.disposed || this.pendingScroll) return
      if (r[0] !== this.scroll.x || r[1] !== this.scroll.y) {
        this.scroll = { x: r[0], y: r[1] }
        this.host.onParamsChange(this)
      }
    } catch { /* loading, or gone */ }
  }

  get scrollPosition(): { x: number; y: number } { return this.scroll }

  // ---------- the files ----------

  private watch(path: string): void {
    const key = pathKey(path)
    if (this.watched.has(key) || this.disposed) return
    this.watched.set(key, path)
    this.host.io.watch(path)
  }

  private unwatch(key: string): void {
    const path = this.watched.get(key)
    if (path === undefined) return
    this.watched.delete(key)
    this.host.io.unwatch(path)
  }

  /** Main's report of what the page loaded and what the policy refused: the files are watched for the live reload. */
  onReport(report: PreviewReport): void {
    if (this.disposed) return
    this.files = report.files
    this.blocked = report.blocked
    const want = new Set([pathKey(this.path), ...report.files.map(pathKey)])
    for (const key of [...this.watched.keys()]) if (!want.has(key)) this.unwatch(key)
    for (const file of [this.path, ...report.files]) this.watch(file)
    this.paintStrip()
  }

  watches(path: string): boolean {
    return this.watched.has(pathKey(path))
  }

  diskChanged(): void {
    if (this.disposed) return
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => { this.reloadTimer = undefined; this.reload() }, HTML_RELOAD_DEBOUNCE_MS)
  }

  /** The editor's unsaved text is not what the page runs; the note's own save reaches the disk and `diskChanged`. */
  sourceChanged(): void {}
  editorScrolled(_editor: NotePanel): void {}
  topLine(): number { return 0 }
  restyle(): void {}

  /** The file was renamed: the page follows it (a fresh guest, its folder may differ). */
  setPath(path: string): void {
    if (path === this.path) return
    for (const key of [...this.watched.keys()]) this.unwatch(key)
    this.path = path
    this.api?.setTitle(previewTitle(path))
    this.files = []
    this.blocked = []
    this.watch(path)
    this.host.onParamsChange(this)
    this.paintStrip()
    this.mount()
  }

  // ---------- keys ----------

  /** A chord pressed inside the page: replayed on the pane so the app's own key handling decides (it never saw the key). */
  replayKey(key: PreviewKey): void {
    const target = this.webview ?? this.element
    const ev = new KeyboardEvent('keydown', { key: key.key, code: key.code, ctrlKey: key.control, shiftKey: key.shift, altKey: key.alt, metaKey: key.meta, bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
  }

  hasPartition(partition: string): boolean { return partition === this.partition }

  // ---------- look ----------

  focus(): void { try { this.webview?.focus() } catch { /* not attached */ } }

  private paintStrip(): void {
    const shown = this.currentPath || this.path
    this.strip.name.textContent = noteTitle(shown)
    this.strip.name.title = shown
    const n = this.blocked.length
    this.strip.blocked.hidden = n === 0
    this.strip.blockedText.textContent = n === 0 ? '' : ` ${blockedLabel(n)}`
    this.strip.blocked.title = n === 0 ? '' : `Bloqueado pela política da prévia (só a pasta da página e https):\n${this.blocked.slice(0, 8).map(b => `${b.url} — ${b.reason}`).join('\n')}${n > 8 ? `\n… e mais ${n - 8}` : ''}`
  }

  private showState(ic: Parameters<typeof icon>[0], title: string, text: string): void {
    setIcon(this.state.icon, ic)
    this.state.title.textContent = title
    this.state.text.textContent = text
    this.state.root.hidden = false
    this.stateName = title
  }

  private hideState(): void { this.state.root.hidden = true; this.stateName = undefined }

  // ---------- tests ----------

  snapshot(): HtmlPreviewSnapshot {
    let contentsId: number | undefined
    let url = ''
    try { if (this.ready) { contentsId = this.webview?.getWebContentsId(); url = this.webview?.getURL() ?? '' } } catch { /* not attached */ }
    return {
      id: this.id, kind: 'html', path: this.path, currentPath: this.currentPath, url, partition: this.partition, contentsId,
      files: [...this.files], blocked: [...this.blocked], loads: this.loads, scroll: { ...this.scroll }, state: this.stateName,
      visible: this.api?.isVisible ?? false,
    }
  }

  /** The guest's rectangle on the page (a test clicks inside it with a real mouse). */
  viewRect(): { x: number; y: number; width: number; height: number } | undefined {
    const r = this.webview?.getBoundingClientRect()
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined
  }

  dispose(): void {
    if (this.disposed) return
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); this.reloadTimer = undefined }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined }
    this.disposed = true
    for (const key of [...this.watched.keys()]) this.unwatch(key)
    for (const d of this.disposers.splice(0)) d.dispose()
    this.unmount()
  }
}
