// The browser extension's Electron-main side (E2): the tabs' session (session.ts) and the tab registry (tabs.ts), served to
// the renderer over the extension's channels (ipc.ts). The gatekeeper, which creates tabs at an agent's request, is a later
// slice; until then only the E2E creates tabs, through `globalThis.__browserTabs` in a build with the test extensions.
// E4: the local-network question (local-network.ts) lives here; the gatekeeper's `Tether.requestLocalNetwork` is
// `registry.requestLocalNetwork(tabId, ownerSlotId, url)`.
import { join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { BrowserChannels } from './ipc.ts'
import { LocalNetworkGate } from './local-network.ts'
import { cookieEncryptionInForce, createTabSession, type TabSession } from './session.ts'
import { savedTabOf } from './tab-rules.ts'
import { type TabBlocked, TabRegistry } from './tabs.ts'

export { manifest } from './manifest.ts'

// Defined by app/build.mjs: true only in a build made with TETHER_TEST_EXTENSIONS=1 (the E2E).
declare const __TETHER_TEST_EXTENSIONS__: boolean | undefined

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<BrowserChannels>()
  let made: TabSession | undefined
  let testBlocked: TabBlocked[] | undefined
  // The session waits for the fuse to be read (rule 19), once; the first tab waits for it.
  const session = cookieEncryptionInForce().then(async on => (made = await createTabSession(on, msg => main.log(msg))))
  const gate = new LocalNetworkGate({
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
  }, { gate, agent: slotId => main.agents.get(slotId) })
  // An agent that exits keeps its tabs (main.agents.onDidExit is not followed): the interface marks them "encerrado".
  const subs: IDisposable[] = [
    ipc.handle('list', () => registry.list()),
    ipc.handle('get', tabId => (typeof tabId === 'string' ? registry.get(tabId) ?? null : null)),
    ipc.handle('restore', async raw => {
      const saved = savedTabOf(raw)
      return saved ? (await registry.restore(saved)) ?? null : null
    }),
    ipc.handle('close', tabId => { if (typeof tabId === 'string') registry.close(tabId) }),
    ipc.handle('status', async () => ({ persistentLogins: (await session).persistentLogins })),
    ipc.handle('localNetworkOpen', () => gate.open()),
    ipc.handle('localNetworkAnswer', (id, choice) => { if (typeof id === 'string') gate.answer(id, choice) }),
    { dispose: () => { gate.dispose(); registry.dispose(); made?.dispose() } },
  ]
  if (typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__) {
    const g = globalThis as { __browserTabs?: unknown }
    g.__browserTabs = {
      registry,
      session: () => session,
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
    }
    subs.push({ dispose: () => { delete g.__browserTabs } })
  }
  return subs
}
