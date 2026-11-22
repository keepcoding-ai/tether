// `channels remove`: the owner takes a member out. The removed one does not come back alone (C18).
import { AGENT_PROP, CANAL_PROP, nameOfAgent, ok, refOf, resolveAgent, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const removeVerb: VerbDef = {
  name: 'remove',
  description: 'Take a member out of a channel you own. It does not come back alone: only the owner joins it again.',
  help: 'Tira um membro de um canal seu.',
  input: { type: 'object', properties: { canal: CANAL_PROP, agent: AGENT_PROP }, required: ['canal', 'agent'] },
  positional: ['canal', 'agent'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const id = resolveAgent(deps, wantString(args, 'agent'))
    const name = nameOfAgent(deps, id)
    const done = settle(await deps.channels.remove(caller.slotId, ch.id, id))
    return ok(`${name} saiu de #${ch.name}, tirado por você.`, { channel: refOf(done.channel), removed: { id, name } })
  },
}
