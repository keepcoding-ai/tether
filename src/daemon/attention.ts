// Per-slot "attention": the agent finished its turn ('done') or waits for the user ('waiting'). Pure state
// machine with an injected clock, so the daemon only feeds it events and the unit tests drive it by hand.
//
// Sources, by slot kind:
//   claude  the Stop / Notification hooks (src/report/claude-hook.mjs → <home>/slots/<id>.attention): exact.
//   soul    the client's own `turn` events (session-event.ts: busy|idle) once it has sent one: exact, see `signal`.
//           Until then (an older soul) a cheap heuristic. After the user submitted a line (input with Enter), an output burst
//           of at least BURST_BYTES followed by IDLE_MS of silence means the turn is over → 'done'. A TUI that
//           keeps painting (a clock, a spinner that never stops) never goes idle: the heuristic misses rather
//           than fires falsely. Plus a lone BEL → 'waiting'.
//   shell   BEL only (a prompt coming back after every command is not worth a badge).
// A BEL that terminates an OSC/DCS/APC/PM/SOS string (window titles, hyperlinks) is not a bell: the scanner
// tracks those strings across chunks.
//
// Cleared by: the user typing into the slot (input that is not a terminal reply), `seen` (the pane got the
// focus), a new launch and the process exit. A `pending` value is the exception: focus does not clear it, only
// resolving it does (typing, a new turn, a finished turn, a reset). The owning agent's `seen(true)` clears it too.
// Two things make a value pending: a 'waiting' that is a pending request (a hook report with a `reason` other than
// 'idle_prompt': a permission prompt, a question), and `defer` (the person marked the slot unread: 'done' unless
// something is already shown). Any change of value other than the mark itself drops `pending`.

import '../agents/load.ts'
import { agentRegistry } from '../agents/registry.ts'

export type Attention = 'done' | 'waiting'
/** What a hook reports: a turn start (turn signal only) or an attention value. */
export type HookKind = Attention | 'start'
export type Turn = 'busy' | 'idle'

export interface AttentionOptions {
  /** Detect "output went quiet after the user's turn" (soul). */
  idle: boolean
  /** A bare BEL in the output means "waiting for you" (soul, shell). */
  bel: boolean
  idleMs?: number
  burstBytes?: number
}

export const IDLE_MS = 4_000
/** After the last background subagent ends, how long the agent may take to wake before the turn counts as over anyway. */
export const WAKE_MS = 120_000
export const BURST_BYTES = 512

/** Where the escape-sequence scanner stands between chunks. */
type Scan = 'text' | 'esc' | 'string' | 'string-esc'

export class AttentionState {
  value: Attention | undefined
  /** `value` stands for something the person must resolve (a pending request, or an unread mark): focus does not clear it. Never true while `value` is undefined. */
  pending = false
  /** Is a turn in progress? Claude: UserPromptSubmit→busy, Stop→idle. Soul: its `turn` events, else Enter→busy, quiet→idle. Shells never. */
  turn: Turn = 'idle'
  /** ISO time the turn last became idle (a finished turn, a signal, a reset); undefined while busy or when it never changed here. */
  idleSince: string | undefined
  /** ISO time the current turn began; undefined while idle. */
  busySince: string | undefined
  /** The agent reports its own turns (`signal`): the Enter / quiet heuristic stands down for this run. */
  private signaled = false
  private readonly opts: Required<AttentionOptions>
  private scan: Scan = 'text'
  /** The user submitted a line; output that follows counts toward a turn. */
  private armed = false
  private burst = 0
  private lastOutputAt = 0
  private paintedAt = 0
  /** When (ms) the last non-empty output chunk arrived, armed or not; 0 when the screen never painted. Read-only for callers. */
  get lastPaintAt(): number { return this.paintedAt }
  /** Background subagents still running (Claude: marker files its Subagent hooks keep). The turn stays busy while any runs. */
  background = 0
  /** The main turn ended (Stop) while subagents ran: the turn is kept busy for them, and the agent wakes when they end. */
  private delegating = false
  /** ms epoch when the last subagent ended while delegating: the wake fallback runs from here. */
  private wakeFrom: number | undefined = undefined

  constructor(opts: AttentionOptions) {
    this.opts = { idleMs: IDLE_MS, burstBytes: BURST_BYTES, ...opts }
  }

  /** A hook reported the turn's end or a wait. Returns true when the value changed. */
  hook(kind: HookKind, reason?: string): boolean {
    this.disarm()
    const pending = kind === 'waiting' && reason !== undefined && reason !== 'idle_prompt'
    // A softer wait (idle prompt, bell) never downgrades a request still pending.
    if (kind === 'waiting' && this.pending && !pending) return false
    // A new turn voids the previous 'done' / 'waiting': the agent is working again.
    if (kind === 'start' || kind === 'done') { this.delegating = false; this.wakeFrom = undefined }
    if (kind === 'start') { const t = this.setTurn('busy'); return this.set(undefined) || t }
    // The turn ended but a background subagent still runs: the agent is waiting for it, not stopped.
    if (kind === 'done' && this.background > 0) { this.delegating = true; return this.setTurn('busy') }
    const t = kind === 'done' ? this.setTurn('idle') : false // 'waiting' keeps the turn busy
    const before = { value: this.value, pending: this.pending }
    this.set(kind)
    this.pending = pending
    return this.value !== before.value || this.pending !== before.pending || t
  }

