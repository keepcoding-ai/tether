// The Regency's one pane, `regency:main`: three columns over the model. Left: "Esperam você" and "Conversas". Centre: the
// chosen channel, the channels extension's view embedded (its members' column goes to "Neste canal" on the right). Right:
// "Neste canal" (folded: only the faces), the tree "Tether" (by desk or by agent, with a state filter, a search and the
// keyboard of a tree, roving tabindex) and the reserved "Fechadas" and "Sistema". The pane keeps its
// layout (channel, folded desks, "Neste canal" open) in its parameters, so layout.json carries it. Nothing here takes the
// focus or changes desk by itself: only a click or a key of the person does.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon } from '../../../app/renderer/icons.ts'
import type { IdentityInput } from '../../../app/renderer/agent-identity.ts'
import type { ChannelSummary } from '../../channels/daemon/requests.ts'
import type { EmbeddedChannel, EmbedOptions } from '../../channels/renderer/embed.ts'
import type { RegencyModel, StateCounts, Target, TreeFilter } from '../model.ts'
import { CLOSED_ID, TREE_FILTERS, modelSignature } from '../model.ts'
import { REGENCY_TITLE } from '../manifest.ts'
import {
  DEFAULT_LAYOUT, layoutParams, openingTab, readLayout, selectChannel, setFilter, setNarrowTab, setView, tierOf, toggleCollapsed,
  toggleMembers, toggleMode, type NarrowTab, type RegencyLayout, type RegencyMode, type RegencyView,
} from './layout-rules.ts'
import {
  el, glyph, paintConversations, paintFaces, paintReserved, paintTree, paintWaiting, targetOf, type ColumnsContext,
} from './columns.ts'
import { flatRows, paneRowKey, treeKeyStep, type FlatRow } from './tree-keys.ts'

/** What the tree is narrowed by: the folds, the state filter and the search. */
export interface TreeQuery { collapsed: readonly string[]; filter: TreeFilter; query: string }

/** What the pane asks of the extension (renderer.ts). */
/** The rows a click opens the quick view of: a pane's or an agent's line in the tree, and "Esperam você". */
const QUICK_ROWS = '[data-row="pane"][data-target], [data-row="agent"][data-target], .rg-wait[data-target]'

export interface RegencyHost {
  /** The model narrowed by `q`, and the panes counted by state before any filter (the chips). */
  view(q: TreeQuery): { model: RegencyModel; counts: StateCounts }
  /** Space on a row of the tree, a click (or Space) on a pane or an agent in "Esperam você": the one place that opens a target's quick view. */
  quickView(target: Target): void
  /** A click on a pane's or agent's row: opens its quick view; the one already in the card closes it. */
  toggleQuick(target: Target): void
  /** The id of the pane in the quick view's card right now (none: undefined). */
  quicked(): string | undefined
  /** Closes the card when the tree's quick view is in it. */
  closeQuick(): void
  /**
   * The Menu key, Shift+F10, a right click or the row's "⋯": the one place that opens the row's menu, at `at` (page
   * coordinates; by default under the row's start). The row has the keyboard and gets it back when the menu closes.
   */
  rowMenu(target: Target, anchor: HTMLElement, at?: { x: number; y: number }): void
  /** "Falar com": the agent's quick view with the keyboard in its terminal (the Regency stays). */
  talk(target: Target): void
  /** The desk's moon or sun: the core's "Hibernar mesa" / "Acordar mesa" for it; a refusal says why. */
  sleepDesk(deskId: string, wake: boolean): void
  /** A rename typed in a row was refused (the name stays as it was). */
  renameRefused(what: 'desk' | 'pane'): void
  /** The channels' list has not come yet. */
  loading(): boolean
  identity(paneId: string): IdentityInput | undefined
  lines(paneId: string): readonly string[] | undefined
  channel(id: string): ChannelSummary | undefined
  /** The open channels, for "Escolher conversa…". */
  openChannels(): readonly ChannelSummary[]
  mount(host: HTMLElement, channelId: string, opts: EmbedOptions): EmbeddedChannel | undefined
  /** Goes to a pane or an agent (its desk comes forward): a click of the person. */
  go(target: Target): void
  pickChannel(): Promise<string | undefined>
  /** The layout changed: save it with the window's layout. */
  saved(): void
  /** The Regency is the visible desk. */
  visible(): boolean
  /** The pane went (dockview disposed it). */
  gone(pane: RegencyPane): void
  /** The immersion's key as the key table shows it ('' when the person unbound it). */
  immersionKey(): string
}

/**
 * "Fechadas" starts folded, but the model folds by what `collapsed` holds: the layout keeps the opposite for it (this id in
 * `collapsed` means "open"), so a layout with no entry, an old one included, has it folded.
 */
const CLOSED_OPEN = 'closed:open'
/** How long a reopened session's new row stays in the highlight's wait, and how long the highlight lasts. */
const FRESH_WAIT_MS = 10_000
const FRESH_SHOWN_MS = 2_200

/** The phone's three places, in the bottom bar's order. */
const NARROW_PLACES: readonly { tab: NarrowTab; label: string; icon: string }[] = [
  { tab: 'waiting', label: 'Chama você', icon: 'bell' },
  { tab: 'conversation', label: 'Conversa', icon: 'chats-circle' },
  { tab: 'tether', label: 'Tether', icon: 'tree-view' },
]

const VIEWS: readonly { view: RegencyView; label: string; tip: string }[] = [
  { view: 'desk', label: 'Por mesa', tip: 'Cada mesa com as suas guias' },
  { view: 'agent', label: 'Por agente', tip: 'Cada agente com o que ele usa; cada guia uma vez só' },
]

