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
// Besides the badge there is the TURN: whether the agent is free to be sent a command (the Faults screen's "Mandar para o
// agente" types into a pane only when it is known to be idle). idle | busy | blocked, or unknown (undefined). Claude's
// hooks tell it exactly (UserPromptSubmit = busy, Stop = idle, Notification = blocked, or idle for the idle_prompt one);
// the soul has the same heuristic as the badge (Enter = busy, quiet after a burst = idle); an agent is idle from the moment
// its start event arrives. Whatever the hooks cannot confirm is unknown rather than guessed: text typed into the prompt,
// or a line submitted to an agent whose hook has not answered yet, make an idle pane unknown until its next report.
//
// Cleared by: the user typing into the slot (input that is not a terminal reply), `seen` (the pane got the
// focus), a new launch and the process exit.

import '../agents/load.ts'
import { agentRegistry } from '../agents/registry.ts'

export type Attention = 'done' | 'waiting'

/** Whether the agent can be sent a command now; undefined (unknown) is not "idle". 'blocked' = waiting for an answer of the person. */
export type Turn = 'idle' | 'busy' | 'blocked'

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
  turn: Turn | undefined
  private readonly opts: Required<AttentionOptions>
  private scan: Scan = 'text'
  /** The user submitted a line; output that follows counts toward a turn. */
  private armed = false
  private burst = 0
  private lastOutputAt = 0

  constructor(opts: AttentionOptions) {
    this.opts = { idleMs: IDLE_MS, burstBytes: BURST_BYTES, ...opts }
  }

  /**
   * A hook reported the turn's start ('busy': the prompt was submitted), end ('done') or a wait ('waiting'; `notification`
   * is Claude's notification_type: its idle_prompt means "idle for a while", not a question). Returns true when the
   * badge or the turn changed.
   */
  hook(kind: Attention | 'busy', notification?: string): boolean {
    this.disarm()
    if (kind === 'busy') return this.update(undefined, 'busy')
    return this.update(kind, kind === 'done' || notification === 'idle_prompt' ? 'idle' : 'blocked')
  }

  /** The agent's start event for this run arrived: it sits at an empty prompt. Returns true when the turn changed. */
  ready(): boolean {
    return this.turn === undefined ? this.update(this.value, 'idle') : false
  }

  /**
   * Input from a client. Typing clears the attention; a line submitted (Enter) arms the idle heuristic.
   * Input that starts with ESC is not counted as typing: terminals answer queries (DA, cursor position,
   * focus reports) through the same channel, even from a pane nobody looks at.
   */
  input(data: string): boolean {
    if (data.startsWith('\x1b')) return false
    const submitted = /[\r\n]/.test(data)
    if (this.opts.idle && submitted) { this.armed = true; this.burst = 0 }
    let turn = this.turn
    if (this.opts.idle && submitted) turn = 'busy' // the heuristic agent's turn starts at Enter
    else if (turn === 'blocked' && submitted) turn = 'busy' // the person answered
    else if (turn === 'idle') turn = undefined // text in the prompt / a line the agent's hook has not confirmed
    return this.update(undefined, turn)
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
    if (bell && this.opts.bel) { this.disarm(); return this.update('waiting', 'blocked') }
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
    return this.update('done', 'idle')
  }

  /** A new launch or the process exit: nothing is pending and nothing is shown. */
  reset(): boolean {
    this.disarm()
    this.scan = 'text'
    return this.update(undefined, undefined)
  }

  private disarm(): void {
    this.armed = false
    this.burst = 0
  }

  private set(v: Attention | undefined): boolean {
    if (this.value === v) return false
    this.value = v
    return true
  }

  /** Sets the badge and the turn together; true when either changed (the daemon then broadcasts the slot). */
  private update(value: Attention | undefined, turn: Turn | undefined): boolean {
    const changed = this.turn !== turn
    this.turn = turn
    return this.set(value) || changed
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

/** The hook's file (<home>/slots/<id>.attention): `{ ts, kind, sessionId? }`; undefined when unreadable. */
export interface AttentionReport { ts: string; kind: Attention | 'busy'; /** Claude's notification_type, for a 'waiting'. */ notification?: string; sessionId?: string }

export function parseAttentionReport(text: string): AttentionReport | undefined {
  let x: unknown
  try { x = JSON.parse(text) } catch { return undefined }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (typeof r.ts !== 'string' || (r.kind !== 'done' && r.kind !== 'waiting' && r.kind !== 'busy')) return undefined
  return { ts: r.ts, kind: r.kind, ...(typeof r.notification === 'string' ? { notification: r.notification } : {}), ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}) }
}