  /**
   * The agent said its own turn state (soul's `turn` event). From the first one the heuristic is off: Enter no longer
   * means busy and silence no longer means done. Busy→idle is a finished turn ('done', like the hook's Stop); an idle that
   * finds no turn in progress is not. Returns true when the turn or the value changed.
   */
  signal(state: Turn): boolean {
    this.signaled = true
    this.disarm()
    if (state === 'busy') { const t = this.setTurn('busy'); return this.set(undefined) || t }
    const finished = this.turn === 'busy'
    const t = this.setTurn('idle')
    return (finished ? this.set('done') : false) || t
  }

  /**
   * The agent said its own wait (soul's `waiting` event). `open` is the same pending 'waiting' a Claude permission hook
   * raises (it resists the focus 'seen'; the turn stays busy); `closed` drops it, only when it is still the shown value.
   * Returns true when the value or `pending` changed.
   */
  waitSignal(state: 'open' | 'closed', reason: string): boolean {
    this.signaled = true
    if (state === 'open') return this.hook('waiting', reason)
    this.disarm()
    return this.value === 'waiting' ? this.set(undefined) : false
  }

  /**
   * Input from a client. Typing clears the attention; a line submitted (Enter) arms the idle heuristic.
   * Input that starts with ESC is not counted as typing: terminals answer queries (DA, cursor position,
   * focus reports) and arrow keys through the same channel, even from a pane nobody looks at. A lone ESC is the
   * person's key (refusing a permission prompt fires no Stop hook): it clears the value, pending or not, but arms
   * nothing and leaves the turn alone.
   */
  input(data: string): boolean {
    if (data === '\x1b') return this.set(undefined)
    if (data.startsWith('\x1b')) return false
    if (this.opts.idle && !this.signaled && /[\r\n]/.test(data)) { this.armed = true; this.burst = 0 }
    const t = this.armed ? this.setTurn('busy') : false
    return this.set(undefined) || t
  }

  /** The user looked at the pane: clears 'done' and a non-pending 'waiting'. `force` (the owning agent) clears a pending one too. */
  seen(force = false): boolean {
    if (this.pending && !force) return false
    return this.set(undefined)
  }

  /**
   * The person marked the slot unread: shows 'done' when nothing is shown (a 'done' or 'waiting' already there stays) and
   * makes it pending, so focus no longer clears it. Leaves the turn alone. Returns true when the value or `pending` changed;
   * `seen(true)` undoes it.
   */
  defer(): boolean {
    const changed = !this.pending
    this.value ??= 'done'
    this.pending = true
    return changed
  }

  /** Output from the process at `now` (ms). Returns true when the value changed (a bell). */
  output(data: string, now: number): boolean {
    if (data.length > 0) this.paintedAt = now
    let bell = false
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i)
      switch (this.scan) {
        case 'text':
          if (c === 0x1b) this.scan = 'esc'
          else if (c === 0x07) bell = true
          break
        case 'esc':
          // ESC ] (OSC), ESC P (DCS), ESC X (SOS), ESC ^ (PM), ESC _ (APC) open a string ended by BEL or ESC \.
          this.scan = c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f ? 'string' : 'text'
          break
        case 'string':
          if (c === 0x07) this.scan = 'text'
          else if (c === 0x1b) this.scan = 'string-esc'
          break
        case 'string-esc':
          this.scan = c === 0x5c ? 'text' : 'string'
          break
      }
    }
    if (this.armed) { this.burst += data.length; this.lastOutputAt = now }
    if (bell && this.opts.bel) { this.disarm(); return this.pending ? false : this.set('waiting') }
    return false
  }

  /** When the daemon should call `poll` next (ms epoch), or undefined when nothing is pending. */
  dueAt(): number | undefined {
    return this.opts.idle && this.armed && this.burst >= this.opts.burstBytes ? this.lastOutputAt + this.opts.idleMs : undefined
  }

  /** The idle heuristic at `now`: a turn's output went quiet → 'done'. Returns true when the value changed. */
  poll(now: number): boolean {
    const due = this.dueAt()
    if (due === undefined || now < due) return false
    this.disarm()
    const t = this.setTurn('idle')
    return this.set('done') || t
  }

  /**
   * How many background subagents run now (`now` in ms). More than zero keeps the turn busy; when the last one ends after the
   * main turn did, the turn stays busy while the agent wakes to read the result, until its Stop or `wakeDueAt`.
   */
  setBackground(n: number, now: number): boolean {
    if (n === this.background) return false
    this.background = n
    if (n > 0) {
      this.wakeFrom = undefined
      if (this.turn === 'idle') { this.delegating = true; return this.setTurn('busy') }
      return true
    }
    if (this.delegating) this.wakeFrom = now
    return true
  }

  /** When the daemon should call `wakeExpired` (ms epoch): the last subagent ended and the agent has not finished since. */
  wakeDueAt(): number | undefined {
    return this.delegating && this.background === 0 && this.wakeFrom !== undefined ? this.wakeFrom + WAKE_MS : undefined
  }

  /** The agent did not report a finished turn within WAKE_MS of its last subagent: the turn is over ('done'). */
  wakeExpired(now: number): boolean {
    const due = this.wakeDueAt()
    if (due === undefined || now < due) return false
    this.delegating = false
    this.wakeFrom = undefined
    const t = this.setTurn('idle')
    return this.set('done') || t
  }

  /** A new launch or the process exit: nothing is pending and nothing is shown. */
  reset(): boolean {
    this.background = 0
    this.delegating = false
    this.wakeFrom = undefined
    this.disarm()
    this.signaled = false
    this.scan = 'text'
    const t = this.setTurn('idle')
    this.idleSince = new Date().toISOString() // a launch / exit starts the idle clock even when the turn was already idle
    return this.set(undefined) || t
  }

  private disarm(): void {
    this.armed = false
    this.burst = 0
  }

  private setTurn(v: Turn): boolean {
    if (this.turn === v) return false
    this.turn = v
    const now = new Date().toISOString()
    this.idleSince = v === 'idle' ? now : undefined
    this.busySince = v === 'busy' ? now : undefined
    return true
  }

  /** Shows `v`; any new value (even the same one) is not the unread mark, so `pending` drops. True when the value or `pending` changed. */
  private set(v: Attention | undefined): boolean {
    const was = this.pending
    this.pending = false
    if (this.value === v) return was
    this.value = v
    return true
  }
}

