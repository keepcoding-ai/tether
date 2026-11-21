// The extensions with an Electron-main entry (extensions/<id>/main.ts), in activation order; activated by
// app/main/ext-host.ts at startup. Add `{ manifest, activate }` of extensions/<id>/main.ts here.
import type { TetherMain } from '../app/main/ext-api.ts'
import type { ExtensionEntry } from './types.ts'
import * as note from './note/main.ts'
import * as quickOpen from './quick-open/main.ts'
import * as explorer from './explorer/main.ts'
import * as search from './search/main.ts'
import * as keybindingsScreen from './keybindings-screen/main.ts'
import * as webBridge from './web-bridge/main.ts'
import * as panelPadManager from './panel-pad-manager/main.ts'
import * as browser from './browser/main.ts'
import * as context from './context/main.ts'
import * as surfaceProbe from '../test/e2e/fixtures/surface-probe/main.ts'
import * as agentsProbe from '../test/e2e/fixtures/agents-probe/main.ts'
import * as doorProbe from '../test/e2e/fixtures/door-probe/main.ts'

// Defined by app/build.mjs: true only in a build made with TETHER_TEST_EXTENSIONS=1 (the E2E); every other build drops the probe.
declare const __TETHER_TEST_EXTENSIONS__: boolean | undefined

export const extensions: readonly ExtensionEntry<TetherMain>[] = [
  { manifest: note.manifest, activate: note.activate },
  { manifest: quickOpen.manifest, activate: quickOpen.activate },
  { manifest: explorer.manifest, activate: explorer.activate },
  { manifest: search.manifest, activate: search.activate },
  { manifest: keybindingsScreen.manifest, activate: keybindingsScreen.activate },
  { manifest: webBridge.manifest, activate: webBridge.activate },
  { manifest: panelPadManager.manifest, activate: panelPadManager.activate },
  { manifest: browser.manifest, activate: browser.activate },
  { manifest: context.manifest, activate: context.activate },
  // E2E only: the probe that drives native surfaces.
  ...(typeof __TETHER_TEST_EXTENSIONS__ !== 'undefined' && __TETHER_TEST_EXTENSIONS__ ? [{ manifest: surfaceProbe.manifest, activate: surfaceProbe.activate }, { manifest: agentsProbe.manifest, activate: agentsProbe.activate }, { manifest: doorProbe.manifest, activate: doorProbe.activate }] : []),
]
