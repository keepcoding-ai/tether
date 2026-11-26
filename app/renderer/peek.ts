// The peek card: a floating card over everything (the open drawer included), 16 px from the window's edges, with the live,
// interactive terminal of ONE slot, or one system screen. The window behind dims and goes `inert` (main.ts does that through
// `onOpenChange`); the native surfaces behind freeze (overlay-freeze.ts reads `#peek[data-open]`).
//
// A slot has one terminal and one pty size (the last resize wins), so the card never mirrors:
//   - a slot WITHOUT a tab: the card's terminal is a real TerminalPanel (panel.ts) built outside dockview (links, copy/paste,
//     theme, font, the exited overlay and the app's key routing come with it). The host registers it in the window's
//     slot→panel map, so the slot's output reaches it like any pane's; it attaches on open and detaches on close;
//   - a slot WITH a tab not in view: the card BORROWS the tab's terminal (TerminalPanel.lend): the same xterm moves into
//     the card (scrollback, selection and scroll position kept; no new attach, no detach) and the tab shows "sendo
//     espiado" in its place. Closing gives it back (TerminalPanel.takeBack), which refits the tab and forces the pty size;
//     a tab disposed meanwhile (closed, moved, hibernated) closes the card.
//
// A system screen (Configurações, Atalhos de teclado, Extensões) is a pane without a slot, built by its type's `create()`
// outside dockview (the host does it) and never saved in the layout. Over an agent it stacks ONE level: the agent's
// terminal stays where it is in the card, hidden under the screen at the same size (its own terminal still attached, a
// lent one still lent: the tab keeps "sendo espiado" and never sits without a terminal), and the header gets "← <agent>".
// Closing the screen (or that button) shows the agent again; closing again closes the card. A screen over a screen
// replaces it.
//
// Closing: the ✕, the chord (peek.close), a press on the margin, Esc on the header's buttons (in the content, agent, shell
// or screen, Esc is always the content's). The keyboard goes back to the exact element that had it before the card opened.
//
// The quick view of a pane (`openPane`): ONE tab of any type, lent alive out of its tab (main.ts lendPane, pane-shell.ts),
// under a header and over a foot that are the card's and the same for every type (peek-rules.ts paneCardHead/paneCardFoot):
// the type's icon or the agent's identity, the title, the type's tag, "em <mesa>" with its colour, the extensions' emblems
// (the owner's seal), the state, ✕; the tab's menu at the left of the foot, "Acordar" while it sleeps and "Ir até a guia" at
// the right. Its body is only the pane's content; for a type that declares `peek: 'fresh'` (the HTML preview) it is a copy
// the type built (pane-fresh.ts), and the tab stays as it was, with no notice and no eye. A native surface in the body (the
// browser's page) lives on: the modal card's freeze spares what is inside it (overlay-freeze.ts). Two ways to show it:
//   - modal (no `over`): the card of always, over the dimmed, inert window;
//   - docked (`over`: the Regency's conversation): no veil, nothing inert, no trapped Tab; it sits at the top right of
//     `over` (peek-rules.ts dockedBox) and follows its size; `over` leaving the screen closes it. Esc closes only in the
//     card's header and foot and on the row that opened it (quickEscCloses).
// Another pane asked meanwhile takes its place (the one shown goes back to its tab first): one card at a time.
import type { SlotState } from '../../src/daemon/protocol.ts'
import { icon, ICON_NAMES, KIND_ICON, type IconName } from './icons.ts'
import { identityOf, markOf } from './agent-identity.ts'
import { emblemBadge, emblemOfPanel } from './tab-emblems.ts'
import type { TabEmblem } from './ext-api.ts'
import { emblemNode, type MakeIcon } from './door/tab-emblem-rules.ts'
import type { TerminalPanel } from './panel.ts'
import type { LendRefusal } from './pane-loan-rules.ts'
import {
  backButton, cardMutesChord, closeTip, dockedBox, lentNotice, paneCardFoot, paneCardHead, paneRefusalText, peekDismiss, peekFoot, peekHeader, peekLabel, peekMenuPlan, peekOpenButton,
  quickEscCloses, screenFoot, screenMenuPlan, screenOpenButton, screenOpenPlan, type Box, type PaneCardFacts, type PeekMenuItem, type PeekOpenButton, type PeekTop, type QuickEscPlace,
} from './peek-rules.ts'
import { lentNoticeElement, type ShellLoan } from './pane-shell.ts'
import {
  NO_OFFSET, clampOffset, dragAllowed, dragStarted, escWord, quickBox, quickEscAction, shownSize, sizeButton, sizeOnShow, toggledSize,
  type Offset, type QuickAbilities, type QuickFrame, type QuickSize,
} from './quick-card-rules.ts'
import { placeEntries, type MenuSpec, type PlaceHost } from './place-menu.ts'
import { OPEN_ELSEWHERE_LABEL } from './sessions-rules.ts'

/** A system screen built for the card (main.ts peekScreen): its pane id, its type, the tab's icon and title, its content. */
export interface PeekScreen {
  paneId: string
  typeId: string
  title: string
  icon: IconName
  element: HTMLElement
  /** The keyboard to the screen (its type's `focus`). */
  focus(): void
  /** Disposes the screen when the card lets it go (what was changed in it is already saved). */
  dispose(): void
}

export interface PeekHost extends PlaceHost {
  /** The app's context menu at (x, y); `opener` gets the focus back when it closes. */
  contextMenu(x: number, y: number, entries: MenuSpec[], opener?: HTMLElement): void
  /** "Copiar link do painel" for the slot. */
  copyLink(slotId: string): void
  /** The tab's "Emblema…" popover for the slot's tab at (x, y); nothing when the slot has no tab. */
  emblemMenu(slotId: string, x: number, y: number, back?: () => void): void
  slot(slotId: string): SlotState | undefined
  /** A TerminalPanel for the slot, initialised and registered where the slot's output is routed. */
  createPanel(slotId: string): TerminalPanel
  /** Disposes the card's panel and unregisters it; `detach: false` when another view of the slot took over. */
  releasePanel(panel: TerminalPanel, detach: boolean): void
  /** "Abrir nesta mesa" of a screen: the screen as a tab of the active desk, the way its command opened it before (the card is already closed). */
  openScreenHere(typeId: string): void
  /** "Abrir em outra mesa" of a screen: the desks, a pick opens it there (the person stays); "Escolher o lugar…" opens it here and then "Mover…". */
  screenPlaces(): PlaceHost
  /** "Abrir nesta mesa": puts the slot in a tab of the active desk (the card is already closed). */
  openHere(slotId: string): void
  /** "Ir para a guia": brings the slot's tab forward and gives it the keyboard (the card is already closed, the terminal back). */
  goToTab(slotId: string): void
  /** The tab's terminal was lent to the card or given back: the tab's eye mark and anything that reads `lentSlot` repaint. */
  onLendChange(slotId: string, lent: boolean): void
  /** The chord that closes the card, as the person reads it ("" when unbound). */
  closeHint(): string
  /** The chord that toggles the drawer, which closes the card while it is open ("" when unbound). */
  toggleHint(): string
  /** The card opened or closed: a modal one makes the window behind inert / gives it back; a docked one leaves it as it is. Called before the focus moves. */
  onOpenChange(open: boolean, modal: boolean): void
  /** Where the keyboard goes when the element that had it before the card is gone. */
  fallbackFocus(): void
  /** Lends a pane's live content into `host` (main.ts lendPane); `lost` runs when the pane goes away while lent. */
  lendPane(paneId: string, host: HTMLElement, lost: () => void): ShellLoan | LendRefusal
  /** What the header and the foot show of a pane right now; undefined once it is gone. */
  paneFacts(paneId: string): PeekPaneFacts | undefined
  /** The tab's menu of the pane, the manager's (aimed at it, nothing comes forward), at (x, y); `opener` gets the keyboard back. */
  paneMenu(paneId: string, x: number, y: number, opener: HTMLElement): void
  /** "Ir até a guia": the pane to the front with the keyboard (the card is already closed, the content back in its tab). */
  goToPane(paneId: string): void
  /** "Acordar": the pane's desk (whole) or the pane alone wakes; the answer is the refusal's sentence, or nothing. */
  wakePane(paneId: string, what: 'desk' | 'pane'): Promise<string | undefined>
  /** The keyboard to the pane's content (its type's focus), wherever the content is. */
  focusPane(paneId: string): void
  /** The terminal of a slot's pane (the content's key routing asks whether a key came from the card's terminal). */
  terminalOf(paneId: string): TerminalPanel | undefined
  /** A pane was lent to the card or given back: its tab's eye mark repaints. */
  onPaneLendChange(paneId: string, lent: boolean): void
}

