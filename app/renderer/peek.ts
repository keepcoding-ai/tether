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
import type { SlotState } from '../../src/daemon/protocol.ts'
import { icon, KIND_ICON, type IconName } from './icons.ts'
import { identityOf, markOf } from './agent-identity.ts'
import { emblemOfPanel } from './tab-emblems.ts'
import type { TerminalPanel } from './panel.ts'
import { backButton, closeTip, lentNotice, peekDismiss, peekFoot, peekHeader, peekLabel, peekMenuPlan, peekOpenButton, screenFoot, screenMenuPlan, screenOpenButton, screenOpenPlan, type PeekMenuItem, type PeekOpenButton, type PeekTop } from './peek-rules.ts'
import { lentNoticeElement } from './pane-shell.ts'
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
  /** The card opened or closed: the window behind goes inert / comes back. Called before the focus moves. */
  onOpenChange(open: boolean): void
  /** Where the keyboard goes when the element that had it before the card is gone. */
  fallbackFocus(): void
}

/** A slot shown: `lent` when the panel is the slot's tab's terminal, borrowed (else the card's own); `el` is what sits in the body. */
interface SlotView { kind: 'slot'; slotId: string; panel: TerminalPanel; lent: boolean; el: HTMLElement }
interface ScreenView { kind: 'screen'; screen: PeekScreen; wrap: HTMLElement }

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
  /** What the card shows on top. */
  private current: SlotView | ScreenView | undefined
  /** The agent under a screen (one level), kept as it was: its terminal attached or still lent. */
  private under: SlotView | undefined
  /** The element that had the keyboard when the card opened; it gets it back on close. */
  private returnTo: HTMLElement | undefined

  constructor(host: PeekHost) {
    this.host = host
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); e.className = cls; return e }
    this.root = el('div', 'peek-layer')
    this.root.id = 'peek'
    this.root.dataset.open = 'false'
    this.root.hidden = true
    this.card = el('section', 'peek-card')
    this.card.setAttribute('role', 'dialog')
    this.card.setAttribute('aria-modal', 'true')
    const head = el('header', 'peek-head')
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
      else if (cur?.lent) this.goToTab()
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
    document.body.append(this.root)
  }

  get isOpen(): boolean { return this.current !== undefined }
  /** The slot the card holds: on top, or under a screen. */
  get slotId(): string | undefined { return this.current?.kind === 'slot' ? this.current.slotId : this.under?.slotId }
  /** The slot whose tab's terminal is lent to the card right now (on top or under a screen). */
  get lentSlot(): string | undefined {
    const v = this.current?.kind === 'slot' ? this.current : this.under
    return v?.lent ? v.slotId : undefined
  }
  /** The card's terminal on top, its own or the lent one (main.ts asks whether a key event came from it). */
  get panel(): TerminalPanel | undefined { return this.current?.kind === 'slot' ? this.current.panel : undefined }
  /** The pane id of the screen on top. */
  get screenId(): string | undefined { return this.current?.kind === 'screen' ? this.current.screen.paneId : undefined }
  /** The screen on top's type. */
  get screenType(): string | undefined { return this.current?.kind === 'screen' ? this.current.screen.typeId : undefined }
  /** The slot under the screen on top. */
  get underSlot(): string | undefined { return this.under?.slotId }
  contains(node: Node | null): boolean { return !!node && this.root.contains(node) }
  /** Whether a node is in the card's content (the terminal or the screen), not its header. */
  inContent(node: Node | null): boolean { return !!node && this.body.contains(node) }

  private get top(): PeekTop { return this.current?.kind ?? 'none' }

  /**
   * Shows the slot in the card; another slot already in it is swapped out (its own terminal detached, a lent one given
   * back), and a screen with what is under it too. The slot under the screen on top comes back as it was.
   * `lend`: the slot's tab's terminal, to borrow instead of building one (the slot has a tab not in view).
   * `from`: where the keyboard goes back on close, when it is not where it sits now.
   */
  open(slotId: string, lend?: TerminalPanel, from?: HTMLElement): void {
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
  openScreen(screen: PeekScreen, from?: HTMLElement): void {
    if (this.current?.kind === 'screen' && this.current.screen.paneId === screen.paneId) { this.focusContent(); return }
    const opening = !this.current
    if (opening) this.rememberReturn(from)
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
    this.current = { kind: 'screen', screen, wrap }
    this.body.append(wrap)
    this.shown(opening)
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
    this.releaseAll(opts.detach !== false)
    this.body.replaceChildren()
    this.root.dataset.open = 'false'
    this.root.hidden = true
    this.host.onOpenChange(false)
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

  private shown(opening: boolean): void {
    this.render()
    if (opening) {
      this.root.hidden = false
      this.root.dataset.open = 'true'
      this.host.onOpenChange(true)
    }
    this.focusContent()
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
    if (cur?.kind === 'screen') { cur.wrap.remove(); cur.screen.dispose() } else if (cur) this.releaseSlot(cur, detach)
    if (under) this.releaseSlot(under, detach)
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
    if (!cur) return []
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
    if (!cur) return
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
    const buttons = [...this.card.querySelectorAll<HTMLButtonElement>('.peek-head button')].filter(visible)
    const cur = this.current
    if (cur?.kind === 'screen') {
      const inScreen = [...cur.wrap.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => visible(e) && e.getClientRects().length > 0)
      return [...buttons, ...inScreen]
    }
    const term = cur?.el.querySelector<HTMLElement>('textarea.xterm-helper-textarea')
    return term ? [...buttons, term] : buttons
  }

  private trapTab(ev: KeyboardEvent): void {
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
      else cur.panel.focus()
    })
  }
}
