// The sync extension: the visible side of `tether sync` (the engine is src/core/sync, the CLI src/cli/sync.ts, the app's cycle
// app/main/sync-runner.ts). A status icon on the top bar while the profile is linked to a repo (hidden otherwise: a function
// that is off takes no room), two palette commands each shown only when it serves, a tray notice for what needs the person
// (authentication, git missing) and a `tether doctor` line. Ids never change.
import type { ExtensionManifest } from '../types.ts'

export const EXT_ID = 'sync'

/** The status icon's id (`contributes.status`), never renamed. */
export const STATUS_ID = 'sync.status'

/** The commands' ids. Ids never change: keybindings.json names them. */
export const CMD = {
  connect: 'sync.connect',
  now: 'sync.now',
} as const

export const CATEGORY = 'Sincronização'

export const manifest: ExtensionManifest = {
  id: EXT_ID,
  version: '0.1.0',
  displayName: 'Sincronização',
  description: 'Mantém perfis, mesas, preferências e atalhos iguais entre as suas máquinas por um repositório git.',
  hosts: ['renderer', 'main', 'daemon'],
  optional: true,
  contributes: {
    commands: [
      // Availability is the link's state (connected or not), known only at run time: the renderer registers each command with
      // its `when` in code (TetherUi.commands.register), so the palette shows `connect` only without a link and `now` only with one.
      { command: CMD.connect, title: 'Conectar a um repositório…', category: CATEGORY, icon: 'link' },
      { command: CMD.now, title: 'Sincronizar agora', category: CATEGORY, icon: 'arrows-clockwise' },
    ],
    status: [{ id: STATUS_ID, icon: 'arrows-clockwise', order: 55 }],
  },
}
