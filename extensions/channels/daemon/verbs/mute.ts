// `channels mute`: the owner silences a member. A muted member still hears; it cannot speak.
import { AGENT_PROP, CANAL_PROP, nameOfAgent, ok, refOf, resolveAgent, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const muteVerb: VerbDef = {
  name: 'mute',
  description: 'Mute a member of a channel you own: it still hears, but cannot speak. `already: true` when it was muted.',
  help: 'Cala um membro de um canal seu (ele continua ouvindo).',
  input: { type: 'object', properties: { canal: CANAL_PROP, agent: AGENT_PROP }, required: ['canal', 'agent'] },
  positional: ['canal', 'agent'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const id = resolveAgent(deps, wantString(args, 'agent'))
    const name = nameOfAgent(deps, id)
    const done = settle(await deps.channels.mute(caller.slotId, ch.id, id))
    return ok(done.changed ? `${name} está calado em #${ch.name}.` : `${name} já estava calado em #${ch.name}.`, { channel: refOf(done.channel), muted: { id, name }, already: !done.changed })
  },
}
