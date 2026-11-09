// The chooser ("o que abrir aqui?"), one component for every place it shows: inside an empty pane (the main flow:
// the pane IS the place), as the focus-mode popup opened from a pane's ⤢ (same state, a context chip instead of
// "Onde"), and as the contextless popup (≡ "Novo painel…", the toolbar "+", the palette), which alone carries the
// "Onde" row. Three fixed bands: the search on top (palette style), the list in the middle (the only part that
// scrolls), the folder + actions at the bottom, so "Abrir" never leaves the screen. Rules in chooser-rules.ts.
// Keys: type to filter; ↑/↓ wrap; 1–9 open the item with that number as shown; Enter opens the highlighted item;
// a click on an item opens it at once; Esc clears the text, then closes the folder list, then cancels (the host
// decides what cancelling means from the pane's origin). Nothing here talks to tetherd: the host resolves the pick.
import type { Profile } from '../../src/daemon/protocol.ts'
import type { EmptyOrigin } from '../shared/empty.ts'
import { type Choice, type ChooserItem, type ChooserRow, choiceOf, chooserItems, chooserRows, effectiveFolder, escLayer, filterFolders, itemForDigit, openLabel, rowItems } from './chooser-rules.ts'
import { LEVEL_HINT, LEVEL_LABEL, PLACEMENT_LABEL, TARGETS, targetKey, type Placement, type Target } from './create.ts'
import { highlightRuns } from './fuzzy.ts'
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import { defaultOf } from './profiles.ts'
import { LEVELS } from './shortcuts.ts'
import { UNSAFE_LABEL, UNSAFE_TOOLTIP } from './panel.ts'
import type { ChooserDestination, ChooserDestinationOption, ChooserDestinations } from './ext-api.ts'
import { folderSuffix } from '../shared/tether-folder.ts'

const ICON_SET = new Set<string>(ICON_NAMES)
const iconEl = (name: string): SVGSVGElement => icon((ICON_SET.has(name) ? name : 'question') as IconName)
const PAGE = 8

export const PLACEMENT_ICON: Record<Placement, IconName> = {
  within: 'tabs', left: 'arrow-line-left', right: 'arrow-line-right', above: 'arrow-line-up', below: 'arrow-line-down',
}

export interface ChooserHost {
  profiles(): Profile[]
  /** The last profiles opened through any chooser, most recent first (ids). */
  recentProfiles(): string[]
  recentFolders(): Promise<string[]>
  pickFolder(initial?: string): Promise<string | null>
  /** "Gerenciar perfis…" / "Criar perfil…". */
  openProfiles(id?: string): void
  /** The destination choices of an item kind (the note's "Nova nota"); none for the other items. */
  destinations?(kind: string): ChooserDestinations | undefined
}

/** What travels between a pane's chooser and its focus-mode popup (and what a test reads). */
export interface ChooserState {
  query: string
  /** The highlighted item's id. */
  highlight: string | undefined
  folder: string
  /** The person edited the folder: a profile's own folder no longer replaces it. */
  touched: boolean
  where: Target
}

export interface ChooserOptions {
  mode: 'pane' | 'popup'
  /** A pane's origin decides the Cancelar button (a "+" pane has one; a laid-out pane has none) and what Esc means. */
  origin: EmptyOrigin
  folder?: string
  /** The "Onde" row (the contextless popup): the reference as its tab reads and the starting target. Absent = no row. */
  where?: { refName: string; initial: Target }
  /** The empty pane is offered as an item (the contextless popup). */
  offerEmpty?: boolean
  state?: Partial<ChooserState>
  /** The pick: resolves with an error message to show (the chooser stays), or nothing (the host replaced / added the pane). */
  onOpen(choice: Choice, cwd: string, where: Target | undefined, destination?: ChooserDestination): Promise<string | undefined>
  onCancel(): void
  /** The ⤢: open the same chooser in focus mode with this state (pane mode only). */
  onExpand?(state: ChooserState): void
}

export interface ChooserSnapshot extends ChooserState {
  busy: boolean
  error: string | undefined
  recentsOpen: boolean
  /** The ids on screen, in order, and the digit each one answers to. */
  shown: { id: string; n: number | undefined }[]
  /** The folder that applies to the highlighted item and whether it is the profile's own. */
  effectiveFolder: string
  fromProfile: boolean
  focused: boolean
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  e.append(...children)
  return e
}
const kbd = (text: string): HTMLElement => el('kbd', undefined, text)
const button = (className: string, title?: string): HTMLButtonElement => { const b = el('button', className); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title) } return b }

