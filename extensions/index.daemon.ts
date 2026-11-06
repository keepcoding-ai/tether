// The extensions with a daemon entry (extensions/<id>/daemon.ts), in activation order. tetherd activates them at
// startup (src/daemon/ext-host.ts), before any slot loads; the CLI and Electron main on their first registry read
// (src/agents/load.ts). Add `{ manifest, activate }` of extensions/<id>/daemon.ts here.
import type { TetherDaemon } from '../src/daemon/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as claude from './claude/daemon.ts'
import * as soul from './soul/daemon.ts'

export const extensions: readonly ExtensionEntry<TetherDaemon>[] = [
  { manifest: claude.manifest, activate: claude.activate },
  { manifest: soul.manifest, activate: soul.activate },
]
