// The browser extension's renderer side (E2): the pad "Guias" (still its empty state, design §5.3) and the `web` pane, the
// frame of one tab: a thin bar with the tab's real title and address (from main, never from the page), its state, and the
// area its surface is tied to (`ui.surfaces.attach`). A new tab enters the Browser desk as a tab behind the others, never
// the active one (§5.2), next to its owner's other tabs. After a restart the panes come back from layout.json without loading
// ("Não carregada desde que o tether reabriu") and load when the person shows them (§7.3); a tab whose address carried a
// credential was saved without it and is not reloaded.
// E4: the local-network question (design §4.1): main asks, this side shows the core's dialog (modal: it freezes the surfaces
// while open), one question at a time, and answers. Open questions are fetched at start, so a reload does not lose them; a
// question whose tab closed is dropped from the queue, or, when on screen, dismissed as a refusal.
// E7: who has the tab (design §6, §12a). The bar shows the control ("‹Agente› usando", "Com você", "Pausada") and its action
// ("Assumir o controle", "Devolver ao ‹agente›", "Retomar"); a strip under it answers a click on the shield ("O ‹agente› está
// usando esta página. Assumir o controle?"), carries a help request ("‹Agente› pede sua ajuda: ‹mensagem›" with "Pronto,
// devolver ao ‹agente›"), its timeout, and, after a manual take, the scripts warning with "Recarregar limpo". A help request
// raises a sticky seal on the agent's pane and on the tab's pane, and the Browser pill and the pad's icon carry the attention
// badge: none goes away by focusing, only when the tab is handed back. Taking maximizes the pane and handing back restores it (E9).
// E9: the bar (history buttons, the real address read-only and cut, loading, the owner chip with a colour derived from the slot id,
// cookies of the site, logins not kept) and the tab (icon, title, owner chip, activity); the page area is the letterbox (the native
// view sits at the fitted rectangle, the bands show the interface).
// The bar now has three zones (bar-rules.ts decides what each shows): navigation; the owner pill (the owner's colour and what
// goes on, in one phrase; a click goes to the agent) with the address, whose ⓘ opens a popover with the tab's facts (cookies,
// logins in memory, debug mode, an address not kept); and the action bar, fed by the tab menu with the bar's pins. The notices
// stack under it, one discreet line each. An open help request shows the "Sua vez" card in a dock (a band with the bar's
// background, pointing at the owner pill) between the bar and the page (the page
// is a native view: nothing in the interface can draw over it), with the agent's message, an optional note for the agent, and
// "Não consigo ajudar" / "Pronto, devolver"; the pane gets a frame in the attention colour. Collapsed (per request), the card
// disappears and the owner pill ("▾ ver pedido" / "▴") brings it back.
// E11: the pad "Guias" (pad-rules.ts): every tab by agent, the ones with the person on top, a click goes to where the tab is (its
// desk), the controls (pause / resume / close, all or one agent's, the ended agents'), the number on the icon, and "Ver guias do
// ‹agente›" in the agent pane's tab menu.
// The tab is the core's standard tab (`tether-tab`: kind, title, ×, right-click for the menu) with the owner's chip and the
// activity dot inside; its menu and each row of the pad offer the same per-tab actions (tab-actions.ts), run by `runTabAction`.
import type { GroupPanelPartInitParameters, IContentRenderer, IDockviewPanel, ITabRenderer } from 'dockview-core'
import { type ActionBar, createActionBar } from '../../app/renderer/action-bar.ts'
import type { Target } from '../../app/renderer/create.ts'
import type { AttentionHandle, ContextMenuEntry, PadHost, PadView, SurfaceBinding, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon, type IconName } from '../../app/renderer/icons.ts'
import { createTabHeader } from '../../app/renderer/tab-header.ts'
import { factsOf } from '../../app/renderer/surface-host.ts'
import { hostVisible } from '../../app/shared/surface-panel-rules.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ControlView } from './control.ts'
import { ASK_NOTE_MAX, helpLine } from './control-rules.ts'
import { type AskCard, type TabNotice, type TabView, tabFacts, tabView } from './bar-rules.ts'
import type { BrowserChannels } from './ipc.ts'
import { LOCAL_NETWORK_SITUATION, localNetworkDialog, type LocalNetworkAsk } from './local-network-rules.ts'
import {
  type DownloadEntry, downloadGroups, formatBytes, PAD_DOWNLOADS, PAD_SHOW_IN_FOLDER, UPLOAD_SITUATION, type UploadAsk, uploadDialog, whenText,
} from './files-rules.ts'
import type { DialogSpec } from '../../app/shared/dialog.ts'
import {
  ACTION_FRESH_MS as PAD_ACTION_FRESH_MS, type ActionKind, brakeableIds, buildPad, CLOSED_SECTION_KEY, withPersonAgent, groupHead, hostOf, isEnded, type LastAction, logoutDialog, type MainAgentView, oldestAsking,
  PAD_ACTIVE, PAD_CLOSE_ALL_ENDED, PAD_ENDED, PAD_NONE_OF_AGENT, PAD_WITH_YOU, type PadAgentInfo, padBadge, type PadGroup, type PadGroupMenuId, padGroupMenu,
  padMenu, type PadMenuId, type PadModel, padOnlyAgent, padSections, type PadSectionId, padSeeAgent, type PadTab, type PadViewState, padViewStateOf, padWhere,
  pillBadgeCount, resolveAgent, rowStateText, shortAddress, toggleCollapsed,
} from './pad-rules.ts'
import { type ClosedTab, closedByText, closedGroups, PAD_CLEAR_CLOSED, PAD_CLOSED, PAD_REOPEN } from './closed-rules.ts'
import { DESK_ID, NEW_TAB_COMMAND_ID, PAD_ID, WEB_COMPONENT, WEB_PANE_PREFIX, WEB_TAB, manifest } from './manifest.ts'
import { BAD_ADDRESS, EDIT_ADDRESS, EDIT_ADDRESS_HINT, NEW_TAB, PAD_MINE, PERSON_NAME, PERSON_TITLE } from './rules.ts'
import { BACK, CRASH_BROWSER, CRASH_GONE, CRASH_HUNG, CRASH_PAUSED, CRED_NOT_KEPT, debugOn, displayUrl, EMPTY_HELP, EMPTY_TITLE, FORWARD, LOADING, NOT_LOADED, OFF_ACTION, offHelpFor, ownerChip, ownerHue, PROFILE_ACTION, PROFILE_OPEN, SETTINGS_ENTRY, PROFILE_OPTION, PROFILE_OPTION_HINT, PROFILE_OPTION_LABEL, READ_ONLY_ADDRESS, RELOAD, REOPEN, serveModeOf, shortName, type ServeMode, TAB_FACTS, TAB_INFO_BUTTON, TAB_INFO_NONE, TAB_INFO_TITLE, type TabFactId } from './rules.ts'
import { insertIndex, isPersonOwned, savedOf, savedTabOf, type SavedTab, type TabInfo } from './tab-rules.ts'
import { PAGE_DIALOG_CANCEL, PAGE_DIALOG_FIELD, PAGE_DIALOG_OK, type PageDialogAsk, pageDialogHead } from './page-rules.ts'
import { CLOSE_TAB, closeNeedsConfirm, closeTabDialog, type TabAction, type TabActionId, type TabActionState, tabActions } from './tab-actions.ts'

export { manifest }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const paneIdOf = (tabId: string): string => `${WEB_PANE_PREFIX}${tabId}`
/** Dresses a chip with its owner's colour (the hue only; the theme gives saturation and lightness) and its name. */
function dressChip(chip: HTMLElement, slotId: string | undefined, agent: { name: string; alive: boolean } | undefined): void {
  const c = ownerChip(agent)
  chip.textContent = slotId ? c.text : ''
  chip.dataset.ended = c.ended ? 'true' : 'false'
  chip.dataset.person = isPersonOwned(slotId) ? 'true' : 'false'
  chip.style.setProperty('--br-hue', String(slotId ? ownerHue(slotId) : 0))
  chip.title = isPersonOwned(slotId) ? PERSON_TITLE : agent ? (c.ended ? c.text : `Agente: ${agent.name}`) : ''
}
/**
 * The owner on the tab strip: a compact emblem (the owner's initial on its hue, the size of the terminal tabs' emblems), with
 * the full text ("‹agente›", "‹agente› encerrado") in data-label, the tooltip and aria-label instead of inline.
 */
