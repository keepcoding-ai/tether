// The peek card's rules as pure data (unit-tested; app/renderer/peek.ts and main.ts wire them to the DOM):
//   - where a peek goes: the card (a live slot no tab shows), the card with the tab's terminal lent (a tab not in view),
//     the slot's tab (in view: only the keyboard goes there), or nowhere;
//   - who owns an Esc inside the card (the drawer's rule: an agent's terminal keeps it);
//   - what the card's header, its "⋯" and foot say, and what a tab whose terminal is lent says.
// A slot has one terminal and one pty size: without a tab the card attaches its own terminal and detaches on close; with
// a tab the card borrows the tab's terminal and gives it back on close (never two views of the same slot at once).
import type { SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { CommandContext } from './commands.ts'
import { slotTitle } from '../shared/agent-info.ts'
import { escAction, type EscAction, type EscInput } from './drawer-rules.ts'
import { GO_PANE_LABEL } from './manager-menu-rules.ts'
import type { LendPlan, LendRefusal } from './pane-loan-rules.ts'
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

export type PeekMenuAction = 'open-here' | 'open-other' | 'go-tab' | 'emblem' | 'copy-link' | 'close'

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
    ? [{ action: 'go-tab', label: GO_TAB_LABEL }, { action: 'emblem', label: EMBLEM_LABEL }]
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
/** The tab menu's own row: the emblem is the tab's, so the card offers it only for a slot that has a tab. */
export const EMBLEM_LABEL = 'Emblema…'

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

/** What any tab lent to the quick view shows in its place (pane-shell.ts), by its title; the terminal keeps `lentNotice`. */
export function paneLentNotice(title: string): LentNotice {
  return {
    title: 'Esta guia está sendo espiada',
    text: `${title} está no cartão aberto na tela. Quando você fechar o cartão, a guia volta para cá.`,
    tip: 'Sendo espiada: a guia está no cartão aberto na tela',
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

/**
 * The commands that open a system screen, which opens in the card itself: their chords keep working with the card open (a
 * screen over the agent shown, or over another screen). Ids are in people's keybindings.json and never change.
 */
export const PEEK_SCREEN_COMMANDS: readonly string[] = ['settings.show', 'keybindings.show', 'extensions.show']

/** Whether a command's chord still fires with the card open. */
export function peekKeeps(command: string): boolean {
  return PEEK_KEEPS.includes(command) || PEEK_SCREEN_COMMANDS.includes(command)
}

/**
 * Whether a command is the screen's own while a screen is in the card (its chord fires there too): its `when` holds with the
 * screen's context flags and does not without them (Ctrl+K Ctrl+K "record" of the shortcuts screen). A command without a
 * rule is nobody's own.
 */
export function screenOwns(when: ((flags: ReadonlySet<string>) => boolean) | undefined, base: ReadonlySet<string>, screenFlags: readonly string[]): boolean {
  if (!when || screenFlags.length === 0) return false
  return when(new Set([...base, ...screenFlags])) && !when(base)
}

// ---------- the command target while a pane is in the card ----------
// With a tab lent to the card and the keyboard in the card, the card's pane is the target of the pane's commands (the
// context `when` rules read, `ui.panes.activeId`, the pane-level app commands): Ctrl+S saves the note in the card, not the
// desk's active tab. The commands that change the structure (new tab, split, duplicate, move, close, the frames and desks)
// never act on the lent pane: their chords are quiet with the keyboard in the card, and from the palette they keep acting on
// the desk. Docked (the Regency), the keyboard leaving the card (the conversation, the tree) gives the target back to the desk.

/** Where a command run lands: the desk's active pane (as without a card), the pane in the card, or nowhere (its chord is quiet). */
export type CommandAim = 'desk' | 'card' | 'mute'

export interface CardKeyboard {
  /** The card is open and shows a lent tab (not an agent's own terminal, not a system screen: those keep their rules). */
  lent: boolean
  /** The card is modal (outside the Regency): nothing else of the window takes the keyboard. */
  modal: boolean
  /** The keyboard's last non-transient place is inside the card (the palette's field and the menus do not move it). */
  focusInCard: boolean
}

/** Whether the pane in the card is the command target now: a lent tab, and the keyboard in the card (always, when modal). */
export function cardHoldsKeys(k: CardKeyboard): boolean {
  return k.lent && (k.modal || k.focusInCard)
}

/**
 * The app commands that act on the pane the keyboard aims at and change nothing of the layout: the terminal's zoom (the font
 * of every terminal, the one in the card included) and copying what the pane points to. Their chords fire in the card.
 */
export const PEEK_PANE_COMMANDS: readonly string[] = ['font.increase', 'font.decrease', 'font.reset', 'pane.copy-folder', 'pane.open-folder', 'pane.copy-link']

const STRUCTURE_PREFIXES: readonly string[] = ['pane.new', 'pane.duplicate.', 'pane.split-empty.', 'pane.go.', 'frame.', 'desk.']
const STRUCTURE_COMMANDS: readonly string[] = ['pane.reopen-closed', 'pane.next-tab', 'pane.previous-tab', 'pane.last', 'pane.move', 'pane.close']

/** A command that changes the structure (tabs, frames, desks) or walks it: never aimed at a lent pane. */
export function isStructureCommand(command: string): boolean {
  return STRUCTURE_COMMANDS.includes(command) || STRUCTURE_PREFIXES.some(p => command.startsWith(p))
}

export interface CommandAimInput extends CardKeyboard {
  command: string
  /** The command came from a chord (else the palette, a menu, the CLI: an explicit pick). */
  key: boolean
  /** The command is the pane's own: its `when` holds only thanks to the pane in the card (paneOwns). */
  paneOwn: boolean
}

/**
 * Who a command aims at. Without a lent tab holding the keyboard, the desk, as always. With one: a structure command's chord
 * is quiet and its explicit run stays on the desk; the card's own few (peekKeeps) run as they always did; every other
 * explicit run aims at the card; a chord aims at the card only for the pane's own commands and PEEK_PANE_COMMANDS, and the
 * rest of the table stays quiet, as with a dialog up.
 */
export function commandAim(i: CommandAimInput): CommandAim {
  if (!cardHoldsKeys(i)) return 'desk'
  if (isStructureCommand(i.command)) return i.key ? 'mute' : 'desk'
  if (peekKeeps(i.command)) return 'desk'
  if (!i.key) return 'card'
  return i.paneOwn || PEEK_PANE_COMMANDS.includes(i.command) ? 'card' : 'mute'
}

/**
 * Whether a command is the pane's own: its `when` holds with the pane's context (its type, its flags, the keyboard in its
 * editor or terminal) and not with a bare pane of no type and no focus (`note.save` is `focus == editor`; a rule that only
 * asks for "a pane" is everybody's). A command without a rule is nobody's own.
 */
export function paneOwns(when: ((ctx: CommandContext) => boolean) | undefined, ctx: CommandContext): boolean {
  if (!when) return false
  const { paneType: _type, unread: _unread, keybindings: _keys, ...rest } = ctx
  const bare: CommandContext = { ...rest, pane: true, flags: new Set<string>(), focus: 'none' }
  return when(ctx) && !when(bare)
}

// ---------- a system screen in the card ----------
// The card also shows a system screen (Configurações, Atalhos de teclado, Extensões): a pane without a slot built outside
// dockview, ephemeral (never in the saved layout). Over an agent it stacks ONE level: the agent's terminal stays under it
// (its own terminal attached, or the tab's still lent) and comes back when the screen closes. A screen over a screen
// replaces it; the agent under stays.

export type PeekTop = 'none' | 'slot' | 'screen'

/** What opening a screen does to what the card shows: `under` = the agent shown goes under the screen. */
export function screenOpenPlan(top: PeekTop): { under: boolean; replace: boolean } {
  return { under: top === 'slot', replace: top === 'screen' }
}

/** What closing (✕, "Fechar", the chord, the margin, Esc on the header) does: back to the agent under the screen, or close the card. */
export function peekDismiss(top: PeekTop, hasUnder: boolean): 'back' | 'close' {
  return top === 'screen' && hasUnder ? 'back' : 'close'
}

/** The card's "Abrir nesta mesa" for a screen: secondary, with the ▾ of the other desks. */
export function screenOpenButton(): PeekOpenButton {
  return { action: 'open-here', label: 'Abrir nesta mesa', title: 'Abrir nesta mesa: a tela vira uma guia da mesa em que você está e o cartão fecha', icon: 'plus', primary: false, split: true }
}

/** The "⋯" of a screen in the card: open here, open on another desk, then close (with the chord when there is one). */
export function screenMenuPlan(hint: string): PeekMenuItem[] {
  return [
    { action: 'open-here', label: 'Abrir nesta mesa' },
    { action: 'open-other', label: 'Abrir em outra mesa', submenu: true },
    { action: 'close', label: 'Fechar', sepBefore: true, ...(hint ? { trail: hint } : {}) },
  ]
}

/** The header's "← <agent>" over a screen: back to the agent the card showed. */
export function backButton(name: string): { label: string; title: string; aria: string } {
  return { label: name, title: `Voltar para ${name} (fechar a tela)`, aria: `Voltar para ${name}` }
}

/** The foot line of a screen in the card: how to close it, and where closing leads when an agent is under it. */
export function screenFoot(hints: readonly string[], back?: string): string {
  const way = hints.length ? `pelo botão, pela margem ou por ${hints.join(' ou ')}` : 'pelo botão ou pela margem'
  return back ? `Feche ${way} para voltar a ${back}.` : `Feche ${way}.`
}

// ---------- the quick view of a pane (one card for a tab of any type) ----------
// A tab of any type comes to the card alive (main.ts lendPane, pane-shell.ts): only its content, under a header and over a
// foot that are the card's and the same for every type. Outside the Regency the card is modal (the window behind dims and
// goes inert, as before); over the Regency it is docked on the conversation without a veil, and what is around it stays usable.

/**
 *   lend    the tab is not in view: its content comes to the card (the tab shows "sendo espiada" meanwhile), or, for a
 *           `peek: 'fresh'` type, a copy of it (the tab stays as it is);
 *   reveal  the tab is in view right now: only the keyboard goes there (lending it would leave a hole where the person looks);
 *   refuse  its type does not lend (`peek: 'none'`): the card opens with the reason and "Ir até a guia";
 *   slot    no tab, a live slot: the agent's own card, the way it always opened (a terminal built for the card);
 *   none    no tab and nothing live behind the id.
 */
export type PaneRoute = 'lend' | 'reveal' | 'refuse' | 'slot' | 'none'

export interface PaneRouteInput {
  hasTab: boolean
  /** The tab is in view (tabInView); ignored without a tab. */
  inView: boolean
  /** The slot behind the id, when there is one. */
  slot?: Pick<SlotState, 'status'> | undefined
  /** The type's lending plan (pane-loan-rules.ts paneLendPlan). */
  plan: LendPlan
}

export function paneRoute(i: PaneRouteInput): PaneRoute {
  if (!i.hasTab) return peekRoute(i.slot, false) === 'card' ? 'slot' : 'none'
  if (i.inView) return 'reveal'
  return i.plan === 'none' ? 'refuse' : 'lend'
}

/** What the header says the pane is, by its type id (an agent's terminal is "agente", a plain one "terminal"). */
const PANE_KIND_LABELS: Readonly<Record<string, string>> = {
  terminal: 'terminal', note: 'nota', 'md-preview': 'prévia', 'image-preview': 'imagem', 'html-preview': 'prévia HTML', web: 'navegador',
  channel: 'canal', process: 'processo', settings: 'sistema', keybindings: 'sistema', extensions: 'sistema', empty: 'guia vazia',
}

export function paneKindLabel(typeId: string, agent: boolean): string {
  if (agent) return 'agente'
  return PANE_KIND_LABELS[typeId] ?? 'guia'
}

/** What the card reads of a pane at the instant it paints (main.ts builds it). */
export interface PaneCardFacts {
  /** The tab's title (a slot's as its tab shows it). */
  title: string
  typeId: string
  /** An AI agent's pane (a slot whose kind is not 'shell'). */
  agent: boolean
  /** Where it lives: the desk's name, "Gaveta", or the pad's title. */
  place?: string | undefined
  /** The colour of its desk (a hue name of the palette), for the dot before the place. */
  color?: string | undefined
  /** A slot's turn line (peekHeader), for a pane with a slot. */
  slot?: PeekHeader | undefined
  /** The pane sleeps by itself (its slot hibernated). */
  asleep: boolean
  /** Its desk sleeps. */
  deskAsleep: boolean
}

export type PaneStateTone = TurnState | 'asleep'

export interface PaneCardHead {
  title: string
  /** The type's tag ("nota", "canal", "agente"…). */
  kind: string
  /** "em <mesa>", or nothing when the place is unknown. */
  where: string | undefined
  color: string | undefined
  /** The state at the header's right: asleep wins over the turn; a pane without a slot and awake has none. */
  state: { text: string; tone: PaneStateTone } | undefined
  /** The card's accessible name. */
  label: string
}

export const ASLEEP_TEXT = 'dormindo'

export function paneCardHead(f: PaneCardFacts): PaneCardHead {
  const state = f.asleep || f.deskAsleep ? { text: ASLEEP_TEXT, tone: 'asleep' as const } : f.slot ? { text: f.slot.text, tone: f.slot.state } : undefined
  return { title: f.title, kind: paneKindLabel(f.typeId, f.agent), where: f.place ? `em ${f.place}` : undefined, color: f.color, state, label: peekLabel(f.title) }
}

export const WAKE_LABEL = 'Acordar'

export interface PaneCardFoot {
  /** "Acordar": only while the pane or its desk sleeps; `what` says which one wakes (the desk wakes whole). */
  wake: { label: string; title: string; what: 'desk' | 'pane' } | undefined
  /** "Ir até a guia": the card closes, the tab comes forward with the keyboard. "Abrir guia" (bring it to the desk the person is on) is the same for a tab that already lives on a desk, so only this one shows. */
  go: { label: string; title: string }
  /** How to close, in one short line ("Esc aqui fecha · Ctrl+Shift+O"). */
  hint: string
}

export function paneCardFoot(f: Pick<PaneCardFacts, 'asleep' | 'deskAsleep' | 'place'>, hints: readonly string[]): PaneCardFoot {
  const wake = f.deskAsleep
    ? { label: WAKE_LABEL, title: `Acordar a mesa${f.place ? ` ${f.place}` : ''}: as guias dela voltam a rodar`, what: 'desk' as const }
    : f.asleep ? { label: WAKE_LABEL, title: 'Acordar a guia: o processo dela volta a rodar', what: 'pane' as const } : undefined
  return {
    wake,
    go: { label: GO_PANE_LABEL, title: 'Ir até a guia: fecha o cartão, devolve a guia ao lugar dela e mostra a guia' },
    hint: hints.length ? `Esc aqui fecha · ${hints.join(' ou ')}` : 'Esc aqui fecha',
  }
}

/** The sentence in the card's body when the pane could not come (its type does not lend yet, it is gone, or held elsewhere). */
export function paneRefusalText(why: LendRefusal): string {
  switch (why) {
    case 'none': return 'Ainda não dá para espiar este tipo de guia.'
    case 'lent': return 'Esta guia já está sendo espiada em outro lugar.'
    case 'unknown': return 'Esta guia não existe mais.'
  }
}

/** Where an Esc lands while the card shows a pane: in its content, its header or foot, the element that opened it, or elsewhere. */
export type QuickEscPlace = 'content' | 'chrome' | 'opener' | 'outside'

/**
 * Whether that Esc closes the card. In the content it is always the content's (the agent interrupts with it, the editor
 * closes its widgets). Modal, everything else of the window is behind the veil: it closes. Docked (non-modal), only the
 * card's own header and foot close it, and the row that opened it (Space opens, Esc closes); an Esc in the conversation or
 * anywhere else stays theirs.
 */
export function quickEscCloses(modal: boolean, at: QuickEscPlace): boolean {
  if (at === 'content') return false
  return modal || at === 'chrome' || at === 'opener'
}

export interface Box { left: number; top: number; width: number; height: number }

/** The docked card's size: a share of what it sits over, within these bounds; it keeps this much of the bottom free (the box of speech). */
export const DOCK_MARGIN = 12
export const DOCK_MIN_WIDTH = 360
export const DOCK_MAX_WIDTH = 640
export const DOCK_WIDTH_SHARE = 0.62
export const DOCK_MIN_HEIGHT = 240
export const DOCK_MAX_HEIGHT = 540
export const DOCK_KEEP_BELOW = 170

/**
 * Where the docked card sits over `over` (the Regency's conversation): at its top right, a share of its width, tall enough
 * for a terminal and short enough to leave the bottom (the latest lines and the box of speech) in view. Never outside `over`.
 */
export function dockedBox(over: Box): Box {
  const roomW = Math.max(0, over.width - 2 * DOCK_MARGIN)
  const roomH = Math.max(0, over.height - 2 * DOCK_MARGIN)
  const width = Math.round(Math.min(roomW, DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, over.width * DOCK_WIDTH_SHARE)))
  const height = Math.round(Math.min(roomH, Math.max(Math.min(DOCK_MIN_HEIGHT, roomH), Math.min(DOCK_MAX_HEIGHT, roomH - DOCK_KEEP_BELOW))))
  return { left: Math.round(over.left + over.width - DOCK_MARGIN - width), top: Math.round(over.top + DOCK_MARGIN), width, height }
}
