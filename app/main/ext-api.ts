// `TetherMain`: what Electron main offers an extension's `activate` (F9 §3.3). It grows per slice; slice 0b has the
// identity, the folders, the IPC bus (ext:<id>:<channel>), the extension's settings, the window and the log. Every
// registration returns a disposable (app/shared/vscode-lifecycle.ts).
import type { BrowserWindow, NativeImage, WebContents } from 'electron'
import type { ChannelMap, MainIpc } from '../shared/ext-ipc.ts'
import type { SettingValue } from '../shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { Brand } from '../shared/brand.ts'
import type { Rect, Size, Visibility } from './surface-rules.ts'
import type { MainAgents } from './agents.ts'

export type { Brand } from '../shared/brand.ts'
export type { Rect, Size, Visibility } from './surface-rules.ts'
export type { AgentExit, AgentExitReason, AgentInfo, MainAgents } from './agents.ts'

export type { IDisposable as Disposable } from '../shared/vscode-lifecycle.ts'

/** One extension's settings (`extensions.<id>.<key>` of settings.json), normalized by its manifest's schema. */
export interface ExtSettings {
  get<T extends SettingValue>(key: string): T | undefined
  set(key: string, value: SettingValue): void
  onChange(key: string, listener: (value: SettingValue) => void): IDisposable
}

/**
 * VS Code's Memento (ExtensionContext.globalState): what an extension remembers that is not a setting (no schema, any
 * JSON). Stored in settings.json under `extensionState.<id>.<key>`, written at once.
 */
export interface ExtState {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): void
}

/** One attempt of the person on a surface's input shield, in window coordinates (DIP of the window's content area). */
export interface SurfaceShieldInput {
  kind: 'down' | 'move' | 'wheel' | 'key'
  x: number
  y: number
  button?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
}

/** Where a surface is and how it is drawn (app/main/surfaces.ts). */
export interface SurfaceState {
  id: string
  visibility: Visibility
  /** The rectangle last asked by setRect (window coordinates), if any. */
  rect: Rect | undefined
  /** Where the view is when shown: the page fitted and centred in `rect` (equal to `rect` without a page size). */
  effective: Rect | undefined
  /** Page px → view px. Under a fixed page size, CDP input coordinates in page px must be multiplied by it. */
  scale: number
  pageSize: Size | undefined
  shield: boolean
  destroyed: boolean
}

/**
 * The surface's debugger, shared by the core and its owner (Electron has one debugger per webContents). The core attaches it
 * at creation and keeps the emulation methods to itself while a page size is set (`send` rejects them).
 */
export interface SurfaceDebugger {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: (method: string, params: unknown, sessionId: string | undefined) => void): IDisposable
  onDetach(listener: (reason: string) => void): IDisposable
}

/** A native view (WebContentsView) over the app's interface, owned by the extension that created it. */
export interface Surface {
  readonly id: string
  /** The page's webContents: navigation, events (`debugger` goes through `surface.debugger`, never webContents.debugger). */
  readonly webContents: WebContents
  readonly debugger: SurfaceDebugger
  state(): SurfaceState
  /** The rectangle the surface takes when shown, in window px; with a page size the view is the page fitted in it (never enlarged). */
  setRect(rect: Rect): Promise<SurfaceState>
  /** hidden ↔ shown ↔ parked, without recreating the view (shown needs a rect; parked only from shown). Showing raises it. */
  setVisibility(visibility: Visibility): Promise<SurfaceState>
  /** Fixed page size (emulated) or null for none. */
  setPageSize(size: Size | null): Promise<SurfaceState>
  /** Clears and re-sends the page-size override (re-sending the same one is ignored): after a clipped screenshot, or when a debugger client of the owner leaves. */
  reapplyEmulation(): Promise<void>
  /** Puts the surface (and its shield) above every other surface. */
  raise(): void
  /** The transparent view over the shown surface that takes the person's input: on keeps keyboard focus on the interface; off hides it and focuses the page. */
  setInputShield(on: boolean): Promise<void>
  onShieldInput(listener: (input: SurfaceShieldInput) => void): IDisposable
  /** The current image of the page (works hidden, shown and parked). */
  capture(): Promise<NativeImage>
  /** Closes the page and lets everything go; also happens when the window closes. */
  destroy(): void
  onDidDestroy(listener: () => void): IDisposable
}

export interface SurfaceOptions {
  /** Owner's preferences: partition or session, and a few harmless switches; Node, sandbox, isolation, preload are locked (app/main/surface-rules.ts). */
  webPreferences?: Record<string, unknown>
  /** Fixed page size, emulated through the debugger (the page always sees it, whatever the rectangle). */
  pageSize?: Size
}

/** The extension's surfaces: only its own are reachable. */
export interface ExtSurfaces {
  /** A new surface on the current window, hidden. Rejects when there is no window or the preferences are refused. */
  create(options?: SurfaceOptions): Promise<Surface>
  get(id: string): Surface | undefined
  list(): Surface[]
}

export interface TetherMain {
  readonly id: string
  /** The product's identity (app/shared/brand.ts). */
  readonly brand: Brand
  /** TETHER_HOME. */
  readonly home: string
  /** The person's own configuration folder (settings.json, keybindings.json): TETHER_USER_DIR, else TETHER_HOME, else ~/.tether. */
  readonly userDir: string
  /** app/dist (workers, assets). */
  readonly dist: string
  /** The extension's channels, typed by its channel map. */
  ipc<C extends ChannelMap>(): MainIpc<C>
  settings: ExtSettings
  state: ExtState
  /**
   * The app window's `<webview>` guests: `guard` installs on every window created from now on (before it loads). With
   * no guard registered the core refuses every webview.
   */
  webviews: { guard(install: (host: WebContents) => void): IDisposable }
  window: { current(): BrowserWindow | undefined }
  /** Native views over the interface (app/main/surfaces.ts). */
  surfaces: ExtSurfaces
  /**
   * The window's AI agents (never plain shells), from the daemon's slot states: `slotId` is the daemon's id, the key shared
   * with the renderer (`TetherUi.agents`). No layout here (desk, drawer, pane): that is the renderer's. `onDidExit` fires when
   * a live agent stops (its process ended, the slot was removed, or the daemon connection was lost).
   */
  agents: MainAgents
  /** The operating system's file shell. `trash` moves a file or folder to the system's trash (Electron's shell.trashItem); it rejects when it cannot. */
  shell: { trash(path: string): Promise<void> }
  /** A line in tether-app.log, prefixed with the extension's id. */
  log(msg: string): void
}
