// The claude conductor in tetherd: registers itself in conductorRegistry (../for-agents/conductor-api.ts); the acts live in conductor.ts.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import { conductorRegistry } from '../for-agents/conductor-api.ts'
import { claudeConductor } from './conductor.ts'

export { manifest } from './manifest.ts'

export function activate(_api: TetherDaemon): IDisposable[] {
  // One registry per process, and a process may activate the daemon extensions twice (see conductor-terminal): the second finds it there.
  if (conductorRegistry.get(claudeConductor.id) === claudeConductor) return []
  return [conductorRegistry.register(claudeConductor)]
}
