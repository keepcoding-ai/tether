// `channels read`: the lines of a channel, for any agent (member or not): what I missed, or the latest ones. Changes no one's state.
// Reaction lines are not shown as lines: each message carries the sum of its reactions (`[👍 Guga, codex · ❓ soul]`), and with
// `since` a last line tells the new reactions to messages before the stretch. A poll shows in its own line with its state now
// (open: the votes and who is still missing; closed: the result); votes are not lines (they take a number, like a reaction);
// the close is the tether's line with the tally. Who owes a vote in the channel reads it at the end.
import {
  closedByText, missingText, owedPolls, pollTally, REACTION_WINDOW, stillCalled, sumReactions, tallyText, votersText,
  type Channel, type Line, type PollResult, type PollTally, type ReactionTally,
} from '../../rules.ts'
import type { ChannelStore } from '../store.ts'
import { CANAL_PROP, hhmm, optFlag, optInt, ok, refOf, resolveChannel, wantString, type VerbDef } from './common.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const pills = (tallies: readonly ReactionTally[]): string => tallies.map((t) => `${t.emoji} ${t.by.map((b) => b.name).join(', ')}`).join(' · ')

/** A poll's state as `read` shows it: open (votes now, who is missing), closed (its result), or closed long ago (`result` unknown). */
type PollState =
  | { state: 'open'; tally: PollTally[]; waiting: string[] }
  | { state: 'closed'; result?: PollResult }

/**
 * The state of each poll line among `shown`: the index for an open one; for a closed one its result line, found among `near`
 * (the stretch and what follows it) or where the index says the last closed ones are (one line read each, never a scan).
 */
async function pollStates(store: ChannelStore, ch: Channel, shown: readonly Line[], near: readonly Line[]): Promise<Map<number, PollState>> {
  const out = new Map<number, PollState>()
  const results = new Map<number, PollResult>()
  for (const l of near) if (l.kind === 'notice' && l.event?.type === 'poll-close' && l.result) results.set(l.result.poll, l.result)
  for (const l of shown) {
    if (l.kind !== 'poll') continue
    const open = ch.polls?.[String(l.seq)]
    if (open) {
      out.set(l.seq, { state: 'open', tally: pollTally(open), waiting: stillCalled(ch, open).filter((t) => !Object.hasOwn(open.votes, t.id)).map((t) => t.name) })
      continue
    }
    let result = results.get(l.seq)
    const at = result ? undefined : ch.pollsClosed?.find((c) => c.poll === l.seq)?.line
    if (at !== undefined) result = (await store.since(ch.id, at - 1, 1)).find((x) => x.seq === at)?.result
    out.set(l.seq, { state: 'closed', ...(result ? { result } : {}) })
  }
  return out
}

/** `57 atrium → nic, bancada: [enquete · aberta · fecha 10:42] Posso…?  [ok 2: nic, Guga · não ok 1: bancada · faltam: conferência]` */
function pollRow(l: Line, s: PollState | undefined): string {
  const p = l.poll!
  const head = `${l.seq} ${l.from.name} → ${p.to.map((t) => t.name).join(', ')}:`
  if (s?.state === 'open') {
    const parts = [votersText(s.tally), s.waiting.length ? `faltam: ${s.waiting.join(', ')}` : ''].filter(Boolean)
    return `${head} [enquete · aberta · fecha ${hhmm(p.closesAt)} · ${p.options.map((o, i) => `${i + 1} ${o}`).join(', ')}] ${p.question}${parts.length ? `  [${parts.join(' · ')}]` : ''}`
  }
  const r = s?.state === 'closed' ? s.result : undefined
  if (!r) return `${head} [enquete · fechada] ${p.question}`
  const parts = [votersText(r.tally) || 'nenhum voto', missingText(r.missing)].filter(Boolean)
  return `${head} [enquete · fechada · ${closedByText(r)}] ${p.question}  [${parts.join(' · ')}]`
}

