// The Regency in the app: declares its pane type, keeps its one pane on its system desk, and gathers the sources into the
// model's input (the desk tree of the core, the owner board of for-agents, the channel feed of channels, the agents). Events
// only mark the pane dirty; one animation frame repaints it, and only while the Regency is the visible desk.
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import type { IdentityInput } from '../../app/renderer/agent-identity.ts'
import type { ITabRenderer } from 'dockview-core'
import { channelEmbeds } from '../channels/renderer/embed.ts'
import { ownerBoard } from '../for-agents/renderer/owner-board.ts'
import type { Ownership } from '../for-agents/rules.ts'
import { CMD, DESK_ID, REGENCY_COMPONENT, REGENCY_LAYOUT, REGENCY_PANE_ID, REGENCY_TAB, REGENCY_TITLE, manifest } from './manifest.ts'
import {
  regencyModelOf, stateCounts, type AgentRef, type OwnerRef, type RegencyInput, type RegencyModel, type StateCounts, type Target,
  type TreeFilter,
} from './model.ts'
import { DEFAULT_LAYOUT, layoutParams, type RegencyLayout } from './renderer/layout-rules.ts'
import { RegencyPane, RegencyTab, type RegencyHost, type TreeQuery } from './renderer/pane.ts'

export { manifest }

/** Pane types with no slot that the quick view already shows (the peek card's system screens). */
const SCREEN_TYPES = new Set(['settings', 'keybindings'])