/** The options for a slot kind (see the header): the agent's contribution; shells and unregistered agents ring on BEL only. */
export function attentionOptions(kind: string): AttentionOptions {
  if (kind !== 'shell') {
    const agent = agentRegistry.get(kind)
    if (agent) return agent.attention
  }
  return { idle: false, bel: true }
}

/** One `turn` line of the soul's events file (<home>/slots/<id>.jsonl): the agent started or finished a turn. */
export interface TurnReport { ts: string; state: Turn }

/** The `turn` lines of an events file's text, in order; every other line (start/rename/end, noise) is skipped. */
export function parseTurnReports(text: string): TurnReport[] {
  const out: TurnReport[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"turn"')) continue
    let x: unknown
    try { x = JSON.parse(line) } catch { continue }
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const r = x as Record<string, unknown>
    if (r.kind !== 'turn' || typeof r.ts !== 'string' || (r.state !== 'busy' && r.state !== 'idle')) continue
    out.push({ ts: r.ts, state: r.state })
  }
  return out
}

/** One `waiting` line of the soul's events file: a request to the person opened or closed (`reason`: permission|question|elicitation). */
export interface WaitingReport { ts: string; kind: 'waiting'; state: 'open' | 'closed'; reason: string }
/** A soul line that moves the attention, in file order: a turn change or a wait edge. */
export type SoulReport = (TurnReport & { kind: 'turn' }) | WaitingReport

/**
 * The `turn` and `waiting` lines of an events file's text, in order (their order matters: a `busy` voids a wait). Any other
 * line, a malformed one, or a `waiting` without a valid `state` is skipped; an unknown or missing `reason` still counts
 * (as `request`), so a newer soul never hides a wait.
 */
export function parseSoulReports(text: string): SoulReport[] {
  const out: SoulReport[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"turn"') && !line.includes('"waiting"')) continue
    let x: unknown
    try { x = JSON.parse(line) } catch { continue }
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const r = x as Record<string, unknown>
    if (typeof r.ts !== 'string') continue
    if (r.kind === 'turn' && (r.state === 'busy' || r.state === 'idle')) out.push({ kind: 'turn', ts: r.ts, state: r.state })
    else if (r.kind === 'waiting' && (r.state === 'open' || r.state === 'closed')) {
      out.push({ kind: 'waiting', ts: r.ts, state: r.state, reason: typeof r.reason === 'string' && r.reason ? r.reason : 'request' })
    }
  }
  return out
}

/** The hook's file (<home>/slots/<id>.attention): `{ ts, kind: start|done|waiting, sessionId?, reason? }`; undefined when unreadable. */
export interface AttentionReport { ts: string; kind: HookKind; sessionId?: string; reason?: string }

export function parseAttentionReport(text: string): AttentionReport | undefined {
  let x: unknown
  try { x = JSON.parse(text) } catch { return undefined }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (typeof r.ts !== 'string' || (r.kind !== 'done' && r.kind !== 'waiting' && r.kind !== 'start')) return undefined
  return { ts: r.ts, kind: r.kind, ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}), ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}) }
}
