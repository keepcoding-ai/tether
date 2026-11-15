// Opening a file, the part both sides know (core, F9 slice 2): where and at what position a file opens, and what
// opening a path means (main inspects it). Ctrl+P (the quick-open extension), a Ctrl+click on a terminal path and the
// extensions' "open the source file" all go through here; the extensions that open the file register as openers.

/**
 * `file:42` / `file:42:7`: a line, and a column when given. `endLine`/`endColumn` (1-based, end exclusive, UTF-16 units
 * like Monaco's columns) turn the position into a selected range; `endColumn` without `endLine` ends on `line`.
 */
export interface LineColumn { line: number; column?: number; endLine?: number; endColumn?: number }

/** What opening a path means (main inspects the file): the editor, the system's program, or a clear refusal. */
export type FileTarget =
  | { kind: 'text'; size: number }
  | { kind: 'binary'; size: number; runnable: boolean }
  | { kind: 'large'; size: number; runnable: boolean }
  | { kind: 'missing' }
  | { kind: 'folder' }
