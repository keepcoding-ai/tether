// The one place that decides what a clickable link is, for every surface of the app (terminal, note editor, markdown
// preview). Each surface only adapts its own technology (xterm's link provider, Monaco's link provider and opener, the
// preview's <a>) and hands a LinkTarget to the single opener (app/renderer/link-open.ts). A change to links made here —
// a new kind of target, a detection rule, the tip, which schemes go out — reaches every surface at once.
// Pure: no DOM, no disk (unit-tested in test/unit/app.links.test.ts).
import type { LineColumn } from './file-open.ts'
import { parseTetherUrl } from './tether-url.ts'

/** Where a followed link goes. */
export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'file'; path: string; isDirectory?: boolean; position?: LineColumn }
  /** A place in the app (app/shared/tether-url.ts): a pane anywhere, or a note. */
  | { kind: 'tether'; url: string }
  | { kind: 'ignore' }

/** Whether a URL may leave the app for the system browser: http(s) only (javascript:, file:, mailto:… never). */
export function isExternalUrl(url: string): boolean {
  return /^https?:\/\/[^\s/?#]+/i.test(url.trim())
}

/** A link found in a piece of text: [start, end) string indices. */
export interface TextLink { start: number; end: number; url: string }

// The web-link rule of @xterm/addon-web-links: a URL never ends on punctuation that usually closes the sentence around it.
const URL_LINK = /(?:https?|tether):\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi

/** What following a URL means: http(s) to the browser, a valid tether:// link to that place in the app, anything else nothing. */
export function linkTargetOfUrl(url: string): LinkTarget {
  if (isExternalUrl(url)) return { kind: 'external', url }
  if (parseTetherUrl(url)) return { kind: 'tether', url }
  return { kind: 'ignore' }
}

/** The URLs written in `text` that lead somewhere: http(s) and tether:// links. */
export function detectUrlLinks(text: string): TextLink[] {
  const out: TextLink[] = []
  for (const m of text.matchAll(URL_LINK)) {
    if (linkTargetOfUrl(m[0]).kind !== 'ignore') out.push({ start: m.index, end: m.index + m[0].length, url: m[0] })
  }
  return out
}

/** The tip over a link, the same on every surface ("Follow link (ctrl + click)" of VS Code). */
export function followLinkTip(mac: boolean): string {
  return `Seguir link (${mac ? 'Cmd' : 'Ctrl'} + clique)`
}

/** Whether the follow modifier is down: Ctrl, or Cmd on macOS. Every surface follows a link only with it. */
export function isFollowModifier(ev: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return mac ? ev.metaKey : ev.ctrlKey
}

/** `L12` / `L12,5` for a position (the fragment a file link carries through a URI). */
export function positionFragment(position: LineColumn | undefined): string {
  if (!position) return ''
  return position.column !== undefined ? `L${position.line},${position.column}` : `L${position.line}`
}

/** The position back from `L12` / `L12,5` (also `L12C5`); undefined for anything else. */
export function parsePositionFragment(fragment: string): LineColumn | undefined {
  const m = /^L(\d+)(?:[,C](\d+))?$/i.exec(fragment.trim())
  if (!m) return undefined
  const line = Number(m[1])
  if (line < 1) return undefined
  return m[2] !== undefined ? { line, column: Number(m[2]) } : { line }
}
