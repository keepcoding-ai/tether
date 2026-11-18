// What an action bar shows of a menu (app/renderer/action-bar.ts): pure, no DOM, so every view can reuse it.
// The menu always holds every item; pinning only promotes an item out of it, never removes it.
// Pinning is a recommendation, not a limit. The bar is here to give the panes a cohesive look and feel. In the
// tether it is often the person's main line of interaction, so several items may be pinned with text, and one may take the
// accent. The core-ui's "one action with text" is a recommendation for secondary bars. A pane's content area is free and
// takes the structure its content asks for.
import type { ContextMenuEntry, MenuPin } from './ext-api.ts'

export type MenuItem = Exclude<ContextMenuEntry, 'sep'>

export interface ActionBarItems {
  /** At most one: the first item pinned 'highlight' (text and accent). */
  highlight?: MenuItem
  /** Pinned with text, in the menu's order (a second 'highlight' lands here). */
  primary: MenuItem[]
  /** Pinned as icon only, in the menu's order. */
  icon: MenuItem[]
}

/** The pin level an item gets on the bar, after the single-highlight rule; undefined = menu only. */
export function pinOf(entries: readonly ContextMenuEntry[], item: MenuItem): MenuPin | undefined {
  if (!item.pin) return undefined
  if (item.pin !== 'highlight') return item.pin
  const first = entries.find((e): e is MenuItem => e !== 'sep' && e.pin === 'highlight')
  return first === item ? 'highlight' : 'primary'
}

export function actionBarItems(entries: readonly ContextMenuEntry[]): ActionBarItems {
  const out: ActionBarItems = { primary: [], icon: [] }
  for (const e of entries) {
    if (e === 'sep') continue
    const level = pinOf(entries, e)
    if (level === 'highlight') out.highlight = e
    else if (level === 'primary') out.primary.push(e)
    else if (level === 'icon') out.icon.push(e)
  }
  return out
}
