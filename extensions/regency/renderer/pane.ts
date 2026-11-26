// The Regency's one pane, `regency:main`: three columns over the model. Left: "Esperam você" and "Conversas". Centre: the
// chosen channel, the channels extension's view embedded (its members' column goes to "Neste canal" on the right). Right:
// "Neste canal" (folded: only the faces), the tree "Tether" and the reserved "Fechadas" and "Sistema". The pane keeps its
// layout (channel, folded desks, "Neste canal" open) in its parameters, so layout.json carries it. Nothing here takes the
// focus or changes desk by itself: only a click or a key of the person does.
import type { DockviewPanelApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { icon } from '../../../app/renderer/icons.ts'
import type { IdentityInput } from '../../../app/renderer/agent-identity.ts'
import type { ChannelSummary } from '../../channels/daemon/requests.ts'
import type { EmbeddedChannel, EmbedOptions } from '../../channels/renderer/embed.ts'
import type { RegencyModel, Target } from '../model.ts'
import { modelSignature } from '../model.ts'
import { REGENCY_TITLE } from '../manifest.ts'
import {
  DEFAULT_LAYOUT, layoutParams, openingTab, readLayout, selectChannel, setNarrowTab, tierOf, toggleCollapsed, toggleMembers,
  toggleMode, type NarrowTab, type RegencyLayout, type RegencyMode,
} from './layout-rules.ts'
import {
  el, glyph, paintConversations, paintFaces, paintReserved, paintTree, paintWaiting, targetOf, type ColumnsContext,
} from './columns.ts'

/** What the pane asks of the extension (renderer.ts). */
export interface RegencyHost {
  model(collapsed: readonly string[]): RegencyModel
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

/** The phone's three places, in the bottom bar's order. */
const NARROW_PLACES: readonly { tab: NarrowTab; label: string; icon: string }[] = [
  { tab: 'waiting', label: 'Chama você', icon: 'bell' },
  { tab: 'conversation', label: 'Conversa', icon: 'chats-circle' },
  { tab: 'tether', label: 'Tether', icon: 'tree-view' },
]

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
  private waitingCount = 0
  /** The phone's opening tab was chosen (once, when the first model with the channels' list came). */
  private opened = false
  private embed: EmbeddedChannel | undefined
  private embedSub: { dispose(): void } | undefined
  private closedOpen = false
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
    this.center.append(this.closedBar, this.embedHost, this.voidBox)
    this.right.setAttribute('aria-label', 'Neste canal e o Tether')
    this.membersHead.type = 'button'
    this.membersHead.dataset.action = 'members'
    this.members.append(this.membersHead, this.membersHost)
    this.modeBtn.type = 'button'
    this.modeBtn.dataset.action = 'mode'
    this.treeHd.append(el('span', 'rg-hd-t', 'Tether'), el('span', 'rg-sp'))
    this.right.append(this.members, this.treeHd, this.treeHost, this.reservedHost)
    this.buildEdges()
    this.buildTabBar()
    this.element.append(this.left, this.edgeLeft, this.center, this.right, this.edgeRight, this.tabBar)
    paintReserved(this.reservedHost)
    this.element.addEventListener('click', ev => this.onClick(ev))
    this.element.addEventListener('keydown', ev => this.onKey(ev))
    this.ro = new ResizeObserver(() => {
      const w = this.element.clientWidth
      if (w > 0) this.element.dataset.tier = tierOf(w)
    })
    this.ro.observe(this.element)
    this.paintMode()
    this.paintTabs()
    this.paintVoid()
    this.paintMembersHead()
  }

  /** The tier the pane is drawn in now (the ruler of four, by the pane's width). */
  get tier(): string { return this.element.dataset.tier ?? 'desktop' }

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
    const model = this.host.model(this.state.collapsed)
    const ctx = this.context()
    if (!this.opened && !ctx.loading) {
      this.opened = true
      const tab = openingTab(this.state.narrowTab, model.waiting.length)
      if (tab !== this.state.narrowTab) this.setTab(tab)
    }
    const sig = `${modelSignature(model)}|${this.state.channelId ?? ''}|${this.closedOpen}|${ctx.loading}`
    if (sig === this.signature) return
    this.signature = sig
    this.waitingCount = model.waiting.length
    this.paintCounts()
    this.keepFocus(() => {
      paintWaiting(this.waitHost, model, ctx)
      paintConversations(this.convHost, model, ctx)
      paintTree(this.treeHost, model, ctx)
    })
    const ch = this.state.channelId ? this.host.channel(this.state.channelId) : undefined
    this.closedBar.hidden = !(ch?.closed)
    this.paintVoid()
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

  focus(): void {
    if (this.embed) this.embed.focus()
    else this.element.querySelector<HTMLElement>('[data-target]')?.focus({ preventScroll: true })
  }

  dispose(): void {
    this.disposed = true
    this.ro?.disconnect()
    this.dropEmbed()
    this.host.gone(this)
  }

  /** Immersion's edges: the left keeps who waits (and lights when someone does); the right keeps "Neste canal" and the tether. */
  private buildEdges(): void {
    this.edgeLeft.type = 'button'
    this.edgeLeft.dataset.action = 'manage'
    this.edgeLeft.title = 'Esperam você · voltar a Gerir'
    this.edgeLeft.append(glyph('bell', 'Esperam você'), this.edgeCount)
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

  private keepFocus(paint: () => void): void {
    const active = document.activeElement
    const key = active instanceof HTMLElement && this.element.contains(active) ? active.dataset.target : undefined
    paint()
    if (!key) return
    const again = [...this.element.querySelectorAll<HTMLElement>('[data-target]')].find(e => e.dataset.target === key)
    if (again && again !== document.activeElement && !document.activeElement?.closest('.rg-center')) again.focus({ preventScroll: true })
  }

  private onClick(ev: MouseEvent): void {
    const t = ev.target instanceof Element ? ev.target : null
    if (!t || t.closest('.rg-center') && !t.closest('[data-action="choose"]')) return
    if (t.closest('.rg-members-host')) return
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action) { this.act(action); return }
    const row = t.closest<HTMLElement>('[data-target]')
    if (row) this.activate(row)
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const t = ev.target instanceof HTMLElement ? ev.target : null
    if (!t?.dataset.target || t.closest('.rg-center')) return
    ev.preventDefault()
    this.activate(t)
  }

  private act(action: string): void {
    if (action.startsWith('tab:')) { this.setTab(action.slice(4) as NarrowTab); return }
    if (action === 'mode') { this.toggleMode(); return }
    if (action === 'manage' || action === 'manage-members' || action === 'manage-tether') {
      this.setMode('manage')
      if (action === 'manage-members' && !this.state.membersOpen && this.embed) { this.setLayout(toggleMembers(this.state)); this.paintMembersHead() }
      if (action === 'manage-tether') this.treeHost.querySelector<HTMLElement>('[data-target]')?.focus({ preventScroll: true })
      return
    }
    if (action === 'closed') { this.closedOpen = !this.closedOpen; this.signature = ''; this.paint() }
    else if (action === 'members') { this.setLayout(toggleMembers(this.state)); this.paintMembersHead() }
    else if (action === 'choose') void this.host.pickChannel().then(id => { if (id) this.select(id) })
  }

  private activate(row: HTMLElement): void {
    const target = targetOf(row.dataset.target)
    if (!target) return
    if (target.kind === 'channel') {
      this.select(target.id)
      // On the phone, choosing a conversation takes the person to it.
      if (this.tier === 'mobile') this.setTab('conversation')
    }
    else if (target.kind === 'desk') { this.setLayout(toggleCollapsed(this.state, target.id)); this.signature = ''; this.paint() }
    else this.host.go(target)
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
