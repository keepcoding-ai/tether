// The extensions' marks on a pane: emblems on its tab (TetherUi.panes.setEmblem / setEmblems), a thin line under its tab
// (setTabLine), and a line in its status bar (setHeadItem). The first half of each is pure: who put which mark on which pane,
// stable order (by extension id), everything goes with its extension. The second half is the DOM: it fills the `.ext-emblems`
// container of every tab header (tab-header.ts), the line of the tab, and the `.ext-head` of every terminal panel's status bar
// (panel.ts) from the boards. A tab header is one for every pane kind, and a pane that changes desk gets a new tab element, so
// the painters watch the page for tabs and panels instead of asking each pane kind to call in: one that appears is painted at once.
import type { PaneHeadItem, TabEmblem } from '../ext-api.ts'
import { normalizeHue } from './desk-seal-rules.ts'

/** How many emblems one extension may put on one pane; more are dropped (the tab has little room). */
export const MAX_TAB_EMBLEMS = 3

/** An emblem as the tab draws it, with who put it. */
export interface PlacedEmblem { ext: string; emblem: TabEmblem }

/** The first character of a label (a whole code point), or '' when there is none. */
function letterOf(label: unknown): string {
  if (typeof label !== 'string') return ''
  return Array.from(label.trim())[0] ?? ''
}

/**
 * The emblem as kept: a named icon (or a one-letter label in its place), a whole hue, the tooltip trimmed, `variant` only when
 * 'struck'; the click stays as given. Undefined when there is nothing to draw.
 */
export function normalizeEmblem(emblem: TabEmblem | undefined): TabEmblem | undefined {
  if (!emblem) return undefined
  const icon = typeof emblem.icon === 'string' ? emblem.icon : ''
  const label = letterOf(emblem.label)
  if (icon === '' && label === '') return undefined
  const hue = normalizeHue(emblem.hue)
  return {
    icon,
    ...(hue === undefined ? {} : { hue }),
    tooltip: typeof emblem.tooltip === 'string' ? emblem.tooltip.trim() : '',
    ...(label === '' ? {} : { label }),
    ...(emblem.variant === 'struck' ? { variant: 'struck' as const } : {}),
    ...(typeof emblem.onActivate === 'function' ? { onActivate: emblem.onActivate } : {}),
  }
}

function sameEmblem(a: TabEmblem, b: TabEmblem): boolean {
  return a.icon === b.icon && a.hue === b.hue && a.tooltip === b.tooltip && a.label === b.label && a.variant === b.variant && a.onActivate === b.onActivate
}

const byExt = <V>(m: Map<string, V>): Array<[string, V]> => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * Emblems and tab lines by pane id, then by extension id. Every change tells `changed` which pane it touched (undefined: any
 * pane).
 */
export class TabEmblemBoard {
  private readonly panes = new Map<string, Map<string, readonly TabEmblem[]>>()
  private readonly lines = new Map<string, Map<string, number>>()

  private readonly changed: (paneId: string | undefined) => void

  constructor(changed: (paneId: string | undefined) => void = () => {}) { this.changed = changed }

  /** Sets (or takes away) the one emblem of `ext` on `paneId`. Returns whether anything changed. */
  set(ext: string, paneId: string, emblem: TabEmblem | undefined): boolean {
    return this.setMany(ext, paneId, emblem ? [emblem] : undefined)
  }

  /** Sets the emblems of `ext` on `paneId`, in order (up to MAX_TAB_EMBLEMS); none takes them away. Returns whether anything changed. */
  setMany(ext: string, paneId: string, emblems: readonly TabEmblem[] | undefined): boolean {
    const next = (Array.isArray(emblems) ? emblems : []).map(normalizeEmblem).filter((e): e is TabEmblem => e !== undefined).slice(0, MAX_TAB_EMBLEMS)
    const mine = this.panes.get(paneId)
    const prev = mine?.get(ext) ?? []
    if (next.length === prev.length && next.every((e, i) => sameEmblem(e, prev[i]!))) return false
    if (next.length === 0) {
      mine!.delete(ext)
      if (mine!.size === 0) this.panes.delete(paneId)
    } else {
      const bucket = mine ?? new Map<string, readonly TabEmblem[]>()
      bucket.set(ext, next)
      this.panes.set(paneId, bucket)
    }
    this.changed(paneId)
    return true
  }

