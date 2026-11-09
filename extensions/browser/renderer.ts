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
// badge: none goes away by focusing, only when the tab is handed back. Taking does not maximize the pane yet (no core API: E9).
import type { GroupPanelPartInitParameters, IContentRenderer, IDockviewPanel, ITabRenderer } from 'dockview-core'
import type { AttentionHandle, PadView, SurfaceBinding, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import { factsOf } from '../../app/renderer/surface-host.ts'
import { hostVisible } from '../../app/shared/surface-panel-rules.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ControlView } from './control.ts'
import { controlTexts } from './control-rules.ts'
import type { BrowserChannels } from './ipc.ts'
import { LOCAL_NETWORK_SITUATION, localNetworkDialog, type LocalNetworkAsk } from './local-network-rules.ts'
import { DESK_ID, PAD_ID, WEB_COMPONENT, WEB_PANE_PREFIX, WEB_TAB, manifest } from './manifest.ts'
import { CRED_NOT_KEPT, EMPTY_HELP, EMPTY_TITLE, LOADING, LOGINS_NOT_KEPT, NOT_LOADED, OFF_ACTION, OFF_HELP, ownerLabel } from './rules.ts'
import { insertIndex, savedOf, savedTabOf, type SavedTab, type TabInfo } from './tab-rules.ts'

export { manifest }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const paneIdOf = (tabId: string): string => `${WEB_PANE_PREFIX}${tabId}`
const ownerOfPanel = (p: IDockviewPanel): string | undefined => (p.params as { ownerSlotId?: string } | undefined)?.ownerSlotId

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<BrowserChannels>()
  const served = (): boolean => ui.settings.get<boolean>('serveToAgents') === true
  /** The agent's name as the texts use it. */
  const agentName = (slotId: string | undefined): string => (slotId ? ui.agents.get(slotId)?.name : undefined) || 'agente'
  /** Who has each tab (main's views, kept as they come). */
  const controls = new Map<string, ControlView>()
  let persistentLogins = true

  /** The pad's empty state; the off line and its button only while the browser is off for the profile. */
  const drawPad = (root: HTMLElement): void => {
    const box = el('div', 'br-empty')
    const art = el('div', 'br-empty-art')
    art.append(icon('globe-simple'))
    box.dataset.state = 'empty'
    box.append(art, el('h3', 'br-empty-title', EMPTY_TITLE), el('p', 'br-empty-help', EMPTY_HELP))
    if (!served()) {
      const off = el('p', 'br-empty-off', OFF_HELP)
      off.dataset.role = 'off'
      const go = el('button', 'br-empty-go', OFF_ACTION)
      go.type = 'button'
      go.dataset.action = 'open-settings'
      go.addEventListener('click', () => { void ui.commands.run('settings.show') })
      box.append(off, go)
    }
    if (!persistentLogins) {
      const mem = el('p', 'br-empty-off', LOGINS_NOT_KEPT)
      mem.dataset.role = 'logins-not-kept'
      box.append(mem)
    }
    root.replaceChildren(box)
  }
  const pads = new Set<Pad>()

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
    focus(): void { this.element.querySelector<HTMLElement>('button')?.focus() }
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
    private readonly ownerEl = el('span', 'br-web-owner')
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
      this.bar.append(this.ownerEl, this.titleEl, this.urlEl, this.stateEl, this.ctlEl, this.actBtn)
      this.element.append(this.bar, this.notice, this.page)
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
      if (!this.binding) {
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
      const control = this.info ? (v?.control ?? 'agent') : undefined
      this.element.dataset.control = control ?? ''
      this.ctlEl.textContent = control ? t[control] : ''
      const act = control === 'agent' ? ['take', t.take] : control === 'user' ? ['give-back', t.giveBack] : control === 'paused' ? ['resume', t.resume] : undefined
      this.actBtn.hidden = !act
      this.actBtn.dataset.action = act?.[0] ?? ''
      this.actBtn.textContent = act?.[1] ?? ''
      let strip: [string, string, string, string] | undefined // kind, text, action, button
      if (v?.ask) strip = ['ask', t.ask(v.ask.message), 'give-back', t.done]
      else if (v?.askExpired && v.holder === 'user') strip = ['expired', t.expired, 'give-back', t.giveBack]
      else if (control === 'agent' && Date.now() < this.ignoredUntil) strip = ['ignored', t.ignored, 'take', t.take]
      else if (v?.holder === 'user' && v.why === 'taken') strip = ['scripts', t.scripts, 'clean-reload', t.cleanReload]
      this.notice.hidden = !strip
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
      this.urlEl.textContent = url
      this.ownerEl.textContent = s ? ownerLabel(ui.agents.get(s.ownerSlotId), s.ownerSlotId) : ''
      const state = this.info ? (this.info.loading ? 'loading' : 'live') : s?.url ? 'not-loaded' : 'no-address'
      this.element.dataset.state = state
      this.stateEl.textContent = state === 'loading' ? LOADING : state === 'not-loaded' ? NOT_LOADED : state === 'no-address' ? CRED_NOT_KEPT : ''
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
      if (panels.get(this.paneId) === this) panels.delete(this.paneId)
      // The person closed the pane (a move re-creates it at once under the same id): closing the pane closes the tab.
      const tabId = this.info?.tabId
      const paneId = this.paneId
      if (tabId) setTimeout(() => { if (!unloading && !ui.panes.find(paneId)) void ipc.invoke('close', tabId) }, 0)
    }
  }

  class Tab implements ITabRenderer {
    readonly element = el('div', 'br-web-tab')
    private sub: IDisposable | undefined
    init(p: GroupPanelPartInitParameters & { api: { title?: string } }): void {
      this.element.textContent = p.api.title ?? 'Guia'
      const owner = (p.params as { ownerSlotId?: string } | undefined)?.ownerSlotId
      if (owner) this.element.dataset.owner = owner
      this.sub = p.api.onDidTitleChange(e => { this.element.textContent = e.title })
    }
    dispose(): void { this.sub?.dispose() }
  }

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
    const name = agentName(owner)
    if (!v.ask) return controlTexts(name).waiting
    const url = panels.get(paneIdOf(v.tabId))?.saved?.url
    let host = ''
    try { host = url ? new URL(url).host : '' } catch { /* no address */ }
    return host ? `${name} pede ajuda em ${host}: ${v.ask.message}` : `${name} pede ajuda: ${v.ask.message}`
  }
  const syncSeals = (v: ControlView): void => {
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
    const badge = waiting.length ? { count: waiting.length, attention: true, tooltip: sealText(waiting[0]!, panels.get(paneIdOf(waiting[0]!.tabId))?.saved?.ownerSlotId) } : undefined
    ui.pads.setBadge(PAD_ID, badge)
    ui.systemDesks.setBadge(DESK_ID, badge)
  }
  const onControl = (v: ControlView): void => {
    controls.set(v.tabId, v)
    panels.get(paneIdOf(v.tabId))?.paintControl()
    syncSeals(v)
  }
  void ipc.invoke('controls').then(list => { for (const v of list) onControl(v) }).catch(() => {})

  const asks: LocalNetworkAsk[] = []
  let asking: string | undefined
  const nextAsk = (): void => {
    if (asking !== undefined) return
    const ask = asks.shift()
    if (!ask) return
    asking = ask.id
    void ui.dialogs.ask(localNetworkDialog(ask)).then(a => a.choice, () => 'deny')
      .then(choice => ipc.invoke('localNetworkAnswer', ask.id, choice))
      .catch(() => {})
      .finally(() => { asking = undefined; nextAsk() })
  }
  const enqueue = (ask: LocalNetworkAsk): void => {
    if (ask.id === asking || asks.some(a => a.id === ask.id)) return
    asks.push(ask)
    nextAsk()
  }
  const withdraw = (id: string): void => {
    const i = asks.findIndex(a => a.id === id)
    if (i >= 0) { asks.splice(i, 1); return }
    // On screen: the dialog's own Esc path (a refusal; main already settled it and ignores the answer).
    if (id === asking) document.querySelector(`dialog[data-dialog="${LOCAL_NETWORK_SITUATION}"]`)?.dispatchEvent(new Event('cancel', { cancelable: true }))
  }
  void ipc.invoke('localNetworkOpen').then(list => { for (const a of list) enqueue(a) }).catch(() => {})

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
  })))
  ui.test.expose('browserReveal', (id: string) => { ui.panes.reveal(id) })
  /** Clicks a control button of a tab's pane the way the person would ('bar' or 'notice'). */
  ui.test.expose('browserClick', (tabId: string, where: string) => {
    const p = panels.get(paneIdOf(tabId))
    p?.element.querySelector<HTMLButtonElement>(where === 'notice' ? '.br-web-notice-act' : '.br-web-act')?.click()
  })
  ui.test.expose('browserSeals', () => [...seals].map(([tabId, hs]) => ({ tabId, count: hs.length })))

  return [
    ui.pads.register({ id: PAD_ID, create: () => new Pad() }),
    ui.panes.register({
      id: 'web', idPrefix: WEB_PANE_PREFIX, component: WEB_COMPONENT, tabComponent: WEB_TAB, hasSlot: false, icon: 'globe-simple',
      optionsOf: p => ({ id: p.id, component: WEB_COMPONENT, tabComponent: WEB_TAB, title: p.title ?? 'Guia', params: p.params ?? {} }),
      create: () => new Panel(), createTab: () => new Tab() as unknown as ITabRenderer, has: id => panels.has(id),
    }),
    ipc.on('tab', info => {
      const p = panels.get(paneIdOf(info.tabId))
      if (p) p.bind(info)
      else openTab(info)
    }),
    ipc.on('localNetworkAsk', enqueue),
    ipc.on('control', onControl),
    ipc.on('localNetworkCancelled', withdraw),
    ipc.on('closed', tabId => {
      const id = paneIdOf(tabId)
      controls.delete(tabId)
      syncSeals({ tabId, control: 'agent', holder: 'agent', paused: false })
      panels.get(id)?.closed()
      if (ui.panes.find(id)) ui.panes.close(id)
    }),
  ]
}
