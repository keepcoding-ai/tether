/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *--------------------------------------------------------------------------------------------*/
// The explorer's file name rules (F8 slice 5), pure. Ported from VS Code @7faf984: `validateFileName` and
// `getWellFormedFileName` (src/vs/workbench/contrib/files/browser/fileActions.ts), `isValidBasename`
// (src/vs/base/common/extpath.ts) and the rename selection (explorerViewer.ts: the name without its extension).
// Changes: messages in Portuguese; the siblings are a list of names (not an ExplorerItem); a nested name ("a/b.txt") is
// allowed when creating (the folders on the way are made, as in VS Code) and refused when renaming (renaming stays in
// the same folder here).

const WINDOWS_INVALID_FILE_CHARS = /[\\/:*?"<>|]/
const UNIX_INVALID_FILE_CHARS = /[/]/
const WINDOWS_FORBIDDEN_NAMES = /^(con|prn|aux|clock\$|nul|lpt[0-9]|com[0-9])(\.(.*?))?$/i
/** Most file systems refuse a longer name. */
const MAX_NAME = 255

/** VS Code's isValidBasename: one path segment the file system accepts. */
export function isValidBasename(name: string | null | undefined, isWindows: boolean): boolean {
  if (!name || name.length === 0 || /^\s+$/.test(name)) return false
  if ((isWindows ? WINDOWS_INVALID_FILE_CHARS : UNIX_INVALID_FILE_CHARS).test(name)) return false
  if (isWindows && WINDOWS_FORBIDDEN_NAMES.test(name)) return false
  if (name === '.' || name === '..') return false
  if (isWindows && name[name.length - 1] === '.') return false // Windows: a name cannot end with a dot
  if (isWindows && name.length !== name.trim().length) return false // Windows: nor with a space
  if (name.length > MAX_NAME) return false
  return true
}

/** VS Code's getWellFormedFileName: tabs trimmed, trailing slashes dropped. */
export function wellFormedFileName(name: string): string {
  if (!name) return name
  return name.replace(/^\t+|\t+$/g, '').replace(/[\\/]+$/, '')
}

export interface NameProblem { message: string; severity: 'error' | 'warning' }

export interface ValidateOptions {
  /** The names already in the folder (the row being renamed included). */
  siblings: readonly string[]
  /** The name being renamed; undefined when creating. */
  current?: string
  isWindows: boolean
}

const trimLong = (name: string): string => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}…` : name)

/** VS Code's validateFileName: null when the name can be used; an error blocks, a warning only informs. */
export function validateFileName(raw: string, opts: ValidateOptions): NameProblem | null {
  const name = wellFormedFileName(raw)
  if (!name || name.length === 0 || /^\s+$/.test(name)) return { message: 'Digite um nome de arquivo ou pasta.', severity: 'error' }
  if (name[0] === '/' || name[0] === '\\') return { message: 'O nome não pode começar com uma barra.', severity: 'error' }
  const names = name.split(/[\\/]/).filter(s => s !== '')
  if (opts.current !== undefined && names.length > 1) return { message: 'Para renomear, use um nome sem barras.', severity: 'error' }
  if (name !== opts.current) {
    // Windows ignores case: "A.md" next to "a.md" is the same file, but renaming "a.md" to "A.md" is a change of case only.
    const key = (s: string): string => (opts.isWindows ? s.toLowerCase() : s)
    const caseOnly = opts.current !== undefined && key(name) === key(opts.current)
    if (!caseOnly && opts.siblings.some(s => key(s) === key(name))) {
      return { message: `Já existe um arquivo ou pasta "${name}" aqui. Escolha outro nome.`, severity: 'error' }
    }
  }
  if (names.some(n => !isValidBasename(n, opts.isWindows))) {
    return { message: `"${trimLong(name)}" não é um nome válido de arquivo ou pasta. Escolha outro nome.`, severity: 'error' }
  }
  if (names.some(n => /^\s|\s$/.test(n))) return { message: 'O nome começa ou termina com espaço.', severity: 'warning' }
  return null
}

/** The part of the name the rename field selects: the name without its extension (a folder, or ".env", selects it whole). */
export function renameSelection(name: string, isDir: boolean): { start: number; end: number } {
  const dot = name.lastIndexOf('.')
  return { start: 0, end: dot > 0 && !isDir ? dot : name.length }
}
