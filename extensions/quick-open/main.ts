// The quick-open extension's Electron-main side: the file index and search of Ctrl+P (service.ts, over the worker
// threads of app/main/file-index-worker.ts, built next to main.cjs) on the bus `ext:quick-open:*`. Every argument
// comes from the renderer and is checked here.
import { join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { QuickOpenChannels } from './ipc.ts'
import { QuickOpenService } from './service.ts'

export { manifest } from './manifest.ts'

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : [])

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<QuickOpenChannels>()
  const service = new QuickOpenService(join(main.dist, 'file-index-worker.cjs'), join(main.dist, '..', '..'))
  return [
    ipc.handle('search', (paneCwd, query, recent) => service.search(paneCwd, typeof query === 'string' ? query : '', strings(recent))),
    ipc.on('refresh', paneCwd => service.refresh(paneCwd)),
    ipc.on('end', () => service.end()),
    { dispose: () => service.dispose() },
  ]
}
