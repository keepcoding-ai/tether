// The probe's renderer side. One call per subject of the door; its hooks are `window.__tether.ext['door-probe']`.
// A new slice adds its file next to this one (seals.ts, picks.ts...) and one line below.
import type { TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'
import { marks } from './marks.ts'
import { menus } from './menus.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  return [
    ...menus(ui),
    ...marks(ui),
  ]
}
