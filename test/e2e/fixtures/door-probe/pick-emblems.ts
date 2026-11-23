// Subject: the person's tab emblem in the list picker (`PickItem.emblem`) and `ui.panes.personEmblem`. The hooks:
// `wearEmblem(paneId, emblemId)` puts the `emblem` param on a tab as the "Emblema…" menu does, `personEmblem(paneId)` reads it back,
// `pickEmblems(paneIds)` opens a picker with one row per pane (same label, the emblem the pane wears), `pickEmblemResults()` lists the answers.
import type { PickItem, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function pickEmblems(ui: TetherUi): IDisposable[] {
  const results: unknown[] = []
  ui.test.expose('pickEmblemResults', () => results)
  ui.test.expose('wearEmblem', (paneId: string, emblemId: string | undefined) => { ui.panes.find(paneId)?.api.updateParameters({ emblem: emblemId }) })
  ui.test.expose('personEmblem', (paneId: string) => ui.panes.personEmblem(paneId) ?? null)
  ui.test.expose('pickEmblems', (paneIds: string[]) => {
    const items: PickItem<string>[] = paneIds.map(id => {
      const emblem = ui.panes.personEmblem(id)
      return { value: id, label: 'atrium', detail: 'mora em atrium', ...(emblem ? { emblem } : {}) }
    })
    void ui.pick.list({ title: 'Dar a guia a…', items }).then(r => { results.push(r ?? null) })
  })
  return []
}
