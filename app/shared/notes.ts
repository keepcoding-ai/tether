// The note tab's rules, pure and shared by the renderer (app/renderer/note-panel.ts) and the main process
// (app/main/note-files.ts): how a note pane is identified in the layout, what it keeps in its pane params,
// how its file is named, what `.gitignore` must say, and what an external change of the file means.
//
// A note is a pane like a terminal (same dockview, same layout.json), but it has no slot in tetherd: the pane
// id carries a prefix the layout code recognizes (`isNotePanelId`) so the restore never prunes it as a slot the
// daemon does not know. Its state for the next launch lives in the pane's params (`NoteParams`): the file's
// path and Monaco's view state (cursor, selections, scroll, folds). That is the model the layout already has
// for the status bar (`details`): the arrangement file says what each tab shows and how, nothing else does.

export const NOTE_COMPONENT = 'note'
export const NOTE_TAB = 'note-tab'
export const NOTE_PANEL_PREFIX = 'note:'
export const NOTE_EXTENSION = '.md'
/** The folder a repository's notes go to, under the pane's opening folder. */
export const NOTES_SUBDIR = '.tether/notes'
/** The line that keeps the folder out of git. */
export const GITIGNORE_LINE = '.tether/'

export function isNotePanelId(id: string): boolean {
  return id.startsWith(NOTE_PANEL_PREFIX)
}

/** A fresh pane id: time-ordered (sortable in the file) plus random tail (two notes in the same millisecond). */
export function newNotePanelId(now: number = Date.now(), random: number = Math.random()): string {
  return `${NOTE_PANEL_PREFIX}${now.toString(36).padStart(9, '0')}-${Math.floor(random * 36 ** 4).toString(36).padStart(4, '0')}`
}

/** Monaco's `ICodeEditorViewState` as the layout keeps it: opaque JSON (the editor reads it back). */
export type NoteView = Record<string, unknown>

export interface NoteParams {
  note: {
    /** Absolute path of the .md file. */
    path: string
    /** Cursor, selections, scroll and folds, as last persisted. */
    view?: NoteView
    /** The folder the file was opened from (Quick Open's root): the pane's opening folder for the next Quick Open or note. */
    cwd?: string
  }
}

/** The note part of a pane's params, when the pane is a note with a path. */
export function noteParams(params: unknown): NoteParams['note'] | undefined {
  if (!params || typeof params !== 'object') return undefined
  const note = (params as { note?: unknown }).note
  if (!note || typeof note !== 'object' || typeof (note as { path?: unknown }).path !== 'string') return undefined
  const { path, view, cwd } = note as { path: string; view?: unknown; cwd?: unknown }
  return { path, ...(view && typeof view === 'object' ? { view: view as NoteView } : {}), ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}) }
}

/** The params with the note's view replaced (or the path changed); other params are kept, the opening folder too when `note` names none. */
export function withNote(params: Record<string, unknown> | undefined, note: NoteParams['note']): Record<string, unknown> {
  const cwd = note.cwd ?? noteParams(params)?.cwd
  return { ...(params ?? {}), note: { path: note.path, ...(note.view ? { view: note.view } : {}), ...(cwd ? { cwd } : {}) } }
}

/** What the tab shows: the file name. */
export function noteTitle(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** The folder of a path (both separators), '' when there is none. */
export function noteDirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i < 0 ? '' : path.slice(0, i)
}

/**
 * Where `path` is after `from` was renamed to `to`: `to` itself, the same place under a renamed folder, or undefined when
 * the rename does not touch it. Case-insensitive, like the notes' own path matching (Windows).
 */
export function rebasePath(path: string, from: string, to: string): string | undefined {
  const p = path.toLowerCase(), f = from.replace(/[\\/]+$/, '').toLowerCase()
  if (p === f) return to
  if (p.startsWith(f) && (p[f.length] === '\\' || p[f.length] === '/')) return to.replace(/[\\/]+$/, '') + path.slice(f.length)
  return undefined
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `AAAA-MM-DD-HHmm.md`, local time. */
export function noteFileName(now: Date = new Date()): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${NOTE_EXTENSION}`
}

/** `name.md`, else `name-2.md`, `name-3.md`… the first that `exists` denies. */
export function uniqueFileName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!exists(candidate)) return candidate
  }
}

/** A name typed in the tab's rename, made a file name: trimmed, path separators and illegal characters out, `.md` appended when missing. */
export function cleanNoteName(typed: string): string | undefined {
  let name = typed.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '')
  if (!name) return undefined
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += NOTE_EXTENSION
  return name
}

/**
 * Whether a `.gitignore` already keeps `.tether/` out: a line of `.tether`, `.tether/`, `/.tether`, `/.tether/`
 * or `**​/.tether/`, with or without surrounding spaces; a negation (`!.tether/`) does not count.
 */
export function gitignoreCovers(text: string): boolean {
  return text.split(/\r?\n/).some(line => /^\s*(\*\*\/|\/)?\.tether\/?\s*$/.test(line))
}

/** The `.gitignore` content with the `.tether/` line added at the end (a newline before it when the file does not end with one). */
export function gitignoreWithTether(text: string): string {
  if (gitignoreCovers(text)) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = text === '' || text.endsWith('\n') ? text : text + eol
  return `${body}${GITIGNORE_LINE}${eol}`
}

export type ExternalChange = 'keep' | 'reload' | 'ask'

/**
 * What a change of the file on disk means for the open note:
 *   keep    the disk holds what the editor already has, or a text we wrote ourselves (`savedText`, or one of
 *           `ownTexts`, the recent writes): our own save echoed by the watcher, possibly late, while the person
 *           kept typing; nothing came from outside, so nothing to ask;
 *   reload  the disk differs and the editor has no pending edit: take the disk's text, keeping the cursor;
 *   ask     the disk differs and the editor has edits not yet written: the person decides.
 */
export function externalChangeAction(input: { diskText: string; editorText: string; savedText: string; ownTexts?: readonly string[] }): ExternalChange {
  if (input.diskText === input.editorText) return 'keep'
  if (input.diskText === input.savedText || (input.ownTexts ?? []).includes(input.diskText)) return 'keep'
  if (input.editorText === input.savedText) return 'reload'
  return 'ask'
}