export class Chooser {
  readonly element: HTMLElement
  private readonly host: ChooserHost
  private readonly opts: ChooserOptions
  private readonly query: HTMLInputElement
  private readonly list: HTMLElement
  private readonly folderInput: HTMLInputElement
  private readonly folderTag: HTMLElement
  private readonly recentsBtn: HTMLButtonElement
  private readonly recentsList: HTMLUListElement
  private readonly error: HTMLElement
  private readonly go: HTMLButtonElement
  private readonly goIcon: HTMLElement
  private readonly goVerb: HTMLElement
  private readonly goName: HTMLElement
  private readonly goKbd: HTMLElement
  private readonly whereSum: HTMLButtonElement | undefined
  private readonly placements: HTMLElement | undefined
  private readonly state: ChooserState
  private rows: ChooserRow[] = []
  private items: ChooserItem[] = []
  private recentFolders: string[] = []
  private busy = false
  private errorText: string | undefined
  private recentsOpen = false
  private whereOpen = false
  private disposed = false
  private readonly dest: HTMLElement
  private readonly destChips: HTMLElement
  private readonly destNote: HTMLElement
  private readonly folderSfx: HTMLElement
  private readonly browseBtn: HTMLButtonElement
  /** The destination picked per item kind (loaded from the item's last one the first time it is highlighted). */
  private readonly destByKind = new Map<string, { id: ChooserDestination; warning?: string }>()
  private readonly destLoading = new Set<string>()
  /** A `fixed` option's folder, once asked. */
  private readonly fixedFolders = new Map<string, string>()

  constructor(host: ChooserHost, opts: ChooserOptions) {
    this.host = host
    this.opts = opts
    this.state = { query: '', highlight: undefined, folder: opts.folder ?? '', touched: false, where: opts.where?.initial ?? { level: 'pane', placement: 'within' }, ...opts.state }
    const root = el('div', 'ch')
    root.tabIndex = -1
    root.dataset.mode = opts.mode
    root.dataset.origin = opts.origin
    this.element = root

    // ---- top: the search ----
    this.query = el('input', 'ch-q')
    this.query.type = 'text'; this.query.placeholder = 'O que abrir aqui? claude, soul, bash, nota…'; this.query.autocomplete = 'off'; this.query.spellcheck = false
    this.query.setAttribute('aria-label', 'O que abrir'); this.query.setAttribute('role', 'combobox'); this.query.setAttribute('aria-expanded', 'true')
    const top = el('div', 'ch-top', iconEl('magnifying-glass'), this.query)
    if (opts.mode === 'pane' && opts.onExpand) {
      const expand = button('ib ch-expand', 'Modo foco: o mesmo seletor numa janela maior')
      expand.append(iconEl('arrows-out-simple'))
      expand.addEventListener('click', () => opts.onExpand?.(this.snapshotState()))
      top.append(expand)
    }

    // ---- middle: the list ----
    this.list = el('div', 'ch-list')
    this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', 'O que abrir')
    // The keyboard stays in the search; a folder list left open (the person was typing a folder) closes, it would cover the items.
    this.list.addEventListener('mousedown', ev => {
      if (!(ev.target as HTMLElement).closest('button')) ev.preventDefault()
      if (this.recentsOpen || document.activeElement === this.folderInput) { this.closeRecents(); this.query.focus(); this.paintFolder() }
    })
    this.list.addEventListener('click', ev => {
      const t = ev.target as HTMLElement
      if (t.closest('.ch-manage')) { this.host.openProfiles(this.host.profiles().length ? undefined : 'new'); return }
      const row = t.closest<HTMLElement>('.ch-item')
      if (!row) return
      this.state.highlight = row.dataset.id
      this.paintHighlight()
      // An item with a destination ("Nova nota") is only selected: the person checks where it goes, then the button opens it.
      if (this.destProvider()) return
      void this.open(this.highlighted())
    })
    this.list.addEventListener('mousemove', ev => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('.ch-item')
      if (row && row.dataset.id !== this.state.highlight) { this.state.highlight = row.dataset.id; this.paintHighlight() }
    })

