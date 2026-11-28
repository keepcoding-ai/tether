// The person talking from afar (RR4 step 4.2b): the five writes of a channel (channels.say, react, vote, poll, seen) over
// the session the device holds now, with what makes them safe to do from a phone in a train. Every act has one actId,
// kept until its answer, and the same id goes again when the answer did not come (the portal answers a repeat with the
// real outcome, never by doing it twice). A speech is in the outbox from the tap on: it shows as "enviando" at once,
// becomes "enviada" with its seq, and leaves when the conversation holds it; a cut or a "timeout" resends it by itself when
// the session is back; a refusal for good leaves it "não enviada" with "Tentar de novo", the text kept. The outbox and the
// draft of each channel are the person's own text, kept in this origin's storage (localStorage, every access guarded):
// they survive a reload and another tab of the same device taking over; nothing of the house is written there.
// The rules (what an answer means, the ceilings, the lanes) are talk-rules.ts; this file holds the state and the timers.
import { fromHex, opByName, randomBytes, toHex, type Bytes } from '../../../src/remote/index.ts'
import type { PollState } from '../../../extensions/channels/daemon/requests.ts'
import type { Reply } from './live.ts'
import { pollStateOf } from './source.ts'
import {
  checkSay, confirmUpTo, expire, FIRST_REPLY_MS, HOLD_TEXT, parseDrafts, parseOutbox, patchItem, pushItem, reactionOk, reasonOf,
  SEEN_LANE, seenDone, seenTake, seenWant, serializeDrafts, serializeOutbox, stepOf, toResend, withDraft,
  type OutItem, type ReplyStep, type SeenLane,
} from './talk-rules.ts'

const OP = {
  say: opByName('channels.say')!.code,
  react: opByName('channels.react')!.code,
  vote: opByName('channels.vote')!.code,
  poll: opByName('channels.poll')!.code,
  seen: opByName('channels.seen')!.code,
}

/** How long a reaction, a vote or a poll waits for a session and an answer before it gives up ("timeout"). */
export const ACT_DEADLINE_MS = 45_000
/** The wait before asking again when the device's own wait ran out but the session stands. */
const AGAIN_MS = 2_000
/** The short delay that coalesces the "seen" of a burst of lines (the app's marks wait the same before they write). */
export const SEEN_DELAY_MS = 250
/**
 * The least time between two "seen" of one channel: a conversation that keeps coming is told every so often, not line by
 * line (the portal counts every request of the device against one budget a minute, the readings' too).
 */
export const SEEN_SPACING_MS = 2_000

/** What the talker needs of a session: one request with its actId, and whether it ended. */
export interface TalkSession {
  request(op: number, body: Record<string, unknown>, o?: { actId?: Bytes }): Promise<Reply>
  readonly ended: unknown
}

/** A few strings by key (localStorage in the page; a map in a test). Every method may fail: the callers guard. */
export interface KeyValue { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }

/** This origin's localStorage, guarded: a browser that refuses it (private mode, a full disk) keeps the text in memory. */
export const browserStore = (): KeyValue => ({
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* the memory copy stands */ } },
  remove: k => { try { localStorage.removeItem(k) } catch { /* nothing to remove */ } },
})

/** What an act threw: `code` is what the shared screen words (reactions.ts, polls.ts); `message` is what the box shows. */
export class TalkRefused extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.name = 'TalkRefused'
    this.code = code
  }
}

/** A change the screen tells aloud: a speech that went, or did not. */
export type TalkNews = { channel: string; what: 'sent' | 'failed' | 'changed' }

