// The tab registry (Tether Browser E2, design §2.1, §4.1, §5.2): each tab is a core surface (main.surfaces, a WebContentsView at
// a fixed 1280×800, born hidden) in the tabs' partition, owned by one agent (its daemon slot id). The registry creates, closes
// and lists tabs and tells the renderer what changes (title, address, loading, closed). The page is held in:
//   - a popup never opens a window: a web address becomes a new tab of the same owner, anything else is denied;
//   - `<webview>` is never attached; a navigation to a scheme other than http(s) (or the blank page) is refused;
//   - addresses never go to the log.
// When an agent exits its tabs stay (the "encerrado" chip is the interface's); nothing here destroys them.
import { randomUUID } from 'node:crypto'
import type { Event as ElectronEvent, WebContents } from 'electron'
import type { Surface, TetherMain } from '../../app/main/ext-api.ts'
import { type IDisposable, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TabSession } from './session.ts'
import { cleanTitle, isId, isNavigable, isWebUrl, makeTab, type SavedTab, storableUrl, type Tab, type TabInfo } from './tab-rules.ts'

export const PAGE_SIZE = { width: 1280, height: 800 } as const

interface Entry { tab: Tab; surface: Surface; loading: boolean }

export interface TabEvents {
  changed(info: TabInfo): void
  closed(tabId: string): void
}

const POPUP_DISPOSITIONS = new Set(['default', 'foreground-tab', 'background-tab', 'new-window'])

export class TabRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<TabInfo>>()
  private readonly main: TetherMain
  private readonly session: Promise<TabSession>
  private readonly events: TabEvents
  private disposed = false

  constructor(main: TetherMain, session: Promise<TabSession>, events: TabEvents) {
    this.main = main
    this.session = session
    this.events = events
  }

  list(): TabInfo[] { return [...this.entries.values()].map(infoOf) }
  get(tabId: string): TabInfo | undefined { const e = this.entries.get(tabId); return e ? infoOf(e) : undefined }
  /** The tab's page (test hooks and, later, the gatekeeper). */
  webContents(tabId: string): WebContents | undefined { return this.entries.get(tabId)?.surface.webContents }

  /** A new tab for `owner` opening `url` (http/https only), hidden; `tabId` keeps a saved tab's id. Same id twice: the same tab. */
  create(owner: string, url: string, opts: { tabId?: string; title?: string } = {}): Promise<TabInfo> {
    if (this.disposed) return Promise.reject(new Error('guia: extensão desligada'))
    if (!isId(owner)) return Promise.reject(new Error('guia: dono inválido'))
    if (!isWebUrl(url)) return Promise.reject(new Error('guia: só endereços http e https'))
    if (opts.tabId !== undefined && !isId(opts.tabId)) return Promise.reject(new Error('guia: id inválido'))
    const tabId = opts.tabId ?? randomUUID()
    const known = this.entries.get(tabId)
    if (known) return Promise.resolve(infoOf(known))
    const inFlight = this.pending.get(tabId)
    if (inFlight) return inFlight
    const p = this.open(tabId, owner, url, opts.title).finally(() => this.pending.delete(tabId))
    this.pending.set(tabId, p)
    return p
  }

  /** A tab saved in layout.json, created again with its id and owner; undefined when its address was not kept. */
  async restore(saved: SavedTab): Promise<TabInfo | undefined> {
    if (!storableUrl(saved.url)) return undefined
    return this.create(saved.ownerSlotId, saved.url, { tabId: saved.tabId, title: saved.title })
  }

  close(tabId: string): void {
    this.entries.get(tabId)?.surface.destroy()
  }

  dispose(): void {
    this.disposed = true
    for (const e of [...this.entries.values()]) e.surface.destroy()
  }

  private async open(tabId: string, owner: string, url: string, title: string | undefined): Promise<TabInfo> {
    const ses = await this.session
    const surface = await this.main.surfaces.create({ pageSize: { ...PAGE_SIZE }, webPreferences: { partition: ses.partition, backgroundThrottling: false } })
    const tab = makeTab({ tabId, ownerSlotId: owner, surfaceId: surface.id, url, title, createdAt: Date.now() })
    if (!tab || this.disposed) { surface.destroy(); throw new Error('guia: não criada') }
    const entry: Entry = { tab, surface, loading: false }
    this.entries.set(tabId, entry)
    const subs = this.guard(entry, ses)
    surface.onDidDestroy(() => {
      for (const s of subs) s.dispose()
      if (this.entries.get(tabId) !== entry) return
      this.entries.delete(tabId)
      this.events.closed(tabId)
    })
    this.main.log(`guia ${tabId} criada para ${owner}`)
    this.events.changed(infoOf(entry))
    // The first load is not awaited: a slow or failing site still gives the tab (its frame shows the state).
    surface.webContents.loadURL(url).catch(() => {})
    return infoOf(entry)
  }

  /** The page's limits and the events the renderer follows. */
  private guard(entry: Entry, ses: TabSession): IDisposable[] {
    const wc = entry.surface.webContents
    const { tabId, ownerSlotId } = entry.tab
    ses.prepare(wc)
    const changed = (): void => this.events.changed(infoOf(entry))
    wc.setWindowOpenHandler(details => {
      if (isWebUrl(details.url) && POPUP_DISPOSITIONS.has(details.disposition)) {
        this.create(ownerSlotId, details.url).catch(e => this.main.log(`guia ${tabId}: popup não virou guia (${(e as Error).message})`))
      } else this.main.log(`guia ${tabId}: popup recusado`)
      return { action: 'deny' }
    })
    const refuse = (e: ElectronEvent, url: string): void => {
      if (isNavigable(url)) return
      e.preventDefault()
      this.main.log(`guia ${tabId}: navegação recusada (esquema não permitido)`)
    }
    const onNavigate = (e: ElectronEvent, url: string): void => refuse(e, url)
    const onRedirect = (e: ElectronEvent, url: string, _inPlace: boolean, isMainFrame: boolean): void => { if (isMainFrame) refuse(e, url) }
    const onAttach = (e: ElectronEvent): void => { e.preventDefault(); this.main.log(`guia ${tabId}: webview recusado`) }
    const onTitle = (_e: ElectronEvent, title: string): void => { entry.tab.title = cleanTitle(title); changed() }
    const onUrl = (_e: ElectronEvent, url: string): void => { if (isNavigable(url)) { entry.tab.url = url; changed() } }
    const onInPage = (e: ElectronEvent, url: string, isMainFrame: boolean): void => { if (isMainFrame) onUrl(e, url) }
    const onStart = (): void => { entry.loading = true; changed() }
    const onStop = (): void => { entry.loading = false; changed(); ses.flush() }
    wc.on('will-navigate', onNavigate)
    wc.on('will-redirect', onRedirect)
    wc.on('will-attach-webview', onAttach)
    wc.on('page-title-updated', onTitle)
    wc.on('did-navigate', onUrl)
    wc.on('did-navigate-in-page', onInPage)
    wc.on('did-start-loading', onStart)
    wc.on('did-stop-loading', onStop)
    return [toDisposable(() => {
      if (wc.isDestroyed()) return
      wc.off('will-navigate', onNavigate); wc.off('will-redirect', onRedirect); wc.off('will-attach-webview', onAttach)
      wc.off('page-title-updated', onTitle); wc.off('did-navigate', onUrl); wc.off('did-navigate-in-page', onInPage)
      wc.off('did-start-loading', onStart); wc.off('did-stop-loading', onStop)
    })]
  }
}

function infoOf(e: Entry): TabInfo {
  return { ...e.tab, loading: e.loading }
}