const FILTERS: Record<TreeFilter, { label: string; tip: string }> = {
  all: { label: 'Todos', tip: 'Mostrar todas as guias' },
  waiting: { label: 'Esperam você', tip: 'Só as guias que esperam você' },
  busy: { label: 'Trabalhando', tip: 'Só as guias que estão trabalhando' },
  asleep: { label: 'Dormindo', tip: 'Só as guias e mesas que dormem' },
}

export class RegencyPane implements IContentRenderer {
  readonly element: HTMLElement
  /** The layout kept in the pane's parameters (`layout` is dockview's resize hook). */
  state: RegencyLayout = { ...DEFAULT_LAYOUT }
  private readonly host: RegencyHost
  private api: DockviewPanelApi | undefined
  private readonly waitHost = el('div', 'rg-waiting')
  private readonly convHost = el('div', 'rg-convs')
  private readonly center = el('section', 'rg-col rg-center')
  private readonly embedHost = el('div', 'rg-embed')
  /** The place the quick view docks on: the conversation under its bar, the same element whatever conversation is shown. */
  private readonly quickHost = el('div', 'rg-quick')
  private readonly closedBar = el('div', 'rg-closed-bar', 'Conversa encerrada: só leitura.')
  private readonly voidBox = el('div', 'rg-void')
  private readonly members = el('section', 'rg-members')
  private readonly membersHead = el('button', 'rg-tg rg-members-tg')
  private readonly facesHost = el('span', 'rg-faces')
  private readonly membersHost = el('div', 'rg-members-host')
  private readonly treeHost = el('div', 'rg-tree')
  private readonly reservedHost = el('div', 'rg-reserved')
  private readonly left = el('aside', 'rg-col rg-left')
  private readonly right = el('aside', 'rg-col rg-right')
  /** Immersion: the thin edges that stand for the side columns. */
  private readonly edgeLeft = el('button', 'rg-edge rg-edge-l')
  private readonly edgeCount = el('span', 'rg-edge-cnt')
  private readonly edgeRight = el('div', 'rg-edge rg-edge-r')
  /** The visible switch between "Gerir" and "Imersão" (it moves to the right edge in immersion). */
  private readonly modeBtn = el('button', 'rg-mode')
  private readonly treeHd = el('div', 'rg-hd')
  /** The phone's bottom bar: "Chama você", "Conversa", "Tether". */
  private readonly tabBar = el('nav', 'rg-tabbar')
  /** "Por mesa · Por agente", the search and the state chips: built once, only updated (a repaint never replaces them). */
  private readonly viewSeg = el('div', 'rg-seg')
  private readonly tools = el('div', 'rg-tools')
  private readonly searchInput = el('input', 'rg-search-in')
  private readonly searchClear = el('button', 'rg-search-x')
  private readonly chips = el('div', 'rg-chips')
  /** The search text: only in the open pane, never in the layout. */
  private query = ''
  /** The tree's one tab stop (roving tabindex), by row key. */
  private focusKey: string | undefined
  /** The tree's rows on screen, in order (the keyboard walks them). */
  private rows: FlatRow[] = []
  /** Paints of the columns so far (the E2E proves a repaint happened). */
  paints = 0
  /** The row whose name is being typed (its field in place of the name), by row key. */
  private renaming: string | undefined
  /** Ends the rename in course (`keep`: the typed name is kept). */
  private endRename: ((keep: boolean) => void) | undefined
  /** Watches the row menu that is up, to give the keyboard back to its row (openMenu). */
  private menuWatch: MutationObserver | undefined
  private waitingCount = 0
  /** The phone's opening tab was chosen (once, when the first model with the channels' list came). */
  private opened = false
  private embed: EmbeddedChannel | undefined
  private embedSub: { dispose(): void } | undefined
  private closedOpen = false
  /** A session just reopened from "Fechadas": its new row gets a brief highlight once the tree draws it. */
  private fresh: { id: string; until: number } | undefined
  private signature = ''
  private ro: ResizeObserver | undefined
  private disposed = false

  constructor(host: RegencyHost) {
    this.host = host
    this.element = el('div', 'rg')
    this.element.dataset.tier = 'desktop'
  }

  get id(): string | undefined { return this.api?.id }

