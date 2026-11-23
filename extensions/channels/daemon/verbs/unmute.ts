// `channels unmute`: the owner gives a muted member its voice back.
import { AGENT_PROP, CANAL_PROP, nameOfAgent, ok, refOf, resolveAgent, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const unmuteVerb: VerbDef = {
  name: 'unmute',
  description: 'Give a muted member of a channel you own its voice back. `already: true` when it was not muted.',
  help: 'Devolve a voz a um membro calado de um canal seu.',
  input: { type: 'object', properties: { canal: CANAL_PROP, agent: AGENT_PROP }, required: ['canal', 'agent'] },
  positional: ['canal', 'agent'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const id = resolveAgent(deps, wantString(args, 'agent'))
    const name = nameOfAgent(deps, id)
    const done = settle(await deps.channels.unmute(caller.slotId, ch.id, id))
    return ok(done.changed ? `${name} pode falar de novo em #${ch.name}.` : `${name} já podia falar em #${ch.name}.`, { channel: refOf(done.channel), unmuted: { id, name }, already: !done.changed })
  },
}
