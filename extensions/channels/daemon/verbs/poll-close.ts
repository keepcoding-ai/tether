// `channels poll-close`: the author of a poll (or the person) closes it before its deadline. The result is a line of the channel.
import { tallyText } from '../../rules.ts'
import { CANAL_PROP, ok, optInt, refOf, refuse, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const pollCloseVerb: VerbDef = {
  name: 'poll-close',
  description: 'Close a poll you opened before its deadline (`poll` is its seq). Those called who did not vote come out as "sem resposta".',
  help: 'Encerra uma enquete sua antes do prazo.',
  input: {
    type: 'object',
    properties: { canal: CANAL_PROP, poll: { type: 'integer', description: 'The seq of the poll.' } },
    required: ['canal', 'poll'],
  },
  positional: ['canal', 'poll'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const seq = optInt(args, 'poll')
    if (seq === undefined) refuse('bad-request', 'poll: número obrigatório')
    const done = settle(await deps.channels.pollClose(caller.slotId, ch.id, seq))
    const ref = `${ch.name}#${seq}`
    return ok(`Encerrou ${ref}: ${tallyText(done.result.tally)}.`, {
      channel: refOf(ch), ref, poll: seq, line: done.line.seq, by: done.result.by, tally: tallyText(done.result.tally),
      missing: done.result.missing.map((m) => ({ name: m.name, why: m.why })),
    })
  },
}
