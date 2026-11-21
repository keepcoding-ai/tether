// `agents give` and `agents revoke`'s shared first steps live here too: only the live owner of the desk a pane sits in gives or
// revokes it (`mayGiveOrRevoke`; the person always may, through the app). The owner of a pane does not pass it on.
// `give` grants `{ owner, givenBy: caller }`; `to: 'self'` makes the pane the agent's own ("de si").
import { slotIsLive } from '../../../../app/shared/agent-info.ts'
import { mayGiveOrRevoke } from '../../rules.ts'
import { capOn, GUIA_PROP, ok, paneName, poolOf, refuse, resolveIn, touch, wantString, type VerbDef, type VerbDeps } from './common.ts'
import type { VerbCaller } from '../../../../src/daemon/ext-api.ts'

/** The pane of a desk the caller owns, resolved by id or name: `not-owner` for anything else, `off` when the desk turned it off. */
export function ownedDeskPane(deps: VerbDeps, caller: VerbCaller, guia: string): string {
  const paneId = resolveIn(deps, poolOf(deps, caller.slotId), guia)
  if (paneId === undefined || !mayGiveOrRevoke(caller.slotId, deps.store.deskOfPane(paneId))) refuse('not-owner', `a guia ${JSON.stringify(guia)} não está numa mesa sua`)
  if (!capOn(deps, 'give-revoke', paneId)) refuse('off', 'dar e revogar guias está desligado nesta mesa')
  return paneId
}

/** A live agent by slot id, or by name when unique. */
function agentNamed(deps: VerbDeps, to: string): string | undefined {
  const agents = deps.api.slots.list().filter((s) => s.kind !== 'shell' && slotIsLive(s)).map((s) => s.slotId)
  return resolveIn(deps, agents, to)
}

export const giveVerb: VerbDef = {
  name: 'give',
  description: "Give one of the panes of your desks to an agent (a live agent, by slot id or name), or to itself with `to: self`: it then commands that pane, and you only see it. The person can take it back at any time.",
  help: 'Dá uma guia da sua mesa a um agente (ou a ela mesma: self).',
  input: { type: 'object', properties: { guia: GUIA_PROP, to: { type: 'string', description: "The agent (slot id or name), or 'self' to make the pane the agent's own." } }, required: ['guia', 'to'] },
  positional: ['guia', 'to'],
  async run(deps, caller, args) {
    const paneId = ownedDeskPane(deps, caller, wantString(args, 'guia'))
    const to = wantString(args, 'to')
    let owner: string | undefined
    if (to === 'self') {
      const slot = deps.api.slots.get(paneId)
      owner = slot && slot.kind !== 'shell' ? paneId : undefined
    } else owner = agentNamed(deps, to)
    if (owner === undefined) refuse('unknown-agent', `não há agente vivo ${to === 'self' ? 'nesta guia' : `chamado ${JSON.stringify(to)}`}`)
    const ownership = await deps.store.givePane(paneId, owner, caller.slotId)
    touch(deps, paneId, caller.slotId, 'give')
    return ok(`Guia ${paneName(deps, paneId)} dada a ${paneName(deps, owner)}.`, { ownership })
  },
}
