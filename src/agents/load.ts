// Fills the process-wide agent registry from the daemon extensions (extensions/index.daemon.ts) in every process that
// is not tetherd: the CLI (`tether here` plans a launch, `tether profiles` validates), Electron main (it saves
// profiles.json) and the doctor (it runs the extensions' checks). Lazy: the registry calls the loader on its first read,
// so importing this module costs nothing until an agent is needed. tetherd activates its own host (src/daemon/main.ts),
// which marks the registry loaded first. Extensions settings.json `extensions.disabled` lists stay off here too.
import { tetherHome } from '../core/paths.ts'
import type { Profile } from '../core/profile.ts'
import { DaemonExtensionHost } from '../daemon/ext-host.ts'
import type { DaemonCheck, TraceSource } from '../daemon/ext-api.ts'
import { agentRegistry } from './registry.ts'

/** What a process that is not tetherd reads from disk synchronously for its extensions: the settings tree and the profiles. */
export interface HostSources {
  settings(home: string): Record<string, unknown>
  profiles(home: string): Profile[]
}
let sources: HostSources | undefined

/**
 * Set by the entry of such a process (load-sync.ts, imported by the CLI and Electron main). tetherd never sets it: its own
 * snapshots go to its host, and this module (reached by tetherd only for the registry's loader) holds no synchronous disk code.
 */
export function setHostSources(s: HostSources | undefined): void { sources = s }

/** `extensions.disabled` of a settings tree (empty when absent). */
export function disabledIn(tree: Record<string, unknown>): string[] {
  const ext = tree.extensions as { disabled?: unknown } | undefined
  const d = ext && typeof ext === 'object' ? ext.disabled : undefined
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : []
}

/** settings.json `extensions.disabled` of `home` (empty when absent, unreadable or no sources are set). */
export function disabledExtensions(home: string): string[] {
  return disabledIn(sources?.settings(home) ?? {})
}

let host: DaemonExtensionHost | undefined

/** This process's host of the daemon extensions, activated on first use (not in tetherd, which has its own). */
export function agentExtensionHost(): DaemonExtensionHost {
  if (!host) {
    const home = tetherHome()
    host = new DaemonExtensionHost({
      home, log: () => {}, disabled: disabledExtensions(home), agents: agentRegistry,
      settings: { get: () => sources?.settings(home) ?? {} }, profileStore: { profiles: () => sources?.profiles(home) ?? [] },
    })
    host.activate()
  }
  return host
}

/** The doctor checks the active daemon extensions contribute, in activation order. */
export function contributedChecks(): ReadonlyArray<() => Promise<DaemonCheck>> {
  agentRegistry.names() // the lazy load, when nothing read the registry yet
  return host?.checks ?? []
}

/** The logs the active daemon extensions contribute to `tether trace`, in activation order. */
export function contributedTraceSources(): ReadonlyArray<TraceSource> {
  agentRegistry.names() // the lazy load, when nothing read the registry yet
  return host?.traceSources ?? []
}

agentRegistry.setLoader(() => { agentExtensionHost() })
