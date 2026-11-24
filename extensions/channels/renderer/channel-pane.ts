// The channel's pane (slice U1a, reading only): the conversation, the members with the state of each, the header. One channel,
// one pane (`channel:<channelId>`, P3). It asks the daemon half (`history`, `members`) and hears `line` and `channel` (N1); what it
// shows is decided by view-model.ts, this file only paints and keeps the place.
//   - A new line never activates the pane, never switches the desk, never steals focus: the pane repaints itself where it is.
//     If the person reads above the end the view does not move (a bar says how many came); at the end it follows.
//   - Moving the pane to another desk rebuilds it; the place (lines held, scroll, "reading the end") is kept per channel in memory,
//     up to KEPT_MAX channels, and the newest page is asked again to fill the end.
//   - The speaking box (composer.ts, U1b) sits in `.ch-composer-slot`; a closed channel has none. Orange is the U3's.
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer } from 'dockview-core'
import type { Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { emblemBadge } from '../../../app/renderer/tab-emblems.ts'
import type { ChannelEvent, LineEvent } from '../daemon/fanout.ts'
import type { Line } from '../rules.ts'
import { CHANNEL_COMPONENT, CHANNEL_PANE_PREFIX, CHANNEL_TAB, CMD, channelIdOfPane, channelPaneId, manifest } from '../manifest.ts'
import { createComposer, type ComposerSnapshot } from './composer.ts'
import { glyph, NOTICE_ICON } from './glyphs.ts'
import { PANE_TEXT } from './texts.ts'
import type { Marks } from './marks.ts'
import {
  applyLine, applyPage, DEFAULT_MODERATOR_NAME, emptyTimeline, forYouLabel, headerOf, idByName, isNearBottom, memberRows, mergeNewest, muteBar,
  olderCursor, rowsOf, unreadLabel, type HistoryPage, type MembersAnswer, type Row, type Timeline,
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

interface Kept { timeline: Timeline; scrollTop: number; stick: boolean }

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
  members: Array<{ name: string; role: string; muted: boolean; state: string; tone: string; emblem: string }>
  muteBar: string
  scroll: { top: number; client: number; height: number; stick: boolean }
  unread: number
  more: boolean
  last: number
  membersOpen: boolean
  hasComposerSlot: boolean
  /** The speaking box; absent while the channel is closed. */
  composer?: ComposerSnapshot
  /** The bar over the conversation ("N novas para você" or "N falas novas"); '' while hidden. `barMe`: the one for her. */
  bar: string
  barMe: boolean
  /** Unseen lines addressed to the person, as the marks hold them. */
  toMe: number
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
}

export interface ChannelPanes {
  disposables: Disposable[]
  /** Opens the channel's pane, or brings the one that exists forward (P3). */
  open(channelId: string, name?: string): void
  snapshot(channelId: string): PaneSnapshot | undefined
}

export function createChannelPanes(ui: TetherUi, marks: Marks): ChannelPanes {
  const live = new Set<ChannelPane>()
  const kept = new Map<string, Kept>()
  const type = manifest.contributes!.paneTypes![0]!

  const keep = (channelId: string, k: Kept): void => {
    kept.delete(channelId)
    kept.set(channelId, k)
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value as string)
  }
  const paneOf = (channelId: string): ChannelPane | undefined => [...live].find(p => p.channelId === channelId)
  const moderatorName = (): string => ui.settings.get<string>('moderatorName') ?? DEFAULT_MODERATOR_NAME

  class ChannelPane implements IContentRenderer {
    readonly element = el('div', 'ch-pane')
    channelId = ''
    private api: GroupPanelPartInitParameters['api'] | undefined
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
    private readonly composerSlot = el('div', 'ch-composer-slot')
    private readonly side = el('div', 'ch-members')
    private membersBtn: HTMLButtonElement | undefined
    private joinBtn: HTMLButtonElement | undefined
    private reopenBtn: HTMLButtonElement | undefined
    private endBtn: HTMLButtonElement | undefined
    /** Whether the empty state ("Ninguém no canal ainda.") was drawn last, to repaint the conversation when it flips. */
    private drewNoMembers = false
    private readonly composer = createComposer({ send: (text, to) => this.say(text, to) })

    init(p: GroupPanelPartInitParameters): void {
      this.api = p.api
      this.channelId = String((p.params as { channelId?: string }).channelId ?? channelIdOfPane(p.api.id))
      this.element.dataset.channel = this.channelId
      const k = kept.get(this.channelId)
      if (k) { this.timeline = k.timeline; this.stick = k.stick; this.lastTop = k.scrollTop; this.pendingScroll = k.stick ? 'end' : k.scrollTop }
      else this.pendingScroll = 'end'
      live.add(this)

      this.newBar.type = 'button'
      this.newBar.addEventListener('click', () => this.onBar())
      this.composerSlot.dataset.slot = 'composer'
      this.foot.append(this.composerSlot)
      this.conv.append(this.msgs, this.newBar, this.muteBox, this.foot)
      this.body.append(this.conv, this.side)
      this.head.append(this.titleBox, this.bar)
      this.element.append(this.head, this.body)
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
        // The orange separator goes when the person sees the line (the same `seen` rule as the marks).
        const first = marks.of(this.channelId).firstToMe
        if (first !== this.separatorAt) this.paintMsgs()
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
      this.ro?.disconnect()
      this.contentRo?.disconnect()
      for (const s of this.subs) s.dispose()
      live.delete(this)
      // A pane that moved to another desk is rebuilt: its place is what the new one starts from.
      // (The scroll is read from the last scroll event: by now the element has left the page and says 0.)
      if (this.loaded) keep(this.channelId, { timeline: this.timeline, scrollTop: this.lastTop, stick: this.stick })
      marks.paneChanged(this.channelId)
    }

    /**
     * The person sees the end of the conversation: the pane is shown (active tab of the visible desk), the window is in front and
     * the view is at the end. Then up to the newest line is seen: the marks go and the daemon is told (`seen`).
     */
    private checkSeen(): void {
      if (!this.loaded || this.disposed || !this.stick || !this.visible()) return
      if (!document.hasFocus() || document.visibilityState !== 'visible') return
      marks.viewed(this.channelId, this.timeline.last)
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
        this.timeline = this.timeline.lines.length > 0 ? mergeNewest(this.timeline, page) : applyPage(this.timeline, page, false)
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
      } catch (e) {
        if (this.disposed) return
        const code = (e as { code?: string }).code
        this.error = code === 'unknown-channel' ? 'Este canal não existe mais.' : `Não consegui ler o canal: ${(e as Error).message}`
      }
      this.paint()
      if (this.loaded && this.stick && this.pendingScroll === undefined) this.scrollEnd()
      this.checkSeen()
    }

    private async refreshMembers(): Promise<void> {
      try {
        const members = await this.ask<MembersAnswer>('members')
        if (this.disposed) return
        this.answer = members
        this.syncTitle()
        this.paintHead()
        this.paintMembers()
        this.paintSide()
        this.paintBar()
        this.paintMuteBar()
        this.paintFoot()
        if (this.noMembers() !== this.drewNoMembers) this.paintMsgs()
      } catch { /* the next event asks again */ }
    }

    private scheduleMembers(): void {
      if (this.membersTimer || this.disposed) return
      this.membersTimer = setTimeout(() => { this.membersTimer = undefined; void this.refreshMembers() }, MEMBERS_REFRESH_MS)
    }

    private async loadOlder(): Promise<void> {
      const before = olderCursor(this.timeline)
      if (before === undefined || this.loadingOlder || this.disposed) return
      this.loadingOlder = true
      const m = this.msgs
      const oldHeight = m.scrollHeight
      const oldTop = m.scrollTop
      try {
        const page = await this.ask<HistoryPage>('history', { before, limit: PAGE_SIZE })
        if (this.disposed) return
        this.timeline = applyPage(this.timeline, page, true)
        this.paintMsgs()
        // The lines went on top: what the person was reading stays where it was.
        m.scrollTop = oldTop + (m.scrollHeight - oldHeight)
      } catch { /* the "Ver anteriores" button tries again */ }
      this.loadingOlder = false
    }

    onLine(ev: LineEvent): void {
      // Before the first answer the line may or may not be in it: keep it, and apply it when the page is in (a repeat is ignored).
      if (!this.loaded) { if (this.early.length < PAGE_SIZE * 4) this.early.push(ev.line); return }
      const r = applyLine(this.timeline, ev.line)
      if (!r.added) return
      this.timeline = r.timeline
      if (r.gap) { void this.catchUp(); return }
      if (!this.stick) this.unread++
      this.paintMsgs()
      if (this.stick) this.scrollEnd()
      this.paintNewBar()
      this.scheduleMembers()
      this.checkSeen()
    }

    onChannel(): void { if (this.loaded) void this.refreshMembers() }

    private async catchUp(): Promise<void> {
      try {
        const page = await this.ask<HistoryPage>('history', { limit: PAGE_SIZE })
        if (this.disposed) return
        const before = this.timeline.last
        this.timeline = mergeNewest(this.timeline, page)
        if (!this.stick) this.unread += Math.max(0, this.timeline.last - before)
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
      if (this.api && this.api.title !== title) this.api.setTitle(title)
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
      members.append(glyph('users'))
      members.addEventListener('click', () => { this.membersTouched = true; this.membersOpen = !this.membersOpen; this.paintSide() })
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
      if (!this.api) return
      const r = opener.getBoundingClientRect()
      ui.panes.showTabMenu(this.api.id, r.left, r.bottom, opener)
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
      if (this.joinBtn) { this.joinBtn.hidden = s.primary !== 'join'; this.joinBtn.classList.toggle('labeled', s.labeled) }
      if (this.reopenBtn) { this.reopenBtn.hidden = s.primary !== 'reopen'; this.reopenBtn.classList.toggle('labeled', s.labeled) }
      if (this.endBtn) this.endBtn.hidden = !s.toEnd
    }

    /** "Ir para o fim", for the tab menu (the bar drops it in the narrow composition). */
    goEnd(): void { this.toEnd() }

    private paintHead(): void {
      this.paintBar()
      this.titleBox.replaceChildren()
      if (!this.answer) { this.titleBox.append(glyph('chats-circle'), el('span', 'ch-name-title', this.api?.title ?? '')); return }
      const h = headerOf(this.answer)
      const sub = el('span', 'ch-sub')
      sub.append(`${this.answer.members.length === 1 ? '1 membro' : `${this.answer.members.length} membros`} · dono: `)
      const owner = el('span', 'ch-oname', h.ownerName)
      hueStyle(owner, h.ownerHue)
      sub.append(owner)
      if (h.closed) sub.append(' · encerrado')
      this.titleBox.append(glyph(h.closed ? 'lock' : 'chats-circle'), el('span', 'ch-name-title', h.title), sub)
    }

    /** The column is drawn when the person has it open and somebody is in the channel (a lone "Você" says nothing). */
    private sideShown(): boolean { return this.membersOpen && !this.noMembers() }

    private paintSide(): void {
      const shown = this.sideShown()
      this.side.hidden = !shown
      this.element.classList.toggle('members-off', !shown)
      if (this.membersBtn) { this.membersBtn.hidden = this.noMembers(); this.membersBtn.classList.toggle('on', shown) }
    }

    /** "N novas para você" (the lines addressed to her, unseen) beats "N falas novas"; neither shows while reading the end. */
    private barText(): { text: string; me: boolean } {
      if (this.stick) return { text: '', me: false }
      const toMe = marks.of(this.channelId).toMe
      if (toMe > 0) return { text: forYouLabel(toMe), me: true }
      return { text: this.unread > 0 ? unreadLabel(this.unread) : '', me: false }
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
      this.composer.setAudience(this.answer.members.length)
      if (this.composerSlot.firstChild !== this.composer.element) this.composerSlot.replaceChildren(this.composer.element)
    }

    private async say(text: string, to: string[]): Promise<void> {
      await this.ask('say', { text, ...(to.length > 0 ? { to } : {}) })
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
    canJoin(): boolean { return this.answer !== undefined && !this.isClosed() }

    private paintMsgs(): void {
      const m = this.msgs
      // Emptying the box resets its scroll: while shown, what the person was reading is put back (the end is the caller's).
      const keepTop = this.visible() ? m.scrollTop : undefined
      m.replaceChildren()
      try { this.fillMsgs(m) } finally { if (keepTop !== undefined && this.visible()) m.scrollTop = keepTop }
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
      const e = el('div', `ch-msg${r.mine ? ' mod' : ''}${r.continued ? ' continued' : ''}${r.to.some(t => t.you) ? ' to-me' : ''}`)
      e.dataset.seq = String(r.seq)
      hueStyle(e, r.hue)
      if (!r.continued) {
        const who = el('div', 'ch-who')
        const em = el('span', `ch-em${r.crown ? ' crown' : ''}${r.mine ? ' me' : ''}`)
        em.append(glyph(r.mine ? 'user' : r.crown ? 'crown-simple' : 'robot'))
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
        who.append(em, el('span', 'ch-author', r.name), role, dest, el('time', '', r.time))
        e.append(who)
      } else e.title = r.time
      e.append(el('p', '', r.body))
      return e
    }

    private paintMembers(): void {
      const side = this.side
      side.replaceChildren()
      if (!this.answer) return
      // The emblems are read at each redraw (no observer): a change shows when the list is drawn again.
      const rows = memberRows(this.answer, id => ui.panes.personEmblem(id))
      const sec = el('div', 'ch-sec')
      sec.append(el('span', '', `Membros · ${rows.length}`))
      side.append(sec)
      for (const m of rows) {
        const row = el('div', 'ch-mrow')
        row.dataset.member = m.id
        hueStyle(row, m.hue)
        const l1 = el('div', 'ch-l1')
        const em = el('span', `ch-em${m.crown ? ' crown' : ''}`)
        em.append(glyph(m.crown ? 'crown-simple' : 'robot'))
        const name = el('button', 'ch-oname ch-link', m.name)
        name.type = 'button'
        name.title = 'Ir para a guia deste agente'
        name.addEventListener('click', () => { if (ui.panes.find(m.id)) ui.panes.reveal(m.id) })
        l1.append(em, name)
        if (m.emblem) {
          const chip = emblemBadge(m.emblem)
          chip.classList.add('ch-emblem')
          chip.title = m.emblem.name
          l1.append(chip)
        }
        if (!this.isClosed()) {
          // The command asks the consequence in its dialog (calar, tirar) before it acts.
          const acts = el('span', 'ch-macts')
          const toggle = m.muted
            ? this.actionBtn('ch-act ch-mact', PANE_TEXT.on(PANE_TEXT.unmute, m.name), 'speaker-high', () => { void ui.commands.run(CMD.unmute, { channel: this.channelId, agent: m.id }) })
            : this.actionBtn('ch-act ch-mact', PANE_TEXT.on(PANE_TEXT.mute, m.name), 'speaker-slash', () => { void ui.commands.run(CMD.mute, { channel: this.channelId, agent: m.id }) })
          toggle.dataset.act = m.muted ? 'unmute' : 'mute'
          const out = this.actionBtn('ch-act ch-mact', PANE_TEXT.on(PANE_TEXT.remove, m.name), 'user-minus', () => { void ui.commands.run(CMD.remove, { channel: this.channelId, agent: m.id }) })
          out.dataset.act = 'remove'
          acts.append(toggle, out)
          l1.append(acts)
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
        l2.append(state)
        row.append(l1, l2)
        side.append(row)
      }
      const me = el('div', 'ch-mrow')
      const l1 = el('div', 'ch-l1')
      const em = el('span', 'ch-em me')
      em.append(glyph('user'))
      l1.append(em, el('span', 'ch-author', 'Você'))
      const l2 = el('div', 'ch-l2')
      l2.append(el('span', 'ch-role mod', 'moderador'), el('span', 'ch-state', 'lê tudo, fala em qualquer canal'))
      me.append(l1, l2)
      side.append(me)
    }

    // ---------- test ----------

    snapshot(): PaneSnapshot {
      const m = this.msgs
      const h = this.answer ? headerOf(this.answer) : undefined
      return {
        loaded: this.loaded, error: this.error, title: h?.title ?? '', sub: h?.sub ?? '', closed: h?.closed ?? false,
        rows: this.rows().map(r => r.kind === 'day' ? { kind: r.kind, text: r.label }
          : r.kind === 'unseen' ? { kind: r.kind, text: r.label }
          : r.kind === 'notice' ? { kind: r.kind, text: r.text, glyph: r.glyph }
          : { kind: r.kind, text: r.body, name: r.name, role: r.role, crown: r.crown, mine: r.mine, to: r.to.map(t => t.name), continued: r.continued }),
        members: this.answer ? memberRows(this.answer).map(x => ({ name: x.name, role: x.role, muted: x.muted, state: x.state, tone: x.tone, emblem: this.side.querySelector(`.ch-mrow[data-member="${x.id}"] .ch-emblem`)?.getAttribute('aria-label') ?? '' })) : [],
        muteBar: this.answer ? muteBar(this.answer) : '',
        scroll: { top: m.scrollTop, client: m.clientHeight, height: m.scrollHeight, stick: this.stick },
        unread: this.unread, more: this.timeline.more, last: this.timeline.last, membersOpen: this.membersOpen,
        hasComposerSlot: this.element.querySelector('.ch-composer-slot') !== null,
        ...(this.composerSlot.contains(this.composer.element) ? { composer: this.composer.snapshot() } : {}),
        bar: this.newBar.hidden ? '' : (this.newBar.textContent ?? ''), barMe: this.newBar.classList.contains('me'), toMe: marks.of(this.channelId).toMe,
        actions: this.barState(),
        empty: this.noMembers(),
        column: { shown: !this.side.hidden, button: this.membersBtn !== undefined && !this.membersBtn.hidden },
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
      const plain = m.unread - m.toMe
      this.ring.hidden = plain === 0
      this.ring.title = plain > 0 ? unreadLabel(plain) : ''
      // The orange counter: how many lines are for her (the plain ones stay the quiet ring, no number).
      this.dot.hidden = m.toMe === 0
      this.dot.textContent = m.toMe > 0 ? String(m.toMe > 99 ? '99+' : m.toMe) : ''
      this.dot.title = m.toMe > 0 ? forYouLabel(m.toMe) : ''
      this.element.dataset.mark = m.toMe > 0 ? 'me' : plain > 0 ? 'plain' : ''
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

  const disposables: Disposable[] = [
    ui.panes.register({
      ...type, hasSlot: false, icon: 'chats-circle',
      create: () => new ChannelPane(),
      createTab: () => new ChannelTab() as unknown as ITabRenderer,
      has: id => id.startsWith(CHANNEL_PANE_PREFIX) && paneOf(channelIdOfPane(id)) !== undefined,
      // The minimum every tab has, plus joining an agent; "Encerrar canal…" is added by menus.ts (the tab menu hook).
      tabMenu: (id, x, y) => ui.menus.context(x, y, [
        ...(paneOf(channelIdOfPane(id))?.canJoin() ? [{ icon: 'user-plus' as const, label: PANE_TEXT.joinMenu, run: () => { void ui.commands.run(CMD.join, { channel: channelIdOfPane(id) }) } }] : []),
        { icon: 'arrow-line-down' as const, label: PANE_TEXT.toEnd, run: () => paneOf(channelIdOfPane(id))?.goEnd() },
        'sep',
        { icon: 'link', label: 'Copiar link do painel', run: () => ui.panes.copyLink(id) },
        { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
        'sep',
        { icon: 'x', label: 'Fechar painel', run: () => ui.panes.close(id) },
      ]),
    }),
    ui.daemon.onEvent<LineEvent>('line', ev => { for (const p of live) if (p.channelId === ev.channelId) p.onLine(ev) }),
    ui.daemon.onEvent<ChannelEvent>('channel', ev => { for (const p of live) if (p.channelId === ev.channel.id) p.onChannel() }),
  ]

  // Test hooks: text and flags of a pane, plus the minimum to drive it (open, scroll, ask the daemon as the app does).
  // Read at window.__tether.ext.channels.<name>.
  ui.test.expose('open', open)
  ui.test.expose('view', (channelId: string): PaneSnapshot | undefined => paneOf(channelId)?.snapshot())
  ui.test.expose('wearEmblem', (paneId: string, emblemId: string | undefined): void => { ui.panes.find(paneId)?.api.updateParameters({ emblem: emblemId }) })
  ui.test.expose('kept',(channelId: string): boolean => kept.has(channelId))
  ui.test.expose('scrollTo', (channelId: string, top: number): void => paneOf(channelId)?.scrollTo(top))
  ui.test.expose('loadOlder', (channelId: string): Promise<void> => paneOf(channelId)?.olderNow() ?? Promise.resolve())

  return { disposables, open, snapshot: channelId => paneOf(channelId)?.snapshot() }
}
