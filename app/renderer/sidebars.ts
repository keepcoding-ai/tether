// The two side bars (F10) on screen: each is a strip of icons (one per pad on that side) and the area of the pad open on
// it, with a sash to resize it. The rules (which pad is where, the toggle, moving, restoring) are app/renderer/sidebar-rules.ts;
// this file draws them and keeps the pads' views.
//
// Views: one per global pad, one per desk for a per-desk pad, created when first shown or when layout.json has a state
// for them. Every view lives in one layer over the workbench (#pads), positioned on its side at that side bar's width,
// and stays mounted while hidden (`visibility:hidden` + `inert`, never `display:none`): a closed pad, or the pad of
// another desk, keeps its size, so nothing in it (a terminal) is resized or detached — the technique of the inactive
// desks (desk-set.ts) and the closed drawer (drawer.ts). Moving a pad to the other side only changes its position. The
// side bar itself (strip, the slot the pad covers, the sash) is in the flex row beside #dock, so an open pad takes its
// width from the desks and a closed one gives it back.
import type { ContextMenuEntry, PadType, PadView } from './ext-api.ts'
import { countLabel, type Badge } from './seal-rules.ts'

import { createBlankView } from './blank-view.ts'
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import {
  DEFAULT_SIDEBAR_WIDTH, emptySideBars, fitWidth, isMoved, movePad, openPad, openPadOn, padsOn, padToggleCommand, panelIdsOfPad, panelPadKey, restorePad, setWidth, SIDES, sideOf,
  togglePad, toggleSideBar, type PadDescriptor, type Side, type SideBarsLayout,
} from './sidebar-rules.ts'

export interface SideBarsHost {
  /** The pads declared by the extensions that are on, in registration order. */
  pads(): readonly PadDescriptor[]
  /** What a pad shows (registered by its extension's activate), if any. */
  padType(id: string): PadType | undefined
  /** The badge an extension put on the pad's icon. */
  badgeOf?(padId: string): Badge | undefined
  activeDeskId(): string
  deskName(id: string): string
  /** The focusable panel the per-panel pads follow (the pane the Foco de Mesa is on); undefined when there is none. */
  activePanelId(): string | undefined
  /** A panel's name as its tab shows it. */
  panelName(id: string): string
  /** The key hint of a command ('' when none). */
  hint(commandId: string): string
  /** The person changed something of the side bars (a pad opened or closed, a width, a side, a pad's state): save soon. */
  onChange(): void
  /** Right-click on a pad's icon, or its header's "⋯" (floating, for a pad that absorbs its header). */
  onPadMenu(padId: string, x: number, y: number, opener: HTMLElement): void
  /** The core's items of a pad's menu (PadHost.menuItems). */
  padMenuItems(padId: string): ContextMenuEntry[]
  /** A pad that held the keyboard was hidden: give it back to the desks. */
  onFocusLost(): void
}

interface Mounted {
  padId: string
  deskId?: string
  /** The focusable panel a per-panel pad's view belongs to. */
  panelId?: string
  wrapper: HTMLElement
  view: PadView
  shown: boolean
}

/**
 * Header absorption (PadContribution.absorbsHeader): the wrapper carries `.absorbed` (no header row; the content starts
 * at the top) and `.menu-hosted` while the view shows the pad's menu itself; without it the pad's "⋯" (`.pad-float`)
 * floats in the top-right corner, so the pad's menu is always reachable.
 */

const STRIP = '.sb-strip'

export class SideBars {
  private readonly workbench: HTMLElement
  private readonly layer: HTMLElement
  private readonly asides: Record<Side, HTMLElement>
  private readonly host: SideBarsHost
  private state: SideBarsLayout = emptySideBars()
  /** The saved state of each desk's per-desk pads (desk id → pad id → state), as read; live views overwrite at save time. */
  private readonly deskStates = new Map<string, Record<string, unknown>>()
  private readonly views = new Map<string, Mounted>()
  /** A per-panel pad shown while no panel has the focus: just the blank view saying so (one per pad, no state). */
  private readonly noTarget = new Map<string, HTMLElement>()
  /** Pads by how recently they were opened or focused (the palette's "Mover prancheta…" acts on the first one still open). */
  private mru: string[] = []

