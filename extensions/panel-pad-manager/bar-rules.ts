// The rule of the action bar at the foot of a card of "Painéis da mesa": which of the guide's menu items are its primaries.
// Pure: panel.ts draws what this picks.
import type { ContextMenuEntry } from '../../app/renderer/ext-api.ts'

export type MenuItem = Exclude<ContextMenuEntry, 'sep'>
export const FOCUS_LABEL = 'Focar guia'
export const CLOSE_LABEL = 'Fechar guia'
/** The bar's limit of primaries. */
export const MAX_PRIMARY = 2

/**
 * The bar's primaries (at most MAX_PRIMARY), by priority: an extension's `highlight` (the one with text and accent: "Devolver a
 * Atrium"), then "Focar guia", then any other `primary`, then "Fechar guia". What does not fit stays in the menu. In the order shown.
 */
export function mainActions(all: readonly MenuItem[]): MenuItem[] {
  const main = all.filter(e => e.pin === 'primary' || e.pin === 'highlight')
  const own = (label: string): MenuItem[] => main.filter(e => e.pin === 'primary' && e.label === label)
  const others = main.filter(e => e.pin === 'primary' && e.label !== FOCUS_LABEL && e.label !== CLOSE_LABEL)
  return [...main.filter(e => e.pin === 'highlight'), ...own(FOCUS_LABEL), ...others, ...own(CLOSE_LABEL)].slice(0, MAX_PRIMARY)
}
