// The browser extension's Electron-main side (E2): the tabs' session (session.ts) and the tab registry (tabs.ts), served to
// the renderer over the extension's channels (ipc.ts). The gatekeeper, which creates tabs at an agent's request, is a later
// slice; until then only the E2E creates tabs, through `globalThis.__browserTabs` in a build with the test extensions.
// E4: the local-network question (local-network.ts) lives here; the gatekeeper's `Tether.requestLocalNetwork` is
// `registry.requestLocalNetwork(tabId, ownerSlotId, url)`.
// E5: the CDP gatekeeper (gate.ts) opens at activation: <home>/browser/endpoint.json and the agents' keys in <home>/browser/keys.
// E7: who has each tab (control.ts): the gate refuses and holds outside 'agent', the shield follows, the clean hand-off lives here.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { ControlHub } from './control.ts'
import { type Gate, startGate } from './gate.ts'
import type { BrowserChannels } from './ipc.ts'
import { LocalNetworkGate } from './local-network.ts'
import { cookieEncryptionInForce, createTabSession, type TabSession } from './session.ts'
import { isWebUrl, savedTabOf } from './tab-rules.ts'
import { type TabBlocked, TabRegistry } from './tabs.ts'

export { manifest } from './manifest.ts'

/** The isolated world the hand-back asks for a password field in (none of the page's scripts live there). */
const PASSWORD_WORLD = 1717

/** Reloads the page and waits until it stopped loading (bounded: a page that never settles does not hold the hand-off). */
function reloadAndWait(wc: WebContents, ms = 10_000): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); wc.off('did-stop-loading', done); resolve() }
    const timer = setTimeout(done, ms)
    wc.once('did-stop-loading', done)
    wc.reload()
  })
}