export interface Talker {
  /** A session is up and unlocked: acts go through it, and what waited is sent again with its own actId. */
  attach(s: TalkSession): void
  /** The session is gone (cut, locked, another tab): nothing is sent until the next one. */
  detach(): void
  /** A speech. Resolves once it is on its way (or went); rejects with TalkRefused when the box must keep the text. */
  say(channel: string, text: string, to: readonly string[]): Promise<void>
  /** A reaction (put or taken off). Resolves with the portal's answer (`changed`). */
  react(channel: string, seq: number, reaction: string, remove: boolean): Promise<{ changed: boolean }>
  /** A vote. Resolves in the shape the card reads: the poll open with the votes now, or its result. */
  vote(channel: string, poll: number, vote: number, reason?: string): Promise<{ poll?: NonNullable<PollState['open']>; result?: PollState['result']; closedAt?: string }>
  /** Opens a poll. */
  poll(channel: string, args: { question: string; options?: readonly string[]; to?: readonly string[]; timeoutMs?: number }): Promise<{ seq: number }>
  /** The view sees the conversation up to `seq`: the house is told, once, a moment later. */
  seen(channel: string, seq: number): void
  /** The speeches of a channel on their way, in the order they were said. */
  items(channel: string): readonly OutItem[]
  /** "Tentar de novo": a speech that did not go goes again, as a new act. */
  retry(id: string): void
  /** "Editar": the speech leaves the outbox and its text is given back (for the box). */
  take(id: string): OutItem | undefined
  draft(channel: string): string
  setDraft(channel: string, text: string): void
  /** A page of the channel came up to `last`: what landed there leaves the outbox (the conversation shows it). */
  confirmed(channel: string, last: number): void
  onChange(listener: (n: TalkNews) => void): { dispose(): void }
  /** An act was answered "trancado": the screen asks for presence (the talker detached itself). */
  onLocked: () => void
  /** The device was revoked: the outbox and the drafts go. */
  forget(): void
  dispose(): void
}

