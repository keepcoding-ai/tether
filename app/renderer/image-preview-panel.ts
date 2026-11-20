// One dockview panel = one image file shown by the app (the image viewer). The bytes come from main (`readImage`), become a
// blob and are drawn by an `<img>`: an SVG is never injected in the DOM (as an image it runs no script and loads nothing).
//   - fit to the window by default (never enlarged past 100%); Ctrl+wheel / Ctrl+= / Ctrl+- zoom, Ctrl+0 fits, 1 shows 1:1,
//     drag pans a picture larger than the area; the checkerboard behind transparency takes the colors of the current theme;
//   - a thin strip with the file and its actions ("Ver código" for an SVG: the same file in the editor), a status bar with the
//     size in pixels, the size on disk and the zoom;
//   - live: the picture is read again when its file changes on disk (the zoom is kept).
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer } from 'dockview-core'
import { icon, setIcon } from './icons.ts'
import type { NoteIo, NotePanel } from './note-panel.ts'
import type { PreviewPane } from './preview-pane.ts'
import type { ImageRead } from '../shared/api.ts'
import { clampZoom, fitScale, formatBytes, formatZoom, placeAxis, ZOOM_STEP, zoomOffset } from '../shared/image-view.ts'
import { pathKey } from '../shared/html-preview.ts'
import { noteTitle } from '../shared/notes.ts'
import { imageMime, isSvgPath, previewParams, previewTitle } from '../shared/preview.ts'
import { followActive } from './focus-follow.ts'

/** After the last change of the file the picture is read again (an editor writes in two steps). */
export const IMAGE_RELOAD_DEBOUNCE_MS = 200
/** An SVG without a size of its own: a box to draw it in. */
const FALLBACK_SIZE = { width: 300, height: 150 }
/** From this zoom the pixels are shown as squares instead of smoothed. */
const PIXELATED_FROM = 2

export interface ImagePreviewHost {
  io: NoteIo
  /** The image's bytes (main reads the file). */
  readImage(path: string): Promise<ImageRead>
  /** The path changed: persist the pane params with the layout. */
  onParamsChange(panel: ImagePreviewPanel): void
  /** "Ver código": the SVG in a note tab (the editor), in the pane's group. */
  viewSource(panel: ImagePreviewPanel, path: string): void
  /** The pane got the keyboard: it becomes the active pane. */
  activate(panel: ImagePreviewPanel): void
  onTabMenu(id: string, x: number, y: number): void
}

/** What a test reads of an image viewer. */
export interface ImagePreviewSnapshot {
  id: string
  kind: 'image'
  path: string
  /** The picture's own size (px), 0 until it is decoded. */
  width: number
  height: number
  /** Bytes on disk. */
  size: number
  zoom: number
  fit: boolean
  /** How many times the file was read. */
  loads: number
  state: string | undefined
  status: string
  visible: boolean
}

export class ImagePreviewPanel implements IContentRenderer, PreviewPane {
  readonly kind = 'image' as const
  readonly element: HTMLElement
  id = ''
  path = ''
  private api: DockviewPanelApi | undefined
  private readonly host: ImagePreviewHost
  private readonly strip: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly stage: HTMLElement
  private readonly img: HTMLImageElement
  private readonly statusEl: HTMLElement
  private readonly fitButton: HTMLElement
  private readonly state: { root: HTMLElement; icon: HTMLElement; title: HTMLElement; text: HTMLElement }
  private stateName: string | undefined
  private objectUrl: string | undefined
  private natural = { width: 0, height: 0 }
  private bytes = 0
  private fit = true
  private zoom = 1
  /** The picture's top-left in the stage while zoomed by hand (clamped when drawn). */
  private offset = { x: 0, y: 0 }
  private loads = 0
  private token = 0
  private disposed = false
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  private observer: ResizeObserver | undefined
  private watching = false
  private readonly disposers: Array<{ dispose(): void }> = []