    // ---- bottom: folder, where, actions ----
    this.error = el('div', 'ch-err'); this.error.hidden = true; this.error.setAttribute('role', 'alert')
    this.folderInput = el('input', 'ch-path-input')
    this.folderInput.type = 'text'; this.folderInput.spellcheck = false; this.folderInput.autocomplete = 'off'; this.folderInput.placeholder = 'D:\\projetos\\meu-app'
    this.folderInput.setAttribute('aria-label', 'Pasta')
    this.folderTag = el('span', 'tag', 'do perfil'); this.folderTag.title = 'A pasta própria deste perfil; edite para usar outra'
    // The grey suffix after the typed text (a destination's `.tether\\notes`): beside the text, never below it (nothing moves).
    this.folderSfx = el('span', 'ch-sfx'); this.folderSfx.hidden = true
    const path = el('div', 'ch-path', this.folderInput, this.folderSfx, this.folderTag)
    path.addEventListener('mousedown', ev => { if (ev.target === path || ev.target === this.folderSfx) { ev.preventDefault(); this.folderInput.focus() } })
    this.recentsBtn = button('ib ch-rec', 'Pastas recentes'); this.recentsBtn.setAttribute('aria-expanded', 'false'); this.recentsBtn.setAttribute('aria-haspopup', 'listbox')
    this.recentsBtn.append(iconEl('caret-down'))
    const browse = button('ib ch-browse', 'Procurar…'); browse.append(iconEl('folder-open'))
    this.browseBtn = browse
    this.recentsList = el('ul', 'ch-recents'); this.recentsList.hidden = true; this.recentsList.setAttribute('role', 'listbox'); this.recentsList.setAttribute('aria-label', 'Pastas recentes')
    const folder = el('div', 'ch-folder', iconEl('folder'), path, this.recentsBtn, browse, this.recentsList)
    folder.querySelector('svg')!.classList.add('fo')

    // The destination of a new file (only items with destinations: "Nova nota"); hidden for every other item.
    this.destChips = el('div', 'ch-dest-chips'); this.destChips.setAttribute('role', 'radiogroup'); this.destChips.setAttribute('aria-label', 'Salvar em')
    this.destNote = el('span', 'ch-dest-note'); this.destNote.hidden = true
    this.dest = el('div', 'ch-dest', el('span', 'lbl', 'Salvar em'), this.destChips, this.destNote); this.dest.hidden = true
    this.destChips.addEventListener('click', ev => {
      const chip = (ev.target as HTMLElement).closest<HTMLElement>('.ch-dest-chip')
      if (chip) this.setDest(chip.dataset.dest!)
    })

    const row = el('div', 'ch-row', this.dest, folder)
    if (opts.where) {
      this.whereSum = button('where-sum'); this.whereSum.setAttribute('aria-expanded', 'false')
      this.placements = el('div', 'placements'); this.placements.hidden = true
      row.append(el('div', 'where', el('div', 'where-line', el('span', 'lbl', 'Onde'), this.whereSum), this.placements))
      this.whereSum.addEventListener('click', () => { this.whereOpen = !this.whereOpen; this.paintWhere() })
      this.placements.addEventListener('click', ev => {
        const chip = (ev.target as HTMLElement).closest<HTMLElement>('.placement')
        if (!chip) return
        this.state.where = { level: chip.dataset.level as Target['level'], placement: chip.dataset.placement as Placement }
        this.paintWhere()
      })
    }
    const hints = el('div', 'ch-hints', el('span', undefined, kbd('↑'), kbd('↓')), el('span', undefined, kbd('1'), '–', kbd('9'), ' abre'))
    const actions = el('div', 'ch-actions', hints)
    if (opts.mode === 'popup') {
      const manage = button('ch-manage'); manage.append(iconEl('sliders-horizontal'), 'Gerenciar perfis…')
      manage.addEventListener('click', () => this.host.openProfiles())
      actions.append(manage)
    }
    actions.append(el('span', 'sp'))
    if (!(opts.mode === 'pane' && opts.origin === 'layout')) {
      const cancel = button('btn cancel'); cancel.append(el('span', 'lbl', 'Cancelar'), kbd('Esc'))
      cancel.addEventListener('click', () => this.cancel(true))
      actions.append(cancel)
    }
    this.goIcon = el('span', 'go-i'); this.goVerb = el('span', 'go-l', 'Abrir'); this.goName = el('span', 'nm'); this.goKbd = kbd('Enter')
    this.go = button('btn primary go'); this.go.append(this.goIcon, this.goVerb, ' ', this.goName, this.goKbd)
    this.go.addEventListener('click', () => { void this.open(this.highlighted()) })
    actions.append(this.go)
    row.append(actions)
    const bottom = el('div', 'ch-bottom', this.error, row)
    root.append(top, this.list, bottom)

