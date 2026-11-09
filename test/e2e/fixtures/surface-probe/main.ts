// E2E-only extension (built into main only with TETHER_TEST_EXTENSIONS=1, see extensions/index.main.ts): hands the extension
// API's surfaces to the E2E as `globalThis.__surfaceProbe` (reached through Playwright's app.evaluate). Never shipped.
import type { ExtensionManifest } from '../../../../extensions/types.ts'
import type { TetherMain } from '../../../../app/main/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

export const manifest: ExtensionManifest = {
  id: 'surface-probe',
  version: '0.0.1',
  displayName: 'Prova de superfícies',
  description: 'Só para os testes: cria superfícies nativas.',
  hosts: ['main'],
  optional: true,
}

export function activate(main: TetherMain): IDisposable[] {
  ;(globalThis as { __surfaceProbe?: TetherMain }).__surfaceProbe = main
  return [{ dispose: () => { delete (globalThis as { __surfaceProbe?: TetherMain }).__surfaceProbe } }]
}
