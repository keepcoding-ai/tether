// The notes manager ("Notas"): a TAB with the map of every prancheta's note, by owner (the loose ones, each desk with its
// desk pad and its panels, the global pad), the filter Soltas / Todas, a read-only preview of the selected note, and its
// actions: Mover… (to another owner; the tabs add up), Fechar (asked inline; the toast offers Desfazer) and Limpar vazias.
// The model is app/renderer/pad-notes.ts; the notes live in the core (TetherUi.pads.notes).
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon, type IconName } from '../../app/renderer/icons.ts'
import type { ContextMenuEntry, NoteFilter, NoteRow, NoteTree } from '../../app/renderer/ext-api.ts'
import { panelNotesOnly, visibleRows, whenLabel } from '../../app/renderer/pad-notes.ts'
import { NOTES_MANAGER_TITLE } from './layouts.ts'

export interface ManagerHost {
  tree(): NoteTree
  targets(): { key: string; label: string; group: string }[]
  /** A note file's text (undefined when it cannot be read). */
  read(path: string): Promise<string | undefined>
  move(from: string, to: string): boolean
  /** Closes the notes (the toast with Desfazer is the host's). */
  close(keys: readonly string[], what: 'one' | 'empty'): void
  show(key: string): void
  menu(x: number, y: number, entries: ContextMenuEntry[]): void
  onTabMenu(id: string, ev: MouseEvent): void
  onClose(id: string): void
}

const PANE_ICON: Record<string, IconName> = { note: 'note-pencil', empty: 'square-half', terminal: 'terminal-window', 'md-preview': 'eye' }

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

/** Where the note lives, in a few words. */
export function ownerText(r: NoteRow): string {
  if (r.owner.kind === 'desk') return r.loose ? `antes na mesa ${r.label || ''}`.trim() : 'prancheta da mesa'
  if (r.owner.kind === 'global') return 'prancheta global'
  if (r.loose) return r.label ? `antes em ${r.label}` : 'painel fechado'
  return r.label
}

export class NotesManagerPanel implements IContentRenderer {
  readonly element: HTMLElement
  id = ''
  private readonly host: ManagerHost
  private filter: NoteFilter = 'loose'
  private selected: string | undefined
  private confirming = false
  private rows: NoteRow[] = []
  private previewKey = ''
  private previewText: string | undefined
  private readonly list: HTMLElement
  private readonly preview: HTMLElement
  private readonly bar: HTMLElement
  private readonly chips: Record<NoteFilter, HTMLButtonElement>
  private readonly clean: HTMLButtonElement

  constructor(host: ManagerHost) {
    this.host = host
    this.element = el('div', 'pn-pane')
    this.element.dataset.notesManager = 'pane'
    const head = el('div', 'pn-head')
    const title = el('span', 'pn-title', NOTES_MANAGER_TITLE)
    const group = el('div', 'pn-filter')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Mostrar')
    const chip = (f: NoteFilter, label: string): HTMLButtonElement => {
      const b = el('button', 'pn-chip', label)
      b.type = 'button'
      b.dataset.filter = f
      b.addEventListener('click', () => this.setFilter(f))
      group.append(b)
      return b
    }
    this.chips = { loose: chip('loose', 'Soltas'), all: chip('all', 'Todas') }
    this.clean = el('button', 'pn-btn pn-clean', 'Limpar vazias')
    this.clean.type = 'button'
    this.clean.title = 'Fecha as notas soltas que não têm nada'
    this.clean.addEventListener('click', () => {
      const keys = panelNotesOnly(this.host.tree()).loose.filter(r => r.empty).map(r => r.key)
      if (keys.length) this.host.close(keys, 'empty')
    })
    head.append(title, group, el('span', 'sp'), this.clean)
    const body = el('div', 'pn-body')
    this.list = el('div', 'pn-list')
    this.list.tabIndex = 0
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', 'Notas')
    this.list.addEventListener('keydown', ev => this.onKey(ev))
    this.preview = el('div', 'pn-preview')
    body.append(this.list, this.preview)
    this.bar = el('div', 'pn-bar')
    this.element.append(head, body, this.bar)
  }

  init(params: GroupPanelPartInitParameters): void {
    this.id = params.api.id
    this.refresh()
  }

  focus(): void { this.list.focus() }

  /** Opens on a filter, with a note selected when given. */
  open(filter: NoteFilter, key?: string): void {
    this.filter = filter
    if (key) this.selected = key
    this.confirming = false
    this.refresh()
  }

