// Quick Open (Ctrl+P), the part both sides know: what a search returns (app/main/file-index.ts builds it, the
// palette shows it), what opening a file means, and the rules that need no DOM (unit-tested): the `:line:col`
// suffix, the history of opened files, the icon of a file type.
import type { IMatch } from './vscode-fuzzy-scorer.ts'

export type { IMatch }

export type ListSource = 'rg' | 'git' | 'walk'

export interface QuickOpenItem {
  /** Absolute path. */
  path: string
  /** File name. */
  label: string
  /** Folder relative to the root ('' at the root itself). */
  description: string
  labelMatch: IMatch[]
  descriptionMatch: IMatch[]
}

export interface QuickOpenResult {
  root: string
  /** Recently opened files under the root: all of them in history order without a query, the matching ones ranked with one. */
  recent: QuickOpenItem[]
  files: QuickOpenItem[]
  /** Files in the list (what was searched). */
  total: number
  source: ListSource | undefined
  /** The safety cap cut the list. */
  truncated: boolean
  /** The list is still being read (first time for the root) or rebuilt: search again shortly for the full answer. */
  pending: boolean
  /** Milliseconds the last complete listing took, and this search. */
  listMs: number | undefined
  searchMs: number
}

/** What opening a path means (main inspects the file): the editor, the system's program, or a clear refusal. */
export type QuickOpenTarget =
  | { kind: 'text'; size: number }
  | { kind: 'binary'; size: number; runnable: boolean }
  | { kind: 'large'; size: number; runnable: boolean }
  | { kind: 'missing' }
  | { kind: 'folder' }

// ---------- `file:42` / `file:42:7` ----------

export interface LineColumn { line: number; column?: number }

/**
 * The query without a trailing `:line` / `:line:col` (also `#line`, VS Code's other spelling), and the position.
 * `app.ts:42` → { query: 'app.ts', line: 42 }; `x.ts:3:7` → column 7; `x.ts:` → the query only (position still being typed).
 */
export function parseLineSuffix(text: string): { query: string; position?: LineColumn } {
  const m = /^(.*?)(?:[:#](\d*)(?::(\d*))?)\s*$/.exec(text)
  if (!m || m[1] === undefined || m[1].trim() === '') return { query: text }
  const query = m[1]
  const line = m[2] ? Number(m[2]) : NaN
  if (!Number.isFinite(line) || line < 1) return { query }
  const column = m[3] ? Number(m[3]) : NaN
  return { query, position: Number.isFinite(column) && column >= 1 ? { line, column } : { line } }
}

// ---------- history of opened files ----------

/** How many opened files the history keeps (VS Code's editor history keeps 200). */
export const HISTORY_MAX = 200

/** The history with `path` on top (case-insensitive duplicates removed on Windows/macOS), capped. */
export function pushHistory(history: readonly string[], path: string, caseSensitive = false, max = HISTORY_MAX): string[] {
  const key = (p: string): string => (caseSensitive ? p : p.toLowerCase())
  const k = key(path)
  return [path, ...history.filter(p => key(p) !== k)].slice(0, max)
}

/** Parses the stored history; anything malformed is an empty history. */
export function readHistory(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX) : []
  } catch { return [] }
}

// ---------- icon by type ----------

const EXT_ICON: Record<string, string> = {
  ts: 'file-ts', mts: 'file-ts', cts: 'file-ts', tsx: 'file-tsx',
  js: 'file-js', mjs: 'file-js', cjs: 'file-js', jsx: 'file-jsx',
  json: 'brackets-curly', jsonc: 'brackets-curly',
  md: 'file-md', markdown: 'file-md',
  css: 'file-css', scss: 'file-css', less: 'file-css',
  html: 'file-html', htm: 'file-html',
  py: 'file-py', rs: 'file-rs', sql: 'file-sql', vue: 'file-vue', svg: 'file-svg', csv: 'file-csv',
  c: 'file-c', h: 'file-c', cpp: 'file-cpp', cs: 'file-c-sharp',
  png: 'file-image', jpg: 'file-image', jpeg: 'file-image', gif: 'file-image', webp: 'file-image', ico: 'file-image', bmp: 'file-image',
  pdf: 'file-pdf', zip: 'file-zip', '7z': 'file-zip', gz: 'file-zip', tgz: 'file-zip', tar: 'file-zip', rar: 'file-zip',
  ps1: 'terminal', psm1: 'terminal', sh: 'terminal', bash: 'terminal', zsh: 'terminal', bat: 'terminal', cmd: 'terminal',
  yaml: 'gear-six', yml: 'gear-six', toml: 'gear-six', ini: 'gear-six', env: 'gear-six', lock: 'file-lock',
  txt: 'file-text', log: 'file-text',
}

/** The Phosphor icon for a file name (by extension; a generic file otherwise). */
export function fileIcon(name: string): string {
  const lower = name.toLowerCase()
  const i = lower.lastIndexOf('.')
  const ext = i < 0 ? '' : lower.slice(i + 1)
  return EXT_ICON[ext] ?? (lower.startsWith('.') ? 'gear-six' : 'file')
}