  constructor(workbench: HTMLElement, host: SideBarsHost) {
    this.workbench = workbench
    this.host = host
    this.layer = workbench.querySelector<HTMLElement>('#pads')!
    this.asides = { left: workbench.querySelector<HTMLElement>('#sidebar-left')!, right: workbench.querySelector<HTMLElement>('#sidebar-right')! }
    for (const side of SIDES) this.wireSash(side)
    this.layer.addEventListener('focusin', ev => {
      const id = (ev.target as Element | null)?.closest?.<HTMLElement>('.pad')?.dataset.pad
      if (id) this.touch(id)
    })
    new ResizeObserver(() => this.applyWidths()).observe(workbench)
  }

  // ---------- state ----------

  get layout(): SideBarsLayout { return this.state }

  /** Replaces everything with a file's side bars and its desks' pad states; views are created for the saved states. */
  load(layout: SideBarsLayout, desks: readonly { id: string; pads?: Record<string, unknown> }[]): void {
    for (const m of this.views.values()) this.disposeView(m)
    this.views.clear()
    for (const el of this.noTarget.values()) el.remove()
    this.noTarget.clear()
    this.deskStates.clear()
    this.state = layout
    for (const d of desks) if (d.pads && Object.keys(d.pads).length) this.deskStates.set(d.id, { ...d.pads })
    for (const pad of this.host.pads()) {
      if (pad.scope === 'global') { if (pad.id in layout.pads) this.ensureView(pad, undefined) }
      else if (pad.scope === 'panel') for (const panelId of panelIdsOfPad(layout.pads, pad.id)) this.ensureView(pad, undefined, panelId)
      else for (const d of desks) if (this.deskStates.get(d.id)?.[pad.id] !== undefined) this.ensureView(pad, d.id)
    }
    this.mru = SIDES.map(s => layout[s].open).filter((x): x is string => !!x)
    this.render()
  }

  /** The side bars as layout.json keeps them: the global pads' states serialized from their live views. */
  toJSON(): SideBarsLayout {
    const pads = { ...this.state.pads }
    for (const m of this.views.values()) {
      if (m.deskId !== undefined || !m.view.serialize) continue
      pads[m.panelId === undefined ? m.padId : panelPadKey(m.padId, m.panelId)] = m.view.serialize()
    }
    return { ...this.state, pads }
  }

  /** A desk's per-desk pad states for layout.json (undefined when it has none). */
  deskPads(deskId: string): Record<string, unknown> | undefined {
    const out = { ...this.deskStates.get(deskId) }
    for (const m of this.views.values()) if (m.deskId === deskId && m.view.serialize) out[m.padId] = m.view.serialize()
    return Object.keys(out).length ? out : undefined
  }

  /** The desks now: the views and states of a desk that is gone go with it. */
  syncDesks(ids: readonly string[]): void {
    const alive = new Set(ids)
    for (const [key, m] of this.views) if (m.deskId !== undefined && !alive.has(m.deskId)) { this.disposeView(m); this.views.delete(key) }
    for (const id of [...this.deskStates.keys()]) if (!alive.has(id)) this.deskStates.delete(id)
    this.render()
  }

  // ---------- what the person does ----------

  toggle(padId: string, focus = true): void { this.apply(togglePad(this.state, this.host.pads(), padId), focus ? padId : undefined) }
  open(padId: string, focus = true): void { this.apply(openPad(this.state, this.host.pads(), padId), focus ? padId : undefined) }
  toggleSide(side: Side): void {
    const next = toggleSideBar(this.state, this.host.pads(), side)
    this.apply(next, next[side].open && next[side].open !== this.state[side].open ? next[side].open : undefined)
  }
  move(padId: string): void { this.apply(movePad(this.state, this.host.pads(), padId), padId) }
  restore(padId: string): void { this.apply(restorePad(this.state, this.host.pads(), padId), padId) }

  /** The pad open on a side (declared and on that side), if any. */
  openOn(side: Side): PadDescriptor | undefined { return openPadOn(this.host.pads(), this.state, side) }
  isOpen(padId: string): boolean { return SIDES.some(s => this.openOn(s)?.id === padId) }
  sideOf(padId: string): Side | undefined { const p = this.pad(padId); return p ? sideOf(this.state, p) : undefined }
  isMoved(padId: string): boolean { const p = this.pad(padId); return !!p && isMoved(this.state, p) }

  /** The pad commands without a name act on: the one most recently opened or focused that is still open. */
  current(): string | undefined { return this.mru.find(id => this.isOpen(id)) }

