// The extensions with a renderer entry, in activation order. Add `{ manifest, activate }` of extensions/<id>/renderer.ts here.
import type { TetherUi } from '../app/renderer/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as claude from './claude/renderer.ts'
import * as soul from './soul/renderer.ts'
import * as note from './note/renderer.ts'
import * as framePads from './frame-pads/renderer.ts'
import * as quickOpen from './quick-open/renderer.ts'
import * as explorer from './explorer/renderer.ts'
import * as keybindingsScreen from './keybindings-screen/renderer.ts'
import * as settingsScreen from './settings-screen/renderer.ts'
import * as webBridge from './web-bridge/renderer.ts'
import * as surfaceProbe from '../test/e2e/fixtures/surface-probe/renderer.ts'
import * as systemDeskProbe from '../test/e2e/fixtures/system-desk-probe/renderer.ts'
import * as agentsProbe from '../test/e2e/fixtures/agents-probe/renderer.ts'

// Defined by app/build.mjs: true only in a build made with TETHER_TEST_EXTENSIONS=1 (the E2E); every other build drops the probe.
declare const __TETHER_TEST_EXTENSIONS__: boolean | undefined

export const extensions: readonly ExtensionEntry<TetherUi>[] = [
  { manifest: claude.manifest, activate: claude.activate },
  { manifest: soul.manifest, activate: soul.activate },
  { manifest: note.manifest, activate: note.activate },
  { manifest: quickOpen.manifest, activate: quickOpen.activate },
  { manifest: framePads.manifest, activate: framePads.activate },
  { manifest: explorer.manifest, activate: explorer.activate },
  { manifest: keybindingsScreen.manifest, activate: keybindingsScreen.activate },
  { manifest: settingsScreen.manifest, activate: settingsScreen.activate },
  { manifest: webBridge.manifest, activate: webBridge.activate },
  // E2E only: the probes (a system desk; a pane hosting a surface).
  ...(typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__ ? [{ manifest: systemDeskProbe.manifest, activate: systemDeskProbe.activate }, { manifest: surfaceProbe.manifest, activate: surfaceProbe.activate }, { manifest: agentsProbe.manifest, activate: agentsProbe.activate }] : []),
]
