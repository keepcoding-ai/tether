// The manager of the panel pad ("Painéis da mesa"): the pad's second state (frame-pads/manager-slot.ts). Its item is the
// GUIDE: one card per pane the pad keeps (an empty pane is not a guide), grouped by the frame's owner (the panel whose
// frame it is). The owner is only a header: its name, kind and state ("Claude · rodando", "em foco", "terminal ·
// fechado"), no actions; the owner in focus first, then the other open owners, then the closed ones (panel-frames.ts
// `guideGroups`). A card does what the guide's own tab does, through its tab menu (TetherUi.panes.tabMenuEntries with
// from 'manager': "Focar guia" and "Fechar guia" before the tab's items). Click only selects; double-click and Enter
// focus the guide; Delete closes it. Dragging a card is dragging the guide's tab: dropping it elsewhere moves it out of
// the pad. A closed owner's frame is mounted (hidden) so its guides are live panes like any other.
// Right-click, the menu key and the "⋯" at the end of the card's action bar open that menu. The bar, at the card's foot,
// shows the menu items that declare a pin (MenuPin): the primaries on the left with their labels, the icons on the
// right; the icons that do not fit leave the bar (right to left), never the menu. Esc and the header's switch take the
// pad back to the frame. The model is app/renderer/panel-frames.ts; the frames live in the core (TetherUi.pads.panelFrames).
import { icon, type IconName } from '../../app/renderer/icons.ts'
import type { AgentPane, ContextMenuEntry, FrameFilter, FramePane, PaneInfo, PanelFrameRow, PanelFrameTree } from '../../app/renderer/ext-api.ts'
import { guideGroups, visibleRows, type FrameGuideGroup } from '../../app/renderer/panel-frames.ts'
import type { ManagerView } from '../frame-pads/manager-slot.ts'

export const MANAGER_TITLE = 'Painéis da mesa'

export interface ManagerHost {
  tree(): PanelFrameTree
  /** The agent a pane shows, when the pane is an agent's and lives somewhere in the window. */
  agent(paneId: string): AgentPane | undefined
  /** A live pane as the core describes it (type, folder, file, agent kind, place). */
  describe(paneId: string): PaneInfo | undefined
  /** Mounts a frame's view so its panes are live (a closed owner's frame). */
  mount(key: string): boolean
  /** The guide's tab menu (manager form) as data. */
  menuEntries(paneId: string): ContextMenuEntry[]
  /** That menu at page coordinates, by its opener. */
  tabMenu(paneId: string, x: number, y: number, opener?: HTMLElement): void
  /** Starts the guide's tab drag from the card's dragstart. */
  beginDrag(paneId: string, ev: DragEvent): boolean
  /** Whether a closed owner can come back, and the words for it. */
  revivable(key: string): { ok: boolean; reason: string }
  /** Closes loose frames (the host tells the person). */
  close(keys: readonly string[], what: 'one' | 'empty'): void
  /** The pad back to the panel's frame. */
  exit(): void
}

const PANE_ICON: Record<string, IconName> = { note: 'note-pencil', empty: 'square-half', terminal: 'terminal-window', 'md-preview': 'file-md', 'html-preview': 'file-html', 'browser-web': 'globe-simple' }
const AGENT_ICON: Record<string, IconName> = { claude: 'brand', soul: 'brand' }
/** The bar's limit of primaries. */
const MAX_PRIMARY = 2

type MenuItem = Exclude<ContextMenuEntry, 'sep'>
const items = (entries: readonly ContextMenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => e !== 'sep')
/** The item a key or gesture runs, found by what it says (the menu is the only definition). */
const itemOf = (entries: readonly ContextMenuEntry[], label: string): MenuItem | undefined => items(entries).find(e => e.label === label)
const FOCUS_LABEL = 'Focar guia'
const CLOSE_LABEL = 'Fechar guia'

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

