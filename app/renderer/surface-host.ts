// The renderer side of the surface panels (TetherUi.surfaces): a pane mounts an element, `attach` ties it to the native
// surface its extension's main side created, and from then on the element's rectangle and whether it is on screen go to main
// (`surface:place`), which keeps the view there. Nothing polls: a ResizeObserver per element, one MutationObserver for the
// class/inert/style flips that show or hide a desk, drawer, pad or tab (only those on an attached element's ancestry count),
// the window's resize, scroll and transition ends. Every pass is a microtask, so a change is on its way before the next paint.
// The surface itself is never touched here: letting go of an element hides it (main), and the same surface can be attached
// to a new element (the pane moved) without being recreated.
//
// The freeze (design §2.3, §12b rules 6–7; rules in app/shared/freeze-rules.ts): while the freeze signal is held for its
// element, a shown surface is swapped for a picture of itself. Order: capture (main, JPEG bytes) → the picture decoded and
// placed inside the host element at the effective rectangle (so it inherits the pane's clipping and scrolling) → one
// interface frame presented → park (main). Back: unpark (main waits for two page frames) → one interface frame → the picture
// goes. A click on a picture with no overlay up, or a picture left with no hold for STUCK_PICTURE_MS, forces the thaw.
import { hostVisible, sameRect, type HostFacts, type Rect, type SurfaceEvent } from '../shared/surface-panel-rules.ts'
import { FreezeMachine, FreezeRegistry, STUCK_PICTURE_MS } from '../shared/freeze-rules.ts'
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
  capture(msg: { owner: string; surface: string }): Promise<Uint8Array | null>
  freeze(msg: { owner: string; surface: string; frozen: boolean }): Promise<boolean>
}

/** The last freeze and thaw of each surface, in ms (the E2E reads them; the report quotes them). */
export interface FreezeTiming { surface: string; freezeMs?: number; thawMs?: number }

/** The picture an attachment shows while frozen, and what it changed on the host element. */
interface Picture { img: HTMLImageElement; url: string; restorePosition: string | undefined }

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
  freeze: FreezeMachine<Blob>
  picture: Picture | undefined
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
    // `data-inert-onscreen`: inert for the keyboard but still on screen (the parts behind the open drawer).
    inert: el.closest('[inert]:not([data-inert-onscreen])') !== null,
  }
}

export class SurfaceHosts {
  private readonly transport: SurfaceTransport
  private readonly all = new Set<Attachment>()
  private mo: MutationObserver | undefined
  private scheduled = false
  private readonly offEvent: () => void
  private readonly cleanups: (() => void)[] = []
  /** The freeze signal (overlay-freeze.ts holds it for the core's overlays, `ui.surfaces.freezeWhile` for an extension's). */
  readonly freezes: FreezeRegistry<Element>
  private readonly offFreeze: () => void
  private stuckTimer: ReturnType<typeof setTimeout> | undefined
  private readonly timings = new Map<string, FreezeTiming>()

  constructor(transport: SurfaceTransport, freezes = new FreezeRegistry<Element>()) {
    this.transport = transport
    this.freezes = freezes
    this.offEvent = transport.onEvent(e => this.onEvent(e))
    this.offFreeze = freezes.onChange(() => this.onFreezeChange())
  }

  /** Pictures on screen now (the E2E counts them). */
  pictures(): number { let n = 0; for (const a of this.all) if (a.picture) n++; return n }

