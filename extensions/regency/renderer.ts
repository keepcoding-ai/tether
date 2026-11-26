// The Regency in the app: declares its pane type, keeps its one pane on its system desk, and gathers the sources into the
// model's input (the desk tree of the core, the owner board of for-agents, the channel feed of channels, the agents). Events
// only mark the pane dirty; one animation frame repaints it, and only while the Regency is the visible desk.
import type { ContextMenuItem, ContextMenuRow, Disposable, TetherUi, TreePane, WakeAnswer } from '../../app/renderer/ext-api.ts'
import type { IdentityInput } from '../../app/renderer/agent-identity.ts'
import { GO_DESK_LABEL, WAKE_DESK_LABEL } from '../../app/renderer/manager-menu-rules.ts'
import type { ITabRenderer } from 'dockview-core'
import type { HueName } from '../../app/shared/palette.ts'
import { WEB_PANE_PREFIX } from '../browser/manifest.ts'
import { browserEmbeds } from '../browser/renderer/embed.ts'
import { channelEmbeds } from '../channels/renderer/embed.ts'
import { ownerBoard } from '../for-agents/renderer/owner-board.ts'
import { processEmbeds } from '../processes/embed.ts'
import { STATUS_ID as SYNC_STATUS } from '../sync/manifest.ts'
import { STATUS_ID as BRIDGE_STATUS } from '../web-bridge/manifest.ts'
import { systemModelOf, type SystemInput, type SystemModel } from './system-rules.ts'
import type { SystemViewHost } from './renderer/system-view.ts'
import { createdText, planOf, runPlan, type CreateDraft, type CreateFixed, type CreateState } from './create-rules.ts'
import { RegencyToast, type ToastAction } from './renderer/toast.ts'
import { createRunner, type CreateSeams } from './renderer/create-run.ts'
import { CreateCard, type CreateRunEnd, type CreateViewHost } from './renderer/create-view.ts'
import type { Ownership } from '../for-agents/rules.ts'
import { CMD, DESK_ID, REGENCY_COMPONENT, REGENCY_LAYOUT, REGENCY_PANE_ID, REGENCY_TAB, REGENCY_TITLE, manifest } from './manifest.ts'
import {
  CLOSED_ID, regencyModelOf, stateCounts, type AgentRef, type ClosedInput, type OwnerRef, type RegencyInput, type RegencyModel, type StateCounts, type Target,
  type TreeFilter,
} from './model.ts'
import { DEFAULT_LAYOUT, layoutParams, type RegencyLayout } from './renderer/layout-rules.ts'
import { RegencyPane, RegencyTab, type RegencyHost, type TreeQuery } from './renderer/pane.ts'
import { targetOf } from './renderer/columns.ts'

export { manifest }

