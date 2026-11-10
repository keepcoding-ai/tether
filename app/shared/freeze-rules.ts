// The freeze of the native surfaces (design §2.3, §12b rules 6–8), pure parts: no DOM, no Electron, unit-tested on their own
// (test/unit/app.freeze-rules.test.ts). The DOM side is app/renderer/surface-host.ts (the image, the host element) and
// app/renderer/overlay-freeze.ts (which overlays hold the signal); main parks and brings back (app/main/surface-bridge.ts).
//
// A native surface is drawn above the whole interface, so anything the interface puts over it (palette, menu, dialog, the
// open drawer, a tab being dragged) would be hidden under the page. While such an overlay is up, every shown surface is
// swapped for a picture of itself and parked (full size, a single pixel inside the window); when the last one goes, the
// surface comes back and only then the picture leaves. The page stays alive all along.
//
// Only overlays that are MODAL or that THE PERSON OPENED hold the signal. Passing notifications and tooltips never do: the
// person may be typing a password in the page when one shows up, and freezing would take the page from under the keys.
// Those are placed outside the page's area instead.

/** Something that may contain a host element (a DOM Element in the renderer; anything with `contains` in the tests). */
export interface Container<E> { contains(other: E | null): boolean }

export interface FreezeHold<E> {
  /** Why (palette, menu, dialog, drawer, drag, an extension's own): shown to the E2E and in logs. */
  reason: string
  /** Surfaces inside this container stay alive (the drawer's own surfaces, over the frozen desk behind it). */
  except?: Container<E>
}

/**
 * The single "an overlay that freezes is up" signal: a counter of holds, each with its reason. Nesting is just two holds
 * (the palette opened from a menu): the surfaces come back only when the last one is let go.
 */
export class FreezeRegistry<E = unknown> {
  private readonly holds = new Set<FreezeHold<E>>()
  private readonly listeners = new Set<() => void>()

  /** Holds the signal until the returned function is called (idempotent). */
  hold(reason: string, except?: Container<E>): () => void {
    const h: FreezeHold<E> = except ? { reason, except } : { reason }
    this.holds.add(h)
    this.fire()
    let done = false
    return () => {
      if (done) return
      done = true
      this.holds.delete(h)
      this.fire()
    }
  }

  /** Holds now. */
  count(): number { return this.holds.size }

  /** The reasons held now, in the order they were taken. */
  reasons(): string[] { return [...this.holds].map(h => h.reason) }

  /** Whether a surface whose host element is `el` must be frozen: some hold does not spare it. */
  freezes(el: E): boolean {
    for (const h of this.holds) if (!h.except || !h.except.contains(el)) return true
    return false
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private fire(): void {
    for (const l of [...this.listeners]) { try { l() } catch (e) { console.error('freeze.onChange', e) } }
  }
}

/** What freezing one surface takes, in order (the machine never calls two at once). */
export interface FreezeOps<I> {
  /** The page as it is now; undefined when it could not be had (the surface went, the capture failed). */
  capture(): Promise<I | undefined>
  /** The picture on screen over the surface's effective rectangle: decoded and one interface frame presented. */
  paint(image: I): Promise<void>
  /** The picture off screen (sync: nothing to wait for, the surface is already back above it, or gone). */
  unpaint(): void
  /** The surface parked (main): only called with the picture painted. */
  park(): Promise<void>
  /** The surface back and painted (main): the picture is removed only after this. */
  unpark(): Promise<void>
}

export type FreezePhase = 'live' | 'frozen'

/**
 * The freeze of one surface. `set(true|false)` says what is wanted; one loop at a time walks towards it, re-reading the wish
 * between steps, so a menu that opens and closes before the capture returns paints nothing, and a close while the picture
 * is being painted removes it without parking. Order (§12b rule 7): picture painted, then park; surface back and painted,
 * then the picture goes.
 */
export class FreezeMachine<I> {
  private readonly ops: FreezeOps<I>
  private wanted = false
  private phase: FreezePhase = 'live'
  private painted = false
  private disposed = false
  /** A capture failed: no retry until the wish drops (no loop on a surface that cannot be captured). */
  private failed = false
  private running: Promise<void> | undefined

  constructor(ops: FreezeOps<I>) { this.ops = ops }

  /** Frozen (picture up, surface parked) or live. */
  get state(): FreezePhase { return this.phase }
  /** The picture is on screen (also during the swaps). */
  get imaged(): boolean { return this.painted }
  get wants(): boolean { return this.wanted }

  set(want: boolean): void {
    if (this.disposed) return
    if (!want) this.failed = false
    this.wanted = want
    void this.drive()
  }

  /** Resolves when the loop is at rest (tests, and callers that measure). */
  async idle(): Promise<void> { while (this.running) await this.running }

  /**
   * The safety valve (a picture left on screen by a failure): the picture goes now and the surface is asked back without
   * waiting. The wish stays as it is; a later set(true) freezes again.
   */
  force(): void {
    if (this.disposed) return
    this.wanted = false
    this.failed = false
    const wasFrozen = this.phase === 'frozen'
    this.phase = 'live'
    this.removePicture()
    if (wasFrozen) this.ops.unpark().catch(() => { /* the surface may be gone */ })
  }

  /** The element let go (pane closed or moved): the picture goes; a parked surface is asked back (main decides what is visible). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.wanted = false
    this.removePicture()
    if (this.phase === 'frozen') { this.phase = 'live'; this.ops.unpark().catch(() => {}) }
  }

  private removePicture(): void {
    if (!this.painted) return
    this.painted = false
    try { this.ops.unpaint() } catch (e) { console.error('freeze.unpaint', e) }
  }

  private drive(): Promise<void> {
    if (this.running) return this.running
    this.running = this.loop().finally(() => {
      this.running = undefined
      // A wish that arrived after the loop decided to stop (it returns on a later microtask) starts a new one.
      if (this.pending()) void this.drive()
    })
    return this.running
  }

  private pending(): boolean {
    if (this.disposed) return false
    return this.wanted ? !this.failed && this.phase === 'live' : this.phase === 'frozen' || this.painted
  }

  private async loop(): Promise<void> {
    while (!this.disposed) {
      if (this.wanted && !this.failed && this.phase === 'live') {
        let image: I | undefined
        try { image = await this.ops.capture() } catch { image = undefined }
        if (this.disposed) return
        if (image === undefined) { if (this.wanted) this.failed = true; continue }
        if (!this.wanted) continue
        try { await this.ops.paint(image); this.painted = true } catch { this.failed = true; this.removePicture(); continue }
        if (this.disposed) { this.removePicture(); return }
        if (!this.wanted) { this.removePicture(); continue }
        try { await this.ops.park() } catch { /* gone or refused: the picture stays only while wanted */ }
        if (this.disposed) return
        this.phase = 'frozen'
        continue
      }
      if (!this.wanted && this.phase === 'frozen') {
        try { await this.ops.unpark() } catch { /* gone: nothing to wait for */ }
        if (this.disposed) return
        this.phase = 'live'
        // Asked again while coming back: the page moved on meanwhile, so the picture goes and a fresh capture follows.
        this.removePicture()
        continue
      }
      if (!this.wanted && this.painted) { this.removePicture(); continue }
      return
    }
  }
}

/** How long a picture may stay on screen with no hold at all before the safety valve removes it (ms). */
export const STUCK_PICTURE_MS = 2500
