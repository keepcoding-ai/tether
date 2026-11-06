// The quick-open extension (F9 slice 2): Ctrl+P, "Ir para…". The palette's box without `>` lists the files under the
// focused pane's opening folder (VS Code's ripgrep listing and fuzzy scorer, in worker threads of main), the recently
// opened ones on top, and opens the pick through the file openers (the note's). What it declares is data; renderer.ts
// registers the mode and the command, main.ts serves the search on the bus `ext:quick-open:*`. Without it Ctrl+P does
// nothing in the app (a terminal gets it: the previous command of its history) and the box keeps only the commands.
import type { ExtensionManifest } from '../types.ts'

export const manifest: ExtensionManifest = {
  id: 'quick-open',
  version: '1.0.0',
  displayName: 'Ir para arquivo',
  description: 'Ctrl+P: procura arquivos na pasta do painel e abre no editor ou no programa do sistema.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    commands: [
      { command: 'palette.quick-open', title: 'Ir para…', category: 'App', icon: 'magnifying-glass' },
    ],
    keybindings: [
      { key: 'ctrl+p', command: 'palette.quick-open' },
    ],
  },
}
