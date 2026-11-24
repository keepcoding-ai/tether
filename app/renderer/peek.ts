// The peek card: a floating card over everything (the open drawer included), 16 px from the window's edges, with the live,
// interactive terminal of ONE slot. The window behind dims and goes `inert` (main.ts does that through `onOpenChange`); the
// native surfaces behind freeze (overlay-freeze.ts reads `#peek[data-open]`).
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
// Closing: the ✕, the chord (peek.close), a press on the margin, Esc on the header's buttons (in the terminal, agent or
// shell, Esc is always the program's). The keyboard goes back to the exact element that had it before the card opened.
import type { SlotState } from '../../src/daemon/protocol.ts'
import { icon, KIND_ICON } from './icons.ts'
import type { TerminalPanel } from './panel.ts'
import { closeTip, lentNotice, peekFoot, peekHeader, peekLabel, peekMenuPlan, peekOpenButton } from './peek-rules.ts'
import { placeEntries, type MenuSpec, type PlaceHost } from './place-menu.ts'
import { OPEN_ELSEWHERE_LABEL } from './sessions-rules.ts'

export interface PeekHost extends PlaceHost {
  /** The app's context menu at (x, y); `opener` gets the focus back when it closes. */
  contextMenu(x: number, y: number, entries: MenuSpec[], opener?: HTMLElement): void
  /** "Copiar link do painel" for the slot. */
  copyLink(slotId: string): void
  slot(slotId: string): SlotState | undefined
  /** A TerminalPanel for the slot, initialised and registered where the slot's output is routed. */
  createPanel(slotId: string): TerminalPanel
  /** Disposes the card's panel and unregisters it; `detach: false` when another view of the slot took over. */
  releasePanel(panel: TerminalPanel, detach: boolean): void
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

export class PeekCard {
  readonly root: HTMLElement
  private readonly card: HTMLElement
  private readonly body: HTMLElement
  private readonly kind: HTMLElement
  private readonly title: HTMLElement
  private readonly state: HTMLElement
  private readonly foot: HTMLElement
  private readonly openBtn: HTMLButtonElement
  private readonly openLabel: HTMLElement
  private readonly moreBtn: HTMLButtonElement
  private readonly menuBtn: HTMLButtonElement
  private readonly closeBtn: HTMLButtonElement
  private readonly host: PeekHost
  /** The slot shown; `lent` when the panel is the slot's tab's terminal, borrowed (else the card's own). */
  private current: { slotId: string; panel: TerminalPanel; lent: boolean } | undefined
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
    const id = el('div', 'peek-id')
    this.kind = el('span', 'peek-kind')
    this.title = el('span', 'peek-title')
    this.state = el('span', 'peek-state')
    // The state changes while the card is open (working, waiting, ended): a screen reader hears it, politely.
    this.state.setAttribute('aria-live', 'polite')
    id.append(this.kind, this.title, this.state)
    const acts = el('div', 'peek-acts')
    this.openBtn = el('button', 'peek-open')
    this.openBtn.type = 'button'
    this.openLabel = el('span', 'label')
    this.openBtn.addEventListener('click', () => { if (this.current?.lent) this.goToTab(); else this.openHere() })
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
    this.paintOpenButton(false)
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
    this.closeBtn.addEventListener('click', () => this.close())
    acts.append(split, this.menuBtn, this.closeBtn)
    head.append(id, acts)
    this.body = el('div', 'peek-body')
    this.foot = el('footer', 'peek-foot')
    this.card.append(head, this.body, this.foot)
    this.root.append(this.card)
    // The layer is the margin: a press that lands on it (not on the card) closes.
    this.root.addEventListener('mousedown', ev => { if (ev.target === this.root) { ev.preventDefault(); this.close() } })
    // Tab goes round inside the card: the header's buttons, then the terminal, then the buttons again. (Inside the terminal
    // Tab is the program's: xterm sends it, so it never gets here.)
    this.root.addEventListener('keydown', ev => this.trapTab(ev))
    document.body.append(this.root)
  }

  get isOpen(): boolean { return this.current !== undefined }
  get slotId(): string | undefined { return this.current?.slotId }
  /** The slot whose tab's terminal is lent to the card right now. */
  get lentSlot(): string | undefined { return this.current?.lent ? this.current.slotId : undefined }
  /** The card's terminal, its own or the lent one (main.ts asks whether a key event came from it). */
  get panel(): TerminalPanel | undefined { return this.current?.panel }
  contains(node: Node | null): boolean { return !!node && this.root.contains(node) }