  freezeTimings(): FreezeTiming[] { return [...this.timings.values()].map(t => ({ ...t })) }

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
      freeze: undefined as unknown as FreezeMachine<Blob>, picture: undefined,
    }
    a.freeze = this.machineFor(a)
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

  /** Hides every placed surface (or those inside `within`) now, ahead of a change that is about to cover or remove it (a desk switch, the drawer closing). The next pass shows what is still on screen. */
  suspendAll(within?: Element): void {
    for (const a of this.all) {
      if (!a.sent || !a.sent.visible || (within && !within.contains(a.element))) continue
      a.sent = { ...a.sent, visible: false }
      this.transport.place({ owner: a.owner, surface: a.surface, rect: a.sent.rect, viewportWidth: a.sent.viewportWidth, visible: false })
      this.refreeze(a)
    }
    this.schedule()
  }

  dispose(): void {
    for (const a of [...this.all]) this.detach(a)
    this.offEvent()
    this.offFreeze()
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
  }

  /** Whether the attachment's surface must be frozen now: the signal holds for its element and the surface is on screen. */
  private wantsFreeze(a: Attachment): boolean {
    const v = a.state?.visibility
    return !!a.sent?.visible && (v === 'shown' || v === 'parked') && this.freezes.freezes(a.element)
  }

  private refreeze(a: Attachment): void {
    if (this.all.has(a)) a.freeze.set(this.wantsFreeze(a))
  }

  private onFreezeChange(): void {
    for (const a of this.all) this.refreeze(a)
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = undefined }
    if (this.freezes.count() === 0) {
      // The safety valve: with nothing holding the signal, no picture may outlive a normal thaw by much.
      this.stuckTimer = setTimeout(() => {
        this.stuckTimer = undefined
        if (this.freezes.count() > 0) return
        for (const a of this.all) if (a.picture) { console.warn('surfaces: picture left on screen, forcing the thaw', a.surface); a.freeze.force() }
      }, STUCK_PICTURE_MS)
    }
  }

  private machineFor(a: Attachment): FreezeMachine<Blob> {
    const id = { owner: a.owner, surface: a.surface }
    let t0 = 0
    return new FreezeMachine<Blob>({
      capture: async () => {
        t0 = performance.now()
        const bytes = await this.transport.capture(id)
        return bytes && bytes.byteLength > 0 ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }) : undefined
      },
      paint: async blob => {
        const img = document.createElement('img')
        img.dataset.surfaceFreeze = a.surface
        img.alt = ''
        img.draggable = false
        img.style.cssText = 'position:absolute;display:block;max-width:none;margin:0;padding:0;border:0;z-index:2147483647;user-select:none;cursor:default'
        const url = URL.createObjectURL(blob)
        img.src = url
        try { await img.decode() } catch (e) { URL.revokeObjectURL(url); throw e }
        if (!this.all.has(a)) { URL.revokeObjectURL(url); throw new Error('detached') }
        const position = getComputedStyle(a.element).position
        const restorePosition = position === 'static' ? a.element.style.position : undefined
        if (restorePosition !== undefined) a.element.style.position = 'relative'
        // The safety valve: a click on a picture with no overlay up means it was left behind.
        img.addEventListener('pointerdown', ev => {
          if (this.freezes.count() > 0) return
          ev.preventDefault(); ev.stopPropagation()
          a.freeze.force()
        })
        a.picture = { img, url, restorePosition }
        this.placePicture(a)
        a.element.appendChild(img)
        await frames(1)
      },
      unpaint: () => {
        const p = a.picture
        if (!p) return
        a.picture = undefined
        p.img.remove()
        URL.revokeObjectURL(p.url)
        if (p.restorePosition !== undefined) a.element.style.position = p.restorePosition
      },
      park: async () => {
        await this.transport.freeze({ ...id, frozen: true })
        this.timings.set(a.surface, { ...this.timings.get(a.surface), surface: a.surface, freezeMs: round(performance.now() - t0) })
      },
      unpark: async () => {
        const t = performance.now()
        await Promise.race([this.transport.freeze({ ...id, frozen: false }), sleep(STUCK_PICTURE_MS)])
        // One interface frame with the surface already above the picture, then the picture may go.
        await frames(1)
        this.timings.set(a.surface, { ...this.timings.get(a.surface), surface: a.surface, thawMs: round(performance.now() - t) })
      },
    })
  }

  /** The picture over the effective rectangle (element CSS px from its border box; absolute is from the padding box). */
  private placePicture(a: Attachment): void {
    const p = a.picture
    const r = a.state?.effective
    if (!p || !r) return
    const s = p.img.style
    s.left = `${r.x - a.element.clientLeft}px`
    s.top = `${r.y - a.element.clientTop}px`
    s.width = `${r.width}px`
    s.height = `${r.height}px`
  }

  private detach(a: Attachment): void {
    a.freeze.dispose()
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
        // A resize while frozen moves the parked surface's rectangle: the picture follows it.
        this.placePicture(a)
        this.refreeze(a)
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
    if (was?.visible !== visible) this.refreeze(a)
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

const round = (ms: number): number => Math.round(ms * 10) / 10
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** `n` interface frames presented (a timeout stands in when frames are not produced: a hidden window). */
function frames(n: number): Promise<void> {
  return new Promise(resolve => {
    let left = n
    const done = setTimeout(resolve, 100 * n)
    const tick = (): void => { if (--left <= 0) { clearTimeout(done); resolve() } else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
}