/** The owner's state in words: "rodando"/"encerrado" for an agent, "em foco", "fechado"/"sessão encerrada". */
export function ownerState(r: PanelFrameRow, agent: AgentPane | undefined, revivable: { ok: boolean; reason: string } | undefined): string[] {
  if (r.loose) return [revivable?.reason.includes('encerrada') ? 'sessão encerrada' : 'fechado']
  return [agent ? (agent.alive ? 'rodando' : 'encerrado') : '', r.focused ? 'em foco' : ''].filter(Boolean)
}

/** A guide's name: its agent's name when it is one, else its tab's title. */
export function paneLabel(p: FramePane, agent: AgentPane | undefined): string {
  return agent?.name ?? p.title
}

/** A guide's short detail: the file it shows, its address, or its folder. */
export function paneDetail(p: FramePane, info: PaneInfo | undefined): string {
  return p.url ?? p.file ?? info?.file ?? info?.cwd ?? ''
}

export class PanelPadManager implements ManagerView {
  readonly element: HTMLElement
  private readonly host: ManagerHost
  private filter: FrameFilter = 'all'
  /** The selected card: a pane id. */
  private selected: string | undefined
  private groups: FrameGuideGroup[] = []
  /** The cards in list order (what the arrows walk). */
  private cards: { pane: FramePane; group: FrameGuideGroup }[] = []
  /** A card is being dragged: redraws wait for its dragend (removing the source would cancel the drag). */
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
    this.chips = { all: chip('all', 'Todas'), loose: chip('loose', 'De painéis fechados') }
    this.clean = el('button', 'pf-btn pf-clean', 'Limpar vazios')
    this.clean.type = 'button'
    this.clean.title = 'Fecha os quadros de painéis fechados desta mesa que não têm nada'
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

  /**
   * Opens on a filter. `key` selects the first guide of that frame (a frame key, as the toast gives it) or that guide
   * (a pane id).
   */
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

  select(paneId: string | undefined): void {
    if (paneId === this.selected) return
    this.selected = paneId
    this.refresh()
  }

  /** Redraws from the core's frames (they may have changed anywhere in the window) for the desk on screen. */
  refresh(): void {
    const tree = this.host.tree()
    const all = guideGroups(tree, 'all')
    // A closed owner's guides live only in its saved frame: mount it so they are live panes (menu, drag, close).
    for (const g of all) if (g.row.loose) this.host.mount(g.row.key)
    this.groups = this.filter === 'all' ? all : all.filter(g => g.row.loose)
    this.cards = this.groups.flatMap(group => group.guides.map(pane => ({ pane, group })))
    const byFrame = this.groups.find(g => g.row.key === this.selected)
    if (byFrame) this.selected = byFrame.guides[0]!.id
    if (!this.cards.some(c => c.pane.id === this.selected)) this.selected = this.cards[0]?.pane.id
    for (const [f, b] of Object.entries(this.chips) as [FrameFilter, HTMLButtonElement][]) b.setAttribute('aria-pressed', String(f === this.filter))
    const closedGuides = all.filter(g => g.row.loose).reduce((n, g) => n + g.guides.length, 0)
    this.chips.loose.textContent = closedGuides ? `De painéis fechados (${closedGuides})` : 'De painéis fechados'
    const empties = visibleRows(tree, 'loose').filter(r => r.empty).length
    this.clean.disabled = empties === 0
    this.clean.hidden = empties === 0
    this.clean.textContent = `Limpar vazios (${empties})`
    this.renderList()
  }

