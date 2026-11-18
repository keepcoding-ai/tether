// The browser extension's Electron-main side (E2): the tabs' session (session.ts) and the tab registry (tabs.ts), served to
// the renderer over the extension's channels (ipc.ts). The gatekeeper, which creates tabs at an agent's request, is a later
// slice; until then only the E2E creates tabs, through `globalThis.__browserTabs` in a build with the test extensions.
// E4: the local-network question (local-network.ts) lives here; the gatekeeper's `Tether.requestLocalNetwork` is
// `registry.requestLocalNetwork(tabId, ownerSlotId, url)`.
// E5: the CDP gatekeeper (gate.ts) opens at activation: <home>/browser/endpoint.json and the agents' keys in <home>/browser/keys.
// E7: who has each tab (control.ts): the gate refuses and holds outside 'agent', the shield follows, the clean hand-off lives here.
// E13: files. Downloads land in the owner agent's folder (downloads.ts), the gate tells the agent, the pad lists them ("Baixados");
// an upload asks the person in the tether's dialog (upload-consent.ts), with the page's picture, and the gate holds the attach to it.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type NativeImage, shell, type WebContents } from 'electron'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { ControlHub, type ControlView } from './control.ts'
import { helpLine } from './control-rules.ts'
import { type Gate, startGate } from './gate.ts'
import { createDebugWriter, DEBUG_KEYS } from './debug-file.ts'
import { DownloadStore } from './downloads.ts'
import { UploadConsent } from './upload-consent.ts'
import { AGENT_TABS_FILE, AgentTabs } from './agent-tabs.ts'
import type { BrowserChannels } from './ipc.ts'
import { LocalNetworkGate } from './local-network.ts'
import { type ActionKind, hostOf } from './pad-rules.ts'
import { cookieEncryptionInForce, createTabSession, type TabSession } from './session.ts'
import { prepareDiskPartition } from './disk-partition.ts'
import { scrubLogLine } from './log-scrub.ts'
import { isId, isWebUrl, savedTabOf } from './tab-rules.ts'
import { type TabBlocked, TabRegistry } from './tabs.ts'

import { activateRemote, wantsBrowserProcess } from './process-host.ts'

export { manifest } from './manifest.ts'

/**
 * Reloads the page and waits until it stopped loading (bounded: a page that never settles does not hold the hand-off). A reload
 * that does not start (the page is a form's answer: Chromium holds a reload that would post again) loads the address afresh.
 * A local page needs a ticket for a reload the browser starts (the filter's rule): `ticket` gives it without asking, since it
 * is the page already open, reloaded by the tether and not at the agent's request.
 */
