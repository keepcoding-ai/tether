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
// E11: the pad "Guias" (pad-rules.ts): every tab by agent, the ones with the person on top, a click goes to where the tab is (its
// desk), the controls (pause / resume / close, all or one agent's, the ended agents'), the number on the icon, and "Ver guias do
// ‹agente›" in the agent pane's tab menu.
import type { GroupPanelPartInitParameters, IContentRenderer, IDockviewPanel, ITabRenderer } from 'dockview-core'
import type { AttentionHandle, PadView, SurfaceBinding, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import { createTabHeader } from '../../app/renderer/tab-header.ts'
import { factsOf } from '../../app/renderer/surface-host.ts'
import { hostVisible } from '../../app/shared/surface-panel-rules.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ControlView } from './control.ts'
import { controlTexts, helpLine } from './control-rules.ts'
import type { BrowserChannels } from './ipc.ts'
import { LOCAL_NETWORK_SITUATION, localNetworkDialog, type LocalNetworkAsk } from './local-network-rules.ts'
import {
  type DownloadEntry, downloadGroups, formatBytes, PAD_DOWNLOADS, PAD_SHOW_IN_FOLDER, UPLOAD_SITUATION, type UploadAsk, uploadDialog, whenText,
} from './files-rules.ts'
import type { DialogSpec } from '../../app/shared/dialog.ts'
import {
  ACTION_FRESH_MS as PAD_ACTION_FRESH_MS, type ActionKind, buildPad, endedTabIds, hostOf, isEnded, type LastAction, lastActionText,
  PAD_NONE_OF_AGENT, PAD_SHOW_ALL, PAD_WITH_YOU, type PadAgentInfo, padBadge, padCloseAgent, padCloseEnded, padFiltered, type PadModel, padResumeAgent,
  logoutDialog, PAD_LOGOUT_ALL, type MainAgentView, oldestAsking, padSeeAgent, pillBadgeCount, type PadTab, padWhere, resolveAgent, shortAddress,
} from './pad-rules.ts'
import { DESK_ID, PAD_ID, WEB_COMPONENT, WEB_PANE_PREFIX, WEB_TAB, manifest } from './manifest.ts'
import { BACK, BAR_LOGINS_NOT_KEPT, COOKIES_HERE, COOKIES_HERE_SHORT, CRASH_BROWSER, CRASH_GONE, CRASH_HUNG, CRED_NOT_KEPT, displayUrl, EMPTY_HELP, EMPTY_TITLE, FORWARD, LOADING, LOGINS_NOT_KEPT, NOT_LOADED, OFF_ACTION, offHelpFor, ownerChip, ownerHue, POPUPS_REFUSED, PROFILE_ACTION, PROFILE_OPTION, PROFILE_OPTION_HINT, PROFILE_OPTION_LABEL, READ_ONLY_ADDRESS, RELOAD, REOPEN, serveModeOf, shortName, type ServeMode } from './rules.ts'
import { insertIndex, savedOf, savedTabOf, type SavedTab, type TabInfo } from './tab-rules.ts'

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
  chip.style.setProperty('--br-hue', String(slotId ? ownerHue(slotId) : 0))
  chip.title = agent ? (c.ended ? c.text : `Agente: ${agent.name}`) : ''
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
  const tip = agent ? (c.ended ? c.text : `Agente: ${agent.name}`) : label
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
  const agentOf = (slotId: string): PadAgentInfo | undefined => {
    const pane = ui.agents.get(slotId)
    return resolveAgent(pane ? { name: pane.name, alive: pane.alive } : undefined, slots.get(slotId), slotsKnown)
  }
  /** Who has each tab (main's views, kept as they come). */
  const controls = new Map<string, ControlView>()
  let persistentLogins = true

  /** The pad's empty state; the off line and its button only while the browser is off for the profile. */
  const drawEmpty = (root: HTMLElement): void => {
    const box = el('div', 'br-empty')
    const art = el('div', 'br-empty-art')
    art.append(icon('globe-simple'))
    box.dataset.state = 'empty'
    box.append(art, el('h3', 'br-empty-title', EMPTY_TITLE), el('p', 'br-empty-help', EMPTY_HELP))
    const mode = serveMode()
    const offHelp = offHelpFor(mode)
    if (offHelp) {
      const off = el('p', 'br-empty-off', offHelp)
      off.dataset.role = 'off'
      off.dataset.mode = mode
      const go = el('button', 'br-empty-go', OFF_ACTION)
      go.type = 'button'
      go.dataset.action = 'open-settings'
      go.addEventListener('click', () => { void ui.commands.run('settings.show') })
      box.append(off, go)
      if (mode === 'perProfile') {
        const profiles = el('button', 'br-empty-go', PROFILE_ACTION)
        profiles.type = 'button'
        profiles.dataset.action = 'open-profiles'
        profiles.addEventListener('click', () => { void ui.commands.run('profiles.manage') })
        box.append(profiles)
      }
    }
    if (!persistentLogins) {
      const mem = el('p', 'br-empty-off', LOGINS_NOT_KEPT)
      mem.dataset.role = 'logins-not-kept'
      box.append(mem)
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
  /** Closes tabs: the live ones in main, and every pane (one back from layout.json has no tab in main yet). */
  const closeTabs = (tabIds: readonly string[]): void => {
    for (const id of tabIds) {
      void ipc.invoke('close', id)
      if (ui.panes.find(paneIdOf(id))) ui.panes.close(paneIdOf(id))
    }
  }

  const btn = (text: string, action: string, onClick: () => void, disabled = false): HTMLButtonElement => {
    const b = el('button', 'br-pad-btn', text)
    b.type = 'button'
    b.dataset.action = action
    b.disabled = disabled
    b.addEventListener('click', () => onClick())
    return b
  }

  /** "Sair de todas as contas" (design §12a): asks first; the answer clears every login of every agent. */
  const confirmLogout = async (): Promise<void> => {
    const a = await ui.dialogs.ask(logoutDialog()).catch(() => undefined)
    if (a?.choice === 'logout') await ipc.invoke('logoutAll').catch(() => {})
  }

  const drawList = (root: HTMLElement, all: PadModel, model: PadModel): void => {
    const now = Date.now()
    const list = el('div', 'br-pad-list')
    list.dataset.state = 'list'
    const all$ = padTabs()
    const ended = endedTabIds(all$, agentInfo)
    const t = controlTexts('')
    // the controls over every tab
    const bar = el('div', 'br-pad-bar')
    bar.dataset.role = 'controls'
    bar.append(
      btn(t.pauseAll, 'pause-all', () => { void ipc.invoke('pauseTabs', all$.map(x => x.tabId)) }, all.total === 0 || all.paused === all.total),
      btn(t.resumeAll, 'resume-all', () => { void ipc.invoke('resumeTabs', all$.map(x => x.tabId)) }, all.paused === 0),
    )
    if (ended.length > 0) bar.append(btn(padCloseEnded(ended.length), 'close-ended', () => closeTabs(ended)))
    bar.append(btn(PAD_LOGOUT_ALL, 'logout-all', () => { void confirmLogout() }))
    list.append(bar)
    if (padFilter !== undefined) {
      const f = el('div', 'br-pad-filter')
      f.dataset.role = 'filter'
      f.append(el('span', 'br-pad-filter-text', padFiltered(agentName(padFilter))), btn(PAD_SHOW_ALL, 'show-all', () => { padFilter = undefined; refreshPad() }))
      list.append(f)
      if (model.total === 0) list.append(el('p', 'br-empty-help', PAD_NONE_OF_AGENT))
    }

    const row = (tab: PadTab): HTMLElement => {
      const owner = agentInfo(tab.ownerSlotId)
      const name = shortName(owner?.name)
      const control = controls.get(tab.tabId)?.control ?? tab.control
      const ct = controlTexts(name)
      const r = el('div', 'br-pad-row')
      r.dataset.tab = tab.tabId
      r.dataset.control = control
      const open = el('button', 'br-pad-open')
      open.type = 'button'
      open.dataset.action = 'open-tab'
      const title = el('span', 'br-pad-title', tab.title || shortAddress(tab.url) || 'Guia')
      const addr = el('span', 'br-pad-addr', shortAddress(tab.url))
      const who = el('span', 'br-pad-who', isEnded(owner) && control === 'agent' ? ct.ended : ct[control])
      who.dataset.role = 'control'
      const action = el('span', 'br-pad-action', lastActionText({ control, asking: tab.asking, expired: tab.expired, ended: isEnded(owner), name, url: tab.url, ...(actions.get(tab.tabId) ? { action: actions.get(tab.tabId)! } : {}), now }))
      action.dataset.role = 'action'
      const meta = el('span', 'br-pad-meta')
      meta.append(who, action)
      open.append(title, addr, meta)
      if (tab.place && tab.place !== 'Browser') {
        const where = el('span', 'br-pad-place', padWhere(tab.place))
        where.dataset.role = 'place'
        open.append(where)
      }
      open.addEventListener('click', () => ui.panes.reveal(paneIdOf(tab.tabId)))
      r.append(open)
      return r
    }

    if (model.withPerson.length > 0) {
      const sec = el('section', 'br-pad-section')
      sec.dataset.section = 'user'
      const head = el('h4', 'br-pad-head', `${PAD_WITH_YOU} (${model.withPerson.length})`)
      sec.append(head, ...model.withPerson.map(row))
      list.append(sec)
    }
    for (const g of model.groups) {
      const sec = el('section', 'br-pad-section')
      sec.dataset.section = 'agent'
      sec.dataset.agent = g.slotId
      sec.dataset.ended = g.ended ? 'true' : 'false'
      const head = el('div', 'br-pad-ghead')
      const chip = el('button', 'br-web-owner br-pad-agent')
      chip.type = 'button'
      chip.dataset.action = 'focus-agent'
      dressChip(chip, g.slotId, agentInfo(g.slotId) ?? { name: g.name, alive: false })
      if (!chip.textContent) chip.textContent = g.name
      chip.addEventListener('click', () => { ui.agents.focus(g.slotId) })
      const count = el('span', 'br-pad-count', String(g.total))
      count.dataset.role = 'count'
      head.append(chip, count)
      const acts = el('div', 'br-pad-acts')
      const allPaused = g.paused === g.total && g.total > 0
      acts.append(
        allPaused
          ? btn(padResumeAgent(g.name), 'resume-agent', () => { void ipc.invoke('resumeTabs', all$.filter(x => x.ownerSlotId === g.slotId).map(x => x.tabId)) })
          : btn(controlTexts(g.name).pauseAgent, 'pause-agent', () => { void ipc.invoke('pauseTabs', all$.filter(x => x.ownerSlotId === g.slotId).map(x => x.tabId)) }),
        btn(padCloseAgent(g.name), 'close-agent', () => closeTabs(all$.filter(x => x.ownerSlotId === g.slotId).map(x => x.tabId))),
      )
      sec.append(head, acts, ...g.tabs.map(row))
      list.append(sec)
    }
    root.replaceChildren(list)
  }

  // ---- E13: "Baixados" (design §4.3, §12a): by agent, name, size, when, and "Mostrar na pasta" ----
  let downloadsList: DownloadEntry[] = []
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
        r.append(text, btn(PAD_SHOW_IN_FOLDER, 'show-in-folder', () => { void ipc.invoke('showDownload', f.slotId, f.name).catch(() => {}) }))
        group.append(r)
      }
      sec.append(group)
    }
    const host = root.querySelector('.br-pad-list') ?? root
    host.append(sec)
  }
  const drawPad = (root: HTMLElement): void => {
    const all = padModel()
    if (all.total === 0) drawEmpty(root)
    else drawList(root, all, padFilter === undefined ? all : padModel(padFilter))
    drawDownloads(root)
  }
  const pads = new Set<Pad>()
  /** A signature of everything the list writes, so a redraw only follows a real change. */
  const padSignature = (): string => {
    const now = Date.now()
    const tabs = padTabs()
    return JSON.stringify([
      padFilter, serveMode(), persistentLogins, downloadsList.map(d => [d.slotId, d.name, d.bytes, whenText(d.at, now)]),
      tabs.map(t => [t.tabId, t.ownerSlotId, t.title, shortAddress(t.url), t.control, t.asking, t.expired, t.place, agentInfo(t.ownerSlotId), (() => { const a = actions.get(t.tabId); return a && now - a.at <= PAD_ACTION_FRESH_MS ? [a.kind, hostOf(t.url)] : 0 })()]),
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
        for (const p of pads) drawPad(p.element)
      }
    }, 0)
  }
  let drawnSignature = ''
  /** Set while the extension itself opens the pad ("Ver guias do ‹agente›"): that opening is not a click on the icon. */
  let ownOpen = false

  class Pad implements PadView {
    readonly element = el('div', 'br-pad')
    private readonly sub: IDisposable
    constructor() {
      this.element.dataset.pad = PAD_ID
      drawPad(this.element)
      this.sub = ui.settings.onChange('serveToAgents', () => drawPad(this.element))
      pads.add(this)
    }
    redraw(): void { drawPad(this.element) }
    focus(): void {
      // The icon was clicked (or the pad opened from the keyboard) with a help request pending: straight to the tab that asks.
      if (!ownOpen && goToOldestAsk()) return
      this.element.querySelector<HTMLElement>('button')?.focus()
    }
    dispose(): void { this.sub.dispose(); pads.delete(this) }
  }

  /** The live `web` panes by pane id. */
  const panels = new Map<string, Panel>()
  let unloading = false
  window.addEventListener('beforeunload', () => { unloading = true })

  class Panel implements IContentRenderer {
    readonly element = el('div', 'br-web')
    private readonly bar = el('div', 'br-web-bar')
    private readonly titleEl = el('span', 'br-web-title')
    private readonly urlEl = el('span', 'br-web-url')
    private readonly ownerEl = el('button', 'br-web-owner')
    private readonly backBtn = el('button', 'br-web-nav')
    private readonly fwdBtn = el('button', 'br-web-nav')
    private readonly reloadBtn = el('button', 'br-web-nav')
    private readonly spinner = el('span', 'br-web-spin')
    private readonly cookiesEl = el('span', 'br-web-cookies', COOKIES_HERE_SHORT)
    private readonly memoryEl = el('span', 'br-web-memory', BAR_LOGINS_NOT_KEPT)
    private actedAt = 0
    /** Set when this pane was maximized by taking the tab (so handing back restores only what we did). */
    maximizedByTake = false
    private readonly stateEl = el('span', 'br-web-state')
    private readonly ctlEl = el('span', 'br-web-control')
    private readonly actBtn = el('button', 'br-web-act')
    private readonly notice = el('div', 'br-web-notice')
    private readonly noticeText = el('span', 'br-web-notice-text')
    private readonly noticeBtn = el('button', 'br-web-notice-act')
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
      this.actBtn.type = 'button'
      this.noticeBtn.type = 'button'
      this.ctlEl.dataset.role = 'control'
      this.notice.dataset.role = 'notice'
      this.notice.append(this.noticeText, this.noticeBtn)
      for (const [b, name, label, action] of [[this.backBtn, 'arrow-left', BACK, 'back'], [this.fwdBtn, 'arrow-right', FORWARD, 'forward'], [this.reloadBtn, 'arrow-clockwise', RELOAD, 'reload']] as const) {
        b.type = 'button'
        b.dataset.nav = action
        b.title = label
        b.setAttribute('aria-label', label)
        b.append(icon(name))
        b.addEventListener('click', () => { const id = this.info?.tabId; if (id && !b.disabled) void ipc.invoke(action, id) })
      }
      this.ownerEl.type = 'button'
      this.ownerEl.dataset.role = 'owner'
      this.ownerEl.addEventListener('click', () => { const o = this.saved?.ownerSlotId; if (o) ui.agents.focus(o) })
      this.urlEl.dataset.role = 'address'
      this.urlEl.setAttribute('aria-label', READ_ONLY_ADDRESS)
      this.spinner.dataset.role = 'loading'
      this.spinner.hidden = true
      this.cookiesEl.dataset.role = 'cookies'
      this.cookiesEl.title = COOKIES_HERE
      this.cookiesEl.hidden = true
      this.memoryEl.dataset.role = 'memory'
      this.memoryEl.title = LOGINS_NOT_KEPT
      this.memoryEl.hidden = true
      this.bar.append(this.backBtn, this.fwdBtn, this.reloadBtn, this.ownerEl, this.titleEl, this.urlEl, this.spinner, this.cookiesEl, this.memoryEl, this.stateEl, this.ctlEl, this.actBtn)
      this.element.append(this.bar, this.notice, this.page)
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
      const run = (action: string | undefined): void => {
        const tabId = this.info?.tabId ?? this.saved?.tabId
        if (!tabId || !action) return
        if (action === 'take') void ipc.invoke('take', tabId)
        else if (action === 'give-back') void ipc.invoke('giveBack', tabId)
        else if (action === 'resume') void ipc.invoke('resume', tabId)
        else if (action === 'clean-reload') void ipc.invoke('cleanReload', tabId)
      }
      this.actBtn.addEventListener('click', () => run(this.actBtn.dataset.action))
      this.noticeBtn.addEventListener('click', () => run(this.noticeBtn.dataset.action))
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
        // The person's click or key on the shield (the agent has the tab): the bar answers, with the way to take it.
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

    /** The control, its action and the strip under the bar (design §12a). */
    paintControl(): void {
      const tabId = this.info?.tabId ?? this.saved?.tabId
      const v = tabId ? controls.get(tabId) : undefined
      const t = controlTexts(agentName(this.saved?.ownerSlotId))
      // A tab not loaded yet can be paused (E12): its state waits in main and applies when it loads.
      const control = this.info ? (v?.control ?? 'agent') : v?.paused ? 'paused' : undefined
      this.paintNav()
      this.element.dataset.control = control ?? ''
      // E9: with the agent gone, the bar does not say it is using the tab (the chip says "encerrado" too).
      const owner = this.saved ? agentOf(this.saved.ownerSlotId) : undefined
      this.ctlEl.textContent = control === 'agent' && owner && !owner.alive ? t.ended : control ? t[control] : ''
      const act = control === 'agent' ? ['take', t.take] : control === 'user' ? ['give-back', t.giveBack] : control === 'paused' ? ['resume', t.resume] : undefined
      this.actBtn.hidden = !act
      this.actBtn.dataset.action = act?.[0] ?? ''
      this.actBtn.textContent = act?.[1] ?? ''
      let strip: [string, string, string, string] | undefined // kind, text, action, button
      if (v?.ask) strip = ['ask', t.ask(v.ask.message), 'give-back', t.done]
      else if (v?.askExpired && v.holder === 'user') strip = ['expired', t.expired, 'give-back', t.giveBack]
      else if (control === 'agent' && Date.now() < this.ignoredUntil) strip = ['ignored', t.ignored, 'take', t.take]
      else if (v?.holder === 'user' && v.why === 'taken') strip = ['scripts', t.scripts, 'clean-reload', t.cleanReload]
      else if ((this.info?.popupsRefused ?? 0) > 0) strip = ['popups', POPUPS_REFUSED, '', '']
      this.notice.hidden = !strip
      this.noticeBtn.hidden = !strip?.[3]
      this.notice.dataset.kind = strip?.[0] ?? ''
      this.noticeText.textContent = strip?.[1] ?? ''
      this.noticeBtn.dataset.action = strip?.[2] ?? ''
      this.noticeBtn.textContent = strip?.[3] ?? ''
    }

    private paint(): void {
      this.paintControl()
      const s = this.saved
      const title = this.info?.title || s?.title || ''
      const url = this.info?.url ?? s?.url ?? ''
      this.titleEl.textContent = title
      this.urlEl.textContent = displayUrl(url)
      this.urlEl.title = url.length <= 2048 && !/^data:/i.test(url) ? url : ''
      dressChip(this.ownerEl, s?.ownerSlotId, s ? agentOf(s.ownerSlotId) : undefined)
      const crash = this.info?.crashed
      this.crashEl.hidden = !crash
      this.crashText.textContent = crash === 'browser' ? CRASH_BROWSER : crash === 'unresponsive' ? CRASH_HUNG : crash ? CRASH_GONE : ''
      const state = crash ? 'crashed' : this.info ? (this.info.loading ? 'loading' : 'live') : s?.url ? 'not-loaded' : 'no-address'
      this.element.dataset.state = state
      this.stateEl.textContent = state === 'loading' ? LOADING : state === 'not-loaded' ? NOT_LOADED : state === 'no-address' ? CRED_NOT_KEPT : ''
      this.spinner.hidden = state !== 'loading'
      this.cookiesEl.hidden = !(this.info?.cookies && this.info.cookies > 0)
      this.memoryEl.hidden = persistentLogins
      this.paintNav()
      paintTabs()
      refreshPad()
    }

    /** History and reload answer only while the person holds the tab (U16). */
    private paintNav(): void {
      const tabId = this.info?.tabId
      const mine = !!tabId && controls.get(tabId)?.control === 'user'
      this.backBtn.disabled = !(mine && this.info?.canGoBack)
      this.fwdBtn.disabled = !(mine && this.info?.canGoForward)
      this.reloadBtn.disabled = !mine
    }

    /** The owner's chip follows the agent (name, ended). */
    repaintOwner(): void {
      dressChip(this.ownerEl, this.saved?.ownerSlotId, this.saved ? agentOf(this.saved.ownerSlotId) : undefined)
      this.paintControl()
    }

    /** What the pad knows of this tab. */
    padTab(): PadTab | undefined {
      const s = this.saved
      if (!s) return undefined
      const v = controls.get(s.tabId)
      return {
        tabId: s.tabId, ownerSlotId: s.ownerSlotId, title: this.info?.title || s.title, url: this.info?.url ?? s.url ?? '',
        control: this.info ? (v?.control ?? 'agent') : v?.paused ? 'paused' : 'agent', asking: !!v?.ask, expired: !!v?.askExpired && v.holder === 'user',
        ...(ui.panes.describe(this.paneId)?.place !== undefined ? { place: ui.panes.describe(this.paneId)!.place! } : {}),
      }
    }

    favicon(): string | undefined { return this.info?.favicon }

    /** What the tab's dot says: the page loads, the agent just acted, or nothing. */
    activity(): 'loading' | 'agent' | 'idle' {
      if (this.info?.loading) return 'loading'
      return Date.now() - this.actedAt < ACTIVE_MS ? 'agent' : 'idle'
    }

    acted(): void {
      this.actedAt = Date.now()
      paintTabs()
      setTimeout(paintTabs, ACTIVE_MS + 50)
    }

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

    closed(): void { this.binding?.dispose(); this.binding = undefined; clearTimeout(this.ignoredTimer) }

    dispose(): void {
      this.binding?.dispose()
      this.ro?.disconnect()
      for (const s of this.subs) s.dispose()
      if (panels.get(this.paneId) === this) { panels.delete(this.paneId); refreshPad() }
      // The person closed the pane (a move re-creates it at once under the same id): closing the pane closes the tab.
      const tabId = this.info?.tabId
      const paneId = this.paneId
      if (tabId) setTimeout(() => { if (!unloading && !ui.panes.find(paneId)) void ipc.invoke('close', tabId) }, 0)
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
      close: { label: 'Fechar guia', onClose: () => ui.panes.close(this.paneId) },
      onMenu: ev => ui.panes.showTabMenu(this.paneId, ev.clientX, ev.clientY),
    })
    readonly element = this.header.element
    private readonly titleEl = this.header.text
    private sub: IDisposable | undefined
    paneId = ''
    init(p: GroupPanelPartInitParameters & { api: { title?: string } }): void {
      this.paneId = p.api.id
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
    }
    dispose(): void { this.sub?.dispose(); tabs.delete(this) }
  }
  const paintTabs = (): void => { for (const t of tabs) t.paint() }

  /** A new tab: a pane in the Browser desk, behind, next to its owner's tabs (each agent's tabs together, in order of arrival). */
  const openTab = (info: TabInfo): void => {
    const paneId = paneIdOf(info.tabId)
    if (ui.panes.find(paneId)) return
    const inDesk = [...panels.keys()].map(id => ui.panes.find(id)).filter((p): p is IDockviewPanel => !!p && ui.panes.describe(p.id)?.place === 'Browser')
    const home = inDesk.find(p => ownerOfPanel(p) === info.ownerSlotId) ?? inDesk[0]
    const group = home?.group.panels
    const where = group && group.length > 0 ? { reference: group[0]!.id, index: insertIndex(group.map(ownerOfPanel), info.ownerSlotId) } : undefined
    ui.systemDesks.addPane(DESK_ID, {
      id: paneId, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: info.title || 'Guia', params: { ...savedOf(info) },
    }, where)
  }

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
   * ("Assumir o controle") does it: a help request does not rearrange her screen. Only what we maximized is restored.
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
  void ipc.invoke('downloads').then(list => { downloadsList = list; refreshPad() }).catch(() => {})

  void ipc.invoke('status').then(s => { persistentLogins = s.persistentLogins; for (const p of pads) p.redraw() })
  ui.test.expose('browserPanes', () => [...panels].map(([id, p]) => ({
    id, tabId: p.saved?.tabId, owner: p.saved?.ownerSlotId, state: p.element.dataset.state,
    title: p.element.querySelector('.br-web-title')?.textContent ?? '', url: p.element.querySelector('.br-web-url')?.textContent ?? '',
    stateText: p.element.querySelector('.br-web-state')?.textContent ?? '',
    control: p.element.dataset.control ?? '', controlText: p.element.querySelector('.br-web-control')?.textContent ?? '',
    action: (p.element.querySelector('.br-web-act') as HTMLElement | null)?.hidden ? '' : p.element.querySelector('.br-web-act')?.textContent ?? '',
    notice: (p.element.querySelector('.br-web-notice') as HTMLElement | null)?.hidden ? '' : p.element.querySelector('.br-web-notice-text')?.textContent ?? '',
    noticeKind: (p.element.querySelector('.br-web-notice') as HTMLElement | null)?.dataset.kind ?? '',
    noticeAction: p.element.querySelector('.br-web-notice-act')?.textContent ?? '',
    group: ui.panes.find(id)?.group.panels.map(x => x.id) ?? [], front: ui.panes.find(id)?.group.activePanel?.id === id,
    place: ui.panes.describe(id)?.place,
    // E9: the bar and the tab
    chip: p.element.querySelector('.br-web-owner')?.textContent ?? '',
    ownerEnded: (p.element.querySelector('.br-web-owner') as HTMLElement | null)?.dataset.ended === 'true',
    ownerHue: (p.element.querySelector('.br-web-owner') as HTMLElement | null)?.style.getPropertyValue('--br-hue') ?? '',
    address: p.element.querySelector('.br-web-url')?.textContent ?? '',
    nav: Object.fromEntries([...p.element.querySelectorAll<HTMLButtonElement>('.br-web-nav')].map(b => [b.dataset.nav, !b.disabled])),
    loadingShown: (p.element.querySelector('.br-web-spin') as HTMLElement | null)?.hidden === false,
    cookiesShown: (p.element.querySelector('.br-web-cookies') as HTMLElement | null)?.hidden === false,
    memoryShown: (p.element.querySelector('.br-web-memory') as HTMLElement | null)?.hidden === false,
    memoryText: p.element.querySelector('.br-web-memory')?.textContent ?? '',
    tab: tabInfoOf(id),
    maximized: ui.panes.find(id)?.api.isMaximized() ?? false,
    letterbox: p.letterbox(),
  })))
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
  /** Clicks a control button of a tab's pane the way the person would ('bar' or 'notice'). */
  ui.test.expose('browserClick', (tabId: string, where: string) => {
    const p = panels.get(paneIdOf(tabId))
    const sel = where === 'notice' ? '.br-web-notice-act' : where === 'back' || where === 'forward' || where === 'reload' ? `.br-web-nav[data-nav="${where}"]` : where === 'owner' ? '.br-web-owner' : '.br-web-act'
    p?.element.querySelector<HTMLButtonElement>(sel)?.click()
  })
  ui.test.expose('browserPad', () => {
    const pad = [...pads].find(p => p.element.isConnected)
    if (!pad) return undefined
    const text = (e: Element | null | undefined): string => e?.textContent ?? ''
    const rowOf = (r: Element) => ({
      tabId: (r as HTMLElement).dataset.tab ?? '', title: text(r.querySelector('.br-pad-title')), address: text(r.querySelector('.br-pad-addr')),
      control: text(r.querySelector('[data-role="control"]')), action: text(r.querySelector('[data-role="action"]')), place: text(r.querySelector('[data-role="place"]')),
    })
    const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('.br-pad-btn')].map(b => ({ action: b.dataset.action ?? '', text: b.textContent ?? '', disabled: b.disabled }))
    return {
      state: (pad.element.firstElementChild as HTMLElement | null)?.dataset.state ?? '',
      emptyText: text(pad.element.querySelector('.br-empty-help')),
      offShown: !!pad.element.querySelector('[data-role="off"]'),
      controls: buttons(pad.element.querySelector('[data-role="controls"]') ?? document.createElement('div')),
      filter: text(pad.element.querySelector('.br-pad-filter-text')),
      withPerson: [...pad.element.querySelectorAll('[data-section="user"] .br-pad-row')].map(rowOf),
      withPersonHead: text(pad.element.querySelector('[data-section="user"] .br-pad-head')),
      groups: [...pad.element.querySelectorAll<HTMLElement>('[data-section="agent"]')].map(g => ({
        slotId: g.dataset.agent ?? '', ended: g.dataset.ended === 'true', chip: text(g.querySelector('.br-pad-agent')), count: text(g.querySelector('[data-role="count"]')),
        buttons: buttons(g), rows: [...g.querySelectorAll('.br-pad-row')].map(rowOf),
      })),
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
    ui.pads.register({ id: PAD_ID, create: () => new Pad() }),
    ui.panes.register({
      id: 'web', idPrefix: WEB_PANE_PREFIX, component: WEB_COMPONENT, tabComponent: WEB_TAB, hasSlot: false, icon: 'globe-simple',
      optionsOf: p => ({ id: p.id, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: p.title ?? 'Guia', params: p.params ?? {} }),
      create: () => new Panel(), createTab: () => new Tab() as unknown as ITabRenderer, has: id => panels.has(id),
      // The minimum every tab has, so hiding the tabs' × never leaves a tab without a way to close it.
      tabMenu: (id, x, y) => ui.menus.context(x, y, [
        { icon: 'link', label: 'Copiar link do painel', run: () => ui.panes.copyLink(id) },
        { icon: 'arrow-square-out', label: 'Mover…', run: () => ui.panes.move(id) },
        'sep',
        { icon: 'x', label: 'Fechar guia', run: () => ui.panes.close(id) },
      ]),
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
    ui.panes.onDidChangeActive(() => refreshPad()),
    ui.systemDesks.onDidChangeActive(e => { if (e.id === DESK_ID && e.active) goToOldestAsk(); refreshPad() }),
    ui.agents.tabMenu(slotId => {
      if (!padTabs().some(t => t.ownerSlotId === slotId)) return []
      return [{ icon: 'globe-simple', label: padSeeAgent(agentName(slotId)), run: () => { padFilter = slotId; ownOpen = true; setTimeout(() => { ownOpen = false }, 300); ui.pads.open(PAD_ID); refreshPad() } }]
    }),
    // The agent's name or life changed (it exited): every chip is dressed again.
    ipc.on('agent', a => { slots.set(a.slotId, a); for (const p of panels.values()) p.repaintOwner(); paintTabs(); refreshPad() }),
    ui.agents.onDidChange(() => { for (const p of panels.values()) p.repaintOwner(); paintTabs(); refreshPad() }),
    ipc.on('localNetworkCancelled', withdraw),
    ipc.on('uploadAsk', enqueueUpload),
    ipc.on('uploadCancelled', withdraw),
    ipc.on('downloads', list => { downloadsList = list; refreshPad() }),
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
