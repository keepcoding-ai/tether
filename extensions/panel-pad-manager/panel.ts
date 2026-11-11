// The manager of the panel pad ("Painéis da mesa"): the pad's second state (frame-pads/manager-slot.ts). Its item is the
// PANEL: one row per panel of the desk on screen that has a frame in the pad, plus the loose frames (panel closed) that
// belonged to this desk. What the frame holds is on the row only to tell which panel it is (chips: the panes' names).
// A loose frame is a panel too (one whose tab is closed), not another kind of thing: every row does what the panel's tab
// does, through one menu (TetherUi.panes.tabMenuEntries with from 'manager': the tab's menu, after "Focar guia" for a
// panel on screen, after "Trazer de volta" for a loose one). Click only selects; double-click and Enter go to the tab
// (a loose panel comes back). Drag starts the tab's own drag (a loose panel comes back where it is dropped).
// Right-click, the menu key and the "⋯" at the end of the row's action bar open that menu. The bar, at the row's foot,
// shows the menu items that declare a pin (MenuPin): the highlight and the primaries on the left with their labels, the
// icons on the right; the icons that do not fit leave the bar (right to left), never the menu. No preview: the list is
// the whole manager. Esc and the header's switch take the pad back to the frame.
// The model is app/renderer/panel-frames.ts; the frames live in the core (TetherUi.pads.panelFrames).
import { icon, type IconName } from '../../app/renderer/icons.ts'
import type { AgentPane, ContextMenuEntry, FrameFilter, FramePane, PaneInfo, PanelFrameRow, PanelFrameTree } from '../../app/renderer/ext-api.ts'
import { visibleRows, whenLabel } from '../../app/renderer/panel-frames.ts'
import type { ManagerView } from '../frame-pads/manager-slot.ts'

export const MANAGER_TITLE = 'Painéis da mesa'

export interface ManagerHost {
  tree(): PanelFrameTree
  /** The agent a pane shows, when the pane is an agent's and lives somewhere in the window. */
  agent(paneId: string): AgentPane | undefined
  /** A live pane as the core describes it (type, folder, file, agent kind, place). */
  describe(paneId: string): PaneInfo | undefined
  /** Brings the panel up (its tab active and focused, its pad shown). */
  reveal(panelId: string): void
  /** The panel's menu (open or loose: one menu) as data. */
  menuEntries(panelId: string): ContextMenuEntry[]
  /** That menu at page coordinates, by its opener. */
  tabMenu(panelId: string, x: number, y: number, opener?: HTMLElement): void
  /** Starts the panel's tab drag from the row's dragstart. */
  beginDrag(panelId: string, ev: DragEvent): boolean
  /** A loose frame's drag: its panel comes back and the drag carries it like its tab's. */
  beginLooseDrag(key: string, ev: DragEvent): boolean
  revivable(key: string): { ok: boolean; reason: string }
  /** Closes loose frames (the host tells the person). */
  close(keys: readonly string[], what: 'one' | 'empty'): void
  /** The pad back to the panel's frame. */
  exit(): void
}

const PANE_ICON: Record<string, IconName> = { note: 'note-pencil', empty: 'square-half', terminal: 'terminal-window', 'md-preview': 'file-md', 'html-preview': 'file-html', 'browser-web': 'globe-simple' }
const AGENT_ICON: Record<string, IconName> = { claude: 'brand', soul: 'brand' }
/** How many of a frame's panes a row shows before "+n". */
const ROW_PANES = 3
/** The bar's limits: one highlighted action, two primaries. */
const MAX_PRIMARY = 2

