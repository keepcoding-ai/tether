// The rules of the arrow keys over the Regency on the web, with no DOM: which item is the neighbour in a direction (by the
// rectangles on screen), which key names an item across a re-reading of the tree, which item takes the keyboard first, and
// whether an arrow pressed somewhere is ours to take. src/focus.ts reads the page into these shapes and acts on the answer.

export type Direction = 'up' | 'down' | 'left' | 'right'

export interface Rect { left: number; top: number; right: number; bottom: number }

export interface Item { key: string; rect: Rect }

export const DIRECTIONS: Readonly<Record<string, Direction>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** How far a neighbour may reach back over the item and still count as lying in the direction (borders, rounding). */
const SLACK = 4
/** The weight of the distance across the direction against the distance along it: the eye follows the line first. */
const ACROSS = 2.5

/** The gap between two ranges on one axis (0 when they overlap). */
const gap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, b0 - a1, a0 - b1)
const overlap = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > 0

/**
 * The neighbour of `from` in `dir`, or undefined at the border (the focus never leaves the screen's items). A neighbour lies
 * wholly past `from`'s edge in that direction; the nearest wins, measured along the direction plus the distance across it
 * (weighted). Going up or down keeps to what shares the column (overlaps across): the foot of a short column does not jump
 * into the middle of the next one. Going sideways takes the nearest item of the next column, aligned or not.
 */
export function neighbourOf(fromItem: Item, items: readonly Item[], dir: Direction): string | undefined {
  const from = fromItem.rect
  const vertical = dir === 'up' || dir === 'down'
  let best: string | undefined
  let bestScore = Infinity
  for (const it of items) {
    const r = it.rect
    if (it.key === fromItem.key) continue
    const past = dir === 'right' ? r.left >= from.right - SLACK
      : dir === 'left' ? r.right <= from.left + SLACK
        : dir === 'down' ? r.top >= from.bottom - SLACK
          : r.bottom <= from.top + SLACK
    if (!past) continue
    if (vertical && !overlap(from.left, from.right, r.left, r.right)) continue
    const along = vertical ? gap(from.top, from.bottom, r.top, r.bottom) : gap(from.left, from.right, r.left, r.right)
    const across = vertical ? gap(from.left, from.right, r.left, r.right) : gap(from.top, from.bottom, r.top, r.bottom)
    // Among items that touch the line, the one whose centre is nearer the line's centre (a wide row under two cards).
    const centre = vertical ? Math.abs((r.left + r.right) - (from.left + from.right)) / 2 : Math.abs((r.top + r.bottom) - (from.top + from.bottom)) / 2
    const score = along + across * ACROSS + centre / 1000
    if (score < bestScore) { bestScore = score; best = it.key }
  }
  return best
}

/** What the page tells of an element that may be an item (its data attributes, its class). */
export interface ItemFacts {
  /** `data-key` of a row of the tree (unique even where a group and its agent's pane share a target). */
  key?: string
  /** `data-target` of a row of "Esperam você" or of the channels. */
  target?: string
  /** `data-filter` of a chip. */
  filter?: string
  /** `data-action` of a toggle ("Encerrados"). */
  action?: string
  /**
   * The name of an item of the open channel, as the page tells it (only the TV walks them): a speech or a poll's card by its
   * seq, an option by its card and number, a part of the speaking box, a button of a speech on its way, "Trancar".
   */
  id?: string
}

/** The places of the Regency (every tier walks them) and of the open channel (the TV's, where nothing else reaches them). */
export type Place = 'wait' | 'conv' | 'tree' | 'chip' | 'toggle' | ChannelPlace
export type ChannelPlace = 'msg' | 'card' | 'opt' | 'older' | 'say' | 'out' | 'lock' | 'form' | 'reason' | 'file' | 'new' | 'bar'

/**
 * The stable name of an item: what it shows of the house, never the node (the tree is painted again on every change). The
 * same channel in "Esperam você" and in the list are two items: the prefix of the place keeps them apart.
 */
export function itemKeyOf(place: Place, f: ItemFacts): string | undefined {
  switch (place) {
    case 'tree': return f.key ? `tree:${f.key}` : undefined
    case 'wait': return f.target ? `wait:${f.target}` : undefined
    case 'conv': return f.target ? `conv:${f.target}` : undefined
    case 'chip': return f.filter ? `chip:${f.filter}` : undefined
    case 'toggle': return f.action ? `toggle:${f.action}` : undefined
    default: return f.id ? `${place}:${f.id}` : undefined
  }
}

/** Who takes the keyboard first: whoever waits for the person, else the first channel, else the first item. */
export function initialKeyOf(keys: readonly string[]): string | undefined {
  return keys.find(k => k.startsWith('wait:')) ?? keys.find(k => k.startsWith('conv:')) ?? keys.find(k => !k.startsWith('lock:')) ?? keys[0]
}

