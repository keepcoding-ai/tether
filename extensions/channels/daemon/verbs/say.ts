// `channels say`: I speak in a channel I am in. Every member hears it; `to` only marks whom it addresses (P8). It never waits for
// the delivery: the result says what became of the line for each member.
import { isMember, sayRefusal, USER } from '../../rules.ts'
import { CANAL_PROP, ok, optInt, optStrings, refOf, refuse, resolveChannel, settle, wantString, type VerbDef, type VerbDeps } from './common.ts'
import type { Channel } from '../../rules.ts'

/** The names a line addresses: the person (`usuário`, or the moderator's name) or a member, by id or name. Anything else is `unknown-member`. */
function addressees(deps: VerbDeps, ch: Channel, refs: readonly string[]): string[] {
  const moderator = deps.channels.nameOf(USER)
  const out: string[] = []
  for (const ref of refs) {
    let name: string | undefined
    if (ref === moderator || ref.toLowerCase() === 'usuário' || ref.toLowerCase() === 'usuario') name = moderator
    else if (isMember(ch, ref)) name = deps.channels.nameOf(ref)
    else {
      const hits = Object.keys(ch.members).filter((id) => deps.channels.nameOf(id) === ref)
      if (hits.length > 1) refuse('ambiguous', `mais de um membro se chama ${JSON.stringify(ref)}`, { options: hits.map((id) => ({ id, name: ref })) })
      if (hits.length === 1) name = ref
    }
    if (name === undefined) refuse('unknown-member', `${JSON.stringify(ref)} não é membro do canal nem a pessoa`)
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export const sayVerb: VerbDef = {
  name: 'say',
  description: 'Speak in a channel you are in. Every member hears it; `to` (a list of member names or ids, or `usuário` for the person) only marks whom it addresses; `reply` is the seq of the line it answers. Returns at once with what became of the line for each member (`inside`, `typed`, `queued`, `away`). A muted member does not speak (`muted`).',
  help: 'Fala num canal em que você está (--to A --to usuário, --reply N).',
  input: {
    type: 'object',
    properties: { canal: CANAL_PROP, text: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, reply: { type: 'integer' } },
    required: ['canal', 'text'],
  },
  positional: ['canal', 'text'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const text = wantString(args, 'text')
    const refs = optStrings(args, 'to')
    const reply = optInt(args, 'reply')
    // Who may speak comes first, so a stranger learns `not-member` and not something about the members.
    const refusal = sayRefusal(caller.slotId, ch)
    if (refusal) refuse(refusal, refusal === 'closed' ? 'o canal está encerrado' : refusal === 'muted' ? 'você está calado neste canal' : 'o agente não está no canal')
    const to = refs?.length ? addressees(deps, ch, refs) : undefined
    const done = settle(await deps.channels.say(caller.slotId, ch.id, { body: text, ...(to ? { to } : {}), ...(reply !== undefined ? { replyTo: reply } : {}) }))
    const delivered = Object.entries(done.receipts).map(([id, state]) => ({ id, name: deps.channels.nameOf(id), state }))
    return ok(`Falou em #${ch.name} (${done.line.seq}).`, { channel: refOf(ch), ref: `${ch.name}#${done.line.seq}`, seq: done.line.seq, delivered })
  },
}
