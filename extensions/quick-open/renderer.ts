// The quick-open extension's renderer entry: the palette's default mode (text without `>`), the command that opens the
// box in it (Ctrl+P) and the history of opened files, fed by every file the core opens.
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { QuickOpenChannels } from './ipc.ts'
import { manifest } from './manifest.ts'
import { QuickOpen } from './ui.ts'

export { manifest }

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<QuickOpenChannels>()
  const quickOpen = new QuickOpen({
    paneCwd: () => ui.panes.cwdOf(ui.panes.activeId()),
    search: (paneCwd, query, recent) => ipc.invoke('search', paneCwd, query, recent),
    refresh: paneCwd => ipc.send('refresh', paneCwd),
    end: () => ipc.send('end'),
    openFile: (path, opts) => ui.openers.open(path, opts),
  })
  return [
    ui.openers.onOpened(path => quickOpen.remember(path)),
    ui.palette.registerMode({
      id: 'quick-open',
      command: 'palette.quick-open',
      hint: 'Digite para procurar arquivos na pasta do painel. Digite > para procurar um comando.',
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
