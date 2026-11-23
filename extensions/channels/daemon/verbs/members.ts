// `channels members`: who is in a channel, whether each one runs and by which path a line reaches it.
import { slotIsLive } from '../../../../app/shared/agent-info.ts'
import { CANAL_PROP, nameOfAgent, optFlag, ownerRow, ok, refOf, resolveChannel, wantString, type VerbDef } from './common.ts'

export const membersVerb: VerbDef = {
  name: 'members',
  description: 'Show who is in a channel: owner and members, with whether each is muted, since when and by whom it joined, whether its pane runs and the path a line takes to it (`inside`, `terminal`, `wait`, or `away` when it does not run).',
  help: 'Mostra quem está no canal e por onde cada um ouve.',
  input: { type: 'object', properties: { canal: CANAL_PROP, closed: { type: 'boolean' } }, required: ['canal'] },
  positional: ['canal'],
  async run(deps, _caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'), { closed: optFlag(args, 'closed') })
    const rows = Object.entries(ch.members).map(([id, m]) => {
      const slot = deps.api.slots.get(id)
      const alive = slot !== undefined && slotIsLive(slot)
      return {
        id, name: nameOfAgent(deps, id), kind: slot?.kind ?? 'gone', muted: m.muted !== undefined,
        since: m.since, by: m.by, alive, path: alive ? deps.api.delivery.routeOf(id) : 'away',
      }
    })
    const owner = ownerRow(deps, ch)
    const text = [`#${ch.name}${ch.closed ? ' (encerrado)' : ''}, dono ${owner.name}`, ...rows.map((r) => `- ${r.name} (${r.id})${r.muted ? ' calado' : ''}, ${r.path}`)].join('\n')
    return ok(text, { channel: refOf(ch), owner, members: rows })
  },
}