  /** The emblems on a pane, in stable order (by extension id, then in the order each gave them). */
  of(paneId: string): readonly PlacedEmblem[] {
    const mine = this.panes.get(paneId)
    if (!mine) return []
    return byExt(mine).flatMap(([ext, list]) => list.map(emblem => ({ ext, emblem })))
  }

  /** Sets (or takes away) the tab line of `ext` on `paneId`. Returns whether anything changed. */
  setLine(ext: string, paneId: string, hue: number | undefined): boolean {
    const next = normalizeHue(hue)
    const mine = this.lines.get(paneId)
    const prev = mine?.get(ext)
    if (next === prev) return false
    if (next === undefined) {
      mine!.delete(ext)
      if (mine!.size === 0) this.lines.delete(paneId)
    } else {
      const bucket = mine ?? new Map<string, number>()
      bucket.set(ext, next)
      this.lines.set(paneId, bucket)
    }
    this.changed(paneId)
    return true
  }

  /** The hue of the line under a pane's tab: the first extension's by id; undefined for none. */
  lineOf(paneId: string): number | undefined {
    const mine = this.lines.get(paneId)
    return mine ? byExt(mine)[0]?.[1] : undefined
  }

  /** How many panes carry a mark (an emblem or a line). */
  get size(): number { return new Set([...this.panes.keys(), ...this.lines.keys()]).size }

  /** Takes away everything `ext` put (the extension went). Returns whether anything changed. */
  removeOwner(ext: string): boolean {
    const touched = new Set<string>()
    for (const map of [this.panes, this.lines] as Array<Map<string, Map<string, unknown>>>) {
      for (const [paneId, mine] of [...map]) {
        if (!mine.delete(ext)) continue
        touched.add(paneId)
        if (mine.size === 0) map.delete(paneId)
      }
    }
    for (const id of touched) this.changed(id)
    return touched.size > 0
  }
}

/** A status-bar line as kept: the text and tooltip trimmed, a whole hue, the click as given. Undefined when it has no text. */
export function normalizeHeadItem(item: PaneHeadItem | undefined): PaneHeadItem | undefined {
  if (!item || typeof item.text !== 'string' || item.text.trim() === '') return undefined
  const hue = normalizeHue(item.hue)
  return {
    icon: typeof item.icon === 'string' ? item.icon : '',
    ...(hue === undefined ? {} : { hue }),
    text: item.text.trim(),
    tooltip: typeof item.tooltip === 'string' ? item.tooltip.trim() : '',
    ...(typeof item.onActivate === 'function' ? { onActivate: item.onActivate } : {}),
  }
}

/** The status-bar lines by pane id, then by extension id; one per extension per pane. Every change tells `changed` the pane. */
export class HeadItemBoard {
  private readonly panes = new Map<string, Map<string, PaneHeadItem>>()
  private readonly changed: (paneId: string) => void

  constructor(changed: (paneId: string) => void = () => {}) { this.changed = changed }

  set(ext: string, paneId: string, item: PaneHeadItem | undefined): boolean {
    const next = normalizeHeadItem(item)
    const mine = this.panes.get(paneId)
    const prev = mine?.get(ext)
    if (!next) {
      if (!prev) return false
      mine!.delete(ext)
      if (mine!.size === 0) this.panes.delete(paneId)
    } else {
      if (prev && prev.icon === next.icon && prev.hue === next.hue && prev.text === next.text && prev.tooltip === next.tooltip && prev.onActivate === next.onActivate) return false
      const bucket = mine ?? new Map<string, PaneHeadItem>()
      bucket.set(ext, next)
      this.panes.set(paneId, bucket)
    }
    this.changed(paneId)
    return true
  }

  /** The lines of a pane, in stable order (by extension id), with who put each. */
  placed(paneId: string): ReadonlyArray<{ ext: string; item: PaneHeadItem }> {
    const mine = this.panes.get(paneId)
    return mine ? byExt(mine).map(([ext, item]) => ({ ext, item })) : []
  }

