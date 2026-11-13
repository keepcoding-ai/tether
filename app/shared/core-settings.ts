// The core's own settings as configuration-registry properties (app/shared/vscode-configuration-registry.ts): the node with
// prefix '' whose keys are top-level paths of settings.json (`theme`, `ui.deskLine`…), next to the extensions' nodes.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/workbench/browser/workbench.contribution.ts (the workbench registers its own settings as a configuration node
//     with titles, descriptions, enum descriptions and order, like any contribution)
// Adapted: only what the settings page edits as a value. `terminal` (its own dialog) and `confirmations` (remembered answers)
// stay out: they are objects the core writes whole. Defaults and enums come from ui-settings.ts / theme.ts, so the readers
// there (normalizeUi, normalizeTheme) and the registry cannot drift (a unit test holds that too). Pure.
import type { ConfigurationNode } from './vscode-configuration-registry.ts'
import { DEFAULT_UI, DIM_LEVELS, FIXED_DESK_LABELS } from './ui-settings.ts'
import { DEFAULT_OS_NOTIFY, OS_NOTIFY_LEVELS } from './os-notify.ts'
import { DEFAULT_THEME, THEME_LABEL, THEME_SETTINGS } from './theme.ts'

export const CORE_SETTINGS: ConfigurationNode = {
  id: 'core',
  prefix: '',
  title: 'Aparência',
  order: 0,
  properties: {
    'theme': {
      type: 'string', default: DEFAULT_THEME, enum: THEME_SETTINGS, enumLabels: THEME_SETTINGS.map(t => THEME_LABEL[t]),
      title: 'Tema', description: 'Claro, escuro ou automático (segue o sistema operacional).', section: 'Tema', order: 0,
    },
    'ui.deskLine': {
      type: 'boolean', default: DEFAULT_UI.deskLine, title: 'Linha da mesa',
      description: 'Uma linha fina na cor da mesa ativa ao longo do topo da mesa.', section: 'Janela', order: 10,
    },
    'ui.tabBorder': {
      type: 'boolean', default: DEFAULT_UI.tabBorder, title: 'Contorno do painel em foco',
      description: 'O painel em foco ganha um contorno em forma de pasta na cor da mesa (na gaveta, na cor da gaveta).', section: 'Janela', order: 11,
    },
    'ui.dimUnfocused': {
      type: 'boolean', default: DEFAULT_UI.dimUnfocused, title: 'Escurecer painéis sem foco',
      description: 'Os quadros sem foco ficam velados em direção ao fundo da mesa.', section: 'Janela', order: 12,
    },
    'ui.dimLevel': {
      type: 'string', default: DEFAULT_UI.dimLevel, enum: DIM_LEVELS, enumLabels: ['Fraco', 'Médio', 'Forte'],
      title: 'Intensidade do escurecimento', description: 'Só vale com "Escurecer painéis sem foco" ligado.', section: 'Janela', order: 13,
    },
    'ui.fixedDeskLabel': {
      type: 'string', default: DEFAULT_UI.fixedDeskLabel, enum: FIXED_DESK_LABELS, enumLabels: ['Ícone', 'Ícone e nome'],
      title: 'Mesas fixas', description: 'Como a Gaveta e as mesas do sistema aparecem na barra de mesas.', section: 'Janela', order: 14,
    },
    'ui.tabClose': {
      type: 'boolean', default: DEFAULT_UI.tabClose, title: 'Botão de fechar nas guias',
      description: 'O × em cada guia. Desligado, a guia fecha pelo menu do botão direito.', section: 'Janela', order: 15,
    },
    'notifications.os': {
      type: 'string', default: DEFAULT_OS_NOTIFY, enum: OS_NOTIFY_LEVELS, enumLabels: ['Todas', 'Só quando esperam você', 'Desligadas'],
      title: 'Notificações do sistema', description: 'Avisos do Windows quando um agente termina ou espera você e o tether não está em primeiro plano.', section: 'Notificações', order: 20,
    },
  },
}