/** What the card shows of a pane (main.ts builds it): the rules' facts, the icon, the slot's kind, the tab's emblems. */
export interface PeekPaneFacts extends PaneCardFacts {
  /** The type's icon, or the engine's for a slot's pane. */
  icon: IconName
  /** The slot's kind behind the pane ('claude', 'shell'…): the agent's identity mark comes from it. */
  slotKind?: string | undefined
  /** The extensions' emblems on the tab (the owner's seal among them), in the tab's order. */
  emblems: readonly TabEmblem[]
}

/** How a pane is shown: `over` docks the card on that element (no veil); `focus: false` leaves the keyboard where it is (docked only); `from` gets it back on close. */
export interface PeekPaneOptions {
  over?: HTMLElement | undefined
  focus?: boolean | undefined
  from?: HTMLElement | undefined
  /** Docked only: the area of "Ampliar" and of a drag, and what the host allows (quick-card-rules.ts). Without it the docked card neither grows nor moves. */
  quick?: QuickFrame | undefined
}

const NO_ABILITIES: QuickAbilities = { expand: false, move: false }
const DRAG_HINT = 'Arraste o cabeçalho para mover o cartão; duplo clique o devolve ao lugar'

/** A slot shown: `lent` when the panel is the slot's tab's terminal, borrowed (else the card's own); `el` is what sits in the body. */
interface SlotView { kind: 'slot'; slotId: string; panel: TerminalPanel; lent: boolean; el: HTMLElement }
interface ScreenView { kind: 'screen'; screen: PeekScreen; wrap: HTMLElement }
/** A pane shown: `loan` while its content is here, `refusal` when it could not come; `holder` is what sits in the body; `note` a wake's refusal. */
interface PaneView { kind: 'pane'; paneId: string; loan: ShellLoan | undefined; refusal: LendRefusal | undefined; holder: HTMLElement; note?: string | undefined }

/** The icon of an emblem's name, when the app has it (an unknown name draws an empty chip, as on the tab). */
const makeIcon: MakeIcon = name => ((ICON_NAMES as readonly string[]).includes(name) ? icon(name as IconName) : undefined)

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  return e
}

function iconButton(cls: string, glyph: IconName, label: string): HTMLButtonElement {
  const b = make('button', cls)
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  b.append(icon(glyph))
  return b
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text
}

/** The card's body when the pane could not come: the closed eye and the sentence ("Ir até a guia" is in the foot). */
function reasonElement(text: string): HTMLElement {
  const root = make('div', 'qv-reason')
  root.setAttribute('role', 'status')
  const ill = make('span', 'ill')
  ill.append(icon('eye-closed'))
  const p = make('p', 't')
  p.textContent = text
  root.append(ill, p)
  return root
}

/** What Tab may visit inside a screen. */
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

export class PeekCard {
  readonly root: HTMLElement
  private readonly card: HTMLElement
  private readonly body: HTMLElement
  private readonly kind: HTMLElement
  /** The emblem the pane wears, or the agent's letter: the identity piece's mark, right after the engine's icon. */
  private readonly mark: HTMLElement
  private markKey = ''
  private readonly title: HTMLElement
  private readonly state: HTMLElement
  private readonly foot: HTMLElement
  private readonly backBtn: HTMLButtonElement
  private readonly backLabel: HTMLElement
  private readonly openBtn: HTMLButtonElement
  private readonly openLabel: HTMLElement
  private readonly moreBtn: HTMLButtonElement
  private readonly menuBtn: HTMLButtonElement
  private readonly closeBtn: HTMLButtonElement
  private readonly host: PeekHost
  /** The header and foot of a slot or a screen; a pane's (`qv*`) take their place in the card while a pane is shown. */
  private readonly head: HTMLElement
  private readonly qvHead = make('header', 'peek-head qv-head')
  private readonly qvKind = make('span', 'peek-kind')
  private readonly qvMark = make('span', 'peek-mark-slot')
  private qvMarkKey = ''
  private readonly qvTitle = make('span', 'peek-title')
  private readonly qvType = make('span', 'qv-type')
  private readonly qvWhere = make('span', 'qv-where')
  private readonly qvWhereText = make('span', 'qv-where-t')
  private readonly qvEmblems = make('span', 'ext-emblems')
  private qvEmblemKey = ''
  private readonly qvState = make('span', 'peek-state')
  private readonly qvClose = iconButton('ib peek-close qv-close', 'x', 'Fechar o cartão')
  /** "Ampliar" / "Reduzir" of the docked card (quick-card-rules.ts sizeButton); hidden where the tier has no large card. */
  private readonly qvSize = iconButton('ib qv-size', 'arrows-out-simple', 'Ampliar')
  /** The docked card's size and its displacement by a drag: neither outlives a close, a swap or a size change. */
  private size: QuickSize = 'docked'
  private offset: Offset = NO_OFFSET
  /** A press on the header: a click until it travels DRAG_THRESHOLD px, a drag after. */
  private drag: { id: number; x0: number; y0: number; from: Offset; moving: boolean } | undefined
  /** The click that ends a drag is the drag's, not the pressed button's. */
  private swallowClick = false
  private readonly qvFoot = make('footer', 'qv-foot')
  private readonly qvMenu = iconButton('ib qv-menu', 'dots-three', 'Ações desta guia')
  private readonly qvHint = make('span', 'qv-hint')
  private readonly qvNote = make('span', 'qv-note')
  private readonly qvWake = make('button', 'qv-wake')
  /** The strip over the content while the pane or its desk sleeps: what is shown is not running, and "Acordar" beside it. */
  private readonly qvBand = make('div', 'qv-band')
  private readonly qvBandText = make('span', 'qv-band-t')
  private readonly qvGo = make('button', 'qv-go')
  /** What the card shows on top. */
  private current: SlotView | ScreenView | PaneView | undefined
  /** The agent under a screen (one level), kept as it was: its terminal attached or still lent. */
  private under: SlotView | undefined
  /** The element that had the keyboard when the card opened; it gets it back on close. */
  private returnTo: HTMLElement | undefined
  /** Docked: what the card sits over, and what follows its size. Undefined: modal. */
  private dock: { over: HTMLElement; observer: ResizeObserver; onResize: () => void; frame: QuickFrame | undefined } | undefined
  /** The element a docked pane was asked from (the row): an Esc there closes the card. */
  private opener: HTMLElement | undefined

