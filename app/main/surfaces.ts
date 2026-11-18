// Native surfaces (N2): a WebContentsView over the app's interface, created and driven by the extension that owns it. The core
// knows nothing of what the page is for; it only keeps the view where it belongs, at the size its owner fixed, alive while not
// seen, and behind an input shield when asked. The pure rules (fit, hidden/parked bounds, moves, preferences) live in
// app/main/surface-rules.ts.
//
// Recipes proven on the bench (design §12b):
//   - a fixed page size is `Emulation.setDeviceMetricsOverride` with `scale`, the view being the page fitted and centred in the
//     asked rectangle, s = min(1, fit) (zoom factor, device scale factor and page scale factor all fail);
//   - hidden = 1×1 px in the window's corner with the override and emulated focus kept on (the page paints, answers CDP and
//     takes input even with the window covered or never shown);
//   - parked = full size with a single pixel inside the window (the freeze moves it back without a resize: no empty frame);
//   - the shield is a transparent view right above the surface, with emulated focus (without it input on a covered window is
//     dropped); the owner's CDP input does not go through it (it targets the page's webContents).
// Electron has one debugger per webContents: the core attaches it and shares it with the owner (`surface.debugger`).
import { type BrowserWindow, type IpcMainEvent, type NativeImage, nativeImage, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RemoteSurfaceBridge } from './surface-bridge.ts'
import type { ExtSurfaces, Surface, SurfaceOptions, SurfaceShieldInput, SurfaceState } from './ext-api.ts'
import { canMove, fitRect, focusOnPress, hiddenBounds, isCoreDebuggerMethod, isPageSize, isRect, metricsOverride, parkedBounds, type Rect, shieldVisible, type Size, surfacePreferences, type Visibility } from './surface-rules.ts'
import { type IDisposable, toDisposable } from '../shared/vscode-lifecycle.ts'

/** The channel the shield's preload (app/preload/surface-shield.ts) sends on. */
export const SHIELD_CHANNEL = 'surface:shield'
const SHIELD_PAGE = 'data:text/html,<html style="background:transparent"><body style="margin:0;background:transparent"></body></html>'

/**
 * Where a surface's views live and how they are placed, in window coordinates (DIP of the app window's content area). In the
 * app's own process it is the window itself (`windowStage`); in the browser process each surface has a stage of its own, a
 * frameless window embedded in the app's window (app/main/browser-child.ts).
 */
export interface SurfaceStage {
  /** Stages with the same key share the resize/close watch (one per window). */
  readonly key: object
  destroyed(): boolean
  contentSize(): Size
  /** Adds the view on top of the stage's others (re-adding raises it). */
  add(view: WebContentsView): void
  remove(view: WebContentsView): void
  setBounds(view: WebContentsView, rect: Rect): void
  getBounds(view: WebContentsView): Rect
  setVisible(view: WebContentsView, on: boolean): void
  /** Keyboard focus back on the app's interface (the shield went up). */
  focusInterface(): void
  /** The OS keyboard focus on the surface's own window, when the stage has one that a click does not focus (an embedded child window). */
  focusSurface?(): void
  onResize(fn: () => void): void
  onClosed(fn: () => void): void
  /** The surface using this stage was destroyed (a stage of its own lets its window go). */
  release?(): void
}

/** The app window as the stage of its surfaces. */
export function windowStage(win: BrowserWindow): SurfaceStage {
  return {
    key: win,
    destroyed: () => win.isDestroyed(),
    contentSize: () => { const [width, height] = win.getContentSize() as [number, number]; return { width, height } },
    add: view => win.contentView.addChildView(view),
    remove: view => win.contentView.removeChildView(view),
    setBounds: (view, rect) => view.setBounds(rect),
    getBounds: view => view.getBounds(),
    setVisible: (view, on) => view.setVisible(on),
    focusInterface: () => win.webContents.focus(),
    onResize: fn => { win.on('resize', fn) },
    onClosed: fn => { win.on('closed', fn) },
  }
}

