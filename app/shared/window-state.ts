// The window's remembered state (<TETHER_HOME>/settings.json `window`): maximized / fullscreen and the last NORMAL
// bounds. Pure and free of Electron so the unit tests can run it; app/main/main.ts feeds it the displays.

export interface Rect { x: number; y: number; width: number; height: number }

export interface WindowState extends Rect {
  maximized: boolean
  fullscreen: boolean
}

export const DEFAULT_WINDOW_SIZE = { width: 1400, height: 900 }
/** Smallest window worth restoring; anything smaller is a corrupt file, not a choice. */
export const MIN_WINDOW_SIZE = { width: 400, height: 300 }
/** How much of the window must lie on a display for the person to grab its title bar. */
const MIN_VISIBLE = { width: 120, height: 60 }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The stored value, or undefined when it is missing or malformed (first run, hand-edited file). */
export function normalizeWindowState(raw: unknown): WindowState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return undefined
  if (r.width < MIN_WINDOW_SIZE.width || r.height < MIN_WINDOW_SIZE.height) return undefined
  return {
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
    maximized: r.maximized === true,
    fullscreen: r.fullscreen === true,
  }
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

/** Whether enough of `rect` is inside some work area to be reachable. */
export function isReachable(rect: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some(w => {
    const o = overlap(rect, w)
    return o.width >= Math.min(MIN_VISIBLE.width, rect.width) && o.height >= Math.min(MIN_VISIBLE.height, rect.height)
  })
}

export interface ResolvedWindow {
  /** x/y absent = let the OS place it (first run: the historical behavior). */
  bounds: { x?: number; y?: number; width: number; height: number }
  maximized: boolean
  fullscreen: boolean
}

/**
 * What to create the window with. No (valid) saved state = the default size, OS-placed. Saved bounds that no longer
 * touch any display (monitor unplugged) = the default size centered on the primary display's work area; the
 * maximized / fullscreen flags are kept either way.
 */
export function resolveWindowState(saved: WindowState | undefined, workAreas: readonly Rect[], primary: Rect): ResolvedWindow {
  if (!saved) return { bounds: { ...DEFAULT_WINDOW_SIZE }, maximized: false, fullscreen: false }
  const { maximized, fullscreen } = saved
  if (isReachable(saved, workAreas)) {
    return { bounds: { x: saved.x, y: saved.y, width: saved.width, height: saved.height }, maximized, fullscreen }
  }
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, primary.width)
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, primary.height)
  return {
    bounds: { x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2), width, height },
    maximized,
    fullscreen,
  }
}