type MenuItem = Exclude<ContextMenuEntry, 'sep'>
const items = (entries: readonly ContextMenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => e !== 'sep')
/** The item a key or gesture runs, found by what it says (the menu is the only definition). */
const itemOf = (entries: readonly ContextMenuEntry[], label: string): MenuItem | undefined => items(entries).find(e => e.label === label)
const BACK_LABEL = 'Trazer de volta'
const FOCUS_LABEL = 'Focar guia'
const CLOSE_LABEL = 'Fechar painel…'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** The panel's kind in a word: "Claude", "soul", "terminal", "nota", "navegador". */
export function panelKind(r: PanelFrameRow, agent: AgentPane | undefined, info: PaneInfo | undefined): string {
  if (agent) return agent.kind === 'claude' ? 'Claude' : agent.kind
  if (info?.agent) return info.agent === 'claude' ? 'Claude' : info.agent
  const t = info?.type ?? (r.panelId.startsWith('note:') ? 'note' : r.panelId.startsWith('web:') ? 'browser-web' : 'terminal')
  return t === 'note' ? 'nota' : t === 'browser-web' ? 'navegador' : t === 'terminal' ? 'terminal' : t
}

/** The panel's state in a word or two, or '' when it has none (a note, a shell). */
export function panelState(agent: AgentPane | undefined): string {
  if (!agent) return ''
  return agent.alive ? 'rodando' : 'encerrado'
}

/** A pane of the frame as the row shows it: its name (an agent's name when it is one). */
export function paneLabel(p: FramePane, agent: AgentPane | undefined): string {
  return agent?.name ?? p.title
}

export class PanelPadManager implements ManagerView {
  readonly element: HTMLElement
  private readonly host: ManagerHost
  private filter: FrameFilter = 'all'
  private selected: string | undefined
  private rows: PanelFrameRow[] = []
  /** A row is being dragged: redraws wait for its dragend (removing the source would cancel the drag). */
  private dragging = false
  private readonly list: HTMLElement
  private readonly chips: Record<FrameFilter, HTMLButtonElement>
  private readonly clean: HTMLButtonElement
  private readonly fit = new ResizeObserver(() => this.fitBars())

