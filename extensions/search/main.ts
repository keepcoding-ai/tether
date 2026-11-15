// The search extension's Electron-main side: "Search in files" (service.ts, over the worker thread of
// app/main/text-search-worker.ts, built next to main.cjs) on the bus `ext:search:*`. Every argument comes from the
// renderer and is checked here: the query is rebuilt field by field, the disk replace is limited to the folders of the
// last search.
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { isInside } from '../../app/main/file-index.ts'
import { gitChangedFiles } from '../../app/main/git-changed-files.ts'
import { type FileEdits, replaceInFiles } from '../../app/main/search-replace-disk.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { type IExpression, type IFolderQuery, type ITextQuery, QueryType } from '../../app/shared/vscode-search.ts'
import type { SearchChannels } from './ipc.ts'
import { SearchService } from './service.ts'

export { manifest } from './manifest.ts'

const MAX_PATTERN = 100_000
const MAX_FOLDERS = 64
const MAX_REPLACE_FILES = 20_000
const DEFAULT_MAX_RESULTS = 20_000
const MAX_RESULTS_LIMIT = 200_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isDir(p: unknown): p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) return false
  try { return statSync(p).isDirectory() } catch { return false }
}

/** An IExpression: an object of string keys to booleans (sibling clauses are not accepted from the renderer). */
function expression(v: unknown): IExpression | undefined {
  if (!isObject(v)) return undefined
  const out: IExpression = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'boolean') return undefined
    out[k] = val
  }
  return out
}

function folderQuery(v: unknown): IFolderQuery | undefined {
  if (!isObject(v) || !isDir(v.folder)) return undefined
  const q: IFolderQuery = { folder: v.folder }
  if (typeof v.folderName === 'string') q.folderName = v.folderName
  const inc = expression(v.includePattern)
  if (inc) q.includePattern = inc
  if (Array.isArray(v.excludePattern)) {
    const ex: NonNullable<IFolderQuery['excludePattern']> = []
    for (const item of v.excludePattern) {
      if (!isObject(item)) continue
      const pattern = expression(item.pattern)
      if (pattern) ex.push({ pattern, ...(typeof item.folder === 'string' ? { folder: item.folder } : {}) })
    }
    q.excludePattern = ex
  }
  if (typeof v.ignoreGlobCase === 'boolean') q.ignoreGlobCase = v.ignoreGlobCase
  if (typeof v.fileEncoding === 'string') q.fileEncoding = v.fileEncoding
  if (typeof v.disregardIgnoreFiles === 'boolean') q.disregardIgnoreFiles = v.disregardIgnoreFiles
  if (typeof v.disregardGlobalIgnoreFiles === 'boolean') q.disregardGlobalIgnoreFiles = v.disregardGlobalIgnoreFiles
  if (typeof v.disregardParentIgnoreFiles === 'boolean') q.disregardParentIgnoreFiles = v.disregardParentIgnoreFiles
  if (typeof v.ignoreSymlinks === 'boolean') q.ignoreSymlinks = v.ignoreSymlinks
  return q
}

