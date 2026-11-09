// The tab registry (Tether Browser E2, design §2.1, §4.1, §5.2): each tab is a core surface (main.surfaces, a WebContentsView at
// a fixed 1280×800, born hidden) in the tabs' partition, owned by one agent (its daemon slot id). The registry creates, closes
// and lists tabs and tells the renderer what changes (title, address, loading, closed). The page is held in:
//   - a popup never opens a window: a web address becomes a new tab of the same owner, anything else is denied;
//   - `<webview>` is never attached; a navigation to a scheme other than http(s) (or the blank page) is refused;
//   - addresses never go to the log;
//   - E3: the network filter (net-filter.ts) refuses the local network to a public origin. A tab created with `ticket` (the
//     gatekeeper's request, a restored tab the person showed) gets one ticket for its first address; `allowOnce` gives one
//     for a later navigation. A popup gets a ticket only when the frame that opened it and its page are both local (the
//     package's origin gate reads the opener's `Referer` the same way; no referrer, no ticket). Each refusal is a `blocked`
//     event with the reason and the destination's origin.
//   - E4: an agent's request for a LOCAL address (`requestLocalNetwork`, `allowOnce`, `create` with `ticket: true`) goes to the
//     local-network question (local-network.ts) before any ticket; the tab's first load waits for the answer (refused, it
//     loads without a ticket and the filter shows the block). A restored tab the person showed and a popup between local pages
//     get their ticket without asking (`ticket: 'granted'`): neither is the agent's request. A closed tab's questions are
//     withdrawn.
//   - E6: no native surface opens from the page (design §3.1): JavaScript dialogs wait for CDP (`-run-dialog` replaced; internal
//     Electron API, so a tab refuses to open on an Electron major it was not proven on), HTTP authentication is cancelled, no
//     client certificate is chosen, `beforeunload` is accepted, the native file chooser is intercepted on the core's own
//     debugger session (an upload goes through the tether's consent, E13), `window.print` does nothing. The tab's first load
//     waits until the chooser and print are held; failing that, the tab is not created.
// When an agent exits its tabs stay (the "encerrado" chip is the interface's); nothing here destroys them.
import { randomUUID } from 'node:crypto'
import type { Event as ElectronEvent, WebContents } from 'electron'
import type { Surface, TetherMain } from '../../app/main/ext-api.ts'
import { type IDisposable, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { AgentInfo } from '../../app/main/agents.ts'
import type { LocalNetworkGate } from './local-network.ts'
import type { BlockedRequest } from './net-filter.ts'
import type { TabSession } from './session.ts'
import { cleanTitle, faviconPlan, FAVICON_MAX, isId, isNavigable, isWebUrl, makeTab, type SavedTab, storableUrl, type Tab, type TabInfo } from './tab-rules.ts'

export const PAGE_SIZE = { width: 1280, height: 800 } as const

/**
 * The Electron major the dialog replacement was proven on (test/e2e/app.browser-gate.test.ts: a dialog stays open, with no native
 * box, until `Page.handleJavaScriptDialog`). Another major: tabs refuse to open until the test passes there and this moves.
 */
export const DIALOGS_PROVEN_ELECTRON_MAJOR = 45

/** True when `version` (process.versions.electron) is the major the dialog replacement was proven on. */
export function dialogsProven(version: string | undefined): boolean {
  return Number.parseInt(version ?? '', 10) === DIALOGS_PROVEN_ELECTRON_MAJOR
}

/**
 * `window.print` does nothing (Electron would open the system's print box): every new document of the tab's own process,
 * frames included, and the current one. Not configurable, so the page cannot put the original back.
 */
const NO_PRINT = `(() => { try { Object.defineProperty(window, 'print', { value: function print() {}, writable: false, configurable: false }) } catch {} })()`

interface Entry { tab: Tab; surface: Surface; loading: boolean; favicon?: string; cookies: number }

/** A request of a tab refused by the network filter: never the full address, only the destination's origin. */
export interface TabBlocked {
  tabId: string
  reason: BlockedRequest['reason']
  resourceType: string
  destination: string
}

/** Who follows the tabs besides the renderer (the gatekeeper): a tab added (its surface exists) and a tab closed. */
export interface TabWatcher {
  added(info: TabInfo): void
  closed(tabId: string): void
}

export interface TabEvents {
  changed(info: TabInfo): void
  closed(tabId: string): void
  blocked?(event: TabBlocked): void
}

/** How the local network is asked: the gate, and who an owner slot id is (its name and profile). */
export interface TabLocalNetwork {
  gate: LocalNetworkGate
  agent(slotId: string): AgentInfo | undefined
}

/** A first address's ticket: `true` is the agent's request (asked when local), `'granted'` needs no question. */
export type FirstTicket = boolean | 'granted'

const POPUP_DISPOSITIONS = new Set(['default', 'foreground-tab', 'background-tab', 'new-window'])

export class TabRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<TabInfo>>()
  private readonly main: TetherMain
  private readonly session: Promise<TabSession>
  private readonly events: TabEvents
  private readonly local: TabLocalNetwork
  private readonly watchers = new Set<TabWatcher>()
  /** A popup's tab -> the tab that opened it (the gatekeeper's `openerId`). */
  private readonly openers = new Map<string, string>()
  private disposed = false

  constructor(main: TetherMain, session: Promise<TabSession>, events: TabEvents, local: TabLocalNetwork) {
    this.main = main
    this.session = session
    this.events = events
    this.local = local
    session.then(s => s.onBlocked(b => {
      const tabId = b.webContentsId === undefined ? undefined : this.tabOfPage(b.webContentsId)
      if (tabId !== undefined) this.events.blocked?.({ tabId, reason: b.reason, resourceType: b.resourceType, destination: b.destination })
    })).catch(() => {})
  }

  private tabOfPage(webContentsId: number): string | undefined {
    for (const [tabId, e] of this.entries) if (!e.surface.webContents.isDestroyed() && e.surface.webContents.id === webContentsId) return tabId
    return undefined
  }

  /**
   * One ticket for the tab's next main-frame navigation to exactly `url` (one use, a few seconds): what the gatekeeper calls
   * before navigating at an agent's request. A redirect from it to another local destination does not inherit it.
   */
  allowOnce(tabId: string, url: string): Promise<boolean> {
    const e = this.entries.get(tabId)
    return e ? this.requestLocalNetwork(tabId, e.tab.ownerSlotId, url) : Promise.resolve(false)
  }

  /**
   * The gatekeeper's `Tether.requestLocalNetwork`: may the agent `ownerSlotId` open `url` in its tab `tabId` once? A public
   * address needs nobody; a local one goes to the setting or the person (pending as long as the person takes, refused when
   * the tab closes). True: the tab holds a ticket for exactly `url` (one use, a few seconds) and the caller navigates now.
   */
  async requestLocalNetwork(tabId: string, ownerSlotId: string, url: string): Promise<boolean> {
    const e = this.entries.get(tabId)
    if (!e || e.tab.ownerSlotId !== ownerSlotId || !isWebUrl(url)) return false
    const wc = e.surface.webContents
    if (wc.isDestroyed()) return false
    const ses = await this.session
    if (ses.net.isLocal(url)) {
      const info = this.local.agent(ownerSlotId)
      const agent = { name: info?.name ?? 'o agente', ...(info?.profile ? { profile: info.profile } : {}) }
      const ok = await this.local.gate.request({ tabId, url, agent })
      if (!ok || wc.isDestroyed() || this.entries.get(tabId) !== e) return false
    }
    return ses.net.allowOnce(wc.id, url)
  }

  /** One ticket for `url` without asking: the gatekeeper's, only after the person allowed it through `Tether.requestLocalNetwork`. */
  async grantLocal(tabId: string, url: string): Promise<boolean> {
    const e = this.entries.get(tabId)
    if (!e || e.surface.webContents.isDestroyed() || !isWebUrl(url)) return false
    return (await this.session).net.allowOnce(e.surface.webContents.id, url)
  }

  watch(w: TabWatcher): IDisposable {
    this.watchers.add(w)
    return toDisposable(() => { this.watchers.delete(w) })
  }

  list(): TabInfo[] { return [...this.entries.values()].map(infoOf) }
  get(tabId: string): TabInfo | undefined { const e = this.entries.get(tabId); return e ? infoOf(e) : undefined }
  /** The tab's page (test hooks and, later, the gatekeeper). */
  webContents(tabId: string): WebContents | undefined { return this.entries.get(tabId)?.surface.webContents }
  /** The tab that opened `tabId` (a popup), while it is still open. */
  opener(tabId: string): string | undefined { const o = this.openers.get(tabId); return o !== undefined && this.entries.has(o) ? o : undefined }
  /** The tab's surface (its debugger is the gatekeeper's way in). */
  surface(tabId: string): Surface | undefined { return this.entries.get(tabId)?.surface }

  /** A new tab for `owner` opening `url` (http/https, or the blank page the gatekeeper's `Target.createTarget` asks for), hidden; `tabId` keeps a saved tab's id. Same id twice: the same tab. */
  create(owner: string, url: string, opts: { tabId?: string; title?: string; ticket?: FirstTicket; openerTabId?: string } = {}): Promise<TabInfo> {
    if (this.disposed) return Promise.reject(new Error('guia: extensão desligada'))
    if (!isId(owner)) return Promise.reject(new Error('guia: dono inválido'))
    if (!dialogsProven(process.versions.electron)) return Promise.reject(new Error('guia: diálogos não provados nesta versão do Electron'))
    if (!isNavigable(url)) return Promise.reject(new Error('guia: só endereços http e https'))
    if (opts.tabId !== undefined && !isId(opts.tabId)) return Promise.reject(new Error('guia: id inválido'))
    const tabId = opts.tabId ?? randomUUID()
    if (opts.openerTabId !== undefined) this.openers.set(tabId, opts.openerTabId)
    const known = this.entries.get(tabId)
    if (known) return Promise.resolve(infoOf(known))
    const inFlight = this.pending.get(tabId)
    if (inFlight) return inFlight
    const p = this.open(tabId, owner, url, opts.title, opts.ticket ?? false).finally(() => this.pending.delete(tabId))
    this.pending.set(tabId, p)
    return p
  }

  /** A tab saved in layout.json, created again with its id and owner; undefined when its address was not kept. */
  async restore(saved: SavedTab): Promise<TabInfo | undefined> {
    if (!storableUrl(saved.url)) return undefined
    // The person showed the pane: its saved address opens once, even on the local network.
    return this.create(saved.ownerSlotId, saved.url, { tabId: saved.tabId, title: saved.title, ticket: 'granted' })
  }

  /** The person's history buttons (the interface offers them while she holds the tab; main checks it too). */
  navigate(tabId: string, how: 'back' | 'forward' | 'reload'): void {
    const wc = this.webContents(tabId)
    if (!wc || wc.isDestroyed()) return
    if (how === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack() }
    else if (how === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward() }
    else wc.reload()
  }

  close(tabId: string): void {
    this.entries.get(tabId)?.surface.destroy()
  }

  dispose(): void {
    this.disposed = true
    for (const e of [...this.entries.values()]) e.surface.destroy()
  }

  private async open(tabId: string, owner: string, url: string, title: string | undefined, ticket: FirstTicket): Promise<TabInfo> {
    const ses = await this.session
    const surface = await this.main.surfaces.create({ pageSize: { ...PAGE_SIZE }, webPreferences: { partition: ses.partition, backgroundThrottling: false } })
    const tab = makeTab({ tabId, ownerSlotId: owner, surfaceId: surface.id, url, title, createdAt: Date.now() })
    if (!tab || this.disposed) { surface.destroy(); throw new Error('guia: não criada') }
    try {
      await holdNativeSurfaces(surface)
    } catch (e) {
      surface.destroy()
      throw new Error(`guia: superfícies nativas não neutralizadas (${(e as Error).message})`)
    }
    if (this.disposed) { surface.destroy(); throw new Error('guia: não criada') }
    const entry: Entry = { tab, surface, loading: false, cookies: 0 }
    this.entries.set(tabId, entry)
    const subs = this.guard(entry, ses)
    const pageId = surface.webContents.id
    surface.onDidDestroy(() => {
      ses.net.forget(pageId)
      this.local.gate.cancelTab(tabId)
      for (const s of subs) s.dispose()
      if (this.entries.get(tabId) !== entry) return
      this.entries.delete(tabId)
      this.openers.delete(tabId)
      this.events.closed(tabId)
      for (const w of [...this.watchers]) w.closed(tabId)
    })
    this.main.log(`guia ${tabId} criada para ${owner}`)
    this.events.changed(infoOf(entry))
    for (const w of [...this.watchers]) w.added(infoOf(entry))
    // The first load is not awaited: a slow or failing site still gives the tab (its frame shows the state). An agent's local
    // address waits for the question; refused, it loads without a ticket and the filter refuses it.
    const granted = ticket === 'granted' ? Promise.resolve(ses.net.allowOnce(pageId, url))
      : ticket ? this.requestLocalNetwork(tabId, owner, url) : Promise.resolve(false)
    granted.catch(() => false).then(() => { if (!surface.webContents.isDestroyed()) surface.webContents.loadURL(url).catch(() => {}) })
    return infoOf(entry)
  }

  /** The page's limits and the events the renderer follows. */
  private guard(entry: Entry, ses: TabSession): IDisposable[] {
    const wc = entry.surface.webContents
    const { tabId, ownerSlotId } = entry.tab
    ses.prepare(wc)
    // JavaScript dialogs: Electron's default listener of its internal '-run-dialog' event shows a NATIVE box. It is replaced so
    // nothing is shown and the dialog waits for CDP (`Page.handleJavaScriptDialog`, the agent's). Internal Electron API (E6
    // pins it with a test per Electron version).
    // The listener must prevent the default: otherwise Electron answers the dialog at once (cancelled) and CDP sees it close.
    // E6 found the "dialog closed 2 ms after opening" of E5 was the test harness's own Playwright (attached to every page of the
    // app, it dismisses dialogs nobody listens to), not Electron: with this listener the dialog stays open until CDP answers.
    wc.removeAllListeners('-run-dialog' as never)
    wc.on('-run-dialog' as never, (() => { /* held for CDP */ }) as never)
    // beforeunload: accepted (decision E6). Electron shows no box and would keep the page, leaving the agent's navigation or the
    // person's close stuck on a page that asks; the agent sees the navigation go through.
    const onUnload = (e: ElectronEvent): void => { e.preventDefault() }
    wc.on('will-prevent-unload', onUnload)
    // HTTP authentication: no box, the request is cancelled (the page gets its 401). Electron forwards the tab's `login` to
    // the app's `login` from a listener of its own registered first, so the egress proxy's challenge (egress-session.ts) is
    // already answered with the proxy's credential when this runs: answering it again calls Electron's callback a second time,
    // and that froze the whole main process in the E6b probe (what E6 saw as "the next tab's creation hangs"). Only a
    // challenge nobody answered is cancelled here.
    const onLogin = (e: ElectronEvent, _d: unknown, info: { isProxy?: boolean } | undefined, cb: () => void): void => {
      if (info?.isProxy || e.defaultPrevented) return
      e.preventDefault(); cb()
    }
    // Client certificate: none is chosen (Electron's default picks the first one, silently).
    const onCert = (e: ElectronEvent, _u: unknown, _l: unknown, cb: () => void): void => {
      if (e.defaultPrevented) return
      e.preventDefault(); cb()
    }
    wc.on('login', onLogin as never)
    wc.on('select-client-certificate', onCert as never)
    const changed = (): void => this.events.changed(infoOf(entry))
    wc.setWindowOpenHandler(details => {
      if (isWebUrl(details.url) && POPUP_DISPOSITIONS.has(details.disposition)) {
        const opener = details.referrer?.url ?? ''
        const ticket = opener !== '' && ses.net.isLocal(opener) && ses.net.isLocal(wc.getURL())
        this.create(ownerSlotId, details.url, { ticket: ticket ? 'granted' : false, openerTabId: tabId }).catch(e => this.main.log(`guia ${tabId}: popup não virou guia (${(e as Error).message})`))
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
    let faviconFor = ''
    const onUrl = (_e: ElectronEvent, url: string): void => {
      if (!isNavigable(url)) return
      // The icon belongs to the site: another origin drops it until the new page names its own.
      if (entry.favicon && originOf(url) !== originOf(entry.tab.url)) { entry.favicon = undefined; faviconFor = '' }
      entry.tab.url = url
      changed()
    }
    const onInPage = (e: ElectronEvent, url: string, isMainFrame: boolean): void => { if (isMainFrame) onUrl(e, url) }
    const onStart = (): void => { entry.loading = true; changed() }
    const onStop = (): void => { entry.loading = false; changed(); ses.flush(); void countCookies() }
    // E9: the cookie count of the page's address (a sign, never the cookies), and the icon fetched by main.
    const countCookies = async (): Promise<void> => {
      const url = entry.tab.url
      if (!isWebUrl(url) || wc.isDestroyed()) return
      const n = (await wc.session.cookies.get({ url }).catch(() => [])).length
      if (n !== entry.cookies) { entry.cookies = n; changed() }
    }
    const onIcon = (_e: ElectronEvent, icons: string[]): void => {
      const plan = faviconPlan(entry.tab.url, icons)
      if (!plan || plan.url === faviconFor) return
      faviconFor = plan.url
      if (plan.kind === 'data') { entry.favicon = plan.url; changed(); return }
      void wc.session.fetch(plan.url, { credentials: 'omit' }).then(async r => {
        const type = r.headers.get('content-type') ?? ''
        if (!r.ok || !/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)/.test(type)) return
        const body = Buffer.from(await r.arrayBuffer())
        if (body.length === 0 || body.length > FAVICON_MAX || wc.isDestroyed() || faviconFor !== plan.url) return
        entry.favicon = `data:${type.split(';')[0]};base64,${body.toString('base64')}`
        changed()
      }).catch(() => {})
    }
    wc.on('page-favicon-updated', onIcon as never)
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
      wc.off('did-start-loading', onStart); wc.off('did-stop-loading', onStop); wc.off('page-favicon-updated', onIcon as never)
      wc.off('login', onLogin as never); wc.off('select-client-certificate', onCert as never); wc.off('will-prevent-unload', onUnload)
    })]
  }
}

/**
 * The file chooser and `window.print`, held on the core's own (root) debugger session before the tab loads anything: the
 * chooser is intercepted (no native box; the gate does not route root-session events, so nobody sees `fileChooserOpened`
 * unless an agent's own session intercepts it too), print replaced in every new document.
 */
async function holdNativeSurfaces(surface: Surface): Promise<void> {
  const dbg = surface.debugger
  await dbg.send('Page.enable')
  await dbg.send('Page.setInterceptFileChooserDialog', { enabled: true })
  await dbg.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_PRINT, runImmediately: true })
}

const originOf = (url: string): string => { try { return new URL(url).origin } catch { return '' } }

function infoOf(e: Entry): TabInfo {
  const wc = e.surface.webContents
  const live = !wc.isDestroyed()
  return {
    ...e.tab, loading: e.loading,
    canGoBack: live && wc.navigationHistory.canGoBack(), canGoForward: live && wc.navigationHistory.canGoForward(),
    ...(e.favicon ? { favicon: e.favicon } : {}), cookies: e.cookies,
  }
}