  constructor(host: ManagerHost) {
    this.host = host
    this.element = el('div', 'pf-pane')
    this.element.dataset.panelPadManager = 'pane'
    const head = el('div', 'pf-head')
    const title = el('span', 'pf-title', MANAGER_TITLE)
    const group = el('div', 'pf-filter')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Mostrar')
    const chip = (f: FrameFilter, label: string): HTMLButtonElement => {
      const b = el('button', 'pf-chip', label)
      b.type = 'button'
      b.dataset.filter = f
      b.addEventListener('click', () => this.setFilter(f))
      group.append(b)
      return b
    }
    this.chips = { all: chip('all', 'Todos'), loose: chip('loose', 'Soltos') }
    this.clean = el('button', 'pf-btn pf-clean', 'Limpar vazios')
    this.clean.type = 'button'
    this.clean.title = 'Fecha os quadros soltos desta mesa que não têm nada'
    this.clean.addEventListener('click', () => {
      const keys = visibleRows(this.host.tree(), 'loose').filter(r => r.empty).map(r => r.key)
      if (keys.length) this.host.close(keys, 'empty')
    })
    head.append(title, group, el('span', 'sp'), this.clean)
    this.list = el('div', 'pf-list')
    this.list.tabIndex = 0
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', MANAGER_TITLE)
    this.list.addEventListener('keydown', ev => this.onKey(ev))
    this.element.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); this.host.exit() } })
    this.element.append(head, this.list)
    this.fit.observe(this.list)
  }

  focus(): void { this.list.focus({ preventScroll: true }) }

  /** Opens on a filter, with a row selected when given. */
  open(filter: FrameFilter, key?: string): void {
    this.filter = filter
    if (key) this.selected = key
    this.refresh()
  }

  setFilter(f: FrameFilter): void {
    if (f === this.filter) return
    this.filter = f
    this.refresh()
  }

  select(key: string | undefined): void {
    if (key === this.selected) return
    this.selected = key
    this.refresh()
  }

  /** Redraws from the core's frames (they may have changed anywhere in the window) for the desk on screen. */
  refresh(): void {
    const tree = this.host.tree()
    this.rows = visibleRows(tree, this.filter)
    if (!this.rows.some(r => r.key === this.selected)) this.selected = this.rows[0]?.key
    const loose = visibleRows(tree, 'loose')
    const withContent = loose.filter(r => !r.empty).length
    for (const [f, b] of Object.entries(this.chips) as [FrameFilter, HTMLButtonElement][]) b.setAttribute('aria-pressed', String(f === this.filter))
    this.chips.loose.textContent = withContent ? `Soltos (${withContent})` : 'Soltos'
    const empties = loose.filter(r => r.empty).length
    this.clean.disabled = empties === 0
    this.clean.hidden = empties === 0
    this.clean.textContent = `Limpar vazios (${empties})`
    this.renderList()
  }

  private renderList(): void {
    if (this.dragging) return
    const hadFocus = this.list.contains(document.activeElement)
    const out: HTMLElement[] = []
    if (this.rows.length === 0) {
      out.push(el('p', 'pf-empty', this.filter === 'loose'
        ? 'Nenhum quadro solto nesta mesa. Quando você fechar um painel que tinha algo na prancheta, o quadro dele fica aqui.'
        : 'Nenhum painel desta mesa tem algo na prancheta ainda.'))
    } else {
      const loose = this.rows.filter(r => r.loose)
      const live = this.rows.filter(r => !r.loose)
      if (loose.length) { out.push(el('div', 'pf-group', `Soltos (${loose.length})`)); for (const r of loose) out.push(this.rowEl(r)) }
      if (live.length) { if (loose.length) out.push(el('div', 'pf-group', 'Painéis')); for (const r of live) out.push(this.rowEl(r)) }
    }
    this.list.replaceChildren(...out)
    this.fitBars()
    if (hadFocus) this.list.focus({ preventScroll: true })
    // Scroll only the list: scrollIntoView would also scroll the window's own containers and push the top bar away.
    const sel = this.list.querySelector<HTMLElement>('.pf-row[aria-selected="true"]')
    if (sel) {
      const top = sel.offsetTop, bottom = top + sel.offsetHeight
      if (top < this.list.scrollTop) this.list.scrollTop = top
      else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight
    }
  }

  private rowEl(r: PanelFrameRow): HTMLElement {
    const agent = this.host.agent(r.panelId)
    const info = r.loose ? undefined : this.host.describe(r.panelId)
    const b = el('div', 'pf-row')
    b.dataset.key = r.key
    b.dataset.panel = r.panelId
    b.setAttribute('role', 'option')
    b.setAttribute('aria-selected', String(r.key === this.selected))
    b.classList.toggle('loose', r.loose)
    b.classList.toggle('focused', r.focused)
    // Line 1: kind icon, the panel's name, its kind and state, when the frame last changed.
    const kind = panelKind(r, agent, info)
    const head = el('div', 'pf-r-head')
    const ic = el('span', 'pf-r-icon')
    ic.append(icon(agent || info?.agent ? AGENT_ICON[agent?.kind ?? info?.agent ?? ''] ?? 'brand' : PANE_ICON[info?.type ?? (r.panelId.startsWith('note:') ? 'note' : 'terminal')] ?? 'app-window'))
    const name = el('span', 'pf-r-title', r.label || r.title || '(sem nome)')
    const state = panelState(agent)
    const meta = el('span', 'pf-r-kind', state ? `${kind} · ${state}` : kind)
    if (agent?.alive) meta.classList.add('live')
    const when = el('span', 'pf-r-meta', whenLabel(r.updatedAt, Date.now()))
    head.append(ic, name, meta, when)
    // Line 2: where (folder) for a live panel; origin and viability for a loose one.
    const sub = el('div', 'pf-r-sub')
    if (r.loose) {
      const v = this.host.revivable(r.key)
      sub.textContent = `solto · ${v.reason}`
      sub.classList.toggle('ok', v.ok)
    } else {
      sub.textContent = [r.focused ? 'em foco' : '', info?.cwd ?? info?.file ?? ''].filter(Boolean).join(' · ')
    }
    // Line 3: what the frame holds, to recognise the panel.
    const panes = el('div', 'pf-r-panes')
    const real = r.panes.filter(p => p.component !== 'empty')
    if (!real.length) panes.append(el('span', 'pf-r-pane dim', 'quadro vazio'))
    for (const p of real.slice(0, ROW_PANES)) {
      const pa = this.host.agent(p.id)
      const chip = el('span', 'pf-r-pane')
      chip.classList.toggle('live', !!pa?.alive)
      chip.append(icon(pa ? AGENT_ICON[pa.kind] ?? 'brand' : PANE_ICON[p.component] ?? 'app-window'), el('span', undefined, paneLabel(p, pa)))
      chip.title = p.url ?? p.file ?? paneLabel(p, pa)
      panes.append(chip)
    }
    if (real.length > ROW_PANES) panes.append(el('span', 'pf-r-pane dim', `+${real.length - ROW_PANES}`))
    b.append(head, sub, panes, this.barEl(r))
    // What the tab does, the row does. A click only selects: going to the tab is a gesture of its own.
    b.addEventListener('click', () => { this.select(r.key); this.list.focus({ preventScroll: true }) })
    b.addEventListener('dblclick', ev => { if ((ev.target as HTMLElement | null)?.closest('button')) return; this.go(r) })
    b.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.select(r.key); this.menu(r, ev.clientX, ev.clientY) })
    b.draggable = true
    b.addEventListener('dragstart', ev => {
      if ((ev.target as HTMLElement | null)?.closest('button')) { ev.preventDefault(); return }
      // A loose panel comes back on dragstart: hold the redraw so the row being dragged stays in the page.
      this.dragging = true
      const ok = r.loose ? this.host.beginLooseDrag(r.key, ev) : this.host.beginDrag(r.panelId, ev)
      if (!ok) { this.dragging = false; ev.preventDefault(); return }
      this.selected = r.key
      b.classList.add('dragging')
    })
    b.addEventListener('dragend', () => { b.classList.remove('dragging'); this.dragging = false; this.refresh() })
    return b
  }

  /**
   * The row's action bar: the menu's pinned items (highlight, primaries with labels on the left; icons on the right) and
   * the "⋯" last. Every button runs the menu's own item.
   */
  private barEl(r: PanelFrameRow): HTMLElement {
    const bar = el('div', 'pf-r-bar')
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', 'Ações do painel')
    const all = items(this.host.menuEntries(r.panelId))
    const highlight = all.find(e => e.pin === 'highlight')
    const primary = all.filter(e => e.pin === 'primary').slice(0, MAX_PRIMARY)
    // Primaries: "Trazer de volta"/"Focar guia" first, "Fechar painel…" after. Icons follow the menu's order.
    primary.sort((x, y) => Number(x.label === CLOSE_LABEL) - Number(y.label === CLOSE_LABEL))
    const icons = all.filter(e => e.pin === 'icon')
    const button = (e: MenuItem, level: 'highlight' | 'primary' | 'icon'): HTMLButtonElement => {
      const btn = el('button', `pf-act pin-${level}`)
      btn.type = 'button'
      btn.draggable = false
      btn.dataset.pin = level
      btn.dataset.label = e.label
      btn.title = e.label
      btn.setAttribute('aria-label', e.label)
      btn.disabled = !!e.disabled
      if (e.danger) btn.classList.add('danger')
      btn.append(icon(e.icon as IconName))
      if (level !== 'icon') btn.append(el('span', undefined, e.label.replace(/…$/, '')))
      btn.addEventListener('click', ev => { ev.stopPropagation(); this.select(r.key); e.run() })
      return btn
    }
    if (highlight) bar.append(button(highlight, 'highlight'))
    for (const e of primary) bar.append(button(e, 'primary'))
    bar.append(el('span', 'sp'))
    for (const e of icons) bar.append(button(e, 'icon'))
    const more = el('button', 'pf-act more')
    more.type = 'button'
    more.dataset.action = 'menu'
    more.title = 'Menu do painel'
    more.setAttribute('aria-label', 'Menu do painel')
    more.setAttribute('aria-haspopup', 'menu')
    more.draggable = false
    more.append(icon('dots-three'))
    more.addEventListener('click', ev => {
      ev.stopPropagation()
      // Measure before selecting: selecting redraws the list, and a detached button measures as the window's corner.
      const box = more.getBoundingClientRect()
      this.select(r.key)
      this.menu(r, box.left, box.bottom, this.rowOf(r.key)?.querySelector<HTMLElement>('.pf-act.more') ?? undefined)
    })
    bar.append(more)
    return bar
  }

  /**
   * The icons that do not fit leave each bar, right to left; the highlight, the primaries and the "⋯" stay.
   */
  private fitBars(): void {
    for (const bar of this.list.querySelectorAll<HTMLElement>('.pf-r-bar')) {
      const all = [...bar.querySelectorAll<HTMLElement>('.pf-act.pin-icon')]
      for (const b of all) b.hidden = false
      for (const b of all.reverse()) { if (bar.scrollWidth <= bar.clientWidth) break; b.hidden = true }
    }
  }

  private rowOf(key: string): HTMLElement | null { return this.list.querySelector<HTMLElement>(`.pf-row[data-key="${CSS.escape(key)}"]`) }

  /** The row's menu: the panel's tab menu, whether its tab is open or not. */
  private menu(r: PanelFrameRow, x: number, y: number, opener?: HTMLElement): void {
    this.host.tabMenu(r.panelId, x, y, opener)
  }

  /** To the panel's tab: a panel on screen comes up and the pad goes back to its frame; a loose one comes back. */
  private go(r: PanelFrameRow): void {
    if (r.loose) { const back = itemOf(this.host.menuEntries(r.panelId), BACK_LABEL); if (back && !back.disabled) back.run(); return }
    const focus = itemOf(this.host.menuEntries(r.panelId), FOCUS_LABEL)
    if (focus) focus.run(); else this.host.reveal(r.panelId)
    this.host.exit()
  }

  private current(): PanelFrameRow | undefined { return this.rows.find(r => r.key === this.selected) }

  private onKey(ev: KeyboardEvent): void {
    const i = this.rows.findIndex(r => r.key === this.selected)
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const next = this.rows[Math.max(0, Math.min(this.rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]
      if (next) this.select(next.key)
    } else if (ev.key === 'Enter') {
      const r = this.current()
      if (!r) return
      ev.preventDefault()
      this.go(r)
    } else if (ev.key === 'Delete') {
      const r = this.current()
      const close = r?.loose ? itemOf(this.host.menuEntries(r.panelId), CLOSE_LABEL) : undefined
      if (close) { ev.preventDefault(); close.run() }
    } else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      const r = this.current()
      if (r) {
        ev.preventDefault()
        const more = this.rowOf(r.key)?.querySelector<HTMLElement>('.pf-act.more')
        const box = more?.getBoundingClientRect()
        this.menu(r, box?.left ?? 0, box?.bottom ?? 0, more ?? undefined)
      }
    }
  }

  /** What the e2e reads. */
  snapshot(): { filter: FrameFilter; rows: { key: string; panel: string; title: string; kind: string; sub: string; loose: boolean; empty: boolean; revivable: boolean; panes: string[] }[]; selected?: string } {
    return {
      filter: this.filter,
      rows: this.rows.map(r => {
        const e = this.rowOf(r.key)
        return {
          key: r.key, panel: r.panelId, title: r.label || r.title, kind: e?.querySelector('.pf-r-kind')?.textContent ?? '', sub: e?.querySelector('.pf-r-sub')?.textContent ?? '',
          loose: r.loose, empty: r.empty, revivable: this.host.revivable(r.key).ok, panes: r.panes.filter(p => p.component !== 'empty').map(p => p.id),
        }
      }),
      ...(this.selected ? { selected: this.selected } : {}),
    }
  }

  dispose(): void { this.fit.disconnect() }
}
