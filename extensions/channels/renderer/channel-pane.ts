// The channel's pane (slice U1a, reading only): the conversation, the members with the state of each, the header. One channel,
// one pane (`channel:<channelId>`, P3). It asks the daemon half (`history`, `members`) and hears `line` and `channel` (N1); what it
// shows is decided by view-model.ts, this file only paints and keeps the place.
//   - A new line never activates the pane, never switches the desk, never steals focus: the pane repaints itself where it is.
//     If the person reads above the end the view does not move (a bar says how many came); at the end it follows.
//   - Moving the pane to another desk rebuilds it; the place (lines held, scroll, "reading the end") is kept per channel in memory,
//     up to KEPT_MAX channels, and the newest page is asked again to fill the end.
//   - The speaking box (composer.ts, U1b) sits in `.ch-composer-slot`; a closed channel has none. Orange is the U3's.
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer } from 'dockview-core'
import type { ContextMenuEntry, ContextMenuRow, Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { detectUrlLinks, linkTargetOfUrl } from '../../../app/shared/links.ts'
import { channelUrl } from '../../../app/shared/tether-url.ts'
import type { ChannelEvent, LineEvent, PollEvent, ReactionEvent } from '../daemon/fanout.ts'
import { reactionKey, USER, type Line, type PollMissingWhy } from '../rules.ts'
import {
  applyPoll, cardAria, cardOf, closePollDialog, isNoOption, POLL_REASON_MAX, pollRefusalText, countdown, voteAnnounce,
  type PollCard, type PollOpenView, type PollState,
} from './polls.ts'
import { ICON } from './texts.ts'
import {
  announceText, applyReaction, emojiKeyHint, FIVE, minesOf, msgAria, otherEmoji, pillAria, pillsOf, pillsSummary, pillTitle, pushRecent, readRecents, refusalText, seesNextText, splitPills, whoText,
  type Pending, type Pill, type Tallies,
} from './reactions.ts'
import { CHANNEL_COMPONENT, CHANNEL_PANE_PREFIX, CHANNEL_TAB, CMD, channelIdOfPane, channelPaneId, manifest } from '../manifest.ts'
import { createComposer, type ComposerSnapshot } from './composer.ts'
import { createFileViews } from './files.ts'
import type { AttachDeps } from './attach-box.ts'
import type { FileSource } from '../attachments.ts'
import type { ChannelsIpc } from '../ipc.ts'
import { createViewer, type ViewerSnapshot } from './viewer.ts'
import { DROP_CLOSED, DROP_NO_FILE, DROP_SUB, DROP_TITLE, dragHasFiles } from './viewer-rules.ts'
import { bareMark } from '../../../app/renderer/agent-identity.ts'
import { identityOf, type Identity } from '../../../app/renderer/agent-identity-rules.ts'
import { ICON_NAMES, type IconName } from '../../../app/renderer/icons.ts'
import { glyph, NOTICE_ICON } from './glyphs.ts'
import { isPeekModifier } from '../../../app/renderer/link-open.ts'
import { agentHue } from '../../../app/shared/agent-color.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import { channelSpans, HASH_TEXT, mentionSpans } from './mentions.ts'
import { MENTION_TEXT, PANE_TEXT, agentNameMenu, channelMenu, memberMenu, type ChannelMenuEntry, type ChannelMenuId, type MemberMenuEntry } from './texts.ts'
import type { Marks } from './marks.ts'
import type { EmbeddedChannel, EmbedOptions } from './embed.ts'
import {
  agentLinkOf, applyLine, applyPage, DEFAULT_MODERATOR_NAME, emptyTimeline, foldAria, foldOf, forYouLabel, headerOf, idByName, isNearBottom, memberAria, memberRows, mergeNewest,
  MODERATOR_ARIA, muteBar, olderCursor, rowsOf, unreadLabel, waitsLabel, type HistoryPage, type MemberRow, type MembersAnswer, type Row, type Timeline,
} from './view-model.ts'

/** Lines asked per page (the daemon's ceiling is 200). */
export const PAGE_SIZE = 50
/** How many channels keep their place in memory after their pane is gone (moved or closed). */
const KEPT_MAX = 16
/** The members' state changes without a line (a guia ficou livre): asked again this long after a line, once per pane. */
const MEMBERS_REFRESH_MS = 1000
/** Scrolled within this of the top: the older page is asked for. */
const TOP_SLACK_PX = 40
/** Under this width the members fold away by default (the narrow composition). */
const NARROW_PX = 560
/** How long after "Tirar" an emptied list still moves the focus (the dialog may take its time). */
const JOIN_FOCUS_MS = 60_000

/** How long the short notice of a refused reaction stays. */
const TOAST_MS = 6000
/** Reaction lines heard before the first page came (more than this are dropped: the page brings the sums). */
const EARLY_REACTIONS_MAX = 200

/** The recent emojis of the person live in this window's storage (a UI convenience, like the palette's recents). */
const RECENTS_KEY = 'tether.channels.recentReactions'
/** The command that opens the picker on the focused speech: its key is `r` here until the person binds the command to another. */
export const REACT_COMMAND = 'channels.react'
/** The palette's command that opens the poll form of the active channel pane. */
export const POLL_COMMAND_ID = 'channels.poll'
const REACT_DEFAULT_KEY = 'r'

interface Kept { timeline: Timeline; tallies: Tallies; polls: Map<number, PollState>; scrollTop: number; stick: boolean; floor: number | undefined }

/** What the person is doing on one poll's card, apart from the poll itself (it survives a repaint). */
interface PollInput {
  /** The reason's field is open: for the option voted (1-based), or 0 while she still has to pick one. */
  reasonFor?: number
  text: string
  /** The vote not answered yet. */
  pending?: number
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const hueStyle = (e: HTMLElement, hue: number | undefined): void => { if (hue !== undefined) e.style.setProperty('--oh', String(hue)) }

/** What a test reads of a pane: text and flags, never elements. */
export interface PaneSnapshot {
  loaded: boolean
  error: string
  title: string
  sub: string
  closed: boolean
  rows: Array<{ kind: Row['kind']; text: string; name?: string; role?: string; crown?: boolean; mine?: boolean; to?: string[]; glyph?: string; continued?: boolean }>
  /** `emblem`: the name on the member's chip as drawn, empty when none. */
  /** The cards of the polls held, as the pane builds them now. `pollInput`: the reason's field of each card (open for which option, the text). */
  polls: PollCard[]
  pollInput: Array<{ seq: number; reasonFor?: number; text: string }>
  /** What a screen reader gets of each card: the row's role and accessible name, as they are on the page now. `focus`: the card that holds the focus (0 = none). */
  pollNames: Array<{ seq: number; role: string; label: string }>
  pollFocus: number
  /** How many polls wait for her vote (from the marks). */
  owed: number
  members: Array<{ name: string; role: string; muted: boolean; state: string; tone: string; emblem: string; hint: string; acts: string[] }>
  muteBar: string
  scroll: { top: number; client: number; height: number; stick: boolean }
  unread: number
  more: boolean
  last: number
  membersOpen: boolean
  hasComposerSlot: boolean
  /** The image viewer over the pane (A3); absent while it is closed. */
  viewer?: ViewerSnapshot
  /** The drop zone (A3): shown while files of the system are dragged over the pane; `refuse` while the channel is closed. */
  drop: { shown: boolean; title: string; sub: string; refuse: boolean }
  /** The short notice of a refused reaction, '' when none shows. */
  toast: string
  /** What was last said aloud (the polite live region) about a reaction change. */
  announce: string
  /** The reaction picker: open, for which speech, its recents, the hint of its field and the field's notice. */
  picker: { open: boolean; seq: number; recents: string[]; hint: string; error: string }
  /** The speech that holds the keyboard focus (0 = none). */
  focusSeq: number
  /** The speaking box; absent while the channel is closed. */
  composer?: ComposerSnapshot
  /** The bar over the conversation ("N novas para você" or "N falas novas"); '' while hidden. `barMe`: the one for her. */
  bar: string
  barMe: boolean
  /** Unseen lines addressed to the person, as the marks hold them. */
  toMe: number
  /** Unseen ❓/❌ reactions of agents on her speeches. */
  asks: number
  /**
   * The header's bar (the plan's `bar`, renamed: `bar` above is the "novas" bar). `primary`: the accent gesture shown (join in an open
   * channel, reopen in a closed common one, none in a closed desk channel or before the first answer); `labeled`: it carries its text;
   * `more`: the "⋯" is there; `toEnd`: "Ir para o fim" is in the bar (not in the narrow one).
   */
  actions: { primary: 'join' | 'reopen' | 'none'; labeled: boolean; more: boolean; toEnd: boolean }
  /** Whether nobody is in the (open) channel: the empty state shows, the column and the "Membros" button are away, the box is off. */
  empty: boolean
  /** What is drawn of the members: the column, and the "Membros" button of the bar (both away while the channel is empty). */
  column: { shown: boolean; button: boolean }
  /**
   * The narrow composition's strip of members (G7): `count` members, `muted` of them muted, `open` while its list is down over the conversation.
   * `foldBar`: whether the strip is drawn (narrow, somebody in the channel) and how many members do not hear now (`warn`, the strip's warning).
   */
  fold: { count: number; muted: number; open: boolean }
  foldBar: { shown: boolean; warn: number }
  /**
   * What the pane says to a screen reader and the keyboard (G9), as attributes: the bar's toolbar, the "Membros" button (`pressed`,
   * `controls`), the strip's button, the list of members (its role, name and each row's whole sentence), the conversation's log, and
   * the order the Tab visits the regions in (`tabs`: toolbar, strip, members, log, composer; one entry per stop).
   */
  aria: {
    toolbar: { role: string; label: string }
    membersBtn: { pressed: string; controls: string; hidden: boolean }
    fold: { expanded: string; label: string; controls: string }
    list: { role: string; label: string; items: Array<{ role: string; label: string }> }
    log: { role: string; live: string; label: string; relevant: string; tabindex: string }
    moreMenu: string
    tabs: string[]
  }
}

export interface ChannelPanes {
  disposables: Disposable[]
  /** Opens the channel's pane, or brings the one that exists forward (P3). */
  open(channelId: string, name?: string): void
  snapshot(channelId: string): PaneSnapshot | undefined
  /** The channel's view outside the dockview (the Regency's centre): the same view as the tab, with no tab of its own. */
  mountEmbed(host: HTMLElement, channelId: string, opts?: EmbedOptions): EmbeddedChannel
}

/**
 * Where a channel's view lives: a tab of the dockview (`pane`, the `api` wrapped as it always was) or embedded in another
 * extension's surface (`embed`: no tab title to set, its menu has no "Fechar painel", "Mover" nor the pane's link).
 */
interface ChannelHost {
  readonly kind: 'pane' | 'embed'
  /** The pane id the core knows the channel by (`channel:<id>`), for both kinds. */
  readonly id: string
  title(): string | undefined
  setTitle(title: string): void
  showMenu(x: number, y: number, opener?: HTMLElement): void
}

/** The menu rows an embedded view leaves out: they act on a tab it does not have. */
const EMBED_OMITS: ReadonlySet<ChannelMenuId> = new Set<ChannelMenuId>(['link', 'move', 'closePane'])
const OPEN_AS_TAB = 'Abrir como guia'

export function createChannelPanes(ui: TetherUi, marks: Marks, channelList: () => readonly ChannelSummary[] = () => []): ChannelPanes {
  /** The channels a "#" can name: the open ones (a closed channel is plain text). */
  const openChannels = (): ChannelSummary[] => channelList().filter(c => c.closed === undefined)
  const live = new Set<ChannelPane>()
  const kept = new Map<string, Kept>()
  const type = manifest.contributes!.paneTypes![0]!

  const keep = (channelId: string, k: Kept): void => {
    kept.delete(channelId)
    kept.set(channelId, k)
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value as string)
  }
  /** The view of a channel, the tab before an embedded one (the tests and the snapshot read the tab when there is one). */
  const paneOf = (channelId: string): ChannelPane | undefined => tabOf(channelId) ?? [...live].find(p => p.channelId === channelId)
  /** Only the tab: what the core asks about (`has`, the tab's menu, the active pane) is never an embedded view. */
  const tabOf = (channelId: string): ChannelPane | undefined => [...live].find(p => p.channelId === channelId && p.kind === 'pane')
  const paneHolding = (node: Node): ChannelPane | undefined => [...live].find(p => p.element.contains(node))
  /** A live agent no pane shows (`placed: false`): its name peeks instead of going to a tab. */
  const noDesk = (id: string): boolean => ui.agents.get(id)?.placed === false
  /** Who an agent is as the lists draw it: its engine and, in the emblem's place, the emblem its tab wears or its letter (agent-identity.ts). */
  const identityOfAgent = (id: string, name: string): Identity => identityOf({ kind: ui.agents.get(id)?.kind ?? '', name, seed: id, emblem: ui.panes.personEmblem(id) })
  /** The engine's cell (`.ch-em`): the agent's engine icon, the generic robot when the app does not know the agent. `crown` rings the owner's. */
  const engineCell = (ident: Identity, crown: boolean): HTMLElement => {
    const cell = el('span', `ch-em${crown ? ' crown' : ''}`)
    if (ident.kind === '') { cell.append(glyph('robot')); return cell }
    const name = (ICON_NAMES as readonly string[]).includes(ident.engine.icon) ? ident.engine.icon as IconName : 'robot'
    cell.dataset.engine = ident.kind
    cell.title = ident.engine.label
    cell.setAttribute('role', 'img')
    cell.setAttribute('aria-label', ident.engine.label)
    cell.append(glyph(name))
    return cell
  }
  /** The emblem's chip or the letter's square, in the emblem's own place. */
  const markCell = (ident: Identity): HTMLElement => {
    const m = bareMark(ident.mark)
    if (ident.mark.type === 'emblem') { m.classList.add('ch-emblem'); m.title = ident.mark.emblem.name }
    return m
  }
  const moderatorName = (): string => ui.settings.get<string>('moderatorName') ?? DEFAULT_MODERATOR_NAME
  // Attaching files (A1): main looks at the files and stages a pasted print; the daemon copies them on `say`.
  const filesIpc = ui.ipc<ChannelsIpc>()
  const attach: AttachDeps = {
    inspect: paths => filesIpc.invoke('inspect', paths),
    pick: () => filesIpc.invoke('pick'),
    stageImage: name => filesIpc.invoke('stageImage', name),
    discard: paths => { void filesIpc.invoke('discard', paths).catch(() => undefined) },
    pathOf: file => window.tether.pathForFile(file),
  }
  // The files of the speeches in the conversation (A2): a click opens like any file link, the right button is the file link's menu.
  const fileViews = createFileViews({
    look: paths => filesIpc.invoke('look', paths),
    open: path => ui.links.follow({ kind: 'file', path }),
    // An image opens in the viewer of the pane that holds the thumbnail (A3); its menu has "Ver imagem" first.
    view: (path, from) => { paneHolding(from)?.showImage(path) },
    menu: (x, y, path, image, from) => {
      const pane = paneHolding(from)
      if (image && pane) pane.imageMenu(x, y, path)
      else ui.links.showMenu(x, y, { kind: 'file', path })
    },
  })

  class ChannelPane implements IContentRenderer {
    readonly element = el('div', 'ch-pane')
    channelId = ''
    private host: ChannelHost | undefined
    /** The members' column lives here instead of beside the conversation (an embedded view's option). */
    private membersHost: HTMLElement | undefined
    private readonly memberListeners = new Set<() => void>()
    private timeline: Timeline = emptyTimeline()
    private answer: MembersAnswer | undefined
    private error = ''
    private loaded = false
    private stick = true
    private unread = 0
    private membersOpen = true
    private membersTouched = false
    private loadingOlder = false
    /** The `seq` the separator "novas para você" was last drawn before. */
    private separatorAt: number | undefined
    private wasVisible = false
    /** Lines heard before the first page came. */
    private early: Line[] = []
    /** The scroll the person left it at, as of the last scroll event seen while shown. */
    private lastTop = 0
    private pendingScroll: number | 'end' | undefined
    private membersTimer: ReturnType<typeof setTimeout> | undefined
    private disposed = false
    private ro: ResizeObserver | undefined
    private contentRo: ResizeObserver | undefined
    private readonly subs: IDisposable[] = []

    private readonly head = el('div', 'ch-head')
    private readonly titleBox = el('div', 'ch-title')
    private readonly bar = el('div', 'ch-bar')
    private readonly body = el('div', 'ch-body')
    private readonly conv = el('div', 'ch-conv')
    private readonly msgs = el('div', 'ch-msgs')
    private readonly newBar = el('button', 'ch-newbar')
    private readonly muteBox = el('div', 'ch-mutebar')
    private readonly foot = el('div', 'ch-foot')
    /** The sum of the reactions of each message held (apart from the timeline: a reaction is no line of the conversation). */
    private tallies: Tallies = new Map()
    /** The person's gestures the daemon has not answered yet, by message. */
    private readonly pending = new Map<number, Map<string, 'add' | 'remove'>>()
    /** `seq`s of reactions heard live above the timeline's last line: they take a number and are no hole in the conversation. */
    private readonly quiet = new Set<number>()
    private earlyReactions: Line[] = []
    /** The state of each poll held (open, with its votes, or its result): apart from the timeline, like the reactions. */
    private pollStates = new Map<number, PollState>()
    private readonly pollInput = new Map<number, PollInput>()
    private earlyPolls: PollEvent[] = []
    /** The countdowns of the open polls: one timer for the pane, only while a poll is open. */
    private pollTimer: ReturnType<typeof setInterval> | undefined
    /** The hover bar: one for the pane, moved onto the message under the mouse. */
    private readonly hb = el('div', 'ch-hb')
    private readonly toastEl = el('div', 'ch-toast')
    private toastTimer: ReturnType<typeof setTimeout> | undefined
    /** The lowest `seq` the pages asked cover: the cursor of the older page when a whole page is reactions (no line to read it from). */
    private floor: number | undefined
    /** The polite live region of reaction changes, apart from the conversation's log (which says only new speeches). */
    private readonly announceEl = el('div', 'ch-announce')
    private announced = ''
    /** The reaction picker (one at a time), and the speech that had the keyboard when it opened (the focus goes back there). */
    private picker: { box: HTMLElement; seq: number; input: HTMLInputElement; error: HTMLElement; off: () => void } | undefined
    /** The last speech that held the focus: the palette's commands act on it when the focus is on the palette itself. */
    private lastFocusSeq = 0
    /** Where the focus returns to after a menu of a speech or of a pill closes (by the key table's hand or the mouse's). */
    private menuReturn: { seq: number; key?: string; until: number } | undefined
    /** What each speech's name is made of (its author, time and text): the name is rebuilt when its reactions change. */
    private readonly msgMeta = new WeakMap<HTMLElement, { who: string; time: string; to: string[]; body: string }>()
    private rxNarrow = false
    private recents: string[] = []
    private readonly composerSlot = el('div', 'ch-composer-slot')
    private readonly side = el('div', 'ch-members')
    /** The narrow composition's strip of members (one button): over the conversation, folded or with its list down. */
    private readonly fold = el('button', 'ch-fold')
    private membersBtn: HTMLButtonElement | undefined
    private joinBtn: HTMLButtonElement | undefined
    private reopenBtn: HTMLButtonElement | undefined
    /** Until when an emptied list moves the focus to the accent (set by "Tirar"; 0 = not waiting). */
    private joinFocusUntil = 0
    private endBtn: HTMLButtonElement | undefined
    /** Whether the empty state ("Ninguém no canal ainda.") was drawn last, to repaint the conversation when it flips. */
    private drewNoMembers = false
    /** Whether the pills were drawn as read only (a closed channel) last: the conversation is repainted when it flips. */
    private drewClosed = false
    /**
     * Where the focus goes back to after a gesture on a member (G9): the button it started from (`act`: mute/unmute share one stop), or a
     * neighbour row when the member is gone (`next`: the rows after it, then the ones before). The member's list is redrawn whole, so the
     * button the person pressed may not exist when the menu or dialog closes. Never takes a focus someone else holds; `until` bounds it.
     */
    private memberReturn: { id: string; act: string; next: string[]; until: number } | undefined
    private overlays: MutationObserver | undefined
    /** When the keyboard last opened a member's menu (the `contextmenu` event it may raise too is ignored for a moment). */
    private keyMenuAt = 0
    private readonly composer = createComposer({
      send: (text, to, files) => this.say(text, to, files),
      attach,
      poll: {
        members: () => (this.answer?.members ?? []).map(m => ({ id: m.id, name: m.name, muted: m.muted, path: m.path })),
        open: async args => { await this.ask('poll', { ...args }) },
      },
      channels: () => openChannels().map(c => ({ name: c.name, current: c.id === this.channelId })),
    })
    /** The image viewer over the pane (A3): its images are the thumbnails of the conversation, in order. */
    private readonly viewer = createViewer({
      host: this.element,
      items: () => [...this.msgs.querySelectorAll<HTMLElement>('.ch-shot')]
        .map(b => ({ path: b.dataset.path ?? '', name: b.dataset.name ?? '', label: b.dataset.label ?? '' })).filter(i => i.path !== ''),
      load: path => filesIpc.invoke('view', path),
      open: path => ui.links.follow({ kind: 'file', path }),
      menu: (x, y, path) => { ui.links.showMenu(x, y, { kind: 'file', path }) },
      restore: path => { [...this.msgs.querySelectorAll<HTMLElement>('.ch-shot')].find(b => b.dataset.path === path)?.focus() },
    })
    /** The zone to drop files on (A3), over the whole pane: it takes no pointer, the drag events reach the pane under it. */
    private readonly dropZone = el('div', 'ch-drop')
    private dropTimer: ReturnType<typeof setTimeout> | undefined

    showImage(path: string): void { this.viewer.open(path) }

    /** The menu of an image of the conversation: "Ver imagem" first, then what a file link has that the app can do from here. */
    imageMenu(x: number, y: number, path: string): void {
      const target = { kind: 'file' as const, path }
      ui.menus.context(x, y, [
        { icon: 'file-image', label: 'Ver imagem', hint: 'Enter', run: () => this.viewer.open(path) },
        { icon: 'arrow-square-out', label: 'Abrir', run: () => ui.links.follow(target) },
        { icon: 'arrow-square-out', label: 'Abrir ao lado', run: () => ui.links.follow(target, { side: true }) },
        { icon: 'clipboard-text', label: 'Copiar caminho', run: () => this.copy(path) },
        'sep',
        { icon: 'dots-three', label: 'Mais opções do arquivo…', run: () => { ui.links.showMenu(x, y, target) } },
      ])
    }

    // Files of the system dragged over the pane (A3): only a drag that carries `Files` counts, so a tab or a panel of the app that
    // is being moved (dockview's own drag) goes on as it was. The zone stays while dragover keeps coming, and goes when it stops.
    private onDrag(ev: DragEvent): void {
      if (!dragHasFiles(ev.dataTransfer?.types)) return
      ev.preventDefault()
      ev.stopPropagation()
      const refuse = this.isClosed()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = refuse ? 'none' : 'copy'
      this.paintDrop(true)
      if (this.dropTimer) clearTimeout(this.dropTimer)
      this.dropTimer = setTimeout(() => this.paintDrop(false), 400)
    }

    private onDragLeave(ev: DragEvent): void {
      if (!dragHasFiles(ev.dataTransfer?.types)) return
      const r = this.element.getBoundingClientRect()
      if (ev.clientX <= r.left || ev.clientX >= r.right || ev.clientY <= r.top || ev.clientY >= r.bottom) this.paintDrop(false)
    }

    private onDrop(ev: DragEvent): void {
      const dt = ev.dataTransfer
      if (!dt || !dragHasFiles(dt.types)) return
      ev.preventDefault()
      ev.stopPropagation()
      this.paintDrop(false)
      if (this.isClosed()) { this.toast(DROP_CLOSED); return }
      if (!this.answer || !this.composerSlot.contains(this.composer.element)) { this.toast('O canal ainda está carregando. Solte de novo em instantes.'); return }
      const r = this.composer.drop(dt)
      if (r === 'off') this.toast('Ninguém ouve ainda: junte um agente ao canal para anexar arquivos.')
      else if (r === 'no-file') this.toast(DROP_NO_FILE)
    }

    private paintDrop(on: boolean): void {
      if (this.dropTimer && !on) { clearTimeout(this.dropTimer); this.dropTimer = undefined }
      if (!on) { this.dropZone.hidden = true; return }
      const refuse = this.isClosed()
      this.dropZone.classList.toggle('refuse', refuse)
      const [title, sub] = this.dropZone.querySelectorAll('p')
      title!.textContent = refuse ? 'Canal encerrado' : DROP_TITLE(this.answer?.channel.name ?? '')
      sub!.textContent = refuse ? DROP_CLOSED : DROP_SUB
      this.dropZone.hidden = false
    }

    get kind(): ChannelHost['kind'] { return this.host?.kind ?? 'pane' }

    init(p: GroupPanelPartInitParameters): void {
      const api = p.api
      this.attach({
        kind: 'pane', id: api.id,
        title: () => api.title,
        setTitle: t => api.setTitle(t),
        showMenu: (x, y, opener) => ui.panes.showTabMenu(api.id, x, y, opener),
      }, String((p.params as { channelId?: string }).channelId ?? channelIdOfPane(api.id)))
    }

    /** Builds the view for `channelId` on `host`, a tab (`init`) or an embedded place (`mountEmbed`). */
    attach(host: ChannelHost, channelId: string, opts: EmbedOptions = {}): void {
      this.host = host
      this.membersHost = opts.membersHost
      this.channelId = channelId
      this.element.dataset.channel = this.channelId
      const k = kept.get(this.channelId)
      if (k) { this.timeline = k.timeline; this.tallies = new Map(k.tallies); this.pollStates = new Map(k.polls); this.floor = k.floor; this.stick = k.stick; this.lastTop = k.scrollTop; this.pendingScroll = k.stick ? 'end' : k.scrollTop }
      else this.pendingScroll = 'end'
      try { this.recents = readRecents(localStorage.getItem(RECENTS_KEY)) } catch { this.recents = [] }
      live.add(this)

      this.newBar.type = 'button'
      this.newBar.addEventListener('click', () => this.onBar())
      this.composerSlot.dataset.slot = 'composer'
      this.foot.append(this.composerSlot)
      this.toastEl.hidden = true
      this.toastEl.setAttribute('role', 'status')
      this.announceEl.setAttribute('role', 'status')
      this.announceEl.setAttribute('aria-live', 'polite')
      this.announceEl.setAttribute('aria-atomic', 'true')
      // The "novas" bar floats over the end of the conversation only (not over the speaking box under it): the two share a positioned box.
      const wrap = el('div', 'ch-msgs-wrap')
      wrap.append(this.msgs, this.newBar)
      this.conv.append(wrap, this.toastEl, this.announceEl, this.muteBox, this.foot)
      this.buildHoverBar()
      this.msgs.addEventListener('mouseover', ev => {
        const m = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ch-msg') : null
        if (m) this.showBar(m)
      })
      this.msgs.addEventListener('mouseleave', () => { if (!this.hb.contains(document.activeElement)) this.hb.remove() })
      // A right click on a speech: the same reactions as the bar, and copy (the pills and the links have their own menus).
      this.msgs.addEventListener('contextmenu', ev => {
        // A poll's card: its own menu (vote, close, copy). The reason's field keeps the browser's menu (paste).
        const pr = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ch-prow') : null
        if (pr) {
          if (ev.target instanceof HTMLInputElement) return
          ev.preventDefault()
          if (performance.now() - this.keyMenuAt < 400) return
          this.openPollMenu(Number(pr.dataset.seq), ev.clientX, ev.clientY)
          return
        }
        const m = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ch-msg') : null
        if (!m) return
        ev.preventDefault()
        // The menu key already opened the menu (onMsgKey): its `contextmenu` event is the same gesture.
        if (performance.now() - this.keyMenuAt < 400) return
        this.openMsgMenu(Number(m.dataset.seq), ev.clientX, ev.clientY)
      })
      // The keyboard: the arrows walk the speeches, R and 1-5 react, the menu key opens the speech's menu (see onMsgKey).
      this.msgs.addEventListener('keydown', ev => this.onMsgKey(ev))
      this.msgs.addEventListener('focusin', ev => {
        const m = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ch-msg') : null
        if (!m) return
        this.lastFocusSeq = Number(m.dataset.seq)
        if (ev.target === m) this.showBar(m)
      })
      this.side.id = `ch-members-${this.channelId}`
      this.fold.type = 'button'
      this.fold.hidden = true
      this.fold.setAttribute('aria-controls', this.side.id)
      this.fold.addEventListener('click', () => this.toggleMembers())
      // The conversation is a log: the lines of system ("juntou", "calou", "tirou") are the spoken confirmation of each gesture. It takes the
      // focus (Tab) so the keys can scroll it.
      this.msgs.setAttribute('role', 'log')
      this.msgs.setAttribute('aria-live', 'polite')
      this.msgs.setAttribute('aria-relevant', 'additions')
      this.msgs.setAttribute('aria-label', 'Conversa do canal')
      this.msgs.tabIndex = 0
      // The Tab visits the strip or the column of members BEFORE the conversation (bar, members, conversation, box): the DOM has that
      // order, and the CSS puts the column on the right in the wide composition and the strip and list above the conversation in the narrow one.
      if (this.membersHost) {
        this.body.append(this.fold, this.conv)
        this.membersHost.append(this.side)
      } else this.body.append(this.fold, this.side, this.conv)
      this.element.addEventListener('focusin', ev => { if (!this.side.contains(ev.target as Node)) this.memberReturn = undefined })
      this.overlays = new MutationObserver(recs => {
        for (const r of recs) {
          for (const n of r.removedNodes) {
            if (!(n instanceof HTMLElement) || !(n.id === 'ctx-menu' || n.tagName === 'DIALOG')) continue
            for (const b of this.side.querySelectorAll('[aria-haspopup][aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false')
            // After the closing code ran (the core gives the focus back to its opener itself when that is still on the page).
            // A dialog closing ends the gesture (a menu may still be followed by its dialog, so the mark stays after it).
            const ended = n.tagName === 'DIALOG'
            setTimeout(() => { this.returnFocus(); this.returnMsgFocus(); if (ended) this.memberReturn = undefined }, 0)
            return
          }
        }
      })
      this.overlays.observe(document.body, { childList: true })
      this.head.append(this.titleBox, this.bar)
      this.element.append(this.head, this.body)
      const dropBox = el('div', 'ch-drop-box')
      const dropIll = el('span', 'ch-drop-ill')
      dropIll.append(glyph('paperclip'))
      dropBox.append(dropIll, el('p', 'ch-drop-t'), el('p', 'ch-drop-s'))
      this.dropZone.append(dropBox)
      this.dropZone.hidden = true
      this.dropZone.setAttribute('aria-hidden', 'true')
      this.element.append(this.dropZone)
      this.element.addEventListener('dragenter', ev => this.onDrag(ev))
      this.element.addEventListener('dragover', ev => this.onDrag(ev))
      this.element.addEventListener('dragleave', ev => this.onDragLeave(ev))
      this.element.addEventListener('drop', ev => this.onDrop(ev))
      this.buildBar()

      this.msgs.addEventListener('scroll', () => this.onScroll())
      this.ro = new ResizeObserver(() => this.onResize())
      this.ro.observe(this.element)
      this.membersOpen = this.element.clientWidth === 0 || this.element.clientWidth >= NARROW_PX
      // The person may see the end of the conversation by the window coming back to the front, with no scroll or line.
      window.addEventListener('focus', this.onWatch)
      document.addEventListener('visibilitychange', this.onWatch)
      this.subs.push(marks.onDidChange(() => {
        this.paintNewBar()
        // A reaction that asks her may arrive while its speech is in view: it is seen at once.
        if (marks.asksOf(this.channelId).length > 0) this.checkSeen()
        // The orange separator goes when the person sees the line (the same `seen` rule as the marks).
        const first = marks.of(this.channelId).firstToMe
        if (first !== this.separatorAt) this.paintMsgs()
      }))
      // The emblem the person put on a member's tab shows at the right of its row: redraw the list when one changes.
      this.subs.push(ui.panes.onDidChangeMarks(paneId => {
        if (this.disposed || !this.answer) return
        if (paneId === undefined || this.answer.members.some(m => m.id === paneId)) { this.paintMembers(); this.membersChanged() }
      }))
      this.paint()
      void this.load()
      marks.paneChanged(this.channelId)
    }

    private readonly onWatch = (): void => this.checkSeen()

    dispose(): void {
      this.disposed = true
      window.removeEventListener('focus', this.onWatch)
      document.removeEventListener('visibilitychange', this.onWatch)
      if (this.membersTimer) clearTimeout(this.membersTimer)
      if (this.toastTimer) clearTimeout(this.toastTimer)
      if (this.dropTimer) clearTimeout(this.dropTimer)
      this.viewer.close(false)
      this.stopPollTimer()
      this.closePicker(false)
      this.ro?.disconnect()
      this.contentRo?.disconnect()
      this.overlays?.disconnect()
      for (const s of this.subs) s.dispose()
      this.memberListeners.clear()
      live.delete(this)
      // A pane that moved to another desk is rebuilt: its place is what the new one starts from.
      // (The scroll is read from the last scroll event: by now the element has left the page and says 0.)
      if (this.loaded) keep(this.channelId, { timeline: this.timeline, tallies: this.tallies, polls: this.pollStates, scrollTop: this.lastTop, stick: this.stick, floor: this.floor })
      marks.paneChanged(this.channelId)
    }

    /**
     * The person sees the end of the conversation: the pane is shown (active tab of the visible desk), the window is in front and
     * the view is at the end. Then up to the newest line is seen: the marks go and the daemon is told (`seen`).
     */
    private checkSeen(): void {
      if (!this.loaded || this.disposed || !this.visible()) return
      if (!document.hasFocus() || document.visibilityState !== 'visible') return
      const asks = marks.asksOf(this.channelId)
      if (this.stick) {
        // A reaction newer than the last speech is no hole in the conversation: it is seen with the end only when its speech is in view.
        let upTo = this.timeline.last
        for (const a of asks) if (a.seq > upTo && this.onScreen(a.on)) upTo = a.seq
        marks.viewed(this.channelId, upTo)
      }
      // Reading above the end: an ask whose speech is in view is seen too.
      for (const a of marks.asksOf(this.channelId)) if (this.onScreen(a.on)) marks.attended(this.channelId, a.seq)
    }

    // ---------- data ----------

    private ask<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      return ui.daemon.request<T>(name, { channel: this.channelId, ...args })
    }

    private async load(): Promise<void> {
      try {
        const [page, members] = await Promise.all([
          this.ask<HistoryPage>('history', { limit: PAGE_SIZE }),
          this.ask<MembersAnswer>('members'),
        ])
        if (this.disposed) return
        const heldFirst = this.timeline.lines[0]?.seq
        this.timeline = this.timeline.lines.length > 0 ? mergeNewest(this.timeline, page) : applyPage(this.timeline, page, false)
        this.noteFloor(heldFirst, page.last)
        this.absorb(page)
        this.absorbPolls(page)
        this.answer = members
        this.error = ''
        this.loaded = true
        this.syncTitle()
        const early = this.early
        this.early = []
        for (const line of early) {
          const r = applyLine(this.timeline, line)
          if (r.added) this.timeline = r.timeline
        }
        // The reactions heard meanwhile go over the page's sums (a repeat changes nothing).
        const earlyReactions = this.earlyReactions
        this.earlyReactions = []
        for (const l of earlyReactions) this.applyReactionLine(l, false)
        // The polls heard meanwhile: only what is newer than the page (its own states already hold the rest).
        const earlyPolls = this.earlyPolls
        this.earlyPolls = []
        for (const ev of earlyPolls) if (ev.line.seq > page.last) this.heardPoll(ev, false)
      } catch (e) {
        if (this.disposed) return
        const code = (e as { code?: string }).code
        this.error = code === 'unknown-channel' ? 'Este canal não existe mais.' : `Não consegui ler o canal: ${(e as Error).message}`
      }
      this.paint()
      if (this.loaded && this.stick && this.pendingScroll === undefined) this.scrollEnd()
      this.checkSeen()
      if (this.answer) this.membersChanged()
    }

    private async refreshMembers(): Promise<void> {
      try {
        const members = await this.ask<MembersAnswer>('members')
        if (this.disposed) return
        this.answer = members
        if (this.isClosed()) this.closePicker(false)
        this.syncTitle()
        this.paintHead()
        this.paintMembers()
        this.paintSide()
        this.paintBar()
        this.paintMuteBar()
        this.paintFoot()
        if (this.noMembers() !== this.drewNoMembers || this.isClosed() !== this.drewClosed) this.paintMsgs()
        else this.paintPolls()
        this.focusJoinIfEmptied()
        this.membersChanged()
      } catch { /* the next event asks again */ }
    }

    /** The members as the column draws them, for an embedded view's host. */
    memberList(): MemberRow[] { return this.answer ? memberRows(this.answer, id => ui.panes.personEmblem(id), noDesk) : [] }

    onDidChangeMembers(listener: () => void): { dispose(): void } {
      this.memberListeners.add(listener)
      return { dispose: () => { this.memberListeners.delete(listener) } }
    }

    private membersChanged(): void {
      for (const l of [...this.memberListeners]) { try { l() } catch (e) { console.error('channel members listener', e) } }
    }

    /** The keyboard goes to the conversation. */
    focusView(): void { this.msgs.focus() }

    /** The members' column (taken out of a host it was given to when the embedded view goes). */
    sideElement(): HTMLElement { return this.side }

    private scheduleMembers(): void {
      if (this.membersTimer || this.disposed) return
      this.membersTimer = setTimeout(() => { this.membersTimer = undefined; void this.refreshMembers() }, MEMBERS_REFRESH_MS)
    }

    /**
     * The page of the newest lines (first load or a catch-up) fixes the floor when it REPLACED what was held (the held first line was
     * not kept); the bound `last - PAGE_SIZE + 1` is never below the page's true start, so no `seq` is skipped (a few are asked twice).
     */
    private noteFloor(heldFirst: number | undefined, last: number): void {
      const first = this.timeline.lines[0]?.seq
      if (heldFirst === undefined || (first !== undefined && first > heldFirst)) this.floor = Math.max(1, last - PAGE_SIZE + 1)
    }

    /** The most pages of nothing but reactions skipped in one go (each reaction takes a number, so a long run is possible but bounded). */
    private static readonly OLDER_SKIP_MAX = 40

    private async loadOlder(): Promise<void> {
      if (olderCursor(this.timeline, this.floor) === undefined || this.loadingOlder || this.disposed) return
      this.loadingOlder = true
      const m = this.msgs
      const oldHeight = m.scrollHeight
      const oldTop = m.scrollTop
      try {
        // A page that is all reactions brings no line (they come apart, as sums): the next one is asked at once, from the floor.
        for (let i = 0; i < ChannelPane.OLDER_SKIP_MAX; i++) {
          const before = olderCursor(this.timeline, this.floor)
          if (before === undefined) break
          const page = await this.ask<HistoryPage>('history', { before, limit: PAGE_SIZE })
          if (this.disposed) return
          this.floor = Math.max(1, before - PAGE_SIZE)
          this.timeline = applyPage(this.timeline, page, true)
          this.absorb(page)
          this.absorbPolls(page)
          if (page.lines.length > 0 || !page.more) break
        }
        this.paintMsgs()
        // The lines went on top: what the person was reading stays where it was.
        m.scrollTop = oldTop + (m.scrollHeight - oldHeight)
      } catch { /* the "Ver anteriores" button tries again */ }
      this.loadingOlder = false
    }

    onLine(ev: LineEvent): void {
      // Before the first answer the line may or may not be in it: keep it, and apply it when the page is in (a repeat is ignored).
      if (!this.loaded) { if (this.early.length < PAGE_SIZE * 4) this.early.push(ev.line); return }
      const r = applyLine(this.timeline, ev.line, this.quiet)
      if (!r.added) return
      this.timeline = r.timeline
      for (const q of this.quiet) if (q <= this.timeline.last) this.quiet.delete(q)
      if (r.gap) { void this.catchUp(); return }
      if (!this.stick) this.unread++
      this.paintMsgs()
      if (this.stick) this.scrollEnd()
      this.paintNewBar()
      this.scheduleMembers()
      this.checkSeen()
    }

    onChannel(): void { if (this.loaded) void this.refreshMembers() }

    /** A reaction heard live: it only changes the pills of its message (never a repaint of the conversation, never an unread). */
    onReaction(ev: ReactionEvent): void {
      if (!this.loaded) { if (this.earlyReactions.length < EARLY_REACTIONS_MAX) this.earlyReactions.push(ev.line); return }
      this.applyReactionLine(ev.line, true)
    }

    private applyReactionLine(l: Line, live: boolean): void {
      const seq = l.react?.seq
      if (seq === undefined || l.kind !== 'reaction') return
      if (live && l.seq > this.timeline.last && this.quiet.size < 1000) this.quiet.add(l.seq)
      // A message the pane does not hold gets its sum with the older page that brings it.
      const first = this.timeline.lines[0]?.seq
      if (first === undefined || seq < first) return
      const before = this.tallies.get(seq)
      const next = applyReaction(before, l)
      if (next.length > 0) this.tallies.set(seq, next)
      else this.tallies.delete(seq)
      this.paintRx(seq)
      // Said aloud in one short sentence when somebody else changed it live (the person's own gesture was said by `react`).
      if (live && l.from.id !== USER && JSON.stringify(before ?? []) !== JSON.stringify(next) && l.react) {
        const sense = FIVE.find(f => reactionKey(f.emoji) === reactionKey(l.react!.emoji))
        this.announce(announceText({ who: l.from.name, emoji: l.react.emoji, ...(sense ? { name: sense.name } : {}), op: l.react.op, author: this.authorOf(seq) }))
      }
    }

    /** "Guga" / "claude · nic" / "você": whose speech it is, as the reaction's sentence names it. */
    private authorOf(seq: number): string {
      const line = this.timeline.lines.find(l => l.seq === seq)
      if (!line) return 'outra pessoa'
      return line.from.id === USER || line.from.role === 'moderator' ? 'você' : line.from.name
    }

    /** One polite sentence in the live region (cleared first so the same sentence twice is heard twice). */
    private announce(text: string): void {
      this.announced = text
      this.announceEl.textContent = ''
      setTimeout(() => { if (!this.disposed && this.announced === text) this.announceEl.textContent = text }, 30)
    }

    private rememberRecent(emoji: string): void {
      const next = pushRecent(this.recents, emoji)
      if (next.join() === this.recents.join()) return
      this.recents = next
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)) } catch { /* storage unavailable: the recents stay for this pane */ }
    }

    // ---------- polls ----------

    /**
     * A `poll` event. The opening is a new line of the conversation (counted as news, like a speech); a vote and the close take a
     * number and are no line (like a reaction): they only change their card, never the "novas" count or a repaint of the rest.
     */
    onPoll(ev: PollEvent): void {
      if (!this.loaded) { if (this.earlyPolls.length < EARLY_REACTIONS_MAX) this.earlyPolls.push(ev); return }
      this.heardPoll(ev, true)
    }

    private heardPoll(ev: PollEvent, live: boolean): void {
      const l = ev.line
      const hit = applyPoll(this.pollStates, ev)
      if (l.kind === 'poll') {
        this.onLine({ channelId: ev.channelId, room: ev.room, line: l })
        this.syncPollTimer()
        return
      }
      if (l.seq > this.timeline.last && this.quiet.size < 1000) this.quiet.add(l.seq)
      if (!hit) return
      this.paintPoll(hit.seq)
      this.syncPollTimer()
      // Said aloud in one sentence: who voted in what, and when it closes (not each minute). Her own vote was said by `votePoll`.
      if (!live) return
      if (hit.what === 'close') {
        const c = this.cardFor(hit.seq)
        if (c) this.announce(`Enquete de ${c.author} fechou: ${c.clock}. ${c.progressText}.`)
      } else if (hit.what === 'vote' && l.kind === 'vote' && l.vote && l.from.id !== USER) {
        const text = this.cardFor(hit.seq)?.options.find(o => o.n === l.vote!.option)?.text
        if (text !== undefined) this.announce(voteAnnounce(l.from.name, text))
      }
    }

    /** The states a page brings replace the held ones of its poll lines. */
    private absorbPolls(page: Pick<HistoryPage, 'lines' | 'polls'>): void {
      const by = new Map((page.polls ?? []).map(p => [p.seq, p] as const))
      for (const l of page.lines) {
        if (l.kind !== 'poll') continue
        const s = by.get(l.seq)
        if (s) this.pollStates.set(l.seq, s)
        else this.pollStates.delete(l.seq)
      }
      this.syncPollTimer()
    }

    private cardFor(seq: number): PollCard | undefined {
      const line = this.timeline.lines.find(l => l.seq === seq)
      if (!line) return undefined
      const pending = this.pollInput.get(seq)?.pending
      return cardOf(line, this.pollStates.get(seq), {
        now: Date.now(), readOnly: this.isClosed(),
        ...(this.answer ? { members: new Set(this.answer.members.map(m => m.id)) } : {}),
        ...(pending !== undefined ? { pending } : {}),
        whyOf: id => this.deafWhy(id),
      })
    }

    /** Why a member does not hear now, as far as `members` says (a sleeping desk, a stopped process, the guia with the person). */
    private deafWhy(id: string): PollMissingWhy | undefined {
      const m = this.answer?.members.find(x => x.id === id)
      if (!m) return undefined
      return m.path === 'away' ? (m.asleep ? 'asleep' : 'stopped') : m.path === 'wait' ? 'with-user' : undefined
    }

    /** The card's row is a group named by the whole card (the card inside it carries no name of its own: nothing is read twice). */
    private nameRow(row: HTMLElement, card: PollCard): void {
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', cardAria(card))
    }

    private hasOpenPoll(): boolean {
      for (const s of this.pollStates.values()) if (s.open !== undefined && s.result === undefined) return true
      return false
    }

    /** One timer for the pane, only while a poll is open; it changes the text of the clocks, never repaints a card. */
    private syncPollTimer(): void {
      if (this.disposed || !this.hasOpenPoll()) { this.stopPollTimer(); return }
      this.pollTimer ??= setInterval(() => this.tickPolls(), 1000)
    }

    private stopPollTimer(): void {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined }
    }

    private tickPolls(): void {
      const now = Date.now()
      for (const clock of this.msgs.querySelectorAll<HTMLElement>('.ch-poll[data-state="open"] .ch-pclock')) {
        const cd = countdown(Number(clock.dataset.closes), now)
        const t = clock.querySelector('.t')
        if (t && t.textContent !== cd.text) {
          t.textContent = cd.text
          // The name read when the card takes the focus follows the clock (it changes once a minute, a second a time in the last one).
          const row = clock.closest<HTMLElement>('.ch-prow')
          const card = row ? this.cardFor(Number(row.dataset.seq)) : undefined
          if (row && card) this.nameRow(row, card)
        }
        clock.classList.toggle('soon', cd.soon)
      }
    }

    /** Repaints one card in place: no other row is touched; the field being typed in and its caret are kept. */
    private paintPoll(seq: number): void {
      const row = this.msgs.querySelector<HTMLElement>(`.ch-prow[data-seq="${seq}"]`)
      const old = row?.querySelector<HTMLElement>(':scope > .ch-poll')
      const card = this.cardFor(seq)
      if (!row || !old || !card) return
      const a = document.activeElement
      const held = a instanceof HTMLElement && old.contains(a) ? a : undefined
      const key = held?.dataset.key
      const caret = held instanceof HTMLInputElement ? [held.selectionStart, held.selectionEnd] as const : undefined
      const next = this.pollCardEl(card)
      old.replaceWith(next)
      this.nameRow(row, card)
      if (held) {
        const again = key !== undefined ? next.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null
        // What held the focus is gone (the reason's field after sending or Esc, an option of a card that closed): the card takes it.
        if (!again) { row.focus({ preventScroll: true }); return }
        again.focus({ preventScroll: true })
        if (again instanceof HTMLInputElement && caret?.[0] != null) again.setSelectionRange(caret[0], caret[1] ?? caret[0])
      }
    }

    private paintPolls(): void {
      for (const row of this.msgs.querySelectorAll<HTMLElement>('.ch-prow')) this.paintPoll(Number(row.dataset.seq))
    }

    private inputOf(seq: number): PollInput {
      let i = this.pollInput.get(seq)
      if (!i) this.pollInput.set(seq, (i = { text: '' }))
      return i
    }

    /** The person picks an option: it votes at once; the "não ok" asks its reason (highlighted, optional); a reason typed goes with it. */
    private chooseOption(seq: number, n: number): void {
      const c = this.cardFor(seq)
      if (!c?.canVote) return
      const input = this.inputOf(seq)
      const typed = input.reasonFor !== undefined ? input.text.trim() : ''
      if (c.mineOption === n && typed === '' && !isNoOption(c.kind, n)) return
      void this.votePoll(seq, n, typed === '' ? undefined : typed)
      if (isNoOption(c.kind, n) && typed === '') { input.reasonFor = n; input.text = '' } else { delete input.reasonFor; input.text = '' }
      this.paintPoll(seq)
      if (input.reasonFor !== undefined) this.msgs.querySelector<HTMLInputElement>(`.ch-prow[data-seq="${seq}"] .ch-pr-in`)?.focus({ preventScroll: true })
    }

    /** Opens the reason's field (menu "Votar com motivo…"): on her vote, or waiting for her to pick an option. */
    private openReason(seq: number): void {
      const c = this.cardFor(seq)
      if (!c?.canVote) return
      const input = this.inputOf(seq)
      input.reasonFor = c.mineOption ?? 0
      input.text = c.mineReason ?? ''
      this.paintPoll(seq)
      this.msgs.querySelector<HTMLInputElement>(`.ch-prow[data-seq="${seq}"] .ch-pr-in`)?.focus({ preventScroll: true })
    }

    private async votePoll(seq: number, option: number, reason?: string): Promise<void> {
      if (this.isClosed() || this.disposed) return
      const input = this.inputOf(seq)
      input.pending = option
      this.paintPoll(seq)
      try {
        const r = await this.ask<{ poll: PollOpenView; result?: PollState['result']; closedAt?: string }>('vote', { poll: seq, vote: option, ...(reason !== undefined ? { reason } : {}) })
        // The answer may come before the event: the card already shows it (the event repeats it, which changes nothing).
        const held = this.pollStates.get(seq)
        if (!held?.result) this.pollStates.set(seq, r.result ? { seq, result: r.result, ...(r.closedAt ? { closedAt: r.closedAt } : {}) } : { seq, open: r.poll })
        const c = this.cardFor(seq)
        const text = c?.options.find(o => o.n === option)?.text
        if (text !== undefined) this.announce(`Você votou em ${text}.`)
      } catch (e) {
        this.toast(pollRefusalText((e as { code?: string }).code))
      } finally {
        delete input.pending
        if (!this.disposed) { this.paintPoll(seq); this.syncPollTimer() }
      }
    }

    /** Sends the reason typed on the vote she already has (or on the option the field waits for). */
    private sendReason(seq: number): void {
      const c = this.cardFor(seq)
      const input = this.inputOf(seq)
      const n = input.reasonFor || c?.mineOption
      if (!c?.canVote || n === undefined || n === 0) { this.toast('Escolha uma opção para votar com o motivo.'); return }
      const text = input.text.trim()
      delete input.reasonFor
      input.text = ''
      void this.votePoll(seq, n, text === '' ? undefined : text)
    }

    private closeReason(seq: number): void {
      const input = this.inputOf(seq)
      delete input.reasonFor
      input.text = ''
      this.paintPoll(seq)
    }

    /** Closes a poll before its time (its author, or the person): she is asked first. */
    private async closePoll(seq: number): Promise<void> {
      const c = this.cardFor(seq)
      if (!c?.canClose) return
      const a = await ui.dialogs.ask(closePollDialog(c)).catch(() => undefined)
      // The dialog gave the focus back to nothing (or to the page): the card takes it, unless the person went somewhere else.
      const back = (): void => {
        setTimeout(() => {
          const f = document.activeElement
          if (!this.disposed && (f === null || f === document.body)) this.focusPoll(seq)
        }, 60)
      }
      if (a?.choice !== 'close' || this.disposed) { back(); return }
      try {
        const r = await this.ask<{ result: PollState['result']; closedAt: string }>('poll-close', { poll: seq })
        if (r.result && !this.pollStates.get(seq)?.result) { this.pollStates.set(seq, { seq, result: r.result, closedAt: r.closedAt }); this.paintPoll(seq); this.syncPollTimer() }
      } catch (e) {
        this.toast(pollRefusalText((e as { code?: string }).code))
      }
      back()
    }

    /** The card's row takes the keyboard focus (nothing scrolls unless it is out of view). */
    private focusPoll(seq: number): void {
      const row = this.msgs.querySelector<HTMLElement>(`.ch-prow[data-seq="${seq}"]`)
      row?.focus({ preventScroll: true })
      row?.scrollIntoView({ block: 'nearest' })
    }

    /** The menu of a card (right click, "⋯"): the votes with their numbers, the reason, close, and copy. Read only keeps copy. */
    private openPollMenu(seq: number, x: number, y: number): void {
      const c = this.cardFor(seq)
      const line = this.timeline.lines.find(l => l.seq === seq)
      if (!c || !line) return
      const ref = `${this.answer?.channel.name ?? this.channelId}#${seq}`
      // After the menu closes the focus goes back to the card it was opened from (like a speech's menu).
      this.menuReturn = { seq, until: Date.now() + JOIN_FOCUS_MS }
      const rows: ContextMenuRow[] = [{ heading: `Enquete de ${c.author} · ${c.clock}` }]
      if (c.canVote) {
        for (const o of c.options) rows.push({ icon: '', label: `Votar "${o.text}"`, hint: String(o.n), checked: c.mineOption === o.n, run: () => this.chooseOption(seq, o.n) })
        rows.push({ icon: '', label: 'Votar com motivo…', hint: 'M', run: () => this.openReason(seq) })
      }
      if (c.canClose) {
        rows.push('sep')
        rows.push({ icon: ICON.close, label: 'Encerrar agora…', hint: c.mineAuthor ? 'autora ou você' : 'você', danger: true, run: () => { void this.closePoll(seq) } })
      }
      rows.push('sep')
      rows.push({ icon: 'clipboard-text', label: 'Copiar pergunta', run: () => this.copy(c.question) })
      rows.push({ icon: 'clipboard-text', label: 'Copiar referência', hint: ref, run: () => this.copy(ref) })
      ui.menus.context(x, y, rows as ContextMenuEntry[])
    }

    /** The card: question, options with bar and count, who voted for what, who is missing, the clock; read only when it cannot be voted. */
    private pollCardEl(c: PollCard): HTMLElement {
      const closed = c.state === 'closed'
      const box = el('div', `ch-poll${closed ? ' done' : ''}`)
      box.dataset.seq = String(c.seq)
      box.dataset.state = c.state
      const ph = el('div', 'ch-ph')
      const tag = el('span', `ch-ptag${closed ? ' done' : ''}`)
      tag.append(glyph(closed ? 'check' : 'checks'), closed ? 'fechada' : 'enquete')
      ph.append(tag, el('span', 'ch-pkind', c.kindLabel))
      if (c.waitsYou) ph.append(el('span', 'ch-pwaits', 'espera seu voto'))
      const clock = el('span', `ch-pclock${c.soon ? ' soon' : ''}`)
      clock.dataset.closes = String(c.closesAt)
      clock.append(glyph(closed ? 'lock' : 'clock'), el('span', 't', c.clock))
      const more = this.actionBtn('ch-pmore', 'Mais ações da enquete', 'dots-three', () => {
        const b = more.getBoundingClientRect()
        this.openPollMenu(c.seq, b.left, b.bottom)
      })
      more.setAttribute('aria-haspopup', 'menu')
      more.dataset.key = 'more'
      ph.append(clock, more)
      box.append(ph, el('p', 'q', c.question))
      if (c.unknown) { box.append(el('div', 'ch-pmiss', 'Esta enquete fechou há muito tempo: o resultado não está mais à mão.')); return box }
      const list = el('div', 'ch-popts')
      list.setAttribute('role', 'group')
      list.setAttribute('aria-label', c.canVote ? 'Opções: teclas 1 a ' + c.options.length + ' votam' : 'Opções')
      for (const o of c.options) {
        const row = c.canVote ? el('button', 'ch-opt') : el('div', 'ch-opt ro')
        if (row instanceof HTMLButtonElement) {
          row.type = 'button'
          row.setAttribute('aria-pressed', String(o.mine))
          row.addEventListener('click', ev => { ev.stopPropagation(); this.chooseOption(c.seq, o.n) })
        }
        if (o.mine) row.classList.add('mine')
        if (o.winner) row.classList.add('win')
        row.dataset.n = String(o.n)
        row.dataset.key = `opt${o.n}`
        const bar = el('span', 'bar')
        bar.style.width = `${o.pct}%`
        const faces = el('span', 'faces')
        for (const v of o.voters) {
          const f = el('span', `ch-face${v.mine ? ' me' : ''}`, (v.name.trim()[0] ?? '?').toUpperCase())
          if (!v.mine) hueStyle(f, agentHue(v.id))
          f.title = v.reason ? `${v.name}: "${v.reason}"` : v.name
          faces.append(f)
        }
        row.append(bar, el('kbd', 'k', String(o.n)), el('span', 'lab', o.text), faces, el('span', 'n', String(o.count)))
        row.setAttribute('aria-label', `${o.text}: ${o.count} ${o.count === 1 ? 'voto' : 'votos'}${o.voters.length ? ` (${o.voters.map(v => v.name).join(', ')})` : ''}${o.mine ? '. Seu voto.' : ''}`)
        list.append(row)
      }
      box.append(list)
      // Open voting: who voted for what and why, in words (the faces are only the count's company; narrow hides them).
      const whys = c.options.flatMap(o => o.voters.filter(v => v.reason).map(v => ({ o, v })))
      for (const { o, v } of whys) box.append(el('div', 'ch-why', `${v.name} (${o.text}): "${v.reason}"`))
      const input = this.pollInput.get(c.seq)
      if (c.canVote && input?.reasonFor !== undefined) box.append(this.reasonEl(c, input))
      const prog = el('div', 'ch-prog')
      const track = el('span', 'track')
      const fill = el('i', '')
      fill.style.width = `${c.progress}%`
      if (closed) fill.classList.add(c.tie ? 'tie' : 'full')
      track.append(fill)
      prog.append(el('span', 'ch-ptext', c.progressText), track)
      box.append(prog)
      if (c.missing.length > 0) {
        const miss = el('div', 'ch-pmiss')
        miss.append(closed ? 'Sem resposta: ' : 'Faltam: ')
        c.missing.forEach((m, i) => {
          if (i > 0) miss.append(' · ')
          miss.append(el('b', '', m.you ? 'Você' : m.name))
          if (m.why) miss.append(` (${m.you ? 'não respondeu' : m.why})`)
        })
        box.append(miss)
      }
      return box
    }

    /** The reason's field: one line, up to 140 characters; under the "não ok" it asks with emphasis and may stay empty. */
    private reasonEl(c: PollCard, input: PollInput): HTMLElement {
      const no = input.reasonFor !== undefined && isNoOption(c.kind, input.reasonFor)
      const box = el('div', `ch-reason${no ? ' ask' : ''}`)
      const field = el('input', 'ch-pr-in')
      field.type = 'text'
      field.maxLength = POLL_REASON_MAX
      field.value = input.text
      field.dataset.key = 'reason'
      field.placeholder = no ? 'Por que não? (opcional, mas ajuda quem perguntou)' : input.reasonFor === 0 ? 'Escreva o motivo e escolha uma opção' : 'Motivo (opcional)'
      field.setAttribute('aria-label', 'Motivo do voto, opcional, até 140 caracteres')
      const count = el('small', 'ch-pr-n', `${input.text.length} / ${POLL_REASON_MAX}`)
      field.addEventListener('input', () => { input.text = field.value; count.textContent = `${field.value.length} / ${POLL_REASON_MAX}` })
      field.addEventListener('keydown', ev => {
        ev.stopPropagation()
        if (ev.key === 'Enter') { ev.preventDefault(); this.sendReason(c.seq) }
        else if (ev.key === 'Escape') { ev.preventDefault(); this.closeReason(c.seq) }
      })
      const send = el('button', 'ch-btn primary', 'Enviar')
      send.type = 'button'
      send.dataset.key = 'send'
      send.addEventListener('click', ev => { ev.stopPropagation(); this.sendReason(c.seq) })
      box.append(field, count, send)
      return box
    }

    /** The sums a page of the history brings replace the held ones of its messages. */
    private absorb(page: Pick<HistoryPage, 'lines' | 'reactions'>): void {
      const sums = new Map((page.reactions ?? []).map(r => [r.seq, r.tallies] as const))
      for (const l of page.lines) {
        if (l.kind !== 'message') continue
        const t = sums.get(l.seq)
        if (t) this.tallies.set(l.seq, t)
        else this.tallies.delete(l.seq)
      }
    }

    private async catchUp(): Promise<void> {
      try {
        const page = await this.ask<HistoryPage>('history', { limit: PAGE_SIZE })
        if (this.disposed) return
        // Counted in lines held, not in `seq`s: a reaction takes a number and is not news.
        const before = this.timeline.last
        const heldFirst = this.timeline.lines[0]?.seq
        this.timeline = mergeNewest(this.timeline, page)
        this.noteFloor(heldFirst, page.last)
        this.absorb(page)
        this.absorbPolls(page)
        this.quiet.clear()
        if (!this.stick) this.unread += this.timeline.lines.filter(l => l.seq > before).length
        this.paintMsgs()
        if (this.stick) this.scrollEnd()
        this.paintNewBar()
        this.checkSeen()
      } catch { /* the next line asks again */ }
    }

    // ---------- scroll ----------

    private visible(): boolean { return this.msgs.clientHeight > 0 }

    private scrollEnd(): void {
      if (this.visible()) this.msgs.scrollTop = this.msgs.scrollHeight
      else this.pendingScroll = 'end'
    }

    private toEnd(): void {
      this.stick = true
      this.unread = 0
      this.scrollEnd()
      this.paintNewBar()
      this.checkSeen()
    }

    /**
     * The bar's click: with lines for her unseen, first to the first of them (centred); once it is on screen, or when it is not held,
     * to the end (which is where they are seen).
     */
    private onBar(): void {
      if (this.barText().ask) {
        // A poll that waits for her vote comes first: its card is brought into view, marked for a moment and takes the focus; the
        // bar stays until she votes (or it closes). Otherwise to the speech the oldest ask is on; once it is on screen the ask is seen.
        const owed = marks.owedOf(this.channelId)[0]
        const card = owed ? this.msgs.querySelector<HTMLElement>(`.ch-prow[data-seq="${owed.seq}"]`) : null
        if (card) {
          card.scrollIntoView({ block: 'center' })
          card.classList.add('ch-flash')
          setTimeout(() => card.classList.remove('ch-flash'), 1800)
          card.focus({ preventScroll: true })
          this.onScroll()
          return
        }
        const ask = marks.asksOf(this.channelId)[0]
        const row = ask ? this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${ask.on}"]`) : null
        if (row) {
          row.scrollIntoView({ block: 'center' })
          row.classList.add('ch-flash')
          setTimeout(() => row.classList.remove('ch-flash'), 1800)
          this.onScroll()
        }
        return
      }
      const first = marks.of(this.channelId).firstToMe
      const row = first === undefined ? null : this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${first}"]`)
      if (row) {
        const r = row.getBoundingClientRect()
        const v = this.msgs.getBoundingClientRect()
        if (r.top < v.top || r.bottom > v.bottom) { row.scrollIntoView({ block: 'center' }); return }
      }
      this.toEnd()
    }

    private onScroll(): void {
      if (!this.visible()) return
      const m = this.msgs
      this.lastTop = m.scrollTop
      this.stick = isNearBottom(m.scrollTop, m.clientHeight, m.scrollHeight)
      if (this.stick && this.unread > 0) this.unread = 0
      this.paintNewBar()
      this.checkSeen()
      if (m.scrollTop <= TOP_SLACK_PX) void this.loadOlder()
    }

    private onResize(): void {
      const narrow = this.element.clientWidth > 0 && this.element.clientWidth < NARROW_PX
      this.element.classList.toggle('narrow', narrow)
      // The pills fold behind "+N" sooner in the narrow composition: the speeches are drawn again when it flips (the focus is kept).
      if (narrow !== this.rxNarrow) { this.rxNarrow = narrow; if (this.loaded) this.paintMsgs() }
      this.paintBar()
      if (!this.membersTouched && this.element.clientWidth > 0 && this.membersOpen === narrow) this.membersOpen = !narrow
      this.paintSide()
      const vis = this.visible()
      const shown = vis && !this.wasVisible
      this.wasVisible = vis
      if (!vis) return
      // First time it has a size (the tab was hidden, or the pane was just rebuilt): put it where the person left it.
      if (this.pendingScroll !== undefined) {
        // Not before there is something to scroll: a fresh pane waits for its first page.
        if (!this.loaded && this.timeline.lines.length === 0) return
        const to = this.pendingScroll
        this.pendingScroll = undefined
        this.msgs.scrollTop = to === 'end' ? this.msgs.scrollHeight : to
      } else if (shown) {
        // A hidden pane loses its scroll (and a repaint while hidden resets it): what it was reading is `lastTop`, the end is `stick`.
        this.msgs.scrollTop = this.stick ? this.msgs.scrollHeight : this.lastTop
      } else if (this.stick) this.msgs.scrollTop = this.msgs.scrollHeight
      this.checkSeen()
    }

    // ---------- paint ----------

    private paint(): void {
      this.paintHead()
      this.paintMsgs()
      this.paintMembers()
      this.paintSide()
      this.paintMuteBar()
      this.paintNewBar()
      this.paintFoot()
      if (this.loaded && this.pendingScroll !== undefined && this.visible()) this.onResize()
    }

    private syncTitle(): void {
      if (!this.answer) return
      const title = `#${this.answer.channel.name}`
      if (this.host && this.host.title() !== title) this.host.setTitle(title)
    }

    /** Asks the commands to join an agent to this channel: they open straight on the agent picker. */
    private joinAgent(): void { void ui.commands.run(CMD.join, { channel: this.channelId }) }

    private isClosed(): boolean { return this.answer?.channel.closed !== undefined }

    /** An open channel that is known to have nobody in it. */
    private noMembers(): boolean { return this.answer !== undefined && !this.isClosed() && this.answer.members.length === 0 }

    private actionBtn(className: string, label: string, icon: Parameters<typeof glyph>[0], run: () => void): HTMLButtonElement {
      const b = el('button', className)
      b.type = 'button'
      b.title = label
      b.setAttribute('aria-label', label)
      b.append(glyph(icon))
      b.addEventListener('click', ev => { ev.stopPropagation(); run() })
      return b
    }

    /** An accent button of the bar: icon always, its text only while `labeled` (see paintBar). */
    private primaryBtn(className: string, label: string, icon: Parameters<typeof glyph>[0], run: () => void): HTMLButtonElement {
      const b = this.actionBtn(`ch-act ch-primary ${className}`, label, icon, run)
      b.append(el('span', 'ch-lbl', label))
      return b
    }

    private buildBar(): void {
      this.joinBtn = this.primaryBtn('ch-join', PANE_TEXT.joinMenu, 'user-plus', () => this.joinAgent())
      this.reopenBtn = this.primaryBtn('ch-reopen', PANE_TEXT.reopen, 'arrow-counter-clockwise', () => { void ui.commands.run(CMD.reopen, { channel: this.channelId }) })
      const members = el('button', 'ch-act on')
      members.type = 'button'
      members.title = PANE_TEXT.members
      members.setAttribute('aria-label', PANE_TEXT.members)
      members.setAttribute('aria-pressed', 'true')
      members.setAttribute('aria-controls', this.side.id)
      members.append(glyph('users'))
      members.addEventListener('click', () => this.toggleMembers())
      this.membersBtn = members
      const end = this.actionBtn('ch-act ch-end', PANE_TEXT.toEnd, 'arrow-line-down', () => this.toEnd())
      this.endBtn = end
      // The same menu as the tab's (right click): the bar shows what is frequent, the "⋯" opens the whole list.
      const more = this.actionBtn('ch-act ch-more', PANE_TEXT.more, 'dots-three', () => this.openMenu(more))
      more.setAttribute('aria-haspopup', 'menu')
      this.bar.setAttribute('role', 'toolbar')
      this.bar.setAttribute('aria-label', 'Ações do canal')
      this.bar.append(this.joinBtn, this.reopenBtn, members, end, more)
      this.paintBar()
    }

    private openMenu(opener: HTMLElement): void {
      if (!this.host) return
      const r = opener.getBoundingClientRect()
      this.host.showMenu(r.left, r.bottom, opener)
    }

    /** After "Tirar" emptied the list the row that held the focus is gone: the focus goes to the accent "Juntar agente…". */
    private focusJoinIfEmptied(): void {
      if (this.joinFocusUntil === 0) return
      if (Date.now() > this.joinFocusUntil) { this.joinFocusUntil = 0; return }
      if (!this.noMembers()) return
      this.joinFocusUntil = 0
      const a = document.activeElement
      // Only when the focus is lost or still in this pane: never take it from something the person went to.
      if (a === null || a === document.body || this.element.contains(a)) this.joinBtn?.focus()
    }

    private isNarrow(): boolean { return this.element.classList.contains('narrow') }

    /** What the bar shows now: the accent gesture and whether it carries text (not in the narrow composition, not in the empty state). */
    private barState(): PaneSnapshot['actions'] {
      const known = this.answer !== undefined
      const primary: PaneSnapshot['actions']['primary'] = !known ? 'none'
        : !this.isClosed() ? 'join'
        : this.answer!.channel.desk === undefined ? 'reopen' : 'none'
      const labeled = primary === 'reopen' || (primary === 'join' && !this.isNarrow() && !this.noMembers())
      return { primary, labeled, more: true, toEnd: !this.isNarrow() }
    }

    private paintBar(): void {
      const s = this.barState()
      const held = document.activeElement
      if (this.joinBtn) { this.joinBtn.hidden = s.primary !== 'join'; this.joinBtn.classList.toggle('labeled', s.labeled) }
      if (this.reopenBtn) { this.reopenBtn.hidden = s.primary !== 'reopen'; this.reopenBtn.classList.toggle('labeled', s.labeled) }
      if (this.endBtn) this.endBtn.hidden = !s.toEnd
      // The accent changes face when the channel closes or reopens: the focus follows it (the button that held it just went away).
      if (held && held === this.joinBtn && this.joinBtn.hidden && this.reopenBtn && !this.reopenBtn.hidden) this.reopenBtn.focus()
      else if (held && held === this.reopenBtn && this.reopenBtn.hidden && this.joinBtn && !this.joinBtn.hidden) this.joinBtn.focus()
    }

    private paintHead(): void {
      this.paintBar()
      this.titleBox.replaceChildren()
      if (!this.answer) { this.titleBox.append(glyph('chats-circle'), el('span', 'ch-name-title', this.host?.title() ?? '')); return }
      const h = headerOf(this.answer)
      const sub = el('span', 'ch-sub')
      sub.append(`${this.answer.members.length === 1 ? '1 membro' : `${this.answer.members.length} membros`} · dono: `)
      const owner = this.agentName(h.ownerId, 'ch-oname', h.ownerName)
      hueStyle(owner, h.ownerHue)
      if (h.ownerId !== undefined) {
        const ident = identityOfAgent(h.ownerId, h.ownerName)
        const lead = el('span', 'ch-olead')
        lead.append(engineCell(ident, false), markCell(ident))
        sub.append(lead)
      }
      sub.append(owner)
      if (h.closed) sub.append(' · encerrado')
      this.titleBox.append(glyph(h.closed ? 'lock' : 'chats-circle'), el('span', 'ch-name-title', h.title), sub)
      if (h.closed) {
        // The narrow header drops the subtitle: the state stays as a chip (the wide one says it in the subtitle).
        const chip = el('span', 'ch-role ch-closed-chip')
        chip.append(glyph('lock'), 'encerrado')
        this.titleBox.append(chip)
      }
    }

    /** The column is drawn when the person has it open and somebody is in the channel (a lone "Você" says nothing). */
    private sideShown(): boolean { return (this.membersHost !== undefined || this.membersOpen) && !this.nobodyListed() }

    /** Nobody is in the channel, open or closed: the column and the "Membros" button have nothing to say. */
    private nobodyListed(): boolean { return this.answer !== undefined && this.answer.members.length === 0 }

    private paintSide(): void {
      const shown = this.sideShown()
      this.side.hidden = !shown
      // A column in another host leaves the conversation the whole width; showing it is that host's (no "Membros" button here).
      this.element.classList.toggle('members-off', !shown || this.membersHost !== undefined)
      if (this.membersBtn) {
        this.membersBtn.hidden = this.nobodyListed() || this.membersHost !== undefined
        this.membersBtn.classList.toggle('on', shown)
        this.membersBtn.setAttribute('aria-pressed', String(shown))
      }
      this.paintFold()
    }

    /** The strip is drawn only in the narrow composition, with somebody in an open channel. */
    private foldShown(): boolean { return this.membersHost === undefined && this.isNarrow() && this.answer !== undefined && !this.isClosed() && this.answer.members.length > 0 }

    private paintFold(): void {
      const show = this.foldShown()
      this.fold.hidden = !show
      if (!show || !this.answer) return
      const f = foldOf(this.answer)
      const open = this.sideShown()
      this.fold.setAttribute('aria-expanded', String(open))
      this.fold.setAttribute('aria-label', foldAria(f, open))
      this.fold.classList.toggle('open', open)
      const kids: Array<Node | string> = []
      if (open) {
        kids.push(glyph('caret-down'), el('span', 'ch-fold-count', f.label), el('span', 'ch-fold-sp'), el('span', 'ch-fold-hint', 'recolher'))
      } else {
        const stack = el('span', 'ch-fold-stack')
        for (const k of f.marks) {
          const em = el('span', `ch-em${k.crown ? ' crown' : ''}`)
          hueStyle(em, k.hue)
          em.append(glyph(k.crown ? 'crown-simple' : 'robot'))
          stack.append(em)
        }
        kids.push(stack, el('span', 'ch-fold-count', f.label))
        if (f.muted > 0) {
          const mute = el('span', 'ch-role mute ch-fold-muted')
          mute.title = f.muted === 1 ? '1 calado' : `${f.muted} calados`
          mute.append(glyph('speaker-slash'), String(f.muted))
          kids.push(mute)
        }
        if (f.waiting > 0) {
          // A member that does not hear now stays visible while folded: a warning on the count.
          const warn = el('span', 'ch-role warn ch-fold-warn')
          warn.title = f.waiting === 1 ? '1 não ouve agora' : `${f.waiting} não ouvem agora`
          warn.append(glyph('warning'), String(f.waiting))
          kids.push(warn)
        }
        kids.push(el('span', 'ch-fold-sp'), glyph('caret-right'))
      }
      this.fold.replaceChildren(...kids)
    }

    /** "N novas para você" (the lines addressed to her, unseen) beats "N falas novas"; neither shows while reading the end. */
    private barText(): { text: string; me: boolean; ask?: true } {
      const m = marks.of(this.channelId)
      if (!this.stick && m.toMe > 0) return { text: forYouLabel(m.toMe), me: true }
      // A ❓/❌ of an agent on her speech asks her even at the end of the conversation (the speech may be far above).
      // A poll that waits for her vote asks her too, and says so in the same bar ("1 reação pede você · 1 enquete espera o seu voto").
      const asks = marks.asksOf(this.channelId).length
      const owed = marks.owedOf(this.channelId).length
      if (asks + owed > 0) return { text: waitsLabel(asks, owed), me: true, ask: true }
      if (this.stick) return { text: '', me: false }
      return { text: this.unread > 0 ? unreadLabel(this.unread) : '', me: false }
    }

    /** Whether the speech `seq` is held and at least partly in view of the conversation. */
    private onScreen(seq: number): boolean {
      const row = this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${seq}"]`)
      if (!row) return false
      const r = row.getBoundingClientRect()
      const v = this.msgs.getBoundingClientRect()
      return r.height > 0 && r.top < v.bottom && r.bottom > v.top
    }

    private paintNewBar(): void {
      const { text, me } = this.barText()
      this.newBar.hidden = text === ''
      this.newBar.classList.toggle('me', me)
      this.newBar.replaceChildren(glyph('arrow-line-down'), document.createTextNode(text))
    }

    private paintMuteBar(): void {
      const text = this.answer ? muteBar(this.answer) : ''
      this.muteBox.hidden = text === ''
      this.muteBox.replaceChildren(...(text === '' ? [] : [glyph('speaker-slash'), el('span', '', text)]))
    }

    private paintFoot(): void {
      // A closed channel says so and has no box; an open one has the box in `.ch-composer-slot` (the draft lives in the box, not here).
      const closed = this.answer?.channel.closed !== undefined
      this.foot.querySelector('.ch-closed')?.remove()
      if (closed) {
        this.foot.prepend(el('div', 'ch-closed', 'Canal encerrado. A conversa fica guardada para leitura.'))
        this.composerSlot.replaceChildren()
        return
      }
      if (!this.answer) return
      this.composer.setMembers(this.answer.members.map(m => m.name))
      this.composer.setMarks(new Map(memberRows(this.answer, undefined, noDesk).flatMap((m): Array<[string, string]> =>
        m.muted ? [[m.name, MENTION_TEXT.muted]] : m.tone === 'wait' ? [[m.name, MENTION_TEXT.deaf]] : [])))
      // The "@" list draws the pair of every member (also homonyms: the pair is what tells them apart).
      this.composer.setIdentities(this.answer.members.map(m => identityOfAgent(m.id, m.name)))
      this.composer.setAudience(this.answer.members.length)
      if (this.composerSlot.firstChild !== this.composer.element) this.composerSlot.replaceChildren(this.composer.element)
    }

    private async say(text: string, to: string[], files?: FileSource[]): Promise<void> {
      await this.ask('say', { text, ...(to.length > 0 ? { to } : {}), ...(files?.length ? { files } : {}) })
      this.toEnd()
    }

    private rows(): Row[] {
      return rowsOf(this.timeline.lines, {
        moderatorName: moderatorName(),
        ...(marks.of(this.channelId).firstToMe !== undefined ? { firstToMe: marks.of(this.channelId).firstToMe! } : {}),
        ...(this.answer ? { idByName: idByName(this.answer) } : {}),
        ...(this.answer?.channel.owner.kind === 'agent' ? { ownerId: this.answer.channel.owner.id } : {}),
      })
    }

    rowsView(): Row[] { return this.rows() }
    /** The channel's one menu (the tab's and the bar's "⋯"): `channelMenu` is the only place that says which rows there are. */
    menuRows(paneId: string): ContextMenuRow[] {
      const answer = this.answer
      // Not loaded yet: the core's floor (link, close) is all the menu has.
      if (!answer) return []
      const channel = this.channelId
      const ask = (id: string) => (): void => { void ui.commands.run(id, { channel }) }
      const run: Record<ChannelMenuId, () => void> = {
        join: () => this.joinAgent(),
        members: () => this.toggleMembers(),
        toEnd: () => this.toEnd(),
        poll: () => this.openPollForm(),
        mute: ask(CMD.mute), unmute: ask(CMD.unmute), remove: ask(CMD.remove), close: ask(CMD.close), reopen: ask(CMD.reopen),
        link: () => ui.panes.copyLink(paneId),
        channelLink: () => ui.shell.writeClipboard(channelUrl(channel)),
        move: () => ui.panes.move(paneId),
        closePane: () => ui.panes.close(paneId),
      }
      const rowOf = (e: ChannelMenuEntry): ContextMenuRow =>
        e === 'sep' || 'heading' in e ? e
          : { icon: e.icon, label: e.label, run: run[e.id], ...(e.danger ? { danger: true } : {}), ...(e.checked !== undefined ? { checked: e.checked } : {}), ...(e.disabled ? { disabled: true } : {}) }
      const entries = channelMenu(answer.channel, answer, { membersOpen: this.sideShown() })
      if (this.kind === 'pane') return entries.map(rowOf)
      // Embedded: no tab to link, move or close (and no members' toggle when the column lives in the host); "Abrir como guia"
      // opens the channel's tab, or brings the one that exists forward (P3).
      const omit = (id: ChannelMenuId): boolean => EMBED_OMITS.has(id) || (id === 'members' && this.membersHost !== undefined)
      return entries.flatMap((e): ContextMenuRow[] => {
        if (e === 'sep' || 'heading' in e) return [rowOf(e)]
        if (omit(e.id)) return []
        return e.id === 'channelLink' ? [{ icon: 'arrow-square-out', label: OPEN_AS_TAB, run: () => open(channel, answer.channel.name) }, rowOf(e)] : [rowOf(e)]
      })
    }

    /** Opens the poll form above the speaking box (the box's button, `/enquete`, the palette and the "⋯" menu land here). */
    openPollForm(): void { this.composer.openPoll() }

    private toggleMembers(): void { this.membersTouched = true; this.membersOpen = !this.membersOpen; this.paintSide() }

    private paintMsgs(): void {
      const m = this.msgs
      // Emptying the box resets its scroll: while shown, what the person was reading is put back (the end is the caller's).
      const keepTop = this.visible() ? m.scrollTop : undefined
      // A speech (or one of its pills) that holds the keyboard keeps it through the redraw: a new line must not throw the focus away.
      const held = document.activeElement instanceof HTMLElement && m.contains(document.activeElement) ? document.activeElement : undefined
      const heldSeq = held?.closest<HTMLElement>('.ch-msg')?.dataset.seq
      const heldKey = held?.classList.contains('ch-pill') ? held.dataset.key : undefined
      m.replaceChildren()
      try { this.fillMsgs(m) } finally { if (keepTop !== undefined && this.visible()) m.scrollTop = keepTop }
      if (heldSeq !== undefined) {
        const msg = m.querySelector<HTMLElement>(`.ch-msg[data-seq="${heldSeq}"]`)
        const again = heldKey !== undefined ? msg?.querySelector<HTMLElement>(`.ch-pill[data-key="${CSS.escape(heldKey)}"]`) : undefined
        ;(again ?? msg)?.focus({ preventScroll: true })
      }
      this.watchContent()
    }

    /**
     * While `stick` holds the pane stays at the end whenever the HEIGHT OF THE CONTENT changes (a repaint while hidden, fonts, a row
     * that grows), not only when the pane itself is resized or shown. Reading above (`stick` false) is never touched.
     */
    private watchContent(): void {
      if (this.disposed) return
      this.contentRo ??= new ResizeObserver(() => {
        if (this.disposed || !this.stick || this.pendingScroll !== undefined || !this.visible()) return
        const m = this.msgs
        if (m.scrollHeight - (m.scrollTop + m.clientHeight) > 1) m.scrollTop = m.scrollHeight
      })
      this.contentRo.disconnect()
      for (const child of Array.from(this.msgs.children)) this.contentRo.observe(child)
      // The conversation's own height too: the poll form (or a long draft) grows above the box and takes room from it.
      this.contentRo.observe(this.msgs)
    }

    private fillMsgs(m: HTMLElement): void {
      if (this.error) {
        const box = el('div', 'ch-empty')
        box.append(el('p', 't', this.error))
        const retry = el('button', 'ch-btn', 'Tentar de novo')
        retry.type = 'button'
        retry.addEventListener('click', () => { this.error = ''; this.paintMsgs(); void this.load() })
        box.append(retry)
        m.append(box)
        return
      }
      if (!this.loaded && this.timeline.lines.length === 0) { m.append(el('div', 'ch-empty', 'Lendo o canal…')); return }
      if (this.timeline.more) {
        const older = el('button', 'ch-btn ch-older', 'Ver anteriores')
        older.type = 'button'
        older.addEventListener('click', () => void this.loadOlder())
        m.append(older)
      }
      const rows = this.rows()
      this.separatorAt = marks.of(this.channelId).firstToMe
      this.drewNoMembers = this.noMembers()
      this.drewClosed = this.isClosed()
      for (const r of rows) m.append(this.rowEl(r))
      if (this.drewNoMembers) {
        // Nobody is here: under the system lines, the empty state and the way to bring someone in (it goes when a member comes).
        const box = el('div', 'ch-empty ch-nobody')
        const ill = el('span', 'ch-ill')
        ill.append(glyph('chats-circle'))
        box.append(ill, el('p', 't', PANE_TEXT.noMembers), el('p', 'help', PANE_TEXT.noMembersHelp))
        const join = this.actionBtn('ch-btn primary ch-join-empty', PANE_TEXT.joinMenu, 'user-plus', () => this.joinAgent())
        join.append(PANE_TEXT.joinMenu)
        box.append(join)
        m.append(box)
      } else if (rows.length === 0) {
        const box = el('div', 'ch-empty')
        box.append(el('p', 't', 'Ninguém falou ainda'), el('p', '', 'O que for dito neste canal aparece aqui.'))
        m.append(box)
      }
    }

    private rowEl(r: Row): HTMLElement {
      if (r.kind === 'day') return el('div', 'ch-day', r.label)
      if (r.kind === 'unseen') {
        const e = el('div', 'ch-day ch-unseen', r.label)
        e.dataset.seq = String(r.seq)
        return e
      }
      if (r.kind === 'notice') {
        const e = el('div', 'ch-sys')
        e.dataset.seq = String(r.seq)
        e.dataset.glyph = r.glyph
        e.append(glyph(NOTICE_ICON[r.glyph]), el('span', 'ch-sys-text', r.text), el('time', '', r.time))
        return e
      }
      if (r.kind === 'poll') return this.pollRowEl(r)
      const e = el('div', `ch-msg${r.mine ? ' mod' : ''}${r.continued ? ' continued' : ''}${r.to.some(t => t.you) ? ' to-me' : ''}`)
      e.dataset.seq = String(r.seq)
      hueStyle(e, r.hue)
      if (!r.continued) {
        const who = el('div', 'ch-who')
        const em = this.authorLead(r)
        const role = el('span', `ch-role${r.mine ? ' mod' : ''}`, r.role)
        const dest = el('span', 'ch-dest')
        dest.append(glyph('arrow-bend-down-right'))
        if (r.to.length === 0) dest.append('para todos')
        else {
          dest.append('para ')
          r.to.forEach((t, i) => {
            if (i > 0) dest.append(', ')
            const n = el('span', 'ch-oname', t.name)
            hueStyle(n, t.hue)
            dest.append(n)
          })
        }
        who.append(...em, this.agentName(r.authorId, 'ch-author', r.name), role, dest, el('time', '', r.time))
        e.append(who)
      } else e.title = r.time
      if (r.body.trim() !== '' || !r.files?.length) e.append(this.speech(r.body))
      // The speech's files: thumbnails for the images, cards for the rest (A2).
      if (r.files?.length) e.append(fileViews.block(r.files))
      // The speech is a stop of its own for the arrows (the log stays the one Tab stop) and reads as a whole: author, time, text, reactions.
      e.tabIndex = -1
      e.setAttribute('role', 'article')
      this.msgMeta.set(e, { who: r.name, time: r.time, to: r.to.map(t => t.name), body: r.body })
      // The narrow composition has no hover bar: this "⋯" is always there and opens the same menu (the menu key does too).
      const more = this.actionBtn('ch-msg-more', 'Reagir e mais ações da fala', 'dots-three', () => {
        const b = more.getBoundingClientRect()
        this.openMsgMenu(r.seq, b.left, b.bottom)
      })
      more.tabIndex = -1
      more.setAttribute('aria-haspopup', 'menu')
      e.append(more)
      const rx = this.rxEl(r.seq)
      if (rx) e.append(rx)
      this.nameMsg(e, r.seq)
      return e
    }

    /** What leads an author's name: the person's own mark ("Você"), or the agent's engine icon and emblem or letter. */
    private authorLead(r: { mine: boolean; crown: boolean; authorId: string; name: string }): HTMLElement[] {
      if (r.mine) { const me = el('span', 'ch-em me'); me.append(glyph('user')); return [me] }
      const ident = identityOfAgent(r.authorId, r.name)
      return [engineCell(ident, r.crown), markCell(ident)]
    }

    /** A poll's row: the author's header like a speech's (no "para"), then the card. It takes no reaction (only a speech does). */
    private pollRowEl(r: Extract<Row, { kind: 'poll' }>): HTMLElement {
      const e = el('div', 'ch-prow')
      e.dataset.seq = String(r.seq)
      hueStyle(e, r.hue)
      e.tabIndex = -1
      const who = el('div', 'ch-who')
      who.append(...this.authorLead(r), this.agentName(r.authorId, 'ch-author', r.name), el('span', `ch-role${r.mine ? ' mod' : ''}`, r.role), el('time', '', r.time))
      e.append(who)
      const card = this.cardFor(r.seq)
      if (card) { e.append(this.pollCardEl(card)); this.nameRow(e, card) }
      return e
    }

    /** The speech's accessible name, with the sum of its reactions as they are now. */
    private nameMsg(e: HTMLElement, seq: number): void {
      const meta = this.msgMeta.get(e)
      if (!meta) return
      e.setAttribute('aria-label', msgAria(meta, pillsOf(this.tallies.get(seq), this.pendingOf(seq))))
    }

    // ---------- reactions ----------

    /** The pills of a message, or nothing: a speech with no reaction takes no room. A closed channel's are plain text (read only). */
    private rxEl(seq: number): HTMLElement | undefined {
      const pills = pillsOf(this.tallies.get(seq), this.pending.get(seq))
      if (pills.length === 0) return undefined
      const box = el('div', 'ch-rx')
      box.setAttribute('role', 'group')
      box.setAttribute('aria-label', 'Reações')
      // A change of the pills is told by the pane's own live region (one short sentence), not by the log re-reading the whole group.
      box.setAttribute('aria-live', 'off')
      const readOnly = this.isClosed()
      const { shown, hidden } = splitPills(pills, this.isNarrow())
      for (const p of shown) {
        const b = readOnly ? el('span', 'ch-pill ro') : el('button', 'ch-pill')
        if (p.mine) b.classList.add('mine')
        if (p.pending) b.classList.add('pend')
        b.dataset.emoji = p.emoji
        b.dataset.key = reactionKey(p.emoji)
        b.dataset.count = String(p.count)
        const sees = seesNextText(p, this.timeline.lines.find(l => l.seq === seq)?.from)
        b.title = sees ? `${pillTitle(p)}\n${sees}` : pillTitle(p)
        b.append(el('span', 'e', p.emoji), el('span', 'n', String(p.count)))
        b.setAttribute('aria-label', pillAria(p, readOnly))
        if (b instanceof HTMLButtonElement) {
          b.type = 'button'
          b.setAttribute('aria-pressed', String(p.mine))
          b.addEventListener('click', ev => { ev.stopPropagation(); this.reactTo(seq, p.emoji) })
          b.addEventListener('contextmenu', ev => {
            ev.preventDefault(); ev.stopPropagation()
            if (performance.now() - this.keyMenuAt < 400) return
            this.openPillMenu(seq, p, ev.clientX, ev.clientY)
          })
        } else b.setAttribute('role', 'img')
        box.append(b)
      }
      if (hidden.length > 0) {
        // The pills that do not fit: one button lists them all (and lets the person put or take hers from the list).
        const n = hidden.length
        const b = el('button', 'ch-pill ch-pill-more', `+${n}`)
        b.type = 'button'
        b.dataset.key = '+n'
        b.title = n === 1 ? 'Mais 1 reação' : `Mais ${n} reações`
        b.setAttribute('aria-haspopup', 'menu')
        b.setAttribute('aria-label', `${b.title}: ${pillsSummary(hidden)}. Abre a lista.`)
        b.addEventListener('click', ev => { ev.stopPropagation(); const r = b.getBoundingClientRect(); this.openHiddenMenu(seq, hidden, r.left, r.bottom) })
        box.append(b)
      }
      if (!readOnly) {
        const add = el('button', 'ch-pill ch-pill-add')
        add.type = 'button'
        add.dataset.key = '+'
        add.title = 'Reagir com outro emoji'
        add.setAttribute('aria-label', 'Reagir com outro emoji')
        add.setAttribute('aria-haspopup', 'dialog')
        add.append(glyph('plus'))
        add.addEventListener('click', ev => { ev.stopPropagation(); this.openPicker(seq) })
        box.append(add)
      }
      return box
    }

    /** Repaints the pills of one message in place: no other row is touched, so nothing moves for the person reading. */
    private paintRx(seq: number): void {
      const e = this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${seq}"]`)
      if (!e) return
      const old = e.querySelector<HTMLElement>(':scope > .ch-rx')
      const heldKey = old && old.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined
      const next = this.rxEl(seq)
      if (old && next) old.replaceWith(next)
      else if (old) old.remove()
      else if (next) e.insertBefore(next, this.hb.parentElement === e ? this.hb : null)
      if (heldKey !== undefined) (next?.querySelector<HTMLElement>(`.ch-pill[data-key="${CSS.escape(heldKey)}"]`) ?? e).focus({ preventScroll: true })
      this.nameMsg(e, seq)
      this.syncBar()
    }

    private pendingOf(seq: number): Pending | undefined { return this.pending.get(seq) }

    /** Puts the person's reaction on a message or takes it back, whichever the pill, the bar or the menu is for. */
    private reactTo(seq: number, emoji: string): void {
      const mine = minesOf(this.tallies.get(seq), this.pendingOf(seq)).has(reactionKey(emoji))
      void this.react(seq, emoji, mine)
    }

    /** The gesture shows at once (pending) and is undone with a short notice if the daemon refuses. */
    private async react(seq: number, emoji: string, remove: boolean): Promise<void> {
      if (this.isClosed() || this.disposed) return
      const key = reactionKey(emoji)
      const held = this.tallies.get(seq) ?? []
      const limit = { mine: held.filter(t => t.by.some(b => b.id === USER)).length, kinds: held.length }
      let per = this.pending.get(seq)
      if (!per) this.pending.set(seq, (per = new Map()))
      per.set(key, remove ? 'remove' : 'add')
      this.paintRx(seq)
      try {
        const r = await this.ask<{ changed: boolean }>('react', { seq, reaction: emoji, ...(remove ? { remove: true } : {}) })
        // The answer may come before the `reaction` event: the sum already shows it (the event repeats it, which changes nothing).
        if (r.changed) {
          const line = { seq: 0, at: '', kind: 'reaction', from: { id: USER, name: moderatorName(), role: 'moderator' }, body: '', react: { seq, emoji, op: remove ? 'remove' : 'add' } } satisfies Line
          const next = applyReaction(this.tallies.get(seq), line)
          if (next.length > 0) this.tallies.set(seq, next)
          else this.tallies.delete(seq)
          const sense = FIVE.find(f => reactionKey(f.emoji) === key)
          this.announce(announceText({ who: 'Você', emoji, ...(sense ? { name: sense.name } : {}), op: remove ? 'remove' : 'add', author: this.authorOf(seq) }))
        }
        if (!remove) this.rememberRecent(emoji)
      } catch (e) {
        this.toast(refusalText((e as { code?: string }).code, limit))
      } finally {
        per.delete(key)
        if (per.size === 0) this.pending.delete(seq)
        if (!this.disposed) this.paintRx(seq)
      }
    }

    private toast(text: string): void {
      this.toastEl.textContent = text
      this.toastEl.hidden = false
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => { this.toastEl.hidden = true }, TOAST_MS)
    }

    // The hover bar: the five agreed reactions and the "⋯" that opens the speech's menu. One bar moves onto the message under the mouse.
    private buildHoverBar(): void {
      this.hb.setAttribute('role', 'toolbar')
      this.hb.setAttribute('aria-label', 'Reagir a esta fala')
      for (const f of FIVE) {
        const b = el('button', 'ch-hb-b', f.emoji)
        b.type = 'button'
        b.dataset.key = reactionKey(f.emoji)
        b.title = `${f.label} (${f.sense})`
        b.setAttribute('aria-label', `Reagir com ${f.label}`)
        b.addEventListener('click', ev => { ev.stopPropagation(); this.reactTo(Number(this.hb.dataset.seq), f.emoji) })
        this.hb.append(b)
      }
      this.hb.append(el('span', 'ch-hb-sep'))
      const face = this.actionBtn('ch-hb-b ch-hb-face', 'Outro emoji…', 'smiley', () => this.openPicker(Number(this.hb.dataset.seq)))
      face.setAttribute('aria-haspopup', 'dialog')
      const more = this.actionBtn('ch-hb-b ch-hb-more', 'Mais ações da fala', 'dots-three', () => {
        const r = more.getBoundingClientRect()
        this.openMsgMenu(Number(this.hb.dataset.seq), r.left, r.bottom)
      })
      more.setAttribute('aria-haspopup', 'menu')
      this.hb.append(face, more)
      // The keys do all of this from the speech itself (1-5, R, the menu key): the bar's buttons are for the pointer, not Tab stops.
      for (const b of this.hb.querySelectorAll<HTMLElement>('button')) b.tabIndex = -1
    }

    private showBar(msg: HTMLElement): void {
      if (this.isClosed()) { this.hb.remove(); return }
      if (this.hb.parentElement !== msg) msg.append(this.hb)
      this.hb.dataset.seq = msg.dataset.seq ?? ''
      this.syncBar()
    }

    /** The reactions the person already gave on the message the bar is on are marked. */
    private syncBar(): void {
      if (!this.hb.isConnected) return
      const seq = Number(this.hb.dataset.seq)
      const mine = minesOf(this.tallies.get(seq), this.pendingOf(seq))
      for (const b of this.hb.querySelectorAll<HTMLElement>('.ch-hb-b[data-key]')) {
        const on = mine.has(b.dataset.key!)
        b.classList.toggle('on', on)
        b.setAttribute('aria-pressed', String(on))
      }
    }

    private copy(text: string): void { void navigator.clipboard?.writeText(text).catch(() => {}) }

    /** The menu of a speech (right click, or the bar's "⋯"): the reactions with their meaning, then copy. A closed channel keeps only copy. */
    private openMsgMenu(seq: number, x: number, y: number): void {
      const line = this.timeline.lines.find(l => l.seq === seq)
      if (!line) return
      const rows: ContextMenuRow[] = []
      this.menuReturn = { seq, until: Date.now() + JOIN_FOCUS_MS }
      if (!this.isClosed()) {
        const mine = minesOf(this.tallies.get(seq), this.pendingOf(seq))
        const who = line.from.id === USER || line.from.role === 'moderator' ? 'você' : line.from.name
        rows.push({ heading: `Reagir à fala de ${who}` })
        // The key of the picker is written beside "Outro emoji…"; the digits 1-5 react from the speech itself (the picker lists them too).
        for (const f of FIVE) rows.push({ icon: '', label: `${f.emoji}  ${f.label}`, checked: mine.has(reactionKey(f.emoji)), run: () => this.reactTo(seq, f.emoji) })
        rows.push({ icon: '', label: '🙂  Outro emoji…', hint: this.reactKeyLabel(), run: () => this.openPicker(seq) })
        rows.push('sep')
      }
      rows.push({ icon: 'clipboard-text', label: 'Copiar texto', run: () => this.copy(line.body) })
      rows.push({ icon: 'clipboard-text', label: 'Copiar referência', hint: `${this.answer?.channel.name ?? this.channelId}#${seq}`, run: () => this.copy(`${this.answer?.channel.name ?? this.channelId}#${seq}`) })
      ui.menus.context(x, y, rows as ContextMenuEntry[])
    }

    /** The menu of a pill: put or take back the person's own, and who reacted. */
    private openPillMenu(seq: number, p: Pill, x: number, y: number): void {
      this.menuReturn = { seq, key: reactionKey(p.emoji), until: Date.now() + JOIN_FOCUS_MS }
      const sense = p.name ? FIVE.find(f => f.name === p.name)?.sense : undefined
      const rows: ContextMenuRow[] = [
        { heading: `${p.emoji} ${sense ? `${sense} · ` : ''}${p.count}` },
        { icon: '', label: p.mine ? 'Tirar minha reação' : `Reagir com ${p.emoji} também`, run: () => this.reactTo(seq, p.emoji) },
        'sep',
        { heading: 'Quem reagiu' },
        ...p.by.map((b): ContextMenuRow => ({ heading: b.id === USER ? 'Você' : b.name })),
      ]
      ui.menus.context(x, y, rows as ContextMenuEntry[])
    }

    /** The list behind "+N": every pill that did not fit, each a row that puts or takes the person's reaction, with who gave it. */
    private openHiddenMenu(seq: number, hidden: readonly Pill[], x: number, y: number): void {
      this.menuReturn = { seq, key: '+n', until: Date.now() + JOIN_FOCUS_MS }
      const readOnly = this.isClosed()
      const rows: ContextMenuRow[] = [{ heading: 'Outras reações' }]
      for (const p of hidden) {
        const sense = p.name ? FIVE.find(f => f.name === p.name)?.sense : undefined
        rows.push({
          icon: '', label: `${p.emoji}  ${p.count} · ${whoText(p.by)}${sense ? ` · ${sense}` : ''}`,
          ...(readOnly ? { disabled: true } : { checked: p.mine }), run: () => this.reactTo(seq, p.emoji),
        })
      }
      ui.menus.context(x, y, rows as ContextMenuEntry[])
    }

    /** After a menu closes the focus returns to the speech (or the pill) it was opened from, unless the person went somewhere else. */
    private returnMsgFocus(): void {
      const r = this.menuReturn
      if (!r || this.disposed) return
      this.menuReturn = undefined
      if (Date.now() > r.until) return
      const a = document.activeElement
      if (a !== null && a !== document.body && !a.closest('#ctx-menu')) return
      const msg = this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${r.seq}"], .ch-prow[data-seq="${r.seq}"]`)
      const pill = r.key !== undefined ? msg?.querySelector<HTMLElement>(`.ch-pill[data-key="${CSS.escape(r.key)}"]`) : undefined
      ;(pill ?? msg)?.focus({ preventScroll: true })
    }

    // ---------- the keyboard on the speeches ----------

    /** The label of the picker's key beside the menu row: the key of the person's own binding when she moved it, `R` otherwise. */
    private reactKeyLabel(): string {
      const own = this.boundKeys()
      return own.length > 0 ? own[0]! : REACT_DEFAULT_KEY.toUpperCase()
    }

    /** The labels of the keys the person bound to the picker's command (empty = she did not: the pane's own `R` holds). */
    private boundKeys(): string[] {
      try {
        const table = ui.keybindings.table()
        return table.bindingsOf(REACT_COMMAND).length > 0 ? [table.hint(REACT_COMMAND)] : []
      } catch { return [] }
    }

    /** The speeches only (what a reaction may go on). */
    private sayLines(): HTMLElement[] { return [...this.msgs.querySelectorAll<HTMLElement>(':scope > .ch-msg')] }

    /** The stops of the arrows: the speeches and the polls' cards, in the order of the conversation. */
    private walkLines(): HTMLElement[] { return [...this.msgs.querySelectorAll<HTMLElement>(':scope > .ch-msg, :scope > .ch-prow')] }

    /** Moves the focus to the neighbour speech or card (or, from the log itself, to the one at the foot of what is seen). */
    private walk(from: HTMLElement | null, dir: 1 | -1): void {
      const all = this.walkLines()
      if (all.length === 0) return
      let to: HTMLElement | undefined
      if (from) {
        const at = all.indexOf(from)
        to = all[at + dir]
        // Above the first held speech there may be older ones: they are asked for, and the focus stays where it is.
        if (!to && dir === -1 && this.timeline.more) void this.loadOlder()
        if (!to) return
      } else {
        const bottom = this.msgs.getBoundingClientRect().bottom
        to = [...all].reverse().find(m => m.getBoundingClientRect().top < bottom) ?? all[all.length - 1]
      }
      if (!to) return
      to.focus({ preventScroll: true })
      to.scrollIntoView({ block: 'nearest' })
    }

    private onMsgKey(ev: KeyboardEvent): void {
      if (ev.defaultPrevented || this.picker) return
      const t = ev.target instanceof HTMLElement ? ev.target : null
      if (!t) return
      const prow = t.closest<HTMLElement>('.ch-prow')
      if (prow && !(t instanceof HTMLInputElement) && (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey))) {
        ev.preventDefault()
        this.keyMenuAt = performance.now()
        const r = prow.getBoundingClientRect()
        this.openPollMenu(Number(prow.dataset.seq), r.left + 16, r.top + 28)
        return
      }
      if (prow) { this.onPollKey(ev, t, prow); return }
      const msg = t.closest<HTMLElement>('.ch-msg')
      const onMsg = t === msg
      // The menu key and Shift+F10: the menu of the speech, or of the pill that holds the focus. Its own `contextmenu` event is ignored (keyMenuAt).
      if (msg && (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey))) {
        ev.preventDefault()
        this.keyMenuAt = performance.now()
        const seq = Number(msg.dataset.seq)
        const pill = t.classList.contains('ch-pill') && t.dataset.emoji !== undefined ? pillsOf(this.tallies.get(seq), this.pendingOf(seq)).find(p => reactionKey(p.emoji) === t.dataset.key) : undefined
        const r = (pill ? t : msg).getBoundingClientRect()
        const x = Math.max(0, r.left + 16), y = Math.min(r.bottom, r.top + 28)
        if (pill && !this.isClosed()) this.openPillMenu(seq, pill, x, r.bottom)
        else this.openMsgMenu(seq, x, y)
        return
      }
      // Esc on something inside a speech (a pill, its "⋯") gives the focus back to the speech.
      if (ev.key === 'Escape' && msg && !onMsg && !ev.ctrlKey && !ev.altKey && !ev.metaKey) { msg.focus({ preventScroll: true }); return }
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return
      if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.shiftKey && (t === this.msgs || onMsg)) {
        ev.preventDefault()
        this.walk(onMsg ? msg : null, ev.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (!onMsg || !msg || this.isClosed()) return
      const seq = Number(msg.dataset.seq)
      const n = Number(ev.key)
      if (ev.key.length === 1 && n >= 1 && n <= FIVE.length) { ev.preventDefault(); this.reactTo(seq, FIVE[n - 1]!.emoji); return }
      // `R` is the pane's own until the person binds the picker's command to a key of hers (then the key table's dispatcher runs it).
      if (ev.key.toLowerCase() === REACT_DEFAULT_KEY && this.boundKeys().length === 0) { ev.preventDefault(); this.openPicker(seq) }
    }

    /**
     * The keys of a poll's card. On the card: Up/Down walk to the neighbour, `1` to `n` vote (the same option again keeps the vote;
     * the "não ok" opens its reason), `M` opens the reason's field, the menu key opens the card's menu (onMsgKey). From anything inside
     * the card (an option, "⋯", the reason's field) Esc gives the focus back to the card.
     */
    private onPollKey(ev: KeyboardEvent, t: HTMLElement, prow: HTMLElement): void {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return
      const seq = Number(prow.dataset.seq)
      if (t !== prow) {
        if (ev.key === 'Escape') { ev.preventDefault(); prow.focus({ preventScroll: true }) }
        return
      }
      if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.shiftKey) { ev.preventDefault(); this.walk(prow, ev.key === 'ArrowDown' ? 1 : -1); return }
      const c = this.cardFor(seq)
      if (!c?.canVote || ev.key.length !== 1) return
      const n = Number(ev.key)
      if (n >= 1 && n <= c.options.length) { ev.preventDefault(); this.chooseOption(seq, n); return }
      if (ev.key.toLowerCase() === 'm') { ev.preventDefault(); this.openReason(seq) }
    }

    /** The speech the palette's commands mean: the one that holds the focus (or held it last); the newest speech when none did. */
    private focusedMsg(): HTMLElement | undefined {
      const all = this.sayLines()
      return all.find(m => Number(m.dataset.seq) === this.lastFocusSeq) ?? all[all.length - 1]
    }

    /** A palette command: react to the focused speech with `emoji`, or open the picker on it (`undefined`). `last`: the newest speech. */
    reactFocused(emoji: string | undefined, last = false): void {
      if (this.isClosed()) return
      const all = this.sayLines()
      const msg = last ? all[all.length - 1] : this.focusedMsg()
      if (!msg) return
      const seq = Number(msg.dataset.seq)
      if (emoji === undefined) { this.openPicker(seq); return }
      this.reactTo(seq, emoji)
      // The palette closes after the row runs: the keyboard goes back to the speech it acted on unless the person already went elsewhere.
      setTimeout(() => {
        const a = document.activeElement
        if (!this.disposed && (a === null || a === document.body || a.closest('#palette'))) this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${seq}"]`)?.focus({ preventScroll: true })
      }, 80)
    }

    // ---------- the picker ----------

    /** Opens the reaction picker on a speech: the five with their meaning, the recent ones and the field for any other emoji. */
    openPicker(seq: number): void {
      if (this.isClosed() || this.disposed) return
      this.closePicker(false)
      try { this.recents = readRecents(localStorage.getItem(RECENTS_KEY)) } catch { /* keep the held ones */ }
      this.menuReturn = undefined
      const mine = minesOf(this.tallies.get(seq), this.pendingOf(seq))
      const box = el('div', 'ch-pick')
      box.setAttribute('role', 'dialog')
      box.setAttribute('aria-label', `Reagir à fala de ${this.authorOf(seq)}`)
      box.dataset.seq = String(seq)
      const choose = (emoji: string): void => { this.closePicker(true); this.reactTo(seq, emoji) }

      box.append(el('h4', '', 'Com sentido combinado'))
      const five = el('div', 'ch-pk-five')
      FIVE.forEach((f, i) => {
        const b = el('button', 'ch-pk-b')
        b.type = 'button'
        b.dataset.key = reactionKey(f.emoji)
        b.append(el('span', 'e', f.emoji), el('span', 's', f.sense), el('kbd', '', String(i + 1)))
        b.setAttribute('aria-label', `${f.label}: ${f.sense}. Tecla ${i + 1}.`)
        b.setAttribute('aria-pressed', String(mine.has(reactionKey(f.emoji))))
        b.classList.toggle('on', mine.has(reactionKey(f.emoji)))
        b.addEventListener('click', () => choose(f.emoji))
        five.append(b)
      })
      box.append(five)
      if (this.recents.length > 0) {
        box.append(el('h4', '', 'Usados há pouco'))
        const rec = el('div', 'ch-pk-rec')
        for (const e of this.recents) {
          const b = el('button', 'ch-pk-b ch-pk-recent', e)
          b.type = 'button'
          b.dataset.key = reactionKey(e)
          b.setAttribute('aria-label', `Reagir com ${e}`)
          b.setAttribute('aria-pressed', String(mine.has(reactionKey(e))))
          b.classList.toggle('on', mine.has(reactionKey(e)))
          b.addEventListener('click', () => choose(e))
          rec.append(b)
        }
        box.append(rec)
      }
      box.append(el('h4', '', 'Outro emoji'))
      const other = el('div', 'ch-pk-other')
      const input = el('input', 'ch-pk-in')
      input.type = 'text'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = emojiKeyHint(navigator.platform ?? '')
      input.setAttribute('aria-label', 'Outro emoji')
      const error = el('div', 'ch-pk-err')
      error.setAttribute('role', 'alert')
      const go = el('button', 'ch-pk-go', 'Reagir')
      go.type = 'button'
      const submit = (): void => {
        const r = otherEmoji(input.value)
        if ('error' in r) { error.textContent = r.error; input.setAttribute('aria-invalid', 'true'); return }
        choose(r.emoji)
      }
      go.addEventListener('click', submit)
      input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid') })
      other.append(input, go)
      box.append(other, error)
      const foot = el('div', 'ch-pk-foot')
      foot.append(el('span', '', '1–5 reage'), el('span', '', 'Esc fecha'))
      box.append(foot)

      box.addEventListener('keydown', ev => {
        const k = ev.key
        if (k === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.closePicker(true); return }
        const inField = ev.target === input
        if (k === 'Enter' && inField) { ev.preventDefault(); ev.stopPropagation(); submit(); return }
        if (ev.ctrlKey || ev.altKey || ev.metaKey) return
        const n = Number(k)
        if (!inField && k.length === 1 && n >= 1 && n <= FIVE.length) { ev.preventDefault(); ev.stopPropagation(); choose(FIVE[n - 1]!.emoji); return }
        const stops = [...box.querySelectorAll<HTMLElement>('button, input')]
        const at = stops.indexOf(ev.target as HTMLElement)
        if (k === 'Tab') {
          // Tab stays inside the picker (it is a dialog over the conversation).
          if (at < 0) return
          const to = stops[ev.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at >= stops.length - 1 ? 0 : at + 1)]
          ev.preventDefault(); to?.focus()
          return
        }
        if (!inField && (k === 'ArrowRight' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowUp') && at >= 0) {
          const fwd = k === 'ArrowRight' || k === 'ArrowDown'
          const btns = stops.filter(s => s !== input && !s.classList.contains('ch-pk-go'))
          const i = btns.indexOf(ev.target as HTMLElement)
          if (i < 0) return
          ev.preventDefault()
          btns[(i + (fwd ? 1 : -1) + btns.length) % btns.length]?.focus()
        }
      })
      // A press outside closes it; the focus stays where the person went.
      const onDown = (ev: Event): void => { if (ev.target instanceof Node && !box.contains(ev.target)) this.closePicker(false) }
      document.addEventListener('pointerdown', onDown, true)
      this.msgs.parentElement?.append(box)
      this.picker = { box, seq, input, error, off: () => document.removeEventListener('pointerdown', onDown, true) }
      // A menu that opened the picker gives the focus back to its own opener as it closes: the picker takes it again.
      const first = box.querySelector<HTMLElement>('.ch-pk-b')
      first?.focus()
      for (const ms of [0, 80]) setTimeout(() => { if (this.picker?.box === box && !box.contains(document.activeElement)) first?.focus() }, ms)
    }

    /** Closes the picker; `back`: the focus goes to the speech it was opened on. */
    private closePicker(back: boolean): void {
      const p = this.picker
      if (!p) return
      this.picker = undefined
      p.off()
      const had = p.box.contains(document.activeElement)
      p.box.remove()
      if (back || had) this.msgs.querySelector<HTMLElement>(`.ch-msg[data-seq="${p.seq}"]`)?.focus({ preventScroll: true })
    }

    /**
     * The text of a speech as nodes (never innerHTML): the http(s) and tether:// links in it are links of the app. A plain click
     * follows (Alt+click on a pane link peeks at it) and the right button opens the link's menu.
     */
    private speech(body: string): HTMLParagraphElement {
      const p = el('p', '')
      let at = 0
      for (const l of detectUrlLinks(body)) {
        if (l.start > at) this.plainSpeech(p, body.slice(at, l.start))
        const target = linkTargetOfUrl(l.url)
        const a = el('a', 'ch-link', l.url)
        a.href = '#'
        a.addEventListener('click', ev => { ev.preventDefault(); ui.links.follow(target, ev.altKey && !ev.ctrlKey && !ev.metaKey ? { peek: true } : {}) })
        a.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); ui.links.showMenu(ev.clientX, ev.clientY, target) })
        p.append(a)
        at = l.end
      }
      if (at < body.length) this.plainSpeech(p, body.slice(at))
      return p
    }

    /**
     * Plain text into `p`, with each `@name` of a known member lightly highlighted and each `#name` of an open channel a button that
     * brings that channel's pane forward (text nodes, spans and buttons only, never innerHTML). A closed or unknown channel stays text.
     */
    private plainSpeech(p: HTMLElement, text: string): void {
      const members = this.answer?.members ?? []
      const channels = openChannels()
      const spans: Array<{ start: number; end: number; name: string; channel?: ChannelSummary }> = [
        ...(members.length === 0 ? [] : mentionSpans(text, members.map(m => m.name))),
        ...channelSpans(text, channels.map(c => c.name)).map(s => ({ ...s, channel: channels.find(c => c.name === s.name)! })),
      ].sort((x, y) => x.start - y.start)
      let at = 0
      for (const s of spans) {
        if (s.start > at) p.append(text.slice(at, s.start))
        if (s.channel) {
          const ch = s.channel
          const b = el('button', 'ch-mention ch-chanref', text.slice(s.start, s.end))
          b.type = 'button'
          b.title = HASH_TEXT.open(ch.name)
          b.dataset.channelRef = ch.id
          b.addEventListener('click', () => open(ch.id, ch.name))
          p.append(b)
          at = s.end
          continue
        }
        const m = el('span', 'ch-mention', text.slice(s.start, s.end))
        const id = members.find(x => x.name === s.name)?.id
        if (id !== undefined) hueStyle(m, agentHue(id))
        m.dataset.member = s.name
        p.append(m)
        at = s.end
      }
      if (at < text.length) p.append(text.slice(at))
    }

    /**
     * An agent's name: a button that goes to its pane on click (the same path as a tether://tab link, with its dialogs for a pane
     * that is closed or unknown) and peeks at it on Alt+click; a plain name for who has no pane (the person). It does not look like a
     * link (channels.css). `rowMenu`: a right-click on it reaches the member row's own menu by bubbling, so it does not open one itself.
     */
    private agentName(id: string | undefined, cls: string, text: string, rowMenu = false): HTMLElement {
      const url = agentLinkOf(id)
      if (id === undefined || url === undefined) return el('span', cls, text)
      const b = el('button', `${cls} ch-agent`, text)
      b.type = 'button'
      b.title = noDesk(id) ? PANE_TEXT.nameTipNoDesk : PANE_TEXT.nameTip
      b.dataset.agent = id
      const target = linkTargetOfUrl(url)
      // An agent with no pane has no tab to go to (the link would ask to reopen a closed tab): the click opens the peek card.
      b.addEventListener('click', ev => { if (isPeekModifier(ev) || noDesk(id)) ui.panes.peek(id); else ui.links.follow(target) })
      if (!rowMenu) b.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this.openNameMenu(id, text, ev.clientX, ev.clientY) })
      return b
    }

    /** A gesture on a member (the commands ask the consequence in their dialog). Taking someone out may leave the list empty: the focus then goes to the accent. */
    private memberAct(act: 'mute' | 'unmute' | 'remove', agent: string): void {
      if (act === 'remove') this.joinFocusUntil = Date.now() + JOIN_FOCUS_MS
      void ui.commands.run(CMD[act], { channel: this.channelId, agent })
    }

    // ---------- the focus around a member's gestures (G9) ----------

    /** The stop of a button of a member's row: its `data-act`, or "name" for the link to the agent's pane. */
    private actOf(node: Element | null): string {
      if (!(node instanceof HTMLElement)) return 'more'
      return node.dataset.act ?? (node.classList.contains('ch-link') ? 'name' : 'more')
    }

    /** Remembers where the focus returns to for a gesture on this member: its `act` button, and the neighbours for when the row goes away. */
    private markReturn(id: string, act: string): void {
      const ids = [...this.side.querySelectorAll<HTMLElement>('.ch-mrow[data-member]')].map(r => r.dataset.member!)
      const at = ids.indexOf(id)
      const next = at < 0 ? [] : [...ids.slice(at + 1), ...ids.slice(0, at).reverse()]
      this.memberReturn = { id, act, next, until: Date.now() + JOIN_FOCUS_MS }
    }

    /** Puts the focus on a member's button (or, when that one cannot take it, on the row's "⋯" or name); false when the row is not there. */
    private focusMember(id: string, act: string): boolean {
      const row = this.side.querySelector<HTMLElement>(`.ch-mrow[data-member="${CSS.escape(id)}"]`)
      if (!row) return false
      const own = act === 'mute' || act === 'unmute' ? '[data-act="mute"], [data-act="unmute"]' : act === 'name' ? '.ch-link' : `[data-act="${act}"]`
      for (const sel of [own, '.ch-mmore', '.ch-link']) {
        const b = row.querySelector<HTMLElement>(sel)
        if (!b) continue
        b.focus()
        if (document.activeElement === b) return true
      }
      return false
    }

    /**
     * After a menu or a dialog closes (or the list is redrawn under the focus): the focus goes back to the button the person pressed, to the
     * next row when the member is gone, to the accent "Juntar agente…" when nobody is left. Only when the focus is lost: never taken from a
     * place the person went to.
     */
    private returnFocus(): void {
      const r = this.memberReturn
      if (!r || this.disposed) return
      if (Date.now() > r.until) { this.memberReturn = undefined; return }
      const a = document.activeElement
      if (a !== null && a !== document.body) return
      if (!this.sideShown()) { (this.isNarrow() ? this.fold : this.membersBtn)?.focus(); return }
      if (this.focusMember(r.id, r.act)) return
      for (const id of r.next) if (this.focusMember(id, 'more')) return
      if (this.noMembers()) this.joinBtn?.focus()
    }

    /** The member's menu (plan 2.6) at page coordinates; `act` is the stop it was opened from (where the focus comes back to). */
    private openMemberMenu(m: MemberRow, x: number, y: number, act = 'more'): void {
      this.markReturn(m.id, act)
      this.side.querySelector(`.ch-mrow[data-member="${CSS.escape(m.id)}"] .ch-mmore`)?.setAttribute('aria-expanded', 'true')
      this.showAgentMenu(m.id, memberMenu({ name: m.name, owner: m.crown, muted: m.muted, fromDesk: m.fromDesk, noDesk: m.noDesk }), x, y, m)
    }

    /**
     * The menu of an agent's name wherever the name shows (the member's row, the author of a speech, the owner in the header): the way
     * to its pane on top, then the member's rows. Who is no longer a member (or any name of a closed channel) has only the way and the link.
     */
    private openNameMenu(id: string, name: string, x: number, y: number): void {
      const m = this.isClosed() || !this.answer ? undefined : memberRows(this.answer, undefined, noDesk).find(r => r.id === id)
      this.showAgentMenu(id, m ? memberMenu({ name: m.name, owner: m.crown, muted: m.muted, fromDesk: m.fromDesk, noDesk: m.noDesk }) : agentNameMenu(name, noDesk(id)), x, y, m)
    }

    private showAgentMenu(id: string, entries: MemberMenuEntry[], x: number, y: number, m?: MemberRow): void {
      const run: Record<string, () => void> = {
        go: () => (noDesk(id) ? ui.panes.peek(id) : ui.links.follow(linkTargetOfUrl(agentLinkOf(id) ?? ''))),
        peek: () => ui.panes.peek(id),
        copy: () => ui.panes.copyLink(id),
        emblem: () => ui.panes.emblemMenu(id, x, y),
        ...(m ? {
          mute: () => this.memberAct('mute', id),
          unmute: () => this.memberAct('unmute', id),
          remove: () => this.memberAct('remove', id),
          talk: () => this.composer.address(m.name),
        } : {}),
      }
      const rows: ContextMenuRow[] = entries.map((e): ContextMenuRow =>
        e === 'sep' || 'heading' in e ? e
          : { icon: e.icon, label: e.label, run: run[e.id]!, ...(e.hint ? { hint: e.hint } : {}), ...(e.danger ? { danger: true } : {}) })
      // The menu takes headings (the core's `fromExtMenu`); only its declared parameter type leaves them out.
      ui.menus.context(x, y, rows as ContextMenuEntry[])
    }

    private paintMembers(): void {
      const side = this.side
      // The list is redrawn whole: a focus on one of its buttons is put back on the same one (or the next row if the member went away).
      const held = document.activeElement instanceof HTMLElement && side.contains(document.activeElement) ? document.activeElement : undefined
      const heldId = held?.closest<HTMLElement>('.ch-mrow[data-member]')?.dataset.member
      if (held && heldId) this.markReturn(heldId, this.actOf(held))
      side.replaceChildren()
      if (!this.answer) return
      // The emblems are read at each redraw (no observer): a change shows when the list is drawn again.
      const rows = memberRows(this.answer, id => ui.panes.personEmblem(id), noDesk)
      const sec = el('div', 'ch-sec')
      sec.append(el('span', '', `Membros · ${rows.length}`))
      // The list proper: the heading above it is not one of its items.
      const list = el('div', 'ch-mlist')
      list.setAttribute('role', 'list')
      list.setAttribute('aria-label', 'Membros')
      side.append(sec, list)
      for (const m of rows) {
        const row = el('div', 'ch-mrow')
        row.dataset.member = m.id
        row.setAttribute('role', 'listitem')
        row.setAttribute('aria-label', memberAria(m))
        hueStyle(row, m.hue)
        const l1 = el('div', 'ch-l1')
        // [engine icon] [emblem or letter] name, the order of the tab.
        const ident = identityOfAgent(m.id, m.name)
        const em = engineCell(ident, m.crown)
        // The row's own right-click menu (open channel) is the name's menu too: it bubbles up from the name.
        const name = this.agentName(m.id, 'ch-oname ch-link', m.name, !this.isClosed())
        l1.append(em, markCell(ident), name)
        // The narrow row is one line: the role, the muted mark and the state as a dot ride on it (the second line is away there).
        const nrole = el('span', 'ch-nrole')
        nrole.append(el('span', 'ch-role', m.role))
        if (m.muted) {
          const mute = el('span', 'ch-role mute')
          mute.append(glyph('speaker-slash'), 'calado')
          nrole.append(mute)
        }
        const dot = el('span', 'ch-dot')
        dot.dataset.tone = m.tone
        dot.title = m.hint ?? m.state
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', m.state)
        l1.append(nrole, dot)
        if (m.tone === 'wait') {
          // The narrow row has no second line for the state: a member that does not hear now says so in words, beside the dot (the dot's own
          // name already says it to a screen reader, so the words are hidden from it).
          const warn = el('span', 'ch-warnlbl', 'não ouve')
          warn.setAttribute('aria-hidden', 'true')
          l1.append(warn)
        }
        if (!this.isClosed()) {
          // The owner's row has only the "⋯"; the others show Calar and Tirar on hover and focus, and the "⋯" always.
          // The command asks the consequence in its dialog (calar, tirar) before it acts.
          if (!m.crown) {
            const acts = el('span', 'ch-macts')
            const toggle = m.muted
              ? this.actionBtn('ch-act ch-mact', PANE_TEXT.on(PANE_TEXT.unmute, m.name), 'speaker-high', () => { this.markReturn(m.id, 'unmute'); this.memberAct('unmute', m.id) })
              : this.actionBtn('ch-act ch-mact', PANE_TEXT.on(PANE_TEXT.mute, m.name), 'speaker-slash', () => { this.markReturn(m.id, 'mute'); this.memberAct('mute', m.id) })
            toggle.dataset.act = m.muted ? 'unmute' : 'mute'
            const out = this.actionBtn('ch-act ch-mact', PANE_TEXT.on(PANE_TEXT.remove, m.name), 'user-minus', () => { this.markReturn(m.id, 'remove'); this.memberAct('remove', m.id) })
            out.dataset.act = 'remove'
            acts.append(toggle, out)
            l1.append(acts)
          }
          const more = this.actionBtn('ch-act ch-mact ch-mmore', PANE_TEXT.memberMore(m.name), 'dots-three', () => {
            const r = more.getBoundingClientRect()
            this.openMemberMenu(m, r.left, r.bottom)
          })
          more.dataset.act = 'more'
          more.setAttribute('aria-haspopup', 'menu')
          more.setAttribute('aria-expanded', 'false')
          l1.append(more)
          row.addEventListener('contextmenu', ev => {
            ev.preventDefault()
            // The keyboard's own menu key already opened it (below): its `contextmenu` event is the same gesture.
            if (performance.now() - this.keyMenuAt < 400) return
            this.openMemberMenu(m, ev.clientX, ev.clientY)
          })
          // The menu key and Shift+F10 on any button of the row: the same menu, at the button that holds the focus.
          row.addEventListener('keydown', ev => {
            if (!(ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey))) return
            ev.preventDefault()
            this.keyMenuAt = performance.now()
            const at = ev.target instanceof HTMLElement && ev.target.getClientRects().length > 0 ? ev.target : more
            const r = at.getBoundingClientRect()
            this.openMemberMenu(m, r.left, r.bottom, this.actOf(at))
          })
        }
        const l2 = el('div', 'ch-l2')
        l2.append(el('span', 'ch-role', m.role))
        if (m.muted) {
          const mute = el('span', 'ch-role mute')
          mute.append(glyph('speaker-slash'), 'calado')
          l2.append(mute)
        }
        const state = el('span', 'ch-state', m.state)
        state.dataset.tone = m.tone
        if (m.hint !== undefined) state.title = m.hint
        l2.append(state)
        row.append(l1, l2)
        list.append(row)
      }
      const me = el('div', 'ch-mrow')
      me.setAttribute('role', 'listitem')
      me.setAttribute('aria-label', MODERATOR_ARIA)
      const l1 = el('div', 'ch-l1')
      const em = el('span', 'ch-em me')
      em.append(glyph('user'))
      l1.append(em, el('span', 'ch-author', 'Você'))
      const l2 = el('div', 'ch-l2')
      l2.append(el('span', 'ch-role mod', 'moderador'), el('span', 'ch-state', 'lê tudo, fala em qualquer canal'))
      me.append(l1, l2)
      list.append(me)
      if (held) this.returnFocus()
    }

    // ---------- test ----------

    /** The attributes of G9 as they are on the page now, and the regions the Tab visits in order (consecutive stops of one region count once). */
    private ariaSnapshot(): PaneSnapshot['aria'] {
      const at = (e: Element | null | undefined, n: string): string => e?.getAttribute(n) ?? ''
      const region = (e: HTMLElement): string =>
        this.bar.contains(e) ? 'toolbar' : this.fold.contains(e) ? 'strip' : this.side.contains(e) ? 'members'
          : this.msgs.contains(e) ? 'log' : this.newBar.contains(e) ? 'newbar' : this.composerSlot.contains(e) ? 'composer' : 'other'
      const stops = [...this.element.querySelectorAll<HTMLElement>('button, select, textarea, input, [tabindex="0"]')]
        .filter(e => !(e as HTMLButtonElement).disabled && e.tabIndex >= 0 && e.getClientRects().length > 0)
        .map(region)
      const list = this.side.querySelector('[role="list"]')
      return {
        toolbar: { role: at(this.bar, 'role'), label: at(this.bar, 'aria-label') },
        membersBtn: { pressed: at(this.membersBtn, 'aria-pressed'), controls: at(this.membersBtn, 'aria-controls'), hidden: this.membersBtn?.hidden ?? true },
        fold: { expanded: at(this.fold, 'aria-expanded'), label: at(this.fold, 'aria-label'), controls: at(this.fold, 'aria-controls') },
        list: {
          role: at(list, 'role'), label: at(list, 'aria-label'),
          items: [...(list?.querySelectorAll('[role="listitem"]') ?? [])].map(i => ({ role: at(i, 'role'), label: at(i, 'aria-label') })),
        },
        log: { role: at(this.msgs, 'role'), live: at(this.msgs, 'aria-live'), label: at(this.msgs, 'aria-label'), relevant: at(this.msgs, 'aria-relevant'), tabindex: at(this.msgs, 'tabindex') },
        moreMenu: at(this.bar.querySelector('.ch-more'), 'aria-haspopup'),
        tabs: stops.filter((r, i) => i === 0 || stops[i - 1] !== r),
      }
    }

    snapshot(): PaneSnapshot {
      const m = this.msgs
      const h = this.answer ? headerOf(this.answer) : undefined
      return {
        loaded: this.loaded, error: this.error, title: h?.title ?? '', sub: h?.sub ?? '', closed: h?.closed ?? false,
        rows: this.rows().map(r => r.kind === 'day' ? { kind: r.kind, text: r.label }
          : r.kind === 'unseen' ? { kind: r.kind, text: r.label }
          : r.kind === 'notice' ? { kind: r.kind, text: r.text, glyph: r.glyph }
          : r.kind === 'poll' ? { kind: r.kind, text: r.question, name: r.name, role: r.role, crown: r.crown, mine: r.mine }
          : { kind: r.kind, text: r.body, name: r.name, role: r.role, crown: r.crown, mine: r.mine, to: r.to.map(t => t.name), continued: r.continued }),
        polls: this.timeline.lines.filter(l => l.kind === 'poll').flatMap(l => { const c = this.cardFor(l.seq); return c ? [c] : [] }),
        pollInput: [...this.pollInput].map(([seq, i]) => ({ seq, ...(i.reasonFor !== undefined ? { reasonFor: i.reasonFor } : {}), text: i.text })),
        pollNames: [...this.msgs.querySelectorAll<HTMLElement>(':scope > .ch-prow')].map(r => ({ seq: Number(r.dataset.seq), role: r.getAttribute('role') ?? '', label: r.getAttribute('aria-label') ?? '' })),
        pollFocus: document.activeElement instanceof HTMLElement && this.msgs.contains(document.activeElement) ? Number(document.activeElement.closest<HTMLElement>('.ch-prow')?.dataset.seq ?? 0) : 0,
        owed: marks.owedOf(this.channelId).length,
        members: this.answer ? memberRows(this.answer).map(x => ({
          name: x.name, role: x.role, muted: x.muted, state: x.state, tone: x.tone, emblem: this.side.querySelector(`.ch-mrow[data-member="${x.id}"] .ch-emblem`)?.getAttribute('aria-label') ?? '',
          hint: this.side.querySelector(`.ch-mrow[data-member="${x.id}"] .ch-state`)?.getAttribute('title') ?? '',
          acts: [...this.side.querySelectorAll(`.ch-mrow[data-member="${x.id}"] [data-act]`)].map(b => (b as HTMLElement).dataset.act ?? ''),
        })) : [],
        muteBar: this.answer ? muteBar(this.answer) : '',
        scroll: { top: m.scrollTop, client: m.clientHeight, height: m.scrollHeight, stick: this.stick },
        unread: this.unread, more: this.timeline.more, last: this.timeline.last, membersOpen: this.membersOpen,
        hasComposerSlot: this.element.querySelector('.ch-composer-slot') !== null,
        ...(this.viewer.snapshot() ? { viewer: this.viewer.snapshot()! } : {}),
        drop: { shown: !this.dropZone.hidden, title: this.dropZone.querySelector('.ch-drop-t')?.textContent ?? '', sub: this.dropZone.querySelector('.ch-drop-s')?.textContent ?? '', refuse: this.dropZone.classList.contains('refuse') },
        toast: this.toastEl.hidden ? '' : (this.toastEl.textContent ?? ''),
        announce: this.announceEl.textContent ?? '',
        picker: {
          open: this.picker !== undefined, seq: this.picker?.seq ?? 0, recents: [...this.recents],
          hint: this.picker?.input.placeholder ?? '', error: this.picker?.error.textContent ?? '',
        },
        focusSeq: document.activeElement instanceof HTMLElement && this.msgs.contains(document.activeElement) ? Number(document.activeElement.closest<HTMLElement>('.ch-msg')?.dataset.seq ?? 0) : 0,
        ...(this.composerSlot.contains(this.composer.element) ? { composer: this.composer.snapshot() } : {}),
        bar: this.newBar.hidden ? '' : (this.newBar.textContent ?? ''), barMe: this.newBar.classList.contains('me'), toMe: marks.of(this.channelId).toMe, asks: marks.asksOf(this.channelId).length,
        actions: this.barState(),
        empty: this.noMembers(),
        column: { shown: !this.side.hidden, button: this.membersBtn !== undefined && !this.membersBtn.hidden },
        fold: this.answer
          ? { count: this.answer.members.length, muted: this.answer.members.filter(x => x.muted).length, open: this.isNarrow() && this.sideShown() }
          : { count: 0, muted: 0, open: false },
        foldBar: { shown: !this.fold.hidden, warn: this.answer ? foldOf(this.answer).waiting : 0 },
        aria: this.ariaSnapshot(),
      }
    }
    scrollTo(top: number): void { this.msgs.scrollTop = top; this.onScroll() }
    olderNow(): Promise<void> { return this.loadOlder() }
  }

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

  const open = (channelId: string, name?: string): void => {
    const id = channelPaneId(channelId)
    if (ui.panes.find(id)) { ui.panes.reveal(id); return }
    ui.panes.open({ id, component: CHANNEL_COMPONENT, tabComponent: CHANNEL_TAB, title: `#${name ?? channelId}`, params: { channelId } })
  }

  // The palette's rows to react to the focused speech (what has a key has a menu): they act on the channel pane that is active.
  const activeChannelPane = (): ChannelPane | undefined => {
    const id = ui.panes.activeId()
    return id !== undefined && id.startsWith(CHANNEL_PANE_PREFIX) ? tabOf(channelIdOfPane(id)) : undefined
  }

  const mountEmbed = (host: HTMLElement, channelId: string, opts: EmbedOptions = {}): EmbeddedChannel => {
    const view = new ChannelPane()
    const name = (): string | undefined => { const c = channelList().find(x => x.id === channelId); return c ? `#${c.name}` : undefined }
    host.append(view.element)
    view.attach({
      kind: 'embed', id: channelPaneId(channelId),
      title: name,
      setTitle: () => {},
      showMenu: (x, y) => ui.menus.context(x, y, view.menuRows(channelPaneId(channelId)) as ContextMenuEntry[]),
    }, channelId, opts)
    let gone = false
    return {
      element: view.element,
      channelId,
      members: () => view.memberList(),
      onDidChangeMembers: listener => view.onDidChangeMembers(listener),
      focus: () => view.focusView(),
      dispose: () => {
        if (gone) return
        gone = true
        view.dispose()
        view.element.remove()
        if (opts.membersHost) view.sideElement().remove()
      },
    }
  }
  const inChannel = (ctx: { paneType?: string }): boolean => ctx.paneType === type.id
  const reactRows = [
    { id: REACT_COMMAND, title: 'Reagir à fala focada…', run: (p: ChannelPane) => p.reactFocused(undefined) },
    { id: `${REACT_COMMAND}.last`, title: 'Reagir à última fala…', run: (p: ChannelPane) => p.reactFocused(undefined, true) },
    ...FIVE.map(f => ({
      id: `${REACT_COMMAND}.${f.name}`, title: `Reagir à fala focada: ${f.emoji} ${f.label}`, run: (p: ChannelPane) => p.reactFocused(f.emoji),
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
      create: () => new ChannelPane(),
      createTab: () => new ChannelTab() as unknown as ITabRenderer,
      has: id => id.startsWith(CHANNEL_PANE_PREFIX) && tabOf(channelIdOfPane(id)) !== undefined,
      // The channel's one menu, from `channelMenu` (texts.ts): the tab's right click and the bar's "⋯" both land here.
      // The menu takes headings (the core's `fromExtMenu`); only the declared parameter type of `context` leaves them out.
      tabMenu: (id, x, y) => ui.menus.context(x, y, (tabOf(channelIdOfPane(id))?.menuRows(id) ?? []) as ContextMenuEntry[]),
    }),
    ui.daemon.onEvent<LineEvent>('line', ev => { for (const p of live) if (p.channelId === ev.channelId) p.onLine(ev) }),
    ui.daemon.onEvent<ChannelEvent>('channel', ev => { for (const p of live) if (p.channelId === ev.channel.id) p.onChannel() }),
    ui.daemon.onEvent<ReactionEvent>('reaction', ev => { for (const p of live) if (p.channelId === ev.channelId) p.onReaction(ev) }),
    ui.daemon.onEvent<PollEvent>('poll', ev => { for (const p of live) if (p.channelId === ev.channelId) p.onPoll(ev) }),
  ]

  // Test hooks: text and flags of a pane, plus the minimum to drive it (open, scroll, ask the daemon as the app does).
  // Read at window.__tether.ext.channels.<name>.
  ui.test.expose('open', open)
  ui.test.expose('view', (channelId: string): PaneSnapshot | undefined => paneOf(channelId)?.snapshot())
  // The embedded view of a channel (the Regency's centre), apart from its tab.
  ui.test.expose('embedView', (channelId: string): PaneSnapshot | undefined => [...live].find(p => p.channelId === channelId && p.kind === 'embed')?.snapshot())
  ui.test.expose('wearEmblem', (paneId: string, emblemId: string | undefined): void => { ui.panes.find(paneId)?.api.updateParameters({ emblem: emblemId }) })
  ui.test.expose('kept',(channelId: string): boolean => kept.has(channelId))
  ui.test.expose('scrollTo', (channelId: string, top: number): void => paneOf(channelId)?.scrollTo(top))
  ui.test.expose('loadOlder', (channelId: string): Promise<void> => paneOf(channelId)?.olderNow() ?? Promise.resolve())

  return { disposables, open, snapshot: channelId => paneOf(channelId)?.snapshot(), mountEmbed }
}
