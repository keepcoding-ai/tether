// The main side of the surface panels: the pane's host element (renderer) tells where it is and whether it is on screen
// (`surface:place`), and this applies it to the surface of the extension that asked: rectangle first, then shown; hidden at
// once when it leaves the screen. A surface of another owner is never touched. What the surface ended up as (visibility,
// effective rectangle in the element's space, scale) and the shield's input go back to the same window as
// `tether:surface-event`. A minimized window hides every placed surface and brings them back on restore.
// Surfaces are the extension's: letting go of an element (`surface:release`) hides the surface, never destroys it.
import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { ExtSurfaces, Surface, SurfaceShieldInput } from './ext-api.ts'
import { cssToWindow, parsePlace, parseRelease, type PlaceMessage, sameRect, type SurfaceEvent, windowRectToElement, windowToElement, zoomOf } from '../shared/surface-panel-rules.ts'
import type { Rect } from './surface-rules.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'

export const PLACE_CHANNEL = 'surface:place'
export const RELEASE_CHANNEL = 'surface:release'
export const EVENT_CHANNEL = 'tether:surface-event'

export interface SurfaceBridgeDeps {
  /** The surfaces of one extension. */
  surfaces(owner: string): ExtSurfaces
  window(): BrowserWindow | undefined
  ipc: { on(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): unknown }
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
  running: boolean
  dirty: boolean
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
      owner: msg.owner, surface, host: undefined, zoom: 1, visible: false, running: false, dirty: false, reported: '',
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

  /** Applies the latest request; requests that arrive meanwhile collapse into one more round. */
  private async apply(b: Binding): Promise<void> {
    if (b.running) { b.dirty = true; return }
    b.running = true
    try {
      do {
        b.dirty = false
        await this.applyOnce(b)
      } while (b.dirty)
    } catch (e) {
      if (!b.surface.state().destroyed) this.deps.log(`superfície ${b.surface.id} (${b.owner}): ${(e as Error).message}`)
    } finally {
      b.running = false
    }
  }

  private async applyOnce(b: Binding): Promise<void> {
    const win = this.deps.window()
    const s = b.surface
    if (s.state().destroyed) return
    const show = b.visible && b.host !== undefined && !!win && !win.isDestroyed() && !win.isMinimized()
    if (!show) {
      // Hide first; a hidden surface's rectangle is refreshed on the next show.
      if (s.state().visibility !== 'hidden') await s.setVisibility('hidden')
    } else {
      // Position first, then show (a parked surface stays parked: the freeze owns that state).
      await s.setRect(b.host!)
      if (s.state().visibility === 'hidden') await s.setVisibility('shown')
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
