// The explorer's renderer entry: the pad (ExplorerView) and its commands.
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'
import { ExplorerView } from './renderer/view.ts'

export { manifest }

const PAD = 'explorer.files'

export function activate(ui: TetherUi): IDisposable[] {
  let view: ExplorerView | undefined
  ui.test.expose('explorer', () => view?.snapshot())
  return [
    ui.pads.register({ id: PAD, create: () => (view = new ExplorerView(ui)) }),
    // Opens the pad (focusing it when it was closed) and puts the keyboard in it when it already was open.
    ui.commands.registerCommand('explorer.focus', () => { ui.pads.open(PAD); view?.focus() }),
    ui.commands.registerCommand('explorer.open-folder', () => { ui.pads.open(PAD); void view?.pickFolder() }),
  ]
}