export const readVerb: VerbDef = {
  name: 'read',
  description: 'Read the lines of a channel, member or not. Without `since`: the latest `limit` lines (default 50), and `more` says older ones exist. With `since` (a seq): the lines after it, and `more` says newer ones exist. `end` is the seq of the last line returned: pass it as `since` to go on. A message that got reactions shows them in brackets (and as `reactions`); a reaction takes a seq of its own, so message numbers may skip. With `since`, `earlier` lists the new reactions to messages before the stretch. A poll shows its votes now, or its result once closed; `owed` lists the open polls waiting for your vote.',
  help: 'Lê as linhas de um canal (--since N, --limit N).',
  input: {
    type: 'object',
    properties: { canal: CANAL_PROP, since: { type: 'number' }, limit: { type: 'number' }, closed: { type: 'boolean' } },
    required: ['canal'],
  },
  positional: ['canal'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'), { closed: optFlag(args, 'closed') })
    const since = optInt(args, 'since')
    const limit = Math.min(Math.max(optInt(args, 'limit') ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const store = deps.channels.store
    const raw = since === undefined ? await store.history(ch.id, undefined, limit) : await store.since(ch.id, since, limit)
    const end = raw.at(-1)?.seq ?? since ?? 0
    const more = since === undefined ? (raw[0]?.seq ?? 1) > 1 : end < (await store.lastSeq(ch.id))
    // A reaction to a message of the stretch can only sit within REACTION_WINDOW lines after it: read that much past the end.
    // A poll of the stretch finds its result there too, when it closed that near.
    const after: Line[] = raw.some((l) => l.kind === 'message' || l.kind === 'poll') ? await store.since(ch.id, end, REACTION_WINDOW) : []
    const sums = sumReactions([...raw, ...after])
    const shown = raw.filter((l) => l.kind !== 'reaction' && l.kind !== 'vote')
    const polls = await pollStates(deps.channels.store, ch, shown, [...raw, ...after])
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
      if (l.kind === 'poll' && l.poll) return pollRow(l, polls.get(l.seq))
      if (l.kind === 'notice' && l.event?.type === 'poll-close' && l.result) return `${l.seq} tether: [enquete ${l.result.poll} fechou · ${closedByText(l.result)}] ${tallyText(l.result.tally)}`
      const head = l.kind === 'notice' ? '·' : `${l.from.name}${l.to?.length ? ` → ${l.to.join(', ')}` : ''}:`
      const tallies = l.kind === 'message' ? sums.get(l.seq) : undefined
      return `${l.seq} ${head} ${l.body}${tallies?.length ? `  [${pills(tallies)}]` : ''}`
    }
    const rows = shown.map(row)
    const earlierText = [...earlier].map(([seq, list]) => `${seq} ${list.map((e) => `${e.emoji} ${e.name}`).join(', ')}`).join('; ')
    if (earlierText) rows.push(`reações novas em falas anteriores: ${earlierText}`)
    const owed = owedPolls(ch, caller.slotId)
    if (owed.length) rows.push(`enquetes esperando seu voto: ${owed.map((p) => `${p.seq} (fecha ${hhmm(p.closesAt)}; ${p.options.map((o, i) => `${i + 1} ${o}`).join(', ')})`).join('; ')}`)
    const text = rows.length === 0 ? `#${ch.name}: nada novo.` : rows.join('\n')
    const lines = shown.map((l) => {
      if (l.kind === 'poll') {
        const s = polls.get(l.seq)
        return s ? { ...l, pollState: s } : l
      }
      const tallies = l.kind === 'message' ? sums.get(l.seq) : undefined
      return tallies?.length ? { ...l, reactions: tallies.map((t) => ({ emoji: t.emoji, ...(t.name ? { name: t.name } : {}), by: t.by.map((b) => b.name) })) } : l
    })
    return ok(text, {
      channel: refOf(ch), lines, end, more,
      ...(earlier.size ? { earlier: [...earlier].map(([seq, list]) => ({ seq, reactions: list })) } : {}),
      ...(owed.length ? { owed: owed.map((p) => ({ poll: p.seq, closesAt: p.closesAt, options: p.options })) } : {}),
    })
  },
}
