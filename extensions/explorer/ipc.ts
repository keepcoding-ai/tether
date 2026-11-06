// The explorer extension's channels between its renderer and main sides (the bus `ext:explorer:<channel>`,
// app/shared/ext-ipc.ts). Main validates every argument: they come from the renderer.
import type { Entry } from './tree-rules.ts'
import type { WatchStats } from './watchers.ts'

export type { Entry } from './tree-rules.ts'
export type { WatchStats } from './watchers.ts'

/** A folder read: its entries (excluded names dropped, folders first), or why it could not be (`missing`: the folder is gone). */
export type ReadDirResult = { ok: true; entries: Entry[] } | { ok: false; missing: boolean; message: string }

/** A file operation's outcome: what went wrong, in the person's words. */
export type OpResult = { ok: true } | { ok: false; message: string }

export interface ExplorerChannels {
  invoke: {
    /** A new empty file or folder (the folders on the way are made); never over an existing one. Only inside the roots. */
    create: (path: string, kind: 'file' | 'dir') => OpResult
    /** Renames within the same folder; never over an existing one. Source and destination inside the roots, never a root. */
    rename: (from: string, to: string) => OpResult
    /** Moves a file or folder to the system's trash (never a permanent delete); a failure changes nothing. */
    trash: (path: string) => OpResult
    /** One folder's entries; never a recursive listing. Only inside the project roots announced by `setRoots`. */
    readDir: (dir: string) => ReadDirResult
    /** What a path is now; a project root that is gone is 'missing'. Only inside the announced roots. */
    stat: (path: string) => { kind: 'file' | 'dir' | 'missing' }
    /** What the disk watchers hold now (the e2e counts handles with it). */
    watchStats: () => WatchStats
  }
  send: {
    /** The window's project roots now: main reads nothing outside them (defence in depth). */
    setRoots: (roots: string[]) => void
    /** The folders the tree shows expanded (whole list, idempotent): disk events elsewhere are dropped; on Linux these are the watched folders. */
    setExpanded: (dirs: string[]) => void
    /** "Atualizar": watchers that failed or whose project folder was gone try again. */
    rewatch: () => void
  }
  events: {
    /** These expanded folders may list differently now (coalesced; at most one message per window). */
    changed: (dirs: string[]) => void
    /** A project folder vanished from the disk or came back. */
    rootMissing: (root: string, missing: boolean) => void
    /** The disk watcher of this project could not start or died: the tree no longer follows it by itself. */
    watchFailed: (root: string, message: string) => void
  }
}