  constructor(host: PeekHost) {
    this.host = host
    const el = make
    this.root = el('div', 'peek-layer')
    this.root.id = 'peek'
    this.root.dataset.open = 'false'
    this.root.hidden = true
    this.card = el('section', 'peek-card')
    this.card.setAttribute('role', 'dialog')
    this.card.setAttribute('aria-modal', 'true')
    const head = el('header', 'peek-head')
    this.head = head
    // "← <agent>": over a screen that covers an agent, back to the agent (the screen closes).
    this.backBtn = el('button', 'peek-back')
    this.backBtn.type = 'button'
    this.backBtn.hidden = true
    this.backLabel = el('span', 'label')
    this.backBtn.append(icon('arrow-left'), this.backLabel)
    this.backBtn.addEventListener('click', () => this.back())
    const id = el('div', 'peek-id')
    this.kind = el('span', 'peek-kind')
    this.mark = el('span', 'peek-mark-slot')
    this.mark.hidden = true
    this.title = el('span', 'peek-title')
    this.state = el('span', 'peek-state')
    // The state changes while the card is open (working, waiting, ended): a screen reader hears it, politely.
    this.state.setAttribute('aria-live', 'polite')
    id.append(this.kind, this.mark, this.title, this.state)
    const acts = el('div', 'peek-acts')
    this.openBtn = el('button', 'peek-open')
    this.openBtn.type = 'button'
    this.openLabel = el('span', 'label')
    this.openBtn.addEventListener('click', () => {
      const cur = this.current
      if (cur?.kind === 'screen') this.openScreenHere()
      else if (cur?.kind === 'slot' && cur.lent) this.goToTab()
      else this.openHere()
    })
    // The split button: "Abrir nesta mesa" with the ▾ stuck to it, which lists the other desks.
    this.moreBtn = el('button', 'peek-open-more')
    this.moreBtn.type = 'button'
    this.moreBtn.title = OPEN_ELSEWHERE_LABEL
    this.moreBtn.setAttribute('aria-label', OPEN_ELSEWHERE_LABEL)
    this.moreBtn.setAttribute('aria-haspopup', 'menu')
    this.moreBtn.append(icon('caret-down'))
    this.moreBtn.addEventListener('click', () => this.showPlaces())
    const split = el('div', 'peek-split')
    split.append(this.openBtn, this.moreBtn)
    this.paintOpenButton(peekOpenButton(false))
    this.menuBtn = el('button', 'peek-menu ib')
    this.menuBtn.type = 'button'
    this.menuBtn.title = 'Mais ações'
    this.menuBtn.setAttribute('aria-label', 'Mais ações')
    this.menuBtn.setAttribute('aria-haspopup', 'menu')
    this.menuBtn.append(icon('dots-three'))
    this.menuBtn.addEventListener('click', () => this.showMenu())
    // The card's main action: "Fechar", the accent button at the right end (it keeps its colour as an icon in a narrow window).
    this.closeBtn = el('button', 'peek-close primary')
    this.closeBtn.type = 'button'
    this.closeBtn.setAttribute('aria-label', 'Fechar o cartão')
    this.closeBtn.append(icon('x'), Object.assign(el('span', 'label'), { textContent: 'Fechar' }))
    this.closeBtn.addEventListener('click', () => this.dismiss())
    acts.append(split, this.menuBtn, this.closeBtn)
    head.append(this.backBtn, id, acts)
    this.body = el('div', 'peek-body')
    this.foot = el('footer', 'peek-foot')
    this.card.append(head, this.body, this.foot)
    this.root.append(this.card)
    // The layer is the margin: a press that lands on it (not on the card) closes.
    this.root.addEventListener('mousedown', ev => { if (ev.target === this.root) { ev.preventDefault(); this.dismiss() } })
    // Tab goes round inside the card: the header's buttons, then the content, then the buttons again. (Inside the terminal
    // Tab is the program's: xterm sends it, so it never gets here.)
    this.root.addEventListener('keydown', ev => this.trapTab(ev))
    // The document-level chords of extensions that aim at the desk's active tab (peek-rules.ts CARD_MUTED_CHORDS): with a lent tab
    // holding the keyboard they would act on the tab behind the card. Swallowed first (capture): their listeners skip a
    // prevented event.
    document.addEventListener('keydown', ev => {
      const a = document.activeElement
      const inTerminal = ev.target instanceof Element && ev.target.closest('.xterm') !== null
      const keys = { lent: this.isOpen && !!this.lentPane, modal: this.isModal, focusInCard: !!a && a !== document.body && this.root.contains(a) }
      if (cardMutesChord(keys, { key: ev.key, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, inTerminal })) ev.preventDefault()
    }, true)
    this.buildPaneChrome()
    document.body.append(this.root)
  }

  /** The header and the foot of a pane in the card: the same for every type (they take the slot's and the screen's place while a pane is shown). */
  private buildPaneChrome(): void {
    const id = make('div', 'peek-id')
    this.qvMark.hidden = true
    this.qvWhere.append(make('span', 'qv-dot'), this.qvWhereText)
    this.qvEmblems.hidden = true
    this.qvState.setAttribute('aria-live', 'polite')
    id.append(this.qvKind, this.qvMark, this.qvTitle, this.qvType, this.qvWhere, this.qvEmblems)
    this.qvClose.addEventListener('click', () => this.dismiss())
    this.qvSize.hidden = true
    this.qvSize.setAttribute('aria-pressed', 'false')
    this.qvSize.addEventListener('click', () => this.setSize(toggledSize(this.size)))
    this.qvBand.hidden = true
    this.qvBand.setAttribute('role', 'status')
    this.qvBand.append(icon('moon'), this.qvBandText, this.qvWake)
    this.qvHead.append(id, this.qvState, this.qvSize, this.qvClose, this.qvBand)
    // Moving the docked card by its header (quick-card-rules.ts dragAllowed): a press stays a click on what it pressed until it
    // travels a few px; then the header holds the pointer and the click that ends the drag is swallowed. A double click on the
    // header (not on a button) puts the card back in its place.
    this.qvHead.addEventListener('pointerdown', ev => this.dragDown(ev))
    this.qvHead.addEventListener('pointermove', ev => this.dragMove(ev))
    this.qvHead.addEventListener('pointerup', ev => this.dragEnd(ev))
    this.qvHead.addEventListener('pointercancel', ev => this.dragEnd(ev))
    this.qvHead.addEventListener('lostpointercapture', ev => this.dragEnd(ev))
    this.qvHead.addEventListener('click', ev => {
      if (!this.swallowClick) return
      this.swallowClick = false
      ev.preventDefault()
      ev.stopPropagation()
    }, true)
    this.qvHead.addEventListener('dblclick', ev => {
      if (!this.movable() || (ev.target instanceof Element && ev.target.closest('button'))) return
      ev.preventDefault()
      this.backHome()
    })
    this.qvMenu.setAttribute('aria-haspopup', 'menu')
    this.qvMenu.addEventListener('click', () => {
      const cur = this.current
      if (cur?.kind !== 'pane') return
      const r = this.qvMenu.getBoundingClientRect()
      this.host.paneMenu(cur.paneId, Math.round(r.left), Math.round(r.bottom + 2), this.qvMenu)
    })
    this.qvNote.hidden = true
    this.qvNote.setAttribute('role', 'status')
    this.qvWake.type = 'button'
    this.qvWake.hidden = true
    this.qvWake.addEventListener('click', () => this.wake())
    this.qvGo.type = 'button'
    this.qvGo.addEventListener('click', () => this.goToPane())
    this.qvFoot.append(this.qvMenu, this.qvHint, this.qvNote, make('span', 'qv-sp'), this.qvGo)
  }

