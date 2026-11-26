// The extensions with a daemon entry (extensions/<id>/daemon.ts), in activation order. tetherd activates them at
// startup (src/daemon/ext-host.ts), before any slot loads; the CLI and Electron main on their first registry read
// (src/agents/load.ts). Add `{ manifest, activate }` of extensions/<id>/daemon.ts here.
import type { TetherDaemon } from '../src/daemon/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as claude from './claude/daemon.ts'
import * as soul from './soul/daemon.ts'
import * as hands from './hands/daemon.ts'
import * as codex from './codex/daemon.ts'
import * as skills from './skills/daemon.ts'
import * as browser from './browser/daemon.ts'
import * as webBridge from './web-bridge/daemon.ts'
import * as forAgents from './for-agents/daemon.ts'
import * as conductorTerminal from './conductor-terminal/daemon.ts'
import * as conductorClaude from './conductor-claude/daemon.ts'
import * as conductorSoul from './conductor-soul/daemon.ts'
import * as conductorCodex from './conductor-codex/daemon.ts'
import * as channels from './channels/daemon.ts'
import * as sync from './sync/daemon.ts'
import * as remote from './remote/daemon.ts'

export const extensions: readonly ExtensionEntry<TetherDaemon>[] = [
  { manifest: claude.manifest, activate: claude.activate },
  { manifest: soul.manifest, activate: soul.activate },
  { manifest: hands.manifest, activate: hands.activate },
  { manifest: codex.manifest, activate: codex.activate },
  { manifest: skills.manifest, activate: skills.activate },
  { manifest: webBridge.manifest, activate: webBridge.activate },
  { manifest: browser.manifest, activate: browser.activate },
  { manifest: forAgents.manifest, activate: forAgents.activate },
  { manifest: conductorTerminal.manifest, activate: conductorTerminal.activate },
  { manifest: conductorClaude.manifest, activate: conductorClaude.activate },
  { manifest: conductorSoul.manifest, activate: conductorSoul.activate },
  { manifest: conductorCodex.manifest, activate: conductorCodex.activate },
  { manifest: channels.manifest, activate: channels.activate },
  { manifest: sync.manifest, activate: sync.activate },
  { manifest: remote.manifest, activate: remote.activate },
]
