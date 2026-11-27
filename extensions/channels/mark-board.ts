// The rule of the channels' marks (slice U3), shared by the app (renderer/marks.ts) and tetherd (daemon/marks.ts): what the
// person has not read, what is said to her, the reactions that ask her and the polls that wait for her vote. One rule, two
// places that hold it: the app keeps a board live from the daemon's events; tetherd builds one from the lines it keeps when a
// remote device asks (`marks`). Pure: no DOM, no daemon, no node:*.
// Memory: one small map per channel, at most MAX_HELD entries each.
import type { Ask, Line } from './rules.ts'

/** Unseen lines kept per channel (the count stops growing past it). */
export const MAX_HELD = 500

export type Heard = 'plain' | 'toMe'

/** An open poll that calls the person and has no vote of hers: what lights the seal of the channel's tab. */
export interface PollOwed { seq: number; closesAt: string }

const norm = (s: string): string => s.trim().toLowerCase()

/** What a line is to the person: undefined (not counted), a line for everyone, or one addressed to her. */
export function classify(line: Line, moderator: string): Heard | undefined {
  // The opening of a poll is a new speech; its votes and its close are no line of the conversation (never reach here).
  if (line.kind !== 'message' && line.kind !== 'poll') return undefined
  if (line.from.id === 'user' || line.from.role === 'moderator') return undefined
  const me = norm(moderator)
  return (line.to ?? []).some(n => norm(n) === me) ? 'toMe' : 'plain'
}

export interface ChannelMarks {
  /** Unseen lines from agents (the ones to her included). */
  unread: number
  /** Of those, the ones addressed to her. */
  toMe: number
  /** The `seq` of the first unseen line addressed to her. */
  firstToMe?: number
  /** The newest `seq` the person saw. */
  seen: number
}

interface Held {
  seen: number; lines: Map<number, Heard>; asks: Map<number, Ask>; dismissed: Set<number>; owed: Map<number, PollOwed>
  /** What a line to her and a poll ask, by `seq` (who and the first line): what "Esperam você" shows of the call. */
  said: Map<number, Said>
}

/** The first line of what a speech or a poll asks, with who asked. */
export interface Said { from: string; text: string; poll?: true }

/** What the person is asked first in a channel (the oldest call not yet answered): one line, for "Esperam você". */
export interface FirstCall { why: 'to-you' | 'reaction-asks' | 'poll-owed'; text: string }

/** The longest first line kept of a speech (the screen truncates; the tooltip shows what is kept). */
export const SAID_MAX = 240

/** A body's first line that has text, its spaces folded, at most SAID_MAX characters. */
export function firstLineOf(body: string): string {
  const line = body.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).find(l => l !== '') ?? ''
  return line.length > SAID_MAX ? `${line.slice(0, SAID_MAX - 1)}…` : line
}

export class MarkBoard {
  private readonly held = new Map<string, Held>()

  private entry(channelId: string): Held {
    let h = this.held.get(channelId)
    if (!h) { h = { seen: 0, lines: new Map(), asks: new Map(), dismissed: new Set(), owed: new Map(), said: new Map() }; this.held.set(channelId, h) }
    return h
  }

  /**
   * The open polls that wait for her vote, as the daemon counts them now (the whole set replaces the held one: a vote or a close
   * takes the poll out). No "seen" mark clears them: only voting or the close does (a poll she looked at still waits).
   */
  setOwed(channelId: string, owed: readonly PollOwed[]): boolean {
    const h = this.entry(channelId)
    const next = new Map(owed.slice(-MAX_HELD).map(p => [p.seq, p] as const))
    const same = next.size === h.owed.size && [...next.keys()].every(s => h.owed.has(s))
    h.owed = next
    return !same
  }

  owedOf(channelId: string): PollOwed[] {
    const h = this.held.get(channelId)
    return h ? [...h.owed.values()].sort((a, b) => a.seq - b.seq) : []
  }

  /**
   * The reactions that ask the person, as the daemon counts them now (the whole set replaces the held one: a ❓ taken back is gone).
   * What she already saw (up to the "seen" mark, or looked at in place) is not held.
   */
  setAsks(channelId: string, asks: readonly Ask[]): boolean {
    const h = this.entry(channelId)
    const next = new Map(asks.filter(a => a.seq > h.seen && !h.dismissed.has(a.seq)).slice(-MAX_HELD).map(a => [a.seq, a] as const))
    for (const s of [...h.dismissed]) if (!asks.some(a => a.seq === s)) h.dismissed.delete(s)
    const same = next.size === h.asks.size && [...next.keys()].every(s => h.asks.has(s))
    h.asks = next
    return !same
  }

  /**
   * The person has the speech of an ask on her screen. Returns `persist` (the "seen" mark is raised to the ask: nothing unseen lies
   * below it, so no other line or ask is hidden by it) or only forgets it for this session.
   */
  attended(channelId: string, seq: number): { changed: boolean; persist: boolean } {
    const h = this.held.get(channelId)
    if (!h || !h.asks.has(seq)) return { changed: false, persist: false }
    const clear = [...h.lines.keys(), ...h.asks.keys()].every(s => s >= seq)
    if (clear) { this.raise(h, seq); return { changed: true, persist: true } }
    h.asks.delete(seq)
    h.dismissed.add(seq)
    return { changed: true, persist: false }
  }