  /**
   * Shows the slot in the card; another slot already in it is swapped out (its own terminal detached, a lent one given
   * back). `lend`: the slot's tab's terminal, to borrow instead of building one (the slot has a tab not in view).
   * `from`: where the keyboard goes back on close, when it is not where it sits now.
   */
  open(slotId: string, lend?: TerminalPanel, from?: HTMLElement): void {
    if (this.current?.slotId === slotId || lend?.isLent) { this.focusTerminal(); return }
    const opening = !this.current
    if (opening) {
      // `from`: who asked when the keyboard no longer sits there (a menu that closed on its pick, a panel that hid itself).
      const active = document.activeElement
      this.returnTo = from?.isConnected ? from : active instanceof HTMLElement && active !== document.body && !this.root.contains(active) ? active : undefined
    }
    if (this.current) this.release(this.current, true)
    if (lend) {
      this.current = { slotId, panel: lend, lent: true }
      this.body.replaceChildren(lend.lend(this.noticeFor(slotId), () => this.lost(lend)))
      this.host.onLendChange(slotId, true)
    } else {
      const panel = this.host.createPanel(slotId)
      this.current = { slotId, panel, lent: false }
      this.body.replaceChildren(panel.element)
    }
    this.render()
    if (opening) {
      this.root.hidden = false
      this.root.dataset.open = 'true'
      this.host.onOpenChange(true)
    }
    this.focusTerminal()
  }

