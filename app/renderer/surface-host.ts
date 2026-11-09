// The renderer side of the surface panels (TetherUi.surfaces): a pane mounts an element, `attach` ties it to the native
// surface its extension's main side created, and from then on the element's rectangle and whether it is on screen go to main
// (`surface:place`), which keeps the view there. Nothing polls: a ResizeObserver per element, one MutationObserver for the
// class/inert/style flips that show or hide a desk, drawer, pad or tab (only those on an attached element's ancestry count),
// the window's resize, scroll and transition ends. Every pass is a microtask, so a change is on its way before the next paint.
// The surface itself is never touched here: letting go of an element hides it (main), and the same surface can be attached
// to a new element (the pane moved) without being recreated.
import { hostVisible, sameRect, type HostFacts, type Rect, type SurfaceEvent } from '../shared/surface-panel-rules.ts'
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

/** What main reports about the surface, in the host element's CSS px. */
export interface SurfaceHostState {
  visibility: 'hidden' | 'shown' | 'parked'
  /** Where the page is drawn inside the element (the fitted page; the bands around it show the interface), or undefined before the first placement. */
  effective: Rect | undefined
  /** Page px → view px (the page is never enlarged: ≤ 1). */
  scale: number
}

/** The shield's input (the person tried to use the page): the point is in the host element's CSS px. */
export interface SurfaceShieldEvent {
  kind: 'down' | 'move' | 'wheel' | 'key'
  x: number
  y: number
  button?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
}

export interface SurfaceBinding extends IDisposable {
  /** The last state main reported, if any. */
  state(): SurfaceHostState | undefined
  onState(listener: (state: SurfaceHostState) => void): IDisposable
  onShieldInput(listener: (input: SurfaceShieldEvent) => void): IDisposable
  /** Reads the element again and tells main (after a change no observer sees). */
  refresh(): void
}

/** What the host needs from the window: the preload's surface calls and the viewport width. */
export interface SurfaceTransport {
  place(msg: { owner: string; surface: string; rect: Rect; viewportWidth: number; visible: boolean }): void
  release(msg: { owner: string; surface: string }): void
  onEvent(listener: (event: SurfaceEvent) => void): () => void
}

interface Attachment {
  owner: string
  surface: string
  element: HTMLElement
  ro: ResizeObserver
  /** The last thing sent, to send only changes. */
  sent: { rect: Rect; visible: boolean; viewportWidth: number } | undefined
  state: SurfaceHostState | undefined
  stateL: Set<(s: SurfaceHostState) => void>
  shieldL: Set<(i: SurfaceShieldEvent) => void>
}

const MUTATION_ATTRIBUTES = ['class', 'inert', 'style', 'hidden', 'data-open', 'data-empty', 'aria-hidden']

/** The element's facts for hostVisible. */
export function factsOf(el: HTMLElement): HostFacts {
  const box = el.getBoundingClientRect()
  const check = (el as HTMLElement & { checkVisibility?(o?: Record<string, boolean>): boolean }).checkVisibility
  return {
    connected: el.isConnected,
    width: box.width,
    height: box.height,
    displayed: check ? check.call(el) : true,
    cssVisible: check ? check.call(el, { visibilityProperty: true, checkVisibilityCSS: true }) : true,
    inert: el.closest('[inert]') !== null,
  }
}

export class SurfaceHosts {
  private readonly transport: SurfaceTransport
  private readonly all = new Set<Attachment>()
  private mo: MutationObserver | undefined
  private scheduled = false
  private readonly offEvent: () => void
  private readonly cleanups: (() => void)[] = []

  constructor(transport: SurfaceTransport) {
    this.transport = transport
    this.offEvent = transport.onEvent(e => this.onEvent(e))
  }

  /** Elements attached now (the E2E counts them). */
  count(): number { return this.all.size }

  /** The `attach` an extension gets: its id travels with every message, so main can refuse another owner's surface. */
  forOwner(owner: string): (surfaceId: string, element: HTMLElement) => SurfaceBinding {
    return (surface, element) => this.attach(owner, surface, element)
  }