export interface SurfaceDeps {
  /** app/dist: where the shield's preload bundle is. */
  dist: string
  /** The app window (its own stage), or `stage` instead: a stage for each new surface. */
  window?(): BrowserWindow | undefined
  stage?(): SurfaceStage | undefined
  ipc: { on(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): unknown }
  log(msg: string): void
}

class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>()
  add(l: (...args: A) => void): IDisposable { this.set.add(l); return toDisposable(() => { this.set.delete(l) }) }
  fire(...args: A): void { for (const l of [...this.set]) { try { l(...args) } catch { /* a listener's error is its owner's */ } } }
  clear(): void { this.set.clear() }
}

interface Shield { view: WebContentsView }

interface SurfaceRecord {
  id: string
  owner: string
  win: SurfaceStage
  view: WebContentsView
  shield: Shield | undefined
  visibility: Visibility
  rect: Rect | undefined
  pageSize: Size | undefined
  /** The scale the override was last sent with (undefined: no override in force). */
  applied: number | undefined
  shieldOn: boolean
  destroyed: boolean
  /** Async operations of one surface run in order (the debugger commands must not interleave). */
  chain: Promise<unknown>
  messages: Listeners<[string, unknown, string | undefined]>
  detach: Listeners<[string]>
  shieldInput: Listeners<[SurfaceShieldInput]>
  destroyedL: Listeners<[]>
  handle: Surface
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 64 ? v : undefined)

export class SurfaceManager {
  private readonly records = new Map<string, SurfaceRecord>()
  private readonly windows = new WeakSet<object>()
  private readonly deps: SurfaceDeps

  constructor(deps: SurfaceDeps) {
    this.deps = deps
    deps.ipc.on(SHIELD_CHANNEL, (event, raw) => this.onShield(event, raw))
  }

  /** Owners whose surfaces live in another process: the panel bridge hands their window messages over. */
  private readonly remotes = new Map<string, RemoteSurfaceBridge>()

  remoteFor(owner: string): RemoteSurfaceBridge | undefined { return this.remotes.get(owner) }

  /** The surfaces of one extension. */
  forOwner(owner: string): ExtSurfaces {
    return {
      forwardTo: bridge => { this.remotes.set(owner, bridge); return toDisposable(() => { if (this.remotes.get(owner) === bridge) this.remotes.delete(owner) }) },
      create: options => this.create(owner, options),
      get: id => { const r = this.records.get(id); return r && r.owner === owner ? r.handle : undefined },
      list: () => [...this.records.values()].filter(r => r.owner === owner).map(r => r.handle),
    }
  }

  /** Every surface (destroyed ones are gone); the E2E counts them. */
  count(): number { return this.records.size }

  private watchWindow(win: SurfaceStage): void {
    if (this.windows.has(win.key)) return
    this.windows.add(win.key)
    win.onResize(() => { for (const r of this.records.values()) if (r.win.key === win.key) this.place(r) })
    win.onClosed(() => { for (const r of [...this.records.values()]) if (r.win.key === win.key) this.destroy(r) })
  }

  private stageNow(): SurfaceStage | undefined {
    if (this.deps.stage) return this.deps.stage()
    const win = this.deps.window?.()
    return win && !win.isDestroyed() ? windowStage(win) : undefined
  }

