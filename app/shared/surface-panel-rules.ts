// The pure rules of the bridge between a pane's host element (renderer) and its native surface (main): when the element
// counts as visible, how its CSS-px rectangle becomes the window's DIP one (the interface may be zoomed), and how window
// points and rectangles come back into the element's space. No DOM, no Electron: unit-tested on their own
// (test/unit/app.surface-panel-rules.test.ts); the DOM reading is app/renderer/surface-host.ts, the main side
// app/main/surface-bridge.ts.
import type { Rect } from '../main/surface-rules.ts'

export type { Rect } from '../main/surface-rules.ts'

/** What the renderer reads off a host element to know whether it is on screen. */
export interface HostFacts {
  /** Attached to the document. */
  connected: boolean
  /** Its box, in CSS px. */
  width: number
  height: number
  /** `visibility` computed as visible on the element (a hidden desk layer, a closed drawer or a hidden tab content is not). */
  cssVisible: boolean
  /** Some ancestor (or itself) is `inert`, the way the app marks a desk, drawer or pad that is out of play. */
  inert: boolean
  /** Some ancestor (or itself) is `display:none`-like: it has no layout box. */
  displayed: boolean
}

/** True when the element is really on screen: attached, with a box, visible and not inert. */
export function hostVisible(f: HostFacts): boolean {
  return f.connected && f.displayed && f.cssVisible && !f.inert && f.width > 0 && f.height > 0
}

/**
 * The interface zoom: window content width (DIP, what main knows) over the document's CSS viewport width. Within a thousandth
 * of 1 it is 1 (the usual case, free of float noise); anything unusable is 1.
 */
export function zoomOf(contentWidth: number, viewportWidth: number): number {
  if (!(contentWidth > 0) || !(viewportWidth > 0)) return 1
  const z = contentWidth / viewportWidth
  return Math.abs(z - 1) < 0.002 ? 1 : z
}

/** A CSS-px rectangle (getBoundingClientRect) in window DIP. */
export function cssToWindow(r: Rect, zoom: number): Rect {
  return { x: r.x * zoom, y: r.y * zoom, width: r.width * zoom, height: r.height * zoom }
}

/** A point of the window (DIP) in the host element's CSS px, given the element's window rectangle. */
export function windowToElement(p: { x: number; y: number }, host: Rect, zoom: number): { x: number; y: number } {
  return { x: (p.x - host.x) / zoom, y: (p.y - host.y) / zoom }
}

/** A window rectangle (DIP) in the host element's CSS px (the effective rectangle, to draw the bands around it). */
export function windowRectToElement(r: Rect, host: Rect, zoom: number): Rect {
  return { x: (r.x - host.x) / zoom, y: (r.y - host.y) / zoom, width: r.width / zoom, height: r.height / zoom }
}

/** Same rectangle, within half a CSS px on every side (a layout settling must not flood the channel). */
export function sameRect(a: Rect | undefined, b: Rect | undefined, tolerance = 0.5): boolean {
  if (!a || !b) return a === b
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

/** What the renderer tells main about one attached element. */
export interface PlaceMessage {
  /** The extension that asks (main refuses a surface of another owner). */
  owner: string
  surface: string
  /** The element's box in CSS px, and the document's CSS viewport width (main derives the zoom from it). */
  rect: Rect
  viewportWidth: number
  /** The element is on screen (hostVisible). */
  visible: boolean
}

export interface ReleaseMessage { owner: string; surface: string }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const idText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

/** Validates what came over the channel (it is the renderer's word, not the type's). */
export function parsePlace(raw: unknown): PlaceMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  const r = m.rect as Record<string, unknown> | undefined
  if (!idText(m.owner) || !idText(m.surface) || typeof m.visible !== 'boolean' || !finite(m.viewportWidth) || !r || typeof r !== 'object') return undefined
  if (![r.x, r.y, r.width, r.height].every(finite) || (r.width as number) < 0 || (r.height as number) < 0) return undefined
  return { owner: m.owner, surface: m.surface, visible: m.visible, viewportWidth: m.viewportWidth, rect: { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number } }
}

export function parseRelease(raw: unknown): ReleaseMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  return idText(m.owner) && idText(m.surface) ? { owner: m.owner, surface: m.surface } : undefined
}

/** What main tells the owner's renderer about a surface it holds: where it ended up, and the shield's input. */
export type SurfaceEvent =
  | {
      kind: 'state'
      surface: string
      visibility: 'hidden' | 'shown' | 'parked'
      /** Where the page is drawn, in the host element's CSS px (undefined until a rectangle was placed). */
      effective: Rect | undefined
      scale: number
    }
  | {
      kind: 'shield'
      surface: string
      input: { kind: 'down' | 'move' | 'wheel' | 'key'; x: number; y: number; button?: number; deltaX?: number; deltaY?: number; key?: string; code?: string }
    }
