// Per-slot "attention": the agent finished its turn ('done') or waits for the user ('waiting'). Pure state
// machine with an injected clock, so the daemon only feeds it events and the unit tests drive it by hand.
//
// Sources, by slot kind:
//   claude  the Stop / Notification hooks (src/report/claude-hook.mjs → <home>/slots/<id>.attention): exact.
//   soul    no hook yet: a cheap heuristic. After the user submitted a line (input with Enter), an output burst
//           of at least BURST_BYTES followed by IDLE_MS of silence means the turn is over → 'done'. A TUI that
//           keeps painting (a clock, a spinner that never stops) never goes idle: the heuristic misses rather
//           than fires falsely. Plus a lone BEL → 'waiting'.
//   shell   BEL only (a prompt coming back after every command is not worth a badge).
// A BEL that terminates an OSC/DCS/APC/PM/SOS string (window titles, hyperlinks) is not a bell: the scanner
// tracks those strings across chunks.
//
// Cleared by: the user typing into the slot (input that is not a terminal reply), `seen` (the pane got the
// focus), a new launch and the process exit.

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
export const BURST_BYTES = 512

/** Where the escape-sequence scanner stands between chunks. */
type Scan = 'text' | 'esc' | 'string' | 'string-esc'

export class AttentionState {
  value: Attention | undefined
  /** Is a turn in progress? Claude: UserPromptSubmit→busy, Stop→idle. Soul: Enter→busy, quiet→idle. Shells never. */
  turn: Turn = 'idle'
  private readonly opts: Required<AttentionOptions>
  private scan: Scan = 'text'
  /** The user submitted a line; output that follows counts toward a turn. */
  private armed = false
  private burst = 0
  private lastOutputAt = 0

  constructor(opts: AttentionOptions) {
    this.opts = { idleMs: IDLE_MS, burstBytes: BURST_BYTES, ...opts }
  }

  /** A hook reported the turn's end or a wait. Returns true when the value changed. */
  hook(kind: HookKind): boolean {
    this.disarm()
    if (kind === 'start') return this.setTurn('busy')
    const t = kind === 'done' ? this.setTurn('idle') : false // 'waiting' keeps the turn busy
    return this.set(kind) || t
  }

  /**
   * Input from a client. Typing clears the attention; a line submitted (Enter) arms the idle heuristic.
   * Input that starts with ESC is not counted as typing: terminals answer queries (DA, cursor position,
   * focus reports) through the same channel, even from a pane nobody looks at.
   */
  input(data: string): boolean {
    if (data.startsWith('\x1b')) return false
    if (this.opts.idle && /[\r\n]/.test(data)) { this.armed = true; this.burst = 0 }
    const t = this.armed ? this.setTurn('busy') : false
    return this.set(undefined) || t
  }

  /** The user looked at the pane. */
  seen(): boolean {
    return this.set(undefined)
  }

  /** Output from the process at `now` (ms). Returns true when the value changed (a bell). */
  output(data: string, now: number): boolean {
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
    if (bell && this.opts.bel) { this.disarm(); return this.set('waiting') }
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

  /** A new launch or the process exit: nothing is pending and nothing is shown. */
  reset(): boolean {
    this.disarm()
    this.scan = 'text'
    const t = this.setTurn('idle')
    return this.set(undefined) || t
  }

  private disarm(): void {
    this.armed = false
    this.burst = 0
  }

  private setTurn(v: Turn): boolean {
    if (this.turn === v) return false
    this.turn = v
    return true
  }

  private set(v: Attention | undefined): boolean {
    if (this.value === v) return false
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

/** The hook's file (<home>/slots/<id>.attention): `{ ts, kind: start|done|waiting, sessionId? }`; undefined when unreadable. */
export interface AttentionReport { ts: string; kind: HookKind; sessionId?: string }

export function parseAttentionReport(text: string): AttentionReport | undefined {
  let x: unknown
  try { x = JSON.parse(text) } catch { return undefined }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (typeof r.ts !== 'string' || (r.kind !== 'done' && r.kind !== 'waiting' && r.kind !== 'start')) return undefined
  return { ts: r.ts, kind: r.kind, ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}) }
}