  get isOpen(): boolean { return this.current !== undefined }
  /** The slot the card holds: on top, or under a screen. */
  get slotId(): string | undefined { return this.current?.kind === 'slot' ? this.current.slotId : this.under?.slotId }
  /** The slot whose tab's terminal is lent to the card right now (on top or under a screen). */
  get lentSlot(): string | undefined {
    const v = this.current?.kind === 'slot' ? this.current : this.under
    return v?.lent ? v.slotId : undefined
  }
  /** The card's terminal on top: its own, the lent one, or a lent terminal pane's (main.ts asks whether a key event came from it). */
  get panel(): TerminalPanel | undefined {
    const cur = this.current
    if (cur?.kind === 'slot') return cur.panel
    return cur?.kind === 'pane' && cur.loan ? this.host.terminalOf(cur.paneId) : undefined
  }
  /** The pane shown (lent, or refused with its reason). */
  get paneId(): string | undefined { return this.current?.kind === 'pane' ? this.current.paneId : undefined }
  /** The pane whose content is in the card right now (its tab shows "sendo espiada"). */
  get lentPane(): string | undefined { return this.current?.kind === 'pane' && this.current.loan ? this.current.paneId : undefined }
  /** Why the pane shown could not come (its type does not lend yet, it is gone). */
  get paneRefusal(): LendRefusal | undefined { return this.current?.kind === 'pane' ? this.current.refusal : undefined }
  /** Modal (the window behind inert) or docked over an element (nothing behind changes). */
  get isModal(): boolean { return this.dock === undefined }
  /** The pane id of the screen on top. */
  get screenId(): string | undefined { return this.current?.kind === 'screen' ? this.current.screen.paneId : undefined }
  /** The screen on top's type. */
  get screenType(): string | undefined { return this.current?.kind === 'screen' ? this.current.screen.typeId : undefined }
  /** The slot under the screen on top. */
  get underSlot(): string | undefined { return this.under?.slotId }
  contains(node: Node | null): boolean { return !!node && this.root.contains(node) }
  /** Whether a node is in the card's content (the terminal or the screen), not its header. */
  inContent(node: Node | null): boolean { return !!node && this.body.contains(node) }

  /** What is on top for the slot-and-screen rules (a pane stacks nothing: it is closed before a slot or a screen opens). */
  private get top(): PeekTop { const k = this.current?.kind; return k === 'slot' || k === 'screen' ? k : 'none' }

  /** Whether an Esc at `target` closes the card (peek-rules.ts quickEscCloses): never in the content; docked, only on the card and the row that opened it. */
  escClosesAt(target: Node | null): boolean {
    const at: QuickEscPlace = this.inContent(target) ? 'content'
      : target && this.card.contains(target) ? 'chrome'
      : target && this.opener && target === this.opener ? 'opener'
      : 'outside'
    return quickEscCloses(this.isModal, at)
  }

  /**
   * Shows ONE pane (a tab of any type) in the card, its live content lent out of its tab; a pane already shown goes back
   * to its tab first (one card at a time), and a slot or a screen in the card closes first. The same pane again only takes
   * the keyboard (when asked). A type that does not lend, or a pane gone, shows the reason and "Ir até a guia".
   */
  openPane(paneId: string, opts: PeekPaneOptions = {}): void {
    const over = opts.over
    const cur = this.current
    if (cur?.kind === 'pane' && cur.paneId === paneId && this.dock?.over === over) {
      if (over) this.opener = opts.from ?? this.activeOutside() ?? this.opener
      this.render()
      if (!over || opts.focus !== false) this.focusContent()
      return
    }
    // A slot or a screen, or the card in the other mode: it closes first (the keyboard's way back is kept).
    let from = opts.from
    if (cur && (cur.kind !== 'pane' || this.dock?.over !== over)) from ??= this.reset()
    const opening = !this.current
    if (opening) {
      this.rememberReturn(from)
      if (over) this.startDock(over, opts.quick)
    } else {
      this.releaseAll(true)
      if (this.dock) this.dock.frame = opts.quick
    }
    if (over) {
      // Docked, the row that asked last is where Esc closes and where the keyboard goes back (Space on another row swaps).
      this.opener = from ?? this.activeOutside()
      if (this.opener) this.returnTo = this.opener
    }
    // Another pane in the card: back in its place (a drag never carries over); a large card stays large, a new opening is docked.
    const size = sizeOnShow(this.size, opening)
    this.resetPlace()
    this.size = size
    const holder = make('div', 'peek-pane')
    holder.dataset.pane = paneId
    this.body.replaceChildren(holder)
    const view: PaneView = { kind: 'pane', paneId, loan: undefined, refusal: undefined, holder }
    this.current = view
    const got = this.host.lendPane(paneId, holder, () => this.paneLost(view))
    if (typeof got === 'string') {
      view.refusal = got
      holder.append(reasonElement(paneRefusalText(got)))
    } else {
      view.loan = got
      // A copy (`fresh`) leaves the tab as it was: no eye on it.
      if (!got.fresh) this.host.onPaneLendChange(paneId, true)
    }
    this.placeDocked()
    // `over` was not on screen: the card closed at once (the pane is back in its tab).
    if (this.current !== view) return
    // Modal, the keyboard must come in (the window behind is inert); docked, it stays where it is unless asked.
    this.shown(opening, !over || opts.focus !== false)
  }

  /** The docked card follows what it sits over; `over` gone from the screen (another desk shown) closes it. main.ts calls it after a desk switch. */
  checkDock(): void { this.placeDocked() }

  /** Closes what the card shows for a mode change and hands back where the keyboard was to return. */
  private reset(): HTMLElement | undefined {
    const back = this.returnTo
    this.close({ restoreFocus: false })
    return back
  }

  private activeOutside(): HTMLElement | undefined {
    const a = document.activeElement
    return a instanceof HTMLElement && a !== document.body && !this.root.contains(a) ? a : undefined
  }

  private startDock(over: HTMLElement, frame: QuickFrame | undefined): void {
    const onResize = (): void => this.placeDocked()
    const observer = new ResizeObserver(onResize)
    observer.observe(over)
    window.addEventListener('resize', onResize)
    this.dock = { over, observer, onResize, frame }
    this.card.setAttribute('aria-modal', 'false')
  }

  private endDock(): void {
    const d = this.dock
    if (!d) return
    this.dock = undefined
    d.observer.disconnect()
    window.removeEventListener('resize', d.onResize)
    this.card.setAttribute('aria-modal', 'true')
    for (const p of ['left', 'top', 'width', 'height'] as const) this.card.style.removeProperty(p)
    this.resetPlace()
    this.paintSize(NO_ABILITIES)
    delete this.root.dataset.size
  }

  /** The docked card back to small and to its place, with no drag in course. */
  private resetPlace(): void {
    this.size = 'docked'
    this.offset = NO_OFFSET
    this.endDrag()
  }

  /** What the docked card's host allows on its tier right now (nothing without a host frame). */
  private abilities(): QuickAbilities {
    return this.dock?.frame?.abilities() ?? NO_ABILITIES
  }

  /** The docked box over the conversation and the area the card lives in (the Regency; the conversation without a host frame). */
  private geometry(): { docked: Box; area: Box } | undefined {
    const d = this.dock
    if (!d) return undefined
    const r = d.over.getBoundingClientRect()
    if (!d.over.isConnected || r.width === 0 || r.height === 0) return undefined
    const box = (x: DOMRect): Box => ({ left: x.left, top: x.top, width: x.width, height: x.height })
    const a = d.frame?.area.getBoundingClientRect()
    return { docked: dockedBox(box(r)), area: a && a.width > 0 && a.height > 0 ? box(a) : box(r) }
  }

