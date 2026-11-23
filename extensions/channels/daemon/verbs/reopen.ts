// `channels reopen`: opens a closed channel again (C7), by its owner or the person; the history goes on. A closed channel is
// found by its id, or by its name with the same resolution as `close`. A desk channel only follows its desk (`desk`).
import { CANAL_PROP, ok, refOf, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const reopenVerb: VerbDef = {
  name: 'reopen',
  description: 'Reopen a closed channel you own (give its id, or its name). A desk channel is never reopened by hand (`desk`); an open one answers `not-closed`.',
  help: 'Reabre um canal encerrado que é seu.',
  input: { type: 'object', properties: { canal: CANAL_PROP }, required: ['canal'] },
  positional: ['canal'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'), { closed: true })
    const done = settle(await deps.channels.reopen(caller.slotId, ch.id))
    return ok(`Canal #${ch.name} reaberto.`, { channel: refOf(done.channel), reopened: { at: done.line.at } })
  },
}
