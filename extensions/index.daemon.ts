// The extensions with a daemon entry (extensions/<id>/daemon.ts), in activation order. tetherd activates them at
// startup (src/daemon/ext-host.ts), before any slot loads. Add `{ manifest, activate }` of extensions/<id>/daemon.ts here.
import type { TetherDaemon } from '../src/daemon/ext-api.ts'
import type { ExtensionEntry } from './types.ts'

export const extensions: readonly ExtensionEntry<TetherDaemon>[] = []
