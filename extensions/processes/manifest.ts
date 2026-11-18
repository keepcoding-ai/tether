// The processes extension (slices 5 and 6 of background processes): the pad "Processos" on the left bar (the list by
// state, the summary, the actions, the badge, the ports view) and the `process` pane, the read-only output of one process
// (its card, the live terminal, the timeline). The core keeps the data (TetherUi.procs); this extension draws it. Ids
// (pad, pane type, command) are saved in layout.json and keybindings.json and never change.
import type { ExtensionManifest } from '../types.ts'

export const PAD_ID = 'processes.list'
export const PROCESS_PANE_PREFIX = 'process:'
export const PROCESS_COMPONENT = 'processes-output'
export const PROCESS_TAB = 'processes-output-tab'
export const OPEN_COMMAND = 'processes.open'

export const manifest: ExtensionManifest = {
  id: 'processes',
  version: '0.1.0',
  displayName: 'Processos',
  description: 'Os processos de fundo que os agentes iniciam pelo Tether: quem roda, quem iniciou, portas, saída e histórico.',
  hosts: ['renderer'],
  optional: true,
  contributes: {
    paneTypes: [{
      id: 'process', idPrefix: PROCESS_PANE_PREFIX, component: PROCESS_COMPONENT, tabComponent: PROCESS_TAB,
      optionsOf: p => ({ id: p.id, component: PROCESS_COMPONENT, tabComponent: PROCESS_TAB, title: p.title ?? p.id.slice(PROCESS_PANE_PREFIX.length), params: p.params ?? {} }),
    }],
    commands: [{ command: OPEN_COMMAND, title: 'Processos: abrir a prancheta', category: 'Processos', icon: 'pulse' }],
    // Below the explorer (order 10) and the browser's "Guias" (order 20) on the left bar.
    pads: [{ id: PAD_ID, title: 'Processos', icon: 'pulse', defaultSide: 'left', scope: 'global', order: 30 }],
  },
}
