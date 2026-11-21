// The terminal conductor in tetherd: registers itself in conductorRegistry (../for-agents/conductor-api.ts); the acts live in conductor.ts.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { conductorRegistry } from '../for-agents/conductor-api.ts'
import { terminalConductor } from './conductor.ts'

export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  // The registry is one per process, and a process may activate the daemon extensions twice (the host of src/agents/load.ts,
  // which only reads the agents, and tetherd's own): the second activation finds the conductor there and leaves it be.
  if (conductorRegistry.get(terminalConductor.id) === terminalConductor) return []
  return [conductorRegistry.register(terminalConductor)]
}