    // ---- wiring ----
    this.query.addEventListener('input', () => { this.state.query = this.query.value; this.state.highlight = undefined; this.render() })
    this.folderInput.addEventListener('input', () => { this.state.folder = this.folderInput.value; this.state.touched = true; this.openRecents(this.folderInput.value); this.paintFolderTag(); this.paintSuffix() })
    this.folderInput.addEventListener('focus', () => { if (!this.fixedOption()) { this.folderInput.value = this.effective().folder; this.paintSuffix() } })
    this.folderInput.addEventListener('blur', () => { setTimeout(() => { if (this.disposed) return; if (!this.recentsList.contains(document.activeElement)) { this.closeRecents(); this.paintFolder() } }, 120) })
    this.folderInput.addEventListener('keydown', ev => this.onFolderKey(ev))
    this.recentsBtn.addEventListener('mousedown', ev => { ev.preventDefault(); if (this.fixedOption()) return; if (this.recentsOpen) this.closeRecents(); else { this.folderInput.focus(); this.openRecents('') } })
    this.recentsList.addEventListener('mousedown', ev => { const li = (ev.target as HTMLElement).closest<HTMLElement>('li[data-folder]'); if (!li) return; ev.preventDefault(); this.pickFolder(li.dataset.folder!) })
    browse.addEventListener('click', () => {
      const fixed = this.fixedOption()
      if (!fixed) { void this.browse(); return }
      // The settings page opens as a tab: the popup steps aside so it is not hidden behind it.
      this.destProvider()?.provider.configure(fixed.id)
      if (this.opts.mode === 'popup') this.opts.onCancel()
    })
    root.addEventListener('keydown', ev => this.onKey(ev))

