// The menus that put a tab-less session in a tab, as data (no DOM): the list "Abrir em outra mesa" (the desks, the current
// one marked, a separator and "Escolher o lugar…") shared by the sessions menu, its right-click menu and the peek card.
// main.ts turns the entries into its context-menu rows.
import type { IconName } from './icons.ts'
import { CHOOSE_PLACE_LABEL, deskChoices } from './sessions-rules.ts'

/** One row of a menu a view asks the app to show: a separator, or an item (with an optional submenu one level deep). */
export type MenuSpec =
  | 'sep'
  | { heading: string }
  | { icon: IconName; label: string; run?: () => void; danger?: boolean; checked?: boolean; disabled?: boolean; trail?: string; tip?: string; children?: MenuSpec[] }

/** What a view needs from the app to offer "open on another desk". */
export interface PlaceHost {
  /** The desks of the strip, in order. */
  desks(): readonly { id: string; name: string }[]
  currentDesk(): string
  /** Puts the session in a tab of that desk and leaves the person where they are. */
  openOnDesk(slotId: string, deskId: string): void
  /** Opens the session on the current desk and then the move screen for its tab. */
  choosePlace(slotId: string): void
}

/** The rows of the list: one per desk (the current one checked), a separator, "Escolher o lugar…". `after` runs once a pick is made. */
export function placeEntries(host: PlaceHost, slotId: string, after?: () => void): MenuSpec[] {
  const desks: MenuSpec[] = deskChoices(host.desks(), host.currentDesk()).map(d => ({
    icon: 'squares-four' as IconName,
    label: d.label,
    checked: d.current,
    run: () => { after?.(); host.openOnDesk(slotId, d.id) },
  }))
  return [...desks, 'sep', { icon: 'arrow-square-out' as IconName, label: CHOOSE_PLACE_LABEL, tip: 'Abre a tela de mover para decidir mesa, quadro e lado', run: () => { after?.(); host.choosePlace(slotId) } }]
}
