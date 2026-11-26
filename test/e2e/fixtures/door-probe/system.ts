// Subject: the S5 seams the Regency's System uses (slice R5a). Hooks in `window.__tether.ext['door-probe']`:
// `sysRonda(slotId)` the pane's ronda (null: off); `sysRondaHeard()` the rondas `agents.onDidChange` told, in order;
// `sysSetRonda(slotId, change)` / `sysOffRonda(slotId, force)` the answers; `sysProfiles()` and `sysProfilesHeard()`;
// `sysEditProfile(id, duplicate)`; `sysStatus()`, `sysStatusShow(id)`; `sysPeekNew(typeId, spec)`.
import type { PeekNewSpec, RondaChange, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export function system(ui: TetherUi): IDisposable[] {
  const rondas: { slotId: string; ronda: unknown }[] = []
  let profileEvents = 0
  ui.test.expose('sysRonda', (slotId: string) => ui.agents.get(slotId)?.ronda ?? null)
  ui.test.expose('sysRondaHeard', () => rondas)
  ui.test.expose('sysSetRonda', (slotId: string, change: RondaChange) => ui.agents.setRonda(slotId, change))
  ui.test.expose('sysOffRonda', (slotId: string, force: boolean) => ui.agents.offRonda(slotId, force ? { force: true } : undefined))
  ui.test.expose('sysProfiles', () => ui.profiles.list())
  ui.test.expose('sysProfilesHeard', () => profileEvents)
  ui.test.expose('sysEditProfile', (id: string, duplicate: boolean) => { ui.profiles.edit(id, duplicate ? { duplicate: true } : undefined) })
  ui.test.expose('sysStatus', () => ui.status.items())
  ui.test.expose('sysStatusShow', (id: string) => ui.status.show(id))
  ui.test.expose('sysPeekNew', (typeId: string, spec?: PeekNewSpec) => ui.panes.peekNew(typeId, spec) ?? null)
  return [
    ui.agents.onDidChange(pane => { rondas.push({ slotId: pane.slotId, ronda: pane.ronda ?? null }) }),
    ui.profiles.onDidChange(() => { profileEvents++ }),
  ]
}
