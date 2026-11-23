// The channel's pane (slice U1a, reading only): the conversation, the members with the state of each, the header. One channel,
// one pane (`channel:<channelId>`, P3). It asks the daemon half (`history`, `members`) and hears `line` and `channel` (N1); what it
// shows is decided by view-model.ts, this file only paints and keeps the place.
//   - A new line never activates the pane, never switches the desk, never steals focus: the pane repaints itself where it is.
//     If the person reads above the end the view does not move (a bar says how many came); at the end it follows.
//   - Moving the pane to another desk rebuilds it; the place (lines held, scroll, "reading the end") is kept per channel in memory,
//     up to KEPT_MAX channels, and the newest page is asked again to fill the end.
//   - The speaking box is the next slice (U1b): its place is `.ch-composer-slot`. Orange is the U3's.
import type { GroupPanelPartInitParameters, IContentRenderer, ITabRenderer } from 'dockview-core'
import type { Disposable, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { ChannelEvent, LineEvent } from '../daemon/fanout.ts'
import { CHANNEL_COMPONENT, CHANNEL_PANE_PREFIX, CHANNEL_TAB, channelIdOfPane, channelPaneId, manifest } from '../manifest.ts'
import { glyph, NOTICE_ICON } from './glyphs.ts'
import {
  applyLine, applyPage, DEFAULT_MODERATOR_NAME, emptyTimeline, headerOf, idByName, isNearBottom, memberRows, mergeNewest, muteBar, olderCursor,
  rowsOf, unreadLabel, type HistoryPage, type MembersAnswer, type Row, type Timeline,
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
  members: Array<{ name: string; role: string; muted: boolean; state: string; tone: string }>
  muteBar: string
  scroll: { top: number; client: number; height: number; stick: boolean }
  unread: number
  more: boolean
  last: number
  membersOpen: boolean
  hasComposerSlot: boolean
}

export interface ChannelPanes {
  disposables: Disposable[]
  /** Opens the channel's pane, or brings the one that exists forward (P3). */
  open(channelId: string, name?: string): void
  snapshot(channelId: string): PaneSnapshot | undefined
}

export function createChannelPanes(ui: TetherUi): ChannelPanes {
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
    private pendingScroll: number | 'end' | undefined
    private membersTimer: ReturnType<typeof setTimeout> | undefined
    private disposed = false
    private ro: ResizeObserver | undefined
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

    init(p: GroupPanelPartInitParameters): void {
      this.api = p.api
      this.channelId = String((p.params as { channelId?: string }).channelId ?? channelIdOfPane(p.api.id))
      this.element.dataset.channel = this.channelId
      const k = kept.get(this.channelId)
      if (k) { this.timeline = k.timeline; this.stick = k.stick; this.pendingScroll = k.stick ? 'end' : k.scrollTop }
      else this.pendingScroll = 'end'
      live.add(this)

      this.newBar.type = 'button'
      this.newBar.addEventListener('click', () => this.toEnd())
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
      this.paint()
      void this.load()
    }

    dispose(): void {
      this.disposed = true
      if (this.membersTimer) clearTimeout(this.membersTimer)
      this.ro?.disconnect()
      for (const s of this.subs) s.dispose()
      live.delete(this)
      // A pane that moved to another desk is rebuilt: its place is what the new one starts from.
      if (this.loaded) keep(this.channelId, { timeline: this.timeline, scrollTop: this.msgs.scrollTop, stick: this.stick })
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
      } catch (e) {
        if (this.disposed) return
        const code = (e as { code?: string }).code
        this.error = code === 'unknown-channel' ? 'Este canal não existe mais.' : `Não consegui ler o canal: ${(e as Error).message}`
      }
      this.paint()
    }

    private async refreshMembers(): Promise<void> {
      try {
        const members = await this.ask<MembersAnswer>('members')
        if (this.disposed) return
        this.answer = members
        this.syncTitle()
        this.paintHead()
        this.paintMembers()
        this.paintMuteBar()
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
      if (!this.loaded) return
      const r = applyLine(this.timeline, ev.line)
      if (!r.added) return
      this.timeline = r.timeline
      if (r.gap) { void this.catchUp(); return }
      if (!this.stick) this.unread++
      this.paintMsgs()
      if (this.stick) this.scrollEnd()
      this.paintNewBar()
      this.scheduleMembers()
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
    }

    private onScroll(): void {
      if (!this.visible()) return
      const m = this.msgs
      this.stick = isNearBottom(m.scrollTop, m.clientHeight, m.scrollHeight)
      if (this.stick && this.unread > 0) this.unread = 0
      this.paintNewBar()
      if (m.scrollTop <= TOP_SLACK_PX) void this.loadOlder()
    }

    private onResize(): void {
      const narrow = this.element.clientWidth > 0 && this.element.clientWidth < NARROW_PX
      this.element.classList.toggle('narrow', narrow)
      if (!this.membersTouched && this.element.clientWidth > 0 && this.membersOpen === narrow) { this.membersOpen = !narrow; this.paintSide() }
      if (!this.visible()) return
      // First time it has a size (the tab was hidden, or the pane was just rebuilt): put it where the person left it.
      if (this.pendingScroll !== undefined) {
        const to = this.pendingScroll
        this.pendingScroll = undefined
        this.msgs.scrollTop = to === 'end' ? this.msgs.scrollHeight : to
      } else if (this.stick) this.msgs.scrollTop = this.msgs.scrollHeight
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

    private buildBar(): void {
      const members = el('button', 'ch-act on')
      members.type = 'button'
      members.title = 'Membros'
      members.setAttribute('aria-label', 'Membros')
      members.append(glyph('users'))
      members.addEventListener('click', () => { this.membersTouched = true; this.membersOpen = !this.membersOpen; this.paintSide() })
      this.membersBtn = members
      const end = el('button', 'ch-act')
      end.type = 'button'
      end.title = 'Ir para o fim'
      end.setAttribute('aria-label', 'Ir para o fim')
      end.append(glyph('arrow-line-down'))
      end.addEventListener('click', () => this.toEnd())
      this.bar.append(members, end)
    }

    private paintHead(): void {
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

    private paintSide(): void {
      this.side.hidden = !this.membersOpen
      this.element.classList.toggle('members-off', !this.membersOpen)
      this.membersBtn?.classList.toggle('on', this.membersOpen)
    }

    private paintNewBar(): void {
      const n = this.stick ? 0 : this.unread
      this.newBar.hidden = n === 0
      this.newBar.replaceChildren(glyph('arrow-line-down'), document.createTextNode(unreadLabel(n)))
    }

    private paintMuteBar(): void {
      const text = this.answer ? muteBar(this.answer) : ''
      this.muteBox.hidden = text === ''
      this.muteBox.replaceChildren(...(text === '' ? [] : [glyph('speaker-slash'), el('span', '', text)]))
    }

    private paintFoot(): void {
      // Reading only: a closed channel says so; the box that speaks fills `.ch-composer-slot` in U1b.
      const closed = this.answer?.channel.closed !== undefined
      this.foot.querySelector('.ch-closed')?.remove()
      if (closed) this.foot.prepend(el('div', 'ch-closed', 'Canal encerrado. A conversa fica guardada para leitura.'))
    }

    private rows(): Row[] {
      return rowsOf(this.timeline.lines, {
        moderatorName: moderatorName(),
        ...(this.answer ? { idByName: idByName(this.answer) } : {}),
        ...(this.answer?.channel.owner.kind === 'agent' ? { ownerId: this.answer.channel.owner.id } : {}),
      })
    }

    rowsView(): Row[] { return this.rows() }

    private paintMsgs(): void {
      const m = this.msgs
      m.replaceChildren()
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
      if (!this.loaded) { m.append(el('div', 'ch-empty', 'Lendo o canal…')); return }
      if (this.timeline.more) {
        const older = el('button', 'ch-btn ch-older', 'Ver anteriores')
        older.type = 'button'
        older.addEventListener('click', () => void this.loadOlder())
        m.append(older)
      }
      const rows = this.rows()
      if (rows.length === 0) {
        const box = el('div', 'ch-empty')
        box.append(el('p', 't', 'Ninguém falou ainda'), el('p', '', 'O que for dito neste canal aparece aqui.'))
        m.append(box)
        return
      }
      for (const r of rows) m.append(this.rowEl(r))
    }

    private rowEl(r: Row): HTMLElement {
      if (r.kind === 'day') return el('div', 'ch-day', r.label)
      if (r.kind === 'notice') {
        const e = el('div', 'ch-sys')
        e.dataset.seq = String(r.seq)
        e.dataset.glyph = r.glyph
        e.append(glyph(NOTICE_ICON[r.glyph]), el('span', 'ch-sys-text', r.text), el('time', '', r.time))
        return e
      }
      const e = el('div', `ch-msg${r.mine ? ' mod' : ''}${r.continued ? ' continued' : ''}`)
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
      const rows = memberRows(this.answer)
      side.append(el('div', 'ch-sec', `Membros · ${rows.length}`))
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
          : r.kind === 'notice' ? { kind: r.kind, text: r.text, glyph: r.glyph }
          : { kind: r.kind, text: r.body, name: r.name, role: r.role, crown: r.crown, mine: r.mine, to: r.to.map(t => t.name), continued: r.continued }),
        members: this.answer ? memberRows(this.answer).map(x => ({ name: x.name, role: x.role, muted: x.muted, state: x.state, tone: x.tone })) : [],
        muteBar: this.answer ? muteBar(this.answer) : '',
        scroll: { top: m.scrollTop, client: m.clientHeight, height: m.scrollHeight, stick: this.stick },
        unread: this.unread, more: this.timeline.more, last: this.timeline.last, membersOpen: this.membersOpen,
        hasComposerSlot: this.element.querySelector('.ch-composer-slot') !== null,
      }
    }
    scrollTo(top: number): void { this.msgs.scrollTop = top; this.onScroll() }
    olderNow(): Promise<void> { return this.loadOlder() }
  }

  class ChannelTab implements ITabRenderer {
    readonly element = el('div', 'ch-tab')
    private readonly title = el('span', 'ch-tab-title')
    init(p: GroupPanelPartInitParameters): void {
      const paneId = p.api.id
      const close = el('button', 'close')
      close.title = 'Fechar painel'; close.setAttribute('aria-label', 'Fechar painel')
      close.append(glyph('x'))
      close.addEventListener('pointerdown', ev => ev.stopPropagation())
      close.addEventListener('click', ev => { ev.stopPropagation(); ui.panes.close(paneId) })
      this.title.textContent = p.api.title ?? `#${channelIdOfPane(paneId)}`
      p.api.onDidTitleChange(() => { this.title.textContent = p.api.title ?? '' })
      this.element.append(glyph('chats-circle'), this.title, close)
      this.element.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); ui.panes.showTabMenu(paneId, ev.clientX, ev.clientY) })
    }
    dispose(): void {}
  }

  const open = (channelId: string, name?: string): void => {
    const id = channelPaneId(channelId)
    if (ui.panes.find(id)) { ui.panes.reveal(id); return }
    ui.panes.open({ id, component: CHANNEL_COMPONENT, tabComponent: CHANNEL_TAB, title: `#${name ?? channelId}`, params: { channelId } })
  }

  const disposables: Disposable[] = [
    ui.panes.register({
      ...type, hasSlot: false, icon: 'clipboard-text',
      create: () => new ChannelPane(),
      createTab: () => new ChannelTab() as unknown as ITabRenderer,
      has: id => id.startsWith(CHANNEL_PANE_PREFIX) && paneOf(channelIdOfPane(id)) !== undefined,
      // The minimum every tab has; the channel's own gestures (join, mute, close…) come with the commands (U2).
      tabMenu: (id, x, y) => ui.menus.context(x, y, [
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
  ui.test.expose('channels', {
    open,
    view: (channelId: string): PaneSnapshot | undefined => paneOf(channelId)?.snapshot(),
    kept: (channelId: string): boolean => kept.has(channelId),
    scrollTo: (channelId: string, top: number): void => paneOf(channelId)?.scrollTo(top),
    loadOlder: (channelId: string): Promise<void> => paneOf(channelId)?.olderNow() ?? Promise.resolve(),
    ask: async (name: string, args?: unknown): Promise<{ ok: boolean; result?: unknown; code?: string }> => {
      try { return { ok: true, result: await ui.daemon.request(name, args) } } catch (e) { return { ok: false, code: (e as { code?: string }).code ?? String(e) } }
    },
  })

  return { disposables, open, snapshot: channelId => paneOf(channelId)?.snapshot() }
}
