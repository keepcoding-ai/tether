// `channels join`: I join an open channel (C4), or, as its owner, I join another agent. An agent that was removed does not come
// back alone (`removed`, C18).
import { CANAL_PROP, AGENT_PROP, me, nameOfAgent, ok, optString, refOf, resolveAgent, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const joinVerb: VerbDef = {
  name: 'join',
  description: 'Join an open channel yourself, or (only as its owner) join another agent with `agent`. An agent removed from a channel cannot come back alone: only the owner joins it again (`removed`).',
  help: 'Entra num canal aberto; o dono pode juntar outro agente (<agente>).',
  input: { type: 'object', properties: { canal: CANAL_PROP, agent: AGENT_PROP }, required: ['canal'] },
  positional: ['canal', 'agent'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const ref = optString(args, 'agent')
    const target = ref === undefined ? caller.slotId : resolveAgent(deps, ref)
    const done = settle(await deps.channels.join(caller.slotId, ch.id, target))
    const member = target === caller.slotId ? me(deps, caller) : { id: target, name: nameOfAgent(deps, target) }
    return ok(done.already ? `${member.name} já estava em #${ch.name}.` : `${member.name} entrou em #${ch.name}.`, { channel: refOf(done.channel), member, already: done.already })
  },
}
