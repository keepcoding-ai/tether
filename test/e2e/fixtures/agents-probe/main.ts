// The probe's main side: TetherMain.agents and what its listeners heard, for the E2E (reached through app.evaluate).
import type { AgentExit, AgentInfo, TetherMain } from '../../../../app/main/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'

export { manifest }

export interface AgentsProbeMain {
  main: TetherMain
  changes: AgentInfo[]
  exits: AgentExit[]
}

export function activate(main: TetherMain): IDisposable[] {
  const probe: AgentsProbeMain = { main, changes: [], exits: [] }
  ;(globalThis as { __agentsProbe?: AgentsProbeMain }).__agentsProbe = probe
  return [
    main.agents.onDidChange(a => { probe.changes.push(a) }),
    main.agents.onDidExit(e => { probe.exits.push(e) }),
    { dispose: () => { delete (globalThis as { __agentsProbe?: AgentsProbeMain }).__agentsProbe } },
  ]
}