  of(paneId: string): readonly PaneHeadItem[] { return this.placed(paneId).map(p => p.item) }

  get size(): number { return this.panes.size }

  removeOwner(ext: string): boolean {
    const touched: string[] = []
    for (const [paneId, mine] of [...this.panes]) {
      if (!mine.delete(ext)) continue
      touched.push(paneId)
      if (mine.size === 0) this.panes.delete(paneId)
    }
    for (const id of touched) this.changed(id)
    return touched.length > 0
  }
}

// ---------- the DOM: the `.ext-emblems` and the line of each tab header, the `.ext-head` of each status bar ----------

const TAB = '.tether-tab[data-slot]'
const PANEL = '.panel[data-slot-id]'

/** The icon for a name the app has; undefined for one it does not (the emblem then draws as an empty chip). */
export type MakeIcon = (name: string) => SVGSVGElement | undefined
let makeIcon: MakeIcon | undefined

/** icons.ts holds the SVG text (a build-time import), so it is loaded on first use: this file stays loadable by the unit tests. */
async function loadIcons(): Promise<MakeIcon> {
  if (makeIcon) return makeIcon
  const { ICON_NAMES, icon } = await import('../icons.ts')
  const names = ICON_NAMES as readonly string[]
  makeIcon = name => (names.includes(name) ? icon(name as Parameters<typeof icon>[0]) : undefined)
  return makeIcon
}

/**
 * One emblem as an element: a button when it answers a click (a press on it is not a press on the tab or the card), a span
 * otherwise. The tab header and a card of a view that lists panes draw it the same way.
 */
export function emblemNode(emblem: TabEmblem, icons: MakeIcon, ext?: string): HTMLElement {
  const click = emblem.onActivate
  const el = document.createElement(click ? 'button' : 'span')
  if (el instanceof HTMLButtonElement) el.type = 'button'
  el.className = `ext-emblem${emblem.hue === undefined ? '' : ' hued'}${emblem.label ? ' letter' : ''}${emblem.variant === 'struck' ? ' struck' : ''}`
  if (ext !== undefined) el.dataset.ext = ext
  if (emblem.hue !== undefined) el.style.setProperty('--emblem-hue', String(emblem.hue))
  if (emblem.tooltip) { el.title = emblem.tooltip; el.setAttribute('aria-label', emblem.tooltip) }
  if (emblem.label) el.textContent = emblem.label
  else { const glyph = icons(emblem.icon); if (glyph) el.append(glyph) }
  if (click) {
    // Like the ×: a press on the emblem does not start a tab drag, and a click on it is not a click on the tab.
    el.addEventListener('pointerdown', ev => ev.stopPropagation())
    el.addEventListener('click', ev => { ev.stopPropagation(); try { click() } catch (err) { console.error('panes.setEmblem onActivate', err) } })
  }
  return el
}

/** Fills the `.ext-emblems` container of one tab header with the pane's emblems (hidden when there are none) and sets its line. */
function paintTab(tab: HTMLElement, emblems: readonly PlacedEmblem[], line: number | undefined, icons: MakeIcon): void {
  if (line === undefined) { tab.classList.remove('ext-line'); tab.style.removeProperty('--line-hue') }
  else { tab.classList.add('ext-line'); tab.style.setProperty('--line-hue', String(line)) }
  const box = tab.querySelector<HTMLElement>(':scope > .ext-emblems')
  if (!box) return
  const nodes = emblems.map(({ ext, emblem }) => emblemNode(emblem, icons, ext))
  box.replaceChildren(...nodes)
  box.hidden = nodes.length === 0
}