  /**
   * Puts the docked card in its box: at the top right of what it sits over (peek-rules.ts dockedBox), moved by a drag, or
   * large over the Regency (quick-card-rules.ts quickBox); that hidden or gone, the card closes.
   */
  private placeDocked(): void {
    const d = this.dock
    if (!d || !this.current) return
    const g = this.geometry()
    if (!g) { this.close({ restoreFocus: false }); return }
    const a = this.abilities()
    const size = shownSize(this.size, a)
    const shrunk = size !== this.size
    if (shrunk) { this.size = size; this.offset = NO_OFFSET }
    if (!a.move && !this.drag) this.offset = NO_OFFSET
    const b = quickBox(this.size, g.docked, g.area, this.offset)
    const px = (n: number): string => `${n}px`
    if (this.card.style.left !== px(b.left)) this.card.style.left = px(b.left)
    if (this.card.style.top !== px(b.top)) this.card.style.top = px(b.top)
    if (this.card.style.width !== px(b.width)) this.card.style.width = px(b.width)
    if (this.card.style.height !== px(b.height)) this.card.style.height = px(b.height)
    this.paintSize(a)
    // The foot's Esc word and the ✕'s tooltip follow the size.
    if (shrunk) this.render()
  }

  /** The header's "Ampliar"/"Reduzir" and the marks CSS reads (`#peek[data-size]`, the card's `data-movable`); writes only on a change. */
  private paintSize(a: QuickAbilities): void {
    const pane = this.current?.kind === 'pane' && this.dock !== undefined
    this.qvSize.hidden = !(pane && a.expand)
    const b = sizeButton(this.size)
    if (this.qvSize.title !== b.title) {
      this.qvSize.title = b.title
      this.qvSize.setAttribute('aria-label', b.label)
      this.qvSize.replaceChildren(icon(b.icon))
    }
    const pressed = String(this.size === 'large')
    if (this.qvSize.getAttribute('aria-pressed') !== pressed) this.qvSize.setAttribute('aria-pressed', pressed)
    if (this.dock && this.root.dataset.size !== this.size) this.root.dataset.size = this.size
    const movable = String(pane && this.size === 'docked' && a.move)
    if (this.card.dataset.movable !== movable) {
      this.card.dataset.movable = movable
      if (movable === 'true') { this.qvHead.title = DRAG_HINT; this.card.setAttribute('aria-description', DRAG_HINT) } else { this.qvHead.removeAttribute('title'); this.card.removeAttribute('aria-description') }
    }
  }

  /** "Ampliar" / "Reduzir": only the card's box changes (the pane's content stays where it is in the body); a drag is undone. */
  private setSize(size: QuickSize): void {
    if (!this.dock || this.current?.kind !== 'pane') return
    this.size = shownSize(size, this.abilities())
    this.offset = NO_OFFSET
    this.endDrag()
    this.placeDocked()
    this.render()
  }

  /** Esc where it closes the card (escClosesAt): the large docked card reduces, anything else closes (quick-card-rules.ts quickEscAction). */
  escape(target: Node | null): void {
    const at: QuickEscPlace = this.inContent(target) ? 'content'
      : target && this.card.contains(target) ? 'chrome'
      : target && this.opener && target === this.opener ? 'opener'
      : 'outside'
    const size = this.current?.kind === 'pane' ? this.size : 'docked'
    const act = quickEscAction(this.isModal, size, at)
    if (act === 'reduce') this.setSize('docked')
    else if (act === 'close') this.dismiss()
  }

  /** The docked card can be dragged now. */
  private movable(): boolean { return this.card.dataset.movable === 'true' }

