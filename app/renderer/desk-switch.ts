// The desk switcher in the middle of the toolbar (the "capsule"): the fixed "⚡ Gaveta" pill (#btn-drawer, wired
// by the host), a divider, one segment per visible desk, and one fixed "+N" at the right listing the desks that
// do not fit. An inactive segment is the name in the desk's colour; the active one is filled with it.
//
// Click switches; double-click renames in place; right-click opens the desk's menu (built by the host). The
// switcher owns no desk state: the host calls `render` with the row as it is. It does own which desks are
// visible (desk-switch-rules.ts: whole names while they fit, the active desk never hidden, MRU on the "+N").
//
// Fitting is measured: each segment's natural width comes from an invisible copy of the row (.desk-measure),
// and the room is the toolbar minus twice the WIDER side (the capsule sits on the window's true centre, so it
// may only grow as far as the wider side lets it on both sides). A ResizeObserver watches the toolbar and its
// two sides only, never the capsule, and lays out in the next frame: repainting the capsule cannot re-trigger it.
//
// Keyboard and a11y: the row is a tablist with a roving tabindex (the active tab is the Tab stop); Left/Right/
// Home/End move the focus, Enter/Space switch, Shift+F10 or the menu key open the desk's menu, Down on the "+N"
// opens its menu, Shift+Left/Right/Home/End move the desk itself in the queue. When the capsule is repainted with focus inside it, the focus follows the same desk. A reorder
// (the "+N" swapping who is visible) slides the surviving segments to their new places (FLIP, 320 ms) unless
// the person asked for reduced motion.
import { DESK_HUES, deskTokens, type DeskHue, type DeskInfo, MAX_DESK_NAME } from './desks.ts'
import { fitDesks, overflowDesks, pickFromOverflow, touchUsed, type LastUsed } from './desk-switch-rules.ts'
import { icon } from './icons.ts'
import { clampDragX, dragTargetIndex, fullIndexAfterDrop, passedThreshold } from './desk-drag-rules.ts'

/** What a desk's badge says: how many panes finished (done) or wait for the user (waiting). */
export interface DeskAttention { done: number; waiting: number }

export interface DeskSwitchHost {
  switchTo(id: string): void
  /** The "+" at the end of the capsule: a new desk, straight away, which becomes the active one. */
  create(): void
  rename(id: string, name: string): void
  recolor(id: string, color: DeskHue): void
  menu(id: string, x: number, y: number): void
  /** The "+N" menu: one entry per hidden desk; `pick` switches to it. */
  overflowMenu(entries: { id: string; name: string; attention: number }[], x: number, y: number, pick: (id: string) => void, opener: HTMLElement): void
  /** Hint shown in a segment's tooltip ("Ctrl+1"). */
  hint(position: number): string
  /** Moves a desk to `to`, an index in the FULL queue (hidden desks count). */
  move(id: string, to: number): void
}

/** Breathing room between the capsule and each side, px. */
const SIDE_MARGIN = 12
/** Duration of the reorder animation, ms. */
const FLIP_MS = 320
/** A touch must rest this long before it can start a drag, ms. */
const TOUCH_HOLD_MS = 300

/** State of a press on a segment, from pointerdown until it ends. */
interface Press {
  id: string; seg: HTMLElement; pointerId: number; x0: number; y0: number
  armed: boolean; timer: number
  /** Set once the drag started: resting centres and the dragged segment's geometry. */
  drag?: { els: HTMLElement[]; centers: number[]; from: number; to: number; step: number; min: number; max: number; lo: number; hi: number; center0: number }
}

export class DeskSwitch {
  readonly element: HTMLElement
  private readonly host: DeskSwitchHost
  private readonly segs: HTMLElement
  private readonly more: HTMLButtonElement
  private readonly add: HTMLButtonElement
  private readonly measure: HTMLElement
  private readonly bar: HTMLElement
  private readonly sides: readonly HTMLElement[]
  private desks: readonly DeskInfo[] = []
  private active = ''
  private attention: (deskId: string) => DeskAttention = () => ({ done: 0, waiting: 0 })
  private visible: string[] = []
  private lastUsed: LastUsed = {}
  private renaming: string | undefined
  private dragging: string | undefined
  private press: Press | undefined
  private swallowClick = false
  private frame = 0

