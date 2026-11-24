// The right-click menu of a link, for every surface (terminal, markdown preview, channel). The surfaces only detect the link
// and call showLinkMenu; the rows come from link-menu-rules.ts and the core (main.ts) registers how they are drawn.
import type { LinkTarget } from '../shared/links.ts'
import { type LinkOrigin } from './link-open.ts'

type LinkMenuHandler = (x: number, y: number, target: LinkTarget, origin: LinkOrigin) => void

let handler: LinkMenuHandler | undefined

/** One row of a link's menu as a surface that draws its own menu (the note editor's) takes it: the label, the key hint, what it does. */
export type LinkMenuAct = 'sep' | { label: string; hint?: string; run(): void }
type LinkMenuRowsProvider = (target: LinkTarget, origin: LinkOrigin) => LinkMenuAct[]

let rowsProvider: LinkMenuRowsProvider | undefined

/** The core registers how the rows of a link's menu are built (once, at startup; the same rows its own menu shows). */
export function setLinkMenuRowsProvider(fn: LinkMenuRowsProvider): void {
  rowsProvider = fn
}

/** The rows of a link's menu, for a surface that merges them into a menu of its own; empty when the link has none. */
export function linkMenuRows(target: LinkTarget, origin: LinkOrigin = {}): LinkMenuAct[] {
  if (target.kind === 'ignore' || target.kind === 'anchor') return []
  return rowsProvider ? rowsProvider(target, origin) : []
}

/** The core registers how the menu is shown (once, at startup). */
export function setLinkMenuHandler(fn: LinkMenuHandler): void {
  handler = fn
}

/** Opens the menu of a link at page coordinates. Returns false when the link has no menu (an anchor, an ignored link). */
export function showLinkMenu(x: number, y: number, target: LinkTarget, origin: LinkOrigin = {}): boolean {
  if (target.kind === 'ignore' || target.kind === 'anchor') return false
  if (!handler) { console.warn('links: no menu handler registered'); return false }
  handler(x, y, target, origin)
  return true
}
