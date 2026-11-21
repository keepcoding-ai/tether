// Subject: several emblems of one extension on a tab (slice K1.3): `setEmblems`, the one-letter emblem ("K") and the struck one.
// The hook `emblemSet(paneId, emblems | undefined)` puts the probe's set (undefined or [] takes it away).
import type { TabEmblem, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function emblemSets(ui: TetherUi): IDisposable[] {
  ui.test.expose('emblemSet', (paneId: string, emblems: TabEmblem[] | undefined) => ui.panes.setEmblems(paneId, emblems))
  return []
}
