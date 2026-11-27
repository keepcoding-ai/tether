// The arrow keys over the Regency on the web: a walk across the screen by direction (the TV's remote, or a keyboard on any
// tier). The items are what the screen offers to open: the cards of "Esperam você", the channels and their "Encerrados", the
// filter chips, the desks' columns and their cards, "Fechadas". Enter (the remote's OK) does what a click does; Back or Esc
// closes the card, or climbs from a card of a desk to its column's head. The rule of "which item lies that way" is pure
// (focus-rules.ts); this file reads the page into rectangles and keys, and moves the focus.
//
// The pane paints its rows again on every change of the house: the focus is held by the item's key, never by its node, and
// given back after each paint when the repaint took it away.
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import { BACK_KEYS, DIRECTIONS, initialKeyOf, itemKeyOf, keptKeyOf, neighbourOf, takesArrow, type Item } from './focus-rules.ts'
import { el } from './ui-lite.ts'

/** Where the items live, and the name of each place (the prefix of its key). */
const PLACES = [
  ['wait', '.rg-waiting [data-target]'],
  ['conv', '.rg-convs .rg-conv[data-target]'],
  ['toggle', '.rg-convs .rg-tg[data-action]'],
  ['chip', '.rg-chips .rg-chip[data-filter]'],
  ['tree', '.rg-tree [data-key]'],
] as const

type Place = (typeof PLACES)[number][0]

const ITEM_SELECTOR = PLACES.map(p => p[1]).join(', ')

function placeOf(e: HTMLElement): Place | undefined {
  for (const [place, sel] of PLACES) if (e.matches(sel)) return place
  return undefined
}

function keyOf(e: HTMLElement): string | undefined {
  const place = placeOf(e)
  if (!place) return undefined
  const d = e.dataset
  return itemKeyOf(place, { key: d.key, target: d.target, filter: d.filter, action: d.action })
}

const editable = (e: Element | null): boolean =>
  e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement || (e instanceof HTMLElement && e.isContentEditable)

/** The strip of the TV's keys, at the top: what the remote does here. */
export function keysStrip(): HTMLElement {
  const strip = el('span', 'rr-keys')
  strip.setAttribute('aria-hidden', 'true')
  const kbd = (t: string): HTMLElement => el('kbd', '', t)
  strip.append(kbd('←'), kbd('→'), kbd('↑'), kbd('↓'), ' andar · ', kbd('OK'), ' abrir · ', kbd('Voltar'), ' fechar')
  return strip
}

export interface SpatialFocusDeps {
  tier(): Tier
  /** The reading card is open. */
  cardShown(): boolean
  /** Closes the card and gives the keyboard back to the row that opened it. */
  closeCard(): void
}

export interface SpatialFocus {
  /** The pane painted: the focus goes back to its item if the repaint took it, and on the TV someone always holds it. */
  afterPaint(): void
  /** The casing changed tier: the TV turns the walk on. */
  tierChanged(): void
  dispose(): void
}