  /** The view shown for a pad now (its desk's, for a per-desk pad). */
  shownView(padId: string): PadView | undefined {
    for (const m of this.views.values()) if (m.padId === padId && m.shown) return m.view
    return undefined
  }

  focus(padId: string): void { this.shownView(padId)?.focus() }

  /** A pad's view (of a desk for a desk pad, of a panel for a panel pad: `owner`), created if it never showed: where a closing desk's pad content goes. */
  viewOf(padId: string, owner: string | undefined): PadView | undefined {
    const pad = this.pad(padId)
    if (!pad) return undefined
    if (pad.scope === 'panel' && !owner) return undefined
    const m = this.ensureView(pad, pad.scope === 'desk' ? owner : undefined, pad.scope === 'panel' ? owner : undefined)
    if (m) this.render()
    return m?.view
  }

  /**
   * Takes a frames pad note away (app/renderer/pad-notes.ts): its view goes without saving anything and so does its saved
   * state. A pad shown for that owner right now gets a fresh view on the next render (seeded like a new one).
   */
  dropNote(padId: string, owner: { deskId?: string; panelId?: string }, redraw = true): void {
    const key = this.viewKey(padId, owner.deskId, owner.panelId)
    const m = this.views.get(key)
    if (m) {
      this.views.delete(key)
      try { m.view.dispose() } catch (err) { console.error(`prancheta ${padId}: erro ao descartar a vista`, err) }
      m.wrapper.remove()
    }
    if (owner.deskId !== undefined) {
      const d = this.deskStates.get(owner.deskId)
      if (d) delete d[padId]
    } else {
      const pads = { ...this.state.pads }
      delete pads[owner.panelId === undefined ? padId : panelPadKey(padId, owner.panelId)]
      this.state = { ...this.state, pads }
    }
    if (redraw) this.render()
  }

  /** Puts a note's saved state back (undo of `dropNote`): whatever view stands there now is replaced by one built from it. */
  putNote(padId: string, owner: { deskId?: string; panelId?: string }, state: unknown): void {
    this.dropNote(padId, owner, false)
    if (owner.deskId !== undefined) this.deskStates.set(owner.deskId, { ...this.deskStates.get(owner.deskId), [padId]: state })
    else this.state = { ...this.state, pads: { ...this.state.pads, [owner.panelId === undefined ? padId : panelPadKey(padId, owner.panelId)]: state } }
    const pad = this.pad(padId)
    if (pad) this.ensureView(pad, owner.deskId, owner.panelId)
    this.render()
  }

  /** The notes' records (SideBarsLayout.meta), saved with the side bars. */
  get meta(): Record<string, unknown> { return this.state.meta ?? {} }
  setMeta(meta: Record<string, unknown>): void {
    const { meta: _old, ...rest } = this.state
    this.state = Object.keys(meta).length ? { ...rest, meta } : rest
  }

  private pad(id: string): PadDescriptor | undefined { return this.host.pads().find(p => p.id === id) }

  /** A pad's title as its header shows it: a desk pad carries the active desk's name ('Prancheta da mesa · Soul'), a panel pad its panel's. */
  padTitle(padId: string, deskId?: string, panelId?: string): string {
    const pad = this.pad(padId)
    if (!pad) return padId
    const desk = pad.scope === 'desk' ? (deskId ?? this.host.activeDeskId()) : undefined
    if (desk) return `${pad.title} · ${this.host.deskName(desk)}`
    const panel = pad.scope === 'panel' ? (panelId ?? this.host.activePanelId()) : undefined
    return panel ? `${pad.title} · ${this.host.panelName(panel)}` : pad.title
  }

  private touch(id: string): void { this.mru = [id, ...this.mru.filter(x => x !== id)].slice(0, 16) }

  private apply(next: SideBarsLayout, focus: string | undefined): void {
    if (next === this.state) return
    const hadFocus = this.layer.contains(document.activeElement)
    this.state = next
    if (focus && this.isOpen(focus)) this.touch(focus)
    this.render()
    this.host.onChange()
    if (focus && this.isOpen(focus)) requestAnimationFrame(() => this.focus(focus))
    else if (hadFocus && !this.layer.contains(document.activeElement)) this.host.onFocusLost()
  }

  // ---------- drawing ----------