  /** The channel's `seenByUser` from the daemon: lines up to it are not news. Returns whether the marks changed. */
  baseline(channelId: string, seen: number): boolean { return this.raise(this.entry(channelId), seen) }

  /** A line heard live or read from the history; a repeat or an old one changes nothing. */
  hear(channelId: string, line: Line, moderator: string): boolean {
    const kind = classify(line, moderator)
    const h = this.entry(channelId)
    // A poll's question is kept even when its line is old: the poll still waits for her vote after she saw it.
    if (kind !== undefined && line.kind === 'poll' && line.poll) this.keepSaid(h, line.seq, { from: line.from.name, text: firstLineOf(line.poll.question), poll: true })
    if (kind === undefined || line.seq <= h.seen || h.lines.get(line.seq) === kind) return false
    if (kind === 'toMe' && line.kind === 'message') this.keepSaid(h, line.seq, { from: line.from.name, text: firstLineOf(line.body) })
    h.lines.set(line.seq, kind)
    if (h.lines.size > MAX_HELD) {
      let min = Infinity
      for (const s of h.lines.keys()) if (s < min) min = s
      h.lines.delete(min)
    }
    return true
  }

  /** A page of the history over what is held (the lines the app missed while it was closed). */
  load(channelId: string, lines: readonly Line[], seenByUser: number, moderator: string): boolean {
    let changed = this.baseline(channelId, seenByUser)
    for (const l of lines) if (this.hear(channelId, l, moderator)) changed = true
    return changed
  }

  /** The person saw the conversation up to `seq`. Returns whether the marks changed. */
  viewed(channelId: string, seq: number): boolean { return this.raise(this.entry(channelId), seq) }

  private raise(h: Held, seq: number): boolean {
    if (seq <= h.seen) return false
    h.seen = seq
    for (const s of [...h.lines.keys()]) if (s <= seq) h.lines.delete(s)
    for (const s of [...h.asks.keys()]) if (s <= seq) h.asks.delete(s)
    for (const [s, said] of [...h.said]) if (s <= seq && !said.poll) h.said.delete(s)
    return true
  }

  of(channelId: string): ChannelMarks {
    const h = this.held.get(channelId)
    if (!h) return { unread: 0, toMe: 0, seen: 0 }
    let toMe = 0
    let first: number | undefined
    for (const [seq, kind] of h.lines) if (kind === 'toMe') { toMe++; if (first === undefined || seq < first) first = seq }
    return { unread: h.lines.size, toMe, ...(first !== undefined ? { firstToMe: first } : {}), seen: h.seen }
  }

  /** The reactions that ask her and she has not seen, oldest first (kept apart from the lines: they are no speech of an agent). */
  asksOf(channelId: string): Ask[] {
    const h = this.held.get(channelId)
    return h ? [...h.asks.values()].sort((a, b) => a.seq - b.seq) : []
  }

  forget(channelId: string): void { this.held.delete(channelId) }

  /**
   * The oldest call she has not answered in the channel, in one line: a speech to her ("conferente: Posso seguir?"), a reaction
   * that asks her ("conferente reagiu ❓ a uma fala sua") or a poll that waits for her vote ("Enquete de conferente: Qual?").
   */
  firstCall(channelId: string): FirstCall | undefined {
    const h = this.held.get(channelId)
    if (!h) return undefined
    const calls: { seq: number; call: FirstCall }[] = []
    for (const [seq, kind] of h.lines) {
      if (kind !== 'toMe' || h.said.get(seq)?.poll) continue
      const s = h.said.get(seq)
      calls.push({ seq, call: { why: 'to-you', text: s ? `${s.from}: ${s.text}` : 'uma fala para você' } })
    }
    for (const a of h.asks.values()) calls.push({ seq: a.seq, call: { why: 'reaction-asks', text: `${a.by} reagiu ${a.emoji} a uma fala sua` } })
    for (const p of h.owed.values()) {
      const s = h.said.get(p.seq)
      calls.push({ seq: p.seq, call: { why: 'poll-owed', text: s ? `Enquete de ${s.from}: ${s.text}` : 'Uma enquete espera o seu voto' } })
    }
    calls.sort((x, y) => x.seq - y.seq)
    return calls[0]?.call
  }

  private keepSaid(h: Held, seq: number, said: Said): void {
    h.said.set(seq, said)
    if (h.said.size <= MAX_HELD) return
    // The oldest goes, unless it is a poll still waiting for her vote.
    for (const s of [...h.said.keys()].sort((a, b) => a - b)) {
      if (h.said.size <= MAX_HELD) break
      if (!h.owed.has(s)) h.said.delete(s)
    }
  }
}
