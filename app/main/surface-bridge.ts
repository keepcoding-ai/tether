// The main side of the surface panels: the pane's host element (renderer) tells where it is and whether it is on screen
// (`surface:place`), and this applies it to the surface of the extension that asked: rectangle first, then shown; hidden at
// once when it leaves the screen. A surface of another owner is never touched. What the surface ended up as (visibility,
// effective rectangle in the element's space, scale) and the shield's input go back to the same window as
// `tether:surface-event`. A minimized window hides every placed surface and brings them back on restore.
// Surfaces are the extension's: letting go of an element (`surface:release`) hides the surface, never destroys it.
// The freeze (design §2.3, §12b; the renderer's half is app/renderer/surface-host.ts): `surface:capture` hands the page as a
// JPEG buffer (no base64 over the channel), `surface:freeze` parks the surface (the renderer has painted the picture) or
// brings it back and waits for the page to paint (the renderer removes the picture after that). While frozen, a surface that
// comes on screen from hidden stays hidden until the thaw: shown, it would cover the overlay with no picture to replace it.
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { ExtSurfaces, Surface, SurfaceShieldInput } from './ext-api.ts'
import { cssToWindow, parsePlace, parseRelease, type PlaceMessage, sameRect, type SurfaceEvent, windowRectToElement, windowToElement, zoomOf } from '../shared/surface-panel-rules.ts'
import type { Rect } from './surface-rules.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'

export const PLACE_CHANNEL = 'surface:place'
export const RELEASE_CHANNEL = 'surface:release'
export const EVENT_CHANNEL = 'tether:surface-event'
export const CAPTURE_CHANNEL = 'surface:capture'
export const FREEZE_CHANNEL = 'surface:freeze'

/** JPEG: the cheapest encoding that does not show (bench B2: ~10 ms against ~22 ms for PNG). */
const FREEZE_JPEG_QUALITY = 90
/** The longest the thaw waits for the page's two frames (a busy page must not keep the picture up). */
const PAINT_TIMEOUT_MS = 250
/** An isolated world of the core's own: the page cannot wrap the requestAnimationFrame it waits on. */
const PAINT_WORLD = 1_009_001

export interface SurfaceBridgeDeps {
  /** The surfaces of one extension. */
  surfaces(owner: string): ExtSurfaces
  window(): BrowserWindow | undefined
  ipc: {
    on(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): unknown
    handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown
  }
  log(msg: string): void
}

/** What the renderer last asked for one surface, and the machinery that applies it in order. */
interface Binding {
  owner: string
  surface: Surface
  /** Element rectangle in window DIP, and the zoom it was converted with. */
  host: Rect | undefined
  zoom: number
  visible: boolean
  /** An apply is running; `dirty` asks for another round with the latest request when it ends. */
  running: Promise<void> | undefined
  dirty: boolean
  /** The renderer froze it (an overlay is up); `parked`: this bridge parked it (an owner's own parking is left alone). */
  frozen: boolean
  parked: boolean
  /** The state last reported to the renderer (to send only changes). */
  reported: string
  shield: IDisposable | undefined
  gone: IDisposable | undefined
}

export class SurfaceBridge {
  private readonly deps: SurfaceBridgeDeps
  private readonly bindings = new Map<string, Binding>()
  private watched: BrowserWindow | undefined

  constructor(deps: SurfaceBridgeDeps) {
    this.deps = deps
    deps.ipc.on(PLACE_CHANNEL, (event, raw) => this.onPlace(event, raw))
    deps.ipc.on(RELEASE_CHANNEL, (event, raw) => this.onRelease(event, raw))
    deps.ipc.handle(CAPTURE_CHANNEL, (event, raw) => this.onCapture(event, raw))
    deps.ipc.handle(FREEZE_CHANNEL, (event, raw) => this.onFreeze(event, raw))
  }

  /** The bound surface the renderer names, if it is that owner's and the message came from the window. */
  private boundFor(sender: unknown, raw: unknown): Binding | undefined {
    const win = this.deps.window()
    if (!win || win.isDestroyed() || sender !== win.webContents) return undefined
    const msg = parseRelease(raw)
    if (!msg) return undefined
    const b = this.bindings.get(msg.surface)
    return b && b.owner === msg.owner && !b.surface.state().destroyed ? b : undefined
  }

  private async onCapture(event: IpcMainInvokeEvent, raw: unknown): Promise<Uint8Array | null> {
    const b = this.boundFor(event.sender, raw)
    if (!b) return null
    try {
      const img = await b.surface.capture()
      return img.isEmpty() ? null : img.toJPEG(FREEZE_JPEG_QUALITY)
    } catch { return null }
  }

  private async onFreeze(event: IpcMainInvokeEvent, raw: unknown): Promise<boolean> {
    const b = this.boundFor(event.sender, raw)
    const frozen = (raw as { frozen?: unknown } | null)?.frozen
    if (!b || typeof frozen !== 'boolean') return false
    b.frozen = frozen
    await this.apply(b)
    return !b.surface.state().destroyed
  }

  /** Surfaces with an element attached right now (the E2E counts them). */
  count(): number { return this.bindings.size }