function reloadAndWait(wc: WebContents, ticket: (url: string) => Promise<unknown>, ms = 10_000): Promise<void> {
  return ticket(wc.getURL()).catch(() => {}).then(() => new Promise<void>(resolve => {
    let started = false
    const onStart = (): void => { started = true }
    const done = (): void => {
      clearTimeout(timer); clearTimeout(nudge)
      wc.off('did-stop-loading', done); wc.off('did-start-loading', onStart)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const nudge = setTimeout(() => { if (!started && !wc.isDestroyed()) wc.loadURL(wc.getURL()).catch(() => {}) }, 1000)
    wc.on('did-start-loading', onStart)
    wc.once('did-stop-loading', done)
    wc.reload()
  }))
}

// Defined by app/build.mjs: true only in a build made with TETHER_TEST_EXTENSIONS=1 (the E2E).
declare const __TETHER_TEST_EXTENSIONS__: boolean | undefined

/**
 * On Windows the browser runs in a process of its own (process-host.ts starts it; process-child.ts runs `activateLocal` there),
 * so nothing a page or the debugger does can take the app. Elsewhere it runs here, in the app's process, as before.
 */
export function activate(main: TetherMain): IDisposable[] {
  return wantsBrowserProcess(main) ? activateRemote(main) : activateLocal(main)
}

export function activateLocal(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<BrowserChannels>()
  // E15: no page address, key or endpoint content reaches the log (log-scrub.ts).
  const log = (msg: string): void => main.log(scrubLogLine(msg))
  let made: TabSession | undefined
  let testBlocked: TabBlocked[] | undefined
  // The session waits for the fuse to be read (rule 19), once; the first tab waits for it.
  // Test builds may ask for the persistent partition on a runtime without the fuse (to look at what reaches the disk).
  const forcePersist = typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__ && process.env.TETHER_TEST_PERSIST_PARTITION === '1'
  const session = cookieEncryptionInForce().then(async fuse => {
    const on = fuse || forcePersist
    prepareDiskPartition({ fuseOn: on, home: main.home, userData: app.getPath('userData'), log })
    return (made = await createTabSession(on, log))
  })
  const localGate = new LocalNetworkGate({
    dir: join(main.home, 'browser'),
    setting: () => main.settings.get('localNetwork'),
    ask: ask => ipc.send('localNetworkAsk', ask),
    cancelled: id => ipc.send('localNetworkCancelled', id),
    log,
  })
  const registry = new TabRegistry(main, session, {
    changed: info => ipc.send('tab', info),
    closed: tabId => ipc.send('closed', tabId),
    blocked: event => { ipc.send('blocked', event); testBlocked?.push(event) },
  }, { gate: localGate, agent: slotId => main.agents.get(slotId) })
  let gate: Gate | undefined
  let gateDisposed = false
  const testing = typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__
  // E13: downloads, by the agent that owns the tab.
  const downloads = new DownloadStore(join(main.home, 'browser'), log)
  void session.then(s => s.onDownload((item, page) => {
    const tabId = registry.tabOfPage(page.id)
    const owner = tabId === undefined ? undefined : registry.get(tabId)?.ownerSlotId
    if (tabId === undefined || owner === undefined) { item.cancel(); log('download recusado (não é de uma guia)'); return }
    downloads.take(item, owner, tabId)
  })).catch(() => {})
  /** Test builds: the files "Mostrar na pasta" would have shown (no window opens in a test). */
  const shownInFolder: string[] = []
  // E13: the upload consent; the page's picture goes in the dialog (design §2.3).
  const uploads = new UploadConsent({
    ask: ask => ipc.send('uploadAsk', ask),
    cancelled: id => ipc.send('uploadCancelled', id),
    log,
  })
  const pagePicture = async (tabId: string): Promise<string | undefined> => {
    const surface = registry.surface(tabId)
    const wc = surface?.webContents
    if (!surface || !wc || wc.isDestroyed()) return undefined
    const shot = (): Promise<NativeImage> => wc.capturePage()
    const timeout = new Promise<undefined>(r => setTimeout(() => r(undefined), 3000))
    const img = await Promise.race([(surface.state().visibility === 'hidden' ? surface.whileDrawing(shot) : shot()).catch(() => undefined), timeout])
    if (!img || img.isEmpty()) return undefined
    return `data:image/jpeg;base64,${img.resize({ width: 480, quality: 'good' }).toJPEG(70).toString('base64')}`
  }
  const confirmUpload = async (req: { tabId: string; slotId: string; path: string; frameOrigin: string }): Promise<boolean> => {
    const wc = registry.webContents(req.tabId)
    let pageOrigin = ''
    try { pageOrigin = new URL(wc?.getURL() ?? '').origin } catch { /* no address */ }
    const image = await pagePicture(req.tabId)
    return uploads.request({ tabId: req.tabId, agent: main.agents.get(req.slotId)?.name || 'agente', path: req.path, frameOrigin: req.frameOrigin, pageOrigin, ...(image ? { image } : {}) })
  }
  const traceFile = testing ? process.env.TETHER_GATE_TRACE : undefined
  const trace = traceFile ? (line: string): void => { try { appendFileSync(traceFile, `${Date.now() % 1_000_000} ${line}
`) } catch { /* test trace only */ } } : undefined
  // E7: who has each tab. The shield is on while the agent has it, off when the person does (rules 10-11).
  const control = new ControlHub({
    ownerOf: tabId => registry.get(tabId)?.ownerSlotId,
    cleanHandoff: async tabId => {
      const removed = (await gateReady)?.cleanTab(tabId)
      await removed
      const surface = registry.surface(tabId)
      const wc = surface?.webContents
      if (!surface || !wc || wc.isDestroyed()) return
      const url = wc.getURL()
      // The service worker survives a reload (it is the origin's, not the document's): it goes first (rule 15).
      if (isWebUrl(url)) await wc.session.clearStorageData({ origin: new URL(url).origin, storages: ['serviceworkers'] })
      await reloadAndWait(wc, url => registry.grantLocal(tabId, url))
      await surface.reapplyEmulation().catch(() => {})
      log(`guia ${tabId}: entrega limpa`)
    },
    beforeGiveBack: async tabId => {
      const surface = registry.surface(tabId)
      const wc = surface?.webContents
      if (!surface || !wc || wc.isDestroyed()) return
      // Rule 16 (H1/M1): what the person left typed and did not send (a 2FA code, a card, a password), the agent would read.
      await reloadAndWait(wc, url => registry.grantLocal(tabId, url))
      await surface.reapplyEmulation().catch(() => {})
      log(`guia ${tabId}: recarregada ao devolver`)
    },
    log,
  })
  // E9: the agent's commands light the tab's dot; at most one event per tab every 400 ms (forgotten when the tab closes).
  const lastPulse = new Map<string, { at: number; kind: ActionKind }>()
  const shieldOf = (tabId: string): void => {
    void registry.surface(tabId)?.setInputShield(control.control(tabId) === 'agent').catch(() => {})
  }
  // E12: a pending help request also reaches the system tray (the same attention the terminals raise), until handed back.
  const notices = new Map<string, { resolve(): void; update(message: string): void }>()
  const syncNotice = (v: ControlView): void => {
    const have = notices.get(v.tabId)
    if (v.holder !== 'user' || (!v.ask && !v.askExpired)) { have?.resolve(); notices.delete(v.tabId); return }
    const info = registry.get(v.tabId)
    const message = helpLine(main.agents.get(info?.ownerSlotId ?? '')?.name || 'agente', hostOf(info?.url ?? ''), v.ask)
    if (have) have.update(message)
    else notices.set(v.tabId, main.notices.raise({ ...(info?.ownerSlotId ? { slotId: info.ownerSlotId } : {}), message }))
  }
  const controlSubs: IDisposable[] = [
    registry.watch({
      added: info => { control.added(info.tabId, registry.opener(info.tabId)); shieldOf(info.tabId) },
      closed: tabId => { uploads.cancelTab(tabId, 'guia fechada'); control.closed(tabId); lastPulse.delete(tabId); notices.get(tabId)?.resolve(); notices.delete(tabId) },
    }),
    control.onChange(v => {
      if (v.control !== 'agent') uploads.cancelTab(v.tabId, v.control === 'paused' ? 'guia pausada' : 'a pessoa assumiu')
      shieldOf(v.tabId); syncNotice(v); ipc.send('control', v)
    }),
    downloads.onEvent(e => {
      gate?.download(e)
      if (e.state === 'completed') ipc.send('downloads', downloads.list())
    }),
    main.agents.onDidExit(e => control.agentExited(e.slotId)),
    main.agents.onDidChange(a => ipc.send('agent', { slotId: a.slotId, name: a.name, alive: a.alive })),
    { dispose: () => { for (const n of notices.values()) n.resolve(); notices.clear() } },
  ]
  const pulse = (tabId: string, kind: ActionKind): void => {
    const now = Date.now()
    const last = lastPulse.get(tabId)
    // A new kind of action goes through at once (the pad says what the agent does now); the same one at most every 400 ms.
    if (last && last.kind === kind && now - last.at < 400) return
    lastPulse.set(tabId, { at: now, kind })
    ipc.send('activity', tabId, kind)
  }
  // What each agent's tool calls its tabs, kept with the tabs (the gate creates `<home>/browser` owner-only before serving).
  const agentTabs = new AgentTabs(join(main.home, 'browser', AGENT_TABS_FILE), log)
  const tabIdsOf = (ids: unknown): string[] => (Array.isArray(ids) ? ids.filter(isId).slice(0, 512) : [])
  const gateReady = startGate({ home: main.home, tabs: registry, control, confirmUpload, agentTabs, activity: pulse, log, ...(trace ? { trace } : {}) }).then(g => {
    if (gateDisposed) g.dispose()
    else gate = g
    return g
  }, e => { log(`porteiro não abriu (${(e as Error).message})`); return undefined })
  // The debug mode (debug-file.ts): <home>/browser/debug.json follows the settings live, from this start on.
  const debugWriter = createDebugWriter({ home: main.home, settings: main.settings, log })
  void debugWriter.sync()
  // An agent that exits keeps its tabs: only its open help requests are dismissed; the interface marks them "encerrado".
  const subs: IDisposable[] = [
    ipc.handle('list', () => registry.list()),
    ipc.handle('get', tabId => (typeof tabId === 'string' ? registry.get(tabId) ?? null : null)),
    ipc.handle('restore', async raw => {
      const saved = savedTabOf(raw)
      return saved ? (await registry.restore(saved)) ?? null : null
    }),
    // The person closed the tab: what the agent's tool knew it by goes with it (a tab that merely went away with the window keeps it).
    ipc.handle('close', tabId => { if (typeof tabId === 'string') { agentTabs.forget(tabId); registry.close(tabId); control.closed(tabId) } }),
    ipc.handle('reopen', async tabId => (isId(tabId) ? (await registry.reopen(tabId).catch(e => { log(`guia ${tabId}: não reabriu (${(e as Error).message})`); return undefined })) ?? null : null)),
    ipc.handle('agents', () => main.agents.list().map(a => ({ slotId: a.slotId, name: a.name, alive: a.alive }))),
    ipc.handle('logoutAll', async () => {
      const ses = await session
      await ses.session.clearStorageData()
      await ses.session.clearAuthCache()
      ses.flush()
      const open = registry.list()
      await Promise.all(open.map(async t => {
        const wc = registry.webContents(t.tabId)
        if (!wc || wc.isDestroyed()) return
        await reloadAndWait(wc, url => registry.grantLocal(t.tabId, url))
        await registry.surface(t.tabId)?.reapplyEmulation().catch(() => {})
      }))
      log(`sair de todas as contas: cookies e armazenamento limpos, ${open.length} ${open.length === 1 ? 'guia recarregada' : 'guias recarregadas'}`)
    }),
    ipc.handle('status', async () => ({ persistentLogins: (await session).persistentLogins })),
    ipc.handle('localNetworkOpen', () => localGate.open()),
    ipc.handle('localNetworkAnswer', (id, choice) => { if (typeof id === 'string') localGate.answer(id, choice) }),
    ipc.handle('controls', () => control.views()),
    ipc.handle('downloads', () => downloads.list()),
    // Opens the system's file browser on the file (selected), never the file itself.
    ipc.handle('showDownload', (slotId, name) => {
      const path = typeof slotId === 'string' && typeof name === 'string' ? downloads.pathOf(slotId, name) : undefined
      if (!path) return
      if (testing) shownInFolder.push(path)
      else shell.showItemInFolder(path)
    }),
    ipc.handle('uploadOpen', () => uploads.open()),
    ipc.handle('uploadAnswer', (id, choice) => { if (typeof id === 'string') uploads.answer(id, choice) }),
    ipc.handle('take', tabId => { if (typeof tabId === 'string' && registry.get(tabId)) control.take(tabId) }),
    ipc.handle('giveBack', async (tabId, note) => { if (typeof tabId === 'string' && registry.get(tabId)) await control.giveBack(tabId, note) }),
    ipc.handle('decline', async (tabId, note) => { if (typeof tabId === 'string' && registry.get(tabId)) await control.decline(tabId, note) }),
    ipc.handle('cleanReload', async tabId => { if (typeof tabId === 'string' && registry.get(tabId)) await control.cleanReload(tabId) }),
    ipc.handle('back', tabId => { if (typeof tabId === 'string' && control.control(tabId) === 'user') void registry.navigate(tabId, 'back') }),
    ipc.handle('forward', tabId => { if (typeof tabId === 'string' && control.control(tabId) === 'user') void registry.navigate(tabId, 'forward') }),
    ipc.handle('reload', tabId => { if (typeof tabId === 'string' && control.control(tabId) === 'user') void registry.navigate(tabId, 'reload') }),
    // E12: a tab restored from layout.json and not loaded yet has no entry in the registry; pausing it keeps the state in the hub,
    // and the tab is born paused when the person shows it.
    ipc.handle('pause', tabId => { if (isId(tabId)) control.pause(tabId) }),
    ipc.handle('resume', tabId => { if (isId(tabId)) control.resume(tabId) }),
    ipc.handle('pauseTabs', ids => control.pauseMany(tabIdsOf(ids))),
    ipc.handle('resumeTabs', ids => control.resumeMany(tabIdsOf(ids))),
    ...controlSubs,
    ...DEBUG_KEYS.map(k => main.settings.onChange(k, () => { void debugWriter.sync() })),
    { dispose: () => { gateDisposed = true; gate?.dispose(); uploads.dispose(); downloads.dispose(); control.dispose(); localGate.dispose(); registry.dispose(); made?.dispose() } },
  ]
  if (typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__) {
    const g = globalThis as { __browserTabs?: unknown }
    g.__browserTabs = {
      registry,
      session: () => session,
      /** The gatekeeper (E5): its port, instance and live connections. */
      gate: async () => { const g = await gateReady; return g ? { port: g.port, instance: g.instance, connections: g.connections() } : null },
      // Stands in for the gatekeeper: the first address gets a ticket unless `ticket` is false.
      create: (owner: string, url: string, ticket = true) => registry.create(owner, url, { ticket }),
      allowOnce: (tabId: string, url: string) => registry.allowOnce(tabId, url),
      requestLocalNetwork: (tabId: string, owner: string, url: string) => registry.requestLocalNetwork(tabId, owner, url),
      /** Crash probes: the tab's renderer killed, or its main thread hung for `ms`. */
      crashRenderer: (tabId: string) => { registry.webContents(tabId)?.forcefullyCrashRenderer() },
      hangRenderer: (tabId: string, ms: number) => { void registry.webContents(tabId)?.executeJavaScript(`{ const t = Date.now() + ${Number(ms) || 0}; while (Date.now() < t) {} }`).catch(() => {}) },
      /** Names the proxy resolves from this map instead of the system (no lookup leaves the machine); unknown names fail. */
      setTestHosts: async (hosts: Record<string, string[]>) => (await session).egress.setTestResolver(async host => {
        if (Object.hasOwn(hosts, host)) return hosts[host]!
        if (host === 'localhost') return ['::1', '127.0.0.1']
        throw new Error('unknown test host')
      }),
      egressBlocked: async () => (await session).egress.blockedCount(),
      setLocalNetwork: (value: string) => main.settings.set('localNetwork', value),
      setPublicStandIns: async (hosts: string[]) => (await session).net.setPublicStandIns(hosts),
      blocked: (testBlocked = []),
      /** A browser-started navigation of the tab (what the gatekeeper does): '' when it loaded, else Chromium's error. */
      load: (tabId: string, url: string) => registry.webContents(tabId)?.loadURL(url).then(() => '', (e: Error) => e.message),
      /** The same through CDP `Page.navigate` on the surface's debugger (the gatekeeper's path). */
      cdpNavigate: async (tabId: string, url: string) => {
        const surface = registry.surface(tabId)
        if (!surface) return 'no tab'
        return ((await surface.debugger.send('Page.navigate', { url })) as { errorText?: string }).errorText ?? ''
      },
      eval: (tabId: string, code: string) => registry.webContents(tabId)?.executeJavaScript(code, true),
      /** E7: who has each tab, and the person's actions. */
      control,
      /** E13: where the downloads land, and what "Mostrar na pasta" would have shown. */
      downloadsDir: () => join(main.home, 'browser', 'downloads'),
      shownInFolder,
      openUploads: () => uploads.open().map(a => ({ ...a, image: a.image ? a.image.slice(0, 32) : undefined })),
      shield: (tabId: string) => registry.surface(tabId)?.state().shield,
      /** The person's typing on the tab's page (what reaches the page when she holds it). */
      type: (tabId: string, text: string) => {
        const wc = registry.webContents(tabId)
        if (!wc) return
        wc.focus()
        for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch })
      },
    }
    // The E2E runs its functions against these hooks through `__browserRun` wherever the browser lives (here, or its process).
    const run = globalThis as { __browserRun?: unknown }
    const evalHook = globalThis as { __browserEval?: unknown }
    if (!process.env.TETHER_BROWSER_PIPE) {
      run.__browserRun = async (src: string, arg: unknown) => (new Function('t', 'a', `return (${src})(t, a)`))(g.__browserTabs, arg)
      evalHook.__browserEval = async (src: string, arg: unknown) => (new Function('a', `return (${src})(undefined, a)`))(arg)
    }
    subs.push({ dispose: () => { delete g.__browserTabs; if (!process.env.TETHER_BROWSER_PIPE) { delete run.__browserRun; delete evalHook.__browserEval } } })
  }
  return subs
}