  constructor(host: ImagePreviewHost) {
    this.host = host
    this.element = document.createElement('div')
    this.element.className = 'preview-panel image-preview'
    this.element.dataset.preview = 'image'

    const strip = document.createElement('div'); strip.className = 'ip-strip'
    const kind = document.createElement('span'); kind.className = 'ip-kind'; kind.append(icon('file-image'))
    this.nameEl = document.createElement('span'); this.nameEl.className = 'ip-name'
    const spacer = document.createElement('span'); spacer.className = 'ip-spacer'
    this.fitButton = this.button('fit', 'arrows-out-simple', '', 'Ajustar à janela (Ctrl+0)', () => this.fitToWindow())
    strip.append(kind, this.nameEl, spacer,
      this.button('zoom-out', 'magnifying-glass-minus', '', 'Reduzir (Ctrl+-)', () => this.zoomBy(1 / ZOOM_STEP)),
      this.button('zoom-in', 'magnifying-glass-plus', '', 'Ampliar (Ctrl+=)', () => this.zoomBy(ZOOM_STEP)),
      this.fitButton,
      this.button('actual', 'circle', '1:1', 'Tamanho real, 100% (1)', () => this.actualSize()),
      this.button('reload', 'arrow-clockwise', '', 'Recarregar a imagem', () => this.reload()))
    this.strip = strip

    this.stage = document.createElement('div'); this.stage.className = 'ip-stage'
    this.stage.tabIndex = 0
    // The chords the stage owns: the app's key dispatch (main.ts) lets them through instead of changing the terminal font.
    this.stage.dataset.ownChords = '= + - 0'
    this.img = document.createElement('img'); this.img.className = 'ip-img'; this.img.draggable = false; this.img.hidden = true
    const root = document.createElement('div'); root.className = 'note-state'; root.hidden = true
    root.setAttribute('role', 'status')
    const card = document.createElement('div'); card.className = 'card'
    const ic = document.createElement('span'); ic.className = 'i'
    const title = document.createElement('h3')
    const text = document.createElement('p')
    card.append(ic, title, text)
    root.append(card)
    this.state = { root, icon: ic, title, text }
    this.stage.append(this.img, root)

    this.statusEl = document.createElement('div'); this.statusEl.className = 'ip-status'; this.statusEl.hidden = true
    this.element.append(strip, this.stage, this.statusEl)
    this.wire()
  }

  private button(action: string, ic: Parameters<typeof icon>[0], label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'ip-btn'; b.dataset.action = action; b.title = title; b.setAttribute('aria-label', label || title)
    b.append(icon(ic))
    if (label) { const t = document.createElement('span'); t.textContent = label; b.append(t) }
    b.addEventListener('click', ev => { ev.stopPropagation(); run() })
    return b
  }