  private onPlace(event: IpcMainEvent, raw: unknown): void {
    const win = this.deps.window()
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    const msg = parsePlace(raw)
    if (!msg) return
    const b = this.bind(msg)
    if (!b) return
    const [contentWidth] = win.getContentSize() as [number, number]
    const zoom = zoomOf(contentWidth, msg.viewportWidth)
    const host = cssToWindow(msg.rect, zoom)
    if (b.visible === msg.visible && b.zoom === zoom && sameRect(b.host, host, 0.01)) return
    b.host = host
    b.zoom = zoom
    b.visible = msg.visible
    this.watch(win)
    void this.apply(b)
  }

  private onRelease(event: IpcMainEvent, raw: unknown): void {
    const win = this.deps.window()
    if (win && !win.isDestroyed() && event.sender !== win.webContents) return
    const msg = parseRelease(raw)
    if (!msg) return
    const b = this.bindings.get(msg.surface)
    if (!b || b.owner !== msg.owner) return
    this.unbind(b)
    if (b.surface.state().destroyed) return
    // Hidden, not destroyed: the surface is the extension's, and the pane may come back (moved, restored).
    b.surface.setVisibility('hidden').catch(() => { /* destroyed meanwhile */ })
  }

  /** The binding of a surface, made on first sight; undefined when the owner has no such surface (another one's included). */
  private bind(msg: PlaceMessage): Binding | undefined {
    const existing = this.bindings.get(msg.surface)
    if (existing) return existing.owner === msg.owner ? existing : undefined
    const surface = this.deps.surfaces(msg.owner).get(msg.surface)
    if (!surface || surface.state().destroyed) return undefined
    const b: Binding = {
      owner: msg.owner, surface, host: undefined, zoom: 1, visible: false, running: undefined, dirty: false, frozen: false, parked: false, reported: '',
      shield: undefined, gone: undefined,
    }
    b.shield = surface.onShieldInput(input => this.sendShield(b, input))
    b.gone = surface.onDidDestroy(() => this.unbind(b))
    this.bindings.set(surface.id, b)
    return b
  }

  private unbind(b: Binding): void {
    if (this.bindings.get(b.surface.id) === b) this.bindings.delete(b.surface.id)
    b.shield?.dispose()
    b.gone?.dispose()
  }

  private watch(win: BrowserWindow): void {
    if (this.watched === win) return
    this.watched = win
    const again = (): void => { for (const b of this.bindings.values()) void this.apply(b) }
    win.on('minimize', again)
    win.on('restore', again)
    win.on('closed', () => {
      for (const b of [...this.bindings.values()]) this.unbind(b)
      if (this.watched === win) this.watched = undefined
    })
  }

  /** Applies the latest request; requests that arrive meanwhile collapse into one more round (the promise covers it). */
  private apply(b: Binding): Promise<void> {
    if (b.running) { b.dirty = true; return b.running }
    b.running = (async () => {
      try {
        do {
          b.dirty = false
          await this.applyOnce(b)
        } while (b.dirty)
      } catch (e) {
        if (!b.surface.state().destroyed) this.deps.log(`superfície ${b.surface.id} (${b.owner}): ${(e as Error).message}`)
      } finally {
        b.running = undefined
      }
    })()
    return b.running
  }

  /** Two frames of the page (or the timeout): the surface is back on screen with its content drawn. */
  private async painted(b: Binding): Promise<void> {
    const wc = b.surface.webContents
    if (wc.isDestroyed()) return
    const frames = wc.executeJavaScriptInIsolatedWorld(PAINT_WORLD, [{ code: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))' }])
      .catch(() => undefined)
    await Promise.race([frames, new Promise(r => setTimeout(r, PAINT_TIMEOUT_MS))])
  }

  private async applyOnce(b: Binding): Promise<void> {
    const win = this.deps.window()
    const s = b.surface
    if (s.state().destroyed) return
    const show = b.visible && b.host !== undefined && !!win && !win.isDestroyed() && !win.isMinimized()
    if (!show) {
      // Hide first; a hidden surface's rectangle is refreshed on the next show.
      if (s.state().visibility !== 'hidden') await s.setVisibility('hidden')
      b.parked = false
    } else {
      // Position first, then show. Frozen: a shown surface parks (the picture is up), a hidden one waits for the thaw.
      // Thawed: only a surface this bridge parked comes back (an owner's own parking is the owner's).
      await s.setRect(b.host!)
      const v = s.state().visibility
      if (b.frozen) {
        if (v === 'shown') { await s.setVisibility('parked'); b.parked = true }
      } else if (v === 'hidden') {
        await s.setVisibility('shown')
      } else if (v === 'parked' && b.parked) {
        await s.setVisibility('shown')
        b.parked = false
        this.report(b)
        await this.painted(b)
      }
    }
    this.report(b)
  }

  private report(b: Binding): void {
    const win = this.deps.window()
    if (!win || win.isDestroyed()) return
    const st = b.surface.state()
    const effective = st.effective && b.host ? windowRectToElement(st.effective, b.host, b.zoom) : undefined
    const event: SurfaceEvent = { kind: 'state', surface: st.id, visibility: st.visibility, effective, scale: st.scale }
    const key = JSON.stringify(event)
    if (key === b.reported) return
    b.reported = key
    win.webContents.send(EVENT_CHANNEL, event)
  }

  private sendShield(b: Binding, input: SurfaceShieldInput): void {
    const win = this.deps.window()
    if (!win || win.isDestroyed() || !b.host) return
    const at = windowToElement(input, b.host, b.zoom)
    const event: SurfaceEvent = { kind: 'shield', surface: b.surface.id, input: { ...input, x: at.x, y: at.y } }
    win.webContents.send(EVENT_CHANNEL, event)
  }
}
