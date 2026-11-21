// The probe's main side (the molde of agents-probe): TetherMain, kept in `globalThis.__doorProbe` for the E2E (reached through
// app.evaluate), and what its objects told.
import type { ExtObjectChange, TetherMain } from '../../../../app/main/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'

export { manifest }

export interface DoorProbeMain {
  main: TetherMain
  heard: ExtObjectChange[]
}

export function activate(main: TetherMain): IDisposable[] {
  const probe: DoorProbeMain = { main, heard: [] }
  ;(globalThis as { __doorProbe?: DoorProbeMain }).__doorProbe = probe
  return [
    main.objects.onDidChange(e => { probe.heard.push(e) }),
    { dispose: () => { delete (globalThis as { __doorProbe?: DoorProbeMain }).__doorProbe } },
  ]
}
