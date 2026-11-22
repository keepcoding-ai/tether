// `channels read`: the lines of a channel, for any agent (member or not): what I missed, or the latest ones. Changes no one's state.
import { CANAL_PROP, optFlag, optInt, ok, refOf, resolveChannel, wantString, type VerbDef } from './common.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const readVerb: VerbDef = {
  name: 'read',
  description: 'Read the lines of a channel, member or not. Without `since`: the latest `limit` lines (default 50), and `more` says older ones exist. With `since` (a seq): the lines after it, and `more` says newer ones exist. `end` is the seq of the last line returned: pass it as `since` to go on.',
  help: 'Lê as linhas de um canal (--since N, --limit N).',
  input: {
    type: 'object',
    properties: { canal: CANAL_PROP, since: { type: 'number' }, limit: { type: 'number' }, closed: { type: 'boolean' } },
    required: ['canal'],
  },
  positional: ['canal'],
  async run(deps, _caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'), { closed: optFlag(args, 'closed') })
    const since = optInt(args, 'since')
    const limit = Math.min(Math.max(optInt(args, 'limit') ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const store = deps.channels.store
    const lines = since === undefined ? await store.history(ch.id, undefined, limit) : await store.since(ch.id, since, limit)
    const end = lines.at(-1)?.seq ?? since ?? 0
    const more = since === undefined ? (lines[0]?.seq ?? 1) > 1 : end < (await store.lastSeq(ch.id))
    const text = lines.length === 0
      ? `#${ch.name}: nada novo.`
      : lines.map((l) => `${l.seq} ${l.kind === 'notice' ? '·' : `${l.from.name}${l.to?.length ? ` → ${l.to.join(', ')}` : ''}:`} ${l.body}`).join('\n')
    return ok(text, { channel: refOf(ch), lines, end, more })
  },
}
