// The explorer's renderer entry: the pad (ExplorerView), its commands, and the two rules that tie it to the active pane:
// "seguir" (an AI agent's pane made active makes its project the current one; nothing else does) and "revelar" (a note's
// file is selected in the tree, on demand or, with the setting on, whenever its pane becomes active).
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import { followTarget } from '../../app/renderer/workspace.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { manifest } from './manifest.ts'
import { ExplorerView } from './renderer/view.ts'

export { manifest }

const PAD = 'explorer.files'
const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)

export function activate(ui: TetherUi): IDisposable[] {
  let view: ExplorerView | undefined
  const on = (key: 'follow' | 'autoReveal'): boolean => ui.settings.get<boolean>(key) === true
  const toggle = (key: 'follow' | 'autoReveal'): void => ui.settings.set(key, !on(key))
  /** The active pane's file, revealed in the tree: opens the pad (the keyboard stays where it is). */
  const reveal = async (): Promise<void> => {
    const id = ui.panes.activeId()
    const file = id ? ui.panes.describe(id)?.file : undefined
    if (!file) return
    ui.pads.open(PAD)
    await view?.reveal(file)
  }

  ui.test.expose('explorer', () => view?.snapshot())
  return [
    ui.pads.register({
      id: PAD,
      create: host => (view = new ExplorerView(ui, host, {
        isOn: on,
        toggle,
        reveal: () => { void reveal() },
      })),
    }),
    // "Seguir": only an agent's pane moves the current project; a shell, a note, a preview do not.
    ui.panes.onDidChangeActive(info => {
      if (on('follow')) {
        const root = followTarget(info, ui.workspace.folders(), CASE_INSENSITIVE)
        if (root) { if (view) view.follow(root); else ui.workspace.setCurrent(root) }
      }
      if (on('autoReveal') && info?.file && view) void view.reveal(info.file)
    }),
    // Opens the pad (focusing it when it was closed) and puts the keyboard in it when it already was open.
    ui.commands.registerCommand('explorer.focus', () => { ui.pads.open(PAD); view?.focus() }),
    ui.commands.registerCommand('explorer.open-folder', () => { ui.pads.open(PAD); void view?.pickFolder() }),
    ui.commands.registerCommand('explorer.reveal', () => { void reveal() }),
    ui.commands.registerCommand('explorer.follow', () => toggle('follow')),
    ui.commands.registerCommand('explorer.auto-reveal', () => toggle('autoReveal')),
  ]
}
