// The browser extension in tetherd. E8: at every launch of an AI agent the browser can be handed to it (agents.ts: a key of
// its own, an MCP file of its own, one more `--mcp-config`), off by default (`extensions.browser.serveToAgents`, one switch
// for the whole app: profiles carry no extension settings yet). The key dies with the agent's run. The side effects wait for
// `onStarted`: only the tetherd that owns the pipe sweeps what a killed one left (the CLI and Electron main, which activate
// this entry for the doctor checks, never get there).
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeSetting, readExtensionsSettings } from '../../app/shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { findNode } from '../web-bridge/warmup.ts'
import { createBrowserLaunchMiddleware, releaseSlot, sweepStale } from './agents.ts'
import { manifest } from './manifest.ts'

export { manifest } from './manifest.ts'

/** A boolean setting of this extension as the app stores it (settings.json `extensions` object), normalized by the manifest's schema. */
export function browserFlag(api: Pick<TetherDaemon, 'settings'>, key: 'serveToAgents' | 'evaluate'): boolean {
  const schema = manifest.contributes!.settings![key]!
  const values = readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]
  return normalizeSetting(schema, values?.[key]) === true
}

export function activate(api: TetherDaemon): IDisposable[] {
  const middleware = createBrowserLaunchMiddleware({
    home: api.home,
    agent: name => api.agents.get(name),
    serve: () => browserFlag(api, 'serveToAgents'),
    evaluate: () => browserFlag(api, 'evaluate'),
    // Read on use: Electron main bundles this module as CommonJS (import.meta.dirname is undefined there), and never runs it.
    server: resolve(import.meta.dirname ?? '.', 'vendor', 'tether-browser', 'server.mjs'),
    // The system node, like the bridge's MCP shell and tetherd itself; the daemon's own binary (a renamed node) is the last resort.
    node: () => findNode() ?? (existsSync(process.execPath) ? process.execPath : undefined),
    log: msg => api.log(msg),
  })
  return [
    api.onStarted(() => { const n = sweepStale(api.home); if (n) api.log(`${n} arquivo(s) de chave/MCP do navegador de um tetherd anterior removidos`) }),
    api.launch.use(middleware),
    api.onSlot(ev => { if (ev.kind === 'exited' && ev.slot.kind !== 'shell') releaseSlot(api.home, ev.slot.slotId) }),
  ]
}
