// The pure rules of the native surfaces (app/main/surfaces.ts): fitting a fixed-size page into a rectangle, where a hidden or
// parked view sits, which visibility moves are allowed, which web preferences an owner may set, and which debugger methods
// the core keeps to itself. No Electron import: unit-tested on their own (test/unit/app.surface-rules.test.ts).

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/**
 * Where a surface is:
 *   hidden  1×1 px in the window's corner; the page stays alive at its fixed size with emulated focus (the initial state, and
 *           the state of an inactive desk or tab);
 *   shown   in its rectangle;
 *   parked  full size with a single pixel inside the window (frozen behind an image: moving back is a shift, not a resize,
 *           so no empty frame shows).
 */
export type Visibility = 'hidden' | 'shown' | 'parked'

const MAX_PAGE_SIDE = 8192

/** True for a positive integer page size no larger than the limit. */
export function isPageSize(v: unknown): v is Size {
  if (!v || typeof v !== 'object') return false
  const { width, height } = v as Record<string, unknown>
  return [width, height].every(n => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_PAGE_SIDE)
}

/** True for a rectangle of finite numbers with no negative side. */
export function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== 'object') return false
  const { x, y, width, height } = v as Record<string, unknown>
  return [x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) && (width as number) >= 0 && (height as number) >= 0
}

/** Electron view bounds are integers. */
function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) }
}

export interface Fit {
  /** The view's bounds: the page at scale `scale`, centred in the requested rectangle (the bands show the interface). */
  rect: Rect
  /** min(1, min(w/W, h/H)): never enlarges. Exact (not rounded): an owner multiplies input coordinates by it. */
  scale: number
}

/**
 * A page of fixed size `page` in the rectangle `want`: scale s = min(1, min(w/W, h/H)), view = W·s × H·s centred in `want`.
 * Without a page size the view takes the rectangle as it is (scale 1).
 */
export function fitRect(want: Rect, page: Size | undefined): Fit {
  if (!page) return { rect: roundRect(want), scale: 1 }
  const fit = Math.min(want.width / page.width, want.height / page.height)
  const scale = Math.max(0, Math.min(1, fit))
  const width = Math.round(page.width * scale)
  const height = Math.round(page.height * scale)
  return { rect: { x: Math.round(want.x + (want.width - width) / 2), y: Math.round(want.y + (want.height - height) / 2), width, height }, scale }
}

/** The hidden view: 1×1 px in the bottom-right corner of the window's content area. */
export function hiddenBounds(content: Size): Rect {
  return { x: Math.max(0, content.width - 1), y: Math.max(0, content.height - 1), width: 1, height: 1 }
}

/** The parked view: its full shown size, with only its top-left pixel inside the window's content area. */
export function parkedBounds(content: Size, size: Size): Rect {
  return { x: Math.max(0, content.width - 1), y: Math.max(0, content.height - 1), width: Math.max(1, size.width), height: Math.max(1, size.height) }
}

export type Move = { ok: true } | { ok: false; reason: string }

/**
 * Whether a surface may go from `from` to `to`. Showing needs a rectangle; parking is for a surface that is on screen (or
 * already parked), so a hidden one cannot be parked; staying where it is is always allowed.
 */
export function canMove(from: Visibility, to: Visibility, hasRect: boolean): Move {
  if (from === to) return { ok: true }
  if (to === 'shown' && !hasRect) return { ok: false, reason: 'sem retângulo: chame setRect antes de mostrar' }
  if (to === 'parked' && from === 'hidden') return { ok: false, reason: 'só uma superfície mostrada pode estacionar' }
  return { ok: true }
}

/** Whether the shield (when on) is visible: only over a shown surface. */
export function shieldVisible(visibility: Visibility, shieldOn: boolean): boolean {
  return shieldOn && visibility === 'shown'
}

/**
 * What a surface's page always gets, whatever its owner asks: no Node anywhere, its own isolated world, the OS sandbox, web
 * security on, no `<webview>`, no experimental features, no navigation by dropping a file. (Preload and the like are in NEVER.)
 */
export const LOCKED_PREFERENCES = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  enableWebSQL: false,
} as const

/** What an owner may choose (each with its expected type); `session` is an Electron Session, passed through as is. */
const OPEN_PREFERENCES: Record<string, 'string' | 'boolean' | 'object'> = {
  partition: 'string',
  session: 'object',
  backgroundThrottling: 'boolean',
  spellcheck: 'boolean',
  javascript: 'boolean',
  images: 'boolean',
  autoplayPolicy: 'string',
  defaultEncoding: 'string',
  disableDialogs: 'boolean',
  safeDialogs: 'boolean',
  disableHtmlFullscreenWindowResize: 'boolean',
}

/** Preferences an owner can never pass, not even with a harmless value. */
const NEVER = new Set(['preload', 'preloadURL', 'additionalArguments', 'enableBlinkFeatures', 'disableBlinkFeatures', 'devTools', 'offscreen', 'transparent'])

export type Preferences = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string }

/**
 * An owner's web preferences → the ones the view is created with. A locked key is accepted only with its locked value; a key
 * that is neither locked nor open, or of the wrong type, is refused (outright, never silently dropped: the owner learns at
 * once). `partition` and `session` are exclusive.
 */
export function surfacePreferences(asked: unknown): Preferences {
  if (asked !== undefined && (asked === null || typeof asked !== 'object' || Array.isArray(asked))) return { ok: false, reason: 'webPreferences deve ser um objeto' }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((asked ?? {}) as Record<string, unknown>)) {
    if (value === undefined) continue
    if (NEVER.has(key)) return { ok: false, reason: `webPreferences.${key} não é permitido` }
    if (Object.hasOwn(LOCKED_PREFERENCES, key)) {
      const locked = LOCKED_PREFERENCES[key as keyof typeof LOCKED_PREFERENCES]
      if (value !== locked) return { ok: false, reason: `webPreferences.${key} é fixo em ${String(locked)}` }
      continue
    }
    const type = Object.hasOwn(OPEN_PREFERENCES, key) ? OPEN_PREFERENCES[key] : undefined
    if (!type) return { ok: false, reason: `webPreferences.${key} não é conhecido` }
    if (typeof value !== type || value === null) return { ok: false, reason: `webPreferences.${key} deve ser ${type}` }
    out[key] = value
  }
  if (out.partition !== undefined && out.session !== undefined) return { ok: false, reason: 'webPreferences: use partition ou session, não os dois' }
  if (typeof out.partition === 'string' && !/^(persist:)?[\w.-]{1,100}$/.test(out.partition)) return { ok: false, reason: 'webPreferences.partition inválido' }
  return { ok: true, value: { ...out, ...LOCKED_PREFERENCES } }
}

/**
 * Debugger methods a fixed-size surface keeps to itself: the owner sending them would break the scale or the emulated focus.
 * It calls `reapplyEmulation()` or `setPageSize()` instead.
 */
const CORE_METHODS = new Set(['Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled', 'Emulation.setVisibleSize'])
export function isCoreDebuggerMethod(method: string): boolean {
  return CORE_METHODS.has(method)
}

/** The override that keeps a page at `page`, drawn at `scale`. */
export function metricsOverride(page: Size, scale: number): Record<string, unknown> {
  return { width: page.width, height: page.height, deviceScaleFactor: 1, mobile: false, scale }
}
