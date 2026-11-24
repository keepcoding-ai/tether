// What an agent owns, for the places that must not lose it by accident (the Sessões menu): pure counts over the mirrored
// ownership state, and the provider the extension hands to `ui.sessions.hold`.
import type { Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { MenuFacts } from './menus.ts'
import { readFacts } from './menus.ts'
import { PICK } from './texts.ts'

/** How many desks and panes (other than its own) the agent owns now; an ended ownership is the person's again and counts for nothing. */
export function ownsCount(f: Pick<MenuFacts, 'deskOwner' | 'paneOwner'>, id: string): { mesas: number; guias: number } {
  return {
    mesas: [...f.deskOwner].filter(([, o]) => !o.ended && o.owner === id).length,
    guias: [...f.paneOwner].filter(([pid, o]) => !o.ended && o.owner === id && pid !== id).length,
  }
}

/** "dono de 2 mesas e 1 guia", or undefined when the agent owns nothing. */
export function heldText(f: Pick<MenuFacts, 'deskOwner' | 'paneOwner'>, id: string): string | undefined {
  const o = ownsCount(f, id)
  return o.mesas + o.guias > 0 ? PICK.owns(o.mesas, o.guias) : undefined
}

export function holds(ui: TetherUi): Disposable[] {
  return [ui.sessions.hold(slotId => heldText(readFacts(ui), slotId))]
}
