// `agents revoke`: takes back the pane's own owner, from any pane of a desk the caller owns (also one the person gave to another
// agent: `givenBy` stays in sight; decision F4). The pane then falls back to the desk's owner.
import { ownedDeskPane } from './give.ts'
import { GUIA_PROP, ok, paneName, touch, wantString, type VerbDef } from './common.ts'

export const revokeVerb: VerbDef = {
  name: 'revoke',
  description: 'Take back a pane you had given to an agent (or that the person gave to one) in one of your desks: it returns to your command. Refuses with `not-given` when the pane has no owner of its own.',
  help: 'Retira a posse própria de uma guia da sua mesa.',
  input: { type: 'object', properties: { guia: GUIA_PROP }, required: ['guia'] },
  positional: ['guia'],
  async run(deps, caller, args) {
    const paneId = ownedDeskPane(deps, caller, wantString(args, 'guia'))
    await deps.store.revokePane(paneId, caller.slotId)
    touch(deps, paneId, caller.slotId, 'revoke')
    return ok(`Guia ${paneName(deps, paneId)} de volta ao seu comando.`, { ownership: null })
  },
}
