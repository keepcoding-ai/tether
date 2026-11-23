// `channels leave`: I leave a channel. An owner that leaves abdicates (C16): the channel passes to the person.
import { CANAL_PROP, ok, refOf, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const leaveVerb: VerbDef = {
  name: 'leave',
  description: 'Leave a channel you are in. If you own it, you stop owning it and it passes to the person.',
  help: 'Sai de um canal em que você está.',
  input: { type: 'object', properties: { canal: CANAL_PROP }, required: ['canal'] },
  positional: ['canal'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const done = settle(await deps.channels.leave(caller.slotId, ch.id))
    return ok(`Você saiu de #${ch.name}.`, { channel: refOf(done.channel), left: true })
  },
}
