// The peek card's rules as pure data (unit-tested; app/renderer/peek.ts and main.ts wire them to the DOM):
//   - where a peek goes: the card (a live slot no tab shows), the card with the tab's terminal lent (a tab not in view),
//     the slot's tab (in view: only the keyboard goes there), or nowhere;
//   - who owns an Esc inside the card (the drawer's rule: an agent's terminal keeps it);
//   - what the card's header, its "⋯" and foot say, and what a tab whose terminal is lent says.
// A slot has one terminal and one pty size: without a tab the card attaches its own terminal and detaches on close; with
// a tab the card borrows the tab's terminal and gives it back on close (never two views of the same slot at once).
import type { SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import { slotTitle } from '../shared/agent-info.ts'
import { escAction, type EscAction, type EscInput } from './drawer-rules.ts'
import { sessionRows, type SessionSlot, type TurnState } from './sessions-rules.ts'

/** The command that closes the card (palette, chord, the ✕ hint). */
export const PEEK_CLOSE_COMMAND = 'peek.close'

// ---------- where a peek goes ----------

/**
 *   card    a live slot (running, starting or queued) that no tab shows: the card opens with a terminal of its own;
 *   lend    a live slot whose tab is NOT in view right now: the card opens with the tab's own terminal, lent (the tab
 *           shows "sendo espiado" meanwhile and gets the terminal back when the card closes);
 *   reveal  the slot's tab is in view (only the keyboard goes to it), or it has a tab and has ended (its tab comes
 *           forward, as opening it always did);
 *   none    unknown slot, or an ended one without a tab (peeking an ended agent is out of scope).
 * `tabInView` only counts with a tab (see `tabInView`); leaving it out reads as "in view".
 */
export type PeekRoute = 'card' | 'lend' | 'reveal' | 'none'

export function peekRoute(slot: Pick<SlotState, 'status'> | undefined, hasTab: boolean, tabInView = true): PeekRoute {
  if (!slot) return 'none'
  const live = slot.status === 'running' || slot.status === 'starting' || slot.status === 'queued'
  if (hasTab) return live && !tabInView ? 'lend' : 'reveal'
  return live ? 'card' : 'none'
}

/** Where a tab is and what is on screen, as main.ts reads it at the instant of the peek. */
export interface TabPlace {
  /** The tab lives in the drawer (else on a desk or in a pad's frames). */
  inDrawer: boolean
  /** Its place is on screen: the active desk, the open drawer, or a pad that is shown (and belongs to the active desk). */
  placeShown: boolean
  /** It is the active tab of its frame (a background tab is display:none). */
  activeInFrame: boolean
  /** The drawer is open: it covers the desks and the pads. */
  drawerOpen: boolean
}

/** Whether a tab is in view right now: its place is shown, it is its frame's active tab, and the open drawer does not cover it. */
export function tabInView(p: TabPlace): boolean {
  return p.placeShown && p.activeInFrame && (p.inDrawer || !p.drawerOpen)
}

// ---------- Esc ----------

/**
 * What an Esc inside the open card means. In the card's terminal (agent or shell) Esc always goes to the program and never
 * closes the card (Claude interrupts with it). On the header (a button) it closes, unless a dialog or menu is up and keeps
 * its own Esc. (The drawer keeps its own rule, drawer-rules.ts.)
 */
export function peekEscAction(input: Omit<EscInput, 'open'>): EscAction {
  // One rule: inside the card's content (the terminal, agent or shell) Esc is the program's, never the card's.
  if (input.focus.in === 'terminal') return 'pass'
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

/** The "Fechar" button's tooltip: "Fechar (Ctrl+` ou Ctrl+Shift+O)", or plain "Fechar" when the person unbound both keys. */
export function closeTip(hints: readonly string[]): string {
  return hints.length ? `Fechar (${hints.join(' ou ')})` : 'Fechar'
}

export type PeekMenuAction = 'open-here' | 'open-other' | 'go-tab' | 'copy-link' | 'close'

export interface PeekMenuItem {
  action: PeekMenuAction
  label: string
  submenu?: boolean
  sepBefore?: boolean
  /** The chord shown at the right (only on "Fechar", and only when bound). */
  trail?: string
  disabled?: boolean
}

/**
 * The "⋯" of the card: open here, open on another desk, copy the pane link, and close (with the chord when there is one).
 * Opening is off once the session ended. A slot with a tab (its terminal lent to the card) has "Ir para a guia" in place
 * of the two ways of opening.
 */
export function peekMenuPlan(hint: string, ended: boolean, hasTab = false): PeekMenuItem[] {
  const open: PeekMenuItem[] = hasTab
    ? [{ action: 'go-tab', label: GO_TAB_LABEL }]
    : [
        { action: 'open-here', label: 'Abrir nesta mesa', disabled: ended },
        { action: 'open-other', label: 'Abrir em outra mesa', submenu: true, disabled: ended },
      ]
  return [
    ...open,
    { action: 'copy-link', label: 'Copiar link do painel' },
    { action: 'close', label: 'Fechar', sepBefore: true, ...(hint ? { trail: hint } : {}) },
  ]
}

export const GO_TAB_LABEL = 'Ir para a guia'

/** The card's opening button, secondary (the main action is "Fechar"): "Abrir nesta mesa" (split with ▾ "Abrir em outra mesa") without a tab; "Ir para a guia" (alone) with one. */
export interface PeekOpenButton {
  action: 'open-here' | 'go-tab'
  label: string
  title: string
  icon: 'plus' | 'arrow-square-out'
  primary: boolean
  /** The ▾ "Abrir em outra mesa" stuck to it. */
  split: boolean
}

export function peekOpenButton(hasTab: boolean): PeekOpenButton {
  return hasTab
    ? { action: 'go-tab', label: GO_TAB_LABEL, title: 'Ir para a guia: fecha o cartão, devolve o terminal à guia e mostra a guia', icon: 'arrow-square-out', primary: false, split: false }
    : { action: 'open-here', label: 'Abrir nesta mesa', title: 'Abrir nesta mesa: o agente ganha uma guia na mesa em que você está', icon: 'plus', primary: false, split: true }
}

/** What the tab says while its terminal is lent to the card (screen 6 of the preview). No buttons: the card covers them. */
export interface LentNotice {
  title: string
  text: string
  /** The tab's eye mark tooltip. */
  tip: string
}

export function lentNotice(name: string): LentNotice {
  return {
    title: `${name} está sendo espiado`,
    text: 'O terminal dele está no cartão aberto na tela. Quando você fechar o cartão, ele volta para cá.',
    tip: 'Sendo espiado: o terminal está no cartão aberto na tela',
  }
}

/** The accessible name of the card. */
export function peekLabel(title: string): string {
  return `Espiando ${title}`
}

/**
 * The line at the card's foot, short enough for one line in a narrow window: how to close it and, for an agent, that Esc
 * stays with the agent (said on the screen itself, since Esc does not close here).
 */
export function peekFoot(kind: SlotKind | undefined, hints: readonly string[], ended: boolean): string {
  const way = hints.length ? `pelo botão, pela margem ou por ${hints.join(' ou ')}` : 'pelo botão ou pela margem'
  if (ended) return `Sessão encerrada. Feche ${way}.`
  return `Feche ${way}. ${kind === 'shell' ? 'O Esc fica com o terminal.' : 'O Esc fica com o agente.'}`
}

// ---------- keys while the card is open ----------

/**
 * The app commands whose chords keep working while the card is open: the palette (and through it, every command), the
 * card's own close and the drawer's toggle, which closes the card (only the card: the drawer under it stays as it was).
 * Everything else of the app's table is quiet, as with a dialog up; the card's terminal keeps its own keys
 * (copy and paste are the panel's, not the table's) and hands the rest to the program.
 */
export const PEEK_KEEPS: readonly string[] = [PEEK_CLOSE_COMMAND, 'palette.show', 'drawer.toggle']

/** Whether a command's chord still fires with the card open. */
export function peekKeeps(command: string): boolean {
  return PEEK_KEEPS.includes(command)
}
