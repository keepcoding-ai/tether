// Getting the command into an agent pane and knowing it was taken, as a small state machine over an injected `io` (the
// renderer wires it to ui.slots; the unit test drives it with a fake clock). Two waits:
//   1. the pane must be ready (running and idle). A new pane in a folder Claude does not trust yet shows a trust dialog (or an
//      MCP approval) and is not idle until the person answers it, so the wait is long (5 min) and says so on the row;
//   2. after the command and the Enter are typed, the pane must turn busy (or blocked) within 10 s. A pane that stays idle
//      did not take the line (the TUI was not listening yet): the line is cleared (Ctrl+U) and typed once more; if it still
//      stays idle the send is reverted ("o comando não foi aceito pelo painel") and nothing is marked as sent.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'

/** How long a pane gets to become idle (a trust dialog may be waiting for the person). */
export const READY_TIMEOUT_MS = 5 * 60_000
/** How long a typed command gets to make the pane busy. */
export const ACCEPT_TIMEOUT_MS = 10_000
/** The text first, the Enter after it: an agent TUI takes a burst ending in Enter for a paste, not for a submit. */
export const SUBMIT_DELAY_MS = 250
/** Ctrl+U: clears the line the agent's prompt holds (what a first, unaccepted attempt left there). */
export const CLEAR_LINE = '\x15'

export const WAITING_TEXT = 'aguardando o agente ficar pronto · confirme no painel'
export const NOT_READY_TEXT = 'O agente não ficou pronto; o comando não foi enviado. O painel ficou aberto · Tentar de novo.'
export const NOT_ACCEPTED_TEXT = 'o comando não foi aceito pelo painel'
export const NOT_FREE_TEXT = 'O painel não está mais livre; escolha outro.'

/** What the machine needs of the world. */
export interface DeliveryIo {
  /** The slot as the app knows it now; undefined = gone. */
  slot(): { status: string; turn?: string } | undefined
  /** Any slot changed. */
  onChange(listener: () => void): IDisposable
  input(data: string): void
  /** Calls `fn` once after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void
}

const wait = (io: DeliveryIo, ms: number): Promise<void> => new Promise(resolve => { io.after(ms, resolve) })

const isReady = (io: DeliveryIo): boolean => { const s = io.slot(); return !!s && s.status === 'running' && s.turn === 'idle' }
/** The agent started a turn (or stopped for the person): the line was taken. */
const tookIt = (io: DeliveryIo): boolean => { const s = io.slot(); return !!s && (s.turn === 'busy' || s.turn === 'blocked') }
/** Starting or queued: the agent may still come up. */
const mayStart = (io: DeliveryIo): boolean => { const s = io.slot(); return !!s && (s.status === 'starting' || s.status === 'queued' || s.status === 'running') }

/** Resolves when `test` holds (checked now and at every change), or false after `timeoutMs`, or as soon as `giveUp` holds. */
function until(io: DeliveryIo, test: () => boolean, timeoutMs: number, giveUp: () => boolean = () => false): Promise<boolean> {
  if (test()) return Promise.resolve(true)
  return new Promise(resolve => {
    let sub: IDisposable = toDisposable(() => undefined)
    let cancel = (): void => undefined
    const done = (ok: boolean): void => { sub.dispose(); cancel(); resolve(ok) }
    sub = io.onChange(() => { if (test()) done(true); else if (giveUp()) done(false) })
    cancel = io.after(timeoutMs, () => done(false))
  })
}

/** Waits for the pane to be idle; `onWaiting` is told once, when it is not idle yet (the row says what to do). */
export function untilReady(io: DeliveryIo, onWaiting?: (text: string) => void, timeoutMs: number = READY_TIMEOUT_MS): Promise<boolean> {
  if (!isReady(io)) onWaiting?.(WAITING_TEXT)
  return until(io, () => isReady(io), timeoutMs, () => !mayStart(io))
}

export type Delivery = 'accepted' | 'not-free' | 'not-accepted'

async function attempt(io: DeliveryIo, command: string, clear: boolean): Promise<boolean> {
  if (clear) io.input(CLEAR_LINE)
  io.input(command)
  await wait(io, SUBMIT_DELAY_MS)
  io.input('\r')
  return until(io, () => tookIt(io), ACCEPT_TIMEOUT_MS)
}

/** Types `command` into the idle pane and checks it was taken; retypes once when the pane stays idle. */
export async function deliver(io: DeliveryIo, command: string): Promise<Delivery> {
  if (!isReady(io)) return 'not-free'
  if (await attempt(io, command, false)) return 'accepted'
  if (!isReady(io)) return tookIt(io) ? 'accepted' : 'not-free'
  return (await attempt(io, command, true)) ? 'accepted' : 'not-accepted'
}
