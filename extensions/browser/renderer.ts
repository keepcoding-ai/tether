// The browser extension's renderer side (E2): the pad "Guias" (still its empty state, design §5.3) and the `web` pane, the
// frame of one tab: a thin bar with the tab's real title and address (from main, never from the page), its state, and the
// area its surface is tied to (`ui.surfaces.attach`). A new tab enters the Browser desk as a tab behind the others, never
// the active one (§5.2), next to its owner's other tabs. After a restart the panes come back from layout.json without loading
// ("Não carregada desde que o tether reabriu") and load when the person shows them (§7.3); a tab whose address carried a
// credential was saved without it and is not reloaded.
import type { GroupPanelPartInitParameters, IContentRenderer, IDockviewPanel, ITabRenderer } from 'dockview-core'
import type { PadView, SurfaceBinding, TetherUi } from '../../app/renderer/ext-api.ts'
import { icon } from '../../app/renderer/icons.ts'
import { factsOf } from '../../app/renderer/surface-host.ts'
import { hostVisible } from '../../app/shared/surface-panel-rules.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { BrowserChannels } from './ipc.ts'
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
      this.bar.append(this.ownerEl, this.titleEl, this.urlEl, this.stateEl)
      this.element.append(this.bar, this.page)
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
      if (!this.binding) this.binding = ui.surfaces.attach(info.surfaceId, this.page)
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

    private paint(): void {
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

    closed(): void { this.binding?.dispose(); this.binding = undefined }

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

  void ipc.invoke('status').then(s => { persistentLogins = s.persistentLogins; for (const p of pads) p.redraw() })
  ui.test.expose('browserPanes', () => [...panels].map(([id, p]) => ({
    id, tabId: p.saved?.tabId, owner: p.saved?.ownerSlotId, state: p.element.dataset.state,
    title: p.element.querySelector('.br-web-title')?.textContent ?? '', url: p.element.querySelector('.br-web-url')?.textContent ?? '',
    stateText: p.element.querySelector('.br-web-state')?.textContent ?? '',
    group: ui.panes.find(id)?.group.panels.map(x => x.id) ?? [], front: ui.panes.find(id)?.group.activePanel?.id === id,
    place: ui.panes.describe(id)?.place,
  })))
  ui.test.expose('browserReveal', (id: string) => { ui.panes.reveal(id) })

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
    ipc.on('closed', tabId => {
      const id = paneIdOf(tabId)
      panels.get(id)?.closed()
      if (ui.panes.find(id)) ui.panes.close(id)
    }),
  ]
}