  init(p: GroupPanelPartInitParameters): void {
    this.api = p.api
    this.state = readLayout(p.params)
    this.setShown(this.host.visible())
    this.left.setAttribute('aria-label', 'Esperam você e conversas')
    this.left.append(this.waitHost, this.convHost)
    this.center.setAttribute('aria-label', 'Conversa')
    this.embedHost.hidden = true
    this.closedBar.hidden = true
    this.quickHost.setAttribute('aria-hidden', 'true')
    this.center.append(this.closedBar, this.embedHost, this.voidBox, this.quickHost)
    this.right.setAttribute('aria-label', 'Neste canal e o Tether')
    this.membersHead.type = 'button'
    this.membersHead.dataset.action = 'members'
    this.members.append(this.membersHead, this.membersHost)
    this.modeBtn.type = 'button'
    this.modeBtn.dataset.action = 'mode'
    this.treeHd.append(el('span', 'rg-hd-t', 'Tether'), el('span', 'rg-sp'), this.viewSeg)
    this.buildTools()
    this.treeHost.setAttribute('role', 'tree')
    this.treeHost.setAttribute('aria-label', 'Tether: mesas e guias')
    this.right.append(this.members, this.treeHd, this.tools, this.treeHost, this.reservedHost)
    this.buildEdges()
    this.buildTabBar()
    this.element.append(this.left, this.edgeLeft, this.center, this.right, this.edgeRight, this.tabBar)
    paintReserved(this.reservedHost)
    this.element.addEventListener('click', ev => this.onClick(ev))
    this.element.addEventListener('keydown', ev => this.onKey(ev))
    this.element.addEventListener('dblclick', ev => this.onDoubleClick(ev))
    this.treeHost.addEventListener('focusin', ev => {
      const key = ev.target instanceof HTMLElement ? ev.target.dataset.key : undefined
      if (key && key !== this.focusKey) { this.focusKey = key; this.paintRoving() }
    })
    this.treeHost.addEventListener('contextmenu', ev => {
      if (ev.target instanceof Element && ev.target.closest('.rg-rename')) return
      const r = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-key]') : null
      const target = targetOf(r?.dataset.target)
      if (!r || !target) return
      ev.preventDefault()
      this.focusRow(r.dataset.key!)
      this.openMenu(target, r, { x: ev.clientX, y: ev.clientY })
    })
    this.ro = new ResizeObserver(() => {
      const w = this.element.clientWidth
      if (w > 0) this.element.dataset.tier = tierOf(w)
    })
    this.ro.observe(this.element)
    this.paintMode()
    this.paintTabs()
    this.paintVoid()
    this.paintMembersHead()
    this.paintTools()
  }

  /** "Por mesa" or "Por agente", kept in the layout. */
  setView(view: RegencyView): void {
    if (this.state.view === view) return
    this.setLayout(setView(this.state, view))
    this.repaint()
  }

  /** The state filter of the tree, kept in the layout. */
  setFilter(filter: TreeFilter): void {
    if (this.state.filter === filter) return
    this.setLayout(setFilter(this.state, filter))
    this.repaint()
  }

  /** The tree's search (not kept). The field is the same element before and after: its caret is untouched. */
  setQuery(query: string): void {
    if (this.searchInput.value !== query) this.searchInput.value = query
    if (this.query === query) return
    this.query = query
    this.repaint()
  }

  get searchText(): string { return this.query }

  /** The tier the pane is drawn in now (the ruler of four, by the pane's width). */
  get tier(): string { return this.element.dataset.tier ?? 'desktop' }

  /**
   * What the quick view docks on: the conversation's body under its bar (the bar's actions stay in reach), else the
   * conversation column, else the whole pane when the column is not on screen (the phone's other tabs).
   */
  quickAnchor(): HTMLElement {
    const r = this.quickHost.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? this.quickHost : this.element
  }

  /** "Gerir" or "Imersão", kept in the pane's layout. */
  setMode(mode: RegencyMode): void {
    if (this.state.mode === mode) return
    // The keyboard leaves a column that folds into an edge for the conversation, never for the page's body.
    const active = document.activeElement
    const lost = active instanceof HTMLElement && (this.left.contains(active) || this.right.contains(active))
    this.setLayout(toggleMode(this.state))
    this.paintMode()
    if (lost && mode === 'immersion') this.focus()
  }

  toggleMode(): void { this.setMode(this.state.mode === 'immersion' ? 'manage' : 'immersion') }

  /** The phone's place shown (kept in the layout as `narrowTab`). */
  setTab(tab: NarrowTab): void {
    if (this.state.narrowTab === tab) return
    this.setLayout(setNarrowTab(this.state, tab))
    this.paintTabs()
  }

  /** Paints what changed since the last paint (the model, the chosen channel, "Encerrados"). */
  paint(): void {
    if (this.disposed || !this.api) return
    this.syncCenter()
    const { model, counts } = this.host.view({ collapsed: this.modelFolds, filter: this.state.filter, query: this.query })
    const ctx = this.context()
    if (!this.opened && !ctx.loading) {
      this.opened = true
      const tab = openingTab(this.state.narrowTab, model.waiting.length)
      if (tab !== this.state.narrowTab) this.setTab(tab)
    }
    this.paintTools(counts)
    const view = this.state.view
    // The minute is in the signature while "Fechadas" shows lines: their "há 5 min" ages.
    const minute = model.closed.rows.length > 0 ? Math.floor(Date.now() / 60_000) : 0
    const sig = `${modelSignature(model)}|${this.state.channelId ?? ''}|${this.closedOpen}|${ctx.loading}|${view}|${minute}`
    if (sig === this.signature) return
    this.signature = sig
    this.paints++
    this.waitingCount = model.waiting.length
    this.paintCounts()
    const narrowed = this.state.filter !== 'all' || this.query.trim() !== ''
    // A name being typed in a row keeps its row: the tree waits (the next paint after the rename draws it whole).
    const holdTree = this.renaming !== undefined
    if (holdTree) this.signature = ''
    this.keepFocus(() => {
      paintWaiting(this.waitHost, model, ctx)
      paintConversations(this.convHost, model, ctx)
      if (holdTree) return
      paintTree(this.treeHost, model, { ...ctx, view, narrowed })
      this.rows = flatRows(model, view)
    })
    this.paintRoving()
    this.markQuick()
    this.showFresh()
    const ch = this.state.channelId ? this.host.channel(this.state.channelId) : undefined
    this.closedBar.hidden = !(ch?.closed)
    this.paintVoid()
  }

  /** What the model folds: the layout's folds, plus "Fechadas" unless the layout says it is open. */
  get modelFolds(): readonly string[] {
    const open = this.state.collapsed.includes(CLOSED_OPEN)
    return open ? this.state.collapsed : [...this.state.collapsed, CLOSED_ID]
  }

  /** "Fechadas" opened or folded, kept in the layout. */
  setClosedOpen(open: boolean): void {
    if (this.state.collapsed.includes(CLOSED_OPEN) === open) return
    this.setLayout(toggleCollapsed(this.state, CLOSED_OPEN))
    this.repaint()
  }

  /**
   * A session was reopened on `deskId` from "Fechadas": the person stays where she is, and the tree shows the new row (its desk
   * and agent group open if they were folded) with a brief highlight. Nothing takes the keyboard.
   */
  announce(slotId: string, deskId: string): void {
    let next = this.state
    for (const id of [deskId, slotId]) if (next.collapsed.includes(id)) next = toggleCollapsed(next, id)
    if (next !== this.state) this.setLayout(next)
    this.fresh = { id: slotId, until: Date.now() + FRESH_WAIT_MS }
    this.repaint()
  }

  /** The reopened session's row, once it is in the tree: highlighted for a moment (the style honours reduced motion). */
  private showFresh(): void {
    const f = this.fresh
    if (!f) return
    if (Date.now() > f.until) { this.fresh = undefined; return }
    const row = [...this.treeHost.querySelectorAll<HTMLElement>('[data-key]')].find(r => r.dataset.target === `agent:${f.id}` || r.dataset.target === `pane:${f.id}`)
    if (!row) return
    this.fresh = undefined
    row.classList.add('rg-fresh')
    row.scrollIntoView({ block: 'nearest' })
    setTimeout(() => row.classList.remove('rg-fresh'), FRESH_SHOWN_MS)
  }

  /**
   * The desk shown or not. The hidden desk's layer keeps its size, so the embedded view would take a line as read while
   * nobody sees it: hidden, the centre is out of the layout (its view has no height and marks nothing as seen).
   */
  setShown(on: boolean): void {
    this.element.classList.toggle('off', !on)
  }

  /** Chooses the channel in the centre (undefined clears it). */
  select(channelId: string | undefined): void {
    if (this.state.channelId === channelId) return
    this.setLayout(selectChannel(this.state, channelId))
    this.signature = ''
    this.paint()
  }

  /** The row being renamed now (the E2E reads it). */
  get renamingKey(): string | undefined { return this.renaming }

  /**
   * "Renomear" in a row's menu: a field in place of the row's name, with the keyboard. Enter (or leaving the field) keeps
   * the name through `commit`; Esc keeps the old one. Repaints by events leave the row alone meanwhile; once done, the
   * tree is painted again and the row (or the one now in its place) gets the keyboard back.
   */
  startRename(key: string, commit: (name: string) => boolean | Promise<boolean>, what: 'desk' | 'pane'): boolean {
    if (this.renaming !== undefined) this.endRename?.(false)
    const row = this.rowEl(key)
    const name = row?.querySelector<HTMLElement>('.rg-dn, .rg-gn, .aid-name')
    if (!row || !name) return false
    const old = name.textContent ?? ''
    const input = el('input', 'rg-rename')
    input.type = 'text'
    input.value = old
    input.spellcheck = false
    input.autocomplete = 'off'
    input.setAttribute('aria-label', what === 'desk' ? 'Novo nome da mesa' : 'Novo nome da guia')
    input.title = 'Enter grava · Esc cancela'
    const hidden = [name, ...row.querySelectorAll<HTMLElement>('.rg-sub')]
    for (const h of hidden) h.hidden = true
    ;(name.closest('.aid-view') ?? name).after(input)
    row.classList.add('rg-renaming')
    this.renaming = key
    const at = this.rows.findIndex(r => r.key === key)
    let done = false
    // `byKey`: Enter or Esc, the keyboard goes back to the row; a click elsewhere keeps the keyboard where it went.
    const end = (keep: boolean, byKey = false): void => {
      if (done) return
      done = true
      this.endRename = undefined
      const next = input.value.trim()
      // A desk needs a name; a pane's empty name gives it back its own.
      const change = keep && next !== old.trim() && (what === 'pane' || next !== '')
      const finish = (): void => {
        const back = byKey || document.activeElement === document.body || document.activeElement === input
        this.renaming = undefined
        this.repaint()
        if (back) this.focusRowNear(key, at)
      }
      if (!change) { finish(); return }
      void Promise.resolve(commit(next)).catch(() => false).then(ok => {
        finish()
        if (!ok) this.host.renameRefused(what)
      })
    }
    this.endRename = end
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); end(true, true) }
      else if (ev.key === 'Escape') { ev.preventDefault(); end(false, true) }
    })
    input.addEventListener('blur', () => end(true))
    input.addEventListener('click', ev => ev.stopPropagation())
    input.focus()
    input.select()
    return true
  }

  /**
   * "O que <agente> tem": the view by agent, with the agent's group open and the keyboard on it. The person asked for it:
   * a search or a filter that would hide the group is cleared.
   */
  showAgent(paneId: string): void {
    const key = paneRowKey({ kind: 'agent', id: paneId })
    let next = this.state.view === 'agent' ? this.state : setView(this.state, 'agent')
    if (next.collapsed.includes(paneId)) next = toggleCollapsed(next, paneId)
    if (next !== this.state) this.setLayout(next)
    this.repaint()
    if (!this.rowEl(key) && (this.query !== '' || this.state.filter !== 'all')) {
      this.query = ''
      this.searchInput.value = ''
      if (this.state.filter !== 'all') this.setLayout(setFilter(this.state, 'all'))
      this.repaint()
    }
    this.focusRow(key)
  }

  focus(): void {
    if (this.embed) this.embed.focus()
    else this.element.querySelector<HTMLElement>('[data-target]')?.focus({ preventScroll: true })
  }

  dispose(): void {
    this.disposed = true
    this.ro?.disconnect()
    this.menuWatch?.disconnect()
    this.dropEmbed()
    this.host.gone(this)
  }

  /** Immersion's edges: the left keeps who waits (and lights when someone does); the right keeps "Neste canal" and the tether. */
  private buildEdges(): void {
    this.edgeLeft.type = 'button'
    this.edgeLeft.dataset.action = 'manage'
    this.edgeLeft.title = 'Esperam você · voltar a Gerir'
    const pill = el('span', 'rg-edge-pill')
    pill.append(this.edgeCount, el('span', 'rg-edge-pt', 'esperam você'))
    this.edgeLeft.append(glyph('bell', 'Esperam você'), pill)
    this.edgeRight.dataset.action = 'manage'
    this.edgeRight.title = 'Voltar a Gerir'
    const to = (action: string, name: string, tip: string): HTMLButtonElement => {
      const b = el('button', 'rg-edge-b')
      b.type = 'button'
      b.dataset.action = action
      b.title = tip
      b.setAttribute('aria-label', tip)
      b.append(glyph(name, tip))
      return b
    }
    this.edgeRight.append(to('manage-members', 'robot', 'Neste canal'), to('manage-tether', 'tree-view', 'Tether'))
  }

  /** The tree's tools: the view's switch (in the heading), the search field and the state chips. */
  private buildTools(): void {
    this.viewSeg.setAttribute('role', 'radiogroup')
    this.viewSeg.setAttribute('aria-label', 'Organizar o Tether')
    for (const v of VIEWS) {
      const b = el('button', 'rg-seg-b', v.label)
      b.type = 'button'
      b.dataset.action = `view:${v.view}`
      b.dataset.view = v.view
      b.title = v.tip
      b.setAttribute('role', 'radio')
      this.viewSeg.append(b)
    }
    const search = el('div', 'rg-search')
    this.searchInput.type = 'search'
    this.searchInput.placeholder = 'Buscar guia, agente ou mesa…'
    this.searchInput.setAttribute('aria-label', 'Buscar no Tether')
    this.searchInput.spellcheck = false
    this.searchInput.autocomplete = 'off'
    this.searchInput.addEventListener('input', () => {
      if (this.query === this.searchInput.value) return
      this.query = this.searchInput.value
      this.repaint()
    })
    this.searchClear.type = 'button'
    this.searchClear.dataset.action = 'clear-search'
    this.searchClear.title = 'Limpar a busca'
    this.searchClear.setAttribute('aria-label', 'Limpar a busca')
    this.searchClear.append(glyph('x', 'Limpar a busca'))
    search.append(glyph('magnifying-glass', 'Buscar'), this.searchInput, this.searchClear)
    this.chips.setAttribute('role', 'radiogroup')
    this.chips.setAttribute('aria-label', 'Filtrar por estado')
    for (const f of TREE_FILTERS) {
      const c = el('button', 'rg-chip')
      c.type = 'button'
      c.dataset.action = `filter:${f}`
      c.dataset.filter = f
      c.title = FILTERS[f].tip
      c.setAttribute('role', 'radio')
      c.append(el('span', 'rg-chip-t', FILTERS[f].label), el('span', 'rg-chip-n'))
      this.chips.append(c)
    }
    this.tools.append(search, this.chips)
  }

  /** The tools follow the layout and the counts in place: the field keeps its text, caret and focus. */
  private paintTools(counts?: StateCounts): void {
    for (const b of this.viewSeg.querySelectorAll<HTMLElement>('.rg-seg-b')) b.setAttribute('aria-checked', String(b.dataset.view === this.state.view))
    this.searchClear.hidden = this.query === ''
    for (const c of this.chips.querySelectorAll<HTMLElement>('.rg-chip')) {
      const f = c.dataset.filter as TreeFilter
      c.setAttribute('aria-checked', String(f === this.state.filter))
      if (!counts) continue
      const n = counts[f]
      const cnt = c.querySelector<HTMLElement>('.rg-chip-n')!
      if (cnt.textContent !== String(n)) cnt.textContent = String(n)
      // The orange only on "Esperam você", and only while someone does.
      c.classList.toggle('al', f === 'waiting' && n > 0)
    }
  }

  /** One row of the tree is in the tab order: the focused one, else the first. */
  private paintRoving(): void {
    const rows = [...this.treeHost.querySelectorAll<HTMLElement>('[data-key]')]
    const stop = rows.find(r => r.dataset.key === this.focusKey) ?? rows[0]
    for (const r of rows) {
      const t = r === stop ? 0 : -1
      if (r.tabIndex !== t) r.tabIndex = t
    }
  }

  private rowEl(key: string): HTMLElement | undefined {
    return [...this.treeHost.querySelectorAll<HTMLElement>('[data-key]')].find(r => r.dataset.key === key)
  }

  /** Moves the tree's keyboard to a row (a key of the person: never called by an event). */
  private focusRow(key: string): void {
    this.focusKey = key
    this.paintRoving()
    const r = this.rowEl(key)
    if (!r) return
    r.focus({ preventScroll: true })
    r.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Opens a row's menu (host.rowMenu) and watches it: the menu gives the keyboard back to the row it was opened on, but a
   * repaint by an event may have replaced that row meanwhile. Once no menu is up, a keyboard left on the page's body (and
   * only then: nothing else is taken) goes to the row by its key, or to the row now at its place.
   */
  openMenu(target: Target, row: HTMLElement, at?: { x: number; y: number }): void {
    // The head of "Fechadas" has no menu (it folds).
    if (target.kind === 'session' && target.id === CLOSED_ID) return
    const key = row.dataset.key
    this.host.rowMenu(target, row, at)
    this.menuWatch?.disconnect()
    this.menuWatch = undefined
    if (!key || !document.getElementById('ctx-menu')) return
    const index = this.rows.findIndex(r => r.key === key)
    // After the picked row ran (and the core gave the keyboard back where it could) and after the repaint it caused. A row
    // that asked in a dialog ("Fechar guia", "Mover…") is checked again when its dialog closes.
    const settle = (): void => {
      requestAnimationFrame(() => {
        if (this.disposed || !this.host.visible()) return
        const active = document.activeElement
        const dialog = active instanceof HTMLElement ? active.closest('dialog') : null
        if (dialog?.open) { dialog.addEventListener('close', settle, { once: true }); return }
        if (active === document.body) this.focusRowNear(key, index)
      })
    }
    const watch = new MutationObserver(() => {
      if (document.getElementById('ctx-menu')) return
      watch.disconnect()
      if (this.menuWatch === watch) this.menuWatch = undefined
      settle()
    })
    watch.observe(document.body, { childList: true })
    this.menuWatch = watch
  }

  /** After a gesture of the person on a row: the keyboard back to it, or to the row now at its place when it went. */
  private focusRowNear(key: string, at: number): void {
    if (this.rowEl(key)) { this.focusRow(key); return }
    const near = this.rows[Math.min(Math.max(at, 0), this.rows.length - 1)]
    if (near) this.focusRow(near.key)
  }

  /** Opens or folds a desk or a group (`open` is the state asked for). */
  private fold(foldId: string, open: boolean): void {
    if (foldId === CLOSED_ID) { this.setClosedOpen(open); return }
    if (this.state.collapsed.includes(foldId) === !open) return
    this.setLayout(toggleCollapsed(this.state, foldId))
    this.repaint()
  }

  private repaint(): void {
    this.signature = ''
    this.paint()
  }

  private buildTabBar(): void {
    this.tabBar.setAttribute('role', 'tablist')
    this.tabBar.setAttribute('aria-label', 'Regência')
    for (const p of NARROW_PLACES) {
      const b = el('button', 'rg-tab')
      b.type = 'button'
      b.dataset.action = `tab:${p.tab}`
      b.dataset.tab = p.tab
      b.setAttribute('role', 'tab')
      b.append(glyph(p.icon, p.label), el('span', 'rg-tab-t', p.label))
      if (p.tab === 'waiting') b.append(el('span', 'cnt rg-tab-cnt'))
      this.tabBar.append(b)
    }
  }

  /** The mode on the element, the switch's look and where it sits (the tree's heading, or the right edge in immersion). */
  private paintMode(): void {
    const imm = this.state.mode === 'immersion'
    this.element.dataset.mode = this.state.mode
    const key = this.host.immersionKey()
    const tip = imm ? 'Voltar a Gerir' : 'Imersão: só a conversa'
    this.modeBtn.title = key ? `${tip} (${key})` : tip
    this.modeBtn.setAttribute('aria-label', tip)
    this.modeBtn.setAttribute('aria-pressed', String(imm))
    this.modeBtn.replaceChildren(glyph(imm ? 'columns' : 'arrows-out-simple', tip))
    if (imm) this.edgeRight.prepend(this.modeBtn)
    else this.treeHd.append(this.modeBtn)
  }

  private paintTabs(): void {
    this.element.dataset.tab = this.state.narrowTab
    for (const b of this.tabBar.querySelectorAll<HTMLElement>('.rg-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === this.state.narrowTab))
  }

  /** The count of who waits, on the left edge and on the phone's "Chama você". */
  private paintCounts(): void {
    const n = this.waitingCount
    const text = n > 0 ? String(n) : ''
    this.edgeCount.textContent = text
    this.edgeLeft.classList.toggle('lit', n > 0)
    this.edgeLeft.setAttribute('aria-label', n > 0 ? `${n} esperam você · voltar a Gerir` : 'Ninguém espera você · voltar a Gerir')
    const cnt = this.tabBar.querySelector<HTMLElement>('.rg-tab-cnt')
    if (cnt) { cnt.textContent = text; cnt.hidden = n === 0; cnt.title = `${n} esperando você` }
  }

  private context(): ColumnsContext {
    return {
      identity: id => this.host.identity(id),
      lines: id => this.host.lines(id),
      selected: this.state.channelId,
      closedOpen: this.closedOpen,
      loading: this.host.loading(),
    }
  }

  private setLayout(next: RegencyLayout): void {
    this.state = next
    // dockview merges the parameters: a cleared channel is written as undefined, which the file leaves out.
    this.api?.updateParameters({ channelId: undefined, ...layoutParams(next) })
    this.host.saved()
  }

  /** The centre follows the chosen channel: one embedded view at a time, its members in "Neste canal". */
  private syncCenter(): void {
    const want = this.state.channelId
    if (this.embed && this.embed.channelId === want) return
    this.dropEmbed()
    if (want) {
      this.embed = this.host.mount(this.embedHost, want, { membersHost: this.membersHost })
      this.embedSub = this.embed?.onDidChangeMembers(() => this.paintMembersHead())
    }
    this.embedHost.hidden = !this.embed
    this.paintMembersHead()
    this.paintVoid()
  }

  private dropEmbed(): void {
    this.embedSub?.dispose()
    this.embedSub = undefined
    this.embed?.dispose()
    this.embed = undefined
  }

  /** No channel in the centre: a sentence and the way to choose or create one. */
  private paintVoid(): void {
    this.voidBox.hidden = !!this.embed
    if (this.embed) return
    const open = this.host.openChannels()
    const box: HTMLElement[] = [glyph('chats-circle', 'Conversa')]
    if (open.length > 0) {
      box.push(el('p', 'rg-void-t', 'Escolha uma conversa à esquerda para acompanhar aqui.'))
      const pick = el('button', 'rg-btn')
      pick.type = 'button'
      pick.dataset.action = 'choose'
      pick.textContent = 'Escolher conversa…'
      box.push(pick)
    } else {
      box.push(el('p', 'rg-void-t', this.host.loading() ? 'Carregando as conversas…' : 'Nenhuma conversa ainda.'))
    }
    box.push(el('p', 'rg-void-s', 'Para criar um canal, use "Canais: Criar canal…" na paleta de comandos.'))
    this.voidBox.replaceChildren(...box)
  }

  /** "Neste canal": the toggle with the count, the faces while folded; the members' column while open. */
  private paintMembersHead(): void {
    const list = this.embed?.members() ?? []
    this.members.hidden = !this.embed
    this.members.dataset.open = String(this.state.membersOpen)
    const open = this.state.membersOpen
    this.membersHead.setAttribute('aria-expanded', String(open))
    this.membersHead.title = open ? 'Recolher os participantes' : 'Mostrar os participantes'
    this.membersHead.replaceChildren(glyph(open ? 'caret-down' : 'caret-right', open ? 'Recolher' : 'Mostrar'), el('span', 'rg-hd-t', `Neste canal · ${list.length}`), this.facesHost)
    this.facesHost.hidden = open
    if (!open) paintFaces(this.facesHost, list, this.context())
    this.membersHost.hidden = !open
  }

  /**
   * A repaint replaces the rows: the focused one is found again in the same list (the tree by its row key, the others by
   * target) and gets the keyboard back; a tree row that went leaves it on the row now in its place. The columns' scroll is
   * kept. The tools are never replaced, so the search field keeps its text, caret and focus by itself.
   */
  private keepFocus(paint: () => void): void {
    const active = document.activeElement
    const within = active instanceof HTMLElement && this.element.contains(active) ? active : undefined
    // A row's button with the keyboard counts as its row (the row is what comes back).
    const inside = within?.closest<HTMLElement>('.rg-tree [data-key]') ?? within
    const list = inside ? [this.waitHost, this.convHost, this.treeHost].find(h => h.contains(inside)) : undefined
    const key = inside?.dataset.key
    const target = inside?.dataset.target
    const at = list === this.treeHost && key ? [...this.treeHost.querySelectorAll('[data-key]')].indexOf(inside!) : -1
    const scroll = [this.left.scrollTop, this.right.scrollTop] as const
    paint()
    if (this.left.scrollTop !== scroll[0]) this.left.scrollTop = scroll[0]
    if (this.right.scrollTop !== scroll[1]) this.right.scrollTop = scroll[1]
    if (!inside || !list || inside.isConnected || (!key && !target)) return
    // Only when the keyboard fell to the page's body with the row it was on: nothing else is ever taken.
    if (document.activeElement && document.activeElement !== document.body) return
    let again: HTMLElement | undefined
    if (list === this.treeHost) {
      const rows = [...this.treeHost.querySelectorAll<HTMLElement>('[data-key]')]
      again = rows.find(r => r.dataset.key === key) ?? (at >= 0 ? rows[Math.min(at, rows.length - 1)] : undefined)
      if (again) this.focusKey = again.dataset.key
    } else {
      again = [...list.querySelectorAll<HTMLElement>('[data-target]')].find(e => e.dataset.target === target)
    }
    again?.focus({ preventScroll: true })
  }

  private onClick(ev: MouseEvent): void {
    const t = ev.target instanceof Element ? ev.target : null
    if (!t || t.closest('.rg-center') && !t.closest('[data-action="choose"]')) return
    if (t.closest('.rg-members-host') || t.closest('.rg-rename')) return
    const button = t.closest<HTMLElement>('[data-action]')
    const action = button?.dataset.action
    if (button && action?.startsWith('row-')) { this.rowAct(action, button); return }
    if (action) { this.act(action); return }
    const row = t.closest<HTMLElement>('[data-target]')
    // The second click of a double click is the dblclick's (it goes to the tab): it must not close the card the first opened.
    if (row && ev.detail > 1 && row.matches(QUICK_ROWS) && !t.closest('.rg-caret')) return
    if (row) this.activate(row, t.closest('.rg-caret') !== null)
  }

  private onKey(ev: KeyboardEvent): void {
    const t = ev.target instanceof HTMLElement ? ev.target : null
    if (!t || t.closest('.rg-center')) return
    if (t === this.searchInput) { this.onSearchKey(ev); return }
    if (t.dataset.key && this.treeHost.contains(t)) { this.onTreeKey(ev, t); return }
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    if (!t.dataset.target) return
    ev.preventDefault()
    this.activate(t, false, ev.key === 'Enter')
  }

  /** The tree's keys, by the pure rule (tree-keys.ts). */
  private onTreeKey(ev: KeyboardEvent, row: HTMLElement): void {
    const step = treeKeyStep(this.rows, row.dataset.key, ev, { query: this.query, filter: this.state.filter })
    if (!step) return
    ev.preventDefault()
    ev.stopPropagation()
    switch (step.type) {
      case 'focus': this.focusRow(step.key); break
      case 'toggle': this.focusKey = step.key; this.fold(step.foldId, step.open); break
      case 'quick': this.host.quickView(step.target); break
      case 'go': this.host.go(step.target); break
      case 'menu': this.openMenu(step.target, row); break
      case 'clear-search': this.setQuery(''); break
      case 'clear-filter': this.setFilter('all'); break
    }
  }

  /** In the field: Esc clears it (empty, the filter); Down and Enter go into the tree. */
  private onSearchKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return
    if (ev.key === 'Escape') {
      if (this.query !== '') this.setQuery('')
      else if (this.state.filter !== 'all') this.setFilter('all')
      else return
      ev.preventDefault()
      ev.stopPropagation()
    } else if (ev.key === 'ArrowDown' || ev.key === 'Enter') {
      const first = this.rows[0]
      if (!first) return
      ev.preventDefault()
      this.focusRow(first.key)
    }
  }

  /** A button of a row's `.rg-acts`: it acts on the row's target and never folds the row nor goes to it. */
  private rowAct(action: string, button: HTMLElement): void {
    const row = button.closest<HTMLElement>('[data-key]')
    const target = targetOf(row?.dataset.target)
    if (!row || !target) return
    this.focusRow(row.dataset.key!)
    if (action === 'row-menu') {
      const r = button.getBoundingClientRect()
      this.openMenu(target, row, { x: Math.round(r.left), y: Math.round(r.bottom + 2) })
    } else if (action === 'row-talk') this.host.talk(target)
    else if ((action === 'row-sleep' || action === 'row-wake') && target.kind === 'desk') this.host.sleepDesk(target.id, action === 'row-wake')
  }

  private act(action: string): void {
    if (action.startsWith('tab:')) { this.setTab(action.slice(4) as NarrowTab); return }
    if (action === 'mode') { this.toggleMode(); return }
    if (action === 'manage' || action === 'manage-members' || action === 'manage-tether') {
      this.setMode('manage')
      if (action === 'manage-members' && !this.state.membersOpen && this.embed) { this.setLayout(toggleMembers(this.state)); this.paintMembersHead() }
      if (action === 'manage-tether') this.treeHost.querySelector<HTMLElement>('[data-key][tabindex="0"]')?.focus({ preventScroll: true })
      return
    }
    if (action.startsWith('view:')) { this.setView(action.slice(5) === 'agent' ? 'agent' : 'desk'); return }
    if (action.startsWith('filter:')) { this.setFilter(TREE_FILTERS.find(f => f === action.slice(7)) ?? 'all'); return }
    if (action === 'clear-search') { this.setQuery(''); this.searchInput.focus(); return }
    if (action === 'clear-narrow') {
      // The button goes with the empty state: the keyboard goes to the field.
      this.searchInput.focus({ preventScroll: true })
      this.query = ''
      this.searchInput.value = ''
      this.setLayout(setFilter(this.state, 'all'))
      this.repaint()
      return
    }
    if (action === 'closed') { this.closedOpen = !this.closedOpen; this.signature = ''; this.paint() }
    else if (action === 'members') { this.setLayout(toggleMembers(this.state)); this.paintMembersHead() }
    else if (action === 'choose') void this.host.pickChannel().then(id => { if (id) this.select(id) })
  }

  /** A click (or Space) on a row; `byEnter`: Enter, which goes to the target where a click on "Esperam você" only spies it. */
  private activate(row: HTMLElement, onCaret = false, byEnter = false): void {
    if (row.dataset.key) this.focusKey = row.dataset.key
    // A desk or "Você" folds; an agent's line goes to its pane and folds only by its caret.
    if (row.dataset.row === 'closed-head') { this.setClosedOpen(row.getAttribute('aria-expanded') !== 'true'); return }
    const folds = row.dataset.row === 'desk' || row.dataset.row === 'group' || (row.dataset.row === 'agent' && onCaret)
    if (folds && row.dataset.fold) {
      this.setLayout(toggleCollapsed(this.state, row.dataset.fold))
      this.repaint()
      return
    }
    const target = targetOf(row.dataset.target)
    if (!target) return
    if (target.kind === 'channel') {
      this.select(target.id)
      // On the phone, choosing a conversation takes the person to it.
      if (this.tier === 'mobile') this.setTab('conversation')
    }
    else if (target.kind === 'desk') { this.setLayout(toggleCollapsed(this.state, target.id)); this.signature = ''; this.paint() }
    // An ended session has nowhere to go: its row opens its menu (reopen, forget).
    else if (target.kind === 'session') this.openMenu(target, row)
    // A pane or an agent: the click is the quick view over the conversation (the person stays here); Enter goes to the tab.
    else if (!byEnter && (target.kind === 'pane' || target.kind === 'agent')) this.host.toggleQuick(target)
    else this.host.go(target)
  }

  /** Marks the row whose pane is in the quick view's card (class and `aria-current`); no card, no mark. */
  markQuick(): void {
    const id = this.host.quicked()
    for (const r of this.element.querySelectorAll<HTMLElement>(QUICK_ROWS)) {
      const on = id !== undefined && targetOf(r.dataset.target)?.id === id
      r.classList.toggle('rg-peeked', on)
      if (on) r.setAttribute('aria-current', 'true')
      else r.removeAttribute('aria-current')
    }
  }

  /** A double click on a row of a pane or agent: the card closes and the person goes to the tab. */
  private onDoubleClick(ev: MouseEvent): void {
    const t = ev.target instanceof Element ? ev.target : null
    if (!t || t.closest('.rg-center') || t.closest('.rg-acts') || t.closest('.rg-rename') || t.closest('.rg-caret')) return
    const row = t.closest<HTMLElement>(QUICK_ROWS)
    const target = targetOf(row?.dataset.target)
    if (!target || (target.kind !== 'pane' && target.kind !== 'agent')) return
    this.host.closeQuick()
    this.host.go(target)
  }
}

/** The Regency's tab: fixed (no close), the pin says so. */
export class RegencyTab implements ITabRenderer {
  readonly element: HTMLElement

  constructor() {
    this.element = el('div', 'tether-tab regency')
    const kind = el('span', 'kind')
    kind.append(icon('columns'))
    kind.title = REGENCY_TITLE
    const pin = el('span', 'kind rg-pin')
    pin.append(icon('push-pin'))
    pin.title = 'Guia fixa da Regência'
    this.element.append(kind, el('span', 'text', REGENCY_TITLE), pin)
    this.element.title = `${REGENCY_TITLE}\nQuem espera você, as conversas e todas as mesas`
  }

  init(_p: TabPartInitParameters): void {}

  dispose(): void {}
}