    this.query.value = this.state.query
    this.render()
    void this.host.recentFolders().then(list => {
      if (this.disposed) return
      this.recentFolders = list
      // Nothing to suggest yet: the most recent folder.
      if (!this.state.folder && list[0]) { this.state.folder = list[0]; this.paintFolder() }
    })
  }

  // ---------- state ----------

  private effective(): { folder: string; fromProfile: boolean } {
    return effectiveFolder(this.highlighted(), this.state.folder, this.state.touched)
  }

  /** The highlighted item: the saved highlight when it is on screen, else the first shown (the last used / the Claude default). */
  private highlighted(): ChooserItem | undefined {
    const byId = this.state.highlight ? this.items.find(i => i.id === this.state.highlight) : undefined
    return byId ?? this.items[0]
  }

  private snapshotState(): ChooserState {
    return { ...this.state, highlight: this.highlighted()?.id }
  }

  /** Puts a state (from the popup) back: text, highlight, folder, where. */
  setState(state: Partial<ChooserState>): void {
    Object.assign(this.state, state)
    this.query.value = this.state.query
    this.render()
  }

  focus(): void {
    if (this.disposed) return
    this.query.focus()
    this.query.select()
  }

  setBusy(busy: boolean): void {
    this.busy = busy
    this.element.classList.toggle('busy', busy)
    this.list.toggleAttribute('inert', busy)
    this.paintGo()
  }

  setError(message: string | undefined): void {
    this.errorText = message
    this.error.replaceChildren()
    if (message) this.error.append(iconEl('warning'), el('span', undefined, message))
    this.error.hidden = !message
    if (message && /pasta/i.test(message)) this.folderInput.focus()
  }

  // ---------- rendering ----------

  /** The whole list (the query or the profiles changed). */
  render(): void {
    const profiles = this.host.profiles()
    const all = chooserItems(profiles, { empty: !!this.opts.offerEmpty })
    this.rows = chooserRows(all, this.state.query, this.host.recentProfiles())
    this.items = rowItems(this.rows)
    if (!this.state.highlight && !this.state.query) {
      // The initial highlight: the last used (first row) when there is history, else the Claude default.
      const recent = this.host.recentProfiles()[0]
      this.state.highlight = (recent && this.items.some(i => i.id === recent) ? recent : undefined) ?? defaultOf(profiles, 'claude')?.id
    }
    this.list.replaceChildren()
    if (this.items.length === 0) {
      const empty = el('div', 'ch-empty')
      if (profiles.length) empty.append('Nada com “', el('b', undefined, this.state.query), '”. Tente ', el('i', undefined, 'claude'), ', ', el('i', undefined, 'soul'), ', ', el('i', undefined, 'bash'), ', ', el('i', undefined, 'nota'), '…', el('br'))
      else empty.append('Nenhum perfil cadastrado: só as notas por enquanto.', el('br'))
      const manage = button('lnk ch-manage'); manage.append(iconEl('sliders-horizontal'), profiles.length ? 'Gerenciar perfis…' : 'Criar perfil…')
      empty.append(manage)
      this.list.append(empty)
    }
    for (const r of this.rows) {
      if (r.kind === 'sep') { this.list.append(el('div', `ch-sep${r.recent ? ' rec' : ''}`, iconEl(r.icon), r.label)); continue }
      this.list.append(this.renderItem(r))
    }
    this.paintHighlight()
  }

  private renderItem(r: Extract<ChooserRow, { kind: 'item' }>): HTMLElement {
    const it = r.item
    const row = el('div', `ch-item${it.unsafe ? ' unsafe' : ''}`)
    row.setAttribute('role', 'option'); row.dataset.id = it.id; row.dataset.group = it.group; row.dataset.kind = it.kind
    const name = el('span', 'ch-name')
    const label = el('span')
    for (const run of highlightRuns(it.name, r.positions)) label.append(run.hit ? el('b', undefined, run.text) : run.text)
    name.append(label)
    if (it.default) { const d = el('span', 'selo', 'padrão'); d.title = `Pré-selecionado para ${it.group === 'claude' ? 'Claude' : it.group}`; name.append(d) }
    if (r.recent && this.state.query) name.append(el('span', 'selo rec', 'recente'))
    const hint = el('span', `ch-hint${it.hintNone ? ' none' : ''}`, it.hint); hint.title = it.hint
    row.append(el('span', 'ch-i', iconEl(it.icon)), el('span', 'ch-t', name, hint))
    if (it.unsafe) { const u = el('span', 'ch-unsafe', iconEl('shield-warning'), UNSAFE_LABEL); u.title = UNSAFE_TOOLTIP; row.append(u) }
    if (r.n !== undefined) { const k = kbd(String(r.n)); k.classList.add('num'); row.append(k) }
    return row
  }

  /** The highlight moved: classes, the folder, the button; the list is not rebuilt. */
  private paintHighlight(): void {
    const cur = this.highlighted()
    for (const row of this.list.querySelectorAll<HTMLElement>('.ch-item')) {
      const on = row.dataset.id === cur?.id
      row.classList.toggle('hl', on)
      row.setAttribute('aria-selected', String(on))
      if (on) { row.scrollIntoView({ block: 'nearest' }); this.query.setAttribute('aria-activedescendant', row.id ||= `ch-opt-${cur!.id.replace(/[^\w-]/g, '_')}`) }
    }
    if (!cur) this.query.removeAttribute('aria-activedescendant')
    this.paintFolder()
    this.paintGo()
    this.paintWhere()
  }

  private paintFolder(): void {
    if (!this.fixedOption()) {
      if (document.activeElement !== this.folderInput) this.folderInput.value = this.effective().folder
      this.folderInput.title = this.effective().folder
    }
    this.paintFolderTag()
    this.paintDest()
  }

  private paintFolderTag(): void {
    this.folderTag.hidden = !this.effective().fromProfile || !!this.fixedOption()
  }

  // ---------- the destination (items with destinations only) ----------

  private destProvider(): { kind: string; provider: ChooserDestinations } | undefined {
    const cur = this.highlighted()
    const provider = cur && cur.kind !== 'profile' ? this.host.destinations?.(cur.kind) : undefined
    return cur && provider ? { kind: cur.kind, provider } : undefined
  }

  /** The option in use for the highlighted item; undefined for an item without destinations. */
  private currentOption(): ChooserDestinationOption | undefined {
    const p = this.destProvider()
    if (!p) return undefined
    const id = this.destByKind.get(p.kind)?.id
    return p.provider.options.find(o => o.id === id) ?? p.provider.options[0]
  }

  private currentDest(): ChooserDestination | undefined { return this.currentOption()?.id }

  /** The option in use when it is `fixed` (the field read only, the folder button configures). */
  private fixedOption(): ChooserDestinationOption | undefined {
    const o = this.currentOption()
    return o?.folder === 'fixed' ? o : undefined
  }

  private paintDest(): void {
    const p = this.destProvider()
    this.dest.hidden = !p
    if (p && !this.destByKind.has(p.kind) && !this.destLoading.has(p.kind)) {
      this.destLoading.add(p.kind)
      void p.provider.initial().then(r => {
        this.destLoading.delete(p.kind)
        if (this.disposed || this.destByKind.has(p.kind)) return
        this.destByKind.set(p.kind, { id: r.id, ...(r.warning ? { warning: r.warning } : {}) })
        // A remembered folder (the last "Outro") is a folder the person chose: kept as is.
        if (r.folder && !this.state.touched) { this.state.folder = r.folder; this.state.touched = true }
        this.paintFolder()
      }, () => { this.destLoading.delete(p.kind) })
    }
    const opt = this.currentOption()
    const fixed = opt?.folder === 'fixed' ? opt : undefined
    // The folder field: read only with the fixed folder, or the person's field as always.
    this.folderInput.readOnly = !!fixed
    this.folderInput.closest('.ch-folder')?.classList.toggle('ro', !!fixed)
    this.recentsBtn.hidden = !!fixed
    this.browseBtn.replaceChildren(iconEl(fixed ? 'gear-six' : 'folder-open'))
    const browseTitle = fixed ? fixed.configureTitle ?? 'Configurar' : 'Procurar…'
    this.browseBtn.title = browseTitle; this.browseBtn.setAttribute('aria-label', browseTitle)
    if (fixed && p) {
      const known = this.fixedFolders.get(fixed.id)
      this.folderInput.value = known ?? ''
      this.folderInput.title = known ?? ''
      if (known === undefined) void p.provider.fixedFolder(fixed.id).then(f => { if (this.disposed) return; this.fixedFolders.set(fixed.id, f); if (this.fixedOption()?.id === fixed.id) { this.folderInput.value = f; this.folderInput.title = f } })
    } else if (this.folderInput.readOnly === false && document.activeElement !== this.folderInput) {
      this.folderInput.value = this.effective().folder
    }
    this.paintSuffix()
    if (!p || !opt) return
    const active = document.activeElement as HTMLElement | null
    const focused = active?.classList.contains('ch-dest-chip') ? active.dataset.dest : undefined
    this.destChips.replaceChildren()
    for (const o of p.provider.options) {
      const on = o.id === opt.id
      const b = button('ch-dest-chip'); b.dataset.dest = o.id; b.textContent = o.label
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); b.tabIndex = on ? 0 : -1
      if (o.title) b.title = o.title
      this.destChips.append(b)
    }
    if (focused) this.destChips.querySelector<HTMLElement>(`[data-dest="${CSS.escape(focused)}"]`)?.focus()
    const warning = this.destByKind.get(p.kind)?.warning
    this.destNote.hidden = !warning
    this.destNote.replaceChildren(...(warning ? [iconEl('warning'), el('span', undefined, warning)] : []))
    this.destNote.title = warning ?? ''
  }

  /** The grey folders after the typed text (an `edit` option's suffix), in the separator the person types. */
  private paintSuffix(): void {
    const opt = this.currentOption()
    const text = opt?.folder === 'edit' && opt.suffix ? folderSuffix(this.folderInput.value, opt.suffix) : ''
    this.folderSfx.textContent = text
    this.folderSfx.hidden = !text
    this.folderInput.closest('.ch-path')?.classList.toggle('has-sfx', !!text)
  }

  private setDest(id: ChooserDestination): void {
    const p = this.destProvider()
    if (!p) return
    this.destByKind.set(p.kind, { id })
    this.closeRecents()
    this.paintFolder()
  }

  /** Left/right on a destination chip: the neighbour becomes the destination (a radio group). */
  private moveDest(step: number): void {
    const chips = [...this.destChips.querySelectorAll<HTMLElement>('.ch-dest-chip')]
    const i = chips.findIndex(c => c === document.activeElement)
    const next = chips[(i + step + chips.length) % chips.length]
    if (!next) return
    this.setDest(next.dataset.dest!)
    this.destChips.querySelector<HTMLElement>(`[data-dest="${CSS.escape(next.dataset.dest!)}"]`)?.focus()
  }

  private paintGo(): void {
    const cur = this.highlighted()
    const label = openLabel(cur, this.busy)
    this.go.classList.toggle('warnb', !!cur?.unsafe)
    this.go.disabled = this.busy || !cur
    this.goIcon.replaceChildren()
    if (this.busy) this.goIcon.append(el('span', 'spin'))
    else if (cur?.unsafe) this.goIcon.append(iconEl('shield-warning'))
    this.goVerb.textContent = label.verb
    this.goName.textContent = label.name
    this.goKbd.hidden = this.busy
    this.go.title = cur ? `${label.verb} ${label.name}` : ''
  }

  private paintWhere(): void {
    if (!this.whereSum || !this.placements || !this.opts.where) return
    const w = this.state.where
    const ref = this.opts.where.refName
    const text = w.placement === 'within' ? `como aba, ao lado de ${ref}`
      : w.level === 'pane' ? `${PLACEMENT_LABEL[w.placement]} de ${ref}`
      : w.level === 'frame' ? `na borda do quadro, ${PLACEMENT_LABEL[w.placement]}`
      : `num quadro novo, ${PLACEMENT_LABEL[w.placement]} da mesa`
    const caret = iconEl('caret-down'); caret.classList.add('car')
    this.whereSum.replaceChildren(iconEl(PLACEMENT_ICON[w.placement]), el('span', 'w', text), caret)
    this.whereSum.setAttribute('aria-expanded', String(this.whereOpen))
    this.whereSum.title = this.whereOpen ? 'Recolher as posições' : 'Escolher outra posição'
    this.placements.hidden = !this.whereOpen
    if (!this.whereOpen) return
    this.placements.replaceChildren()
    for (const level of LEVELS) {
      const group = el('div', 'placement-group'); group.dataset.level = level
      const head = el('span', 'placement-level', LEVEL_LABEL[level]); head.title = LEVEL_HINT[level]
      group.append(head)
      for (const t of TARGETS.filter(t => t.level === level)) {
        const chip = button('placement'); chip.dataset.level = level; chip.dataset.placement = t.placement
        chip.classList.toggle('on', targetKey(t) === targetKey(w)); chip.setAttribute('aria-pressed', String(targetKey(t) === targetKey(w)))
        chip.append(iconEl(PLACEMENT_ICON[t.placement]), PLACEMENT_LABEL[t.placement])
        group.append(chip)
      }
      group.append(el('span', 'placement-hint', LEVEL_HINT[level]))
      this.placements.append(group)
    }
  }

  // ---------- the folder list ----------

  private openRecents(filter: string): void {
    const folders = filterFolders(this.recentFolders, filter)
    // Typing a folder nothing recent resembles: no list in the way (the ▾ still opens the full list, or says there is none).
    if (folders.length === 0 && filter) { this.closeRecents(); return }
    this.recentsList.replaceChildren(el('li', 'hd', 'Pastas recentes'))
    if (folders.length === 0) this.recentsList.append(el('li', 'hd none', 'nenhuma pasta recente'))
    folders.forEach((f, i) => {
      const li = el('li', i === 0 ? 'hl' : '', iconEl('clock-counter-clockwise'), el('span', undefined, f)); li.dataset.folder = f; li.setAttribute('role', 'option'); li.title = f
      if (i === 0) li.append(el('span', 'pick', 'Enter'))
      this.recentsList.append(li)
    })
    this.recentsList.hidden = false
    this.recentsOpen = true
    this.recentsBtn.setAttribute('aria-expanded', 'true')
  }

  private closeRecents(): void {
    this.recentsList.hidden = true
    this.recentsOpen = false
    this.recentsBtn.setAttribute('aria-expanded', 'false')
  }

  private moveRecents(step: number): void {
    const lis = [...this.recentsList.querySelectorAll<HTMLElement>('li[data-folder]')]
    if (lis.length === 0) return
    let i = lis.findIndex(l => l.classList.contains('hl'))
    i = (i + step + lis.length) % lis.length
    lis.forEach((l, j) => l.classList.toggle('hl', j === i))
    lis[i]!.scrollIntoView({ block: 'nearest' })
  }

  private pickFolder(folder: string): void {
    this.state.folder = folder
    this.state.touched = true
    this.closeRecents()
    this.folderInput.value = folder
    this.paintFolder()
    this.query.focus()
  }

  private async browse(): Promise<void> {
    const picked = await this.host.pickFolder(this.effective().folder || undefined)
    if (picked && !this.disposed) this.pickFolder(picked)
  }

  private onFolderKey(ev: KeyboardEvent): void {
    switch (ev.key) {
      case 'Enter': {
        ev.preventDefault(); ev.stopPropagation()
        const hl = this.recentsList.querySelector<HTMLElement>('li.hl[data-folder]')
        if (this.recentsOpen && hl) { this.pickFolder(hl.dataset.folder!); return }
        this.closeRecents()
        void this.open(this.highlighted())
        return
      }
      case 'Escape':
        ev.preventDefault(); ev.stopPropagation()
        if (this.recentsOpen) { this.closeRecents(); return }
        this.query.focus()
        return
      case 'ArrowDown':
        ev.preventDefault(); ev.stopPropagation()
        if (this.fixedOption()) return
        if (this.recentsOpen) this.moveRecents(1); else this.openRecents(this.folderInput.value)
        return
      case 'ArrowUp':
        if (!this.recentsOpen) return
        ev.preventDefault(); ev.stopPropagation()
        this.moveRecents(-1)
        return
      case 'Tab':
        this.closeRecents()
        return
      default:
    }
  }

  // ---------- keys of the whole chooser ----------

  private move(step: number): void {
    const n = this.items.length
    if (n === 0) return
    const cur = this.highlighted()
    const i = cur ? this.items.indexOf(cur) : -1
    const next = Math.abs(step) === 1 ? (i + step + n) % n : Math.min(n - 1, Math.max(0, i + step))
    this.state.highlight = this.items[next]!.id
    this.paintHighlight()
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.target === this.folderInput) return // its own keys (onFolderKey)
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return // the app's chords
    const target = ev.target as HTMLElement
    const inSearch = target === this.query || target === this.element || target === this.list
    if (target.closest('.ch-dest-chips') && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) { ev.preventDefault(); ev.stopPropagation(); this.moveDest(ev.key === 'ArrowLeft' ? -1 : 1); return }
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); ev.stopPropagation(); this.move(1); return
      case 'ArrowUp': ev.preventDefault(); ev.stopPropagation(); this.move(-1); return
      case 'PageDown': ev.preventDefault(); ev.stopPropagation(); this.move(PAGE); return
      case 'PageUp': ev.preventDefault(); ev.stopPropagation(); this.move(-PAGE); return
      case 'Enter':
        // The focused button takes it; a destination chip is already applied, so Enter there creates.
        if (target.closest('button') && !target.closest('.go') && !target.classList.contains('ch-dest-chip')) return
        ev.preventDefault(); ev.stopPropagation()
        void this.open(this.highlighted())
        return
      case 'Escape':
        ev.preventDefault(); ev.stopPropagation()
        this.cancel(false)
        return
      default:
    }
    if (inSearch && /^[1-9]$/.test(ev.key)) {
      const item = itemForDigit(this.rows, ev.key)
      if (item) { ev.preventDefault(); ev.stopPropagation(); this.state.highlight = item.id; this.paintHighlight(); if (!this.destProvider()) void this.open(item) }
      return
    }
    // A letter typed anywhere in the chooser goes to the search.
    if (ev.key.length === 1 && target !== this.query && !target.closest('input')) this.query.focus()
  }

  /** The Esc ladder (or the Cancelar button, which skips it). */
  private cancel(direct: boolean): void {
    const layer = direct ? 'cancel' : escLayer({ query: this.state.query, recentsOpen: this.recentsOpen })
    if (layer === 'clear') { this.state.query = ''; this.query.value = ''; this.state.highlight = undefined; this.render(); return }
    if (layer === 'close-recents') { this.closeRecents(); return }
    this.opts.onCancel()
  }

  // ---------- opening ----------

  private async open(item: ChooserItem | undefined): Promise<void> {
    if (!item || this.busy || this.disposed) return
    const choice = choiceOf(item.id, this.host.profiles())
    if (!choice) { this.setError('Escolha um perfil.'); return }
    const cwd = effectiveFolder(item, this.state.folder, this.state.touched).folder.trim()
    if (choice.kind === 'profile' && !cwd) { this.setError('Informe a pasta.'); return }
    this.setError(undefined)
    this.setBusy(true)
    try {
      const error = await this.opts.onOpen(choice, cwd, this.opts.where ? this.state.where : undefined, this.currentDest())
      if (!this.disposed && error) this.setError(error)
    } finally {
      if (!this.disposed) this.setBusy(false)
    }
  }

  // ---------- tests ----------

  snapshot(): ChooserSnapshot {
    const eff = this.effective()
    return { ...this.snapshotState(), busy: this.busy, error: this.errorText, recentsOpen: this.recentsOpen, shown: this.rows.flatMap(r => (r.kind === 'item' ? [{ id: r.item.id, n: r.n }] : [])), effectiveFolder: eff.folder, fromProfile: eff.fromProfile, focused: this.element.contains(document.activeElement) }
  }

  dispose(): void {
    this.disposed = true
    this.element.remove()
  }
}
