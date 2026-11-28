// The arrow keys over the Regency on the web: a walk across the screen by direction (the TV's remote, or a keyboard on any
// tier). The items are what the screen offers to open: the cards of "Esperam você", the channels and their "Encerrados", the
// filter chips, the desks' columns and their cards, "Fechadas". Enter (the remote's OK) does what a click does; Back or Esc
// closes the card, or climbs from a card of a desk to its column's head. The rule of "which item lies that way" is pure
// (focus-rules.ts); this file reads the page into rectangles and keys, and moves the focus.
//
// The pane paints its rows again on every change of the house: the focus is held by the item's key, never by its node, and
// given back after each paint when the repaint took it away.
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import {
  BACK_KEYS, caretAtEdge, DIRECTIONS, firstFocusOf, initialKeyOf, itemKeyOf, keptKeyOf, neighbourOf, okDoes, takesArrow,
  type Direction, type Item, type Place,
} from './focus-rules.ts'
import { el } from './ui-lite.ts'

/** Where the items of the Regency live, and the name of each place (the prefix of its key). Every tier walks them. */
const PLACES: readonly (readonly [Place, string])[] = [
  ['wait', '.rg-waiting [data-target]'],
  ['conv', '.rg-convs .rg-conv[data-target]'],
  ['toggle', '.rg-convs .rg-tg[data-action]'],
  ['chip', '.rg-chips .rg-chip[data-filter]'],
  ['tree', '.rg-tree [data-key]'],
]

/**
 * The open channel's items, walked on the TV only (elsewhere the view keeps its own keys: the arrows walk its speeches, a
 * mouse or a finger does the rest): the speeches and the polls' cards, the votes, "Ver anteriores", the speaking box, the
 * poll form, the reason of a vote, the speeches on their way and "Trancar".
 */
const TV_PLACES: readonly (readonly [Place, string])[] = [
  ['msg', '.ch-msgs > .ch-msg[data-seq]'],
  ['card', '.ch-msgs > .ch-prow[data-seq]'],
  ['opt', '.ch-msgs .ch-prow button.ch-opt[data-n]'],
  // The files of a speech (step 4.3): OK on a thumbnail opens it big, on a card downloads it.
  ['file', '.ch-msgs .ch-msg-files button:is(.ch-shot, .ch-fcard)[data-path]'],
  ['older', '.ch-msgs > .ch-older'],
  ['reason', '.ch-msgs .ch-reason :is(input, button)'],
  ['say', '.ch-say :is(textarea.ch-field, select.ch-dsel, button.ch-pollbtn, button.ch-send)'],
  ['form', '.ch-pf :is(input, button)'],
  ['out', '.rr-out .rr-out-b[data-act]'],
  ['lock', '.rr-top .rr-lock'],
  // Managing from afar (RR5): "+ Novo" in the heading of "Mesas", and the channel's own gestures ("Chamar agente…",
  // "Reabrir canal", its "⋯"), so the remote reaches what a finger or a pointer does.
  ['new', '.rg-hd .rg-new'],
  ['bar', '.ch-bar > button.ch-act:is(.ch-join, .ch-reopen, .ch-more)'],
]

const ITEM_SELECTOR = PLACES.map(p => p[1]).join(', ')
const TV_SELECTOR = [...PLACES, ...TV_PLACES].map(p => p[1]).join(', ')

function placeOf(e: HTMLElement): Place | undefined {
  for (const [place, sel] of [...PLACES, ...TV_PLACES]) if (e.matches(sel)) return place
  return undefined
}

/** The name an item of the open channel goes by (stable across a repaint of the conversation or of the box). */
function channelId(place: Place, e: HTMLElement): string | undefined {
  const d = e.dataset
  switch (place) {
    case 'msg': case 'card': return d.seq
    case 'opt': return `${e.closest<HTMLElement>('.ch-prow')?.dataset.seq ?? ''}:${d.n ?? ''}`
    case 'file': return d.path
    case 'older': case 'lock': case 'new': return place
    case 'bar': return e.classList.contains('ch-join') ? 'join' : e.classList.contains('ch-reopen') ? 'reopen' : 'more'
    case 'reason': return `${e.closest<HTMLElement>('.ch-prow')?.dataset.seq ?? ''}:${d.key ?? e.tagName}`
    case 'say': return e.classList.contains('ch-field') ? 'field' : e.classList.contains('ch-dsel') ? 'to' : e.classList.contains('ch-send') ? 'send' : 'poll'
    case 'out': return `${e.closest<HTMLElement>('.rr-out-i')?.dataset.id ?? ''}:${d.act ?? ''}`
    case 'form': {
      const form = e.closest('.ch-pf')
      const same = form ? [...form.querySelectorAll<HTMLElement>(e.tagName)] : []
      return `${e.tagName}:${d.kind ?? d.dl ?? d.who ?? same.indexOf(e)}`
    }
    default: return undefined
  }
}