/** The casing's own items ("Trancar"): there from the first paint, they are not the house's content and never take the first focus. */
const isCasing = (k: string): boolean => k.startsWith('chip:') || k.startsWith('lock:')

/**
 * The first focus of the TV is decided when real content arrives, not at the first paint (which has only the filter chips and
 * would give them the keyboard for good). Until content arrives nothing is forced; when it arrives for the first time the
 * focus goes to who takes it first, unless the person already walked with the arrows (then hers stays). `settled` turns true
 * once the content has been seen.
 */
export function firstFocusOf(keys: readonly string[], walked: boolean): { settled: boolean; key?: string } {
  if (!keys.some(k => !isCasing(k))) return { settled: false }
  return walked ? { settled: true } : { settled: true, key: initialKeyOf(keys) }
}

/**
 * The item that keeps the keyboard after the tree is read again: the same key when it is still there; when it went (a pane
 * closed), the item now at its old place in the order, so the focus does not fall off the screen.
 */
export function keptKeyOf(before: readonly string[], after: readonly string[], key: string | undefined): string | undefined {
  if (key === undefined) return undefined
  if (after.includes(key)) return key
  if (after.length === 0) return undefined
  const at = before.indexOf(key)
  if (at < 0) return initialKeyOf(after)
  // The nearest survivor before it in the old order (same place, same column), else the first after it.
  for (let i = at - 1; i >= 0; i--) { const k = before[i]!; if (after.includes(k)) return k }
  for (let i = at + 1; i < before.length; i++) { const k = before[i]!; if (after.includes(k)) return k }
  return initialKeyOf(after)
}

/** Where an arrow was pressed. */
export interface KeyPlace {
  /** The element is a field that takes text (input, textarea, select, contenteditable). */
  editable: boolean
  /** The element is one of our items. */
  item: boolean
  /** The element is a row of the tree (it has its own arrows outside the TV). */
  treeRow: boolean
  /** Nothing has the keyboard (the page itself). */
  nowhere: boolean
  /** The reading card (the ficha) holds the keyboard. */
  inCard: boolean
  /** The TV's tier, where the arrows walk the screen by default. */
  tv: boolean
  /** A modifier was held (Alt, Ctrl, Meta, Shift): the arrow belongs to the browser or to a shortcut. */
  modified: boolean
  /**
   * In a field, the caret cannot go that way (Up on its first line, Down on its last; a one-line field or a list of choices
   * always): on the TV the arrow leaves the field, the remote has nothing else to leave it with.
   */
  edge?: boolean
}

/**
 * Whether the arrow is ours. Never a text field's while its caret can move that way, never the card's, never with a
 * modifier. On the TV, every item walks the screen, the tree's rows too (the board has no folds to open sideways), and a
 * field of the speaking box or of the poll form lets go at its edge. Elsewhere the tree keeps its own keys (left folds,
 * right opens) and the other items walk; from nowhere, the first arrow brings the focus in.
 */
export function takesArrow(p: KeyPlace): boolean {
  if (p.inCard || p.modified) return false
  if (p.editable) return p.tv && p.item && p.edge === true
  if (p.nowhere) return true
  if (!p.item) return false
  return p.tv || !p.treeRow
}

/** What a field of the page tells of its caret, for `edge`. */
export interface Caret { kind: 'text' | 'area' | 'select'; value: string; start: number; end: number }

/** Whether the caret cannot go that way: Up on the first line of a text area, Down on its last; a one-line field or a list always. */
export function caretAtEdge(c: Caret, dir: Direction): boolean {
  if (dir === 'left' || dir === 'right') return false
  if (c.kind !== 'area') return true
  return dir === 'up' ? !c.value.slice(0, c.start).includes('\n') : !c.value.slice(c.end).includes('\n')
}

/**
 * What the remote's OK does on an item: a speech or a poll's card opens its menu (react, vote, copy: what a right click
 * opens); a field keeps its own Enter (the box sends, the form opens the poll); anything else is clicked.
 */
export function okDoes(place: Place, editable: boolean, manages = false): 'menu' | 'click' | 'own' {
  if (editable) return 'own'
  // A device that manages (step 5.4): a row of the tree opens its menu ("Espiar" is its first row), as a right click does.
  if (manages && place === 'tree') return 'menu'
  return place === 'msg' || place === 'card' ? 'menu' : 'click'
}

/** The keys that close the card or go up a level: Esc, and the remote's Back (TVs send one of these names; never in a field). */
export const BACK_KEYS: ReadonlySet<string> = new Set(['Escape', 'GoBack', 'BrowserBack', 'Backspace'])
