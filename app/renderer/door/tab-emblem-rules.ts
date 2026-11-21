// The extensions' emblems on the tabs (TetherUi.panes.setEmblem). The first half is pure: who put which emblem on which pane,
// one per extension per pane, stable order (by extension id), everything goes with its extension. The second half is the DOM:
// it fills the `.ext-emblems` container of every tab header (tab-header.ts) from the board. A tab header is one for every pane
// kind, and a pane that changes desk gets a new tab element, so the painter watches the page for tabs instead of asking each
// pane kind to call in: a tab that appears is painted at once.
import type { TabEmblem } from '../ext-api.ts'
import { normalizeHue } from './desk-seal-rules.ts'

/** An emblem as the tab draws it, with who put it. */
export interface PlacedEmblem { ext: string; emblem: TabEmblem }

/** The emblem as kept: a named icon, a whole hue, the tooltip trimmed; the click stays as given. Undefined when there is nothing to draw. */
export function normalizeEmblem(emblem: TabEmblem | undefined): TabEmblem | undefined {
  if (!emblem || typeof emblem.icon !== 'string' || emblem.icon === '') return undefined
  const hue = normalizeHue(emblem.hue)
  return {
    icon: emblem.icon,
    ...(hue === undefined ? {} : { hue }),
    tooltip: typeof emblem.tooltip === 'string' ? emblem.tooltip.trim() : '',
    ...(typeof emblem.onActivate === 'function' ? { onActivate: emblem.onActivate } : {}),
  }
}

/** Emblems by pane id, then by extension id. Every change tells `changed` which pane it touched (undefined: any pane). */
export class TabEmblemBoard {
  private readonly panes = new Map<string, Map<string, TabEmblem>>()

  private readonly changed: (paneId: string | undefined) => void

  constructor(changed: (paneId: string | undefined) => void = () => {}) { this.changed = changed }

  /** Sets (or takes away) the emblem of `ext` on `paneId`. Returns whether anything changed. */
  set(ext: string, paneId: string, emblem: TabEmblem | undefined): boolean {
    const next = normalizeEmblem(emblem)
    const mine = this.panes.get(paneId)
    const prev = mine?.get(ext)
    if (!next) {
      if (!prev) return false
      mine!.delete(ext)
      if (mine!.size === 0) this.panes.delete(paneId)
    } else {
      if (prev && prev.icon === next.icon && prev.hue === next.hue && prev.tooltip === next.tooltip && prev.onActivate === next.onActivate) return false
      const bucket = mine ?? new Map<string, TabEmblem>()
      bucket.set(ext, next)
      this.panes.set(paneId, bucket)
    }
    this.changed(paneId)
    return true
  }

  /** The emblems on a pane, in stable order (by extension id). */
  of(paneId: string): readonly PlacedEmblem[] {
    const mine = this.panes.get(paneId)
    if (!mine) return []
    return [...mine].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ext, emblem]) => ({ ext, emblem }))
  }

  /** How many panes carry an emblem. */
  get size(): number { return this.panes.size }

  /** Takes away everything `ext` put (the extension went). Returns whether anything changed. */
  removeOwner(ext: string): boolean {
    let any = false
    const touched: string[] = []
    for (const [paneId, mine] of [...this.panes]) {
      if (!mine.delete(ext)) continue
      any = true
      touched.push(paneId)
      if (mine.size === 0) this.panes.delete(paneId)
    }
    for (const id of touched) this.changed(id)
    return any
  }
}

// ---------- the DOM: the `.ext-emblems` of each tab header ----------

const TAB = '.tether-tab[data-slot]'

/** The icon for a name the app has; undefined for one it does not (the emblem then draws as an empty chip). */
type MakeIcon = (name: string) => SVGSVGElement | undefined
let makeIcon: MakeIcon | undefined

