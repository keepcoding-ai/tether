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
import { DESK_HUES, deskTokens, type DeskHue, type DeskInfo, MAX_DESK_NAME } from './desks.ts'
import { fitDesks, overflowDesks, pickFromOverflow, touchUsed, type LastUsed } from './desk-switch-rules.ts'
import { icon } from './icons.ts'

/** What a desk's badge says: how many panes finished (done) or wait for the user (waiting). */
export interface DeskAttention { done: number; waiting: number }

export interface DeskSwitchHost {
  switchTo(id: string): void
  rename(id: string, name: string): void
  recolor(id: string, color: DeskHue): void
  menu(id: string, x: number, y: number): void
  /** The "+N" menu: one entry per hidden desk; `pick` switches to it. */
  overflowMenu(entries: { id: string; name: string; attention: number }[], x: number, y: number, pick: (id: string) => void): void
  /** Hint shown in a segment's tooltip ("Ctrl+1"). */
  hint(position: number): string
}

/** Breathing room between the capsule and each side, px. */
const SIDE_MARGIN = 12

export class DeskSwitch {
  readonly element: HTMLElement
  private readonly host: DeskSwitchHost
  private readonly segs: HTMLElement
  private readonly more: HTMLButtonElement
  private readonly measure: HTMLElement
  private readonly bar: HTMLElement
  private readonly sides: readonly HTMLElement[]
  private desks: readonly DeskInfo[] = []
  private active = ''
  private attention: (deskId: string) => DeskAttention = () => ({ done: 0, waiting: 0 })
  private visible: string[] = []
  private lastUsed: LastUsed = {}
  private renaming: string | undefined
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
    this.more = document.createElement('button')
    this.more.type = 'button'
    this.more.className = 'seg desk-more'
    this.more.setAttribute('aria-haspopup', 'menu')
    this.more.hidden = true
    this.more.addEventListener('mousedown', ev => ev.preventDefault())
    this.more.addEventListener('click', ev => { ev.stopPropagation(); this.openOverflow() })
    this.measure = document.createElement('div')
    this.measure.className = 'desk-measure'
    this.measure.setAttribute('aria-hidden', 'true')
    element.append(this.segs, this.more, this.measure)
    const ro = new ResizeObserver(() => this.schedule())
    ro.observe(bar)
    for (const s of sides) ro.observe(s)
  }

  render(desks: readonly DeskInfo[], active: string, attention: (deskId: string) => DeskAttention): void {
    if (active !== this.active) this.lastUsed = touchUsed(this.lastUsed, active)
    this.desks = desks
    this.active = active
    this.attention = attention
    if (this.renaming) return // the input in a segment is being edited: repainting would drop it
    this.layout()
  }

  /** What the capsule shows now (test hook). */
  state(): { visible: string[]; hidden: string[]; active: string } {
    const order = this.desks.map(d => d.id)
    return { visible: [...this.visible], hidden: overflowDesks(order, this.visible), active: this.active }
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; if (!this.renaming) this.layout() })
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
    this.segs.replaceChildren(...this.desks.flatMap((d, i) => shown.has(d.id) ? [this.segment(d, i, false)] : []))
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
    const go = index < 9 ? ` (${this.host.hint(index + 1)})` : ''
    const what = total === 0 ? '' : `\n${[att.waiting ? `${att.waiting} esperando você` : '', att.done ? `${att.done} terminou` : ''].filter(Boolean).join(', ')}`
    seg.title = `${d.name}${go}${what}\nDuplo clique renomeia; clique direito: mais opções.`
    seg.addEventListener('mousedown', ev => { if (ev.button === 0 && !(ev.target as Element).closest('input')) ev.preventDefault() })
    seg.addEventListener('click', () => this.host.switchTo(d.id))
    seg.addEventListener('dblclick', ev => { ev.preventDefault(); this.startRename(d.id) })
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
    })
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