  private wire(): void {
    const menu = (ev: MouseEvent): void => { ev.preventDefault(); if (this.api) this.host.onTabMenu(this.api.id, ev.clientX, ev.clientY) }
    this.strip.addEventListener('contextmenu', menu)
    this.stage.addEventListener('contextmenu', menu)
    this.stage.addEventListener('focus', () => this.host.activate(this))
    this.stage.addEventListener('keydown', ev => this.onKey(ev))
    this.stage.addEventListener('wheel', ev => this.onWheel(ev), { passive: false })
    this.stage.addEventListener('dblclick', () => { if (this.fit) this.actualSize(); else this.fitToWindow() })
    let drag: { x: number; y: number; ox: number; oy: number; id: number } | undefined
    this.stage.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return
      this.stage.focus()
      const at = this.placed()
      drag = { x: ev.clientX, y: ev.clientY, ox: at.x, oy: at.y, id: ev.pointerId }
      try { this.stage.setPointerCapture(ev.pointerId) } catch { /* the pointer is gone */ }
    })
    this.stage.addEventListener('pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id || !this.overflows()) return
      this.fit = false
      this.offset = { x: drag.ox + ev.clientX - drag.x, y: drag.oy + ev.clientY - drag.y }
      this.place()
    })
    const end = (ev: PointerEvent): void => { if (drag && ev.pointerId === drag.id) drag = undefined }
    this.stage.addEventListener('pointerup', end)
    this.stage.addEventListener('pointercancel', end)
  }

  init(params: GroupPanelPartInitParameters): void {
    this.api = params.api
    this.id = params.api.id
    this.element.dataset.previewId = this.id
    const preview = previewParams(params.params)
    if (!preview) {
      this.showState('warning', 'Imagem sem arquivo', 'Esta aba não aponta para nenhum arquivo.')
      return
    }
    this.path = preview.path
    this.disposers.push(followActive(params.api, () => this.focus()))
    this.paintStrip()
    this.watch()
    this.observer = new ResizeObserver(() => this.place())
    this.observer.observe(this.stage)
    void this.load()
  }

  // ---------- the picture ----------

  /** Reads the file and draws it; the zoom stays as the person left it. */
  private async load(): Promise<void> {
    if (!this.path || this.disposed) return
    const mine = ++this.token
    const r = await this.host.readImage(this.path)
    if (mine !== this.token || this.disposed) return
    if (!r.ok) {
      this.hideImage()
      if (r.missing) this.showState('file-text', 'Arquivo não encontrado', this.path)
      else this.showState('x-circle', 'Não foi possível abrir a imagem', r.message)
      return
    }
    const url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: imageMime(this.path) }))
    const decoder = new Image()
    decoder.src = url
    try { await decoder.decode() } catch {
      URL.revokeObjectURL(url)
      if (mine !== this.token || this.disposed) return
      this.hideImage()
      this.showState('x-circle', 'Não foi possível exibir a imagem', 'O arquivo não é uma imagem válida deste formato.')
      return
    }
    if (mine !== this.token || this.disposed) { URL.revokeObjectURL(url); return }
    const previous = this.objectUrl
    this.objectUrl = url
    this.img.src = url
    if (previous) URL.revokeObjectURL(previous)
    // An SVG with no intrinsic size reports 0: give it a box to be zoomed from.
    this.natural = { width: decoder.naturalWidth || FALLBACK_SIZE.width, height: decoder.naturalHeight || FALLBACK_SIZE.height }
    this.bytes = r.size
    this.loads++
    this.hideState()
    this.img.hidden = false
    this.place()
  }

  private hideImage(): void { this.img.hidden = true; this.natural = { width: 0, height: 0 }; this.paintStatus() }

  private box(): { width: number; height: number } {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight }
  }

  private drawn(): { width: number; height: number } {
    return { width: this.natural.width * this.zoom, height: this.natural.height * this.zoom }
  }

  private overflows(): boolean {
    const size = this.drawn(); const box = this.box()
    return size.width > box.width || size.height > box.height
  }

  /** Where the picture's top-left is now (stage coordinates). */
  private placed(): { x: number; y: number } {
    const box = this.box(); const size = this.drawn()
    return { x: placeAxis(box.width, size.width, this.offset.x), y: placeAxis(box.height, size.height, this.offset.y) }
  }

  /** Sizes and positions the picture: centered when it fits an axis, clamped to the area when it overflows. */
  private place(): void {
    if (this.disposed || this.img.hidden || this.natural.width === 0) { this.paintStatus(); return }
    const box = this.box()
    if (box.width === 0 || box.height === 0) return // a hidden pane: drawn when it shows
    if (this.fit) this.zoom = fitScale(this.natural.width, this.natural.height, box.width, box.height)
    const size = this.drawn()
    const at = this.placed()
    if (!this.fit) this.offset = at
    this.img.style.width = `${size.width}px`
    this.img.style.height = `${size.height}px`
    this.img.style.transform = `translate(${at.x}px, ${at.y}px)`
    this.img.classList.toggle('pixelated', this.zoom >= PIXELATED_FROM)
    this.stage.classList.toggle('pannable', this.overflows())
    this.paintStatus()
  }

  // ---------- zoom ----------

  reload(): void { void this.load() }

  fitToWindow(): void { this.fit = true; this.offset = { x: 0, y: 0 }; this.place() }

  /** 1:1, centered. */
  actualSize(): void { this.setZoom(1, undefined) }

  zoomBy(factor: number, cursor?: { x: number; y: number }): void { this.setZoom(this.zoom * factor, cursor) }

  /** The zoom around a point of the stage (default: its center), the point staying under the cursor. */
  private setZoom(next: number, cursor: { x: number; y: number } | undefined): void {
    if (this.natural.width === 0) return
    const box = this.box()
    const to = clampZoom(next)
    const from = this.zoom
    const c = cursor ?? { x: box.width / 2, y: box.height / 2 }
    const at = this.placed()
    this.fit = false
    this.zoom = to
    this.offset = { x: zoomOffset(c.x, at.x, from, to), y: zoomOffset(c.y, at.y, from, to) }
    this.place()
  }

  private onWheel(ev: WheelEvent): void {
    if (this.natural.width === 0) return
    if (ev.ctrlKey) {
      ev.preventDefault()
      const r = this.stage.getBoundingClientRect()
      this.zoomBy(Math.pow(1.0015, -ev.deltaY), { x: ev.clientX - r.left, y: ev.clientY - r.top })
      return
    }
    if (!this.overflows()) return
    ev.preventDefault()
    const at = this.placed()
    this.fit = false
    this.offset = { x: at.x - ev.deltaX, y: at.y - ev.deltaY }
    this.place()
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.altKey || ev.metaKey) return
    if (ev.ctrlKey) {
      if (ev.key === '=' || ev.key === '+') this.zoomBy(ZOOM_STEP)
      else if (ev.key === '-' || ev.key === '_') this.zoomBy(1 / ZOOM_STEP)
      else if (ev.key === '0') this.fitToWindow()
      else return
    } else if (ev.key === '1' && !ev.shiftKey) this.actualSize()
    else return
    ev.preventDefault(); ev.stopPropagation()
  }

  // ---------- the file ----------

  private watch(): void {
    if (this.watching || this.disposed || !this.path) return
    this.watching = true
    this.host.io.watch(this.path)
  }

  private unwatch(): void {
    if (!this.watching) return
    this.watching = false
    this.host.io.unwatch(this.path)
  }

  watches(path: string): boolean { return this.watching && pathKey(path) === pathKey(this.path) }

  diskChanged(): void {
    if (this.disposed) return
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => { this.reloadTimer = undefined; void this.load() }, IMAGE_RELOAD_DEBOUNCE_MS)
  }

  /** The editor's unsaved text is not what the viewer shows; the note's own save reaches the disk and `diskChanged`. */
  sourceChanged(): void {}
  editorScrolled(_editor: NotePanel): void {}
  topLine(): number { return 0 }
  restyle(): void {}

  /** The file was renamed: the viewer follows it. */
  setPath(path: string): void {
    if (path === this.path) return
    this.unwatch()
    this.path = path
    this.api?.setTitle(previewTitle(path))
    this.watch()
    this.host.onParamsChange(this)
    this.paintStrip()
    void this.load()
  }

  // ---------- look ----------

  focus(): void { try { this.stage.focus({ preventScroll: true }) } catch { /* not attached */ } }

  private paintStrip(): void {
    this.nameEl.textContent = noteTitle(this.path)
    this.nameEl.title = this.path
    this.strip.querySelector('[data-action="source"]')?.remove()
    if (isSvgPath(this.path)) {
      const source = this.button('source', 'brackets-curly', 'Ver código', 'Ver código: abre o SVG no editor', () => this.host.viewSource(this, this.path))
      this.strip.querySelector('[data-action="reload"]')?.before(source)
    }
  }

  private statusText(): string {
    if (this.natural.width === 0) return ''
    return `${this.natural.width} × ${this.natural.height} px · ${formatBytes(this.bytes)} · ${formatZoom(this.zoom)}`
  }

  private paintStatus(): void {
    this.statusEl.textContent = this.statusText()
    this.statusEl.hidden = this.natural.width === 0
    this.fitButton.classList.toggle('on', this.fit)
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

  snapshot(): ImagePreviewSnapshot {
    return {
      id: this.id, kind: 'image', path: this.path, width: this.natural.width, height: this.natural.height, size: this.bytes,
      zoom: this.zoom, fit: this.fit, loads: this.loads, state: this.stateName, status: this.statusText(), visible: this.api?.isVisible ?? false,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); this.reloadTimer = undefined }
    this.observer?.disconnect()
    this.unwatch()
    for (const d of this.disposers.splice(0)) d.dispose()
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined }
  }
}
