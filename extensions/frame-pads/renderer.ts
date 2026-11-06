// The frame pads' renderer entry: each pad's view is the core's frames view (a Desk hosted like the drawer's).
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  return (manifest.contributes?.pads ?? []).map(pad => ui.pads.register({ id: pad.id, create: host => ui.pads.frames(host) }))
}