  constructor(element: HTMLElement, bar: HTMLElement, sides: readonly HTMLElement[], host: DeskSwitchHost) {
    this.element = element
    this.host = host
    this.bar = bar
    this.sides = sides
    this.segs = document.createElement('div')
    this.segs.className = 'desk-segs'
    this.segs.setAttribute('role', 'tablist')
    this.segs.setAttribute('aria-label', 'Mesas')
    this.segs.addEventListener('keydown', ev => this.onSegKey(ev))
    this.more = document.createElement('button')
    this.more.type = 'button'
    this.more.className = 'seg desk-more'
    this.more.setAttribute('aria-haspopup', 'menu')
    this.more.setAttribute('aria-expanded', 'false')
    this.more.hidden = true
    this.more.addEventListener('mousedown', ev => ev.preventDefault())
    this.more.addEventListener('click', ev => { ev.stopPropagation(); this.openOverflow() })
    this.more.addEventListener('keydown', ev => { if (ev.key === 'ArrowDown') { ev.preventDefault(); this.openOverflow() } })
    this.add = document.createElement('button')
    this.add.type = 'button'
    this.add.className = 'seg desk-add'
    this.add.title = 'Nova mesa'
    this.add.setAttribute('aria-label', 'Nova mesa')
    this.add.append(icon('plus'))
    this.add.addEventListener('mousedown', ev => ev.preventDefault())
    this.add.addEventListener('click', ev => { ev.stopPropagation(); this.host.create() })
    this.measure = document.createElement('div')
    this.measure.className = 'desk-measure'
    this.measure.setAttribute('aria-hidden', 'true')
    element.append(this.segs, this.more, this.add, this.measure)
    const ro = new ResizeObserver(() => this.schedule())
    ro.observe(bar)
    for (const s of sides) ro.observe(s)
  }

  render(desks: readonly DeskInfo[], active: string, attention: (deskId: string) => DeskAttention): void {
    if (active !== this.active) this.lastUsed = touchUsed(this.lastUsed, active)
    this.desks = desks
    this.active = active
    this.attention = attention
    if (this.renaming || this.dragging) return // the input in a segment is being edited: repainting would drop it
    this.layout()
  }