  private dragDown(ev: PointerEvent): void {
    this.swallowClick = false
    if (!this.dock || this.current?.kind !== 'pane') return
    if (!dragAllowed({ size: this.size, abilities: this.abilities(), pointerType: ev.pointerType, button: ev.button })) return
    this.drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, from: this.offset, moving: false }
  }

  private dragMove(ev: PointerEvent): void {
    const g = this.drag
    if (!g || ev.pointerId !== g.id) return
    const dx = ev.clientX - g.x0
    const dy = ev.clientY - g.y0
    if (!g.moving) {
      if (!dragStarted(dx, dy)) return
      g.moving = true
      try { this.qvHead.setPointerCapture(g.id) } catch { /* the pointer is gone: the next move ends nothing */ }
      this.card.dataset.dragging = 'true'
      window.getSelection()?.removeAllRanges()
    }
    ev.preventDefault()
    const geo = this.geometry()
    if (!geo) return
    this.offset = clampOffset(geo.docked, { x: g.from.x + dx, y: g.from.y + dy }, geo.area)
    this.placeDocked()
  }

  private dragEnd(ev: PointerEvent): void {
    const g = this.drag
    if (!g || ev.pointerId !== g.id) return
    // A drag that moved: the click it ends with is not the pressed button's.
    if (g.moving && ev.type === 'pointerup') this.swallowClick = true
    this.endDrag()
  }

  private endDrag(): void {
    const g = this.drag
    this.drag = undefined
    delete this.card.dataset.dragging
    if (g?.moving && this.qvHead.hasPointerCapture(g.id)) this.qvHead.releasePointerCapture(g.id)
  }

  /** Double click on the header: the moved card goes back to its place. */
  private backHome(): void {
    if (this.offset.x === 0 && this.offset.y === 0) return
    this.offset = NO_OFFSET
    this.placeDocked()
  }

  /** The pane shown went away while lent (closed, moved to another desk): the card closes, nothing to give back. */
  private paneLost(v: PaneView): void {
    if (this.current !== v) return
    v.loan = undefined
    this.host.onPaneLendChange(v.paneId, false)
    this.close()
  }

  /** "Ir até a guia": the content goes back to its tab first, then the tab comes forward with the keyboard. */
  private goToPane(): void {
    const id = this.paneId
    if (!id) return
    this.close({ restoreFocus: false })
    this.host.goToPane(id)
  }

  /** "Acordar": never by itself (spying a sleeping pane does not wake it); the person's press wakes the desk or the pane. */
  private wake(): void {
    const v = this.current
    if (v?.kind !== 'pane') return
    const what = this.qvWake.dataset.what === 'pane' ? 'pane' : 'desk'
    this.qvWake.disabled = true
    v.note = undefined
    void this.host.wakePane(v.paneId, what).then(refusal => {
      if (this.current !== v) return
      this.qvWake.disabled = false
      v.note = refusal
      this.render()
    })
  }

  /**
   * Shows the slot in the card; another slot already in it is swapped out (its own terminal detached, a lent one given
   * back), and a screen with what is under it too. The slot under the screen on top comes back as it was.
   * `lend`: the slot's tab's terminal, to borrow instead of building one (the slot has a tab not in view).
   * `from`: where the keyboard goes back on close, when it is not where it sits now.
   */
  open(slotId: string, lend?: TerminalPanel, from?: HTMLElement): void {
    // A pane in the card (docked or not) goes back to its tab first: a slot opens in the modal card of always.
    if (this.current?.kind === 'pane' || this.dock) from ??= this.reset()
    if (this.under?.slotId === slotId) { this.back(); return }
    if ((this.current?.kind === 'slot' && this.current.slotId === slotId) || lend?.isLent) { this.focusContent(); return }
    const opening = !this.current
    if (opening) this.rememberReturn(from)
    this.releaseAll(true)
    if (lend) {
      const node = lend.lend(this.noticeFor(slotId), () => this.lost(lend))
      this.current = { kind: 'slot', slotId, panel: lend, lent: true, el: node }
      this.body.replaceChildren(node)
      this.host.onLendChange(slotId, true)
    } else {
      const panel = this.host.createPanel(slotId)
      this.current = { kind: 'slot', slotId, panel, lent: false, el: panel.element }
      this.body.replaceChildren(panel.element)
    }
    this.shown(opening)
  }

  /**
   * Shows a system screen the host built. Over an agent it stacks one level (the agent stays under it, hidden at the same
   * size); over a screen it replaces it (the agent under stays). The same screen again only gets the keyboard.
   */
  openScreen(screen: PeekScreen, from?: HTMLElement, over?: HTMLElement): void {
    if (this.current?.kind === 'pane') from ??= this.reset()
    // Docked (`over`, a screen the Regency asked for) or modal: a card in the other mode closes first.
    if (this.current && this.dock?.over !== over) from ??= this.reset()
    if (this.current?.kind === 'screen' && this.current.screen.paneId === screen.paneId) { if (!over) this.focusContent(); return }
    const opening = !this.current
    if (opening) {
      this.rememberReturn(from)
      // A screen docked over the Regency neither grows nor moves (its header is the screen's, not the pane's).
      if (over) this.startDock(over, undefined)
    }
    if (over) {
      this.opener = from ?? this.activeOutside()
      if (this.opener) this.returnTo = this.opener
    }
    const plan = screenOpenPlan(this.top)
    if (plan.under && this.current?.kind === 'slot') {
      this.under = this.current
      this.under.el.classList.add('peek-under')
    } else if (plan.replace && this.current?.kind === 'screen') {
      this.current.wrap.remove()
      this.current.screen.dispose()
    }
    const wrap = document.createElement('div')
    wrap.className = 'peek-screen'
    wrap.dataset.screen = screen.typeId
    wrap.append(screen.element)
    const view: ScreenView = { kind: 'screen', screen, wrap }
    this.current = view
    this.body.append(wrap)
    if (!over) { this.shown(opening); return }
    this.placeDocked()
    // `over` was not on screen: the card closed at once. Docked, the keyboard stays where it was (the row, the button).
    if (this.current !== view) return
    this.shown(opening, false)
  }

  /** "← <agent>", or closing a screen over an agent: the screen goes, the agent under it is shown again as it was. */
  back(): void {
    const cur = this.current
    const under = this.under
    if (cur?.kind !== 'screen' || !under) return
    this.under = undefined
    cur.wrap.remove()
    cur.screen.dispose()
    under.el.classList.remove('peek-under')
    this.current = under
    this.render()
    this.focusContent()
  }

  /** What the person's close does (✕, "Fechar", the chord, the margin, Esc on the header): back to the agent under a screen, or close. */
  dismiss(): void {
    if (peekDismiss(this.top, !!this.under) === 'back') this.back()
    else this.close()
  }

  /**
   * Closes the card; the session keeps running. A lent terminal goes back to its tab. `detach: false` when another view of
   * the slot already attached (a tab opened meanwhile). `restoreFocus: false` when the caller moves the keyboard itself.
   */
  close(opts: { detach?: boolean; restoreFocus?: boolean } = {}): void {
    if (!this.current) return
    const modal = this.isModal
    this.releaseAll(opts.detach !== false)
    this.body.replaceChildren()
    this.endDock()
    this.opener = undefined
    this.root.dataset.open = 'false'
    delete this.root.dataset.mode
    this.root.hidden = true
    this.host.onOpenChange(false, modal)
    const back = this.returnTo
    this.returnTo = undefined
    if (opts.restoreFocus === false) return
    if (back?.isConnected) back.focus()
    if (!back?.isConnected || document.activeElement !== back) this.host.fallbackFocus()
  }

  /**
   * The slot's view in the card goes away (the session ended with its terminal lent, it was removed, a tab was born for it):
   * on top the card closes; under a screen only the agent goes (given back), the screen stays. `detach: false` as in `close`.
   */
  dropSlot(slotId: string, detach = true): void {
    if (this.current?.kind === 'slot' && this.current.slotId === slotId) { this.close({ detach }); return }
    const under = this.under
    if (under?.slotId !== slotId) return
    this.under = undefined
    under.el.remove()
    this.releaseSlot(under, detach)
    this.render()
  }

  /** Repaints the header and foot from the slot's state, or the screen's (main.ts calls it on every state of the slot shown). */
  render(): void {
    const cur = this.current
    if (!cur) return
    this.useChrome(cur.kind === 'pane')
    if (cur.kind === 'pane') { this.renderPane(cur); return }
    const hints = [this.host.toggleHint(), this.host.closeHint()].filter(h => h !== '')
    const tip = closeTip(hints)
    if (this.closeBtn.title !== tip) this.closeBtn.title = tip
    const underName = this.under ? this.nameOf(this.under.slotId) : undefined
    this.backBtn.hidden = underName === undefined
    if (underName !== undefined) {
      const b = backButton(underName)
      if (this.backLabel.textContent !== b.label) this.backLabel.textContent = b.label
      this.backBtn.title = b.title
      this.backBtn.setAttribute('aria-label', b.aria)
    }
    this.card.dataset.content = cur.kind
    if (cur.kind === 'screen') {
      const s = cur.screen
      if (this.kind.dataset.icon !== s.icon) { this.kind.dataset.icon = s.icon; this.kind.replaceChildren(icon(s.icon)) }
      this.kind.className = 'peek-kind screen'
      this.mark.hidden = true
      if (this.title.textContent !== s.title) this.title.textContent = s.title
      this.state.hidden = true
      this.state.replaceChildren()
      this.card.setAttribute('aria-label', s.title)
      this.card.dataset.lent = 'false'
      this.paintOpenButton(screenOpenButton())
      this.openBtn.disabled = false
      this.moreBtn.disabled = false
      const foot = screenFoot(hints, underName)
      if (this.foot.textContent !== foot) this.foot.textContent = foot
      return
    }
    const s = this.host.slot(cur.slotId)
    const kind = s?.kind ?? 'shell'
    const name = KIND_ICON[kind] ?? 'terminal-window'
    if (this.kind.dataset.icon !== name) { this.kind.dataset.icon = name; this.kind.replaceChildren(icon(name)) }
    this.kind.className = `peek-kind ${kind}`
    const h = s ? peekHeader(s, Date.now()) : { title: cur.slotId, state: 'ended' as const, text: 'encerrada' }
    if (this.title.textContent !== h.title) this.title.textContent = h.title
    this.paintMark(cur.slotId, kind, h.title)
    this.state.hidden = false
    this.state.className = `peek-state ${h.state}`
    if (this.state.textContent !== h.text) { this.state.replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }), document.createTextNode(h.text)) }
    this.card.setAttribute('aria-label', peekLabel(h.title))
    this.card.dataset.lent = String(cur.lent)
    // The drawer's key closes the card too (main.ts toggleDrawer): both chords as the person has them bound.
    this.paintOpenButton(peekOpenButton(cur.lent))
    this.openBtn.disabled = !cur.lent && h.state === 'ended'
    this.moreBtn.disabled = h.state === 'ended'
    const foot = peekFoot(s?.kind, hints, h.state === 'ended')
    if (this.foot.textContent !== foot) this.foot.textContent = foot
  }

  /** Redraws the mark only when the emblem, the name's initial or the slot changed (the card repaints on every state change). */
  private paintMark(slotId: string, kind: string, name: string): void {
    const id = identityOf({ kind, name, seed: slotId, emblem: emblemOfPanel(slotId) })
    const key = id.mark.type === 'emblem' ? `e|${id.mark.emblem.name}|${id.mark.emblem.color}|${id.mark.emblem.icon}` : `l|${id.mark.letter}|${id.mark.hue}`
    this.mark.hidden = false
    if (key === this.markKey) return
    this.markKey = key
    this.mark.replaceChildren(markOf(id))
  }

  /** The pane's header and foot in the card, or the slot's and screen's: one pair at a time in the DOM. */
  private useChrome(pane: boolean): void {
    const [out, into] = pane ? [[this.head, this.foot], [this.qvHead, this.qvFoot]] : [[this.qvHead, this.qvFoot], [this.head, this.foot]]
    if (!pane) delete this.card.dataset.paneType
    if (into[0]!.isConnected) return
    out[0]!.replaceWith(into[0]!)
    out[1]!.replaceWith(into[1]!)
  }

  /** The header and foot of a pane, the same for every type (peek-rules.ts paneCardHead, paneCardFoot); only what changed is written. */
  private renderPane(v: PaneView): void {
    const f = this.host.paneFacts(v.paneId)
    if (!f) return
    const head = paneCardHead(f)
    const hints = [this.host.toggleHint(), this.host.closeHint()].filter(h => h !== '')
    this.card.dataset.content = 'pane'
    this.card.dataset.lent = String(!!v.loan)
    this.card.dataset.paneType = f.typeId
    if (this.card.getAttribute('aria-label') !== head.label) this.card.setAttribute('aria-label', head.label)
    if (this.qvKind.dataset.icon !== f.icon) { this.qvKind.dataset.icon = f.icon; this.qvKind.replaceChildren(icon(f.icon)) }
    const kindClass = `peek-kind ${f.slotKind ?? 'pane'}`
    if (this.qvKind.className !== kindClass) this.qvKind.className = kindClass
    this.paintPaneMark(v.paneId, f)
    setText(this.qvTitle, head.title)
    this.qvTitle.title = head.title
    setText(this.qvType, head.kind)
    this.qvWhere.hidden = head.where === undefined
    setText(this.qvWhereText, head.where ?? '')
    const desk = head.color ? `var(--x-${head.color}, var(--accent))` : ''
    if (this.qvWhere.style.getPropertyValue('--qv-desk') !== desk) { if (desk) this.qvWhere.style.setProperty('--qv-desk', desk); else this.qvWhere.style.removeProperty('--qv-desk') }
    this.paintEmblems(f.emblems)
    this.qvState.hidden = head.state === undefined
    if (head.state) {
      const cls = `peek-state ${head.state.tone}`
      if (this.qvState.className !== cls) this.qvState.className = cls
      if (this.qvState.textContent !== head.state.text) this.qvState.replaceChildren(make('span', 'dot'), document.createTextNode(head.state.text))
    }
    // The large docked card: Esc reduces it, so neither the ✕ nor the foot offer Esc as a way to close.
    const large = this.dock !== undefined && this.size === 'large'
    const tip = closeTip(large ? hints : ['Esc', ...hints])
    if (this.qvClose.title !== tip) this.qvClose.title = tip
    const foot = paneCardFoot(f, hints, escWord(large ? 'large' : 'docked'))
    setText(this.qvHint, foot.hint)
    this.qvNote.hidden = !v.note
    setText(this.qvNote, v.note ?? '')
    this.qvWake.hidden = !foot.wake
    this.qvBand.hidden = !foot.wake
    setText(this.qvBandText, foot.wake?.band ?? '')
    if (foot.wake) {
      this.qvWake.dataset.what = foot.wake.what
      this.qvWake.title = foot.wake.title
      if (this.qvWake.textContent !== foot.wake.label) this.qvWake.replaceChildren(icon('sun'), make('span', 'label'))
      setText(this.qvWake.lastElementChild as HTMLElement, foot.wake.label)
    }
    this.qvGo.title = foot.go.title
    if (this.qvGo.textContent !== foot.go.label) {
      const label = make('span', 'label')
      label.textContent = foot.go.label
      this.qvGo.replaceChildren(icon('arrow-square-out'), label)
    }
  }

  /** The agent's identity mark (its emblem, or its letter) after the engine's icon; any other pane: the person's emblem, if it wears one. */
  private paintPaneMark(paneId: string, f: PeekPaneFacts): void {
    let key = ''
    let node: (() => HTMLElement) | undefined
    const emblem = emblemOfPanel(paneId)
    if (f.agent && f.slotKind) {
      const id = identityOf({ kind: f.slotKind, name: f.title, seed: paneId, emblem })
      key = id.mark.type === 'emblem' ? `e|${id.mark.emblem.name}|${id.mark.emblem.color}|${id.mark.emblem.icon}` : `l|${id.mark.letter}|${id.mark.hue}`
      node = () => markOf(id)
    } else if (emblem) {
      key = `b|${emblem.name}|${emblem.color}|${emblem.icon}`
      node = () => emblemBadge(emblem)
    }
    this.qvMark.hidden = !node
    if (key === this.qvMarkKey) return
    this.qvMarkKey = key
    this.qvMark.replaceChildren(...(node ? [node()] : []))
  }

  /** The extensions' emblems of the tab (the owner's seal among them), drawn as the tab draws them. */
  private paintEmblems(emblems: readonly TabEmblem[]): void {
    const key = emblems.map(e => `${e.icon}|${e.label ?? ''}|${e.hue ?? ''}|${e.variant ?? ''}|${e.tooltip}`).join('\n')
    if (key === this.qvEmblemKey) return
    this.qvEmblemKey = key
    this.qvEmblems.replaceChildren(...emblems.map(e => emblemNode(e, makeIcon)))
    this.qvEmblems.hidden = emblems.length === 0
  }

  /** The "⋯" menu at (x, y) (the screen's own right-click on its header asks for it: ext-api panes.showTabMenu). */
  showMenuAt(x: number, y: number): void { this.showMenu({ x, y }) }

  /** "Abrir nesta mesa" (with the ▾) without a tab or for a screen; "Ir para a guia" (alone) with one (rules: peekOpenButton, screenOpenButton). */
  private paintOpenButton(b: PeekOpenButton): void {
    if (this.openBtn.title === b.title) return
    this.openBtn.dataset.action = b.action
    this.openBtn.classList.toggle('primary', b.primary)
    this.openBtn.title = b.title
    this.openBtn.setAttribute('aria-label', b.label)
    this.openLabel.textContent = b.label
    this.openBtn.replaceChildren(icon(b.icon), this.openLabel)
    this.moreBtn.hidden = !b.split
    this.openBtn.parentElement?.classList.toggle('alone', !b.split)
  }

  private nameOf(slotId: string): string {
    const s = this.host.slot(slotId)
    return s ? peekHeader(s, Date.now()).title : slotId
  }

  private rememberReturn(from: HTMLElement | undefined): void {
    // `from`: who asked when the keyboard no longer sits there (a menu that closed on its pick, a panel that hid itself).
    const active = document.activeElement
    this.returnTo = from?.isConnected ? from : active instanceof HTMLElement && active !== document.body && !this.root.contains(active) ? active : undefined
  }

  private shown(opening: boolean, focus = true): void {
    this.render()
    if (opening) {
      this.root.hidden = false
      this.root.dataset.open = 'true'
      this.root.dataset.mode = this.isModal ? 'modal' : 'docked'
      this.host.onOpenChange(true, this.isModal)
    }
    if (focus) this.focusContent()
  }

  /** What the tab shows in place of its terminal while the card has it (screen 6 of the preview). */
  private noticeFor(slotId: string): HTMLElement {
    return lentNoticeElement(lentNotice(this.nameOf(slotId)))
  }

  /** Gives back everything the card holds: the screen on top (disposed), and every slot view (see releaseSlot). */
  private releaseAll(detach: boolean): void {
    const cur = this.current
    const under = this.under
    this.current = undefined
    this.under = undefined
    if (cur?.kind === 'screen') { cur.wrap.remove(); cur.screen.dispose() } else if (cur?.kind === 'pane') { this.releasePane(cur) } else if (cur) this.releaseSlot(cur, detach)
    if (under) this.releaseSlot(under, detach)
  }

  /** Gives a pane's content back to its tab (with its size and visibility told again: pane-shell.ts), and empties the holder. */
  private releasePane(v: PaneView): void {
    const loan = v.loan
    v.loan = undefined
    if (loan) {
      loan.giveBack()
      if (!loan.fresh) this.host.onPaneLendChange(v.paneId, false)
    }
    v.holder.remove()
  }

  /** Gives back a slot view: a lent terminal to its tab, the card's own terminal to the host (disposed). */
  private releaseSlot(v: SlotView, detach: boolean): void {
    v.el.classList.remove('peek-under')
    if (!v.lent) { this.host.releasePanel(v.panel, detach); return }
    v.panel.takeBack()
    this.host.onLendChange(v.slotId, false)
  }

  /** The tab whose terminal the card holds was disposed (closed, moved, its desk hibernated): that view goes, nothing to give back. */
  private lost(panel: TerminalPanel): void {
    const v = this.current?.kind === 'slot' ? this.current : this.under
    if (v?.panel === panel) this.dropSlot(v.slotId, false)
  }

  private openHere(): void {
    const slotId = this.slotId
    if (!slotId) return
    // Closed (detached) before the tab is born: the tab's own attach comes after, so nothing cuts its output.
    this.close({ restoreFocus: false })
    this.host.openHere(slotId)
  }

  /** "Abrir nesta mesa" of a screen: the card closes (an agent under it goes back too) and the screen becomes a tab here. */
  private openScreenHere(): void {
    const typeId = this.screenType
    if (!typeId) return
    this.close({ restoreFocus: false })
    this.host.openScreenHere(typeId)
  }

  /** "Ir para a guia": the terminal goes back to the tab first, then the tab comes forward with the keyboard. */
  private goToTab(): void {
    const slotId = this.slotId
    if (!slotId) return
    this.close({ restoreFocus: false })
    this.host.goToTab(slotId)
  }

  /** The rows "Abrir em outra mesa" of what is on top: the card closes on a pick and the person stays where they are. */
  private places(): MenuSpec[] {
    const cur = this.current
    if (!cur || cur.kind === 'pane') return []
    // The card closes before the tab is born elsewhere (the tab's own attach comes after, so nothing cuts its output).
    return cur.kind === 'screen'
      ? placeEntries(this.host.screenPlaces(), cur.screen.typeId, () => this.close())
      : placeEntries(this.host, cur.slotId, () => this.close())
  }

  /** The ▾ list "Abrir em outra mesa". */
  private showPlaces(): void {
    if (!this.current) return
    const r = this.moreBtn.getBoundingClientRect()
    this.host.contextMenu(r.left, r.bottom + 2, [{ heading: OPEN_ELSEWHERE_LABEL }, ...this.places()], this.moreBtn)
  }

  /** The "⋯" menu (rules: peekMenuPlan, screenMenuPlan). */
  private showMenu(at?: { x: number; y: number }): void {
    const cur = this.current
    if (!cur || cur.kind === 'pane') return
    const hint = this.host.closeHint()
    const slotId = cur.kind === 'slot' ? cur.slotId : undefined
    const plan: PeekMenuItem[] = cur.kind === 'screen' ? screenMenuPlan(hint) : peekMenuPlan(hint, this.host.slot(cur.slotId)?.status === 'exited', cur.lent)
    const icons = { 'open-here': 'plus', 'open-other': 'arrow-square-out', 'go-tab': 'arrow-square-out', emblem: 'tag', 'copy-link': 'link', close: 'x' } as const
    const entries: MenuSpec[] = []
    const r = this.menuBtn.getBoundingClientRect()
    const pos = at ?? { x: r.right, y: r.bottom + 2 }
    for (const item of plan) {
      if (item.sepBefore) entries.push('sep')
      const run = (): void => {
        if (item.action === 'emblem') { if (slotId) this.host.emblemMenu(slotId, pos.x, pos.y, () => this.focusContent()); return }
        if (item.action === 'open-here') { if (cur.kind === 'screen') this.openScreenHere(); else this.openHere() }
        else if (item.action === 'go-tab') this.goToTab()
        else if (item.action === 'copy-link') { if (slotId) this.host.copyLink(slotId) }
        else if (item.action === 'close') this.dismiss()
      }
      entries.push({
        icon: icons[item.action],
        label: item.label,
        ...(item.disabled ? { disabled: true } : {}),
        ...(item.trail ? { trail: item.trail } : {}),
        ...(item.submenu ? { children: this.places(), run: () => {} } : { run }),
      })
    }
    this.host.contextMenu(pos.x, pos.y, entries, at ? undefined : this.menuBtn)
  }

  /** What Tab visits in the card, in order: the header's enabled buttons, then the content (the terminal's input, or the screen's controls). */
  private tabStops(): HTMLElement[] {
    const visible = (b: HTMLElement): boolean => !(b as HTMLButtonElement).disabled && !b.hidden && !b.closest('[hidden]')
    const cur = this.current
    if (cur?.kind === 'pane') {
      const head = [...this.qvHead.querySelectorAll<HTMLButtonElement>('button')].filter(visible)
      const foot = [...this.qvFoot.querySelectorAll<HTMLButtonElement>('button')].filter(visible)
      const term = cur.holder.querySelector<HTMLElement>('textarea.xterm-helper-textarea')
      const inner = term ? [term] : [...cur.holder.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => visible(e) && e.getClientRects().length > 0)
      return [...head, ...inner, ...foot]
    }
    const buttons = [...this.card.querySelectorAll<HTMLButtonElement>('.peek-head button')].filter(visible)
    if (cur?.kind === 'screen') {
      const inScreen = [...cur.wrap.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => visible(e) && e.getClientRects().length > 0)
      return [...buttons, ...inScreen]
    }
    const term = cur?.el.querySelector<HTMLElement>('textarea.xterm-helper-textarea')
    return term ? [...buttons, term] : buttons
  }

  private trapTab(ev: KeyboardEvent): void {
    // Docked, the card is one place among the others: Tab leaves it as it leaves any region.
    if (!this.isModal) return
    if (ev.key !== 'Tab' || ev.ctrlKey || ev.altKey || ev.metaKey || (ev.target as Element | null)?.closest?.('.xterm')) return
    const stops = this.tabStops()
    if (stops.length === 0) return
    const at = stops.indexOf(document.activeElement as HTMLElement)
    const next = at < 0 ? 0 : ev.shiftKey ? (at - 1 + stops.length) % stops.length : (at + 1) % stops.length
    ev.preventDefault()
    ev.stopPropagation()
    stops[next]!.focus()
  }

  /** The keyboard to what is on top: the terminal, or the screen. */
  private focusContent(): void {
    const cur = this.current
    requestAnimationFrame(() => {
      if (this.current !== cur || !cur) return
      if (cur.kind === 'screen') cur.screen.focus()
      else if (cur.kind === 'pane') {
        // A copy takes the keyboard itself: the type's focus aims at the tab's instance.
        if (cur.loan?.focus) cur.loan.focus()
        else if (cur.loan) this.host.focusPane(cur.paneId)
        // A type without a focus of its own (or one that focuses elsewhere): the body itself holds the keyboard (Tab goes on
        // from there); a pane that could not come, "Ir até a guia".
        if (!this.card.contains(document.activeElement)) {
          if (cur.loan) { cur.holder.tabIndex = -1; cur.holder.focus({ preventScroll: true }) } else this.qvGo.focus()
        }
      }
      else cur.panel.focus()
    })
  }
}