  private renderList(): void {
    if (this.dragging) return
    const hadFocus = this.list.contains(document.activeElement)
    const out: HTMLElement[] = []
    if (this.cards.length === 0) {
      out.push(el('p', 'pf-empty', this.filter === 'loose'
        ? 'Nenhuma guia de painel fechado nesta mesa. Quando você fechar um painel que tinha algo na prancheta, as guias dele ficam aqui.'
        : 'Nenhum painel desta mesa tem guias na prancheta ainda.'))
    } else {
      for (const g of this.groups) {
        out.push(this.groupEl(g))
        for (const p of g.guides) out.push(this.cardEl(p, g))
      }
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

  /** The owner's header: name, kind and state. Not selectable, no actions. */
  private groupEl(g: FrameGuideGroup): HTMLElement {
    const r = g.row
    const agent = r.loose ? undefined : this.host.agent(r.panelId)
    const info = r.loose ? undefined : this.host.describe(r.panelId)
    const h = el('div', 'pf-owner')
    h.dataset.key = r.key
    h.dataset.panel = r.panelId
    h.setAttribute('role', 'presentation')
    h.classList.toggle('loose', r.loose)
    h.classList.toggle('focused', r.focused)
    const ic = el('span', 'pf-o-icon')
    ic.append(icon(agent || info?.agent ? AGENT_ICON[agent?.kind ?? info?.agent ?? ''] ?? 'brand' : PANE_ICON[info?.type ?? (r.panelId.startsWith('note:') ? 'note' : 'terminal')] ?? 'app-window'))
    const name = el('span', 'pf-o-name', r.label || '(sem nome)')
    const state = [panelKind(r, agent, info), ...ownerState(r, agent, r.loose ? this.host.revivable(r.key) : undefined)].join(' · ')
    const meta = el('span', 'pf-o-state', state)
    if (agent?.alive) meta.classList.add('live')
    h.append(ic, name, meta)
    return h
  }

  /** A guide's card: kind icon, name, detail; the action bar at its foot. */
  private cardEl(p: FramePane, g: FrameGuideGroup): HTMLElement {
    const agent = this.host.agent(p.id)
    const info = this.host.describe(p.id)
    const b = el('div', 'pf-row')
    if (g.row.loose) b.classList.add('closed-owner')
    b.dataset.pane = p.id
    b.dataset.key = g.row.key
    b.setAttribute('role', 'option')
    b.setAttribute('aria-selected', String(p.id === this.selected))
    const head = el('div', 'pf-r-head')
    const ic = el('span', 'pf-r-icon')
    ic.append(icon(agent ? AGENT_ICON[agent.kind] ?? 'brand' : PANE_ICON[p.component] ?? 'app-window'))
    const name = el('span', 'pf-r-title', paneLabel(p, agent) || '(sem nome)')
    const detail = paneDetail(p, info)
    const sub = el('span', 'pf-r-kind', detail)
    sub.title = detail
    if (agent?.alive) name.classList.add('live')
    head.append(ic, name, sub)
    b.append(head, this.barEl(p))
    b.addEventListener('click', () => { this.select(p.id); this.list.focus({ preventScroll: true }) })
    b.addEventListener('dblclick', ev => { if ((ev.target as HTMLElement | null)?.closest('button')) return; this.go(p.id) })
    b.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.select(p.id); this.host.tabMenu(p.id, ev.clientX, ev.clientY) })
    b.draggable = true
    b.addEventListener('dragstart', ev => {
      if ((ev.target as HTMLElement | null)?.closest('button')) { ev.preventDefault(); return }
      this.dragging = true
      if (!this.host.beginDrag(p.id, ev)) { this.dragging = false; ev.preventDefault(); return }
      this.selected = p.id
      b.classList.add('dragging')
    })
    b.addEventListener('dragend', () => { b.classList.remove('dragging'); this.dragging = false; this.refresh() })
    return b
  }

  /**
   * The card's action bar: the menu's pinned items (primaries with labels on the left; icons on the right) and the "⋯"
   * last. Every button runs the menu's own item.
   */
  private barEl(p: FramePane): HTMLElement {
    const bar = el('div', 'pf-r-bar')
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', 'Ações da guia')
    const all = items(this.host.menuEntries(p.id))
    const primary = all.filter(e => e.pin === 'primary' || e.pin === 'highlight').slice(0, MAX_PRIMARY)
    // "Focar guia" first, "Fechar guia" after. Icons follow the menu's order.
    primary.sort((x, y) => Number(x.label === CLOSE_LABEL) - Number(y.label === CLOSE_LABEL))
    const icons = all.filter(e => e.pin === 'icon')
    const button = (e: MenuItem, level: 'primary' | 'icon'): HTMLButtonElement => {
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
      btn.addEventListener('click', ev => {
        ev.stopPropagation()
        this.select(p.id)
        if (e.label === FOCUS_LABEL) this.go(p.id); else e.run()
      })
      return btn
    }
    for (const e of primary) bar.append(button(e, 'primary'))
    bar.append(el('span', 'sp'))
    for (const e of icons) bar.append(button(e, 'icon'))
    const more = el('button', 'pf-act more')
    more.type = 'button'
    more.dataset.action = 'menu'
    more.title = 'Menu da guia'
    more.setAttribute('aria-label', 'Menu da guia')
    more.setAttribute('aria-haspopup', 'menu')
    more.draggable = false
    more.append(icon('dots-three'))
    more.addEventListener('click', ev => {
      ev.stopPropagation()
      // Measure before selecting: selecting redraws the list, and a detached button measures as the window's corner.
      const box = more.getBoundingClientRect()
      this.select(p.id)
      this.host.tabMenu(p.id, box.left, box.bottom, this.cardOf(p.id)?.querySelector<HTMLElement>('.pf-act.more') ?? undefined)
    })
    bar.append(more)
    return bar
  }

