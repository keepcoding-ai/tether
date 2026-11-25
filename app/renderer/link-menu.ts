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

/**
 * The web-bridge extension's way to open an http(s) address in the browser the Bridge has connected: `browser()` names it
 * (synchronously, from the extension's last status) or is undefined when none is connected; `open` hands the address over.
 */
export interface BridgeOpener { browser(): string | undefined; open(url: string): void }

let bridge: BridgeOpener | undefined

/** The web-bridge extension registers its opener while it is on; disposing withdraws it (the row leaves the menu). */
export function setBridgeOpener(next: BridgeOpener): { dispose(): void } {
  bridge = next
  return { dispose: () => { if (bridge === next) bridge = undefined } }
}

/** The opener in force, if the web-bridge extension is on. */
export const bridgeOpener = (): BridgeOpener | undefined => bridge

/**
 * The browser extension's way to open an http(s) address in a tab of the person's own: `side` false brings it to the front in
 * the Browser desk; `side` true opens it in the group of `originPane`, beside the pane the link was clicked in.
 */
export interface BrowserOpener { open(url: string, opts: { side: boolean; originPane?: string }): void }

let browserOpener: BrowserOpener | undefined

/** The browser extension registers its opener while it is on; disposing withdraws it (the two rows leave the menu). */
export function setBrowserOpener(next: BrowserOpener): { dispose(): void } {
  browserOpener = next
  return { dispose: () => { if (browserOpener === next) browserOpener = undefined } }
}

/** The tether browser's opener in force, if the browser extension is on. */
export const tetherBrowserOpener = (): BrowserOpener | undefined => browserOpener

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
