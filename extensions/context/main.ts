// The context extension's main side: the service behind `ext:context:snapshot` and `ext:context:measure`. The window's
// arguments are validated here (they come from the renderer); the agent kind comes from the daemon's slot states that
// main already follows (TetherMain.agents), never from the renderer.
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ContextChannels } from './ipc.ts'
import { ContextService } from './service.ts'

export { manifest } from './manifest.ts'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function activate(main: TetherMain): IDisposable[] {
  const service = new ContextService({ home: main.home, agentKind: slotId => main.agents.get(slotId)?.kind })
  const ipc = main.ipc<ContextChannels>()
  return [
    ipc.handle('snapshot', req => {
      const r = (req ?? {}) as unknown as Record<string, unknown>
      const rev = str(r.rev)
      const invKey = str(r.invKey)
      return service.snapshot({ slotId: str(r.slotId), cwd: str(r.cwd), ...(rev ? { rev } : {}), ...(invKey ? { invKey } : {}) })
    }),
    ipc.handle('measure', req => {
      const r = (req ?? {}) as unknown as Record<string, unknown>
      return service.measure({ slotId: str(r.slotId), cwd: str(r.cwd), force: r.force === true })
    }),
    { dispose: () => service.dispose() },
  ]
}
