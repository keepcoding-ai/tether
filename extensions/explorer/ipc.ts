// The explorer extension's channels between its renderer and main sides (the bus `ext:explorer:<channel>`,
// app/shared/ext-ipc.ts). Main validates every argument: they come from the renderer.
import type { Entry } from './tree-rules.ts'

export type { Entry } from './tree-rules.ts'

/** A folder read: its entries (excluded names dropped, folders first), or why it could not be (`missing`: the folder is gone). */
export type ReadDirResult = { ok: true; entries: Entry[] } | { ok: false; missing: boolean; message: string }

export interface ExplorerChannels {
  invoke: {
    /** One folder's entries; never a recursive listing. Only inside the project roots announced by `setRoots`. */
    readDir: (dir: string) => ReadDirResult
    /** What a path is now; a project root that is gone is 'missing'. Only inside the announced roots. */
    stat: (path: string) => { kind: 'file' | 'dir' | 'missing' }
  }
  send: {
    /** The window's project roots now: main reads nothing outside them (defence in depth). */
    setRoots: (roots: string[]) => void
  }
}
