// The search extension's channels between its renderer and main sides (the bus `ext:search:<channel>`,
// app/shared/ext-ipc.ts). Main validates every argument: they come from the renderer.
import type { IFileMatch, ITextQuery, ITextSearchCompleteMessage } from '../../app/shared/vscode-search.ts'
import type { FileEdits, FileOutcome } from '../../app/main/search-replace-disk.ts'

export type { FileEdits, FileOutcome }

/** How a search ended. */
export type SearchDone =
  | { kind: 'done'; limitHit: boolean; messages: ITextSearchCompleteMessage[] }
  | { kind: 'cancelled' }
  /** `code` is a SearchErrorCode name when the engine gave one (e.g. 'regexParseError'). */
  | { kind: 'error'; message: string; code?: string }

export interface SearchChannels {
  invoke: {
    /** Runs a text search; it replaces (cancels) the one this window was running. Resolves when it ends; matches arrive on `progress` with the same id. */
    search: (id: number, query: ITextQuery) => SearchDone
    /** Applies replacements on disk; a file is written only if every range still holds the found text. Only inside the folders of this window's last search. */
    replace: (files: FileEdits[]) => FileOutcome[]
    /** The files changed in git (modified, added, renamed, untracked) under these folders. */
    changedFiles: (folders: string[]) => string[]
  }
  send: {
    /** Cancels the search `id` if it is still running. */
    cancel: (id: number) => void
  }
  events: {
    /** A batch of file matches of the search `id`. */
    progress: (id: number, matches: IFileMatch[]) => void
  }
}
