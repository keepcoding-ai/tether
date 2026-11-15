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

/** The answer of `searchOnce`; `code` is the engine's SearchErrorCode name when it gave one (e.g. 'regexParseError'). */
export type SearchOnceResult =
  | { ok: true; matches: IFileMatch[]; limitHit: boolean }
  | { ok: false; message: string; code?: string }

export interface SearchChannels {
  invoke: {
    /**
     * Starts a text search; it replaces (cancels) the one this window was running. The reply only says whether it started:
     * matches arrive on `progress` and the end on `done`, both with the same id. The end is an event because Electron does
     * not order the reply of an invoke against `webContents.send` messages, while messages sent in sequence keep their order.
     */
    search: (id: number, query: ITextQuery) => { started: true } | { started: false; message: string }
    /**
     * Searches one file again with the query (its pattern and preview options; no ignore files, no exclusions), outside
     * the live search: undefined when the file has no match. The file must lie inside the query's folders.
     */
    searchFile: (query: ITextQuery, path: string) => IFileMatch | undefined
    /** Applies replacements on disk; a file is written only if every range still holds the found text. Only inside the folders of this window's last search. */
    replace: (files: FileEdits[]) => FileOutcome[]
    /**
     * A file's text for the replace preview, decoded as the disk replace decodes it (BOM outside the text). Only inside the
     * folders of this window's last search, at most 5 MB; a refusal or a failure comes back as a message in Portuguese.
     */
    readText: (path: string) => { ok: true; text: string } | { ok: false; message: string }
    /** The files changed in git (modified, added, renamed, untracked) under these folders. */
    changedFiles: (folders: string[]) => string[]
    /**
     * A search editor's document written to `<userDir>/search-editors/Pesquisa-AAAAMMDD-HHMMSS.code-search` (`-2`, `-3`…
     * when the name is taken), at most 50 MB; the folder keeps the 50 most recent documents.
     */
    saveEditor: (text: string) => { ok: true; path: string } | { ok: false; message: string }
    /**
     * One whole search for the search editor, on a worker of its own (the pad's live search goes on): every batch joined
     * in one reply. A newer call replaces the running one, which answers `ok: false` with SUPERSEDED_MESSAGE.
     */
    searchOnce: (query: ITextQuery) => SearchOnceResult
  }
  send: {
    /** Cancels the search `id` if it is still running. */
    cancel: (id: number) => void
  }
  events: {
    /** A batch of file matches of the search `id`. */
    progress: (id: number, matches: IFileMatch[]) => void
    /** The search `id` ended; sent after its last `progress` on the same path, so no batch of it arrives later. */
    done: (id: number, result: SearchDone) => void
  }
}
