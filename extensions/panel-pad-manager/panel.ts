// The manager of the panel pad's frames ("Quadros dos painéis"): the pad's second state (frame-pads/manager-slot.ts), with
// the map of every panel's frame (the loose ones first, then each desk with its panels, then panels outside every desk),
// the filter Todos / Soltos, a read-only preview of the selected frame by the kind of its panes (a note's text; an
// agent's name, state and folder; a terminal's title and folder; a browser tab's address), and its actions: Mover… (to
// another panel's frame; the tabs add up), Fechar (asked inline, and told when a live agent is in the frame: its session
// goes on without a tab; the toast offers Desfazer) and Limpar vazios. The frame's tab bar stays above it; its switch,
// Esc and Enter on a live frame take the pad back to the frame. The model is app/renderer/panel-frames.ts; the frames
// live in the core (TetherUi.pads.panelFrames).
import { icon, type IconName } from '../../app/renderer/icons.ts'
import type { AgentPane, ContextMenuEntry, FrameFilter, FramePane, PanelFrameRow, PanelFrameTree } from '../../app/renderer/ext-api.ts'
import { visibleRows, whenLabel } from '../../app/renderer/panel-frames.ts'
import type { ManagerView } from '../frame-pads/manager-slot.ts'

export const MANAGER_TITLE = 'Quadros dos painéis'

export interface ManagerHost {
  tree(): PanelFrameTree
  targets(): { key: string; label: string; group: string }[]
  /** A note file's text (undefined when it cannot be read). */
  read(path: string): Promise<string | undefined>
  /** The agent a pane shows, when the pane is an agent's and lives somewhere in the window. */
  agent(paneId: string): AgentPane | undefined
  /** A live pane's folder. */
  cwdOf(paneId: string): string | undefined
  move(from: string, to: string): boolean
  /** Closes the frames (the toast with Desfazer is the host's). */
  close(keys: readonly string[], what: 'one' | 'empty'): void
  show(key: string): void
  menu(x: number, y: number, entries: ContextMenuEntry[]): void
  /** The pad back to the panel's frame. */
  exit(): void
}

const PANE_ICON: Record<string, IconName> = { note: 'note-pencil', empty: 'square-half', terminal: 'terminal-window', 'md-preview': 'file-md', 'browser-web': 'globe-simple' }
/** How many of a frame's panes a row shows before "+n". */
const ROW_PANES = 3

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** A desk's group heading: its name, with "Mesa" in front unless the name already says it ("Mesa 1"). */
export function deskHeading(name: string): string {
  return /^mesa\b/i.test(name) ? name : `Mesa ${name}`
}

/** Whose frame it is, in a few words. */
export function ownerText(r: PanelFrameRow): string {
  if (r.loose) return r.label ? `solto · antes em ${r.label}` : 'solto · painel fechado'
  return r.focused ? 'painel em foco' : 'painel'
}

/** The row's name: the panel's, else what the frame holds. */
export function rowTitle(r: PanelFrameRow): string {
  return r.label || r.title || '(sem nome)'
}

/** What a pane is, for the preview: "Claude", "terminal", "nota", "navegador". */
export function paneKind(p: FramePane, agent: AgentPane | undefined): string {
  if (agent) return agent.kind === 'claude' ? 'Claude' : agent.kind
  if (p.component === 'note') return 'nota'
  if (p.component === 'terminal') return 'terminal'
  if (p.component === 'browser-web') return 'navegador'
  if (p.component === 'md-preview' || p.component === 'html-preview') return 'prévia'
  if (p.component === 'empty') return 'vazio'
  return p.component
}