  /** Strips, which views show, widths. Called after every change of the pads, the state or the active desk. */
  render(): void {
    const pads = this.host.pads()
    const desk = this.host.activeDeskId()
    const panel = this.host.activePanelId()
    for (const side of SIDES) {
      const here = padsOn(pads, this.state, side)
      const open = this.openOn(side)
      const aside = this.asides[side]
      // A side with no pad has no strip at all.
      aside.hidden = here.length === 0
      aside.classList.toggle('open', !!open)
      const strip = aside.querySelector<HTMLElement>(STRIP)!
      // The strip is redrawn; a button that had the keyboard (Enter, Space) keeps it.
      const focused = (strip.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.pad : undefined)
      strip.replaceChildren(...here.map(p => this.iconButton(p, p.id === open?.id)))
      if (focused) strip.querySelector<HTMLElement>(`[data-pad="${CSS.escape(focused)}"]`)?.focus()
      if (open) {
        if (open.scope === 'panel' && !panel) this.ensureNoTarget(open)
        else this.ensureView(open, open.scope === 'desk' ? desk : undefined, open.scope === 'panel' ? panel : undefined)
      }
    }
    for (const [padId, el] of this.noTarget) {
      const pad = this.pad(padId)
      const side = pad ? sideOf(this.state, pad) : undefined
      const shown = !!pad && !!side && !panel && this.openOn(side)?.id === pad.id
      if (side) el.dataset.side = side
      el.classList.toggle('shown', shown)
      el.toggleAttribute('inert', !shown)
      el.setAttribute('aria-hidden', String(!shown))
    }
    for (const m of this.views.values()) {
      const pad = this.pad(m.padId)
      const side = pad ? sideOf(this.state, pad) : undefined
      const shown = !!pad && !!side && this.openOn(side)?.id === pad.id && (m.deskId === undefined || m.deskId === desk) && (m.panelId === undefined || m.panelId === panel)
      if (side) m.wrapper.dataset.side = side
      m.wrapper.classList.toggle('shown', shown)
      m.wrapper.toggleAttribute('inert', !shown)
      m.wrapper.setAttribute('aria-hidden', String(!shown))
      const title = m.wrapper.querySelector<HTMLElement>('.pad-desk')
      if (title && m.deskId) title.textContent = this.host.deskName(m.deskId)
      else if (title && m.panelId) title.textContent = this.host.panelName(m.panelId)
      if (shown !== m.shown) { m.shown = shown; m.view.setVisible?.(shown) }
    }
    this.applyWidths()
  }

  /** Each side's width, fitted to the window: on the slot (the room an open pad takes) and on that side's views. */
  private applyWidths(): void {
    const room = this.workbench.clientWidth - SIDES.reduce((n, s) => n + (this.asides[s].hidden ? 0 : this.asides[s].querySelector<HTMLElement>(STRIP)!.offsetWidth), 0)
    const open = { left: !!this.openOn('left'), right: !!this.openOn('right') }
    const left = fitWidth(this.state.left.width, room, open.right ? this.state.right.width : 0)
    const right = fitWidth(this.state.right.width, room, open.left ? left : 0)
    this.workbench.style.setProperty('--sb-left-w', `${left}px`)
    this.workbench.style.setProperty('--sb-right-w', `${right}px`)
    for (const s of SIDES) this.workbench.style.setProperty(`--sb-${s}-strip`, `${this.asides[s].hidden ? 0 : this.asides[s].querySelector<HTMLElement>(STRIP)!.offsetWidth}px`)
  }

  private iconButton(pad: PadDescriptor, open: boolean): HTMLElement {
    const b = document.createElement('button')
    b.className = 'sb-icon'
    b.type = 'button'
    b.dataset.pad = pad.id
    b.setAttribute('aria-pressed', String(open))
    const hint = this.host.hint(padToggleCommand(pad.id))
    b.title = `${this.padTitle(pad.id)}${hint ? ` (${hint})` : ''}: ${open ? 'fechar' : 'abrir'} · clique direito: mover`
    b.setAttribute('aria-label', pad.title)
    // Closed: the regular (outline) weight; open: the fill weight, when the icon has one (Phosphor's `<name>-fill`).
    const fill = `${pad.icon}-fill` as IconName
    b.append(icon(open && ICON_NAMES.includes(fill) ? fill : pad.icon as IconName))
    const badge = this.host.badgeOf?.(pad.id)
    if (badge) {
      const el = document.createElement('span')
      el.className = `sb-badge ${badge.attention ? 'waiting' : 'plain'}${badge.count ? '' : ' pip'}`
      el.textContent = badge.count ? countLabel(badge.count) : ''
      b.append(el)
      if (badge.tooltip) b.title += `\n${badge.tooltip}`
      if (badge.count) b.setAttribute('aria-label', `${pad.title}, ${badge.count}`)
    }
    b.addEventListener('mousedown', ev => ev.preventDefault()) // the keyboard moves only into the pad that opens
    b.addEventListener('click', () => this.toggle(pad.id))
    b.addEventListener('contextmenu', ev => { ev.preventDefault(); this.host.onPadMenu(pad.id, ev.clientX, ev.clientY, b) })
    return b
  }

