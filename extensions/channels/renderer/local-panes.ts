// The channel's view in the app: the host the view runs on here (`TetherUi`, the extension's ipc with the main process and
// the marks, passed through as they are), its tab in the dockview, the pane type, the palette's commands and the test
// hooks. The view itself (channel-pane.ts) knows only the `ChannelHost`.
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer } from 'dockview-core'
import type { ContextMenuEntry, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import type { ChannelsIpc } from '../ipc.ts'
import { CHANNEL_COMPONENT, CHANNEL_PANE_PREFIX, CHANNEL_TAB, channelIdOfPane, channelPaneId, manifest } from '../manifest.ts'
import { POLL_COMMAND_ID, REACT_COMMAND, createChannelViews, type ChannelView, type PaneSnapshot } from './channel-pane.ts'
import type { EmbeddedChannel, EmbedOptions } from './embed.ts'
import { glyph } from './glyphs.ts'
import type { ChannelHost } from './host.ts'
import type { Marks } from './marks.ts'
import { FIVE } from './reactions.ts'
import { forYouLabel, unreadLabel, waitsLabel } from './view-model.ts'

export interface ChannelPanes {
  disposables: Disposable[]
  /** Opens the channel's pane, or brings the one that exists forward (P3). */
  open(channelId: string, name?: string): void
  /** Opens the channel as a tab on a desk out of view, without switching desks or taking the keyboard; false when refused (desk unknown, or the channel already has a tab). */
  openOn(channelId: string, deskId: string, name?: string): boolean
  snapshot(channelId: string): PaneSnapshot | undefined
  /** The channel's view outside the dockview (the Regency's centre): the same view as the tab, with no tab of its own. */
  mountEmbed(host: HTMLElement, channelId: string, opts?: EmbedOptions): EmbeddedChannel
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** The app as the channel's view sees it: every member is the app's own call, unchanged. */
export function localChannelHost(ui: TetherUi, marks: Marks, channelList: () => readonly ChannelSummary[]): ChannelHost {
  // Attaching files (A1): main looks at the files and stages a pasted print; the daemon copies them on `say`.
  const filesIpc = ui.ipc<ChannelsIpc>()
  return {
    request: (name, args) => ui.daemon.request(name, args),
    onEvent: (name, listener) => ui.daemon.onEvent(name, listener),
    marks,
    channels: channelList,
    agent: id => ui.agents.get(id),
    personEmblem: id => ui.panes.personEmblem(id),
    onDidChangeEmblems: listener => ui.panes.onDidChangeMarks(listener),
    moderatorName: () => ui.settings.get<string>('moderatorName'),
    files: {
      inspect: paths => filesIpc.invoke('inspect', paths),
      pick: () => filesIpc.invoke('pick'),
      stageImage: name => filesIpc.invoke('stageImage', name),
      discard: paths => { void filesIpc.invoke('discard', paths).catch(() => undefined) },
      pathOf: file => window.tether.pathForFile(file),
      look: paths => filesIpc.invoke('look', paths),
      view: path => filesIpc.invoke('view', path),
    },
    follow: (target, opts) => ui.links.follow(target, opts),
    linkMenu: (x, y, target) => { ui.links.showMenu(x, y, target) },
    menu: (x, y, entries) => ui.menus.context(x, y, entries),
    ask: spec => ui.dialogs.ask(spec),
    run: (command, args) => ui.commands.run(command, args),
    peek: paneId => ui.panes.peek(paneId),
    copyLink: paneId => ui.panes.copyLink(paneId),
    emblemMenu: (paneId, x, y) => ui.panes.emblemMenu(paneId, x, y),
    movePane: paneId => ui.panes.move(paneId),
    closePane: paneId => ui.panes.close(paneId),
    tabMenu: (paneId, x, y, opener) => ui.panes.showTabMenu(paneId, x, y, opener),
    writeClipboard: text => ui.shell.writeClipboard(text),
    keyTable: () => ui.keybindings.table(),
  }
}

export function createChannelPanes(ui: TetherUi, marks: Marks, channelList: () => readonly ChannelSummary[] = () => []): ChannelPanes {
  const views = createChannelViews(localChannelHost(ui, marks, channelList))
  const type = manifest.contributes!.paneTypes![0]!
  const { paneOf, tabOf } = views

  class ChannelTab implements ITabRenderer {
    readonly element = el('div', 'ch-tab')
    private readonly title = el('span', 'ch-tab-title')
    private readonly ring = el('span', 'ch-ring')
    private readonly dot = el('span', 'ch-att')
    private sub: IDisposable | undefined
    /**
     * The marks on the tab: the quiet ring for lines nobody has seen (a count in its tooltip, no colour, no number) and the orange
     * counter only for lines addressed to the person. Drawn here because the core's emblems and seals fill its own tab headers, not an extension's.
     */
    private paintMarks(channelId: string): void {
      const m = marks.of(channelId)
      const plain = Math.max(0, m.unread - m.toMe)
      // The orange counter: how many lines are for her and how many reactions ask her (the plain lines stay the quiet ring, no number).
      const asks = marks.asksOf(channelId).length
      const owed = marks.owedOf(channelId).length
      const n = m.toMe + asks + owed
      this.ring.hidden = plain === 0
      this.ring.title = plain > 0 ? unreadLabel(plain) : ''
      this.dot.hidden = n === 0
      this.dot.textContent = n > 0 ? String(n > 99 ? '99+' : n) : ''
      this.dot.title = m.toMe > 0 ? forYouLabel(m.toMe) : waitsLabel(asks, owed)
      this.element.dataset.mark = n > 0 ? 'me' : plain > 0 ? 'plain' : ''
    }
    init(p: GroupPanelPartInitParameters): void {
      const paneId = p.api.id
      const channelId = channelIdOfPane(paneId)
      const close = el('button', 'close')
      close.title = 'Fechar painel'; close.setAttribute('aria-label', 'Fechar painel')
      close.append(glyph('x'))
      close.addEventListener('pointerdown', ev => ev.stopPropagation())
      close.addEventListener('click', ev => { ev.stopPropagation(); ui.panes.close(paneId) })
      this.title.textContent = p.api.title ?? `#${channelIdOfPane(paneId)}`
      p.api.onDidTitleChange(() => { this.title.textContent = p.api.title ?? '' })
      this.element.dataset.channel = channelId
      this.element.append(glyph('chats-circle'), this.title, this.ring, this.dot, close)
      this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); ui.panes.showTabMenu(paneId, ev.clientX, ev.clientY) })
      this.paintMarks(channelId)
      this.sub = marks.onDidChange(() => this.paintMarks(channelId))
    }
    dispose(): void { this.sub?.dispose() }
  }

  const paneOptions = (channelId: string, name?: string) =>
    ({ id: channelPaneId(channelId), component: CHANNEL_COMPONENT, tabComponent: CHANNEL_TAB, title: `#${name ?? channelId}`, params: { channelId } })
  const open = (channelId: string, name?: string): void => {
    const id = channelPaneId(channelId)
    if (ui.panes.find(id)) { ui.panes.reveal(id); return }
    ui.panes.open(paneOptions(channelId, name))
  }
  const openOn = (channelId: string, deskId: string, name?: string): boolean => {
    if (ui.panes.find(channelPaneId(channelId))) return false
    return ui.panes.openOnDesk(paneOptions(channelId, name), deskId) !== undefined
  }

  // The palette's rows to react to the focused speech (what has a key has a menu): they act on the channel pane that is active.
  const activeChannelPane = (): ChannelView | undefined => {
    const id = ui.panes.activeId()
    return id !== undefined && id.startsWith(CHANNEL_PANE_PREFIX) ? tabOf(channelIdOfPane(id)) : undefined
  }

  const inChannel = (ctx: { paneType?: string }): boolean => ctx.paneType === type.id
  const reactRows = [
    { id: REACT_COMMAND, title: 'Reagir à fala focada…', run: (p: ChannelView) => p.reactFocused(undefined) },
    { id: `${REACT_COMMAND}.last`, title: 'Reagir à última fala…', run: (p: ChannelView) => p.reactFocused(undefined, true) },
    ...FIVE.map(f => ({
      id: `${REACT_COMMAND}.${f.name}`, title: `Reagir à fala focada: ${f.emoji} ${f.label}`, run: (p: ChannelView) => p.reactFocused(f.emoji),
    })),
  ]

  const disposables: Disposable[] = [
    // The palette's row to open a poll (what has a key has a menu): it acts on the channel pane that is active.
    ui.commands.register({
      id: POLL_COMMAND_ID, title: 'Abrir enquete…', group: 'Canais', icon: 'chats-circle', when: inChannel,
      run: (): void => { activeChannelPane()?.openPollForm() },
    }),
    ui.commands.register(...reactRows.map(r => ({
      id: r.id, title: r.title, group: 'Canais', icon: 'chats-circle', when: inChannel, ignoreRepeat: true,
      run: (): void => { const p = activeChannelPane(); if (p) r.run(p) },
    }))),
    ui.panes.register({
      ...type, hasSlot: false, icon: 'chats-circle',
      create: () => new views.View() as unknown as IContentRenderer,
      createTab: () => new ChannelTab() as unknown as ITabRenderer,
      has: id => id.startsWith(CHANNEL_PANE_PREFIX) && tabOf(channelIdOfPane(id)) !== undefined,
      // The channel's one menu, from `channelMenu` (texts.ts): the tab's right click and the bar's "⋯" both land here.
      // The menu takes headings (the core's `fromExtMenu`); only the declared parameter type of `context` leaves them out.
      tabMenu: (id, x, y) => ui.menus.context(x, y, (tabOf(channelIdOfPane(id))?.menuRows(id) ?? []) as ContextMenuEntry[]),
    }),
    ...views.disposables,
  ]

  // Test hooks: text and flags of a pane, plus the minimum to drive it (open, scroll, ask the daemon as the app does).
  // Read at window.__tether.ext.channels.<name>.
  ui.test.expose('open', open)
  ui.test.expose('view', (channelId: string): PaneSnapshot | undefined => paneOf(channelId)?.snapshot())
  // The embedded view of a channel (the Regency's centre), apart from its tab.
  ui.test.expose('embedView', (channelId: string): PaneSnapshot | undefined => views.embedOf(channelId)?.snapshot())
  ui.test.expose('wearEmblem', (paneId: string, emblemId: string | undefined): void => { ui.panes.find(paneId)?.api.updateParameters({ emblem: emblemId }) })
  ui.test.expose('kept', (channelId: string): boolean => views.isKept(channelId))
  ui.test.expose('scrollTo', (channelId: string, top: number): void => paneOf(channelId)?.scrollTo(top))
  ui.test.expose('loadOlder', (channelId: string): Promise<void> => paneOf(channelId)?.olderNow() ?? Promise.resolve())

  return { disposables, open, openOn, snapshot: channelId => paneOf(channelId)?.snapshot(), mountEmbed: views.mountEmbed }
}