  /**
   * Closes the card; the session keeps running. A lent terminal goes back to its tab. `detach: false` when another view of
   * the slot already attached (a tab opened meanwhile). `restoreFocus: false` when the caller moves the keyboard itself.
   */
  close(opts: { detach?: boolean; restoreFocus?: boolean } = {}): void {
    const cur = this.current
    if (!cur) return
    this.current = undefined
    this.release(cur, opts.detach !== false)
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

  /** Repaints the header and foot from the slot's state (main.ts calls it on every state of the slot shown). */
  render(): void {
    const cur = this.current
    if (!cur) return
    const s = this.host.slot(cur.slotId)
    const kind = s?.kind ?? 'shell'
    const name = KIND_ICON[kind] ?? 'terminal-window'
    if (this.kind.dataset.icon !== name) { this.kind.dataset.icon = name; this.kind.replaceChildren(icon(name)) }
    this.kind.className = `peek-kind ${kind}`
    const h = s ? peekHeader(s, Date.now()) : { title: cur.slotId, state: 'ended' as const, text: 'encerrada' }
    if (this.title.textContent !== h.title) this.title.textContent = h.title
    this.state.className = `peek-state ${h.state}`
    if (this.state.textContent !== h.text) { this.state.replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }), document.createTextNode(h.text)) }
    this.card.setAttribute('aria-label', peekLabel(h.title))
    this.card.dataset.lent = String(cur.lent)
    // The drawer's key closes the card too (main.ts toggleDrawer): both chords as the person has them bound.
    const hints = [this.host.toggleHint(), this.host.closeHint()].filter(h => h !== '')
    const tip = closeTip(hints)
    if (this.closeBtn.title !== tip) this.closeBtn.title = tip
    this.paintOpenButton(cur.lent)
    this.openBtn.disabled = !cur.lent && h.state === 'ended'
    this.moreBtn.disabled = h.state === 'ended'
    const foot = peekFoot(s?.kind, hints, h.state === 'ended')
    if (this.foot.textContent !== foot) this.foot.textContent = foot
  }

  /** "Abrir nesta mesa" (primary, with the ▾) without a tab; "Ir para a guia" (secondary, alone) with one (rules: peekOpenButton). */
  private paintOpenButton(hasTab: boolean): void {
    const b = peekOpenButton(hasTab)
    if (this.openBtn.dataset.action === b.action) return
    this.openBtn.dataset.action = b.action
    this.openBtn.classList.toggle('primary', b.primary)
    this.openBtn.title = b.title
    this.openBtn.setAttribute('aria-label', b.label)
    this.openLabel.textContent = b.label
    this.openBtn.replaceChildren(icon(b.icon), this.openLabel)
    this.moreBtn.hidden = !b.split
    this.openBtn.parentElement?.classList.toggle('alone', !b.split)
  }

  /** What the tab shows in place of its terminal while the card has it (screen 6 of the preview). */
  private noticeFor(slotId: string): HTMLElement {
    const s = this.host.slot(slotId)
    const n = lentNotice(s ? peekHeader(s, Date.now()).title : slotId)
    // (The card sits over it: a button here could not be reached, so the notice is the icon, the title and the sentence.)
    const root = document.createElement('div'); root.className = 'peek-lent'; root.setAttribute('role', 'status')
    const ill = document.createElement('span'); ill.className = 'ill'; ill.append(icon('eye'))
    const t = document.createElement('p'); t.className = 't'; t.textContent = n.title
    const p = document.createElement('p'); p.className = 'mut'; p.textContent = n.text
    root.append(ill, t, p)
    return root
  }

  /** Gives back what the card holds: a lent terminal to its tab, the card's own terminal to the host (disposed). */
  private release(cur: { slotId: string; panel: TerminalPanel; lent: boolean }, detach: boolean): void {
    if (!cur.lent) { this.host.releasePanel(cur.panel, detach); return }
    cur.panel.takeBack()
    this.host.onLendChange(cur.slotId, false)
  }

  /** The tab whose terminal the card holds was disposed (closed, moved, its desk hibernated): the card closes, nothing to give back. */
  private lost(panel: TerminalPanel): void {
    if (this.current?.panel === panel) this.close({ detach: false })
  }

  private openHere(): void {
    const slotId = this.current?.slotId
    if (!slotId) return
    // Closed (detached) before the tab is born: the tab's own attach comes after, so nothing cuts its output.
    this.close({ restoreFocus: false })
    this.host.openHere(slotId)
  }

  /** "Ir para a guia": the terminal goes back to the tab first, then the tab comes forward with the keyboard. */
  private goToTab(): void {
    const slotId = this.current?.slotId
    if (!slotId) return
    this.close({ restoreFocus: false })
    this.host.goToTab(slotId)
  }

  /** The ▾ list "Abrir em outra mesa": the card closes on a pick and the person stays where they are. */
  private showPlaces(): void {
    const slotId = this.current?.slotId
    if (!slotId) return
    const r = this.moreBtn.getBoundingClientRect()
    // The card closes before the tab is born elsewhere (the tab's own attach comes after, so nothing cuts its output).
    this.host.contextMenu(r.left, r.bottom + 2, [{ heading: OPEN_ELSEWHERE_LABEL }, ...placeEntries(this.host, slotId, () => this.close())], this.moreBtn)
  }

  /** The "⋯" menu (rules: peekMenuPlan). */
  private showMenu(): void {
    const cur = this.current
    if (!cur) return
    const slotId = cur.slotId
    const hint = this.host.closeHint()
    const ended = this.host.slot(slotId)?.status === 'exited'
    const icons = { 'open-here': 'plus', 'open-other': 'arrow-square-out', 'go-tab': 'arrow-square-out', 'copy-link': 'link', close: 'x' } as const
    const entries: MenuSpec[] = []
    for (const item of peekMenuPlan(hint, ended, cur.lent)) {
      if (item.sepBefore) entries.push('sep')
      const run = (): void => {
        if (item.action === 'open-here') this.openHere()
        else if (item.action === 'go-tab') this.goToTab()
        else if (item.action === 'copy-link') this.host.copyLink(slotId)
        else if (item.action === 'close') this.close()
      }
      entries.push({
        icon: icons[item.action],
        label: item.label,
        ...(item.disabled ? { disabled: true } : {}),
        ...(item.trail ? { trail: item.trail } : {}),
        ...(item.submenu ? { children: placeEntries(this.host, slotId, () => this.close()), run: () => {} } : { run }),
      })
    }
    const r = this.menuBtn.getBoundingClientRect()
    this.host.contextMenu(r.right, r.bottom + 2, entries, this.menuBtn)
  }

  /** What Tab visits in the card, in order: the header's enabled buttons, then the terminal's input. */
  private tabStops(): HTMLElement[] {
    const buttons = [...this.card.querySelectorAll<HTMLButtonElement>('.peek-head button')].filter(b => !b.disabled && !b.hidden && !b.closest('[hidden]'))
    const term = this.body.querySelector<HTMLElement>('textarea.xterm-helper-textarea')
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

  private focusTerminal(): void {
    const panel = this.current?.panel
    requestAnimationFrame(() => { if (this.current?.panel === panel) panel?.focus() })
  }
}