  private viewKey(padId: string, deskId: string | undefined, panelId?: string): string {
    return panelId !== undefined ? `${padId}@panel:${panelId}` : deskId === undefined ? padId : `${padId}@${deskId}`
  }

  /** The wrapper of a pad's area (header or floating "⋯") and the body its content goes in. */
  private buildWrapper(pad: PadDescriptor, deskId: string | undefined, panelId: string | undefined): { wrapper: HTMLElement; body: HTMLElement } {
    const wrapper = document.createElement('section')
    wrapper.className = pad.absorbsHeader ? 'pad absorbed' : 'pad'
    wrapper.dataset.pad = pad.id
    if (deskId) wrapper.dataset.desk = deskId
    if (panelId) wrapper.dataset.panel = panelId
    wrapper.dataset.side = sideOf(this.state, pad)
    wrapper.setAttribute('role', 'region')
    wrapper.setAttribute('aria-label', pad.title)
    wrapper.toggleAttribute('inert', true)
    const head = document.createElement('header')
    head.className = 'pad-head'
    const title = document.createElement('span')
    title.className = 'pad-title'
    title.textContent = pad.title
    head.append(title)
    if (deskId) { const d = document.createElement('span'); d.className = 'pad-desk'; d.textContent = this.host.deskName(deskId); head.append(d) }
    if (panelId) { const d = document.createElement('span'); d.className = 'pad-desk'; d.textContent = this.host.panelName(panelId); head.append(d) }
    const sp = document.createElement('span'); sp.className = 'sp'
    const more = document.createElement('button')
    more.className = 'ib pad-more'; more.type = 'button'; more.title = 'Mais ações da prancheta'; more.setAttribute('aria-label', 'Mais ações da prancheta')
    more.append(icon('dots-three'))
    more.addEventListener('click', ev => { const r = more.getBoundingClientRect(); ev.stopPropagation(); this.host.onPadMenu(pad.id, r.left, r.bottom + 4, more) })
    const body = document.createElement('div')
    body.className = 'pad-body'
    if (pad.absorbsHeader) {
      // No header row: the "⋯" floats over the content's top-right corner (hidden while the view hosts the menu).
      const float = document.createElement('div')
      float.className = 'pad-float'
      float.append(more)
      wrapper.append(body, float)
    } else {
      const close = document.createElement('button')
      close.className = 'ib pad-close'; close.type = 'button'; close.title = 'Fechar a prancheta'; close.setAttribute('aria-label', 'Fechar a prancheta')
      close.append(icon('x'))
      close.addEventListener('click', () => this.toggle(pad.id, false))
      head.append(sp, more, close)
      wrapper.append(head, body)
    }
    this.layer.append(wrapper)
    return { wrapper, body }
  }

  /** A per-panel pad open while no panel has the focus: nothing to show but a discreet line saying why. */
  private ensureNoTarget(pad: PadDescriptor): void {
    if (this.noTarget.has(pad.id)) return
    const { wrapper, body } = this.buildWrapper(pad, undefined, undefined)
    wrapper.classList.add('pad-no-target')
    body.append(createBlankView({ message: 'Nenhum painel em foco.' }))
    this.noTarget.set(pad.id, wrapper)
  }

