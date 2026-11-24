// The peek card's rules as pure data (unit-tested; app/renderer/peek.ts and main.ts wire them to the DOM):
//   - where a peek goes: the card (a live slot no tab shows), the slot's tab (it has one), or nowhere;
//   - who owns an Esc inside the card (the drawer's rule: an agent's terminal keeps it);
//   - what the card's header and foot say.
// The card is the only view of a slot without a tab: it attaches the slot's terminal while open and detaches on close.
import type { SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import { slotTitle } from '../shared/agent-info.ts'
import { escAction, type EscAction, type EscInput } from './drawer-rules.ts'
import { sessionRows, type SessionSlot, type TurnState } from './sessions-rules.ts'

/** The command that closes the card (palette, chord, the ✕ hint). */
export const PEEK_CLOSE_COMMAND = 'peek.close'

// ---------- where a peek goes ----------

/**
 *   card    a live slot (running, starting or queued) that no tab shows: the card opens with its terminal;
 *   reveal  the slot has a tab (desk, drawer or pad): its tab comes forward (lending the terminal is a later step);
 *   none    unknown slot, or an ended one without a tab (peeking an ended agent is out of scope).
 */
export type PeekRoute = 'card' | 'reveal' | 'none'

export function peekRoute(slot: Pick<SlotState, 'status'> | undefined, hasTab: boolean): PeekRoute {
  if (!slot) return 'none'
  if (hasTab) return 'reveal'
  return slot.status === 'running' || slot.status === 'starting' || slot.status === 'queued' ? 'card' : 'none'
}

// ---------- Esc ----------

/**
 * What an Esc inside the open card means: the drawer's rule (drawer-rules.ts `escAction`), the card standing for the
 * drawer. Outside the terminal (the header, a button) Esc closes; an agent's terminal never gives Esc away (Claude
 * interrupts with it); a shell at its prompt closes on a double Esc; a dialog or menu up keeps its own Esc.
 */
export function peekEscAction(input: Omit<EscInput, 'open'>): EscAction {
  return escAction({ ...input, open: true })
}

// ---------- texts ----------

export interface PeekHeader {
  /** The name the slot's tab would show (slotTitle). */
  title: string
  /** The turn state, as the sessions menu reads it. */
  state: TurnState
  /** "trabalhando agora", "ocioso há 2 h", "pede atenção", "encerrada": the sessions menu's short line. */
  text: string
}

/** The header of the card: the tab's name and the sessions menu's state line, for the same slot at the same instant. */
export function peekHeader(slot: SessionSlot & Pick<SlotState, 'name' | 'title' | 'cwd'>, now: number): PeekHeader {
  const row = sessionRows([slot], () => false, now)[0]!
  return { title: slotTitle(slot), state: row.state, text: row.text }
}

/** The ✕'s tooltip: "Fechar (Ctrl+Shift+O)", or plain "Fechar" when the person unbound the key. */
export function closeTip(hint: string): string {
  return hint ? `Fechar (${hint})` : 'Fechar'
}

export type PeekMenuAction = 'open-here' | 'open-other' | 'copy-link' | 'close'

export interface PeekMenuItem {
  action: PeekMenuAction
  label: string
  submenu?: boolean
  sepBefore?: boolean
  /** The chord shown at the right (only on "Fechar", and only when bound). */
  trail?: string
  disabled?: boolean
}

/** The "⋯" of the card: open here, open on another desk, copy the pane link, and close (with the chord when there is one). Opening is off once the session ended. */
export function peekMenuPlan(hint: string, ended: boolean): PeekMenuItem[] {
  return [
    { action: 'open-here', label: 'Abrir nesta mesa', disabled: ended },
    { action: 'open-other', label: 'Abrir em outra mesa', submenu: true, disabled: ended },
    { action: 'copy-link', label: 'Copiar link do painel' },
    { action: 'close', label: 'Fechar', sepBefore: true, ...(hint ? { trail: hint } : {}) },
  ]
}

/** The accessible name of the card. */
export function peekLabel(title: string): string {
  return `Espiando ${title}`
}

/**
 * The line at the card's foot: the card never ends the session, and, for an agent, Esc is the agent's (said on the
 * screen itself, since Esc does not close here).
 */
export function peekFoot(kind: SlotKind | undefined, hint: string, ended: boolean): string {
  const way = hint ? `pelo ✕ ou por ${hint}` : 'pelo ✕'
  if (ended) return `A sessão terminou. Feche o cartão ${way}.`
  const keep = 'Sem guia: fechar o cartão não encerra a sessão, ela segue viva em "Sem guia", no painel de sessões.'
  return kind === 'shell' ? `${keep} Feche ${way}, ou com Esc duas vezes.` : `${keep} Esc vai para o agente; feche ${way}.`
}
