// The one tab header every pane kind uses (terminal, note, preview, empty, extensions, disabled, browser): the same row of
// `.kind` icon · `.text` title (ellipsis) · `.ext-emblems` (extensions' emblems) · emblems · status dot · `.close` ×, the same height and spacing, and the same
// pointer rules (the × does not start a dockview drag; right-click opens the pane menu; double-click is the caller's).
import { icon } from './icons.ts'

export interface TabHeaderOptions {
  /** Extra classes after `tether-tab` (e.g. 'note', 'empty', 'br-web-tab'). */
  className?: string
  /** The Phosphor glyph inside `.kind`; omit to fill `.kind` yourself (a favicon). */
  glyph?: string
  /** Nodes placed inside `.kind` (instead of, or after, the glyph). */
  kindChildren?: Element[]
  /** Extra classes on the title span (besides `text`). */
  textClass?: string
  /** Emblems after the title, in order (shield, ronda, owner badge, attention seal...). */
  emblems?: HTMLElement[]
  /** The status dot, placed after the emblems. */
  dot?: HTMLElement
  /** The ×: its label (tooltip and aria-label) and action. Omit for a tab without ×. */
  close?: { label: string; aria?: string; onClose: () => void }
  /** Right-click on the tab. */
  onMenu?: (ev: MouseEvent) => void
  /** Double-click on the tab (rename). */
  onDblClick?: () => void
}

export interface TabHeader {
  readonly element: HTMLElement
  readonly kind: HTMLElement
  readonly text: HTMLElement
  /**
   * The extensions' emblems (TetherUi.panes.setEmblem), on the right just before the state emblems; the core fills it. Hidden
   * while empty, so a tab without extension emblems keeps today's spacing.
   */
  readonly extEmblems: HTMLElement
  readonly close: HTMLButtonElement | undefined
}

export function createTabHeader(o: TabHeaderOptions): TabHeader {
  const element = document.createElement('div')
  element.className = o.className ? `tether-tab ${o.className}` : 'tether-tab'
  const kind = document.createElement('span'); kind.className = 'kind'
  if (o.glyph) kind.append(icon(o.glyph))
  if (o.kindChildren) kind.append(...o.kindChildren)
  const text = document.createElement('span'); text.className = o.textClass ? `text ${o.textClass}` : 'text'
  const extEmblems = document.createElement('span'); extEmblems.className = 'ext-emblems'; extEmblems.hidden = true
  element.append(kind, text, extEmblems, ...(o.emblems ?? []))
  if (o.dot) element.append(o.dot)
  let close: HTMLButtonElement | undefined
  if (o.close) {
    const c = o.close
    close = document.createElement('button')
    close.className = 'close'; close.title = c.label; close.setAttribute('aria-label', c.aria ?? c.label)
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); c.onClose() })
    element.append(close)
  }
  if (o.onMenu) { const m = o.onMenu; element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); m(ev) }) }
  if (o.onDblClick) { const d = o.onDblClick; element.addEventListener('dblclick', ev => { ev.preventDefault(); ev.stopPropagation(); d() }) }
  return { element, kind, text, extEmblems, close }
}
