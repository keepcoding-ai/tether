// The faults extension: the "Falhas" screen over the fault registry (src/core/faults.ts), where what broke in any tether
// process is read, marked (resolvida, ignorada, reaberta), tagged, annotated, and handed to an AI agent of one of the panes
// ("Mandar para o agente": the screen types `/tether:fault-investigate <id>` into that pane). Only the SCREEN is the
// extension's: capture is the core's and stays on with the screen off, and `tether faults` writes the same registry.
// The extension also declares the feature `faults` (what the agents receive: the skills that read and mark faults), off by
// default; its `share/` folder holds the skills. Ids (command, pane component, prefix, status, feature) are
// already in people's files and never change.
import type { ExtensionManifest } from '../types.ts'
import { FAULTS_SCREEN_LAYOUT } from './layouts.ts'

/** The feature the skills ride on (`agents.features.faults`, Profile.features.faults). Never renamed. */
export const FAULTS_FEATURE = 'faults'
/** The top bar's status icon (`contributes.status`), never renamed. */
export const FAULTS_STATUS_ID = 'faults.status'

export const manifest: ExtensionManifest = {
  id: 'faults',
  version: '1.0.0',
  displayName: 'Falhas',
  description: 'A tela com o que quebrou no tether, onde cada falha se marca, etiqueta, anota e se manda para um agente investigar.',
  hosts: ['renderer', 'main', 'daemon'],
  optional: true,
  contributes: {
    paneTypes: [FAULTS_SCREEN_LAYOUT],
    settings: {
      investigateCwd: {
        type: 'string', default: '', title: 'Pasta do novo painel que investiga uma falha',
        description: 'Onde "Mandar para o agente" abre um painel novo. Vazio: a pasta do código-fonte do tether, quando ela existe nesta máquina.',
      },
    },
    commands: [
      { command: 'faults.show', title: 'Falhas', category: 'App', icon: 'bug' },
    ],
    menus: {
      app: [
        // order 6: in the 'app' group after "Atalhos de teclado" (5) and before "Instalar Tether Bridge" (7).
        { command: 'faults.show', group: 'app', order: 6, icon: 'bug', label: 'Falhas' },
      ],
    },
    features: {
      // Static content: extensions/faults/share (the skills; Claude gets them as /tether:fault-*).
      [FAULTS_FEATURE]: { title: 'Falhas do tether para o agente', description: 'Os agentes dos painéis recebem as skills que leem e marcam as falhas do tether.', default: false, share: 'share' },
    },
    status: [
      { id: FAULTS_STATUS_ID, icon: 'bug', order: 40 },
    ],
  },
}