export function mountSpatialFocus(shell: HTMLElement, deps: SpatialFocusDeps): SpatialFocus {
  /** The walk is on: the ring shows, and the focus is given back after a repaint. On by default on the TV only. */
  let on = deps.tier() === 'wide'
  let lastKey: string | undefined
  let order: string[] = []
  let cardAtKey = false

  const paintOn = (): void => { if (on) shell.dataset.keys = 'on'; else delete shell.dataset.keys }

  const items = (): HTMLElement[] => [...shell.querySelectorAll<HTMLElement>(ITEM_SELECTOR)]
    .filter(e => !e.closest('[hidden], .rr-card') && e.getClientRects().length > 0)

  const keyed = (): { key: string; el: HTMLElement }[] => {
    const out: { key: string; el: HTMLElement }[] = []
    for (const e of items()) { const k = keyOf(e); if (k) out.push({ key: k, el: e }) }
    return out
  }

  const focusEl = (e: HTMLElement): void => {
    e.focus({ preventScroll: true })
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  /** Nothing of the page holds the keyboard (a repaint took the node that had it, or nobody had it yet). */
  const nobody = (): boolean => {
    const a = document.activeElement
    return a === null || a === document.body || a === document.documentElement
  }

  const isItem = (e: Element | null): e is HTMLElement => e instanceof HTMLElement && shell.contains(e) && e.matches(ITEM_SELECTOR) && !e.closest('.rr-card')

  // On the document, in the capture phase: an arrow pressed while nobody holds the keyboard reaches the body, not the shell,
  // and the pane's own keys (the tree's) must not run first on the TV.
  const onKeyCapture = (ev: KeyboardEvent): void => {
    const t = document.activeElement
    if (!shell.isConnected || !(nobody() || (t !== null && shell.contains(t)))) return
    cardAtKey = deps.cardShown()
    const inCard = t instanceof Element && t.closest('.rr-card') !== null
    const dir = DIRECTIONS[ev.key]
    if (dir) {
      const item = isItem(t)
      const take = takesArrow({
        editable: editable(t), item, treeRow: item && t.matches('.rg-tree [data-key]'), nowhere: nobody(), inCard,
        tv: deps.tier() === 'wide', modified: ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey,
      })
      if (!take) return
      const all = keyed()
      // Nothing to walk (the notice of "offline"): the arrow stays the page's.
      if (all.length === 0) return
      ev.preventDefault()
      ev.stopPropagation()
      on = true
      paintOn()
      order = all.map(a => a.key)
      const here = item ? all.find(a => a.el === t) : undefined
      let next: string | undefined
      if (!here) next = keptKeyOf(order, order, lastKey) ?? initialKeyOf(order)
      else {
        const rects: Item[] = all.map(a => { const r = a.el.getBoundingClientRect(); return { key: a.key, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } } })
        next = neighbourOf(rects.find(r => r.key === here.key)!, rects, dir)
      }
      const to = next === undefined ? undefined : all.find(a => a.key === next)
      if (to) focusEl(to.el)
      return
    }
    // The remote's OK on an item: what a click does (the tree's own Enter would go to the tab, which the web has not).
    if (ev.key === 'Enter' && deps.tier() === 'wide' && isItem(t) && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault()
      ev.stopPropagation()
      t.click()
    }
  }

  // Back runs after the pane's own Esc (the search, the filter) and the card's: only what nobody took climbs a level.
  const onKeyBubble = (ev: KeyboardEvent): void => {
    if (!BACK_KEYS.has(ev.key) || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return
    const t = document.activeElement
    if (editable(t)) return
    if (cardAtKey) {
      // Esc closed it already (the casing's key); the remote's Back has no one else to close it.
      if (ev.key !== 'Escape' && deps.cardShown()) { ev.preventDefault(); deps.closeCard() }
      return
    }
    if (!on || !isItem(t) || t.getAttribute('aria-level') !== '2') return
    const head = t.closest('.rg-group')?.querySelector<HTMLElement>('[data-key][aria-level="1"]')
    if (!head || head === t) return
    ev.preventDefault()
    focusEl(head)
  }

  const onFocusIn = (ev: FocusEvent): void => {
    const t = ev.target
    if (!isItem(t as Element | null)) return
    const k = keyOf(t as HTMLElement)
    if (k) lastKey = k
  }

  // A pointer turns the ring off (the person is not walking by keys); on the TV the next arrow brings it back.
  const onPointer = (): void => { if (on) { on = false; paintOn() } }

  document.addEventListener('keydown', onKeyCapture, true)
  shell.addEventListener('keydown', onKeyBubble)
  shell.addEventListener('focusin', onFocusIn)
  shell.addEventListener('pointerdown', onPointer, true)
  paintOn()

  const afterPaint = (): void => {
    const all = keyed()
    const keys = all.map(a => a.key)
    if (on && nobody() && !deps.cardShown()) {
      const want = keptKeyOf(order, keys, lastKey) ?? (deps.tier() === 'wide' ? initialKeyOf(keys) : undefined)
      const to = want === undefined ? undefined : all.find(a => a.key === want)
      if (to) focusEl(to.el)
    }
    order = keys
  }

  return {
    afterPaint,
    tierChanged: () => {
      on = deps.tier() === 'wide'
      paintOn()
      if (on) afterPaint()
    },
    dispose: () => {
      document.removeEventListener('keydown', onKeyCapture, true)
      shell.removeEventListener('keydown', onKeyBubble)
      shell.removeEventListener('focusin', onFocusIn)
      shell.removeEventListener('pointerdown', onPointer, true)
      delete shell.dataset.keys
    },
  }
}
