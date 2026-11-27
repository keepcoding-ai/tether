// What of the Regency's layout lives in the address, so that a reload (or an installed app reopening) comes back to the same
// place: the open channel, the phone's tab, "Por mesa / Por agente" and the state filter. Pure: string <-> state, no DOM.
//
// Only ids and names of tabs travel here, never a text: not a channel's lines, not a ticket, not the pairing code or a key
// (those are the fragment's, `#pair=`, which is never touched by this module and which main.ts takes out of the address). The
// state is in the query, not the path: the origin is static and fixed (no server to answer `/c/abc`), and every asset of the
// page is a relative link. Whatever the address holds is read as hostile: a value that is not one of the known names is
// dropped, key by key, and the rest still stands.
import { TREE_FILTERS, type TreeFilter } from '../../../extensions/regency/model.ts'
import { DEFAULT_LAYOUT, type NarrowTab, type RegencyLayout, type RegencyView } from '../../../extensions/regency/renderer/layout-rules.ts'

export interface UrlState {
  channelId?: string
  narrowTab?: NarrowTab
  view?: RegencyView
  filter?: TreeFilter
}

const TABS: readonly NarrowTab[] = ['waiting', 'conversation', 'tether']
const VIEWS: readonly RegencyView[] = ['desk', 'agent']
/** The shape of a channel id (`c_k3j9x2a`, a desk's channel): short, with no space, slash or quote. */
const ID = /^[A-Za-z0-9_.:-]{1,80}$/

/** Reads the address's query (`location.search`), whatever it holds. Unknown keys and invalid values are dropped. */
export function parseUrlState(search: string): UrlState {
  let q: URLSearchParams
  try { q = new URLSearchParams(search) } catch { return {} }
  const channel = q.get('c')
  const tab = TABS.find(t => t === q.get('tab'))
  const view = VIEWS.find(v => v === q.get('view'))
  const filter = TREE_FILTERS.find(f => f === q.get('filter'))
  return {
    ...(channel !== null && ID.test(channel) ? { channelId: channel } : {}),
    ...(tab ? { narrowTab: tab } : {}),
    ...(view ? { view } : {}),
    ...(filter ? { filter } : {}),
  }
}

/** The query for a state (`''` or `?c=…&tab=…`): what is the default is left out, keys in a fixed order. */
export function formatUrlState(s: UrlState): string {
  const q = new URLSearchParams()
  if (s.channelId !== undefined && ID.test(s.channelId)) q.set('c', s.channelId)
  if (s.narrowTab && s.narrowTab !== DEFAULT_LAYOUT.narrowTab && TABS.includes(s.narrowTab)) q.set('tab', s.narrowTab)
  if (s.view && s.view !== DEFAULT_LAYOUT.view && VIEWS.includes(s.view)) q.set('view', s.view)
  if (s.filter && s.filter !== DEFAULT_LAYOUT.filter && TREE_FILTERS.includes(s.filter)) q.set('filter', s.filter)
  const text = q.toString()
  return text === '' ? '' : `?${text}`
}

/** The part of a layout the address keeps. */
export function urlStateOf(l: Pick<RegencyLayout, 'channelId' | 'narrowTab' | 'view' | 'filter'>): UrlState {
  return { ...(l.channelId !== undefined ? { channelId: l.channelId } : {}), narrowTab: l.narrowTab, view: l.view, filter: l.filter }
}

/** The pane's parameters for a new visit: the defaults with what the address says over them. */
export function paramsOfUrlState(s: UrlState): Record<string, unknown> {
  return { ...(s.channelId !== undefined ? { channelId: s.channelId } : {}), ...(s.narrowTab ? { narrowTab: s.narrowTab } : {}), ...(s.view ? { view: s.view } : {}), ...(s.filter ? { filter: s.filter } : {}) }
}

/**
 * The channel in the centre when the house's channels are first known. The one the address names stands while the house
 * still has it (a closed one included: it reads); one it no longer has, or any when the device cannot read channels, gives
 * way to the default: the open channel that calls the person first, else the first open one (none: no channel).
 */
export function channelOnOpen(
  asked: string | undefined,
  channels: readonly { id: string; closed?: unknown }[],
  calls: (channelId: string) => number,
): string | undefined {
  if (asked !== undefined && channels.some(c => c.id === asked)) return asked
  const open = channels.filter(c => !c.closed)
  return (open.find(c => calls(c.id) > 0) ?? open[0])?.id
}

/**
 * Writes the state in the address of the page, keeping the path and the fragment, with `replaceState` (the Back button does
 * not walk through filters). Nothing is written when the address already says it.
 */
export function writeUrlState(loc: { pathname: string; search: string; hash: string }, hist: { replaceState(data: unknown, unused: string, url: string): void }, s: UrlState): void {
  const search = formatUrlState(s)
  if (search === loc.search) return
  hist.replaceState(null, '', `${loc.pathname}${search}${loc.hash}`)
}