  /** What the capsule shows now (test hook). */
  state(): { visible: string[]; hidden: string[]; active: string } {
    const order = this.desks.map(d => d.id)
    return { visible: [...this.visible], hidden: overflowDesks(order, this.visible), active: this.active }
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; if (!this.renaming && !this.dragging) this.layout() })
  }

  /** Measures every segment's natural width, decides who is visible, and paints. */
  private layout(): void {
    const order = this.desks.map(d => d.id)
    this.measure.replaceChildren(...this.desks.map((d, i) => this.segment(d, i, true)))
    const probe = document.createElement('span')
    probe.className = 'seg desk-more'
    probe.textContent = `+${Math.max(order.length, 10)}`
    this.measure.append(probe)
    const widths: Record<string, number> = {}
    for (const el of this.measure.querySelectorAll<HTMLElement>('.seg[data-desk]')) widths[el.dataset.desk!] = Math.ceil(el.getBoundingClientRect().width)
    const plusWidth = Math.ceil(probe.getBoundingClientRect().width)
    const avail = this.room()
    this.visible = avail === undefined
      ? order.filter(id => this.visible.includes(id) || id === this.active)
      : fitDesks({ order, active: this.active, visible: this.visible.filter(id => order.includes(id)), widths, avail, plusWidth, gap: this.gap(), lastUsed: this.lastUsed })
    if (this.visible.length === 0) this.visible = [...order]
    this.measure.replaceChildren()
    const shown = new Set(this.visible)
    const before = this.segRects()
    const focused = this.segs.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.desk : undefined
    this.segs.replaceChildren(...this.desks.flatMap((d, i) => shown.has(d.id) ? [this.segment(d, i, false)] : []))
    if (focused) this.segs.querySelector<HTMLElement>(`.seg[data-desk="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
    this.flip(before)
    const hidden = overflowDesks(order, this.visible)
    this.more.hidden = hidden.length === 0
    const waiting = hidden.reduce((n, id) => { const a = this.attention(id); return n + a.done + a.waiting }, 0)
    this.more.replaceChildren(document.createTextNode(`+${hidden.length}`))
    if (waiting > 0) { const dot = document.createElement('span'); dot.className = 'more-dot'; this.more.append(dot) }
    this.more.title = `Mais ${hidden.length === 1 ? '1 mesa' : `${hidden.length} mesas`}${waiting > 0 ? ` (${waiting} com atenção)` : ''}`
    this.more.setAttribute('aria-label', this.more.title)
  }

  /** Room for the segments and the "+N", px; undefined when the toolbar is not laid out (hidden window). */
  private room(): number | undefined {
    const barStyle = getComputedStyle(this.bar)
    const inner = this.bar.clientWidth - parseFloat(barStyle.paddingLeft) - parseFloat(barStyle.paddingRight)
    if (inner <= 0) return undefined
    const side = Math.max(...this.sides.map(s => s.getBoundingClientRect().width))
    // The capsule's own chrome: its padding, the pill, the divider, and the gaps between them.
    const cs = getComputedStyle(this.element)
    let chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    const gap = this.gap()
    for (const el of this.element.children) {
      if (el === this.segs || el === this.more || el === this.measure) continue
      chrome += (el as HTMLElement).getBoundingClientRect().width + gap
    }
    chrome += gap // between the segments and the "+N"
    return inner - 2 * (side + SIDE_MARGIN) - chrome
  }

  private gap(): number {
    return parseFloat(getComputedStyle(this.element).columnGap) || 0
  }

  private segment(d: DeskInfo, index: number, measuring: boolean): HTMLElement {
    const active = d.id === this.active
    const seg = document.createElement('div')
    seg.className = 'seg'
    seg.classList.toggle('on', active)
    seg.dataset.desk = d.id
    const t = deskTokens(d.color)
    seg.style.setProperty('--seg-fill', t.fill)
    seg.style.setProperty('--seg-fg', t.foreground)
    seg.style.setProperty('--seg-text', t.text)
    const name = document.createElement('span'); name.className = 'seg-name'; name.textContent = d.name
    seg.append(name)
    const att = this.attention(d.id)
    const total = att.done + att.waiting
    if (total > 0) {
      const badge = document.createElement('span')
      badge.className = `cnt desk-badge ${att.waiting > 0 ? 'waiting' : 'done'}`
      badge.textContent = String(total)
      seg.append(badge)
    }
    if (measuring) return seg
    seg.setAttribute('role', 'tab')
    seg.setAttribute('aria-selected', String(active))
    seg.tabIndex = active ? 0 : -1
    seg.setAttribute('aria-label', `${d.name}${total === 0 ? '' : `, ${total} com atenção`}`)
    const go = index < 9 ? ` (${this.host.hint(index + 1)})` : ''
    const what = total === 0 ? '' : `\n${[att.waiting ? `${att.waiting} esperando você` : '', att.done ? `${att.done} terminou` : ''].filter(Boolean).join(', ')}`
    seg.title = `${d.name}${go}${what}\nDuplo clique renomeia; clique direito: mais opções. Arraste para reordenar.`
    seg.addEventListener('mousedown', ev => { if (ev.button === 0 && !(ev.target as Element).closest('input')) ev.preventDefault() })
    seg.addEventListener('click', () => { if (this.swallowClick) return; this.host.switchTo(d.id) })
    seg.addEventListener('dblclick', ev => { ev.preventDefault(); if (this.swallowClick) return; this.startRename(d.id) })
    seg.addEventListener('pointerdown', ev => this.pressStart(ev, d.id, seg))
    seg.addEventListener('pointermove', ev => this.pressMove(ev))
    seg.addEventListener('pointerup', ev => this.pressEnd(ev, true))
    seg.addEventListener('pointercancel', ev => this.pressEnd(ev, false))
    seg.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.host.menu(d.id, ev.clientX, ev.clientY) })
    return seg
  }

  private openOverflow(): void {
    const order = this.desks.map(d => d.id)
    const hidden = overflowDesks(order, this.visible)
    const r = this.more.getBoundingClientRect()
    const entries = hidden.map(id => { const a = this.attention(id); return { id, name: this.desks.find(d => d.id === id)?.name ?? id, attention: a.done + a.waiting } })
    this.host.overflowMenu(entries, r.left, r.bottom + 4, id => {
      // The picked desk takes the place of the visible desk used longest ago; the others stay.
      this.visible = pickFromOverflow(order, this.visible, id, this.active, this.lastUsed)
      this.host.switchTo(id)
    }, this.more)
  }

  /** Keys of the tablist: Left/Right/Home/End move the focus, Enter/Space switch, the menu key opens the desk's menu. */
  private onSegKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement
    if (target.closest('input')) return // renaming: the input owns its keys
    const tabs = [...this.segs.querySelectorAll<HTMLElement>('.seg[data-desk]')]
    const i = tabs.indexOf(target.closest<HTMLElement>('.seg[data-desk]')!)
    if (i < 0) return
    if (ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End')) {
      // Reorders the focused desk in the full queue; layout() puts the focus back on it after the repaint.
      ev.preventDefault()
      const id = tabs[i]!.dataset.desk!
      const at = this.desks.findIndex(d => d.id === id)
      const to = ev.key === 'ArrowLeft' ? at - 1 : ev.key === 'ArrowRight' ? at + 1 : ev.key === 'Home' ? 0 : this.desks.length - 1
      if (at >= 0 && to >= 0 && to < this.desks.length && to !== at) this.host.move(id, to)
      return
    }
    const go = (n: number): void => { ev.preventDefault(); const t = tabs[(n + tabs.length) % tabs.length]; if (t) { for (const s of tabs) s.tabIndex = s === t ? 0 : -1; t.focus() } }
    if (ev.key === 'ArrowRight') go(i + 1)
    else if (ev.key === 'ArrowLeft') go(i - 1)
    else if (ev.key === 'Home') go(0)
    else if (ev.key === 'End') go(tabs.length - 1)
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.host.switchTo(tabs[i]!.dataset.desk!) }
    else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      const r = tabs[i]!.getBoundingClientRect()
      this.host.menu(tabs[i]!.dataset.desk!, r.left, r.bottom + 4)
    }
  }

  private pressStart(ev: PointerEvent, id: string, seg: HTMLElement): void {
    if (ev.button !== 0 || this.renaming || this.dragging || this.press || (ev.target as Element).closest('input')) return
    const touch = ev.pointerType === 'touch'
    const press: Press = { id, seg, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, armed: !touch, timer: 0 }
    if (touch) press.timer = window.setTimeout(() => { press.armed = true }, TOUCH_HOLD_MS)
    this.press = press
    try { seg.setPointerCapture(ev.pointerId) } catch { /* the pointer is already gone */ }
  }

  private pressMove(ev: PointerEvent): void {
    const p = this.press
    if (!p || ev.pointerId !== p.pointerId) return
    if (!p.drag) {
      if (!passedThreshold(ev.clientX - p.x0, ev.clientY - p.y0)) return
      if (!p.armed) { this.endPress(p); return } // a touch that moved before resting long enough is not a drag
      if (!this.dragStart(p)) return
    }
    this.dragMove(p, ev.clientX)
  }

  private pressEnd(ev: PointerEvent, commit: boolean): void {
    const p = this.press
    if (!p || ev.pointerId !== p.pointerId) return
    this.finishDrag(p, commit)
  }

  private dragStart(p: Press): boolean {
    const els = [...this.segs.querySelectorAll<HTMLElement>('.seg[data-desk]')]
    const from = els.indexOf(p.seg)
    if (from < 0) { this.endPress(p); return false }
    const rects = els.map(el => el.getBoundingClientRect())
    const row = this.segs.getBoundingClientRect()
    const w = rects[from]!.width
    p.drag = { els, centers: rects.map(r => r.left + r.width / 2), from, to: from, step: w + this.segGap(), min: row.left + w / 2, max: row.right - w / 2, lo: row.left, hi: row.right, center0: rects[from]!.left + w / 2 }
    this.dragging = p.id
    this.swallowClick = true
    p.seg.classList.add('dragging')
    this.segs.classList.add('drag-live')
    document.addEventListener('keydown', this.onDragKey, true)
    return true
  }

  private dragMove(p: Press, clientX: number): void {
    const d = p.drag!
    const raw = d.center0 + (clientX - p.x0)
    const center = clampDragX(raw, d.min, d.max)
    p.seg.style.transform = `translateX(${center - d.center0}px) scale(1.04)`
    // The place follows the unclamped centre (kept inside the row): a segment wider than the first one could never
    // reach that place if the visual clamp, which keeps it inside the capsule, decided.
    d.to = dragTargetIndex(d.centers, d.from, clampDragX(raw, d.lo, d.hi))
    d.els.forEach((el, i) => {
      if (i === d.from) return
      const shift = d.to > d.from && i > d.from && i <= d.to ? -d.step : d.to < d.from && i >= d.to && i < d.from ? d.step : 0
      el.style.transform = shift ? `translateX(${shift}px)` : ''
    })
  }

  private readonly onDragKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !this.press?.drag) return
    ev.preventDefault()
    ev.stopPropagation()
    this.finishDrag(this.press, false)
  }

  /** Ends the press; a started drag commits the new place (when it changed) or puts everything back. */
  private finishDrag(p: Press, commit: boolean): void {
    const d = p.drag
    this.endPress(p)
    if (!d) return
    p.seg.classList.remove('dragging')
    this.segs.classList.remove('drag-live')
    document.removeEventListener('keydown', this.onDragKey, true)
    this.dragging = undefined
    // The click that follows the release belongs to the gesture: it is dropped, then the flag clears.
    window.setTimeout(() => { this.swallowClick = false }, 0)
    const order = this.desks.map(x => x.id)
    if (commit && d.to !== d.from) {
      // The transforms stay on while the host repaints: layout() measures the visual positions (FLIP), so the segment
      // slides from where it was dropped. The old elements left the DOM by then; clearing them is harmless.
      this.host.move(p.id, fullIndexAfterDrop(order, this.visible, p.id, d.to))
      for (const el of d.els) el.style.transform = ''
    } else {
      for (const el of d.els) el.style.transform = ''
      this.layout() // repaint what was held back while dragging
    }
  }

  private endPress(p: Press): void {
    window.clearTimeout(p.timer)
    try { p.seg.releasePointerCapture(p.pointerId) } catch { /* already released */ }
    if (this.press === p) this.press = undefined
  }

  private segGap(): number {
    return parseFloat(getComputedStyle(this.segs).columnGap) || 0
  }

  /** The left edge of every visible segment inside the row, by desk id. */
  private segRects(): Map<string, number> {
    const m = new Map<string, number>()
    const base = this.segs.getBoundingClientRect().left // relative to the row: a window resize recentres the capsule, which is not a reorder
    for (const el of this.segs.querySelectorAll<HTMLElement>('.seg[data-desk]')) m.set(el.dataset.desk!, el.getBoundingClientRect().left - base)
    return m
  }

  /**
   * FLIP: the segments that were visible before and still are slide from where they were to where they are now.
   * Segments that appear fade in. Nothing runs under prefers-reduced-motion, nor before the first paint.
   */
  private flip(before: Map<string, number>): void {
    if (before.size === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const base = this.segs.getBoundingClientRect().left
    for (const el of this.segs.querySelectorAll<HTMLElement>('.seg[data-desk]')) {
      const was = before.get(el.dataset.desk!)
      if (typeof el.animate !== 'function') return
      if (was === undefined) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIP_MS, easing: 'ease-out' }); continue }
      const dx = was - (el.getBoundingClientRect().left - base)
      if (Math.abs(dx) < 1) continue
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    }
  }

  /** Puts an input in the desk's segment: Enter keeps the name, Esc or an empty name keeps the old one. */
  startRename(id: string): void {
    const seg = this.segs.querySelector<HTMLElement>(`.seg[data-desk="${CSS.escape(id)}"]`)
    const name = seg?.querySelector<HTMLElement>('.seg-name')
    if (!seg || !name || this.renaming) return
    this.renaming = id
    const input = document.createElement('input')
    input.className = 'desk-rename'
    input.value = name.textContent ?? ''
    input.maxLength = MAX_DESK_NAME
    input.spellcheck = false
    input.setAttribute('aria-label', 'Nome da mesa')
    name.replaceWith(input)
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      this.renaming = undefined
      if (commit) this.host.rename(id, input.value)
      else this.host.rename(id, name.textContent ?? '') // repaints with the old name
    }
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', ev => ev.stopPropagation())
    input.focus()
    input.select()
  }

  /** The 12 hues at (x, y): picking a swatch recolours the desk; a click elsewhere or Esc closes it. */
  pickColor(id: string, current: DeskHue, x: number, y: number): void {
    document.getElementById('desk-colors')?.remove()
    const pop = document.createElement('div')
    pop.id = 'desk-colors'
    pop.className = 'desk-colors'
    pop.setAttribute('role', 'listbox')
    pop.setAttribute('aria-label', 'Cor da mesa')
    const close = (): void => { pop.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true) }
    const onDoc = (ev: Event): void => { if (!pop.contains(ev.target as Node)) close() }
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); close() } }
    for (const { hue, label } of DESK_HUES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'swatch'
      b.dataset.color = hue
      b.style.setProperty('--desk-color', `var(--x-${hue})`)
      b.style.setProperty('--desk-color-fg', `var(--x-${hue}-foreground)`)
      b.title = label
      b.setAttribute('role', 'option')
      b.setAttribute('aria-label', label)
      b.setAttribute('aria-selected', String(hue === current))
      if (hue === current) b.append(icon('check'))
      b.addEventListener('click', ev => { ev.stopPropagation(); close(); this.host.recolor(id, hue) })
      pop.append(b)
    }
    document.body.append(pop)
    const r = pop.getBoundingClientRect()
    pop.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
    pop.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
    document.addEventListener('click', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    pop.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }
}