/** icons.ts holds the SVG text (a build-time import), so it is loaded on first use: this file stays loadable by the unit tests. */
async function loadIcons(): Promise<MakeIcon> {
  if (makeIcon) return makeIcon
  const { ICON_NAMES, icon } = await import('../icons.ts')
  const names = ICON_NAMES as readonly string[]
  makeIcon = name => (names.includes(name) ? icon(name as Parameters<typeof icon>[0]) : undefined)
  return makeIcon
}

/** Fills the `.ext-emblems` container of one tab header with the pane's emblems; hidden when there are none. */
function paintTab(tab: HTMLElement, emblems: readonly PlacedEmblem[], icons: MakeIcon): void {
  const box = tab.querySelector<HTMLElement>(':scope > .ext-emblems')
  if (!box) return
  const nodes = emblems.map(({ ext, emblem }) => {
    const click = emblem.onActivate
    const el = document.createElement(click ? 'button' : 'span')
    if (el instanceof HTMLButtonElement) el.type = 'button'
    el.className = emblem.hue === undefined ? 'ext-emblem' : 'ext-emblem hued'
    el.dataset.ext = ext
    if (emblem.hue !== undefined) el.style.setProperty('--emblem-hue', String(emblem.hue))
    if (emblem.tooltip) { el.title = emblem.tooltip; el.setAttribute('aria-label', emblem.tooltip) }
    const glyph = icons(emblem.icon)
    if (glyph) el.append(glyph)
    if (click) {
      // Like the ×: a press on the emblem does not start a tab drag, and a click on it is not a click on the tab.
      el.addEventListener('pointerdown', ev => ev.stopPropagation())
      el.addEventListener('click', ev => { ev.stopPropagation(); try { click() } catch (err) { console.error('panes.setEmblem onActivate', err) } })
    }
    return el
  })
  box.replaceChildren(...nodes)
  box.hidden = nodes.length === 0
}

/**
 * Keeps every tab painted from the board: `repaint(paneId)` paints the tabs of one pane, `repaint()` all of them, and while the
 * board holds an emblem a watcher paints a tab the moment it enters the page. A no-op without a DOM (the unit tests).
 */
export class TabEmblemPainter {
  private observer: MutationObserver | undefined
  private readonly board: TabEmblemBoard

  constructor(board: TabEmblemBoard) { this.board = board }

  repaint(paneId?: string): void {
    if (typeof document === 'undefined') return
    if (makeIcon) { this.run(paneId, makeIcon); return }
    void loadIcons().then(icons => this.run(paneId, icons)).catch(err => console.error('tab emblems: icons', err))
  }

  private run(paneId: string | undefined, icons: MakeIcon): void {
    if (this.board.size > 0) this.watch(); else this.unwatch()
    const tabs = document.querySelectorAll<HTMLElement>(paneId === undefined ? TAB : `${TAB}[data-slot="${CSS.escape(paneId)}"]`)
    for (const tab of tabs) paintTab(tab, this.board.of(tab.dataset.slot!), icons)
  }

  private watch(): void {
    if (this.observer || typeof MutationObserver === 'undefined') return
    this.observer = new MutationObserver(records => {
      const icons = makeIcon
      if (!icons || this.board.size === 0) return
      const fresh = new Set<HTMLElement>()
      const take = (el: Element): void => {
        if (el.matches(TAB)) fresh.add(el as HTMLElement)
        for (const t of el.querySelectorAll<HTMLElement>(TAB)) fresh.add(t)
      }
      for (const r of records) {
        if (r.type === 'attributes') { if (r.target instanceof Element) take(r.target); continue }
        for (const n of r.addedNodes) if (n instanceof Element) take(n)
      }
      for (const tab of fresh) { const mine = this.board.of(tab.dataset.slot!); if (mine.length > 0) paintTab(tab, mine, icons) }
    })
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-slot'] })
  }

  private unwatch(): void {
    this.observer?.disconnect()
    this.observer = undefined
  }
}
