// The extension model (F9): an extension is a folder extensions/<id>/ with manifest.ts and up to three entries
// (renderer.ts, main.ts, daemon.ts), each exporting `activate(api)` that returns the disposables of what it registered.
// Discovery is static: one committed index per host (index.renderer.ts, index.main.ts, index.daemon.ts); a unit test
// fails when a folder's entry is missing from its index (test/unit/ext.index.test.ts). Pure: read by all three hosts.
import type { IDisposable } from '../app/shared/vscode-lifecycle.ts'

export type Host = 'renderer' | 'main' | 'daemon'
export const HOSTS: readonly Host[] = ['renderer', 'main', 'daemon']

export interface ExtensionManifest {
  /** Stable, lowercase, no dot: `note`, `quick-open`, `claude`. Prefixes IPC channels, settings and test hooks. */
  id: string
  /** Semver, bumped by hand in the commit that changes the extension. Informative. */
  version: string
  displayName: string
  description?: string
  /** The processes this extension has an entry in; the index test checks it against the files. */
  hosts: readonly Host[]
  /** Can the person turn it off. */
  optional?: boolean
  /** Extensions that must activate first. */
  requires?: readonly string[]
  /** What the core needs before activation (grows per slice: keybindings, settings, pads, agents, menus). */
  contributes?: {
    /** Pane type ids this extension registers: the layout knows they exist. */
    paneTypes?: readonly string[]
  }
}

/** One entry of a host's index: the manifest and that host's `activate`. */
export interface ExtensionEntry<Api> {
  manifest: ExtensionManifest
  activate(api: Api): IDisposable[] | void
  deactivate?(): void
}
