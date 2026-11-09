// The browser extension's Electron-main side (E2): the tabs' session (session.ts) and the tab registry (tabs.ts), served to
// the renderer over the extension's channels (ipc.ts). The gatekeeper, which creates tabs at an agent's request, is a later
// slice; until then only the E2E creates tabs, through `globalThis.__browserTabs` in a build with the test extensions.
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { BrowserChannels } from './ipc.ts'
import { cookieEncryptionInForce, createTabSession, type TabSession } from './session.ts'
import { savedTabOf } from './tab-rules.ts'
import { TabRegistry } from './tabs.ts'

export { manifest } from './manifest.ts'

// Defined by app/build.mjs: true only in a build made with TETHER_TEST_EXTENSIONS=1 (the E2E).
declare const __TETHER_TEST_EXTENSIONS__: boolean | undefined

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<BrowserChannels>()
  let made: TabSession | undefined
  // The session waits for the fuse to be read (rule 19), once; the first tab waits for it.
  const session = cookieEncryptionInForce().then(on => (made = createTabSession(on, msg => main.log(msg))))
  const registry = new TabRegistry(main, session, {
    changed: info => ipc.send('tab', info),
    closed: tabId => ipc.send('closed', tabId),
  })
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
    { dispose: () => { registry.dispose(); made?.dispose() } },
  ]
  if (typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__) {
    const g = globalThis as { __browserTabs?: unknown }
    g.__browserTabs = {
      registry,
      session: () => session,
      create: (owner: string, url: string) => registry.create(owner, url),
      eval: (tabId: string, code: string) => registry.webContents(tabId)?.executeJavaScript(code, true),
    }
    subs.push({ dispose: () => { delete g.__browserTabs } })
  }
  return subs
}
