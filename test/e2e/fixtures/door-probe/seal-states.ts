// Subject: the states of a seal on a desk pill (slice K1.2): 'struck' (what it names ended) and a click the extension answers
// (`onActivate`, "Ir para Atrium"). The hooks: `sealState(deskId, seal & { clickable? })` puts the probe's seal (undefined takes
// it away), `sealClicks()` lists the desks whose seal was clicked.
import type { DeskSeal, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function sealStates(ui: TetherUi): IDisposable[] {
  const clicks: string[] = []
  ui.test.expose('sealClicks', () => clicks)
  ui.test.expose('sealState', (deskId: string, seal: (Omit<DeskSeal, 'onActivate'> & { clickable?: boolean }) | undefined) => {
    if (!seal) { ui.desks.setSeal(deskId, undefined); return }
    const { clickable, ...rest } = seal
    ui.desks.setSeal(deskId, clickable ? { ...rest, onActivate: () => { clicks.push(deskId) } } : rest)
  })
  return []
}