function dressTabOwner(badge: HTMLElement, slotId: string | undefined, agent: { name: string; alive: boolean } | undefined): void {
  const c = ownerChip(agent)
  const label = slotId ? c.text : ''
  badge.dataset.label = label
  badge.dataset.ended = c.ended ? 'true' : 'false'
  badge.hidden = !label
  badge.textContent = label ? (agent ? shortName(agent.name) : label).trim().charAt(0).toUpperCase() : ''
  badge.style.setProperty('--br-hue', String(slotId ? ownerHue(slotId) : 0))
  badge.dataset.person = isPersonOwned(slotId) ? 'true' : 'false'
  const tip = isPersonOwned(slotId) ? PERSON_TITLE : agent ? (c.ended ? c.text : `Agente: ${agent.name}`) : label
  badge.title = tip
  if (tip) badge.setAttribute('aria-label', tip); else badge.removeAttribute('aria-label')
}
/** How long the tab's dot stays lit after the agent's last command. */
const ACTIVE_MS = 1500
const ownerOfPanel = (p: IDockviewPanel): string | undefined => (p.params as { ownerSlotId?: string } | undefined)?.ownerSlotId

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<BrowserChannels>()
  /** The mode as the settings page stores it (a stored boolean reads through the manifest's fromBoolean). */
  const serveMode = (): ServeMode => serveModeOf(ui.settings.get<string>('serveToAgents'))
  /** The agent's name as the texts use it. */
  const agentName = (slotId: string | undefined): string => (slotId ? agentOf(slotId)?.name : undefined) || 'agente'
  /** E12: the agents' real life, as main's slots say it (a closed pane does not end an agent); `known` after the first answer. */
  const slots = new Map<string, MainAgentView>()
  let slotsKnown = false
  /** The agent as the interface tells it: the pane's name, main's word on whether it lives. */
  /** The person's own tabs answer "Você", alive (never ended: no slot stands behind them). */
  const agentOf = withPersonAgent((slotId: string): PadAgentInfo | undefined => {
    const pane = ui.agents.get(slotId)
    return resolveAgent(pane ? { name: pane.name, alive: pane.alive } : undefined, slots.get(slotId), slotsKnown)
  })
  /** Who has each tab (main's views, kept as they come). */
  const controls = new Map<string, ControlView>()
  /** F3: the open JavaScript dialog of each page she holds, by tab: shown in its pane's band, never in the agents' question queue. */
  const pageDialogs = new Map<string, PageDialogAsk>()
  let persistentLogins = true

  /**
   * The pad's empty state: the classic centered block (icon in a box, title, one line), shorter when "Fechadas" follow it. Mode `off` keeps its message and the one button that turns the browser on;
   * `perProfile` adds the hint and a button that opens the profiles; `all` shows neither.
   */
  const drawEmpty = (root: HTMLElement, withClosed: boolean): void => {
    const box = el('div', 'br-empty')
    box.dataset.state = 'empty'
    if (withClosed) box.dataset.withClosed = ''
    const art = el('div', 'br-empty-art')
    art.append(icon('globe-simple'))
    box.append(art, el('h3', 'br-empty-title', EMPTY_TITLE), el('p', 'br-empty-help', EMPTY_HELP))
    const mode = serveMode()
    const offHelp = offHelpFor(mode)
    if (offHelp) {
      const off = el('p', 'br-empty-off', offHelp)
      off.dataset.role = 'off'
      off.dataset.mode = mode
      const go = el('button', 'br-empty-go', mode === 'off' ? OFF_ACTION : PROFILE_OPEN)
      go.type = 'button'
      go.dataset.action = mode === 'off' ? 'open-settings' : 'open-profiles'
      go.addEventListener('click', () => { void ui.commands.run(mode === 'off' ? 'settings.show' : 'profiles.manage') })
      box.append(off, go)
    }
    root.replaceChildren(box)
  }

  // ---- E11: the pad's list ----
  /** The agent whose tabs the pad shows alone ("Ver guias do ‹agente›"); undefined: all. */
  let padFilter: string | undefined
  /** The agents' last action per tab, from the gatekeeper's activity events. */
  const actions = new Map<string, LastAction>()
  const agentInfo = (slotId: string): PadAgentInfo | undefined => agentOf(slotId)
  /** The tabs in the order their panes are on screen. */
  const padTabs = (): PadTab[] => {
    const order = ui.panes.all().map(p => p.id).filter(id => panels.has(id))
    for (const id of panels.keys()) if (!order.includes(id)) order.push(id)
    return order.map(id => panels.get(id)!.padTab()).filter((t): t is PadTab => !!t)
  }
  const padModel = (only?: string): PadModel => buildPad(padTabs(), agentInfo, only)
  /**
   * Closes tabs: the live ones in main, and every pane (one back from layout.json has no tab in main yet: its saved address goes
   * with the close, for the closed history). `by` 'cleanup': the ended agents' "Fechar todas".
   */
  const closeTabs = (tabIds: readonly string[], by: 'user' | 'cleanup' = 'user'): void => {
    for (const id of tabIds) {
      const saved = panels.get(paneIdOf(id))?.saved
      void ipc.invoke('close', id, by, saved)
      if (ui.panes.find(paneIdOf(id))) ui.panes.close(paneIdOf(id))
    }
  }

  /** What a tab's actions depend on (tab-actions.ts), from main's control view, the pane and the agent's life. */
  const actionState = (tabId: string): TabActionState => {
    const p = panels.get(paneIdOf(tabId))
    const v = controls.get(tabId)
    const owner = p?.saved?.ownerSlotId
    return {
      holder: v?.holder ?? 'agent', paused: v?.paused ?? false, loaded: !!p?.loaded(), agentAlive: owner ? agentOf(owner)?.alive ?? false : false,
      asking: v?.holder === 'user' && !!v.ask, expired: v?.holder === 'user' && !v.ask && !!v.askExpired,
      ...(isPersonOwned(owner) || v?.why === 'own' ? { own: true } : {}),
    }
  }
  const ownerName = (tabId: string): string => agentName(panels.get(paneIdOf(tabId))?.saved?.ownerSlotId)
  /**
   * Runs one action on one tab: the tab menu, the tab's ×, the pad's rows, the bar, its notices and the card all come here. A
   * hand-back or a decline carries the note the person wrote on the card, wherever it was clicked.
   */
  const runTabAction = async (id: TabActionId, tabId: string): Promise<void> => {
    const note = (): string | undefined => panels.get(paneIdOf(tabId))?.askNote() || undefined
    if (id === 'take') void ipc.invoke('take', tabId)
    else if (id === 'give-back') void ipc.invoke('giveBack', tabId, note())
    else if (id === 'decline') void ipc.invoke('decline', tabId, note())
    else if (id === 'pause') void ipc.invoke('pause', tabId)
    else if (id === 'resume') void ipc.invoke('resume', tabId)
    else if (id === 'clean-reload') void ipc.invoke('cleanReload', tabId)
    else {
      if (closeNeedsConfirm(actionState(tabId))) {
        const p = panels.get(paneIdOf(tabId))
        const a = await ui.dialogs.ask(closeTabDialog(ownerName(tabId), p?.padTab()?.title || shortAddress(p?.padTab()?.url ?? ''))).catch(() => undefined)
        if (a?.choice !== 'close') return
      }
      closeTabs([tabId])
    }
  }
  /**
   * The tab's menu: who has it, the brake, the clean reload; the link and the address; where it lives; close (the core's order).
   * The tab's right-click, the strip's "⋯", the pad's row bar and the tab's own bar all read it; the bar passes its actions with
   * the bar's pins (bar-rules.ts), the others take tab-actions.ts's.
   */
  const tabMenuEntries = (paneId: string, barActions?: TabAction[]): ContextMenuEntry[] => {
    const p = panels.get(paneId)
    const tabId = p?.saved?.tabId
    if (!p || !tabId) {
      return [{ icon: 'link', label: 'Copiar link do painel', run: () => ui.panes.copyLink(paneId) }, { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(paneId) }, 'sep', { icon: 'x', label: CLOSE_TAB, run: () => ui.panes.close(paneId) }]
    }
    const acts = barActions ?? tabActions(actionState(tabId), ownerName(tabId))
    const entry = (a: TabAction): ContextMenuEntry => ({ icon: a.icon, label: a.label, ...(a.danger ? { danger: true } : {}), ...(a.pin ? { pin: a.pin } : {}), run: () => { void runTabAction(a.id, tabId) } })
    const url = p.padTab()?.url ?? ''
    const owner = p.saved?.ownerSlotId
    return [
      ...acts.filter(a => a.id !== 'close').map(entry),
      'sep',
      ...(owner && !isPersonOwned(owner) && agentOf(owner) ? [{ icon: 'globe-simple', label: padSeeAgent(agentName(owner)), run: () => seeAgent(owner) }] : []),
      { icon: 'link', label: 'Copiar link do painel', run: () => ui.panes.copyLink(paneId) },
      ...(url ? [{ icon: 'copy', label: 'Copiar endereço', run: () => ui.shell.writeClipboard(url) }] : []),
      'sep',
      { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(paneId) },
      'sep',
      ...acts.filter(a => a.id === 'close').map(entry),
    ]
  }
  const showWebMenu = (paneId: string, x: number, y: number): void => { ui.menus.context(x, y, tabMenuEntries(paneId)) }

  /** "Sair de todas as contas" (design §12a): asks first; the answer clears every login of every agent. */
  const confirmLogout = async (): Promise<void> => {
    const a = await ui.dialogs.ask(logoutDialog()).catch(() => undefined)
    if (a?.choice === 'logout') await ipc.invoke('logoutAll').catch(() => {})
  }

  /** The pad panel's menu (its header bar shows the pinned items): the items of padMenu, run over every tab. */
  const padMenuEntries = (): ContextMenuEntry[] => {
    const tabs = padTabs()
    const run = (id: PadMenuId): void => {
      if (id === 'show-all') { padFilter = undefined; refreshPad() }
      else if (id === 'pause-all') void ipc.invoke('pauseTabs', brakeableIds(tabs, agentInfo))
      else if (id === 'resume-all') void ipc.invoke('resumeTabs', tabs.filter(t => t.control === 'paused').map(t => t.tabId))
      else void confirmLogout()
    }
    const entries = padMenu(buildPad(tabs, agentInfo), padFilter !== undefined).map((i): ContextMenuEntry => i === 'sep' ? i : {
      icon: i.icon, label: i.label, run: () => run(i.id),
      ...(i.pin ? { pin: i.pin } : {}), ...(i.disabled ? { disabled: true } : {}), ...(i.danger ? { danger: true } : {}),
    })
    // "+": a tab of the person's own, pinned on the panel's header.
    entries.unshift({ icon: 'plus', label: NEW_TAB, pin: 'icon', run: () => { void newTab() } })
    // The empty state no longer carries these buttons: they live here.
    entries.push(
      'sep',
      { icon: 'gear-six', label: SETTINGS_ENTRY, run: () => { void ui.commands.run('settings.show') } },
      { icon: 'sliders-horizontal', label: PROFILE_ACTION, run: () => { void ui.commands.run('profiles.manage') } },
    )
    return entries
  }
  /** An agent group's menu: the brake and close act on every tab of the agent (the ones with the person included). */
  const groupMenuEntries = (g: PadGroup): ContextMenuEntry[] => {
    const own = (): string[] => padTabs().filter(t => t.ownerSlotId === g.slotId).map(t => t.tabId)
    const run = (id: PadGroupMenuId): void => {
      if (id === 'pause-agent') void ipc.invoke('pauseTabs', own())
      else if (id === 'resume-agent') void ipc.invoke('resumeTabs', own())
      else if (id === 'see-agent') seeAgent(g.slotId)
      else closeTabs(own())
    }
    return padGroupMenu(g).map((i): ContextMenuEntry => i === 'sep' ? i : {
      icon: i.icon, label: i.label, run: () => run(i.id), ...(i.pin ? { pin: i.pin } : {}), ...(i.danger ? { danger: true } : {}),
    })
  }

  /** The action bars drawn in each pad root: the pad redraws by replacing children, so the bars (each with a ResizeObserver) are let go first. */
  const barsOf = new WeakMap<HTMLElement, ActionBar[]>()
  const disposeBars = (root: HTMLElement): void => { for (const b of barsOf.get(root) ?? []) b.dispose(); barsOf.delete(root) }
  /** An action bar drawn in `root`, let go at the root's next redraw. */
  const barIn = (root: HTMLElement, label: string, entries: () => ContextMenuEntry[]): HTMLElement => {
    const b = createActionBar({ entries, label, align: 'end', openMenu: (x, y) => ui.menus.context(x, y, entries()) })
    const bars = barsOf.get(root) ?? []
    barsOf.set(root, bars)
    bars.push(b)
    return b.element
  }

  // ---- collapsing groups: kept in the pad's own state (layout.json), shared by its views ----
  let viewState: PadViewState = { collapsed: [], closedCollapsed: [] }
  let viewStateSeeded = false
  const toggleGroup = (key: string, closed = false): void => {
    viewState = closed
      ? { ...viewState, closedCollapsed: toggleCollapsed(viewState.closedCollapsed, key) }
      : { ...viewState, collapsed: toggleCollapsed(viewState.collapsed, key) }
    for (const p of pads) p.persist()
    refreshPad()
  }
  /**
   * A group's header that folds: the caret and the header's free area toggle it; its own buttons (the chip, the action bar) keep
   * their clicks.
   */
  const foldable = (head: HTMLElement, collapsed: boolean, name: string, toggle: () => void): HTMLElement => {
    const caret = el('button', 'br-pad-caret')
    caret.type = 'button'
    caret.dataset.action = 'toggle-group'
    caret.append(icon(collapsed ? 'caret-right' : 'caret-down'))
    caret.setAttribute('aria-expanded', String(!collapsed))
    const label = collapsed ? `Expandir ${name}` : `Recolher ${name}`
    caret.title = label
    caret.setAttribute('aria-label', label)
    caret.addEventListener('click', ev => { ev.stopPropagation(); toggle() })
    head.dataset.fold = 'true'
    head.addEventListener('click', ev => { if (!(ev.target as HTMLElement).closest('button, .action-bar')) toggle() })
    return caret
  }

  const drawList = (root: HTMLElement, model: PadModel): void => {
    const now = Date.now()
    const bar = (label: string, entries: () => ContextMenuEntry[]): HTMLElement => barIn(root, label, entries)
    const list = el('div', 'br-pad-list')
    list.dataset.state = 'list'
    if (padFilter !== undefined) {
      const f = el('div', 'br-pad-filter', padOnlyAgent(agentName(padFilter)))
      f.dataset.role = 'filter'
      list.append(f)
      if (model.total === 0) list.append(el('p', 'br-empty-help', PAD_NONE_OF_AGENT))
    }

    const row = (tab: PadTab, section: PadSectionId): HTMLElement => {
      const owner = agentInfo(tab.ownerSlotId)
      const name = shortName(owner?.name)
      const control = controls.get(tab.tabId)?.control ?? tab.control
      const paneId = paneIdOf(tab.tabId)
      const r = el('div', 'br-pad-row')
      r.dataset.tab = tab.tabId
      r.dataset.control = control
      const open = el('button', 'br-pad-open')
      open.type = 'button'
      open.dataset.action = 'open-tab'
      const where = el('span', 'br-pad-addrline')
      where.append(el('span', 'br-pad-addr', shortAddress(tab.url)))
      if (tab.place && tab.place !== 'Browser') { const w = el('span', 'br-pad-place', padWhere(tab.place)); w.dataset.role = 'place'; where.append(w) }
      open.append(el('span', 'br-pad-title', tab.title || shortAddress(tab.url) || 'Guia'), where)
      const foot = el('div', 'br-pad-foot')
      const text = el('span', 'br-pad-foot-text')
      const state = rowStateText(section, { control, asking: tab.asking, expired: tab.expired, ended: isEnded(owner), name, url: tab.url, ...(actions.get(tab.tabId) ? { action: actions.get(tab.tabId)! } : {}), now })
      if (state) { const s = el('span', 'br-pad-state', state); s.dataset.role = 'state'; text.append(s) }
      else r.dataset.bare = 'true' // no state phrase: the bar shares the address line instead of taking a third one
      foot.append(text, bar('Ações da guia', () => tabMenuEntries(paneId)))
      r.append(open, foot)
      // The whole row reveals the tab (the bar's buttons stop their own clicks); right-click opens the tab's menu.
      r.addEventListener('click', () => ui.panes.reveal(paneId))
      r.addEventListener('contextmenu', ev => { ev.preventDefault(); ui.menus.context(ev.clientX, ev.clientY, tabMenuEntries(paneId)) })
      return r
    }

    const sections = padSections(model)
    const title = (text: string): HTMLElement => el('h4', 'br-pad-head', text)
    const group = (g: PadGroup, section: PadSectionId): HTMLElement => {
      const folded = groupHead(g, viewState.collapsed.includes(g.slotId))
      const box = el('div', 'br-pad-group')
      box.dataset.agent = g.slotId
      box.dataset.ended = g.ended ? 'true' : 'false'
      box.dataset.collapsed = String(folded.collapsed)
      const head = el('div', 'br-pad-ghead')
      const caret = foldable(head, folded.collapsed, `as guias do ${g.name}`, () => toggleGroup(g.slotId))
      const chip = el('button', 'br-web-owner br-pad-agent')
      chip.type = 'button'
      chip.dataset.action = 'focus-agent'
      dressChip(chip, g.slotId, agentInfo(g.slotId) ?? { name: g.name, alive: false })
      // The ended section already says it: the chip is the short name alone.
      if (g.ended || !chip.textContent) chip.textContent = g.name
      chip.addEventListener('click', () => { ui.agents.focus(g.slotId) })
      const count = el('span', 'br-pad-count', String(g.tabs.length))
      count.dataset.role = 'count'
      head.append(caret, chip, count)
      if (folded.attention) {
        const attn = el('span', 'br-pad-attn')
        attn.dataset.role = 'attention'
        const tip = `${g.asking} ${g.asking === 1 ? 'guia pede' : 'guias pedem'} sua ajuda`
        attn.title = tip
        attn.setAttribute('aria-label', tip)
        head.append(attn)
      }
      head.append(bar(`Ações do ${g.name}`, () => groupMenuEntries(g)))
      box.append(head, ...(folded.collapsed ? [] : g.tabs.map(t => row(t, section))))
      return box
    }
    // Her own tabs first: what she opened herself, no agent behind.
    if (sections.mine.length > 0) {
      const sec = el('section', 'br-pad-section')
      sec.dataset.section = 'mine'
      sec.append(title(`${PAD_MINE} (${sections.mine.length})`), ...sections.mine.map(t => row(t, 'mine')))
      list.append(sec)
    }
    if (sections.withPerson.length > 0) {
      const sec = el('section', 'br-pad-section')
      sec.dataset.section = 'user'
      sec.append(title(`${PAD_WITH_YOU} (${sections.withPerson.length})`), ...sections.withPerson.map(t => row(t, 'user')))
      list.append(sec)
    }
    if (sections.active.length > 0) {
      const sec = el('section', 'br-pad-section')
      sec.dataset.section = 'active'
      sec.append(title(PAD_ACTIVE), ...sections.active.map(g => group(g, 'active')))
      list.append(sec)
    }
    if (sections.ended.length > 0) {
      const sec = el('section', 'br-pad-section')
      sec.dataset.section = 'ended'
      const head = el('div', 'br-pad-sechead')
      const closeAll = (): ContextMenuEntry[] => [{ icon: 'x', label: PAD_CLOSE_ALL_ENDED, danger: true, pin: 'primary', run: () => closeTabs(sections.endedIds, 'cleanup') }]
      head.append(title(`${PAD_ENDED} (${sections.endedIds.length})`), bar('Ações das guias de agentes encerrados', closeAll))
      sec.append(head, ...sections.ended.map(g => group(g, 'ended')))
      list.append(sec)
    }
    root.replaceChildren(list)
  }

  // ---- E13: "Baixados" (design §4.3, §12a): by agent, name, size, when, and "Mostrar na pasta" ----
  let downloadsList: DownloadEntry[] = []
  /** The one text button left in the pad: a downloaded file's "Mostrar na pasta". */
  const showButton = (text: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'br-pad-btn', text)
    b.type = 'button'
    b.dataset.action = 'show-in-folder'
    b.addEventListener('click', () => onClick())
    return b
  }
  const drawDownloads = (root: HTMLElement): void => {
    const shown = padFilter === undefined ? downloadsList : downloadsList.filter(d => d.slotId === padFilter)
    if (shown.length === 0) return
    const now = Date.now()
    const sec = el('section', 'br-pad-section br-pad-downloads')
    sec.dataset.section = 'downloads'
    sec.append(el('h4', 'br-pad-head', `${PAD_DOWNLOADS} (${shown.length})`))
    for (const g of downloadGroups(shown)) {
      const group = el('div', 'br-pad-dgroup')
      group.dataset.agent = g.slotId
      group.append(el('div', 'br-pad-dagent', agentName(g.slotId)))
      for (const f of g.files) {
        const r = el('div', 'br-pad-row br-pad-drow')
        r.dataset.name = f.name
        const text = el('span', 'br-pad-dtext')
        text.append(el('span', 'br-pad-title', f.name), el('span', 'br-pad-addr', `${formatBytes(f.bytes)} · ${whenText(f.at, now)}`))
        r.append(text, showButton(PAD_SHOW_IN_FOLDER, () => { void ipc.invoke('showDownload', f.slotId, f.name).catch(() => {}) }))
        group.append(r)
      }
      sec.append(group)
    }
    const host = root.querySelector('.br-pad-list') ?? root
    host.append(sec)
  }
  // ---- "Fechadas": the closed history by agent, each with "Reabrir", and "Limpar histórico" ----
  let closedList: ClosedTab[] = []
  const closedOwnerName = (slotId: string, kept: string): string => isPersonOwned(slotId) ? PERSON_NAME : shortName(ui.agents.get(slotId)?.name || slots.get(slotId)?.name || kept || 'Agente')
  const reopenClosed = async (id: string): Promise<void> => {
    const info = await ipc.invoke('reopenClosed', id).catch(() => null)
    if (!info) return
    // The tab event opened its pane (or will, at once): it is shown, with the person holding it.
    const show = (tries: number): void => {
      if (ui.panes.find(paneIdOf(info.tabId))) ui.panes.reveal(paneIdOf(info.tabId))
      else if (tries > 0) setTimeout(() => show(tries - 1), 50)
    }
    show(20)
  }
  const drawClosed = (root: HTMLElement): void => {
    const shown = padFilter === undefined ? closedList : closedList.filter(c => c.ownerSlotId === padFilter)
    if (shown.length === 0) return
    const now = Date.now()
    const sectionFolded = viewState.closedCollapsed.includes(CLOSED_SECTION_KEY)
    const sec = el('section', 'br-pad-section br-pad-closed')
    sec.dataset.section = 'closed'
    sec.dataset.collapsed = String(sectionFolded)
    const head = el('div', 'br-pad-sechead')
    const clear = (): ContextMenuEntry[] => [{ icon: 'trash', label: PAD_CLEAR_CLOSED, danger: true, pin: 'icon', run: () => { void ipc.invoke('clearClosed').catch(() => {}) } }]
    head.append(
      foldable(head, sectionFolded, 'as guias fechadas', () => toggleGroup(CLOSED_SECTION_KEY, true)),
      el('h4', 'br-pad-head', `${PAD_CLOSED} (${shown.length})`),
      barIn(root, 'Ações das guias fechadas', clear),
    )
    sec.append(head)
    if (!sectionFolded) {
      for (const g of closedGroups(shown)) {
        const folded = viewState.closedCollapsed.includes(g.slotId)
        const name = closedOwnerName(g.slotId, g.name)
        const box = el('div', 'br-pad-group')
        box.dataset.agent = g.slotId
        box.dataset.collapsed = String(folded)
        const ghead = el('div', 'br-pad-ghead')
        const who = el('span', 'br-pad-dagent', name)
        const count = el('span', 'br-pad-count', String(g.items.length))
        count.dataset.role = 'count'
        ghead.append(foldable(ghead, folded, `as guias fechadas do ${name}`, () => toggleGroup(g.slotId, true)), who, count)
        box.append(ghead)
        if (!folded) {
          for (const c of g.items) {
            const r = el('div', 'br-pad-row br-pad-drow br-pad-crow')
            r.dataset.closed = c.id
            const text = el('span', 'br-pad-dtext')
            text.append(el('span', 'br-pad-title', c.title || shortAddress(c.url) || 'Guia'), el('span', 'br-pad-addr', `${shortAddress(c.url)} · ${closedByText(c.by)} · ${whenText(c.closedAt, now)}`))
            text.title = c.url
            const b = el('button', 'br-pad-btn', PAD_REOPEN)
            b.type = 'button'
            b.dataset.action = 'reopen-closed'
            b.addEventListener('click', () => { void reopenClosed(c.id) })
            r.append(text, b)
            box.append(r)
          }
        }
        sec.append(box)
      }
    }
    const host = root.querySelector('.br-pad-list') ?? root
    host.append(sec)
  }
  const drawPad = (root: HTMLElement): void => {
    disposeBars(root)
    const all = padModel()
    if (all.total === 0) drawEmpty(root, (padFilter === undefined ? closedList : closedList.filter(c => c.ownerSlotId === padFilter)).length > 0)
    else drawList(root, padFilter === undefined ? all : padModel(padFilter))
    drawClosed(root)
    drawDownloads(root)
  }
  const pads = new Set<Pad>()
  /** A signature of everything the list writes, so a redraw only follows a real change. */
  const padSignature = (): string => {
    const now = Date.now()
    const tabs = padTabs()
    return JSON.stringify([
      padFilter, serveMode(), persistentLogins, downloadsList.map(d => [d.slotId, d.name, d.bytes, whenText(d.at, now)]), viewState,
      closedList.map(c => [c.id, c.title, c.ownerSlotId, closedOwnerName(c.ownerSlotId, c.ownerName), whenText(c.closedAt, now)]),
      tabs.map(t => [t.tabId, actionState(t.tabId), t.ownerSlotId, t.title, shortAddress(t.url), t.control, t.asking, t.expired, t.place, agentInfo(t.ownerSlotId), (() => { const a = actions.get(t.tabId); return a && now - a.at <= PAD_ACTION_FRESH_MS ? [a.kind, hostOf(t.url)] : 0 })()]),
    ])
  }
  let lastBadge: ReturnType<typeof padBadge>
  let refreshQueued = false
  /** The pad's views and the icon's number follow what changed (coalesced: many events arrive together). */
  function refreshPad(): void {
    if (refreshQueued) return
    refreshQueued = true
    setTimeout(() => {
      refreshQueued = false
      const badge = padBadge(padModel())
      lastBadge = badge
      ui.pads.setBadge(PAD_ID, badge)
      const sig = padSignature()
      if (sig !== drawnSignature) {
        drawnSignature = sig
        for (const p of pads) p.redraw()
      }
    }, 0)
  }
  let drawnSignature = ''
  /** Set while the extension itself opens the pad ("Ver guias do ‹agente›"): that opening is not a click on the icon. */
  let ownOpen = false
  /** "Ver guias do ‹agente›": the pad opens with that agent's tabs alone. */
  function seeAgent(slotId: string): void { padFilter = slotId; ownOpen = true; setTimeout(() => { ownOpen = false }, 300); ui.pads.open(PAD_ID); refreshPad() }

  class Pad implements PadView {
    readonly element = el('div', 'br-pad')
    private readonly sub: IDisposable
    private readonly host: PadHost
    constructor(host: PadHost) {
      this.host = host
      if (!viewStateSeeded) { viewState = padViewStateOf(host.state); viewStateSeeded = true }
      this.element.dataset.pad = PAD_ID
      drawPad(this.element)
      this.sub = ui.settings.onChange('serveToAgents', () => this.redraw())
      pads.add(this)
    }
    /** The header shows the pinned items of menu(), which follow the same state as the list. */
    redraw(): void { drawPad(this.element); this.host.menuChanged() }
    menu(): ContextMenuEntry[] { return padMenuEntries() }
    /** The collapsed groups, kept in layout.json (they survive reopening the pad and the app). */
    serialize(): PadViewState { return viewState }
    persist(): void { this.host.persist() }
    focus(): void {
      // The icon was clicked (or the pad opened from the keyboard) with a help request pending: straight to the tab that asks.
      if (!ownOpen && goToOldestAsk()) return
      this.element.querySelector<HTMLElement>('button')?.focus()
    }
    dispose(): void { this.sub.dispose(); disposeBars(this.element); pads.delete(this) }
  }

  /** The live `web` panes by pane id. */
  const panels = new Map<string, Panel>()
  let unloading = false
  window.addEventListener('beforeunload', () => { unloading = true })

  class Panel implements IContentRenderer {
    readonly element = el('div', 'br-web')
    // The bar has three zones: navigation; the owner pill and the address (its ⓘ keeps the tab's facts); the actions.
    private readonly bar = el('div', 'br-web-bar')
    private readonly navEl = el('div', 'br-web-navs')
    private readonly backBtn = el('button', 'br-web-nav')
    private readonly fwdBtn = el('button', 'br-web-nav')
    private readonly reloadBtn = el('button', 'br-web-nav')
    private readonly ownerEl = el('button', 'br-web-owner')
    private readonly ownerText = el('span', 'br-web-owner-text')
    private readonly ownerLive = el('span', 'br-web-owner-live')
    private readonly ownerShort = el('span', 'br-web-owner-short')
    private readonly ownerToggle = el('span', 'br-web-owner-toggle')
    private readonly addrEl = el('div', 'br-web-addr')
    private readonly infoBtn = el('button', 'br-web-info')
    private readonly urlEl = el('span', 'br-web-url')
    /** The address the person types (shown in place of `urlEl` while she edits; only on a tab she holds). */
    private readonly urlInput = el('input', 'br-web-url-input')
    private readonly stateEl = el('span', 'br-web-state')
    private readonly spinner = el('span', 'br-web-spin')
    private readonly actionBar: ActionBar
    /** The tab's facts, behind the ⓘ (a popover over the page: the surfaces freeze while it is open). */
    private readonly popEl = el('div', 'br-web-pop')
    private readonly popFacts = new Map<TabFactId, HTMLElement>()
    private readonly popNone = el('p', 'br-web-pop-none', TAB_INFO_NONE)
    private popHold: IDisposable | undefined
    private popOff: (() => void) | undefined
    /** The notices under the bar, one line each. */
    private readonly notesEl = el('div', 'br-web-notes')
    private notesDrawn = ''
    /** The "Sua vez" card of an open help request, between the bar and the page (the page is a native view: nothing draws over it). */
    private readonly turnEl = el('section', 'br-web-turn')
    /**
     * The dock that holds the card: a band with the bar's background between the bar (and notices) and the page. It owns its
     * height and pushes the page down; collapsed, the whole band goes. The card's arrow points at the owner pill.
     */
    private readonly dockEl = el('div', 'br-web-dock')
    private readonly dockRo = new ResizeObserver(() => this.placeTip())
    private turnAsk = ''
    private noteEl: HTMLTextAreaElement | undefined
    /**
     * F3: the page's JavaScript dialog while she holds the tab, a band of its own between the bar and the page (the page is a
     * native view: nothing draws over it). Built once per dialog, so what she types in a prompt survives repaints.
     */
    private readonly jsEl = el('section', 'br-web-jsdlg')
    private jsAsk = ''
    private jsInput: HTMLInputElement | undefined
    /** The request whose card the person collapsed (a new request opens expanded). */
    private collapsedAsk: string | undefined
    private actedAt = 0
    /** Set when this pane was maximized by taking the tab (so handing back restores only what we did). */
    maximizedByTake = false
    private ignoredUntil = 0
    private ignoredTimer: ReturnType<typeof setTimeout> | undefined
    readonly page = el('div', 'br-web-page')
    private paneId = ''
    private api: GroupPanelPartInitParameters['api'] | undefined
    saved: SavedTab | undefined
    private info: TabInfo | undefined
    private binding: SurfaceBinding | undefined
    private boundSurface = ''
    private readonly crashEl = el('div', 'br-web-crash')
    private readonly crashText = el('span', 'br-web-crash-text')
    private readonly crashBtn = el('button', 'br-web-crash-act', REOPEN)
    private reopening = false
    private restoring = false
    private readonly subs: IDisposable[] = []
    private ro: ResizeObserver | undefined
    private checkQueued = false

    constructor() {
      for (const [b, name, label, action] of [[this.backBtn, 'arrow-left', BACK, 'back'], [this.fwdBtn, 'arrow-right', FORWARD, 'forward'], [this.reloadBtn, 'arrow-clockwise', RELOAD, 'reload']] as const) {
        b.type = 'button'
        b.dataset.nav = action
        b.title = label
        b.setAttribute('aria-label', label)
        b.append(icon(name))
        b.addEventListener('click', () => { const id = this.info?.tabId; if (id && !b.disabled) void ipc.invoke(action, id) })
      }
      this.navEl.append(this.backBtn, this.fwdBtn, this.reloadBtn)
      this.ownerEl.type = 'button'
      this.ownerEl.dataset.role = 'owner'
      this.ownerLive.hidden = true
      this.ownerLive.title = 'O agente está agindo'
      this.ownerToggle.hidden = true
      // The long phrase and the short one are both in the pill; the pane's width (a container query) shows one.
      this.ownerEl.append(el('span', 'br-web-owner-dot'), this.ownerText, this.ownerShort, this.ownerLive, this.ownerToggle)
      // During a help request the pill opens and collapses the card; otherwise it goes to the agent.
      this.ownerEl.addEventListener('click', () => {
        if (this.turnAsk) { this.toggleTurn(); return }
        const o = this.saved?.ownerSlotId
        // Her own tab's pill leads nowhere: there is no agent.
        if (o && !isPersonOwned(o)) ui.agents.focus(o)
      })
      this.infoBtn.type = 'button'
      this.infoBtn.dataset.role = 'info'
      this.infoBtn.title = TAB_INFO_BUTTON
      this.infoBtn.setAttribute('aria-label', TAB_INFO_BUTTON)
      this.infoBtn.setAttribute('aria-haspopup', 'dialog')
      this.infoBtn.setAttribute('aria-expanded', 'false')
      this.infoBtn.append(icon('info'))
      this.infoBtn.addEventListener('click', ev => { ev.stopPropagation(); this.togglePop() })
      this.urlEl.dataset.role = 'address'
      this.urlEl.setAttribute('aria-label', READ_ONLY_ADDRESS)
      // While she holds the tab the address is hers to type: a click (or Enter on it, or Ctrl+L) opens the field.
      this.urlEl.addEventListener('click', () => { if (this.editable()) this.startEdit() })
      this.urlEl.addEventListener('keydown', ev => { if (ev.key === 'Enter' && this.editable()) { ev.preventDefault(); this.startEdit() } })
      this.urlInput.type = 'text'
      this.urlInput.hidden = true
      this.urlInput.spellcheck = false
      this.urlInput.autocomplete = 'off'
      this.urlInput.dataset.role = 'address-input'
      this.urlInput.setAttribute('aria-label', EDIT_ADDRESS)
      this.urlInput.placeholder = EDIT_ADDRESS_HINT
      this.urlInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); void this.submitAddress() }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.endEdit() }
      })
      this.urlInput.addEventListener('input', () => { delete this.urlInput.dataset.invalid; this.urlInput.title = '' })
      this.urlInput.addEventListener('blur', () => { if (!this.submitting) this.endEdit() })
      this.spinner.dataset.role = 'loading'
      this.spinner.hidden = true
      this.addrEl.append(this.infoBtn, this.urlEl, this.urlInput, this.stateEl, this.spinner)
      this.actionBar = createActionBar({
        label: 'Ações da guia', align: 'end', moreClass: 'br-web-more',
        entries: () => this.barEntries(),
        openMenu: (x, y) => ui.menus.context(x, y, this.barEntries()),
      })
      this.actionBar.element.classList.add('br-web-actions')
      this.bar.append(this.navEl, this.ownerEl, this.addrEl, this.actionBar.element)
      this.popEl.hidden = true
      this.popEl.setAttribute('role', 'dialog')
      this.popEl.setAttribute('aria-label', TAB_INFO_TITLE)
      const list = el('ul', 'br-web-pop-list')
      for (const id of Object.keys(TAB_FACTS) as TabFactId[]) {
        const f = TAB_FACTS[id]
        const li = el('li', 'br-web-pop-fact')
        li.dataset.fact = id
        li.hidden = true
        const text = el('span', 'br-web-pop-text')
        text.append(el('strong', 'br-web-pop-head', f.title), el('span', 'br-web-pop-body', f.text))
        li.append(icon(f.icon as IconName), text)
        this.popFacts.set(id, li)
        list.append(li)
      }
      this.popEl.append(el('h4', 'br-web-pop-title', TAB_INFO_TITLE), list, this.popNone)
      this.notesEl.dataset.role = 'notices'
      this.turnEl.dataset.role = 'turn'
      this.dockEl.hidden = true
      this.dockEl.append(this.turnEl)
      this.jsEl.hidden = true
      this.jsEl.dataset.role = 'page-dialog'
      this.jsEl.setAttribute('role', 'alertdialog')
      this.element.append(this.bar, this.notesEl, this.dockEl, this.jsEl, this.page, this.popEl)
      // The pill moves when the bar reflows (pane resized, narrow layout, phrase changed): the arrow follows it.
      this.dockRo.observe(this.bar)
      this.dockRo.observe(this.ownerEl)
      this.crashEl.dataset.role = 'crash'
      this.crashEl.hidden = true
      this.crashBtn.type = 'button'
      this.crashBtn.dataset.action = 'reopen'
      this.crashEl.append(this.crashText, this.crashBtn)
      this.page.append(this.crashEl)
      this.crashBtn.addEventListener('click', () => {
        const tabId = this.info?.tabId
        if (!tabId || this.reopening) return
        this.reopening = true
        this.crashBtn.disabled = true
        void ipc.invoke('reopen', tabId).then(info => { if (info && panels.get(this.paneId) === this) this.bind(info) })
          .finally(() => { this.reopening = false; this.crashBtn.disabled = false })
      })
    }

    private tabId(): string | undefined { return this.info?.tabId ?? this.saved?.tabId }

    /** The bar's actions: the tab menu, with the pins of the bar's state (bar-rules.ts). */
    private barEntries(): ContextMenuEntry[] { return tabMenuEntries(this.paneId, this.view().actions) }

    /** What the bar shows now, from main's control view, the pane and the agent's life (bar-rules.ts). */
    view(): TabView {
      const tabId = this.tabId()
      const owner = this.saved ? agentOf(this.saved.ownerSlotId) : undefined
      return tabView({
        ...(tabId && controls.get(tabId) ? { control: controls.get(tabId)! } : {}),
        loaded: !!this.info,
        agent: { name: agentName(this.saved?.ownerSlotId), alive: owner?.alive ?? false },
        ignored: Date.now() < this.ignoredUntil,
        popupsRefused: this.info?.popupsRefused ?? 0,
        ...(this.collapsedAsk ? { collapsedAsk: this.collapsedAsk } : {}),
        acting: this.activity() === 'agent',
        ...(this.own() ? { own: true } : {}),
      })
    }

    /** The person's note on the open request's card ('' when none). */
    askNote(): string { return this.noteEl?.value ?? '' }

    /** The person's own tab (owner PERSON_OWNER). */
    own(): boolean { return isPersonOwned(this.saved?.ownerSlotId) }

    /** She may type an address: her own tab, or an agent's she holds, once main has it. */
    editable(): boolean { return !!this.info && (this.own() || this.view().nav) }

    private submitting = false

    /** Opens the address field with the current address selected (empty on the blank page). */
    startEdit(): void {
      if (!this.editable()) return
      const url = this.info?.url ?? ''
      if (this.urlInput.hidden) this.urlInput.value = url === 'about:blank' ? '' : url
      delete this.urlInput.dataset.invalid
      this.urlInput.title = ''
      this.urlInput.hidden = false
      this.urlEl.hidden = true
      this.urlInput.focus()
      this.urlInput.select()
    }

    /** Closes the field: the bar shows the tab's real address again (Esc, blur, or the address went). */
    endEdit(): void {
      if (this.urlInput.hidden) return
      this.urlInput.hidden = true
      this.urlEl.hidden = false
      delete this.urlInput.dataset.invalid
    }

    /** Enter: main checks the address and navigates; a refused one keeps the field open, marked. */
    private async submitAddress(): Promise<void> {
      const tabId = this.tabId()
      if (!tabId || this.submitting) return
      this.submitting = true
      const outcome = await ipc.invoke('go', tabId, this.urlInput.value).catch(() => 'no-tab' as const)
      this.submitting = false
      if (outcome === 'ok') { this.endEdit(); return }
      this.urlInput.dataset.invalid = 'true'
      this.urlInput.title = outcome === 'bad-url' ? BAD_ADDRESS : ''
      this.urlInput.focus()
    }

    /** The address as the field reads it now (test hook). */
    addressField(): { editing: boolean; value: string; invalid: boolean; editable: boolean } {
      return { editing: !this.urlInput.hidden, value: this.urlInput.value, invalid: this.urlInput.dataset.invalid === 'true', editable: this.editable() }
    }

    init(p: GroupPanelPartInitParameters): void {
      this.paneId = p.api.id
      this.api = p.api
      this.saved = savedTabOf(p.params)
      panels.set(this.paneId, this)
      refreshPad()
      if (!this.saved) { this.paint(); return }
      this.element.dataset.tab = this.saved.tabId
      this.subs.push(p.api.onDidVisibilityChange(() => this.queueCheck()))
      this.subs.push(ui.systemDesks.onDidChangeActive(() => this.queueCheck()))
      this.subs.push(ui.panes.onDidChangeActive(() => this.queueCheck()))
      this.ro = new ResizeObserver(() => this.queueCheck())
      this.ro.observe(this.page)
      const tabId = this.saved.tabId
      void ipc.invoke('get', tabId).then(info => {
        if (panels.get(this.paneId) !== this) return
        if (info) this.bind(info)
        else { this.paint(); this.queueCheck() }
      })
    }

    /** The tab's surface is tied to the page area; the frame shows main's title and address. */
    bind(info: TabInfo): void {
      // A crashed tab lets its surface go (nothing to draw); "Reabrir" brings the tab back with a new surface.
      if (this.binding && (info.crashed || this.boundSurface !== info.surfaceId)) { this.binding.dispose(); this.binding = undefined }
      if (!this.binding && !info.crashed) {
        this.boundSurface = info.surfaceId
        this.binding = ui.surfaces.attach(info.surfaceId, this.page)
        // The person's click or key on the shield (the agent has the tab): a notice answers, with the way to take it.
        this.subs.push(this.binding.onShieldInput(i => { if (i.kind === 'down' || i.kind === 'key' || i.kind === 'wheel') this.ignored() }))
      }
      this.show(info)
    }

    show(info: TabInfo): void {
      this.info = info
      const saved = savedOf(info)
      this.saved = saved
      this.api?.updateParameters({ ...saved })
      if (info.title) this.api?.setTitle(info.title)
      ui.layout.scheduleSave()
      this.paint()
    }

    private ignored(): void {
      this.ignoredUntil = Date.now() + 6000
      clearTimeout(this.ignoredTimer)
      this.ignoredTimer = setTimeout(() => this.paintControl(), 6100)
      this.paintControl()
    }

    /** The owner pill, the actions, the notices and the card, from tabView (design §12a). */
    paintControl(): void {
      const tabId = this.tabId()
      const v = tabId ? controls.get(tabId) : undefined
      // A tab not loaded yet can be paused (E12): its state waits in main and applies when it loads.
      const control = this.own() ? 'user' : this.info ? (v?.control ?? 'agent') : v?.paused ? 'paused' : undefined
      const view = this.view()
      this.element.dataset.control = control ?? ''
      this.element.dataset.attn = view.ask ? 'true' : 'false'
      this.paintOwner(view)
      this.paintNav(view.nav)
      const editable = this.editable()
      this.urlEl.dataset.editable = String(editable)
      this.urlEl.tabIndex = editable ? 0 : -1
      this.urlEl.setAttribute('aria-label', editable ? EDIT_ADDRESS : READ_ONLY_ADDRESS)
      if (!editable) this.endEdit()
      this.actionBar.refresh()
      this.paintNotices(view.notices)
      this.paintTurn(view.ask)
      this.paintPageDialog()
    }

    /** F3: the band of the page's dialog (OK, Cancelar, a prompt's field); Enter answers OK, Esc cancels. */
    paintPageDialog(): void {
      const tabId = this.tabId()
      const ask = tabId ? pageDialogs.get(tabId) : undefined
      this.jsEl.hidden = !ask
      if (!ask) {
        if (this.jsAsk) { this.jsAsk = ''; this.jsInput = undefined; this.jsEl.replaceChildren() }
        return
      }
      if (this.jsAsk === ask.id) return
      this.jsAsk = ask.id
      this.jsInput = undefined
      this.jsEl.dataset.kind = ask.kind
      const answer = (accept: boolean): void => {
        const text = this.jsInput?.value
        if (pageDialogs.get(ask.tabId)?.id === ask.id) pageDialogs.delete(ask.tabId)
        this.paintPageDialog()
        void ipc.invoke('pageDialogAnswer', ask.id, accept, text).catch(() => {})
      }
      const body = el('div', 'br-web-jsdlg-body')
      body.append(el('strong', 'br-web-jsdlg-head', pageDialogHead(ask.origin)), el('p', 'br-web-jsdlg-msg', ask.message))
      if (ask.kind === 'prompt') {
        const input = el('input', 'br-web-jsdlg-input')
        input.type = 'text'
        input.spellcheck = false
        input.autocomplete = 'off'
        input.value = ask.defaultText ?? ''
        input.setAttribute('aria-label', PAGE_DIALOG_FIELD)
        this.jsInput = input
        body.append(input)
      }
      const foot = el('div', 'br-web-jsdlg-foot')
      const button = (accept: boolean, label: string): HTMLButtonElement => {
        const b = el('button', `br-web-jsdlg-btn${accept ? ' br-web-jsdlg-ok' : ''}`, label)
        b.type = 'button'
        b.dataset.action = accept ? 'ok' : 'cancel'
        b.addEventListener('click', () => answer(accept))
        return b
      }
      const ok = button(true, PAGE_DIALOG_OK)
      foot.append(...(ask.kind === 'alert' ? [] : [button(false, PAGE_DIALOG_CANCEL)]), ok)
      this.jsEl.onkeydown = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); answer(ask.kind === 'alert') }
        else if (ev.key === 'Enter' && ev.target === this.jsInput) { ev.preventDefault(); answer(true) }
      }
      this.jsEl.replaceChildren(body, foot)
      // The keyboard goes to the band only when her pane is the active one (nothing is taken from where she is typing).
      if (activeWebPane === this.paneId) (this.jsInput ?? ok).focus()
    }

    /** What the band shows now (test hook). */
    pageDialog(): { kind: string; head: string; message: string; value: string | null; buttons: string[] } | null {
      if (this.jsEl.hidden || !this.jsAsk) return null
      return {
        kind: this.jsEl.dataset.kind ?? '', head: this.jsEl.querySelector('.br-web-jsdlg-head')?.textContent ?? '',
        message: this.jsEl.querySelector('.br-web-jsdlg-msg')?.textContent ?? '', value: this.jsInput ? this.jsInput.value : null,
        buttons: [...this.jsEl.querySelectorAll<HTMLButtonElement>('.br-web-jsdlg-btn')].map(b => b.textContent ?? ''),
      }
    }

    /** Answers the band the way she would: types the prompt's text, then clicks OK or Cancelar (test hook). */
    answerPageDialog(accept: boolean, text?: string): boolean {
      if (this.jsEl.hidden) return false
      if (text !== undefined && this.jsInput) this.jsInput.value = text
      this.jsEl.querySelector<HTMLButtonElement>(`.br-web-jsdlg-btn[data-action="${accept ? 'ok' : 'cancel'}"]`)?.click()
      return true
    }

    /** The pill: the owner's colour and name, and what goes on, in one phrase; a click goes to the agent (or toggles the card). */
    private paintOwner(view: TabView): void {
      const slotId = this.saved?.ownerSlotId
      const agent = slotId ? agentOf(slotId) : undefined
      const c = ownerChip(agent)
      this.ownerEl.hidden = !slotId
      this.ownerEl.dataset.tone = view.owner.tone
      this.ownerEl.dataset.chip = slotId ? c.text : ''
      this.ownerEl.dataset.ended = c.ended ? 'true' : 'false'
      this.ownerEl.dataset.person = this.own() ? 'true' : 'false'
      this.ownerEl.style.setProperty('--br-hue', String(slotId ? ownerHue(slotId) : 0))
      const toggle = view.owner.toggle
      this.ownerEl.title = toggle ? toggle.title : this.own() ? PERSON_TITLE : agent ? `Ver o agente: ${agent.name}` : ''
      if (toggle) this.ownerEl.setAttribute('aria-expanded', String(!view.ask?.collapsed)); else this.ownerEl.removeAttribute('aria-expanded')
      this.ownerText.textContent = view.owner.text
      this.ownerShort.textContent = view.owner.short
      this.ownerLive.hidden = !view.owner.live
      this.ownerToggle.hidden = !toggle
      this.ownerToggle.replaceChildren(toggle?.mark ?? '', ...(toggle?.word ? [el('span', 'br-web-owner-word', ` ${toggle.word}`)] : []))
    }

    /** Collapses the open request's card (it disappears) or brings it back. */
    private toggleTurn(): void {
      this.collapsedAsk = this.collapsedAsk === this.turnAsk ? undefined : this.turnAsk
      this.paintControl()
    }

    private paintNotices(notices: TabNotice[]): void {
      const sig = JSON.stringify(notices)
      if (sig === this.notesDrawn) return
      this.notesDrawn = sig
      this.notesEl.replaceChildren(...notices.map(n => {
        const line = el('div', 'br-web-note')
        line.dataset.kind = n.kind
        line.append(icon('info'), el('span', 'br-web-note-text', n.text))
        if (n.action) {
          const b = el('button', 'br-web-note-act', n.action.label)
          b.type = 'button'
          b.dataset.action = n.action.id
          const id = n.action.id
          b.addEventListener('click', () => { const t = this.tabId(); if (t) void runTabAction(id, t) })
          line.append(b)
        }
        return line
      }))
      this.notesEl.hidden = notices.length === 0
    }

    /**
     * The "Sua vez" card, in the flow between the bar and the page (the page area shrinks; nothing covers the page). Built once
     * per request, so her note survives repaints; collapsed, it disappears entirely (kept, with the note) and the pill brings it back.
     */
    private paintTurn(ask: AskCard | undefined): void {
      this.dockEl.hidden = !ask || ask.collapsed
      if (!ask) {
        if (this.turnAsk) { this.turnAsk = ''; this.noteEl = undefined; this.turnEl.replaceChildren() }
        return
      }
      if (this.turnAsk !== ask.id) {
        this.turnAsk = ask.id
        const head = el('header', 'br-web-turn-head')
        const toggle = el('button', 'br-web-turn-toggle')
        toggle.type = 'button'
        toggle.dataset.action = 'toggle'
        toggle.textContent = ask.collapse
        toggle.addEventListener('click', () => this.toggleTurn())
        head.append(el('span', 'br-web-turn-tag', ask.tag), el('h3', 'br-web-turn-title', ask.title), toggle)
        const body = el('div', 'br-web-turn-body')
        const quote = el('blockquote', 'br-web-turn-msg', ask.message)
        // The note box stays closed: writing to the agent is secondary, opened by the footer's discreet link.
        const say = el('label', 'br-web-turn-say')
        say.hidden = true
        const note = el('textarea', 'br-web-turn-note')
        note.rows = 2
        note.maxLength = ASK_NOTE_MAX
        note.placeholder = ask.placeholder
        this.noteEl = note
        say.append(el('span', 'br-web-turn-say-text', ask.say), note)
        const write = el('button', 'br-web-turn-write', ask.write)
        write.type = 'button'
        write.dataset.action = 'write'
        write.addEventListener('click', () => { say.hidden = false; write.hidden = true; note.focus() })
        const foot = el('footer', 'br-web-turn-foot')
        const button = (id: 'decline' | 'give-back', label: string): HTMLButtonElement => {
          const b = el('button', `br-web-turn-btn${id === 'give-back' ? ' br-web-turn-done' : ''}`, label)
          b.type = 'button'
          b.dataset.action = id
          b.addEventListener('click', () => { const t = this.tabId(); if (t) void runTabAction(id, t) })
          return b
        }
        foot.append(write, button('decline', ask.decline), button('give-back', ask.done))
        body.append(quote, el('p', 'br-web-turn-hint', ask.hint), say, foot)
        this.turnEl.replaceChildren(head, body)
      }
      this.turnEl.dataset.collapsed = ask.collapsed ? 'true' : 'false'
      if (!ask.collapsed) this.placeTip()
    }

    /** The card's arrow sits under the owner pill: its offset from the card's left edge, kept inside the card. */
    private placeTip(): void {
      if (this.dockEl.hidden) return
      const pill = this.ownerEl.getBoundingClientRect()
      const card = this.turnEl.getBoundingClientRect()
      if (card.width === 0) return
      const tip = Math.min(Math.max(16, pill.left - card.left + 24), Math.max(16, card.width - 28))
      this.turnEl.style.setProperty('--br-tip', `${Math.round(tip)}px`)
    }

    /** Opens or closes the ⓘ popover. It lies over the page area, so the surfaces freeze while it is open (the person opened it). */
    private togglePop(open = this.popEl.hidden): void {
      if (open === !this.popEl.hidden) return
      this.popEl.hidden = !open
      this.infoBtn.setAttribute('aria-expanded', String(open))
      if (!open) {
        this.popOff?.(); this.popOff = undefined
        this.popHold?.dispose(); this.popHold = undefined
        return
      }
      const r = this.infoBtn.getBoundingClientRect()
      const host = this.element.getBoundingClientRect()
      this.popEl.style.left = `${Math.max(4, r.left - host.left)}px`
      this.popEl.style.top = `${r.bottom - host.top + 4}px`
      this.popHold = ui.surfaces.freezeWhile('browser-tab-info')
      const down = (ev: PointerEvent): void => { if (!this.popEl.contains(ev.target as Node) && !this.infoBtn.contains(ev.target as Node)) this.togglePop(false) }
      const key = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { this.togglePop(false); this.infoBtn.focus() } }
      document.addEventListener('pointerdown', down, true)
      document.addEventListener('keydown', key, true)
      this.popOff = () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true) }
    }

    private paint(): void {
      this.paintControl()
      const s = this.saved
      const url = this.info?.url ?? s?.url ?? ''
      this.urlEl.textContent = displayUrl(url)
      this.urlEl.title = url.length <= 2048 && !/^data:/i.test(url) ? url : ''
      const crash = this.info?.crashed
      this.crashEl.hidden = !crash
      this.crashText.textContent = crash === 'suspect' ? CRASH_PAUSED : crash === 'browser' ? CRASH_BROWSER : crash === 'unresponsive' ? CRASH_HUNG : crash ? CRASH_GONE : ''
      const state = crash ? 'crashed' : this.info ? (this.info.loading ? 'loading' : 'live') : s?.url ? 'not-loaded' : 'no-address'
      this.element.dataset.state = state
      this.stateEl.textContent = state === 'loading' ? LOADING : state === 'not-loaded' ? NOT_LOADED : state === 'no-address' ? CRED_NOT_KEPT : ''
      this.spinner.hidden = state !== 'loading'
      this.paintFacts()
      paintTabs()
      refreshPad()
    }

    /** History and reload answer only while the person holds the tab (U16). */
    private paintNav(on: boolean): void {
      this.backBtn.disabled = !(on && this.info?.canGoBack)
      this.fwdBtn.disabled = !(on && this.info?.canGoForward)
      this.reloadBtn.disabled = !on
    }

    /** The facts behind the ⓘ, and its dot while any of them applies. */
    paintFacts(): void {
      const facts = tabFacts({
        cookies: this.info?.cookies ?? 0, persistentLogins, debug: debugOn(ui.settings), addressLost: this.element.dataset.state === 'no-address',
      })
      for (const [id, li] of this.popFacts) li.hidden = !facts.includes(id)
      this.popNone.hidden = facts.length > 0
      this.infoBtn.dataset.flag = facts.length > 0 ? 'true' : 'false'
    }

    repaintOwner(): void { this.paintControl() }

    /** What the pad knows of this tab. */
    padTab(): PadTab | undefined {
      const s = this.saved
      if (!s) return undefined
      const v = controls.get(s.tabId)
      return {
        tabId: s.tabId, ownerSlotId: s.ownerSlotId, title: this.info?.title || s.title, url: this.info?.url ?? s.url ?? '',
        control: isPersonOwned(s.ownerSlotId) ? 'user' : this.info ? (v?.control ?? 'agent') : v?.paused ? 'paused' : 'agent', asking: !!v?.ask, expired: !!v?.askExpired && v.holder === 'user',
        ...(ui.panes.describe(this.paneId)?.place !== undefined ? { place: ui.panes.describe(this.paneId)!.place! } : {}),
      }
    }

    favicon(): string | undefined { return this.info?.favicon }

    /** Main has the tab (a pane back from layout.json has none until it is shown). */
    loaded(): boolean { return !!this.info }

    /** What the tab's dot says: the page loads, the agent just acted, or nothing. */
    activity(): 'loading' | 'agent' | 'idle' {
      if (this.info?.loading) return 'loading'
      return Date.now() - this.actedAt < ACTIVE_MS ? 'agent' : 'idle'
    }

    acted(): void {
      this.actedAt = Date.now()
      this.paintLive()
      paintTabs()
      setTimeout(() => { paintTabs(); this.paintLive() }, ACTIVE_MS + 50)
    }

    /** The pill's live dot follows the agent's last command without redrawing the rest of the bar. */
    private paintLive(): void { this.ownerLive.hidden = !this.view().owner.live }

    /** The letterbox: what main reports of the fitted page (the bands are the page area's own background). */
    letterbox(): { host: { width: number; height: number }; effective: { x: number; y: number; width: number; height: number } | undefined; scale: number; visibility: string } | undefined {
      const st = this.binding?.state()
      if (!st) return undefined
      const r = this.page.getBoundingClientRect()
      return { host: { width: r.width, height: r.height }, effective: st.effective, scale: st.scale, visibility: st.visibility }
    }

    /** A pane back from layout.json loads when it is on screen (the person showed it). */
    private queueCheck(): void {
      if (this.checkQueued || this.info || this.restoring) return
      this.checkQueued = true
      setTimeout(() => {
        this.checkQueued = false
        if (this.info || this.restoring || !this.saved?.url || panels.get(this.paneId) !== this) return
        if (!hostVisible(factsOf(this.page))) return
        this.restoring = true
        void ipc.invoke('restore', this.saved).then(info => { if (info && panels.get(this.paneId) === this) this.bind(info) }).finally(() => { this.restoring = false })
      }, 0)
    }

    closed(): void { this.binding?.dispose(); this.binding = undefined; clearTimeout(this.ignoredTimer); this.togglePop(false) }

    dispose(): void {
      this.togglePop(false)
      this.actionBar.dispose()
      this.binding?.dispose()
      this.ro?.disconnect()
      this.dockRo.disconnect()
      for (const s of this.subs) s.dispose()
      if (panels.get(this.paneId) === this) { panels.delete(this.paneId); refreshPad() }
      // The person closed the pane (a move re-creates it at once under the same id): closing the pane closes the tab.
      // A pane back from layout.json and never loaded closes too: its saved address goes with it, for the closed history.
      const tabId = this.info?.tabId ?? this.saved?.tabId
      const saved = this.saved
      const paneId = this.paneId
      if (tabId) setTimeout(() => { if (!unloading && !ui.panes.find(paneId)) void ipc.invoke('close', tabId, 'user', saved) }, 0)
    }
  }

  /** The tab of a pane (the shared tab header): favicon, title, the owner's emblem and a dot while the page loads or the agent acts. */
  const tabs = new Set<Tab>()
  class Tab implements ITabRenderer {
    private readonly iconEl = el('img', 'br-web-tab-icon')
    private readonly globe = icon('globe-simple', 'br-web-tab-globe')
    private readonly chip = el('span', 'br-web-tab-owner')
    private readonly dot = el('span', 'br-web-tab-dot')
    private readonly header = createTabHeader({
      className: 'br-web-tab', kindChildren: [this.iconEl, this.globe], textClass: 'br-web-tab-title',
      emblems: [this.chip], dot: this.dot,
      close: { label: 'Fechar guia', onClose: () => {
        const tabId = panels.get(this.paneId)?.saved?.tabId
        if (tabId) void runTabAction('close', tabId)
        else ui.panes.close(this.paneId)
      } },
      onMenu: ev => showWebMenu(this.paneId, ev.clientX, ev.clientY),
    })
    readonly element = this.header.element
    private readonly titleEl = this.header.text
    private sub: IDisposable | undefined
    paneId = ''
    init(p: GroupPanelPartInitParameters & { api: { title?: string } }): void {
      this.paneId = p.api.id
      this.element.dataset.slot = p.api.id
      this.iconEl.alt = ''
      this.iconEl.hidden = true
      this.dot.hidden = true
      this.dot.dataset.role = 'activity'
      this.chip.dataset.role = 'tab-owner'
      this.titleEl.textContent = p.api.title ?? 'Guia'
      const owner = (p.params as { ownerSlotId?: string } | undefined)?.ownerSlotId
      if (owner) this.element.dataset.owner = owner
      this.sub = p.api.onDidTitleChange(e => { this.titleEl.textContent = e.title })
      tabs.add(this)
      this.paint()
    }
    /** From the pane's state: the icon, the owner's chip, and the activity (loading; the agent acting). */
    paint(): void {
      const panel = panels.get(this.paneId)
      const owner = panel?.saved?.ownerSlotId ?? this.element.dataset.owner
      dressTabOwner(this.chip, owner, owner ? agentOf(owner) : undefined)
      const favicon = panel?.favicon()
      if (favicon) { if (this.iconEl.src !== favicon) this.iconEl.src = favicon } else this.iconEl.removeAttribute('src')
      this.iconEl.hidden = !favicon
      this.globe.style.display = favicon ? 'none' : ''
      const a = panel?.activity() ?? 'idle'
      this.dot.hidden = a === 'idle'
      this.element.dataset.activity = a
      this.dot.title = a === 'loading' ? LOADING : a === 'agent' ? 'O agente está agindo' : ''
      const title = panel?.padTab()?.title || this.titleEl.textContent || 'Guia'
      this.element.title = [title, panel?.padTab()?.url ?? '', isPersonOwned(owner) ? PERSON_TITLE : owner ? `Agente: ${agentName(owner)}` : ''].filter(Boolean).join('\n')
    }
    dispose(): void { this.sub?.dispose(); tabs.delete(this) }
  }
  const paintTabs = (): void => { for (const t of tabs) t.paint() }

  /** A new tab: a pane in the Browser desk, behind, next to its owner's tabs (each agent's tabs together, in order of arrival). */
  /** The pane a link's "Abrir ao lado" was clicked in, until the person's tab it asked for is drawn. */
  let sideOrigin: string | undefined
  const openTab = (info: TabInfo): void => {
    const paneId = paneIdOf(info.tabId)
    if (ui.panes.find(paneId)) return
    // "Abrir ao lado" of a link: the person's new tab goes beside the pane the link was clicked in, not to the Browser desk.
    const beside = isPersonOwned(info.ownerSlotId) ? sideOrigin : undefined
    if (beside && ui.panes.find(beside)) {
      sideOrigin = undefined
      ui.panes.open({
        id: paneId, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: info.title || 'Guia', params: { ...savedOf(info) },
      }, { target: { level: 'pane', placement: 'right' } as Target, reference: beside })
      return
    }
    const inDesk = [...panels.keys()].map(id => ui.panes.find(id)).filter((p): p is IDockviewPanel => !!p && ui.panes.describe(p.id)?.place === 'Browser')
    const home = inDesk.find(p => ownerOfPanel(p) === info.ownerSlotId) ?? inDesk[0]
    const group = home?.group.panels
    const where = group && group.length > 0 ? { reference: group[0]!.id, index: insertIndex(group.map(ownerOfPanel), info.ownerSlotId) } : undefined
    ui.systemDesks.addPane(DESK_ID, {
      id: paneId, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: info.title || 'Guia', params: { ...savedOf(info) },
    }, where)
  }

  /**
   * A tab of the person's own (the palette's "Navegador: nova guia", the pad's "+", Ctrl+T in the Browser desk): main opens it,
   * the tab event draws its pane, and here it comes to the front with the address field in focus.
   */
  const newTab = async (url?: string): Promise<string | undefined> => {
    const info = await ipc.invoke('openForPerson', url).catch(() => null)
    sideOrigin = undefined
    if (!info) return undefined
    const paneId = paneIdOf(info.tabId)
    const show = (tries: number): void => {
      const p = panels.get(paneId)
      if (p && p.loaded() && ui.panes.find(paneId)) { ui.panes.reveal(paneId); if (!url) p.startEdit() }
      else if (tries > 0) setTimeout(() => show(tries - 1), 50)
    }
    show(60)
    return info.tabId
  }
  /** The active pane when it is a tab's (Ctrl+L focuses its address). */
  let activeWebPane: string | undefined
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey || ev.repeat) return
    const key = ev.key.toLowerCase()
    if (key === 't' && ui.systemDesks.isActive(DESK_ID)) { ev.preventDefault(); void newTab() }
    else if (key === 'l') {
      const p = activeWebPane ? panels.get(activeWebPane) : undefined
      if (p?.editable()) { ev.preventDefault(); p.startEdit() }
    }
  }
  document.addEventListener('keydown', onKey)

  /** The sticky seals of the tabs whose agent asks for help (the agent's pane and the tab's pane), until handed back. */
  const seals = new Map<string, AttentionHandle[]>()
  const sealText = (v: ControlView, owner: string | undefined): string => {
    let host = ''
    try { const url = panels.get(paneIdOf(v.tabId))?.saved?.url; host = url ? new URL(url).host : '' } catch { /* no address */ }
    return helpLine(agentName(owner), host, v.ask)
  }
  /** When each pending help request was first seen: the pill and the pad's icon lead to the oldest. */
  const askedAt = new Map<string, number>()
  const syncSeals = (v: ControlView): void => {
    if (v.holder === 'user' && (v.ask || v.askExpired)) { if (!askedAt.has(v.tabId)) askedAt.set(v.tabId, Date.now()) } else askedAt.delete(v.tabId)
    const owner = panels.get(paneIdOf(v.tabId))?.saved?.ownerSlotId
    const wanted = v.holder === 'user' && (!!v.ask || !!v.askExpired)
    const have = seals.get(v.tabId)
    if (!wanted) {
      if (have) { for (const h of have) h.resolve(); seals.delete(v.tabId) }
    } else {
      const message = sealText(v, owner)
      if (have) for (const h of have) h.update({ message })
      else {
        const handles: AttentionHandle[] = []
        // The agent's pane may be gone (the agent closed): the tab's own seal and the badges still carry the request.
        const raise = (o: { slotId?: string; paneId?: string }): void => { try { handles.push(ui.attention.raise({ ...o, message, sticky: true })) } catch { /* no such pane */ } }
        if (owner) raise({ slotId: owner })
        if (ui.panes.find(paneIdOf(v.tabId))) raise({ paneId: paneIdOf(v.tabId) })
        for (const h of handles) h.onDidActivate(() => ui.panes.reveal(paneIdOf(v.tabId)))
        seals.set(v.tabId, handles)
      }
    }
    const waiting = [...controls.values()].filter(c => c.holder === 'user' && (c.ask || c.askExpired))
    const inDesk = (c: ControlView): boolean => !!ui.panes.find(paneIdOf(c.tabId)) && ui.panes.describe(paneIdOf(c.tabId))?.place === 'Browser'
    const badge = waiting.length ? { count: pillBadgeCount(waiting.map(c => ({ paneInBrowserDesk: inDesk(c) }))), attention: true, tooltip: sealText(waiting[0]!, panels.get(paneIdOf(waiting[0]!.tabId))?.saved?.ownerSlotId) } : undefined
    ui.systemDesks.setBadge(DESK_ID, badge)
    refreshPad()
  }
  /** Takes the person to the tab that has waited longest for her help; false when no request is pending. */
  const goToOldestAsk = (): boolean => {
    const tabId = oldestAsking([...askedAt].map(([id, at]) => ({ tabId: id, at })))
    if (!tabId || !ui.panes.find(paneIdOf(tabId))) return false
    ui.panes.reveal(paneIdOf(tabId))
    return true
  }
  /**
   * Taking the tab maximizes its pane and handing it back restores the earlier size (design §6.1). Only a take by the person
   * ("Assumir") does it: a help request does not rearrange her screen. Only what we maximized is restored.
   */
  const followMaximize = (v: ControlView): void => {
    const p = panels.get(paneIdOf(v.tabId))
    const panel = p ? ui.panes.find(paneIdOf(v.tabId)) : undefined
    if (!p || !panel) return
    if (v.holder === 'user' && v.why === 'taken') {
      if (!panel.api.isMaximized()) { panel.api.maximize(); p.maximizedByTake = true }
    } else if (v.holder === 'agent' && p.maximizedByTake) {
      p.maximizedByTake = false
      if (panel.api.isMaximized()) panel.api.exitMaximized()
    }
  }
  const onControl = (v: ControlView): void => {
    controls.set(v.tabId, v)
    panels.get(paneIdOf(v.tabId))?.paintControl()
    followMaximize(v)
    syncSeals(v)
  }
  void ipc.invoke('agents').then(list => {
    for (const a of list) slots.set(a.slotId, a)
    slotsKnown = true
    for (const p of panels.values()) p.repaintOwner()
    paintTabs(); refreshPad()
  }).catch(() => {})
  void ipc.invoke('controls').then(list => { for (const v of list) onControl(v) }).catch(() => {})

  // The questions main puts to the person (the local network, E4; an upload, E13): one dialog at a time, in arrival order. Every
  // one is the core's modal dialog, which freezes the surfaces while it is open (design §2.3).
  interface Question { id: string; situation: string; spec: DialogSpec; answer(choice: string): Promise<unknown> }
  const asks: Question[] = []
  let asking: Question | undefined
  const nextAsk = (): void => {
    if (asking !== undefined) return
    const q = asks.shift()
    if (!q) return
    asking = q
    void ui.dialogs.ask(q.spec).then(a => a.choice, () => 'deny')
      .then(choice => q.answer(choice))
      .catch(() => {})
      .finally(() => { asking = undefined; nextAsk() })
  }
  const enqueueQuestion = (q: Question): void => {
    if (q.id === asking?.id || asks.some(a => a.id === q.id)) return
    asks.push(q)
    nextAsk()
  }
  const enqueue = (ask: LocalNetworkAsk): void => enqueueQuestion({
    id: ask.id, situation: LOCAL_NETWORK_SITUATION, spec: localNetworkDialog(ask), answer: choice => ipc.invoke('localNetworkAnswer', ask.id, choice),
  })
  const enqueueUpload = (ask: UploadAsk): void => enqueueQuestion({
    id: ask.id, situation: UPLOAD_SITUATION, spec: uploadDialog(ask), answer: choice => ipc.invoke('uploadAnswer', ask.id, choice),
  })
  const withdraw = (id: string): void => {
    const i = asks.findIndex(a => a.id === id)
    if (i >= 0) { asks.splice(i, 1); return }
    // On screen: the dialog's own Esc path (a refusal; main already settled it and ignores the answer).
    if (id === asking?.id) document.querySelector(`dialog[data-dialog="${asking.situation}"]`)?.dispatchEvent(new Event('cancel', { cancelable: true }))
  }
  void ipc.invoke('localNetworkOpen').then(list => { for (const a of list) enqueue(a) }).catch(() => {})
  void ipc.invoke('uploadOpen').then(list => { for (const a of list) enqueueUpload(a) }).catch(() => {})
  // F3: her pages' dialogs, each in its pane's band (a queue of their own, apart from the agents' questions above).
  const onPageDialog = (ask: PageDialogAsk): void => {
    pageDialogs.set(ask.tabId, ask)
    panels.get(paneIdOf(ask.tabId))?.paintPageDialog()
  }
  const onPageDialogClosed = (id: string): void => {
    for (const [tabId, a] of pageDialogs) {
      if (a.id !== id) continue
      pageDialogs.delete(tabId)
      panels.get(paneIdOf(tabId))?.paintPageDialog()
    }
  }
  void ipc.invoke('pageDialogOpen').then(list => { for (const a of list) onPageDialog(a) }).catch(() => {})
  void ipc.invoke('downloads').then(list => { downloadsList = list; refreshPad() }).catch(() => {})
  void ipc.invoke('closedList').then(list => { closedList = list; refreshPad() }).catch(() => {})

  void ipc.invoke('status').then(s => { persistentLogins = s.persistentLogins; for (const p of pads) p.redraw(); for (const p of panels.values()) p.paintFacts() })
  ui.test.expose('browserPanes', () => [...panels].map(([id, p]) => {
    const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => p.element.querySelector<T>(sel)
    const owner = q('.br-web-owner')
    const notes = [...p.element.querySelectorAll<HTMLElement>('.br-web-note')].map(n => ({
      kind: n.dataset.kind ?? '', text: n.querySelector('.br-web-note-text')?.textContent ?? '', action: n.querySelector('.br-web-note-act')?.textContent ?? '',
    }))
    const turn = q('.br-web-turn')
    const fact = (id: TabFactId): HTMLElement | null => q(`.br-web-pop-fact[data-fact="${id}"]`)
    return {
    id, tabId: p.saved?.tabId, owner: p.saved?.ownerSlotId, state: p.element.dataset.state,
    title: p.padTab()?.title ?? '', url: q('.br-web-url')?.textContent ?? '',
    stateText: q('.br-web-state')?.textContent ?? '',
    // The owner pill: its tone and phrase ("‹Agente› usando", "Com você · pedido do ‹agente›", "Pausada"...).
    control: p.element.dataset.control ?? '', controlText: owner?.hidden ? '' : q('.br-web-owner-text')?.textContent ?? '', tone: owner?.dataset.tone ?? '',
    // The bar's highlighted action, and every action shown on the bar.
    action: q('.br-web-actions .ab-highlight')?.dataset.label ?? '',
    actions: [...p.element.querySelectorAll<HTMLButtonElement>('.br-web-actions .ab-act[data-label]')].map(b => ({ pin: b.dataset.pin ?? '', label: b.dataset.label ?? '' })),
    notices: notes,
    notice: notes[0]?.text ?? '', noticeKind: notes[0]?.kind ?? '', noticeAction: notes[0]?.action ?? '',
    attention: p.element.dataset.attn === 'true',
    // The open request's card, also while collapsed (then hidden: `collapsed` says so); the pill's toggle text.
    ownerToggle: (q('.br-web-owner-toggle')?.hidden ? '' : q('.br-web-owner-toggle')?.textContent) ?? '',
    ask: turn && turn.childElementCount > 0 ? {
      title: turn.querySelector('.br-web-turn-title')?.textContent ?? '', message: turn.querySelector('.br-web-turn-msg')?.textContent ?? '',
      collapsed: turn.dataset.collapsed === 'true', buttons: [...turn.querySelectorAll<HTMLButtonElement>('.br-web-turn-btn')].map(b => b.textContent ?? ''),
    } : null,
    group: ui.panes.find(id)?.group.panels.map(x => x.id) ?? [], front: ui.panes.find(id)?.group.activePanel?.id === id,
    place: ui.panes.describe(id)?.place,
    // E9: the bar and the tab
    chip: owner?.dataset.chip ?? '',
    ownerEnded: owner?.dataset.ended === 'true',
    ownerHue: owner?.style.getPropertyValue('--br-hue') ?? '',
    address: q('.br-web-url')?.textContent ?? '',
    nav: Object.fromEntries([...p.element.querySelectorAll<HTMLButtonElement>('.br-web-nav')].map(b => [b.dataset.nav, !b.disabled])),
    loadingShown: q('.br-web-spin')?.hidden === false,
    // The ⓘ's facts (shown in its popover) and its dot.
    infoFlag: q('.br-web-info')?.dataset.flag === 'true',
    cookiesShown: fact('cookies')?.hidden === false,
    memoryShown: fact('memory')?.hidden === false,
    memoryText: fact('memory')?.querySelector('.br-web-pop-head')?.textContent ?? '',
    debugShown: fact('debug')?.hidden === false,
    tab: tabInfoOf(id),
    maximized: ui.panes.find(id)?.api.isMaximized() ?? false,
    letterbox: p.letterbox(),
    // The person's own tab, the person mark on the pill, and the address field.
    own: p.own(),
    person: owner?.dataset.person === 'true',
    addressField: p.addressField(),
  }
  }))
  /** The person's "Nova guia", as the palette runs it: the new tab's id. */
  ui.test.expose('browserNewTab', (url?: string) => newTab(url))
  /** The pane's tab strip element as the person sees it. */
  const tabInfoOf = (paneId: string): { title: string; owner: string; ownerHue: string; ownerEnded: boolean; icon: boolean; activity: string } | undefined => {
    const t = [...tabs].find(x => x.element.isConnected && x.paneId === paneId)
    if (!t) return undefined
    const chip = t.element.querySelector('.br-web-tab-owner') as HTMLElement
    return {
      title: t.element.querySelector('.br-web-tab-title')?.textContent ?? '', owner: chip.dataset.label ?? '', ownerHue: chip.style.getPropertyValue('--br-hue'),
      ownerEnded: chip.dataset.ended === 'true', icon: (t.element.querySelector('.br-web-tab-icon') as HTMLElement | null)?.hidden === false,
      activity: t.element.dataset.activity ?? '',
    }
  }
  ui.test.expose('browserReveal', (id: string) => { ui.panes.reveal(id) })
  /** F3: the band of a tab's page dialog as she sees it, and her answer to it. */
  ui.test.expose('browserPageDialog', (tabId: string) => panels.get(paneIdOf(tabId))?.pageDialog() ?? null)
  ui.test.expose('browserPageDialogAnswer', (tabId: string, accept: boolean, text?: string) => panels.get(paneIdOf(tabId))?.answerPageDialog(accept, text) ?? false)
  /**
   * Clicks a control of a tab's pane the way the person would: 'bar' (the bar's highlighted action), 'notice' (the first notice's
   * action), 'done' / 'decline' / 'toggle' (the card), 'owner', 'info', or a history button.
   */
  ui.test.expose('browserClick', (tabId: string, where: string) => {
    const p = panels.get(paneIdOf(tabId))
    const sel = where === 'notice' ? '.br-web-note-act'
      : where === 'back' || where === 'forward' || where === 'reload' ? `.br-web-nav[data-nav="${where}"]`
        : where === 'owner' ? '.br-web-owner' : where === 'info' ? '.br-web-info'
          : where === 'done' ? '.br-web-turn [data-action="give-back"]' : where === 'decline' ? '.br-web-turn [data-action="decline"]'
            : where === 'toggle' ? '.br-web-turn-toggle' : '.br-web-actions .ab-highlight'
    p?.element.querySelector<HTMLButtonElement>(sel)?.click()
  })
  /** Opens the note box of a tab's open request ("Escrever ao ‹agente›") and types the person's note. */
  ui.test.expose('browserAskNote', (tabId: string, text: string) => {
    const root = panels.get(paneIdOf(tabId))?.element
    root?.querySelector<HTMLButtonElement>('.br-web-turn-write')?.click()
    const note = root?.querySelector<HTMLTextAreaElement>('.br-web-turn-note')
    if (note) note.value = text
    return !!note
  })
  ui.test.expose('browserPad', () => {
    const pad = [...pads].find(p => p.element.isConnected)
    if (!pad) return undefined
    const text = (e: Element | null | undefined): string => e?.textContent ?? ''
    const rowOf = (r: Element) => ({
      tabId: (r as HTMLElement).dataset.tab ?? '', title: text(r.querySelector('.br-pad-title')), address: text(r.querySelector('.br-pad-addr')),
      control: (r as HTMLElement).dataset.control ?? '', state: text(r.querySelector('[data-role="state"]')), place: text(r.querySelector('[data-role="place"]')),
      actions: [...r.querySelectorAll<HTMLButtonElement>('.br-pad-foot .ab-act[data-label]')].map(b => ({ pin: b.dataset.pin ?? '', label: b.dataset.label ?? '' })),
    })
    const groupOf = (g: HTMLElement) => ({
      slotId: g.dataset.agent ?? '', ended: g.dataset.ended === 'true', chip: text(g.querySelector('.br-pad-agent')), count: text(g.querySelector('[data-role="count"]')),
      actions: [...g.querySelectorAll<HTMLButtonElement>('.br-pad-ghead .ab-act[data-label]')].map(b => ({ pin: b.dataset.pin ?? '', label: b.dataset.label ?? '' })),
      rows: [...g.querySelectorAll('.br-pad-row')].map(rowOf),
    })
    const section = (id: string) => pad.element.querySelector<HTMLElement>(`[data-section="${id}"]`)
    return {
      state: (pad.element.firstElementChild as HTMLElement | null)?.dataset.state ?? '',
      emptyText: text(pad.element.querySelector('.br-empty-help')),
      offShown: !!pad.element.querySelector('[data-role="off"]'),
      filter: text(pad.element.querySelector('[data-role="filter"]')),
      noneOfAgent: !!pad.element.querySelector('.br-pad-list > .br-empty-help'),
      mine: [...pad.element.querySelectorAll('[data-section="mine"] .br-pad-row')].map(rowOf),
      mineHead: text(section('mine')?.querySelector('.br-pad-head')),
      withPerson: [...pad.element.querySelectorAll('[data-section="user"] .br-pad-row')].map(rowOf),
      withPersonHead: text(section('user')?.querySelector('.br-pad-head')),
      sections: [...pad.element.querySelectorAll<HTMLElement>('.br-pad-section')].map(s => s.dataset.section ?? ''),
      activeHead: text(section('active')?.querySelector('.br-pad-head')),
      endedHead: text(section('ended')?.querySelector('.br-pad-head')),
      endedActions: [...(section('ended')?.querySelectorAll<HTMLButtonElement>('.br-pad-sechead .ab-act[data-label]') ?? [])].map(b => ({ pin: b.dataset.pin ?? '', label: b.dataset.label ?? '' })),
      groups: [...pad.element.querySelectorAll<HTMLElement>('.br-pad-group')].map(groupOf),
      buttonsInContent: [...pad.element.querySelectorAll<HTMLButtonElement>('button.br-pad-btn')].map(b => b.dataset.action ?? ''),
      badge: lastBadge ?? null,
      downloads: [...pad.element.querySelectorAll<HTMLElement>('[data-section="downloads"] .br-pad-dgroup')].map(g => ({
        slotId: g.dataset.agent ?? '', agent: text(g.querySelector('.br-pad-dagent')),
        files: [...g.querySelectorAll<HTMLElement>('.br-pad-drow')].map(r => ({ name: r.dataset.name ?? '', meta: text(r.querySelector('.br-pad-addr')) })),
      })),
    }
  })
  /** Clicks "Mostrar na pasta" on a downloaded file of the pad, the way the person would. */
  ui.test.expose('browserShowDownload', (name: string) => {
    const pad = [...pads].find(p => p.element.isConnected)
    const row = [...(pad?.element.querySelectorAll<HTMLElement>('.br-pad-drow') ?? [])].find(r => r.dataset.name === name)
    row?.querySelector<HTMLButtonElement>('[data-action="show-in-folder"]')?.click()
    return !!row
  })
  ui.test.expose('browserPadOpen', () => { ui.pads.open(PAD_ID) })
  ui.test.expose('browserSeals', () => [...seals].map(([tabId, hs]) => ({ tabId, count: hs.length })))

  return [
    ui.profiles.registerOption({ key: PROFILE_OPTION, label: PROFILE_OPTION_LABEL, hint: PROFILE_OPTION_HINT }),
    ui.pads.register({ id: PAD_ID, create: host => new Pad(host) }),
    ui.panes.register({
      id: 'web', idPrefix: WEB_PANE_PREFIX, component: WEB_COMPONENT, tabComponent: WEB_TAB, hasSlot: false, icon: 'globe-simple',
      optionsOf: p => ({ id: p.id, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: p.title ?? 'Guia', params: p.params ?? {} }),
      create: () => new Panel(), createTab: () => new Tab() as unknown as ITabRenderer, has: id => panels.has(id),
      tabMenu: showWebMenu,
      searchTextOf: id => panels.get(id)?.padTab()?.url || undefined,
    }),
    ui.links.provideBrowser({
      open: (url, opts) => {
        sideOrigin = opts.side ? opts.originPane : undefined
        void newTab(url)
      },
    }),
    ipc.on('tab', info => {
      const p = panels.get(paneIdOf(info.tabId))
      if (p) p.bind(info)
      else openTab(info)
    }),
    ipc.on('localNetworkAsk', enqueue),
    ipc.on('control', onControl),
    ipc.on('activity', (tabId, kind) => {
      panels.get(paneIdOf(tabId))?.acted()
      actions.set(tabId, { kind, at: Date.now() })
      refreshPad()
      setTimeout(refreshPad, PAD_ACTION_FRESH_MS + 100)
    }),
    // A move re-creates the pane (init above), but the desk a pane is in also changes with the desk coming and going.
    ui.panes.onDidChangeActive(info => { activeWebPane = info && panels.has(info.id) ? info.id : undefined; refreshPad() }),
    ui.commands.registerCommand(NEW_TAB_COMMAND_ID, () => { void newTab() }),
    { dispose: () => document.removeEventListener('keydown', onKey) },
    ui.systemDesks.onDidChangeActive(e => { if (e.id === DESK_ID && e.active) goToOldestAsk(); refreshPad() }),
    ui.agents.tabMenu(slotId => {
      if (!padTabs().some(t => t.ownerSlotId === slotId)) return []
      return [{ icon: 'globe-simple', label: padSeeAgent(agentName(slotId)), run: () => seeAgent(slotId) }]
    }),
    // The agent's name or life changed (it exited): every chip is dressed again.
    ipc.on('agent', a => { slots.set(a.slotId, a); for (const p of panels.values()) p.repaintOwner(); paintTabs(); refreshPad() }),
    ui.agents.onDidChange(() => { for (const p of panels.values()) p.repaintOwner(); paintTabs(); refreshPad() }),
    ui.settings.onChange('debug', () => { for (const p of panels.values()) p.paintFacts() }),
    ipc.on('localNetworkCancelled', withdraw),
    ipc.on('uploadAsk', enqueueUpload),
    ipc.on('uploadCancelled', withdraw),
    ipc.on('pageDialog', onPageDialog),
    ipc.on('pageDialogClosed', onPageDialogClosed),
    // Ctrl+T / Ctrl+L typed in a page she holds: main kept them from the page and put the keyboard back on the interface.
    ipc.on('pageKey', (tabId, key) => {
      if (key === 'new-tab') { void newTab(); return }
      panels.get(paneIdOf(tabId))?.startEdit()
    }),
    ipc.on('downloads', list => { downloadsList = list; refreshPad() }),
    ipc.on('closedHistory', list => { closedList = list; refreshPad() }),
    ipc.on('closed', tabId => {
      const id = paneIdOf(tabId)
      controls.delete(tabId)
      actions.delete(tabId)
      syncSeals({ tabId, control: 'agent', holder: 'agent', paused: false })
      panels.get(id)?.closed()
      if (ui.panes.find(id)) ui.panes.close(id)
    }),
  ]
}