function keyOf(e: HTMLElement): string | undefined {
  const place = placeOf(e)
  if (!place) return undefined
  const d = e.dataset
  return itemKeyOf(place, { key: d.key, target: d.target, filter: d.filter, action: d.action, id: channelId(place, e) })
}

const editable = (e: Element | null): boolean =>
  e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement || (e instanceof HTMLElement && e.isContentEditable)

/** Whether the caret of a field cannot go `dir` (a field that is not one says no). */
function atEdge(e: Element | null, dir: Direction): boolean {
  if (e instanceof HTMLTextAreaElement) return caretAtEdge({ kind: 'area', value: e.value, start: e.selectionStart, end: e.selectionEnd }, dir)
  if (e instanceof HTMLInputElement) return caretAtEdge({ kind: 'text', value: e.value, start: e.selectionStart ?? 0, end: e.selectionEnd ?? 0 }, dir)
  if (e instanceof HTMLSelectElement) return caretAtEdge({ kind: 'select', value: '', start: 0, end: 0 }, dir)
  return false
}

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
  /** The device manages from afar: OK on a row of the tree opens its menu (step 5.4). */
  manages?(): boolean
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
  /** The first focus was decided (the house arrived); and whether the person walked with the arrows before that. */
  let settled = false
  let walked = false

  const paintOn = (): void => { if (on) shell.dataset.keys = 'on'; else delete shell.dataset.keys }

  const selector = (): string => (deps.tier() === 'wide' ? TV_SELECTOR : ITEM_SELECTOR)
  const items = (): HTMLElement[] => [...shell.querySelectorAll<HTMLElement>(selector())]
    .filter(e => !e.closest('[hidden], .rr-card') && !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0)

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

  /** The keyboard sits on a filter chip (what the first paint gave it, before the house arrived). */
  const heldIsChip = (): boolean => { const a = document.activeElement; return a instanceof HTMLElement && shell.contains(a) && a.matches('.rg-chips .rg-chip[data-filter]') }

  const isItem = (e: Element | null): e is HTMLElement => e instanceof HTMLElement && shell.contains(e) && e.matches(selector()) && !e.closest('.rr-card')

  // On the document, in the capture phase: an arrow pressed while nobody holds the keyboard reaches the body, not the shell,
  // and the pane's own keys (the tree's) must not run first on the TV.
  const onKeyCapture = (ev: KeyboardEvent): void => {
    const t = document.activeElement
    if (!shell.isConnected || !(nobody() || (t !== null && shell.contains(t)))) return
    // The big picture walks its own arrows (the image before and after) and closes on Back: the walk stays out of it.
    if (t instanceof Element && t.closest('.ch-viewer')) return
    cardAtKey = deps.cardShown()
    const inCard = t instanceof Element && t.closest('.rr-card') !== null
    const dir = DIRECTIONS[ev.key]
    if (dir) {
      const item = isItem(t)
      const take = takesArrow({
        editable: editable(t), item, treeRow: item && t.matches('.rg-tree [data-key]'), nowhere: nobody(), inCard,
        tv: deps.tier() === 'wide', modified: ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey, edge: atEdge(t, dir),
      })
      if (!take) return
      const all = keyed()
      // Nothing to walk (the notice of "offline"): the arrow stays the page's.
      if (all.length === 0) return
      ev.preventDefault()
      ev.stopPropagation()
      on = true
      walked = true
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
    // The remote's OK on an item: what a click does (the tree's own Enter would go to the tab, which the web has not); on a
    // speech or a poll's card, its menu (what a right click opens); a field keeps its own Enter.
    if (ev.key === 'Enter' && deps.tier() === 'wide' && isItem(t) && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      // The head of "Fechadas" folds (it has no menu).
      const does = okDoes(placeOf(t) ?? 'tree', editable(t), deps.manages?.() === true && t.dataset.row !== 'closed-head')
      if (does === 'own') return
      ev.preventDefault()
      ev.stopPropagation()
      if (does === 'click') { t.click(); return }
      const r = t.getBoundingClientRect()
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + Math.min(32, r.height / 2) }))
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
    if (on && !settled && deps.tier() === 'wide' && !deps.cardShown() && (nobody() || heldIsChip())) {
      const first = firstFocusOf(keys, walked)
      settled = first.settled
      if (first.key !== undefined) {
        const to = all.find(a => a.key === first.key)
        if (to) { focusEl(to.el); order = keys; return }
      }
    }
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