/** Fills the `.ext-head` container of one panel's status bar with the pane's lines; hidden when there are none. */
function paintHead(panel: HTMLElement, items: ReadonlyArray<{ ext: string; item: PaneHeadItem }>, icons: MakeIcon): void {
  const box = panel.querySelector<HTMLElement>('.status-bar > .ext-head')
  if (!box) return
  const nodes = items.map(({ ext, item }) => {
    const click = item.onActivate
    const el = document.createElement(click ? 'button' : 'span')
    if (el instanceof HTMLButtonElement) { el.type = 'button'; el.setAttribute('aria-haspopup', 'menu') }
    el.className = item.hue === undefined ? 'ext-head-item' : 'ext-head-item hued'
    el.dataset.ext = ext
    if (item.hue !== undefined) el.style.setProperty('--head-hue', String(item.hue))
    if (item.tooltip) el.title = item.tooltip
    const glyph = item.icon ? icons(item.icon) : undefined
    if (glyph) el.append(glyph)
    const text = document.createElement('span'); text.className = 'tx'; text.textContent = item.text
    el.append(text)
    if (click) {
      const caret = icons('caret-down')
      if (caret) { caret.classList.add('caret'); el.append(caret) }
      el.addEventListener('click', ev => { ev.stopPropagation(); try { click(el) } catch (err) { console.error('panes.setHeadItem onActivate', err) } })
    }
    return el
  })
  box.replaceChildren(...nodes)
  box.hidden = nodes.length === 0
}

/**
 * Keeps every element matching `selector` painted from a board: `repaint(paneId)` paints the elements of one pane, `repaint()`
 * all of them, and while the board holds a mark a watcher paints an element the moment it enters the page (or its pane id
 * attribute changes). A no-op without a DOM (the unit tests).
 */
class Painter {
  private observer: MutationObserver | undefined
  private readonly selector: string
  private readonly attr: string
  private readonly busy: () => boolean
  private readonly paint: (el: HTMLElement, paneId: string, icons: MakeIcon) => void

  constructor(selector: string, attr: string, busy: () => boolean, paint: (el: HTMLElement, paneId: string, icons: MakeIcon) => void) {
    this.selector = selector; this.attr = attr; this.busy = busy; this.paint = paint
  }

  repaint(paneId?: string): void {
    if (typeof document === 'undefined') return
    if (makeIcon) { this.run(paneId, makeIcon); return }
    void loadIcons().then(icons => this.run(paneId, icons)).catch(err => console.error('pane marks: icons', err))
  }

  private idOf(el: HTMLElement): string { return el.getAttribute(this.attr) ?? '' }

  private run(paneId: string | undefined, icons: MakeIcon): void {
    if (this.busy()) this.watch(); else this.unwatch()
    const els = document.querySelectorAll<HTMLElement>(paneId === undefined ? this.selector : `${this.selector}[${this.attr}="${CSS.escape(paneId)}"]`)
    for (const el of els) this.paint(el, this.idOf(el), icons)
  }

  private watch(): void {
    if (this.observer || typeof MutationObserver === 'undefined') return
    this.observer = new MutationObserver(records => {
      const icons = makeIcon
      if (!icons || !this.busy()) return
      const fresh = new Set<HTMLElement>()
      const take = (el: Element): void => {
        if (el.matches(this.selector)) fresh.add(el as HTMLElement)
        for (const t of el.querySelectorAll<HTMLElement>(this.selector)) fresh.add(t)
      }
      for (const r of records) {
        if (r.type === 'attributes') { if (r.target instanceof Element) take(r.target); continue }
        for (const n of r.addedNodes) if (n instanceof Element) take(n)
      }
      for (const el of fresh) this.paint(el, this.idOf(el), icons)
    })
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [this.attr] })
  }

  private unwatch(): void {
    this.observer?.disconnect()
    this.observer = undefined
  }
}

/** The tabs: emblems and line, from the board. */
export class TabEmblemPainter {
  private readonly painter: Painter

  constructor(board: TabEmblemBoard) {
    this.painter = new Painter(TAB, 'data-slot', () => board.size > 0, (tab, id, icons) => paintTab(tab, board.of(id), board.lineOf(id), icons))
  }

  repaint(paneId?: string): void { this.painter.repaint(paneId) }
}

/** The terminal panels' status bars: the extensions' lines, from the board. */
export class HeadItemPainter {
  private readonly painter: Painter

  constructor(board: HeadItemBoard) {
    this.painter = new Painter(PANEL, 'data-slot-id', () => board.size > 0, (panel, id, icons) => paintHead(panel, board.placed(id), icons))
  }

  repaint(paneId?: string): void { this.painter.repaint(paneId) }
}