  /** The view of a pad (for a desk, or for a panel), created on first need; none when no extension registered what the pad shows. */
  private ensureView(pad: PadDescriptor, deskId: string | undefined, panelId?: string): Mounted | undefined {
    const key = this.viewKey(pad.id, deskId, panelId)
    const existing = this.views.get(key)
    if (existing) return existing
    const type = this.host.padType(pad.id)
    if (!type) return undefined
    const { wrapper, body } = this.buildWrapper(pad, deskId, panelId)
    const state = panelId !== undefined ? this.state.pads[panelPadKey(pad.id, panelId)] : deskId === undefined ? this.state.pads[pad.id] : this.deskStates.get(deskId)?.[pad.id]
    let view: PadView
    try {
      view = type.create({
        padId: pad.id, ...(deskId ? { deskId } : {}), ...(panelId ? { panelId } : {}), state,
        persist: () => this.host.onChange(),
        title: () => this.padTitle(pad.id, deskId, panelId),
        menuItems: () => this.host.padMenuItems(pad.id),
        setMenuHosted: hosted => { wrapper.classList.toggle('menu-hosted', !!pad.absorbsHeader && hosted) },
      })
    } catch (err) {
      console.error(`prancheta ${pad.id}: a extensão falhou ao criar a vista`, err)
      wrapper.remove()
      return undefined
    }
    body.append(view.element)
    const m: Mounted = { padId: pad.id, ...(deskId ? { deskId } : {}), ...(panelId ? { panelId } : {}), wrapper, view, shown: false }
    this.views.set(key, m)
    return m
  }

  private disposeView(m: Mounted): void {
    // What the view would save goes on living in the state map: a desk that comes back, or a reload, finds it.
    try {
      const s = m.view.serialize?.()
      if (s !== undefined) {
        if (m.deskId === undefined) this.state = { ...this.state, pads: { ...this.state.pads, [m.panelId === undefined ? m.padId : panelPadKey(m.padId, m.panelId)]: s } }
      }
      m.view.dispose()
    } catch (err) { console.error(`prancheta ${m.padId}: erro ao descartar a vista`, err) }
    m.wrapper.remove()
  }

  // ---------- the sash ----------

  private wireSash(side: Side): void {
    const sash = this.asides[side].querySelector<HTMLElement>('.sb-sash')!
    sash.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || !this.openOn(side)) return
      ev.preventDefault()
      sash.setPointerCapture(ev.pointerId)
      const start = ev.clientX
      const from = parseFloat(this.workbench.style.getPropertyValue(`--sb-${side}-w`)) || this.state[side].width
      document.body.classList.add('sb-resizing')
      const move = (e: PointerEvent): void => {
        const dx = e.clientX - start
        this.state = setWidth(this.state, side, side === 'left' ? from + dx : from - dx)
        this.applyWidths()
      }
      const up = (): void => {
        sash.removeEventListener('pointermove', move)
        sash.removeEventListener('pointerup', up)
        sash.removeEventListener('pointercancel', up)
        document.body.classList.remove('sb-resizing')
        // What is saved is what shows (the window may have held it narrower than the drag asked).
        this.state = setWidth(this.state, side, parseFloat(this.workbench.style.getPropertyValue(`--sb-${side}-w`)) || this.state[side].width)
        this.host.onChange()
      }
      sash.addEventListener('pointermove', move)
      sash.addEventListener('pointerup', up)
      sash.addEventListener('pointercancel', up)
    })
    sash.addEventListener('dblclick', () => {
      if (!this.openOn(side)) return
      this.state = setWidth(this.state, side, DEFAULT_SIDEBAR_WIDTH)
      this.applyWidths()
      this.host.onChange()
    })
  }

  /** What the e2e reads: each side's strip, open pad and width; each live view. */
  snapshot(): { left: SideSnapshot; right: SideSnapshot; placement: Record<string, Side>; views: { pad: string; desk?: string; panel?: string; side: string; shown: boolean; width: number }[] } {
    const side = (s: Side): SideSnapshot => ({
      strip: this.asides[s].hidden ? [] : [...this.asides[s].querySelectorAll<HTMLElement>('.sb-icon')].map(b => b.dataset.pad!),
      open: this.openOn(s)?.id,
      width: this.state[s].width,
      shownWidth: parseFloat(this.workbench.style.getPropertyValue(`--sb-${s}-w`)) || 0,
      slot: (this.asides[s].querySelector<HTMLElement>('.sb-slot')?.offsetWidth) ?? 0,
    })
    return {
      left: side('left'), right: side('right'), placement: { ...this.state.placement },
      views: [...this.views.values()].map(m => ({ pad: m.padId, ...(m.deskId ? { desk: m.deskId } : {}), ...(m.panelId ? { panel: m.panelId } : {}), side: m.wrapper.dataset.side ?? '', shown: m.shown, width: m.wrapper.offsetWidth })),
    }
  }
}

export interface SideSnapshot { strip: string[]; open: string | undefined; width: number; shownWidth: number; slot: number }
