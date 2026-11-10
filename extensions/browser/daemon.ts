// The browser extension in tetherd. E8: at every launch of an AI agent the browser can be handed to it (agents.ts: a key of
// its own, an MCP file of its own, one more `--mcp-config`), by default only to the agents launched with a profile that
// marks it (`extensions.browser.serveToAgents`: perProfile | all | off; the mark is `profile.extensions.browser.serve`). The key dies with the agent's run. The side effects wait for
// `onStarted`: only the tetherd that owns the pipe sweeps what a killed one left (the CLI and Electron main, which activate
// this entry for the doctor checks, never get there).
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeSetting, readExtensionsSettings } from '../../app/shared/vscode-configuration-registry.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { profileOption } from '../../src/core/profile.ts'
import { findNode } from '../web-bridge/warmup.ts'
import { createBrowserLaunchMiddleware, releaseSlot, sweepStale } from './agents.ts'
import { manifest } from './manifest.ts'
import { scrubLogLine } from './log-scrub.ts'
import { PROFILE_OPTION, serveModeOf, servesAgent, type ServeMode } from './rules.ts'

export { manifest } from './manifest.ts'

/** A boolean setting of this extension as the app stores it (settings.json `extensions` object), normalized by the manifest's schema. */
export function browserFlag(api: Pick<TetherDaemon, 'settings'>, key: 'evaluate'): boolean {
  const schema = manifest.contributes!.settings![key]!
  const values = readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]
  return normalizeSetting(schema, values?.[key]) === true
}

/** `extensions.browser.serveToAgents` as the person set it (the old boolean included: see serveModeOf). */
export function serveMode(api: Pick<TetherDaemon, 'settings'>): ServeMode {
  return serveModeOf(readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]?.serveToAgents)
}

/** Whether the launch's profile carries the browser option (a slot without a profile, or whose profile is gone, does not). */
export function profileMarked(api: Pick<TetherDaemon, 'profiles'>, slot: Pick<SlotMeta, 'profileId'>): boolean {
  return !!slot.profileId && profileOption(api.profiles.get(slot.profileId), manifest.id, PROFILE_OPTION) === true
}

/** The launch decision: the global mode and the slot's profile. */
export function serveFor(api: Pick<TetherDaemon, 'settings' | 'profiles'>, slot: Pick<SlotMeta, 'profileId'>): boolean {
  return servesAgent(serveMode(api), profileMarked(api, slot))
}

export function activate(api: TetherDaemon): IDisposable[] {
  const middleware = createBrowserLaunchMiddleware({
    home: api.home,
    agent: name => api.agents.get(name),
    serve: slot => serveFor(api, slot),
    evaluate: () => browserFlag(api, 'evaluate'),
    // Read on use: Electron main bundles this module as CommonJS (import.meta.dirname is undefined there), and never runs it.
    server: resolve(import.meta.dirname ?? '.', 'vendor', 'tether-browser', 'server.mjs'),
    // The system node, like the bridge's MCP shell and tetherd itself; the daemon's own binary (a renamed node) is the last resort.
    node: () => findNode() ?? (existsSync(process.execPath) ? process.execPath : undefined),
    log: msg => api.log(scrubLogLine(msg)),
  })
  return [
    api.onStarted(() => { const n = sweepStale(api.home); if (n) api.log(`${n} arquivo(s) de chave/MCP do navegador de um tetherd anterior removidos`) }),
    api.launch.use(middleware),
    api.onSlot(ev => { if (ev.kind === 'exited' && ev.slot.kind !== 'shell') releaseSlot(api.home, ev.slot.slotId) }),
  ]
}