  private async create(owner: string, options: SurfaceOptions = {}): Promise<Surface> {
    const prefs = surfacePreferences(options.webPreferences)
    if (!prefs.ok) throw new Error(`superfície: ${prefs.reason}`)
    if (options.pageSize !== undefined && !isPageSize(options.pageSize)) throw new Error('superfície: pageSize inválido')
    const win = this.stageNow()
    if (!win || win.destroyed()) throw new Error('superfície: não há janela')
    this.watchWindow(win)
    const view = new WebContentsView({ webPreferences: prefs.value })
    const wc = view.webContents
    // A popup is the owner's to allow (it may set its own handler); by default none opens.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const r: SurfaceRecord = {
      id: randomUUID(), owner, win, view, shield: undefined, visibility: 'hidden', rect: undefined,
      pageSize: options.pageSize ? { width: options.pageSize.width, height: options.pageSize.height } : undefined,
      applied: undefined, shieldOn: false, destroyed: false, chain: Promise.resolve(),
      messages: new Listeners(), detach: new Listeners(), shieldInput: new Listeners(), destroyedL: new Listeners(),
      handle: undefined as unknown as Surface,
    }
    r.handle = this.handleOf(r)
    this.records.set(r.id, r)
    win.add(view)
    this.place(r)
    wc.on('destroyed', () => this.destroy(r))
    // The person's press on the page she holds gives it the keyboard (an embedded child window does not take it by itself).
    wc.on('input-event', (_e, input) => { if (!r.destroyed && focusOnPress(input.type, r.visibility, r.shieldOn)) this.focusPage(r) })
    try {
      // A debugger command sent before the first navigation may never answer: the page starts blank.
      await wc.loadURL('about:blank')
      wc.debugger.attach('1.3')
      wc.debugger.on('message', (_e, method, params, sessionId) => r.messages.fire(method, params, sessionId || undefined))
      wc.debugger.on('detach', (_e, reason) => {
        r.applied = undefined
        if (!r.destroyed) this.deps.log(`superfície ${r.id} (${owner}): depurador solto (${reason})`)
        r.detach.fire(reason)
      })
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      await this.emulate(r, false)
      this.warmUp(r)
      // The owner usually navigates right after create: the first page gets its own warm-up once it has loaded.
      wc.once('did-finish-load', () => this.warmUp(r))
    } catch (e) {
      this.destroy(r)
      throw new Error(`superfície: não abriu (${(e as Error).message})`)
    }
    return r.handle
  }

  private handleOf(r: SurfaceRecord): Surface {
    const run = <T>(fn: () => Promise<T> | T): Promise<T> => {
      const next = r.chain.then(() => { if (r.destroyed) throw new Error('superfície destruída'); return fn() })
      r.chain = next.catch(() => {})
      return next
    }
    return {
      id: r.id,
      webContents: r.view.webContents,
      debugger: {
        send: (method, params, sessionId) => {
          if (isCoreDebuggerMethod(method)) return Promise.reject(new Error(`superfície: ${method} é do núcleo (use setPageSize ou reapplyEmulation)`))
          if (r.destroyed) return Promise.reject(new Error('superfície destruída'))
          return r.view.webContents.debugger.sendCommand(method, params, sessionId)
        },
        onMessage: l => r.messages.add(l),
        onDetach: l => r.detach.add(l),
      },
      state: () => this.stateOf(r),
      setRect: rect => run(async () => {
        if (!isRect(rect)) throw new Error('superfície: retângulo inválido')
        r.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        await this.emulate(r, false)
        this.place(r)
        return this.stateOf(r)
      }),
      setVisibility: visibility => run(async () => {
        if (visibility !== 'hidden' && visibility !== 'shown' && visibility !== 'parked') throw new Error('superfície: estado inválido')
        const move = canMove(r.visibility, visibility, r.rect !== undefined)
        if (!move.ok) throw new Error(`superfície: ${move.reason}`)
        const raise = visibility === 'shown' && r.visibility !== 'shown'
        const hiding = visibility === 'hidden'
        r.visibility = visibility
        // Shrink before the scale goes back to 1, grow after it took the fitted one: the view never shows the page cropped.
        if (hiding) this.place(r)
        await this.emulate(r, false)
        if (raise) this.raise(r)
        if (!hiding) this.place(r)
        return this.stateOf(r)
      }),
      setPageSize: size => run(async () => {
        if (size !== null && !isPageSize(size)) throw new Error('superfície: pageSize inválido')
        r.pageSize = size ? { width: size.width, height: size.height } : undefined
        await this.emulate(r, true)
        this.place(r)
        return this.stateOf(r)
      }),
      reapplyEmulation: () => run(() => this.emulate(r, true)),
      raise: () => { if (!r.destroyed) this.raise(r) },
      setInputShield: on => run(async () => {
        if (on && !r.shield) r.shield = await this.makeShield(r)
        r.shieldOn = on
        this.place(r)
        if (on) { if (r.visibility === 'shown' && !r.win.destroyed()) r.win.focusInterface() }
        else if (r.visibility === 'shown') r.view.webContents.focus()
      }),
      onShieldInput: l => r.shieldInput.add(l),
      capture: () => run(() => this.capture(r)),
      whileDrawing: fn => this.whileDrawing(r, fn),
      destroy: () => this.destroy(r),
      onDidDestroy: l => r.destroyedL.add(l),
    }
  }

  /** The keyboard on the page: the stage's window first (an embedded one is never focused by Windows), then the page in it. */
  private focusPage(r: SurfaceRecord): void {
    if (r.win.destroyed()) return
    try { r.win.focusSurface?.() } catch { /* the stage's window is going away */ }
    const wc = r.view.webContents
    if (!wc.isDestroyed() && !wc.isFocused()) wc.focus()
  }

  private fit(r: SurfaceRecord): { rect: Rect; scale: number } | undefined {
    return r.rect ? fitRect(r.rect, r.pageSize) : undefined
  }

  /**
   * The scale the page is drawn at: the fit while shown or parked (parked keeps the shown size, so the move back is a shift);
   * 1 while hidden (the 1×1 view of the bench, whose capture then gives the whole page at full size).
   */
  private drawScale(r: SurfaceRecord): number {
    return r.visibility === 'hidden' ? 1 : this.fit(r)?.scale ?? 1
  }

  private stateOf(r: SurfaceRecord): SurfaceState {
    const fit = this.fit(r)
    return {
      id: r.id, visibility: r.visibility, rect: r.rect ? { ...r.rect } : undefined, effective: fit?.rect,
      scale: fit?.scale ?? 1, pageSize: r.pageSize ? { ...r.pageSize } : undefined, shield: r.shieldOn, destroyed: r.destroyed,
    }
  }

  /**
   * Keeps the override in force at the current scale (the shown one; 1 before any rectangle). Chromium ignores an override equal
   * to the one in force, so `force` clears it first (after a clipped screenshot reset it, or an owner's client left).
   */
  private async emulate(r: SurfaceRecord, force: boolean): Promise<void> {
    const dbg = r.view.webContents.debugger
    if (!dbg.isAttached()) return
    if (!r.pageSize) {
      if (r.applied !== undefined) await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
      r.applied = undefined
      return
    }
    const scale = this.drawScale(r)
    if (!force && r.applied === scale) return
    if (force) {
      await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    }
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', metricsOverride(r.pageSize, scale))
    r.applied = scale
  }

  /** The view's bounds for its state; the shield follows (visible only over a shown surface). */
  private place(r: SurfaceRecord): void {
    if (r.destroyed || r.win.destroyed()) return
    const content = r.win.contentSize()
    const fit = this.fit(r)
    const bounds = r.visibility === 'shown' && fit ? fit.rect
      : r.visibility === 'parked' && fit ? parkedBounds(content, fit.rect)
      : hiddenBounds(content)
    r.win.setBounds(r.view, bounds)
    if (r.shield) {
      const visible = shieldVisible(r.visibility, r.shieldOn)
      if (visible) r.win.setBounds(r.shield.view, bounds)
      r.win.setVisible(r.shield.view, visible)
    }
  }

  /** Re-adding a child view puts it on top: the surface, then its shield right above it. */
  private raise(r: SurfaceRecord): void {
    if (r.win.destroyed()) return
    r.win.add(r.view)
    if (r.shield) r.win.add(r.shield.view)
  }

  private async makeShield(r: SurfaceRecord): Promise<Shield> {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(this.deps.dist, 'surface-shield.cjs'),
        // An in-memory session of its own: the shield shares nothing with the page or the app.
        partition: 'surface-shield',
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, navigateOnDragDrop: false,
      },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const wc = view.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', e => e.preventDefault())
    r.win.add(view)
    await wc.loadURL(SHIELD_PAGE)
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (r.destroyed) { this.closeView(r.win, view); throw new Error('superfície destruída') }
    return { view }
  }

  private onShield(event: IpcMainEvent, raw: unknown): void {
    const r = [...this.records.values()].find(x => x.shield?.view.webContents.id === event.sender.id)
    if (!r || !r.shieldOn || r.visibility !== 'shown' || !raw || typeof raw !== 'object') return
    const a = raw as Record<string, unknown>
    const kind = a.kind
    if (kind !== 'down' && kind !== 'move' && kind !== 'wheel' && kind !== 'key') return
    const x = num(a.x), y = num(a.y)
    if (x === undefined || y === undefined) return
    const at = r.win.getBounds(r.shield!.view)
    const input: SurfaceShieldInput = { kind, x: at.x + x, y: at.y + y }
    if (num(a.button) !== undefined) input.button = num(a.button)
    if (kind === 'wheel') { input.deltaX = num(a.deltaX) ?? 0; input.deltaY = num(a.deltaY) ?? 0 }
    if (kind === 'key') { input.key = str(a.key); input.code = str(a.code) }
    r.shieldInput.fire(input)
  }

  /**
   * The page as it is now. capturePage gives the whole page at its drawn scale in every state (hidden draws at scale 1, so the
   * 1×1 view still captures the full page); a debugger screenshot (unclipped: a clip would reset the scale) covers the case
   * where it comes back empty.
   */
  private async capture(r: SurfaceRecord): Promise<NativeImage> {
    const wc = r.view.webContents
    const img = await wc.capturePage()
    const size = img.getSize()
    if (!img.isEmpty() && size.width > 1 && size.height > 1) return img
    if (!wc.debugger.isAttached()) return img
    const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }) as { data?: string }
    return shot.data ? nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')) : img
  }

  /**
   * `fn` with the hidden page drawing. The hidden 1×1 view draws no new frame, so a debugger screenshot waits forever (E6: with
   * a second tab no form of `Page.captureScreenshot` answered); a `capturePage` in flight counts as a capturer and makes the page
   * draw without changing its bounds (E6b probe: with one running alongside, the full-page screenshot answered in ~300 ms).
   * So captures are pumped, one after the other, until `fn` settles. Outside the surface's chain: `fn` may use it.
   */
  private async whileDrawing<T>(r: SurfaceRecord, fn: () => Promise<T>): Promise<T> {
    const wc = r.view.webContents
    let done = false
    const pump = (async () => {
      while (!done && !r.destroyed && !wc.isDestroyed()) {
        if (r.visibility === 'hidden') { try { await wc.capturePage() } catch { return } }
        await new Promise(res => setTimeout(res, 50))
      }
    })()
    try { return await fn() } finally { done = true; await pump }
  }

  /**
   * A throwaway capture (design §12b rule 8). On the bench the first freeze of each process showed a wrong picture (the page's
   * background with no content) for ~300 ms; the likely cause is the view's first copy request being served from a frame the
   * compositor produced before the content was laid out, but it was not proven. Spending that first capture here, where
   * nobody sees it, keeps the person's first freeze clean.
   */
  private warmUp(r: SurfaceRecord): void {
    if (r.destroyed) return
    const next = r.chain.then(() => (r.destroyed ? undefined : r.view.webContents.capturePage()))
    r.chain = next.catch(() => {})
  }

  private closeView(win: SurfaceStage, view: WebContentsView): void {
    if (!win.destroyed()) { try { win.remove(view) } catch { /* already gone */ } }
    const wc = view.webContents
    if (wc.isDestroyed()) return
    try { if (wc.debugger.isAttached()) wc.debugger.detach() } catch { /* closing anyway */ }
    wc.close()
  }

  private destroy(r: SurfaceRecord): void {
    if (r.destroyed) return
    r.destroyed = true
    this.records.delete(r.id)
    if (r.shield) this.closeView(r.win, r.shield.view)
    this.closeView(r.win, r.view)
    try { r.win.release?.() } catch { /* the stage's window is gone already */ }
    r.destroyedL.fire()
    for (const l of [r.messages, r.detach, r.shieldInput, r.destroyedL]) l.clear()
  }
}