  /** The icons that do not fit leave each bar, right to left; the primaries and the "⋯" stay. */
  private fitBars(): void {
    for (const bar of this.list.querySelectorAll<HTMLElement>('.pf-r-bar')) {
      const all = [...bar.querySelectorAll<HTMLElement>('.pf-act.pin-icon')]
      for (const b of all) b.hidden = false
      for (const b of all.reverse()) { if (bar.scrollWidth <= bar.clientWidth) break; b.hidden = true }
    }
  }

  private cardOf(paneId: string): HTMLElement | null { return this.list.querySelector<HTMLElement>(`.pf-row[data-pane="${CSS.escape(paneId)}"]`) }

  /** "Focar guia": the guide comes to the front (its owner with it) and the pad goes back to the frame. */
  private go(paneId: string): void {
    const focus = itemOf(this.host.menuEntries(paneId), FOCUS_LABEL)
    if (!focus || focus.disabled) return
    focus.run()
    this.host.exit()
  }

  private onKey(ev: KeyboardEvent): void {
    const i = this.cards.findIndex(c => c.pane.id === this.selected)
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const next = this.cards[Math.max(0, Math.min(this.cards.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]
      if (next) this.select(next.pane.id)
    } else if (ev.key === 'Enter') {
      if (!this.selected) return
      ev.preventDefault()
      this.go(this.selected)
    } else if (ev.key === 'Delete') {
      const close = this.selected ? itemOf(this.host.menuEntries(this.selected), CLOSE_LABEL) : undefined
      if (close && !close.disabled) { ev.preventDefault(); close.run() }
    } else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      if (!this.selected) return
      ev.preventDefault()
      const more = this.cardOf(this.selected)?.querySelector<HTMLElement>('.pf-act.more')
      const box = more?.getBoundingClientRect()
      this.host.tabMenu(this.selected, box?.left ?? 0, box?.bottom ?? 0, more ?? undefined)
    }
  }

  /** What the e2e reads. */
  snapshot(): {
    filter: FrameFilter
    groups: { key: string; panel: string; name: string; state: string; loose: boolean; guides: { id: string; title: string; detail: string }[] }[]
    looseGuides: number
    selected?: string
  } {
    return {
      filter: this.filter,
      groups: this.groups.map(g => {
        const h = this.list.querySelector<HTMLElement>(`.pf-owner[data-key="${CSS.escape(g.row.key)}"]`)
        return {
          key: g.row.key, panel: g.row.panelId, name: h?.querySelector('.pf-o-name')?.textContent ?? '', state: h?.querySelector('.pf-o-state')?.textContent ?? '', loose: g.row.loose,
          guides: g.guides.map(p => { const c = this.cardOf(p.id); return { id: p.id, title: c?.querySelector('.pf-r-title')?.textContent ?? '', detail: c?.querySelector('.pf-r-kind')?.textContent ?? '' } }),
        }
      }),
      looseGuides: Number(/\((\d+)\)/.exec(this.chips.loose.textContent ?? '')?.[1] ?? 0),
      ...(this.selected ? { selected: this.selected } : {}),
    }
  }

  dispose(): void { this.fit.disconnect() }
}
