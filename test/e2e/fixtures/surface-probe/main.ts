// E2E-only extension (built into main only with TETHER_TEST_EXTENSIONS=1, see extensions/index.main.ts): hands the extension
// API's surfaces to the E2E as `globalThis.__surfaceProbe` (reached through Playwright's app.evaluate) and creates the
// surface of the test panel on request, the page being the file named by TETHER_SURFACE_PROBE_PAGE. Never shipped.
import type { TetherMain } from '../../../../app/main/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import type { SurfaceProbeChannels } from './ipc.ts'
import { manifest } from './manifest.ts'

export { manifest }

export function activate(main: TetherMain): IDisposable[] {
  ;(globalThis as { __surfaceProbe?: TetherMain }).__surfaceProbe = main
  const ipc = main.ipc<SurfaceProbeChannels>().handle('create', async () => {
    const s = await main.surfaces.create({ pageSize: { width: 1280, height: 800 }, webPreferences: { partition: 'surface-probe' } })
    const page = process.env.TETHER_SURFACE_PROBE_PAGE
    if (page) await s.webContents.loadFile(page)
    return s.id
  })
  return [ipc, { dispose: () => { delete (globalThis as { __surfaceProbe?: TetherMain }).__surfaceProbe } }]
}