/** Rebuilds a search query from what the renderer sent, keeping only known fields of the right type; undefined when it is unusable. */
export function sanitizeQuery(raw: unknown): ITextQuery | undefined {
  if (!isObject(raw) || !isObject(raw.contentPattern)) return undefined
  const cp = raw.contentPattern
  if (typeof cp.pattern !== 'string' || cp.pattern === '' || cp.pattern.length > MAX_PATTERN) return undefined
  if (!Array.isArray(raw.folderQueries) || raw.folderQueries.length < 1 || raw.folderQueries.length > MAX_FOLDERS) return undefined
  const folderQueries: IFolderQuery[] = []
  for (const f of raw.folderQueries) {
    const q = folderQuery(f)
    if (!q) return undefined
    folderQueries.push(q)
  }
  const contentPattern: ITextQuery['contentPattern'] = { pattern: cp.pattern }
  for (const k of ['isRegExp', 'isWordMatch', 'isMultiline', 'isUnicode', 'isCaseSensitive'] as const) {
    if (typeof cp[k] === 'boolean') contentPattern[k] = cp[k]
  }
  if (typeof cp.wordSeparators === 'string') contentPattern.wordSeparators = cp.wordSeparators
  const query: ITextQuery = {
    type: QueryType.Text,
    folderQueries,
    contentPattern,
    maxResults: isNum(raw.maxResults) ? Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.trunc(raw.maxResults))) : DEFAULT_MAX_RESULTS,
  }
  const inc = expression(raw.includePattern)
  if (inc) query.includePattern = inc
  const exc = expression(raw.excludePattern)
  if (exc) query.excludePattern = exc
  if (typeof raw.ignoreGlobCase === 'boolean') query.ignoreGlobCase = raw.ignoreGlobCase
  if (isObject(raw.previewOptions) && isNum(raw.previewOptions.matchLines) && isNum(raw.previewOptions.charsPerLine)) {
    query.previewOptions = { matchLines: raw.previewOptions.matchLines, charsPerLine: raw.previewOptions.charsPerLine }
  }
  if (isNum(raw.surroundingContext)) query.surroundingContext = Math.min(100, Math.max(0, Math.trunc(raw.surroundingContext)))
  if (isNum(raw.maxFileSize)) query.maxFileSize = raw.maxFileSize
  return query
}

function realOf(p: string): string | undefined {
  try { return realpathSync(p) } catch { return undefined }
}

/**
 * The disk-replace guard: the path lies inside one of the searched folders AND so does its real path (a link inside
 * the project that leads outside is refused). A file that does not exist passes: replacing reports it as missing.
 */
export function allowedIn(folders: readonly string[]): (path: string) => boolean {
  return path => {
    if (!isAbsolute(path) || !folders.some(f => isInside(f, path))) return false
    const real = realOf(path)
    if (real === undefined) return true
    return folders.some(f => {
      const realFolder = realOf(f)
      return realFolder !== undefined && (realFolder === real || isInside(realFolder, real))
    })
  }
}

/** The shape of the files to replace in, or an empty list when anything is off. */
export function sanitizeReplace(raw: unknown): FileEdits[] {
  if (!Array.isArray(raw) || raw.length > MAX_REPLACE_FILES) return []
  const out: FileEdits[] = []
  for (const f of raw) {
    if (!isObject(f) || typeof f.path !== 'string' || !isAbsolute(f.path) || !Array.isArray(f.edits)) return []
    const edits: FileEdits['edits'] = []
    for (const e of f.edits) {
      if (!isObject(e) || !isObject(e.range) || typeof e.expected !== 'string' || typeof e.text !== 'string') return []
      const r = e.range
      if (!isInt(r.startLineNumber) || !isInt(r.startColumn) || !isInt(r.endLineNumber) || !isInt(r.endColumn)) return []
      if (r.startLineNumber < 1 || r.startColumn < 1 || r.endLineNumber < 1 || r.endColumn < 1) return []
      edits.push({
        range: { startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn },
        expected: e.expected,
        text: e.text,
      })
    }
    out.push({ path: f.path, edits })
  }
  return out
}

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<SearchChannels>()
  const service = new SearchService(join(main.dist, 'text-search-worker.cjs'), join(main.dist, '..', '..'))
  return [
    ipc.handle('search', (id, raw) => {
      const query = isInt(id) ? sanitizeQuery(raw) : undefined
      if (!isInt(id) || !query) return { kind: 'error', message: 'Consulta de pesquisa inválida.' }
      return service.search(id, query, (sid, matches) => ipc.send('progress', sid, matches))
    }),
    ipc.on('cancel', id => { if (isInt(id)) service.cancel(id) }),
    ipc.handle('replace', files => replaceInFiles(sanitizeReplace(files), { allowed: allowedIn(service.folders()) })),
    ipc.handle('changedFiles', async folders => {
      if (!Array.isArray(folders) || folders.length > MAX_FOLDERS) return []
      const seen = new Set<string>()
      for (const f of folders) {
        if (!isDir(f)) continue
        for (const p of await gitChangedFiles(f)) seen.add(p)
      }
      return [...seen]
    }),
    { dispose: () => { void service.dispose() } },
  ]
}
