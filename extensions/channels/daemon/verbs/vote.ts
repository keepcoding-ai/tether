// `channels vote`: I answer a poll that calls me, by the option's number (accents and spaces break in some shells) or its text,
// with an optional short reason. It is not a line to speak: it opens no turn in anyone. Voting again changes the vote until the
// poll closes; the last one still called voting closes it.
import { stillCalled, tallyText } from '../../rules.ts'
import { CANAL_PROP, hhmm, ok, optInt, optString, refOf, refuse, resolveChannel, settle, wantString, type VerbDef } from './common.ts'

export const voteVerb: VerbDef = {
  name: 'vote',
  description: 'Vote on a poll that calls you: `poll` is its seq, `vote` the option\'s number (or its text), `reason` an optional short why (one line, up to 140 characters; a "não ok" usually deserves one). It opens no turn in anyone: do not also speak to say how you voted. Voting again changes your vote until the poll closes.',
  help: 'Vota numa enquete pelo número da opção (--reason "...").',
  input: {
    type: 'object',
    properties: {
      canal: CANAL_PROP,
      poll: { type: 'integer', description: 'The seq of the poll.' },
      vote: { type: 'string', description: 'The option\'s number (1, 2…) or its text.' },
      reason: { type: 'string', description: 'Why, in one line of up to 140 characters (optional).' },
    },
    required: ['canal', 'poll', 'vote'],
  },
  positional: ['canal', 'poll', 'vote'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const seq = optInt(args, 'poll')
    if (seq === undefined) refuse('bad-request', 'poll: número obrigatório')
    const raw = args.vote
    const vote = typeof raw === 'number' ? raw : wantString(args, 'vote')
    const reason = optString(args, 'reason')
    const done = settle(await deps.channels.vote(caller.slotId, ch.id, { poll: seq, vote, ...(reason !== undefined ? { reason } : {}) }), {
      'slow-down': 'você já trocou o voto 5 vezes nesta enquete',
    })
    const p = done.poll
    const ref = `${ch.name}#${p.seq}`
    const chosen = p.options[done.option - 1]!
    let text: string
    if (done.closed) text = `Votou "${chosen}" em ${ref}; todos votaram e ela fechou: ${tallyText(done.closed.result.tally)}.`
    else {
      const called = stillCalled(ch, p)
      const left = called.filter((t) => !Object.hasOwn(p.votes, t.id)).length
      text = `${done.changed ? 'Votou' : 'Seu voto já era'} "${chosen}" em ${ref}. Faltam ${left} de ${called.length}; fecha às ${hhmm(p.closesAt)}.`
    }
    return ok(text, {
      channel: refOf(ch), ref, poll: p.seq, option: done.option, text: chosen, changed: done.changed,
      ...(done.line ? { line: done.line.seq } : {}),
      ...(done.closed ? { closed: { by: done.closed.result.by, line: done.closed.line.seq, tally: tallyText(done.closed.result.tally) } } : {}),
    })
  },
}
