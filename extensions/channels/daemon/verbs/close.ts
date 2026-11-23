// `channels close`: ends a channel I own. The history stays readable; the owner or the person may reopen it. A desk channel
// only follows its desk (`desk`).
import { CANAL_PROP, ok, refOf, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const closeVerb: VerbDef = {
  name: 'close',
  description: 'Close a channel you own. Nobody speaks in it afterwards, its history stays readable and the owner or the person may reopen it. A desk channel is never closed by hand (`desk`).',
  help: 'Encerra um canal seu; o histórico fica legível.',
  input: { type: 'object', properties: { canal: CANAL_PROP }, required: ['canal'] },
  positional: ['canal'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const done = settle(await deps.channels.close(caller.slotId, ch.id))
    return ok(`Canal #${ch.name} encerrado.`, { channel: refOf(done.channel), closed: { at: done.channel.closed?.at ?? done.line.at } })
  },
}