// Defined by app/build.mjs: true only in a build made with TETHER_TEST_EXTENSIONS=1 (the E2E).
declare const __TETHER_TEST_EXTENSIONS__: boolean | undefined

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<BrowserChannels>()
  let made: TabSession | undefined
  let testBlocked: TabBlocked[] | undefined
  // The session waits for the fuse to be read (rule 19), once; the first tab waits for it.
  const session = cookieEncryptionInForce().then(async on => (made = await createTabSession(on, msg => main.log(msg))))
  const localGate = new LocalNetworkGate({
    dir: join(main.home, 'browser'),
    setting: () => main.settings.get('localNetwork'),
    ask: ask => ipc.send('localNetworkAsk', ask),
    cancelled: id => ipc.send('localNetworkCancelled', id),
    log: msg => main.log(msg),
  })
  const registry = new TabRegistry(main, session, {
    changed: info => ipc.send('tab', info),
    closed: tabId => ipc.send('closed', tabId),
    blocked: event => { ipc.send('blocked', event); testBlocked?.push(event) },
  }, { gate: localGate, agent: slotId => main.agents.get(slotId) })
  let gate: Gate | undefined
  let gateDisposed = false
  const testing = typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__
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
      await reloadAndWait(wc)
      await surface.reapplyEmulation().catch(() => {})
      main.log(`guia ${tabId}: entrega limpa`)
    },
    beforeGiveBack: async tabId => {
      const surface = registry.surface(tabId)
      const wc = surface?.webContents
      if (!surface || !wc || wc.isDestroyed()) return
      // Rule 16: what the person left typed in a page that did not navigate, the agent would read. Asked in a world of its own.
      const field = await wc.executeJavaScriptInIsolatedWorld(PASSWORD_WORLD, [{ code: `!!document.querySelector('input[type=password]')` }]).catch(() => false)
      if (field !== true) return
      await reloadAndWait(wc)
      await surface.reapplyEmulation().catch(() => {})
      main.log(`guia ${tabId}: recarregada ao devolver (campo de senha)`)
    },
    log: msg => main.log(msg),
  })
  const shieldOf = (tabId: string): void => {
    void registry.surface(tabId)?.setInputShield(control.control(tabId) === 'agent').catch(() => {})
  }
  const controlSubs: IDisposable[] = [
    registry.watch({
      added: info => { control.added(info.tabId, registry.opener(info.tabId)); shieldOf(info.tabId) },
      closed: tabId => control.closed(tabId),
    }),
    control.onChange(v => { shieldOf(v.tabId); ipc.send('control', v) }),
    main.agents.onDidExit(e => control.agentExited(e.slotId)),
  ]
  // E9: the agent's commands light the tab's dot; at most one event per tab every 400 ms.
  const lastPulse = new Map<string, number>()
  const pulse = (tabId: string): void => {
    const now = Date.now()
    if (now - (lastPulse.get(tabId) ?? 0) < 400) return
    lastPulse.set(tabId, now)
    ipc.send('activity', tabId)
  }
  const tabsOf = (slotId?: string): string[] => registry.list().filter(t => slotId === undefined || t.ownerSlotId === slotId).map(t => t.tabId)
  const gateReady = startGate({ home: main.home, tabs: registry, control, activity: pulse, log: msg => main.log(msg), ...(trace ? { trace } : {}) }).then(g => {
    if (gateDisposed) g.dispose()
    else gate = g
    return g
  }, e => { main.log(`porteiro não abriu (${(e as Error).message})`); return undefined })
  // An agent that exits keeps its tabs: only its open help requests are dismissed; the interface marks them "encerrado".
  const subs: IDisposable[] = [
    ipc.handle('list', () => registry.list()),
    ipc.handle('get', tabId => (typeof tabId === 'string' ? registry.get(tabId) ?? null : null)),
    ipc.handle('restore', async raw => {
      const saved = savedTabOf(raw)
      return saved ? (await registry.restore(saved)) ?? null : null
    }),
    ipc.handle('close', tabId => { if (typeof tabId === 'string') registry.close(tabId) }),
    ipc.handle('status', async () => ({ persistentLogins: (await session).persistentLogins })),
    ipc.handle('localNetworkOpen', () => localGate.open()),
    ipc.handle('localNetworkAnswer', (id, choice) => { if (typeof id === 'string') localGate.answer(id, choice) }),
    ipc.handle('controls', () => control.views()),
    ipc.handle('take', tabId => { if (typeof tabId === 'string' && registry.get(tabId)) control.take(tabId) }),
    ipc.handle('giveBack', async tabId => { if (typeof tabId === 'string' && registry.get(tabId)) await control.giveBack(tabId) }),
    ipc.handle('cleanReload', async tabId => { if (typeof tabId === 'string' && registry.get(tabId)) await control.cleanReload(tabId) }),
    ipc.handle('back', tabId => { if (typeof tabId === 'string' && control.control(tabId) === 'user') registry.navigate(tabId, 'back') }),
    ipc.handle('forward', tabId => { if (typeof tabId === 'string' && control.control(tabId) === 'user') registry.navigate(tabId, 'forward') }),
    ipc.handle('reload', tabId => { if (typeof tabId === 'string' && control.control(tabId) === 'user') registry.navigate(tabId, 'reload') }),
    ipc.handle('pause', tabId => { if (typeof tabId === 'string' && registry.get(tabId)) control.pause(tabId) }),
    ipc.handle('resume', tabId => { if (typeof tabId === 'string' && registry.get(tabId)) control.resume(tabId) }),
    ipc.handle('pauseAll', () => control.pauseMany(tabsOf())),
    ipc.handle('resumeAll', () => control.resumeMany(tabsOf())),
    ipc.handle('pauseAgent', slotId => { if (typeof slotId === 'string') control.pauseMany(tabsOf(slotId)) }),
    ipc.handle('resumeAgent', slotId => { if (typeof slotId === 'string') control.resumeMany(tabsOf(slotId)) }),
    ...controlSubs,
    { dispose: () => { gateDisposed = true; gate?.dispose(); control.dispose(); localGate.dispose(); registry.dispose(); made?.dispose() } },
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
      shield: (tabId: string) => registry.surface(tabId)?.state().shield,
      /** The person's typing on the tab's page (what reaches the page when she holds it). */
      type: (tabId: string, text: string) => {
        const wc = registry.webContents(tabId)
        if (!wc) return
        wc.focus()
        for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch })
      },
    }
    subs.push({ dispose: () => { delete g.__browserTabs } })
  }
  return subs
}