/** Pane types with no slot that the quick view already shows (the peek card's system screens). */
const SCREEN_TYPES = new Set(['settings', 'keybindings', 'extensions'])
/** The pill menu's own row that puts a desk to sleep (main.ts, deskMenuEntries): the moon button runs it. */
const HIBERNATE_DESK_LABEL = 'Hibernar mesa'
/** The menu of an ended session's row, and the picker's value for the desk that does not exist yet. */
const REOPEN_LABEL = 'Reabrir em…'
const FORGET_LABEL = 'Esquecer…'
const NEW_DESK = '\u0000new-desk'
/** The rows "+ Novo" puts in a desk's menu and in an agent's menu. */
const NEW_IN_DESK_LABEL = 'Nova guia nesta mesa'
const GIVE_NEW_DESK_LABEL = 'Dar uma mesa nova…'

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

  /** The ended sessions of the core's list, read again only when it says it changed (the core scans the slots to make it). */
  let closedCache: ClosedInput[] | undefined
  const closedList = (): ClosedInput[] => closedCache ??= ui.sessions.closed().map(c => ({
    slotId: c.slotId, kind: c.kind, name: c.name,
    ...(c.title !== undefined ? { title: c.title } : {}),
    ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
  }))

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
    const base = { desks, owners, channels, channelMarks, agents: agentRefs(), closed: closedList(), collapsed: [...collapsed], selfDeskId: DESK_ID }
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
   * The one place that opens the quick view of a target: an agent's or any pane's tab, alive in the card docked over the
   * conversation (not modal: the conversation, its box and the tree stay usable; another target takes the card's place).
   * A system screen keeps its own card; an agent with no tab, the agent's own card (the core decides: `peekPane`).
   * `focus`: the keyboard goes into the card ("Falar com"); else it stays on the row (Space, a click in "Esperam você").
   */
  const openQuickView = (t: Target, focus = false): void => {
    if (t.kind !== 'agent' && t.kind !== 'pane') return
    const type = t.kind === 'pane' ? ui.panes.describe(t.id)?.type : undefined
    if (type && SCREEN_TYPES.has(type)) { ui.panes.peekScreen(type); return }
    const over = livePane()?.quickAnchor()
    quickId = t.id
    ui.panes.peekPane(t.id, { ...(over ? { over } : {}), focus })
    livePane()?.markQuick()
  }

  /** The pane or agent whose quick view the tree opened last (cleared when the card closes); the row of it is marked. */
  let quickId: string | undefined
  const peekOpen = (): boolean => document.querySelector('#peek[data-open="true"]') !== null

  /** A click on a row: its quick view opens; the row already in the card closes it. */
  const toggleQuick = (t: Target): void => {
    if (quickId === t.id && peekOpen()) { void ui.commands.run('peek.close'); return }
    openQuickView(t)
  }

  /** The card closed (by any way): the mark goes. Checked a frame later, so a swap of the card's content does not clear it. */
  const peekWatch = new MutationObserver(() => {
    requestAnimationFrame(() => { if (quickId !== undefined && !peekOpen()) { quickId = undefined; livePane()?.markQuick() } })
  })
  peekWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-open'] })

  /** A gesture the core or the tetherd did not take: said in a dialog, never silently. */
  const refuse = (title: string, message: string): void => {
    void ui.dialogs.ask({
      situation: 'regency.refused', tone: 'warn', icon: 'shield-warning', title, message,
      choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada foi alterado.', tone: 'safe' }],
    })
  }

  /**
   * How a wake (a pane's or a desk's) ended. A refusal is said here: the choice of an `unconfirmed` pane (resume or start
   * again) is asked inside the pane itself, which may be on another desk, so the notice offers the way to it.
   */
  const woke = (a: WakeAnswer): void => {
    if (a.ok) return
    const name = nameOf(a.paneId)
    const unconfirmed = a.why === 'unconfirmed'
    void ui.dialogs.ask({
      situation: 'regency.wake-refused', tone: 'warn', icon: 'shield-warning',
      title: unconfirmed ? `${name} não despertou` : `${name} não pôde despertar`,
      message: unconfirmed ? 'Esta guia precisa da sua escolha (retomar ou começar de novo) na própria guia.' : a.message,
      choices: [
        { id: 'go', icon: 'arrow-right', label: 'Ir até a guia', consequence: 'Leva você à guia.', tone: 'safe' },
        { id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada foi alterado.', tone: 'safe' },
      ],
    }).then(r => { if (r.choice === 'go') ui.panes.reveal(a.paneId) })
  }

  /** A pane of the tree as the core sees it now (its flags), wherever it lives. */
  const treePane = (id: string): TreePane | undefined => {
    for (const d of ui.desks.tree().desks) { const p = d.panes.find(x => x.id === id); if (p) return p }
    return undefined
  }

  /**
   * "Falar com": the agent's quick view, the keyboard in its terminal (the card docked over the conversation holds the tab's
   * terminal; the Regency stays). Asleep or ended there is nobody to talk to: it says why instead.
   */
  const talk = (t: Target): void => {
    if (t.kind !== 'agent') return
    const p = treePane(t.id)
    const name = nameOf(t.id)
    if (p?.asleep) { refuse(`${name} está hibernando`, 'Desperte a guia (menu da linha, "Despertar guia") para falar com o agente.'); return }
    if (p?.exited) { refuse(`${name} está encerrado`, 'A sessão terminou: reinicie o agente para falar com ele.'); return }
    openQuickView(t, true)
  }

  /** The desk's moon or sun: the core's own row of the desk's menu, so the question and the rules are the pill's. */
  const sleepDesk = (deskId: string, wake: boolean): void => {
    const label = wake ? WAKE_DESK_LABEL : HIBERNATE_DESK_LABEL
    const row = ui.desks.menuEntries(deskId, { from: 'manager', onWake: woke }).find((e): e is ContextMenuItem => e !== 'sep' && e.label === label)
    if (row && !row.disabled) { row.run(); return }
    const name = ui.desks.list().find(d => d.id === deskId)?.name ?? 'A mesa'
    if (wake) refuse(`${name} não está hibernando`, 'A mesa já está desperta.')
    else refuse(`${name} não pode hibernar agora`, 'A última mesa desperta fica desperta, e uma mesa que já hibernou não hiberna de novo.')
  }

  const closedName = (slotId: string): string => closedList().find(c => c.slotId === slotId)?.name ?? slotId

  /**
   * "Reabrir em…": the awake desks of the queue, then "Nova mesa". The session is born there and starts; the person stays on
   * the Regency, whose tree shows the new row with a brief highlight. `where` is a desk id or NEW_DESK.
   */
  const reopenOn = (slotId: string, where: string): boolean => {
    const deskId = where === NEW_DESK ? ui.sessions.reopenInNewDesk(slotId) : (ui.sessions.reopen(slotId, where) ? where : undefined)
    if (!deskId) {
      refuse('A sessão não foi reaberta', 'Ela já não está encerrada (ou já tem guia), ou a mesa escolhida não existe mais. Nada foi alterado.')
      return false
    }
    livePane()?.announce(slotId, deskId)
    return true
  }

  const reopenIn = async (slotId: string): Promise<void> => {
    const desks = ui.desks.list().filter(d => !d.asleep)
    const where = await ui.pick.list<string>({
      title: `Reabrir ${closedName(slotId)} em…`,
      placeholder: 'Nome da mesa',
      items: [
        ...desks.map(d => ({ value: d.id, label: d.name, icon: 'cards', detail: `${d.panes.length} guia${d.panes.length === 1 ? '' : 's'}` })),
        { value: NEW_DESK, label: 'Nova mesa', icon: 'plus', detail: 'Cria uma mesa depois da última' },
      ],
      emptyText: 'Nenhuma mesa desperta',
    })
    if (where) reopenOn(slotId, where)
  }

  /** "Esquecer…": asks (it cannot be undone), then the core's forget; a refusal is said, never silent. */
  const forgetClosed = async (slotId: string): Promise<void> => {
    const name = closedName(slotId)
    const r = await ui.dialogs.ask({
      situation: 'regency.forget-session', tone: 'danger', icon: 'trash',
      title: `Esquecer a sessão de ${name}?`,
      message: 'O tether deixa de guardar esta sessão encerrada. Isso não pode ser desfeito.',
      choices: [{ id: 'forget', icon: 'trash', label: 'Esquecer', consequence: 'A sessão sai de "Fechadas" e não volta.', tone: 'destructive' }],
      cancelLabel: 'Cancelar',
    })
    if (r.choice !== 'forget') return
    const why = await ui.sessions.forget(slotId)
    if (why) refuse('A sessão não foi esquecida', why)
  }

  /** The row menus asked so far (the E2E reads them). */
  const menuAsks: Array<{ target: Target; anchor: string }> = []

  /** Rename in the row, by the pane's field (the core's own input lives on a pill or a tab that may be out of sight). */
  const renameIn = (key: string, what: 'desk' | 'pane', commit: (name: string) => boolean | Promise<boolean>) =>
    (): void => { livePane()?.startRename(key, commit, what) }

  /**
   * The one place that opens a row's menu (the Menu key, Shift+F10, a right click, the row's "⋯"): the core's own menus
   * aimed at the row's target, as a manager's (nothing comes forward; "Ir até…" last is the only way out).
   *   desk of the queue: the pill's menu; Browser and the drawer: "Ir até a mesa" alone;
   *   pane: the tab's menu; an agent's pane: the same plus "Falar com" and "O que <nome> tem".
   * The row has the keyboard: the menu gives it back when it closes.
   */
  const openRowMenu = (target: Target, anchor: HTMLElement, at?: { x: number; y: number }): void => {
    const key = anchor.dataset.key ?? ''
    menuAsks.push({ target, anchor: key })
    if (menuAsks.length > 20) menuAsks.shift()
    const box = anchor.getBoundingClientRect()
    const { x, y } = at ?? { x: Math.round(box.left + 24), y: Math.round(box.bottom) }
    if (target.kind === 'session') {
      if (target.id === CLOSED_ID) return
      const id = target.id
      ui.menus.context(x, y, [
        { icon: 'arrow-clockwise', label: REOPEN_LABEL, run: () => { void reopenIn(id) } },
        'sep',
        { icon: 'trash', label: FORGET_LABEL, danger: true, run: () => { void forgetClosed(id) } },
      ])
      return
    }
    if (target.kind === 'desk') {
      const desk = ui.desks.tree().desks.find(d => d.id === target.id)
      if (!desk) return
      if (desk.kind !== 'queue') {
        ui.menus.context(x, y, [{ icon: 'arrow-right', label: GO_DESK_LABEL, run: () => { ui.desks.reveal(desk.id) } }])
        return
      }
      // "Nova guia nesta mesa": the "+ Novo" card with this desk fixed (an awake desk only takes one).
      const add: ContextMenuRow[] = desk.asleep ? [] : [{ icon: 'plus', label: NEW_IN_DESK_LABEL, run: () => { livePane()?.openCreate({ deskId: desk.id }, key) } }]
      ui.desks.showMenu(desk.id, x, y, undefined, {
        from: 'manager', goLast: true, onWake: woke, rename: renameIn(key, 'desk', name => ui.desks.rename(desk.id, name)), extra: add,
      })
      return
    }
    if (target.kind !== 'pane' && target.kind !== 'agent') return
    if (target.kind === 'agent' && !ui.panes.find(target.id)) return
    const id = target.id
    const extra: ContextMenuRow[] = []
    if (target.kind === 'agent') {
      const name = nameOf(id)
      const p = treePane(id)
      // Asleep or ended there is no terminal to talk to: the row says so, off.
      const off = p?.asleep ? 'hibernando' : p?.exited ? 'encerrado' : undefined
      extra.push(
        off
          ? { icon: 'chats-circle', label: `Falar com ${name} (${off})`, disabled: true, run: () => {} }
          : { icon: 'chats-circle', label: `Falar com ${name}`, run: () => talk(target) },
        { icon: 'tray', label: `O que ${name} tem`, run: () => { livePane()?.showAgent(id) } },
      )
      // "Dar uma mesa nova…": the card of one step (name and colour); giving needs for-agents.
      if (ownerBoard.active) extra.push({ icon: 'cards', label: GIVE_NEW_DESK_LABEL, run: () => { livePane()?.openCreate({ forAgent: id, forName: name }, key) } })
    }
    // In blocks: the agent's, the tab's, who commands it; Space (the row's key) is the quick view's, so "Espiar" shows it.
    const groups = { ...(target.kind === 'agent' ? { agent: nameOf(id) } : {}), owner: commanderOf(id), peek: () => openQuickView(target), peekHint: 'Espaço' }
    ui.panes.showTabMenu(id, x, y, undefined, { from: 'manager', goLast: true, groups, onWake: woke, rename: renameIn(key, 'pane', name => ui.panes.rename(id, name)), extra })
  }

  /** Who commands a pane, for the title "Quem manda aqui: …": its own owner, else its desk's, else the person. */
  const commanderOf = (paneId: string): string => {
    if (!ownerBoard.active) return 'você'
    const own = ownerOf(ownerBoard.paneOwner(paneId))
    if (own) return own.name
    const desk = ui.desks.tree().desks.find(d => d.panes.some(p => p.id === paneId))
    const o = desk ? ownerOf(ownerBoard.deskOwner(desk.id)) : undefined
    return o && o.id !== paneId ? o.name : 'você'
  }

  // ---------------------------------------------------------------- "+ Novo"

  /** How long a give waits for the owner board to show the new owner (the command writes to the tetherd and returns). */
  const GIVE_WAIT_MS = 5_000
  const given = (kind: 'pane' | 'desk', id: string, to: string): boolean => {
    const o = kind === 'desk' ? ownerBoard.deskOwner(id) : ownerBoard.paneOwner(id)
    return !!o && !o.ended && o.owner === to
  }
  const waitGiven = (kind: 'pane' | 'desk', id: string, to: string): Promise<boolean> => new Promise(resolve => {
    if (given(kind, id, to)) { resolve(true); return }
    const sub = ownerBoard.onDidChange(() => { if (given(kind, id, to)) { clearTimeout(timer); sub.dispose(); resolve(true) } })
    const timer = setTimeout(() => { sub.dispose(); resolve(given(kind, id, to)) }, GIVE_WAIT_MS)
  })

  /** The seams the plan's acts run on: nothing here switches desk or takes the keyboard. */
  const seams: CreateSeams = {
    slot: spec => ui.create.slot(spec),
    item: spec => ui.create.item(spec),
    desk: spec => ui.desks.create({ name: spec.name, ...(spec.color ? { color: spec.color as HueName } : {}), ...(spec.after ? { after: spec.after } : {}), stay: true }),
    tab: opts => browserEmbeds.newTab(opts),
    tabFor: (agent, opts) => browserEmbeds.newTabFor(agent, opts),
    tabPane: tabId => `${WEB_PANE_PREFIX}${tabId}`,
    channel: name => channelEmbeds.create(name),
    join: (channelId, agent) => channelEmbeds.join(channelId, agent),
    show: channelId => {
      const p = livePane()
      p?.select(channelId)
      if (p?.tier === 'mobile') p.setTab('conversation')
    },
    give: async (kind, id, to) => {
      if (!ownerBoard.active) return 'a posse dos agentes está desligada'
      const r = await ui.commands.run('for-agents.give', { kind, id, to })
      if (r !== 'ran') return 'a posse dos agentes está desligada'
      return (await waitGiven(kind, id, to)) ? undefined : 'o tether não confirmou a posse'
    },
    move: (pane, deskId) => ui.panes.moveToDesk(pane, deskId),
    nameOf,
  }

  const createCtx = () => ({ desks: ui.desks.tree(), channels: [...channelEmbeds.list()] })

  /** Runs a ready draft: the plan in order; then the new row glows and takes the keyboard (a new channel: the centre). */
  const runCreate = async (state: CreateState): Promise<CreateRunEnd> => {
    const acts = planOf(state, createCtx())
    if (acts.length === 0) return { ok: false, text: 'Nada a criar: falta escolher algo no cartão.', after: () => {} }
    const runner = createRunner(acts, seams)
    const run = await runPlan(acts, runner.exec)
    lastRun = { acts: acts.map(a => a.act), ok: run.ok, done: run.done, ...(run.text !== undefined ? { text: run.text } : {}), made: { ...runner.made } }
    const after = (): void => {
      const pane = livePane()
      if (!pane) return
      if (state.draft.what === 'channel') return
      const made = run.announce
      // "Ir até a guia depois de criar": the person asked to go there, so her desk changes and the tab takes the keyboard.
      if (made && state.draft.goAfter === true) { ui.panes.reveal(made.paneId); return }
      if (made) pane.announce(made.paneId, made.deskId, { focus: true })
      else if (runner.made.deskId) pane.announceDesk(runner.made.deskId, { focus: true })
      const deskId = made?.deskId ?? runner.made.deskId
      const text = createdText(state.draft.what, deskId ? ui.desks.list().find(d => d.id === deskId)?.name : undefined)
      if (!text) return
      const target: Target | undefined = made ? (ui.agents.get(made.paneId) ? { kind: 'agent', id: made.paneId } : { kind: 'pane', id: made.paneId }) : undefined
      showToast(text, target ? { label: 'Espiar', tip: 'Ver a guia nova sem sair da Regência (Espaço na linha)', run: () => openQuickView(target) } : undefined)
    }
    return { ok: run.ok, ...(run.text !== undefined ? { text: run.text } : {}), after }
  }
  let lastRun: { acts: string[]; ok: boolean; done: number; text?: string; made: object } | undefined

  /** The brief notice of the Regency (one at a time), mounted on the live pane when it is said. */
  const toast = new RegencyToast()
  const showToast = (text: string, action?: ToastAction): void => {
    const pane = livePane()
    if (!pane) return
    if (toast.element.parentElement !== pane.element) pane.element.append(toast.element)
    toast.show(text, action)
  }

  const cardHost: CreateViewHost = {
    items: () => ui.create.items(),
    desks: () => ui.desks.tree(),
    owners: () => {
      const owners: RegencyInput['owners'] = { desk: {}, pane: {} }
      if (!ownerBoard.active) return owners
      for (const d of ui.desks.tree().desks) { const o = ownerOf(ownerBoard.deskOwner(d.id)); if (o) owners.desk[d.id] = o }
      return owners
    },
    channels: () => channelEmbeds.list(),
    agents: () => ui.agents.list().filter(a => a.placed !== false && a.alive).map(a => ({ id: a.paneId, kind: a.kind, name: a.name })),
    projects: () => ui.workspace.folders().filter(f => !f.missing).map(f => ({ path: f.path, name: f.name, pinned: f.pinned })),
    recentFolders: () => ui.folders.recent(),
    pickFolder: initial => ui.folders.pickFolder(initial),
    defaultFolder: () => ui.workspace.current() ?? ui.workspace.folders().find(f => !f.missing)?.path,
    pickList: spec => ui.pick.list(spec),
    pickMany: spec => ui.pick.many(spec),
    tier: () => livePane()?.tier ?? 'desktop',
    run: runCreate,
  }
  const card = new CreateCard(cardHost)

  /** Opens the card; an open quick view closes first (one card over the conversation at a time). */
  const openCreate = (fixed: CreateFixed, restore: () => void, what?: 'agent' | 'terminal' | 'channel'): void => {
    if (peekOpen()) { void ui.commands.run('peek.close').then(() => card.open(fixed, restore, what)); return }
    card.open(fixed, restore, what)
  }

  // ---------------------------------------------------------------- "Sistema"

  /** The sources of "Sistema" as the pure model's input: no value of an env variable is read (profiles give names only). */
  const systemInput = (): SystemInput => {
    const status = (id: string): { state?: string; badge?: string } | undefined => {
      const s = ui.status.items().find(x => x.id === id)
      return s ? { state: s.title, ...(s.badge !== undefined ? { badge: String(s.badge) } : {}) } : undefined
    }
    const bridge = status(BRIDGE_STATUS)
    const sync = status(SYNC_STATUS)
    return {
      now: Date.now(),
      procs: processEmbeds.list(),
      agents: ui.agents.list().filter(a => a.placed !== false).map(a => ({
        id: a.paneId, name: a.name, kind: a.kind, alive: a.alive,
        ...(a.profile ? { profileId: a.profile.id } : {}), ...(a.ronda ? { ronda: a.ronda } : {}),
      })),
      profiles: ui.profiles.list().map(p => ({
        id: p.id, name: p.name, agent: p.agent, env: Object.fromEntries(p.envNames.map(n => [n, ''])), ...(p.default ? { default: true } : {}),
      })),
      folders: ui.workspace.folders(),
      status: { ...(bridge ? { bridge } : {}), ...(sync ? { sync } : {}) },
    }
  }
  const systemModel = (): SystemModel => systemModelOf(systemInput())

  /** "Abrir o registro numa mesa…": the awake desks; the record is born there and the person stays. */
  const logOnDesk = async (name: string) => {
    const desks = ui.desks.list().filter(d => !d.asleep)
    const deskId = await ui.pick.list<string>({
      title: `Abrir o registro de ${name} numa mesa`,
      placeholder: 'Nome da mesa',
      items: desks.map(d => ({ value: d.id, label: d.name, icon: 'cards', detail: `${d.panes.length} guia${d.panes.length === 1 ? '' : 's'}` })),
      emptyText: 'Nenhuma mesa desperta',
    })
    return deskId ? processEmbeds.output(name, { deskId }) : undefined
  }

  const system: SystemViewHost = {
    model: systemModel,
    procsActive: () => processEmbeds.active,
    identity: paneId => {
      const a = ui.agents.get(paneId)
      return a && a.placed !== false ? { kind: a.kind, name: a.name, seed: paneId, emblem: ui.panes.personEmblem(paneId) } : undefined
    },
    proc: (act, name, opts) => {
      switch (act) {
        case 'start': return processEmbeds.start(name)
        case 'stop': return processEmbeds.stop(name, opts)
        case 'restart': return processEmbeds.restart(name, opts)
        case 'hold': return processEmbeds.hold(name)
        case 'release': return processEmbeds.release(name)
      }
    },
    // Docked over the conversation, as every quick view the Regency opens (the record is a pane like the others).
    peekLog: name => { const over = livePane()?.quickAnchor(); return processEmbeds.peekOutput(name, over ? { over } : undefined) },
    logOnDesk,
    seen: name => { void ui.procs.seen(name).catch(() => {}) },
    setRonda: (id, change) => ui.agents.setRonda(id, change),
    offRonda: (id, force) => ui.agents.offRonda(id, force ? { force: true } : undefined),
    editProfile: (id, duplicate) => ui.profiles.edit(id, duplicate ? { duplicate: true } : undefined),
    createHere: (what, cwd, restore) => openCreate({ cwd }, restore, what),
    togglePin: path => ui.workspace.togglePin(path),
    openScreen: type => { ui.panes.peekScreen(type) },
    showStatus: id => ui.status.show(id === 'bridge' ? BRIDGE_STATUS : SYNC_STATUS),
    menu: (x, y, entries) => ui.menus.context(x, y, entries),
    tick: () => schedule(),
  }

  const host: RegencyHost = {
    create: openCreate,
    system,
    view: viewOf,
    quickView: openQuickView,
    toggleQuick,
    quicked: () => (peekOpen() ? quickId : undefined),
    closeQuick: () => { if (quickId !== undefined && peekOpen()) void ui.commands.run('peek.close') },
    rowMenu: openRowMenu,
    talk,
    sleepDesk,
    renameRefused: what => refuse(
      what === 'desk' ? 'A mesa não foi renomeada' : 'A guia não foi renomeada',
      what === 'desk' ? 'O nome ficou como estava.' : 'O tether recusou o nome (ou esta guia se renomeia pelo próprio arquivo). O nome ficou como estava.',
    ),
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
      title: 'Escolher canal',
      placeholder: 'Nome do canal',
      items: channelEmbeds.list().filter(c => !c.closed).map(c => ({ value: c.id, label: `#${c.name}`, ...(c.title && c.title !== c.name ? { detail: c.title } : {}) })),
      emptyText: 'Nenhum canal aberto',
    }),
    // The pane that replaces a closed one starts from the last layout saved (the new pane may come before the old one's dispose).
    saved: () => { const p = livePane(); if (p) lastLayout = p.state; ui.layout.scheduleSave() },
    visible,
    gone: pane => { panes.delete(pane); lastLayout = pane.state },
    immersionKey: () => { try { return ui.keybindings.table().hint(CMD.immersion) } catch { return '' } },
  }

  ui.test.expose('model', (): RegencyModel => modelOf(livePane()?.modelFolds ?? []))
  ui.test.expose('layout', (): RegencyLayout | undefined => livePane()?.state)
  ui.test.expose('select', (channelId: string): void => { livePane()?.select(channelId) })
  ui.test.expose('close', (): void => { ui.panes.close(REGENCY_PANE_ID) })
  ui.test.expose('quickView', openQuickView)
  ui.test.expose('mode', (): string | undefined => livePane()?.state.mode)
  ui.test.expose('tier', (): string | undefined => livePane()?.tier)
  /** The model and counts the screen shows now (the pane's folds, filter and search). */
  ui.test.expose('shown', () => { const p = livePane(); return p ? viewOf({ collapsed: p.modelFolds, filter: p.state.filter, query: p.searchText }) : undefined })
  ui.test.expose('view', (v: 'desk' | 'agent'): void => { livePane()?.setView(v) })
  ui.test.expose('filter', (f: TreeFilter): void => { livePane()?.setFilter(f) })
  ui.test.expose('search', (q: string): void => { livePane()?.setQuery(q) })
  ui.test.expose('paints', (): number => livePane()?.paints ?? 0)
  ui.test.expose('menuAsks', () => menuAsks.map(m => ({ ...m })))
  /** Opens a tree row's menu by its row key, as Shift+F10 on it would (false: no such row on screen). */
  ui.test.expose('menu', (key: string): boolean => {
    const row = [...document.querySelectorAll<HTMLElement>('.rg-tree [data-key]')].find(r => r.dataset.key === key)
    const target = row ? targetOf(row.dataset.target) : undefined
    if (!row || !target) return false
    const pane = livePane()
    if (!pane) return false
    row.focus({ preventScroll: true })
    pane.openMenu(target, row)
    return true
  })
  ui.test.expose('renaming', (): string | undefined => livePane()?.renamingKey)
  /** The "+ Novo" card as it is now (open, step, draft, error, the sentence told). */
  ui.test.expose('createView', () => card.snapshot())
  /** Runs a draft's plan without the card (as the card's "Criar" does), then lights what was made. */
  ui.test.expose('create', async (draft: CreateDraft, fixed: CreateFixed = {}) => {
    const end = await runCreate({ draft, fixed, step: 'details' })
    end.after()
    return { ok: end.ok, ...(end.text !== undefined ? { text: end.text } : {}) }
  })
  /** The last plan run: its acts, how it ended and what it made. */
  ui.test.expose('lastRun', () => lastRun)
  /** The brief notice shown now (its text and buttons), undefined when none. */
  ui.test.expose('toast', () => toast.shown)
  /** "Sistema" as drawn: the column, the section, the red dots and the rows. */
  ui.test.expose('system', () => livePane()?.systemSnapshot())
  /** The four tiers as drawn: the tier, the tablet's step, side and panel, the TV's quick column. */
  ui.test.expose('tiers', () => livePane()?.tierSnapshot())
  /** The pure model of "Sistema" now (what the screen paints). */
  ui.test.expose('systemModel', () => systemModel())
  /** Opens "Sistema" on a section (or the kept one), as the foot's button does; `false` goes back to the tree. */
  ui.test.expose('openSystem', (section?: string | false): void => {
    const p = livePane()
    if (!p) return
    if (section === false) p.closeSystem()
    else p.openSystemColumn(section ? section as SystemModel['sections'][number]['id'] : undefined)
  })

  schedule()
  return [
    // The person's key or the palette: only the Regency in sight changes (hidden, it would change out of her view).
    ui.commands.registerCommand(CMD.immersion, () => { if (visible()) livePane()?.toggleMode() }),
    // "Regência: Novo…" from the palette: the person asked for the Regency's card, so it comes to view first.
    ui.commands.registerCommand(CMD.create, () => {
      const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined
      if (!visible()) ui.desks.reveal(DESK_ID)
      requestAnimationFrame(() => {
        const pane = livePane()
        if (pane && opener && pane.element.contains(opener)) pane.openCreate({})
        else openCreate({}, () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); else livePane()?.focus() })
      })
    }),
    { dispose: () => card.close(false) },
    { dispose: () => toast.dispose() },
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
    ui.sessions.onDidChange(() => { closedCache = undefined; schedule() }),
    ui.agents.onDidChange(schedule),
    ui.panes.onDidChangeMarks(schedule),
    ownerBoard.onDidChange(schedule),
    channelEmbeds.onDidChange(() => { heard = true; schedule() }),
    // "Sistema" and its red dot follow the processes, the profiles, the projects and the top bar's icons.
    processEmbeds.onDidChange(schedule),
    ui.profiles.onDidChange(schedule),
    ui.workspace.onDidChange(schedule),
    ui.status.onDidChange(schedule),
    { dispose: () => { peekWatch.disconnect() } },
    { dispose: () => { if (frame) cancelAnimationFrame(frame); frame = 0 } },
  ]
}
