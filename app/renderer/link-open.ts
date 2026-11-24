// The single opener of a followed link, for every surface (terminal, note editor, markdown preview). The surfaces
// detect and classify through app/shared/links.ts and call openLink; what "opening" means is registered once by the
// app's core (main.ts): the browser for http(s), the Explorer for a folder, a file the way Ctrl+P opens it.
import { followLinkTip, isFollowModifier, type LinkTarget } from '../shared/links.ts'

export const IS_MAC = /Macintosh/.test(navigator.userAgent)
export const FOLLOW_LINK_TIP = followLinkTip(IS_MAC)
export const isModifierDown = (ev: MouseEvent | KeyboardEvent): boolean => isFollowModifier(ev, IS_MAC)

/** Where the link was followed: the pane it came from and the folder a relative path was read against. */
export interface LinkOrigin {
  slotId?: string
  baseDir?: string
  /** Open a file or a note beside the reference pane instead of in it ("Abrir ao lado"). */
  side?: boolean
  /** A link to a pane peeks at it (Alt+click, "Espiar") instead of going to its tab. */
  peek?: boolean
}

/** Whether the peek modifier is down: Alt (Option on macOS), alone (Ctrl or Cmd with it is the follow gesture). */
export const isPeekModifier = (ev: MouseEvent | KeyboardEvent): boolean => ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey

type LinkHandler = (target: LinkTarget, origin: LinkOrigin) => void

let handler: LinkHandler | undefined

/** The core registers what opening a link means (once, at startup). */
export function setLinkHandler(fn: LinkHandler): void {
  handler = fn
}

/** Follows a link. An anchor is the surface's own business (the preview scrolls); `ignore` does nothing. */
export function openLink(target: LinkTarget, origin: LinkOrigin = {}): void {
  if (target.kind === 'ignore' || target.kind === 'anchor') return
  if (!handler) { console.warn('links: no handler registered'); return }
  handler(target, origin)
}
