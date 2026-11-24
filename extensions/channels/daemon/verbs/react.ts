// `channels react`: a light signal on a line of a channel (a reaction), by its seq. It is not a line to speak: it opens no turn in
// anyone and reaches no one's queue. Anyone in the channel reacts (the muted only with the five); the record keeps it as a line
// of its own.
import { CANAL_PROP, optFlag, optInt, ok, refOf, refuse, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const reactVerb: VerbDef = {
  name: 'react',
  description: 'React to a line of a channel by its `seq`, instead of speaking: `reaction` is one of the five names (`seen` 👀 I saw it, `agree` 👍, `done` ✅, `disagree` ❌, `question` ❓) or one emoji of your own (no agreed meaning). It opens no turn in anyone. `remove: true` takes your reaction back. Only a message among the last 500 lines of an open channel takes a reaction; one reaction per member per emoji.',
  help: 'Reage a uma fala pelo número (seen|agree|done|disagree|question ou um emoji; --remove tira).',
  input: {
    type: 'object',
    properties: {
      canal: CANAL_PROP,
      seq: { type: 'integer', description: 'The seq of the line reacted to.' },
      reaction: { type: 'string', description: 'seen, agree, done, disagree, question, or one emoji.' },
      remove: { type: 'boolean', description: 'Take your reaction back.' },
    },
    required: ['canal', 'seq', 'reaction'],
  },
  positional: ['canal', 'seq', 'reaction'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const seq = optInt(args, 'seq')
    if (seq === undefined) refuse('bad-request', 'seq: número obrigatório')
    const remove = optFlag(args, 'remove')
    const done = settle(await deps.channels.react(caller.slotId, ch.id, { seq, reaction: wantString(args, 'reaction'), remove }))
    const where = `${ch.name}#${seq}`
    const emoji = done.reaction.emoji
    const text = remove
      ? (done.changed ? `Tirou ${emoji} de ${where}.` : `Você não tinha ${emoji} em ${where}.`)
      : (done.changed ? `Reagiu ${emoji} em ${where}.` : `Você já tinha ${emoji} em ${where}.`)
    return ok(text, {
      channel: refOf(ch), ref: where, seq, emoji, ...(done.reaction.name ? { name: done.reaction.name } : {}),
      op: remove ? 'remove' : 'add', changed: done.changed, ...(done.line ? { line: done.line.seq } : {}),
    })
  },
}
