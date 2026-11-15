// The search extension's renderer entry: the pad (SearchView) and its focus command.
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'
import { SearchView } from './renderer/view.ts'

export { manifest }

const PAD = 'search.view'

export function activate(ui: TetherUi): IDisposable[] {
  let view: SearchView | undefined
  ui.test.expose('search', () => undefined)
  return [
    ui.pads.register({ id: PAD, create: host => (view = new SearchView(ui, host)) }),
    ui.commands.registerCommand('search.focus', () => { ui.pads.open(PAD); view?.focus() }),
  ]
}
