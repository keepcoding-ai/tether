// The rules of the docked quick view's two sizes and of moving it (peek.ts applies them; no DOM here).
//
// Docked over the Regency's conversation the card has two sizes:
//   docked  the small card at the top right of the conversation (peek-rules.ts dockedBox); it can be dragged by its header
//           to read what is under it, kept inside the Regency, and it never remembers where it was moved to;
//   large   the card the size of the modal one (16 px from the edges of the Regency, 6 px in a small one), still over the
//           conversation and without a veil; it does not move.
// The press on "Ampliar" / "Reduzir" swaps them; nothing else moves the pane's content (the same live element stays in the
// card's body: only the card's box changes). Esc where it closes the docked card reduces the large one first.
// What each tier allows (the Regency tells the card through `quickAbilities`):
//   mobile   the docked card already takes the conversation's width: no "Ampliar", no moving;
//   tablet   "Ampliar" (a tap), no moving (a touch tier: a drag there would fight the scroll);
//   desktop  both;
//   TV       both over the conversation (immersion); in the quick view's own column (manage) the card covers nothing, so it
//            does not move.
// A touch pointer never drags, on any tier.
import { DOCK_MARGIN, quickEscCloses, type Box, type QuickEscPlace } from './peek-rules.ts'

export type QuickSize = 'docked' | 'large'

/** The Regency's tiers (extensions/regency/renderer/layout-rules.ts Tier). */
export type QuickTier = 'mobile' | 'tablet' | 'desktop' | 'wide'

/** What the docked card may do on the tier it is shown on right now. */
export interface QuickAbilities {
  /** The "Ampliar" button exists. */
  expand: boolean
  /** The docked card can be dragged by its header. */
  move: boolean
}

/** What the host of a docked card gives besides its anchor: the area it lives in (the large box, the drag's bounds) and its abilities now. */
export interface QuickFrame {
  area: HTMLElement
  abilities(): QuickAbilities
}

/** `inColumn`: the card sits in the quick view's own column (the TV in manage mode), not over the conversation. */
export function quickAbilities(tier: QuickTier, inColumn: boolean): QuickAbilities {
  if (tier === 'mobile') return { expand: false, move: false }
  if (tier === 'tablet') return { expand: true, move: false }
  return { expand: true, move: !inColumn }
}

/** The size the card shows: a large card on a tier that has no "Ampliar" (the window got narrow) is docked again. */
export function shownSize(size: QuickSize, a: QuickAbilities): QuickSize {
  return size === 'large' && !a.expand ? 'docked' : size
}

/**
 * The size when a pane comes to the card: a new opening starts docked (nothing persists between openings); another pane
 * spied in an open card keeps its size (the large card is the "imersão rápida": it stays large). A drag never carries over.
 */
export function sizeOnShow(size: QuickSize, opening: boolean): QuickSize {
  return opening ? 'docked' : size
}

/** The foot's Esc word for the size shown: the large card reduces, the docked one closes. */
export function escWord(size: QuickSize): string {
  return size === 'large' ? 'Esc reduz' : 'Esc aqui fecha'
}

export function toggledSize(size: QuickSize): QuickSize {
  return size === 'large' ? 'docked' : 'large'
}

/** The header's button for the size shown: what a press does, as label, tooltip and icon. */
export function sizeButton(size: QuickSize): { label: string; title: string; icon: 'arrows-out-simple' | 'arrows-in-simple' } {
  return size === 'large'
    ? { label: 'Reduzir', title: 'Reduzir: o cartão volta ao canto da conversa (Esc)', icon: 'arrows-in-simple' }
    : { label: 'Ampliar', title: 'Ampliar: o cartão fica grande por cima da conversa', icon: 'arrows-out-simple' }
}

/** What an Esc at that place does: nothing (it is the content's, or somewhere else's), reduce the large card, or close. */
export type QuickEscAction = 'none' | 'reduce' | 'close'

export function quickEscAction(modal: boolean, size: QuickSize, at: QuickEscPlace): QuickEscAction {
  if (!quickEscCloses(modal, at)) return 'none'
  return !modal && size === 'large' ? 'reduce' : 'close'
}

/** The large card's margin inside the Regency: the modal card's (16 px; 6 px when the Regency is small, as peek.css does for the window). */
export const LARGE_MARGIN = 16
export const LARGE_MARGIN_SMALL = 6
export const SMALL_WIDTH = 560
export const SMALL_HEIGHT = 420

/** The large card: the Regency's box less the modal card's margin. */
export function largeBox(area: Box): Box {
  const m = area.width <= SMALL_WIDTH || area.height <= SMALL_HEIGHT ? LARGE_MARGIN_SMALL : LARGE_MARGIN
  return {
    left: Math.round(area.left + m),
    top: Math.round(area.top + m),
    width: Math.max(0, Math.round(area.width - 2 * m)),
    height: Math.max(0, Math.round(area.height - 2 * m)),
  }
}

/** How far (px) a press on the header must travel before it is a drag: under it, it stays a click on what was pressed. */
export const DRAG_THRESHOLD = 5

export function dragStarted(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD
}

export interface DragPress {
  size: QuickSize
  abilities: QuickAbilities
  /** PointerEvent.pointerType ('mouse', 'pen', 'touch'). */
  pointerType: string
  /** PointerEvent.button (0 = the main one). */
  button: number
}

/** Whether a press on the header may become a drag: the docked card, a tier that moves it, the main button of a mouse or a pen. */
export function dragAllowed(p: DragPress): boolean {
  return p.size === 'docked' && p.abilities.move && p.pointerType !== 'touch' && p.button === 0
}

export interface Offset { x: number; y: number }

export const NO_OFFSET: Offset = { x: 0, y: 0 }

/**
 * The card's displacement from its place (`base`, the docked box) kept so the whole card stays inside `area` (the Regency),
 * with the docked card's own margin. A card larger than the area keeps its top left in it.
 */
export function clampOffset(base: Box, offset: Offset, area: Box): Offset {
  const m = DOCK_MARGIN
  const minX = area.left + m - base.left
  const maxX = area.left + area.width - m - (base.left + base.width)
  const minY = area.top + m - base.top
  const maxY = area.top + area.height - m - (base.top + base.height)
  const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)))
  return { x: Math.round(clamp(offset.x, minX, maxX)), y: Math.round(clamp(offset.y, minY, maxY)) }
}

/** The box the card gets: large, or docked moved by the offset (kept inside the area). */
export function quickBox(size: QuickSize, docked: Box, area: Box, offset: Offset): Box {
  if (size === 'large') return largeBox(area)
  const o = clampOffset(docked, offset, area)
  return { left: docked.left + o.x, top: docked.top + o.y, width: docked.width, height: docked.height }
}
