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
  DEFAULT_LAYOUT, layoutParams, readLayout, selectChannel, tierOf, toggleCollapsed, toggleMembers, type RegencyLayout,
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
  private readonly closedBar = el('div', 'rg-closed-bar', 'Conversa encerrada: só leitura.')
  private readonly voidBox = el('div', 'rg-void')
  private readonly members = el('section', 'rg-members')
  private readonly membersHead = el('button', 'rg-tg rg-members-tg')
  private readonly facesHost = el('span', 'rg-faces')
  private readonly membersHost = el('div', 'rg-members-host')
  private readonly treeHost = el('div', 'rg-tree')
  private readonly reservedHost = el('div', 'rg-reserved')
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
    const left = el('aside', 'rg-col rg-left')
    left.setAttribute('aria-label', 'Esperam você e conversas')
    left.append(this.waitHost, this.convHost)
    this.center.setAttribute('aria-label', 'Conversa')
    this.embedHost.hidden = true
    this.closedBar.hidden = true
    this.center.append(this.closedBar, this.embedHost, this.voidBox)
    const right = el('aside', 'rg-col rg-right')
    right.setAttribute('aria-label', 'Neste canal e o Tether')
    this.membersHead.type = 'button'
    this.membersHead.dataset.action = 'members'
    this.members.append(this.membersHead, this.membersHost)
    const treeHd = el('div', 'rg-hd')
    treeHd.append(el('span', 'rg-hd-t', 'Tether'))
    right.append(this.members, treeHd, this.treeHost, this.reservedHost)
    this.element.append(left, this.center, right)
    paintReserved(this.reservedHost)
    this.element.addEventListener('click', ev => this.onClick(ev))
    this.element.addEventListener('keydown', ev => this.onKey(ev))
    this.ro = new ResizeObserver(() => {
      const w = this.element.clientWidth
      if (w > 0) this.element.dataset.tier = tierOf(w)
    })
    this.ro.observe(this.element)
    this.paintVoid()
    this.paintMembersHead()
  }

  /** Paints what changed since the last paint (the model, the chosen channel, "Encerrados"). */
  paint(): void {
    if (this.disposed || !this.api) return
    this.syncCenter()
    const model = this.host.model(this.state.collapsed)
    const ctx = this.context()
    const sig = `${modelSignature(model)}|${this.state.channelId ?? ''}|${this.closedOpen}|${ctx.loading}`
    if (sig === this.signature) return
    this.signature = sig
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
    if (action === 'closed') { this.closedOpen = !this.closedOpen; this.signature = ''; this.paint() }
    else if (action === 'members') { this.setLayout(toggleMembers(this.state)); this.paintMembersHead() }
    else if (action === 'choose') void this.host.pickChannel().then(id => { if (id) this.select(id) })
  }

  private activate(row: HTMLElement): void {
    const target = targetOf(row.dataset.target)
    if (!target) return
    if (target.kind === 'channel') this.select(target.id)
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