  setFilter(f: NoteFilter): void {
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

  /** Redraws from the core's notes (they may have changed anywhere in the window). */
  refresh(): void {
    const tree = panelNotesOnly(this.host.tree())
    this.rows = visibleRows(tree, this.filter)
    if (!this.rows.some(r => r.key === this.selected)) this.selected = this.rows[0]?.key
    const loose = tree.loose.filter(r => !r.empty).length
    for (const [f, b] of Object.entries(this.chips) as [NoteFilter, HTMLButtonElement][]) b.setAttribute('aria-pressed', String(f === this.filter))
    this.chips.loose.textContent = loose ? `Soltas (${loose})` : 'Soltas'
    const empties = tree.loose.filter(r => r.empty).length
    this.clean.disabled = empties === 0
    this.clean.textContent = empties ? `Limpar vazias (${empties})` : 'Limpar vazias'
    this.renderList(tree)
    this.renderPreview()
    this.renderBar()
  }

  private renderList(tree: NoteTree): void {
    const hadFocus = this.list.contains(document.activeElement)
    const out: HTMLElement[] = []
    if (this.rows.length === 0) {
      out.push(el('p', 'pn-empty', this.filter === 'loose'
        ? 'Nenhuma nota solta. Quando você fechar um painel que tinha nota na prancheta, ela aparece aqui.'
        : 'Nenhuma nota nas pranchetas ainda.'))
    } else if (this.filter === 'loose') {
      for (const r of tree.loose) out.push(this.rowEl(r))
    } else {
      if (tree.loose.length) { out.push(el('div', 'pn-group', `Soltas (${tree.loose.length})`)); for (const r of tree.loose) out.push(this.rowEl(r)) }
      const shown = new Set(this.rows.map(r => r.key))
      for (const d of tree.desks) {
        const rows = [...(d.deskPad ? [d.deskPad] : []), ...d.panels].filter(r => shown.has(r.key))
        if (!rows.length) continue
        out.push(el('div', 'pn-group', deskHeading(d.name)))
        for (const r of rows) out.push(this.rowEl(r))
      }
      const global = tree.global.filter(r => shown.has(r.key))
      if (global.length) { out.push(el('div', 'pn-group', 'Global')); for (const r of global) out.push(this.rowEl(r)) }
    }
    this.list.replaceChildren(...out)
    if (hadFocus) this.list.focus()
    this.list.querySelector<HTMLElement>('.pn-row[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  private rowEl(r: NoteRow): HTMLElement {
    const b = el('div', 'pn-row')
    b.dataset.key = r.key
    b.setAttribute('role', 'option')
    b.setAttribute('aria-selected', String(r.key === this.selected))
    b.classList.toggle('loose', r.loose)
    b.classList.toggle('empty', r.empty)
    const title = el('span', 'pn-r-title', r.empty ? '(vazia)' : r.title)
    const owner = el('span', 'pn-r-owner', ownerText(r))
    const meta: string[] = []
    if (r.tabs > 1) meta.push(`${r.tabs} abas`)
    const when = whenLabel(r.updatedAt, Date.now())
    if (when) meta.push(when)
    const right = el('span', 'pn-r-meta', meta.join(' · '))
    b.append(title, owner)
    if (r.focused) b.append(el('span', 'pn-badge', 'em foco'))
    b.append(right)
    b.addEventListener('click', () => { this.select(r.key); this.list.focus() })
    b.addEventListener('dblclick', () => { if (!r.loose) this.host.show(r.key) })
    return b
  }

  private current(): NoteRow | undefined { return this.rows.find(r => r.key === this.selected) }

  private renderPreview(): void {
    const r = this.current()
    if (!r) { this.preview.replaceChildren(el('p', 'pn-empty', 'Selecione uma nota para ver.')); this.previewKey = ''; return }
    const head = el('div', 'pn-p-head')
    head.append(el('span', 'pn-p-title', r.empty ? '(vazia)' : r.title), el('span', 'pn-p-owner', ownerText(r)))
    if (!r.loose) {
      const go = el('button', 'pn-link', 'Ir para a prancheta')
      go.type = 'button'
      go.addEventListener('click', () => this.host.show(r.key))
      head.append(go)
    }
    const tabs = el('ul', 'pn-p-tabs')
    for (const p of r.panes) {
      const li = el('li')
      li.append(icon(PANE_ICON[p.component] ?? 'app-window'), el('span', undefined, p.component === 'empty' ? 'Vazio' : p.title))
      tabs.append(li)
    }
    const file = r.panes.find(p => p.file)?.file
    const text = el('pre', 'pn-p-text')
    text.setAttribute('aria-label', 'Prévia da nota (só leitura)')
    const key = `${r.key}|${file ?? ''}`
    if (!file) text.textContent = r.empty ? 'Nada nesta nota.' : 'Sem prévia para este tipo de aba.'
    else if (key === this.previewKey && this.previewText !== undefined) text.textContent = this.previewText || '(nota em branco)'
    else {
      text.textContent = 'Carregando…'
      this.previewKey = key
      this.previewText = undefined
      void this.host.read(file).then(t => {
        if (this.previewKey !== key) return
        this.previewText = t ?? ''
        const live = this.preview.querySelector('.pn-p-text')
        if (live) live.textContent = t === undefined ? 'Não foi possível ler o arquivo.' : t || '(nota em branco)'
      })
    }
    this.preview.replaceChildren(head, tabs, text)
  }

  private renderBar(): void {
    const r = this.current()
    if (!r) { this.bar.replaceChildren(); this.bar.hidden = true; return }
    this.bar.hidden = false
    if (this.confirming) {
      const msg = el('span', 'pn-confirm', r.tabs > 0 ? 'Fechar esta nota? As abas dela fecham junto.' : 'Fechar esta nota?')
      const yes = el('button', 'pn-btn danger', 'Fechar')
      yes.type = 'button'
      yes.dataset.action = 'confirm-close'
      yes.addEventListener('click', () => { this.confirming = false; this.host.close([r.key], 'one') })
      const no = el('button', 'pn-btn', 'Cancelar')
      no.type = 'button'
      no.addEventListener('click', () => { this.confirming = false; this.renderBar(); this.list.focus() })
      this.bar.replaceChildren(msg, el('span', 'sp'), yes, no)
      requestAnimationFrame(() => yes.focus())
      return
    }
    const move = el('button', 'pn-btn', 'Mover…')
    move.type = 'button'
    move.dataset.action = 'move'
    move.disabled = r.empty
    move.title = r.empty ? 'Nada para mover' : 'Levar as abas desta nota para a prancheta de outro painel, da mesa ou global'
    move.addEventListener('click', () => { const b = move.getBoundingClientRect(); this.openMove(r, b.left, b.top) })
    const close = el('button', 'pn-btn', 'Fechar')
    close.type = 'button'
    close.dataset.action = 'close'
    close.addEventListener('click', () => { this.confirming = true; this.renderBar() })
    this.bar.replaceChildren(el('span', 'pn-sel', r.empty ? '(vazia)' : r.title), el('span', 'sp'), move, close)
  }

  private openMove(r: NoteRow, x: number, y: number): void {
    const targets = this.host.targets().filter(t => t.key !== r.key)
    const entries: ContextMenuEntry[] = []
    let group = ''
    for (const t of targets) {
      if (t.group !== group && entries.length) entries.push('sep')
      group = t.group
      entries.push({ icon: t.key.startsWith('frame-pads.panel@') ? 'push-pin' : t.group === 'Global' ? 'globe-simple' : 'clipboard-text', label: t.group === 'Global' ? t.label : `${t.group} · ${t.label}`, run: () => { this.host.move(r.key, t.key) } })
    }
    if (!entries.length) entries.push({ icon: 'x', label: 'Nenhum destino aberto', run: () => {}, disabled: true })
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
  snapshot(): { id: string; filter: NoteFilter; rows: { key: string; title: string; owner: string; loose: boolean; empty: boolean }[]; selected?: string; preview: string; confirming: boolean } {
    return {
      id: this.id, filter: this.filter, confirming: this.confirming,
      rows: this.rows.map(r => ({ key: r.key, title: r.title, owner: ownerText(r), loose: r.loose, empty: r.empty })),
      ...(this.selected ? { selected: this.selected } : {}),
      preview: this.preview.querySelector('.pn-p-text')?.textContent ?? '',
    }
  }

  dispose(): void {}
}

export class NotesManagerTab implements ITabRenderer {
  readonly element: HTMLElement
  private api: DockviewPanelApi | undefined
  private readonly host: ManagerHost

  constructor(host: ManagerHost) {
    this.host = host
    this.element = el('div', 'tether-tab notes-manager')
    const kind = el('span', 'kind'); kind.append(icon('clipboard-text'))
    const text = el('span', 'text', NOTES_MANAGER_TITLE)
    const close = el('button', 'close')
    close.title = 'Fechar'; close.setAttribute('aria-label', 'Fechar o gerenciador de notas')
    close.append(icon('x'))
    close.addEventListener('pointerdown', ev => ev.stopPropagation())
    close.addEventListener('click', ev => { ev.stopPropagation(); if (this.api) this.host.onClose(this.api.id) })
    this.element.append(kind, text, close)
    this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (this.api) this.host.onTabMenu(this.api.id, ev) })
    this.element.title = `${NOTES_MANAGER_TITLE}\nAs notas de todas as pranchetas, inclusive as soltas`
  }

  init(params: TabPartInitParameters): void {
    this.api = params.api
    this.element.dataset.slot = params.api.id
  }

  dispose(): void {}
}
