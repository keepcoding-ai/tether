// The peek card: a floating card over everything (the open drawer included), 16 px from the window's edges, with the live,
// interactive terminal of ONE slot that no tab shows. The window behind dims and goes `inert` (main.ts does that through
// `onOpenChange`); the native surfaces behind freeze (overlay-freeze.ts reads `#peek[data-open]`).
//
// The terminal is a real TerminalPanel (panel.ts) built outside dockview: links, copy/paste, theme, font, the exited
// overlay and the app's key routing come with it. The host registers it in the window's slot→panel map, so the slot's
// output reaches it like any pane's; it attaches on open and detaches on close. A slot has one pty size: the card is the
// only view of a slot without a tab, so its size is the one in force while it is open.
//
// Closing: the ✕, the chord (peek.close), a press on the margin, Esc outside the terminal (in a terminal, the drawer's rule:
// an agent keeps Esc). The keyboard goes back to the exact element that had it before the card opened.
import type { SlotState } from '../../src/daemon/protocol.ts'
import { icon, KIND_ICON } from './icons.ts'
import type { TerminalPanel } from './panel.ts'
import { closeTip, peekFoot, peekHeader, peekLabel, peekMenuPlan } from './peek-rules.ts'
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
  /** The chord that closes the card, as the person reads it ("" when unbound). */
  closeHint(): string
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
  private readonly moreBtn: HTMLButtonElement
  private readonly menuBtn: HTMLButtonElement
  private readonly closeBtn: HTMLButtonElement
  private readonly host: PeekHost
  private current: { slotId: string; panel: TerminalPanel } | undefined
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
    id.append(this.kind, this.title, this.state)
    const acts = el('div', 'peek-acts')
    this.openBtn = el('button', 'peek-open primary')
    this.openBtn.type = 'button'
    this.openBtn.title = 'Abrir nesta mesa: o agente ganha uma guia na mesa em que você está'
    const label = el('span', 'label'); label.textContent = 'Abrir nesta mesa'
    this.openBtn.append(icon('plus'), label)
    this.openBtn.setAttribute('aria-label', 'Abrir nesta mesa')
    this.openBtn.addEventListener('click', () => this.openHere())
    // The split button: "Abrir nesta mesa" with the ▾ stuck to it, which lists the other desks.
    this.moreBtn = el('button', 'peek-open-more primary')
    this.moreBtn.type = 'button'
    this.moreBtn.title = OPEN_ELSEWHERE_LABEL
    this.moreBtn.setAttribute('aria-label', OPEN_ELSEWHERE_LABEL)
    this.moreBtn.setAttribute('aria-haspopup', 'menu')
    this.moreBtn.append(icon('caret-down'))
    this.moreBtn.addEventListener('click', () => this.showPlaces())
    const split = el('div', 'peek-split')
    split.append(this.openBtn, this.moreBtn)
    this.menuBtn = el('button', 'peek-menu ib')
    this.menuBtn.type = 'button'
    this.menuBtn.title = 'Mais ações'
    this.menuBtn.setAttribute('aria-label', 'Mais ações')
    this.menuBtn.setAttribute('aria-haspopup', 'menu')
    this.menuBtn.append(icon('dots-three'))
    this.menuBtn.addEventListener('click', () => this.showMenu())
    this.closeBtn = el('button', 'peek-close ib')
    this.closeBtn.type = 'button'
    this.closeBtn.setAttribute('aria-label', 'Fechar o cartão')
    this.closeBtn.append(icon('x'))
    this.closeBtn.addEventListener('click', () => this.close())
    acts.append(split, this.menuBtn, this.closeBtn)
    head.append(id, acts)
    this.body = el('div', 'peek-body')
    this.foot = el('footer', 'peek-foot')
    this.card.append(head, this.body, this.foot)
    this.root.append(this.card)
    // The layer is the margin: a press that lands on it (not on the card) closes.
    this.root.addEventListener('mousedown', ev => { if (ev.target === this.root) { ev.preventDefault(); this.close() } })
    document.body.append(this.root)
  }

  get isOpen(): boolean { return this.current !== undefined }
  get slotId(): string | undefined { return this.current?.slotId }
  /** The card's terminal (main.ts asks whether a key event came from it). */
  get panel(): TerminalPanel | undefined { return this.current?.panel }
  contains(node: Node | null): boolean { return !!node && this.root.contains(node) }

  /** Shows the slot in the card; another slot already in it is swapped out (its terminal detached). */
  open(slotId: string): void {
    if (this.current?.slotId === slotId) { this.focusTerminal(); return }
    const opening = !this.current
    if (opening) {
      const active = document.activeElement
      this.returnTo = active instanceof HTMLElement && active !== document.body && !this.root.contains(active) ? active : undefined
    }
    if (this.current) this.host.releasePanel(this.current.panel, true)
    const panel = this.host.createPanel(slotId)
    this.current = { slotId, panel }
    this.body.replaceChildren(panel.element)
    this.render()
    if (opening) {
      this.root.hidden = false
      this.root.dataset.open = 'true'
      this.host.onOpenChange(true)
    }
    this.focusTerminal()
  }

  /**
   * Closes the card; the session keeps running. `detach: false` when another view of the slot already attached (a tab
   * opened meanwhile). `restoreFocus: false` when the caller moves the keyboard itself (Abrir nesta mesa).
   */
  close(opts: { detach?: boolean; restoreFocus?: boolean } = {}): void {
    const cur = this.current
    if (!cur) return
    this.current = undefined
    this.host.releasePanel(cur.panel, opts.detach !== false)
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
    const hint = this.host.closeHint()
    const tip = closeTip(hint)
    if (this.closeBtn.title !== tip) this.closeBtn.title = tip
    this.openBtn.disabled = h.state === 'ended'
    this.moreBtn.disabled = h.state === 'ended'
    const foot = peekFoot(s?.kind, hint, h.state === 'ended')
    if (this.foot.textContent !== foot) this.foot.textContent = foot
  }

  private openHere(): void {
    const slotId = this.current?.slotId
    if (!slotId) return
    // Closed (detached) before the tab is born: the tab's own attach comes after, so nothing cuts its output.
    this.close({ restoreFocus: false })
    this.host.openHere(slotId)
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
    const slotId = this.current?.slotId
    if (!slotId) return
    const hint = this.host.closeHint()
    const ended = this.host.slot(slotId)?.status === 'exited'
    const icons = { 'open-here': 'plus', 'open-other': 'arrow-square-out', 'copy-link': 'link', close: 'x' } as const
    const entries: MenuSpec[] = []
    for (const item of peekMenuPlan(hint, ended)) {
      if (item.sepBefore) entries.push('sep')
      const run = (): void => {
        if (item.action === 'open-here') this.openHere()
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

  private focusTerminal(): void {
    const panel = this.current?.panel
    requestAnimationFrame(() => { if (this.current?.panel === panel) panel?.focus() })
  }
}