  attach(owner: string, surface: string, element: HTMLElement): SurfaceBinding {
    const a: Attachment = {
      owner, surface, element, ro: new ResizeObserver(() => { this.sync(a) }),
      sent: undefined, state: undefined, stateL: new Set(), shieldL: new Set(),
    }
    this.all.add(a)
    a.ro.observe(element)
    this.start()
    this.schedule()
    let disposed = false
    return {
      state: () => a.state,
      onState: l => { a.stateL.add(l); return toDisposable(() => { a.stateL.delete(l) }) },
      onShieldInput: l => { a.shieldL.add(l); return toDisposable(() => { a.shieldL.delete(l) }) },
      refresh: () => { if (!disposed) this.sync(a) },
      dispose: () => {
        if (disposed) return
        disposed = true
        this.detach(a)
      },
    }
  }

  /** Hides every placed surface now, ahead of a change that is about to cover or remove it (a desk switch, the drawer closing). The next pass shows what is still on screen. */
  suspendAll(): void {
    for (const a of this.all) {
      if (!a.sent || !a.sent.visible) continue
      a.sent = { ...a.sent, visible: false }
      this.transport.place({ owner: a.owner, surface: a.surface, rect: a.sent.rect, viewportWidth: a.sent.viewportWidth, visible: false })
    }
    this.schedule()
  }

  dispose(): void {
    for (const a of [...this.all]) this.detach(a)
    this.offEvent()
  }

  private detach(a: Attachment): void {
    a.ro.disconnect()
    this.all.delete(a)
    // The surface stays shown by another element of the same owner (a pane moved: the new one attached first): no release then.
    const still = [...this.all].some(o => o.surface === a.surface)
    if (!still) this.transport.release({ owner: a.owner, surface: a.surface })
    a.stateL.clear()
    a.shieldL.clear()
    if (this.all.size === 0) this.stop()
  }

  private onEvent(e: SurfaceEvent): void {
    for (const a of [...this.all]) {
      if (a.surface !== e.surface) continue
      if (e.kind === 'state') {
        a.state = { visibility: e.visibility, effective: e.effective, scale: e.scale }
        for (const l of [...a.stateL]) { try { l(a.state) } catch (err) { console.error('surfaces.onState', err) } }
      } else {
        for (const l of [...a.shieldL]) { try { l(e.input) } catch (err) { console.error('surfaces.onShieldInput', err) } }
      }
    }
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; for (const a of [...this.all]) this.sync(a) })
  }

  private sync(a: Attachment): void {
    if (!this.all.has(a)) return
    const box = a.element.getBoundingClientRect()
    const rect = { x: box.left, y: box.top, width: box.width, height: box.height }
    const visible = hostVisible(factsOf(a.element))
    const viewportWidth = window.innerWidth
    const was = a.sent
    if (was && was.visible === visible && was.viewportWidth === viewportWidth && sameRect(was.rect, rect, 0.01)) return
    a.sent = { rect, visible, viewportWidth }
    this.transport.place({ owner: a.owner, surface: a.surface, rect, viewportWidth, visible })
  }

  /** The observers and listeners that exist only while something is attached. */
  private start(): void {
    if (this.mo) return
    const touches = (n: Node): boolean => { for (const a of this.all) if (n.contains(a.element)) return true; return false }
    this.mo = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes' ? touches(r.target) : [...r.addedNodes, ...r.removedNodes].some(touches) || touches(r.target)) { this.schedule(); return }
      }
    })
    this.mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: MUTATION_ATTRIBUTES, childList: true })
    const poke = (): void => this.schedule()
    for (const ev of ['resize', 'scroll'] as const) { window.addEventListener(ev, poke, { capture: true, passive: true }); this.cleanups.push(() => window.removeEventListener(ev, poke, true)) }
    for (const ev of ['transitionend', 'animationend'] as const) { document.addEventListener(ev, poke, true); this.cleanups.push(() => document.removeEventListener(ev, poke, true)) }
    window.visualViewport?.addEventListener('resize', poke)
    const vv = window.visualViewport
    if (vv) this.cleanups.push(() => vv.removeEventListener('resize', poke))
  }

  private stop(): void {
    this.mo?.disconnect()
    this.mo = undefined
    for (const c of this.cleanups.splice(0)) c()
  }
}
