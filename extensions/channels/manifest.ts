// The channels extension: rooms where agents of any engine and the person talk. The truth lives in tetherd (a channel works
// with the app closed), under <home>/channels/; the roles are the pure rules of rules.ts. Without for-agents there are
// channels and no desk channel. The verbs' namespace is `channels` (the agent sees mcp__tether__channels_say, runs
// `tether channels say`). Ids never change.
import type { ExtensionManifest } from '../types.ts'

export const EXT_ID = 'channels'
/** The namespace of the verbs (VerbContribution.ns), distinct from the id. */
export const VERB_NS = 'channels'

/** The channel's pane: id `channel:<channelId>`, params `{ channelId }`. Saved in layout.json: never changes. */
export const CHANNEL_PANE_PREFIX = 'channel:'
export const CHANNEL_COMPONENT = 'channels-pane'
export const CHANNEL_TAB = 'channels-pane-tab'

export const channelPaneId = (channelId: string): string => `${CHANNEL_PANE_PREFIX}${channelId}`
export const channelIdOfPane = (paneId: string): string => paneId.slice(CHANNEL_PANE_PREFIX.length)

/** The commands' ids. Ids never change: keybindings.json names them. */
export const CMD = {
  open: 'channels.open',
  create: 'channels.create',
  join: 'channels.join',
  remove: 'channels.remove',
  mute: 'channels.mute',
  unmute: 'channels.unmute',
  close: 'channels.close',
  reopen: 'channels.reopen',
} as const

/** The palette's group of every channel command. */
export const CATEGORY = 'Canais'

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.1.0',
  displayName: 'Canais',
  description: 'Salas em que agentes de qualquer motor e você conversam: cada canal tem dono, membros e você como moderador.',
  hosts: ['daemon', 'renderer'],
  optional: true,
  contributes: {
    commands: [
      { command: CMD.open, title: 'Abrir canal…', category: CATEGORY, icon: 'chats-circle' },
      { command: CMD.create, title: 'Criar canal…', category: CATEGORY, icon: 'chats-circle' },
      { command: CMD.join, title: 'Juntar agente a um canal…', category: CATEGORY, icon: 'plugs-connected' },
      { command: CMD.remove, title: 'Tirar agente de um canal…', category: CATEGORY, icon: 'minus-circle' },
      { command: CMD.mute, title: 'Calar agente num canal…', category: CATEGORY, icon: 'bell-slash' },
      { command: CMD.unmute, title: 'Devolver a voz a um agente…', category: CATEGORY, icon: 'arrow-counter-clockwise' },
      { command: CMD.close, title: 'Encerrar canal…', category: CATEGORY, icon: 'stop-circle' },
      { command: CMD.reopen, title: 'Reabrir canal…', category: CATEGORY, icon: 'arrow-counter-clockwise' },
    ],
    paneTypes: [{
      id: 'channel', idPrefix: CHANNEL_PANE_PREFIX, component: CHANNEL_COMPONENT, tabComponent: CHANNEL_TAB,
      optionsOf: p => ({
        id: p.id, component: CHANNEL_COMPONENT, tabComponent: CHANNEL_TAB, title: p.title ?? `#${channelIdOfPane(p.id)}`,
        params: { ...(p.params ?? {}), channelId: channelIdOfPane(p.id) },
      }),
    }],
  },
}
