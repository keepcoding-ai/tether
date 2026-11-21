// The terminal conductor in tetherd: registers itself in conductorRegistry (../for-agents/conductor-api.ts); the acts live in conductor.ts.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { conductorRegistry } from '../for-agents/conductor-api.ts'
import { terminalConductor } from './conductor.ts'

export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  return [conductorRegistry.register(terminalConductor)]
}
