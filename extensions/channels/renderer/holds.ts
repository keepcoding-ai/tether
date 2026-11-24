// What ties an agent to open channels, for the Sessões menu: the bulk close of idle sessions spares a member and stopping it by hand
// asks first. Pure count over the member ids the directory keeps, plus the provider handed to `ui.sessions.hold`.
import type { Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import { memberOfText } from './texts.ts'

/** In how many of the channels (id -> member ids) the agent is a member. */
export function channelsOf(members: ReadonlyMap<string, readonly string[]>, slotId: string): number {
  let n = 0
  for (const ids of members.values()) if (ids.includes(slotId)) n += 1
  return n
}

/** "membro de 2 canais", or undefined when the agent is in none. */
export function heldText(members: ReadonlyMap<string, readonly string[]>, slotId: string): string | undefined {
  const n = channelsOf(members, slotId)
  return n > 0 ? memberOfText(n) : undefined
}

export function holds(ui: TetherUi, memberIds: () => ReadonlyMap<string, readonly string[]>): Disposable[] {
  return [ui.sessions.hold(slotId => heldText(memberIds(), slotId))]
}
