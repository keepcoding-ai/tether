// The explorer's renderer entry: the pad (ExplorerView), its commands, and the two rules that tie it to the active pane:
// "seguir" (an AI agent's pane made active makes its project the current one; nothing else does) and "revelar" (a note's
// file is selected in the tree, on demand or, with the setting on, whenever its pane becomes active).
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import { followTarget } from '../../app/renderer/workspace.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ExplorerChannels } from './ipc.ts'
import { manifest } from './manifest.ts'
import { ExplorerView, type FileOp } from './renderer/view.ts'

export { manifest }

const PAD = 'explorer.files'
const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)

export function activate(ui: TetherUi): IDisposable[] {
  let view: ExplorerView | undefined
  const on = (key: 'follow' | 'autoReveal' | 'confirmDelete'): boolean => ui.settings.get<boolean>(key) === true
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
  ui.test.expose('explorerWatch', () => view?.watchStats())
  // The e2e calls the write channels directly to prove main's guard refuses what the view would never ask.
  const ipc = ui.ipc<ExplorerChannels>()
  ui.test.expose('explorerWrite', {
    create: (path: string, kind: 'file' | 'dir') => ipc.invoke('create', path, kind),
    rename: (from: string, to: string) => ipc.invoke('rename', from, to),
    trash: (path: string) => ipc.invoke('trash', path),
  })
  return [
    ui.pads.register({
      id: PAD,
      create: host => (view = new ExplorerView(ui, host, {
        isOn: on,
        toggle,
        set: (key, value) => ui.settings.set(key, value),
        onChange: (key, listener) => ui.settings.onChange(key, listener),
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
    ui.commands.registerCommand('explorer.refresh', () => { ui.pads.open(PAD); view?.refresh() }),
    ui.commands.registerCommand('explorer.collapse-all', () => { ui.pads.open(PAD); view?.collapseAll() }),
    ...(['new-file', 'new-folder', 'rename', 'delete', 'copy-path', 'copy-relative-path', 'new-pane'] as const).map((op: FileOp) =>
      ui.commands.registerCommand(`explorer.${op}`, () => { ui.pads.open(PAD); view?.run(op) })),
    ui.commands.registerCommand('explorer.follow', () => toggle('follow')),
    ui.commands.registerCommand('explorer.auto-reveal', () => toggle('autoReveal')),
  ]
}
