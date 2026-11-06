// The quick-open extension's renderer entry: the palette's default mode (text without `>`), the command that opens the
// box in it (Ctrl+P) and the history of opened files, fed by every file the core opens.
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { QuickOpenChannels } from './ipc.ts'
import { manifest } from './manifest.ts'
import { QuickOpen, type QuickOpenScope } from './ui.ts'

/** The last segment of a path (a folder's name). */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<QuickOpenChannels>()
  const quickOpen = new QuickOpen({
    scope: () => scopeOf(ui),
    search: (root, query, recent) => ipc.invoke('search', root, query, recent),
    refresh: root => ipc.send('refresh', root),
    end: () => ipc.send('end'),
    openFile: (path, opts) => ui.openers.open(path, opts),
  })
  return [
    ui.openers.onOpened(path => quickOpen.remember(path)),
    ui.palette.registerMode({
      id: 'quick-open',
      command: 'palette.quick-open',
      hint: 'Digite para procurar arquivos pelo nome. Digite > para procurar um comando.',
      placeholder: () => quickOpen.placeholder(),
      searchingText: 'Procurando arquivos…',
      begin: () => quickOpen.begin(),
      end: () => quickOpen.end(),
      search: async text => {
        const s = await quickOpen.search(text)
        if (!s) return null
        return { pending: s.result.pending, render: (list, idBase) => quickOpen.render(list, s, idBase), emptyText: () => quickOpen.emptyText(s) }
      },
      open: (path, side) => quickOpen.open(path, side),
    }),
    ui.commands.registerCommand('palette.quick-open', () => ui.palette.showMode()),
  ]
}

/**
 * Where Ctrl+P searches (F8 slice 6): the project that contains the focused pane's folder; a pane outside every project
 * searches its own folder; a pane without a folder searches the explorer's current project; none of them: main uses the notes folder.
 */
function scopeOf(ui: TetherUi): QuickOpenScope {
  const cwd = ui.panes.cwdOf(ui.panes.activeId())
  const project = cwd ? ui.workspace.folderOf(cwd) : undefined
  if (project) return { root: project.path, kind: 'project', name: project.name }
  if (cwd) return { root: cwd, kind: 'folder', name: baseName(cwd) }
  const current = ui.workspace.current()
  const found = current ? ui.workspace.folders().find(f => f.path === current) : undefined
  if (found) return { root: found.path, kind: 'project', name: found.name }
  return { root: undefined, kind: 'none', name: '' }
}