export class PanelPadManager implements ManagerView {
  readonly element: HTMLElement
  private readonly host: ManagerHost
  private filter: FrameFilter = 'all'
  private selected: string | undefined
  private confirming = false
  private rows: PanelFrameRow[] = []
  private previewKey = ''
  private previewText: string | undefined
  private readonly list: HTMLElement
  private readonly preview: HTMLElement
  private readonly bar: HTMLElement
  private readonly chips: Record<FrameFilter, HTMLButtonElement>
  private readonly clean: HTMLButtonElement

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
    this.clean.title = 'Fecha os quadros soltos que não têm nada'
    this.clean.addEventListener('click', () => {
      const keys = this.host.tree().loose.filter(r => r.empty).map(r => r.key)
      if (keys.length) this.host.close(keys, 'empty')
    })
    head.append(title, group, el('span', 'sp'), this.clean)
    const body = el('div', 'pf-body')
    this.list = el('div', 'pf-list')
    this.list.tabIndex = 0
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', 'Quadros dos painéis')
    this.list.addEventListener('keydown', ev => this.onKey(ev))
    this.element.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !this.confirming) { ev.preventDefault(); this.host.exit() } })
    this.preview = el('div', 'pf-preview')
    body.append(this.list, this.preview)
    this.bar = el('div', 'pf-bar')
    this.element.append(head, body, this.bar)
  }

  focus(): void { this.list.focus() }

  /** Opens on a filter, with a frame selected when given. */
  open(filter: FrameFilter, key?: string): void {
    this.filter = filter
    if (key) this.selected = key
    this.confirming = false
    this.refresh()
  }

  setFilter(f: FrameFilter): void {
    if (f === this.filter) return
    this.filter = f
    this.confirming = false
    this.refresh()
  }

  select(key: string | undefined): void {
    if (key === this.selected) return
    this.selected = key
    this.confirming = false
    this.refresh()
  }

  /** Redraws from the core's frames (they may have changed anywhere in the window). */
  refresh(): void {
    const tree = this.host.tree()
    this.rows = visibleRows(tree, this.filter)
    if (!this.rows.some(r => r.key === this.selected)) this.selected = this.rows[0]?.key
    const loose = tree.loose.filter(r => !r.empty).length
    for (const [f, b] of Object.entries(this.chips) as [FrameFilter, HTMLButtonElement][]) b.setAttribute('aria-pressed', String(f === this.filter))
    this.chips.loose.textContent = loose ? `Soltos (${loose})` : 'Soltos'
    const empties = tree.loose.filter(r => r.empty).length
    this.clean.disabled = empties === 0
    this.clean.textContent = empties ? `Limpar vazios (${empties})` : 'Limpar vazios'
    this.renderList(tree)
    this.renderPreview()
    this.renderBar()
  }

  private renderList(tree: PanelFrameTree): void {
    const hadFocus = this.list.contains(document.activeElement)
    const out: HTMLElement[] = []
    if (this.rows.length === 0) {
      out.push(el('p', 'pf-empty', this.filter === 'loose'
        ? 'Nenhum quadro solto. Quando você fechar um painel que tinha algo na prancheta, o quadro dele aparece aqui.'
        : 'Nenhum quadro com conteúdo ainda. O que você abrir na prancheta de um painel aparece aqui.'))
    } else if (this.filter === 'loose') {
      for (const r of tree.loose) out.push(this.rowEl(r))
    } else {
      if (tree.loose.length) { out.push(el('div', 'pf-group', `Soltos (${tree.loose.length})`)); for (const r of tree.loose) out.push(this.rowEl(r)) }
      const shown = new Set(this.rows.map(r => r.key))
      for (const d of tree.desks) {
        const rows = d.panels.filter(r => shown.has(r.key))
        if (!rows.length) continue
        out.push(el('div', 'pf-group', deskHeading(d.name)))
        for (const r of rows) out.push(this.rowEl(r))
      }
      const elsewhere = tree.elsewhere.filter(r => shown.has(r.key))
      if (elsewhere.length) { out.push(el('div', 'pf-group', 'Fora das mesas')); for (const r of elsewhere) out.push(this.rowEl(r)) }
    }
    this.list.replaceChildren(...out)
    if (hadFocus) this.list.focus()
    this.list.querySelector<HTMLElement>('.pf-row[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  private rowEl(r: PanelFrameRow): HTMLElement {
    const b = el('div', 'pf-row')
    b.dataset.key = r.key
    b.setAttribute('role', 'option')
    b.setAttribute('aria-selected', String(r.key === this.selected))
    b.classList.toggle('loose', r.loose)
    b.classList.toggle('empty', r.empty)
    const title = el('span', 'pf-r-title', rowTitle(r))
    const owner = el('span', 'pf-r-owner', ownerText(r))
    const when = whenLabel(r.updatedAt, Date.now())
    const right = el('span', 'pf-r-meta', when)
    const panes = el('span', 'pf-r-panes')
    const real = r.panes.filter(p => p.component !== 'empty')
    if (!real.length) panes.append(el('span', 'pf-r-pane dim', '(vazio)'))
    for (const p of real.slice(0, ROW_PANES)) {
      const agent = this.host.agent(p.id)
      const chip = el('span', 'pf-r-pane')
      chip.classList.toggle('live', !!agent?.alive)
      chip.append(icon(PANE_ICON[p.component] ?? 'app-window'), el('span', undefined, agent?.name ?? p.title))
      chip.title = paneKind(p, agent)
      panes.append(chip)
    }
    if (real.length > ROW_PANES) panes.append(el('span', 'pf-r-pane dim', `+${real.length - ROW_PANES}`))
    b.append(title, right, owner, panes)
    b.addEventListener('click', () => { this.select(r.key); this.list.focus() })
    b.addEventListener('dblclick', () => { if (!r.loose) this.host.show(r.key) })
    return b
  }

  private current(): PanelFrameRow | undefined { return this.rows.find(r => r.key === this.selected) }

  /** The live agents among a frame's panes. */
  private liveAgents(r: PanelFrameRow): AgentPane[] {
    return r.panes.map(p => this.host.agent(p.id)).filter((a): a is AgentPane => !!a?.alive)
  }

  private renderPreview(): void {
    const r = this.current()
    if (!r) { this.preview.replaceChildren(el('p', 'pf-empty', 'Selecione um quadro para ver.')); this.previewKey = ''; return }
    const head = el('div', 'pf-p-head')
    head.append(el('span', 'pf-p-title', rowTitle(r)), el('span', 'pf-p-owner', ownerText(r)))
    if (!r.loose) {
      const go = el('button', 'pf-link', 'Ir para o quadro')
      go.type = 'button'
      go.addEventListener('click', () => this.host.show(r.key))
      head.append(go)
    }
    const real = r.panes.filter(p => p.component !== 'empty')
    const list = el('ul', 'pf-p-panes')
    for (const p of real) {
      const agent = this.host.agent(p.id)
      const li = el('li')
      li.classList.toggle('live', !!agent?.alive)
      const kind = el('span', 'pf-p-kind')
      kind.append(icon(PANE_ICON[p.component] ?? 'app-window'), el('span', undefined, paneKind(p, agent)))
      const name = el('span', 'pf-p-name', agent?.name ?? p.title)
      li.append(kind, name)
      const facts: string[] = []
      if (agent) facts.push(agent.alive ? 'rodando' : 'encerrado')
      if (agent?.profile?.name) facts.push(agent.profile.name)
      const cwd = r.loose ? undefined : this.host.cwdOf(p.id)
      if (cwd) facts.push(cwd)
      if (p.url) facts.push(p.url)
      if (facts.length) li.append(el('span', 'pf-p-facts', facts.join(' · ')))
      list.append(li)
    }
    const file = real.find(p => p.file)?.file
    const text = el('pre', 'pf-p-text')
    text.setAttribute('aria-label', 'Prévia da nota (só leitura)')
    const key = `${r.key}|${file ?? ''}`
    if (!real.length) text.textContent = 'Nada neste quadro.'
    else if (!file) text.hidden = true
    else if (key === this.previewKey && this.previewText !== undefined) text.textContent = this.previewText || '(nota em branco)'
    else {
      text.textContent = 'Carregando…'
      this.previewKey = key
      this.previewText = undefined
      void this.host.read(file).then(t => {
        if (this.previewKey !== key) return
        this.previewText = t ?? ''
        const live = this.preview.querySelector('.pf-p-text')
        if (live) live.textContent = t === undefined ? 'Não foi possível ler o arquivo.' : t || '(nota em branco)'
      })
    }
    this.preview.replaceChildren(head, list, text)
  }

  private renderBar(): void {
    const r = this.current()
    if (!r) { this.bar.replaceChildren(); this.bar.hidden = true; return }
    this.bar.hidden = false
    if (this.confirming) {
      const live = this.liveAgents(r)
      const what = live.length === 0 ? (r.tabs > 0 ? 'Fechar este quadro? As abas dele fecham junto.' : 'Fechar este quadro?')
        : live.length === 1 ? `Este quadro tem ${live[0]!.name} rodando: a sessão continua viva, sem guia, na gestão de sessões. Fechar mesmo assim?`
        : `Este quadro tem ${live.length} agentes rodando: as sessões continuam vivas, sem guia, na gestão de sessões. Fechar mesmo assim?`
      const msg = el('span', 'pf-confirm', what)
      msg.classList.toggle('warn', live.length > 0)
      const yes = el('button', 'pf-btn danger', 'Fechar')
      yes.type = 'button'
      yes.dataset.action = 'confirm-close'
      yes.addEventListener('click', () => { this.confirming = false; this.host.close([r.key], 'one') })
      const no = el('button', 'pf-btn', 'Cancelar')
      no.type = 'button'
      no.addEventListener('click', () => { this.confirming = false; this.renderBar(); this.list.focus() })
      this.bar.replaceChildren(msg, el('span', 'sp'), yes, no)
      requestAnimationFrame(() => yes.focus())
      return
    }
    const move = el('button', 'pf-btn', 'Mover…')
    move.type = 'button'
    move.dataset.action = 'move'
    move.disabled = r.empty
    move.title = r.empty ? 'Nada para mover' : 'Levar as abas deste quadro para o quadro de outro painel'
    move.addEventListener('click', () => { const b = move.getBoundingClientRect(); this.openMove(r, b.left, b.top) })
    const close = el('button', 'pf-btn', 'Fechar')
    close.type = 'button'
    close.dataset.action = 'close'
    close.addEventListener('click', () => { this.confirming = true; this.renderBar() })
    this.bar.replaceChildren(el('span', 'pf-sel', rowTitle(r)), el('span', 'sp'), move, close)
  }

  private openMove(r: PanelFrameRow, x: number, y: number): void {
    const targets = this.host.targets().filter(t => t.key !== r.key)
    const entries: ContextMenuEntry[] = []
    let group = ''
    for (const t of targets) {
      if (t.group !== group && entries.length) entries.push('sep')
      group = t.group
      entries.push({ icon: 'push-pin', label: `${t.group} · ${t.label}`, run: () => { this.host.move(r.key, t.key) } })
    }
    if (!entries.length) entries.push({ icon: 'x', label: 'Nenhum painel aberto', run: () => {}, disabled: true })
    this.host.menu(x, y, entries)
  }

  private onKey(ev: KeyboardEvent): void {
    const i = this.rows.findIndex(r => r.key === this.selected)
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const next = this.rows[Math.max(0, Math.min(this.rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]
      if (next) this.select(next.key)
    } else if (ev.key === 'Enter') {
      const r = this.current()
      if (r && !r.loose) { ev.preventDefault(); this.host.show(r.key) }
    } else if (ev.key === 'Delete') {
      if (this.current()) { ev.preventDefault(); this.confirming = true; this.renderBar() }
    }
  }

  /** What the e2e reads. */
  snapshot(): { filter: FrameFilter; rows: { key: string; title: string; owner: string; loose: boolean; empty: boolean; panes: string[] }[]; selected?: string; preview: string; facts: string[]; confirming: boolean; confirmText: string } {
    return {
      filter: this.filter, confirming: this.confirming,
      rows: this.rows.map(r => ({ key: r.key, title: rowTitle(r), owner: ownerText(r), loose: r.loose, empty: r.empty, panes: r.panes.filter(p => p.component !== 'empty').map(p => p.id) })),
      ...(this.selected ? { selected: this.selected } : {}),
      preview: this.preview.querySelector('.pf-p-text')?.textContent ?? '',
      facts: [...this.preview.querySelectorAll('.pf-p-facts')].map(e => e.textContent ?? ''),
      confirmText: this.bar.querySelector('.pf-confirm')?.textContent ?? '',
    }
  }

  dispose(): void {}
}
