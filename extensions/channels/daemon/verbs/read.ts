// `channels read`: the lines of a channel, for any agent (member or not): what I missed, or the latest ones. Changes no one's state.
// Reaction lines are not shown as lines: each message carries the sum of its reactions (`[👍 Guga, codex · ❓ soul]`), and with
// `since` a last line tells the new reactions to messages before the stretch.
import { REACTION_WINDOW, sumReactions, type Line, type ReactionTally } from '../../rules.ts'
import { CANAL_PROP, optFlag, optInt, ok, refOf, resolveChannel, wantString, type VerbDef } from './common.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const pills = (tallies: readonly ReactionTally[]): string => tallies.map((t) => `${t.emoji} ${t.by.map((b) => b.name).join(', ')}`).join(' · ')

export const readVerb: VerbDef = {
  name: 'read',
  description: 'Read the lines of a channel, member or not. Without `since`: the latest `limit` lines (default 50), and `more` says older ones exist. With `since` (a seq): the lines after it, and `more` says newer ones exist. `end` is the seq of the last line returned: pass it as `since` to go on. A message that got reactions shows them in brackets (and as `reactions`); a reaction takes a seq of its own, so message numbers may skip. With `since`, `earlier` lists the new reactions to messages before the stretch.',
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
    const raw = since === undefined ? await store.history(ch.id, undefined, limit) : await store.since(ch.id, since, limit)
    const end = raw.at(-1)?.seq ?? since ?? 0
    const more = since === undefined ? (raw[0]?.seq ?? 1) > 1 : end < (await store.lastSeq(ch.id))
    // A reaction to a message of the stretch can only sit within REACTION_WINDOW lines after it: read that much past the end.
    const after: Line[] = raw.some((l) => l.kind === 'message') ? await store.since(ch.id, end, REACTION_WINDOW) : []
    const sums = sumReactions([...raw, ...after])
    const shown = raw.filter((l) => l.kind !== 'reaction')
    // The new reactions in the stretch to messages before it (only when reading from a point on).
    const earlier = new Map<number, Array<{ emoji: string; name: string }>>()
    if (since !== undefined) {
      for (const l of raw) {
        if (l.kind !== 'reaction' || !l.react || l.react.op !== 'add' || l.react.seq > since) continue
        const list = earlier.get(l.react.seq) ?? []
        list.push({ emoji: l.react.emoji, name: l.from.name })
        earlier.set(l.react.seq, list)
      }
    }
    const row = (l: Line): string => {
      const head = l.kind === 'notice' ? '·' : `${l.from.name}${l.to?.length ? ` → ${l.to.join(', ')}` : ''}:`
      const tallies = l.kind === 'message' ? sums.get(l.seq) : undefined
      return `${l.seq} ${head} ${l.body}${tallies?.length ? `  [${pills(tallies)}]` : ''}`
    }
    const rows = shown.map(row)
    const earlierText = [...earlier].map(([seq, list]) => `${seq} ${list.map((e) => `${e.emoji} ${e.name}`).join(', ')}`).join('; ')
    if (earlierText) rows.push(`reações novas em falas anteriores: ${earlierText}`)
    const text = rows.length === 0 ? `#${ch.name}: nada novo.` : rows.join('\n')
    const lines = shown.map((l) => {
      const tallies = l.kind === 'message' ? sums.get(l.seq) : undefined
      return tallies?.length ? { ...l, reactions: tallies.map((t) => ({ emoji: t.emoji, ...(t.name ? { name: t.name } : {}), by: t.by.map((b) => b.name) })) } : l
    })
    return ok(text, {
      channel: refOf(ch), lines, end, more,
      ...(earlier.size ? { earlier: [...earlier].map(([seq, list]) => ({ seq, reactions: list })) } : {}),
    })
  },
}