export interface TalkerOptions {
  /** The house the text belongs to (the record's id): the keys of the storage. */
  houseId: string
  store?: KeyValue
  now?: () => number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

const hex = (b: Bytes): string => toHex(b)
const bytesOf = (h: string): Bytes => fromHex(h)

export function createTalker(o: TalkerOptions): Talker {
  const store = o.store ?? browserStore()
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const keyOut = `tether.remote.v1.${o.houseId}.outbox`
  const keyDrafts = `tether.remote.v1.${o.houseId}.drafts`
  const listeners = new Set<(n: TalkNews) => void>()
  let session: TalkSession | undefined
  let disposed = false
  /** The memory copy of what the storage holds: the source of truth while this tab holds the house. */
  let items: OutItem[] = []
  let drafts: Record<string, string> = {}
  const inFlight = new Set<string>()
  const timers = new Set<unknown>()
  const seenLanes = new Map<string, SeenLane>()
  const seenTimers = new Map<string, unknown>()
  /** When each channel's last "seen" left. */
  const seenAt = new Map<string, number>()
  /** The acts waiting for a session (a reaction, a vote, a poll): woken by attach. */
  const waiters = new Set<() => void>()

  const read = (): void => {
    try { items = parseOutbox(store.get(keyOut)) } catch { /* keep the memory copy */ }
    try { drafts = parseDrafts(store.get(keyDrafts)) } catch { /* keep the memory copy */ }
  }
  const saveItems = (): void => { try { store.set(keyOut, serializeOutbox(items)) } catch { /* the memory copy stands */ } }
  const saveDrafts = (): void => { try { store.set(keyDrafts, serializeDrafts(drafts)) } catch { /* the memory copy stands */ } }
  read()

  const emit = (n: TalkNews): void => { for (const l of [...listeners]) { try { l(n) } catch (e) { console.error('talk listener', e) } } }
  const later = (f: () => void, ms: number): void => {
    const t = setTimer(() => { timers.delete(t); if (!disposed) f() }, ms)
    timers.add(t)
  }
  const live = (): TalkSession | undefined => (session && !session.ended ? session : undefined)
  const locked = (): void => { session = undefined; talker.onLocked() }

  // ---- the speeches

  const find = (id: string): OutItem | undefined => items.find(x => x.id === id)

  /** Sends a speech once with its own actId; undefined when no session is up (it waits for the next). */
  const sendOnce = async (item: OutItem): Promise<ReplyStep | undefined> => {
    const s = live()
    if (!s || inFlight.has(item.id)) return undefined
    inFlight.add(item.id)
    try {
      const r = await s.request(OP.say, { channel: item.channel, text: item.text, ...(item.to.length ? { to: item.to } : {}) }, { actId: bytesOf(item.id) })
      return stepOf(r)
    } finally { inFlight.delete(item.id) }
  }

  /** What an answer does to a speech that is still waiting (an edit or a retry may have taken it meanwhile). */
  const apply = (id: string, step: ReplyStep | undefined): void => {
    const item = find(id)
    if (!item || item.state !== 'sending' || disposed || !step) return
    switch (step.do) {
      case 'done': {
        const seq = typeof step.body.seq === 'number' && Number.isSafeInteger(step.body.seq) && step.body.seq >= 1 ? step.body.seq : undefined
        items = patchItem(items, id, { state: 'sent', ...(seq !== undefined ? { seq } : {}) })
        saveItems()
        emit({ channel: item.channel, what: 'sent' })
        return
      }
      case 'hold':
      case 'fail':
        items = patchItem(items, id, { state: 'failed', why: step.code })
        saveItems()
        emit({ channel: item.channel, what: 'failed' })
        return
      case 'resend':
        later(() => { void sendOnce(item).then(s => apply(id, s)) }, step.afterMs)
        return
      case 'wait-session':
        // The session stands but gave no answer in the device's wait: ask again in a moment. A session that ended: attach resends.
        if (live()) later(() => { void sendOnce(item).then(s => apply(id, s)) }, AGAIN_MS)
        return
      case 'locked':
        locked()
    }
  }

  /** What waited is sent again, one after the other, each with its own actId; what waited too long is the person's to decide. */
  const resendAll = async (): Promise<void> => {
    const t = now()
    const before = items
    items = expire(items, t)
    if (items.some((x, i) => x !== before[i])) { saveItems(); for (const c of new Set(items.map(x => x.channel))) emit({ channel: c, what: 'changed' }) }
    for (const item of toResend(items, t)) {
      if (!live()) return
      apply(item.id, await sendOnce(item))
    }
  }

  // ---- the other acts: no outbox (the screen shows them pending itself), the same actId until an answer or the deadline

  const sessionWithin = (deadline: number): Promise<TalkSession | undefined> => {
    const s = live()
    if (s) return Promise.resolve(s)
    const left = deadline - now()
    if (left <= 0 || disposed) return Promise.resolve(undefined)
    return new Promise(done => {
      const wake = (): void => { waiters.delete(wake); done(live()) }
      waiters.add(wake)
      later(wake, left)
    })
  }

  const act = async (op: number, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const actId = randomBytes(16)
    const deadline = now() + ACT_DEADLINE_MS
    for (;;) {
      const s = await sessionWithin(deadline)
      if (!s) throw new TalkRefused('timeout')
      const step = stepOf(await s.request(op, body, { actId }))
      switch (step.do) {
        case 'done': return step.body
        case 'hold':
        case 'fail': throw new TalkRefused(step.code)
        case 'locked': locked(); break
        case 'resend':
        case 'wait-session':
          if (now() >= deadline) throw new TalkRefused('timeout')
          await new Promise<void>(done => later(done, step.do === 'resend' ? step.afterMs : AGAIN_MS))
      }
    }
  }

  // ---- seen

  const seenFire = (channel: string): void => {
    seenTimers.delete(channel)
    const took = seenTake(seenLanes.get(channel) ?? SEEN_LANE)
    seenLanes.set(channel, took.lane)
    if (took.seq === undefined) return
    const seq = took.seq
    const s = live()
    const done = (ok: boolean): void => {
      const d = seenDone(seenLanes.get(channel) ?? SEEN_LANE, seq, ok)
      seenLanes.set(channel, d.lane)
      if (d.start) seenArm(channel)
    }
    if (!s) { done(false); return }
    seenAt.set(channel, now())
    void s.request(OP.seen, { channel, seq }, { actId: randomBytes(16) }).then(r => {
      const step = stepOf(r)
      if (step.do === 'locked') locked()
      // A refusal is not the person's concern (the app's marks do the same): the next look at the end asks again.
      done(step.do === 'done')
    }, () => done(false))
  }

  const seenArm = (channel: string, ms = SEEN_DELAY_MS): void => {
    if (seenTimers.has(channel) || disposed) return
    const wait = Math.max(ms, (seenAt.get(channel) ?? -Infinity) + SEEN_SPACING_MS - now())
    const t = setTimer(() => { timers.delete(t); if (!disposed) seenFire(channel) }, wait)
    timers.add(t)
    seenTimers.set(channel, t)
  }

  const talker: Talker = {
    onLocked: () => {},
    attach: s => {
      if (disposed) return
      session = s
      // Another tab of this device may have held the house meanwhile: its outbox and drafts are the ones to go on with.
      read()
      for (const w of [...waiters]) w()
      void resendAll()
    },
    detach: () => { session = undefined },
    say: async (channel, text, to) => {
      const c = checkSay(text, to)
      if (!c.ok) throw new TalkRefused(c.code, c.message)
      const item: OutItem = { id: hex(randomBytes(16)), channel, text, to: [...new Set(to)], at: now(), state: 'sending' }
      items = pushItem(items, item)
      saveItems()
      emit({ channel, what: 'changed' })
      const sent = sendOnce(item)
      const first = await Promise.race([sent, new Promise<'later'>(done => later(() => done('later'), FIRST_REPLY_MS))])
      if (first !== 'later' && first?.do === 'hold') {
        // The portal's pace: nothing happened. The speech leaves the outbox and the box keeps its text.
        items = items.filter(x => x.id !== item.id)
        saveItems()
        emit({ channel, what: 'changed' })
        throw new TalkRefused(first.code, HOLD_TEXT[first.code])
      }
      if (first === 'later') void sent.then(s => apply(item.id, s))
      else apply(item.id, first)
      // What was typed is on its way: the draft of the box goes (unless the person already typed something else).
      if ((drafts[channel] ?? '').trim() === text.trim()) { drafts = withDraft(drafts, channel, ''); saveDrafts() }
    },
    react: async (channel, seq, reaction, remove) => {
      if (!reactionOk(reaction)) throw new TalkRefused('bad-reaction')
      const r = await act(OP.react, { channel, seq, reaction, ...(remove ? { remove: true } : {}) })
      return { changed: r.changed === true }
    },
    vote: async (channel, poll, vote, reason) => {
      const why = reasonOf(reason)
      const r = await act(OP.vote, { channel, poll, vote, ...(why !== undefined ? { reason: why } : {}) })
      const state = pollStateOf(channel, r.state)
      if (state?.result) return { result: state.result, ...(state.closedAt ? { closedAt: state.closedAt } : {}) }
      if (state?.open) return { poll: state.open }
      throw new TalkRefused('failed')
    },
    poll: async (channel, a) => {
      const r = await act(OP.poll, {
        channel, question: a.question, ...(a.options?.length ? { options: [...a.options] } : {}), ...(a.to?.length ? { to: [...new Set(a.to)] } : {}),
        ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
      })
      return { seq: typeof r.seq === 'number' ? r.seq : 0 }
    },
    seen: (channel, seq) => {
      if (!Number.isSafeInteger(seq) || seq < 1) return
      const w = seenWant(seenLanes.get(channel) ?? SEEN_LANE, seq)
      seenLanes.set(channel, w.lane)
      if (w.start) seenArm(channel)
    },
    items: channel => items.filter(x => x.channel === channel),
    retry: id => {
      const old = find(id)
      if (!old || old.state !== 'failed') return
      // A new act: the old id's outcome (a refusal, or nothing known) stays the portal's for that id.
      const item: OutItem = { id: hex(randomBytes(16)), channel: old.channel, text: old.text, to: old.to, at: now(), state: 'sending' }
      items = items.map(x => (x.id === id ? item : x))
      saveItems()
      emit({ channel: item.channel, what: 'changed' })
      void sendOnce(item).then(s => apply(item.id, s))
    },
    take: id => {
      const item = find(id)
      if (!item || item.state === 'sending') return undefined
      items = items.filter(x => x.id !== id)
      saveItems()
      emit({ channel: item.channel, what: 'changed' })
      return item
    },
    draft: channel => drafts[channel] ?? '',
    setDraft: (channel, text) => {
      if ((drafts[channel] ?? '') === text) return
      drafts = withDraft(drafts, channel, text)
      saveDrafts()
    },
    confirmed: (channel, last) => {
      const next = confirmUpTo(items, channel, last)
      if (next.length === items.length) return
      items = next
      saveItems()
      emit({ channel, what: 'changed' })
    },
    onChange: l => { listeners.add(l); return { dispose: () => { listeners.delete(l) } } },
    forget: () => {
      items = []
      drafts = {}
      try { store.remove(keyOut); store.remove(keyDrafts) } catch { /* nothing kept */ }
    },
    dispose: () => {
      disposed = true
      session = undefined
      for (const t of timers) clearTimer(t)
      timers.clear()
      seenTimers.clear()
      for (const w of [...waiters]) w()
      listeners.clear()
    },
  }
  return talker
}