export function activate(ui: TetherUi): Disposable[] {
  const panes = new Set<RegencyPane>()
  /** When each target began to wait for the person (epoch ms), by `<kind>:<id>`; a key goes when its target stops waiting. */
  const since = new Map<string, number>()
  /** The seal lines of the last tree read, by pane id. */
  let lines = new Map<string, readonly string[]>()
  /** The channels' list has come at least once (the feed notifies after each directory read). */
  let heard = channelEmbeds.list().length > 0
  /** The layout of the last pane that went, given back to the pane that replaces it. */
  let lastLayout: RegencyLayout = { ...DEFAULT_LAYOUT }
  let frame = 0

  const visible = (): boolean => ui.systemDesks.isActive(DESK_ID)
  const nameOf = (slotId: string): string => ui.agents.get(slotId)?.name ?? slotId
  const ownerOf = (o: Ownership | undefined): OwnerRef | undefined =>
    o && !o.ended ? { id: o.owner, name: nameOf(o.owner) } : undefined

  const agentRefs = (): AgentRef[] => ui.agents.list().filter(a => a.placed !== false).map(a => {
    const emblem = ui.panes.personEmblem(a.paneId)
    return { id: a.paneId, kind: a.kind, name: a.name, ...(emblem ? { emblem: { name: emblem.name, color: emblem.color, icon: emblem.icon } } : {}) }
  })

  /** Keeps `since` in step with who waits now: a newcomer gets its time (the slot's own for an agent), a leaver is dropped. */
  const trackSince = (input: Omit<RegencyInput, 'since'>): void => {
    const agents = new Set(input.agents.map(a => a.id))
    const now = new Map<string, number | undefined>()
    for (const d of input.desks.desks) {
      if (d.id === DESK_ID) continue
      for (const p of d.panes) {
        if (p.attention !== 'waiting') continue
        const at = agents.has(p.id) ? Date.parse(ui.panes.slotFacts(p.id)?.attention?.since ?? '') : NaN
        now.set(`${agents.has(p.id) ? 'agent' : 'pane'}:${p.id}`, Number.isFinite(at) ? at : undefined)
      }
    }
    for (const c of input.channels) {
      const m = input.channelMarks[c.id]
      if (!c.closed && m && m.toMe + m.asks + m.owed > 0) now.set(`channel:${c.id}`, undefined)
    }
    for (const k of [...since.keys()]) if (!now.has(k)) since.delete(k)
    for (const [k, at] of now) if (!since.has(k)) since.set(k, at ?? Date.now())
  }

  const inputOf = (collapsed: readonly string[], narrow: Pick<RegencyInput, 'filter' | 'query'> = {}): RegencyInput => {
    const desks = ui.desks.tree()
    const owners: RegencyInput['owners'] = { desk: {}, pane: {} }
    const nextLines = new Map<string, readonly string[]>()
    for (const d of desks.desks) {
      if (ownerBoard.active) {
        const o = ownerOf(ownerBoard.deskOwner(d.id))
        if (o) owners.desk[d.id] = o
      }
      for (const p of d.panes) {
        if (p.lines?.length) nextLines.set(p.id, p.lines)
        if (!ownerBoard.active) continue
        const o = ownerOf(ownerBoard.paneOwner(p.id))
        if (o) owners.pane[p.id] = o
      }
    }
    lines = nextLines
    const channels = [...channelEmbeds.list()]
    const channelMarks: RegencyInput['channelMarks'] = {}
    for (const c of channels) channelMarks[c.id] = channelEmbeds.marksOf(c.id)
    const base = { desks, owners, channels, channelMarks, agents: agentRefs(), collapsed: [...collapsed], selfDeskId: DESK_ID }
    trackSince(base)
    return { ...base, since: Object.fromEntries(since), ...narrow }
  }

  const modelOf = (collapsed: readonly string[]): RegencyModel => regencyModelOf(inputOf(collapsed))
  /** One read of the sources gives both the narrowed model and the chips' counts (counted before the filter). */
  const viewOf = (q: TreeQuery): { model: RegencyModel; counts: StateCounts } => {
    const input = inputOf(q.collapsed, { filter: q.filter, query: q.query })
    return { model: regencyModelOf(input), counts: stateCounts(input) }
  }

  /** The queue desk each foreign pane was last seen in, and the queue desk the person used last. */
  const home = new Map<string, string>()
  let lastQueue: string | undefined
  /** Panes whose way back was refused: left where they are, never tried again. */
  const refused = new Set<string>()

  /** The Regency keeps `regency:main` alone: any other tab that shows up on its desk goes back to the queue. */
  const sweepStrangers = (): void => {
    const tree = ui.desks.tree()
    const queue = tree.desks.filter(d => d.kind === 'queue')
    const active = ui.desks.activeId()
    if (queue.some(d => d.id === active)) lastQueue = active
    const here = tree.desks.find(d => d.id === DESK_ID)
    let moved = false
    for (const p of here?.panes ?? []) {
      if (p.id === REGENCY_PANE_ID || refused.has(p.id)) continue
      const from = home.get(p.id)
      const to = (from && queue.some(d => d.id === from) ? from : undefined) ?? (lastQueue && queue.some(d => d.id === lastQueue) ? lastQueue : queue[0]?.id)
      if (!to || !ui.panes.moveToDesk(p.id, to)) refused.add(p.id)
      else moved = true
    }
    // The stranger had made its own tab the active one of the Regency's frame: the Regency's pane is shown again.
    if (moved) requestAnimationFrame(() => ui.panes.find(REGENCY_PANE_ID)?.api.setActive())
    home.clear()
    for (const d of queue) for (const p of d.panes) home.set(p.id, d.id)
    for (const id of [...refused]) if (!here?.panes.some(p => p.id === id)) refused.delete(id)
  }

  const flush = (): void => {
    frame = 0
    // Hidden, the Regency paints nothing; it only keeps the times of who began to wait.
    const shown = visible()
    for (const p of panes) p.setShown(shown)
    if (!shown) { if (panes.size > 0) inputOf([]); return }
    for (const p of panes) p.paint()
  }
  const schedule = (): void => {
    if (frame) return
    frame = requestAnimationFrame(flush)
  }

  /** The Regency's one pane is there whenever the desk is shown: closed or never made, it comes back (with its layout). */
  const ensurePane = (): void => {
    if (!visible() || ui.panes.find(REGENCY_PANE_ID)) return
    try {
      ui.systemDesks.addPane(DESK_ID, { id: REGENCY_PANE_ID, component: REGENCY_COMPONENT, tabComponent: REGENCY_TAB, title: REGENCY_TITLE, params: layoutParams(lastLayout) })
    } catch (e) { console.error('regência: painel', e) }
  }

  const livePane = (): RegencyPane | undefined => [...panes].find(p => p.id === REGENCY_PANE_ID) ?? [...panes][0]

  /** Goes to what a row names, as the person asked by a click: its desk comes forward and it gets the keyboard. */
  const go = (t: Target): void => {
    if (t.kind === 'agent') { if (!ui.agents.focus(t.id)) ui.panes.reveal(t.id) }
    else if (t.kind === 'pane') ui.panes.reveal(t.id)
    else if (t.kind === 'channel') livePane()?.select(t.id)
  }

  /**
   * The one place that opens the quick view of a target (the slice of the quick view replaces its inside): a live agent
   * in the peek card, a system screen in the card; any other kind, nothing yet.
   */
  const openQuickView = (t: Target): void => {
    if (t.kind === 'agent') { ui.panes.peek(t.id); return }
    if (t.kind !== 'pane') return
    const type = ui.panes.describe(t.id)?.type
    if (type && SCREEN_TYPES.has(type)) ui.panes.peekScreen(type)
  }

  /** The row menus asked so far (the E2E reads them; the menus slice opens the menu here). */
  const menuAsks: Array<{ target: Target; anchor: string }> = []
  /**
   * The one place that opens a row's menu, anchored on the row (the Menu key, Shift+F10, a right click). This slice only
   * takes the ask; the menus slice fills it.
   */
  const openRowMenu = (target: Target, anchor: HTMLElement): void => {
    menuAsks.push({ target, anchor: anchor.dataset.key ?? '' })
    if (menuAsks.length > 20) menuAsks.shift()
  }

  const host: RegencyHost = {
    view: viewOf,
    quickView: openQuickView,
    rowMenu: openRowMenu,
    loading: () => channelEmbeds.active && !heard,
    identity: (paneId): IdentityInput | undefined => {
      const a = ui.agents.get(paneId)
      if (!a || a.placed === false) return undefined
      return { kind: a.kind, name: a.name, seed: paneId, emblem: ui.panes.personEmblem(paneId) }
    },
    lines: id => lines.get(id),
    channel: id => channelEmbeds.list().find(c => c.id === id),
    openChannels: () => channelEmbeds.list().filter(c => !c.closed),
    mount: (el, channelId, opts) => channelEmbeds.mount(el, channelId, opts),
    go,
    pickChannel: () => ui.pick.list<string>({
      title: 'Escolher conversa',
      placeholder: 'Nome do canal',
      items: channelEmbeds.list().filter(c => !c.closed).map(c => ({ value: c.id, label: `#${c.name}`, ...(c.title && c.title !== c.name ? { detail: c.title } : {}) })),
      emptyText: 'Nenhuma conversa aberta',
    }),
    // The pane that replaces a closed one starts from the last layout saved (the new pane may come before the old one's dispose).
    saved: () => { const p = livePane(); if (p) lastLayout = p.state; ui.layout.scheduleSave() },
    visible,
    gone: pane => { panes.delete(pane); lastLayout = pane.state },
    immersionKey: () => { try { return ui.keybindings.table().hint(CMD.immersion) } catch { return '' } },
  }

  ui.test.expose('model', (): RegencyModel => modelOf(livePane()?.state.collapsed ?? []))
  ui.test.expose('layout', (): RegencyLayout | undefined => livePane()?.state)
  ui.test.expose('select', (channelId: string): void => { livePane()?.select(channelId) })
  ui.test.expose('close', (): void => { ui.panes.close(REGENCY_PANE_ID) })
  ui.test.expose('quickView', openQuickView)
  ui.test.expose('mode', (): string | undefined => livePane()?.state.mode)
  ui.test.expose('tier', (): string | undefined => livePane()?.tier)
  /** The model and counts the screen shows now (the pane's folds, filter and search). */
  ui.test.expose('shown', () => { const p = livePane(); return p ? viewOf({ collapsed: p.state.collapsed, filter: p.state.filter, query: p.searchText }) : undefined })
  ui.test.expose('view', (v: 'desk' | 'agent'): void => { livePane()?.setView(v) })
  ui.test.expose('filter', (f: TreeFilter): void => { livePane()?.setFilter(f) })
  ui.test.expose('search', (q: string): void => { livePane()?.setQuery(q) })
  ui.test.expose('paints', (): number => livePane()?.paints ?? 0)
  ui.test.expose('menuAsks', () => menuAsks.map(m => ({ ...m })))

  schedule()
  return [
    // The person's key or the palette: only the Regency in sight changes (hidden, it would change out of her view).
    ui.commands.registerCommand(CMD.immersion, () => { if (visible()) livePane()?.toggleMode() }),
    ui.panes.register({
      ...REGENCY_LAYOUT, hasSlot: false, icon: 'columns',
      create: () => { const p = new RegencyPane(host); panes.add(p); schedule(); return p },
      createTab: () => new RegencyTab() as unknown as ITabRenderer,
      has: id => [...panes].some(p => p.id === id),
      focus: () => livePane()?.focus(),
      tabMenu: (_id, x, y) => ui.menus.context(x, y, [{ icon: 'push-pin', label: 'A Regência é uma guia fixa', disabled: true, run: () => {} }]),
    }),
    ui.desks.onDidChangeTree(() => { sweepStrangers(); ensurePane(); schedule() }),
    ui.systemDesks.onDidChangeActive(e => {
      if (e.id !== DESK_ID) return
      for (const p of panes) p.setShown(e.active)
      if (e.active) { ensurePane(); schedule() }
    }),
    ui.agents.onDidChange(schedule),
    ui.panes.onDidChangeMarks(schedule),
    ownerBoard.onDidChange(schedule),
    channelEmbeds.onDidChange(() => { heard = true; schedule() }),
    { dispose: () => { if (frame) cancelAnimationFrame(frame); frame = 0 } },
  ]
}
