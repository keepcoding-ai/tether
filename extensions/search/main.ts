// The search extension's Electron-main side: "Search in files" (service.ts, over the worker thread of
// app/main/text-search-worker.ts, built next to main.cjs) on the bus `ext:search:*`. Every argument comes from the
// renderer and is checked here: the query is rebuilt field by field, the disk replace is limited to the folders of the
// last search. `searchFile` searches one file again (after a replace in it), in this process: a short ripgrep run that
// leaves the worker and its live search alone. The search editor writes its documents through `saveEditor` (in the
// person's configuration folder, outside every project) and searches through `searchOnce`, on a second worker.
import { realpathSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { findRipgrep, isInside } from '../../app/main/file-index.ts'
import { RipgrepTextSearchEngine } from '../../app/main/vscode-ripgrep-text-search.ts'
import { TextSearchManager } from '../../app/main/vscode-text-search-manager.ts'
import { escapeGlobPattern } from '../../app/shared/vscode-search-query.ts'
import { gitChangedFiles } from '../../app/main/git-changed-files.ts'
import { decode, type FileEdits, replaceInFiles } from '../../app/main/search-replace-disk.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { type IExpression, type IFileMatch, type IFolderQuery, type ITextQuery, QueryType } from '../../app/shared/vscode-search.ts'
import type { SearchChannels, SearchOnceResult } from './ipc.ts'
import { editorsToPrune, KEEP_SEARCH_EDITORS, MAX_SEARCH_EDITOR_BYTES, SEARCH_EDITORS_DIR, searchEditorName, SUPERSEDED_MESSAGE } from './renderer/search-editor-rules.ts'
import { SearchService } from './service.ts'

export { manifest } from './manifest.ts'

const MAX_PATTERN = 100_000
const MAX_FOLDERS = 64
const MAX_REPLACE_FILES = 20_000
const DEFAULT_MAX_RESULTS = 20_000
const MAX_RESULTS_LIMIT = 200_000
/** A one-file search that takes longer than this is abandoned (the file keeps the results it has). */
const SEARCH_FILE_TIMEOUT_MS = 15_000
/** The largest file `readText` reads (the replace preview); the openers hand bigger ones to the system's program. */
export const MAX_READ_BYTES = 5 * 1024 * 1024

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

/**
 * The query that searches only `path`, with the content pattern and the preview options of `query`: its folder is the
 * file's, its include the file's name (glob characters escaped). Ignore files and exclusions are left out: the file
 * was already accepted by the search. The encoding and the symbolic link setting come from the searched folder that
 * holds it.
 */
export function fileQuery(query: ITextQuery, path: string): ITextQuery {
  const holder = query.folderQueries.find(f => isInside(f.folder, path))
  const folder: IFolderQuery = {
    folder: dirname(path),
    includePattern: { [escapeGlobPattern(basename(path))]: true },
    disregardIgnoreFiles: true,
    disregardGlobalIgnoreFiles: true,
    disregardParentIgnoreFiles: true,
  }
  if (holder?.fileEncoding !== undefined) folder.fileEncoding = holder.fileEncoding
  if (holder?.ignoreSymlinks !== undefined) folder.ignoreSymlinks = holder.ignoreSymlinks
  if (query.ignoreGlobCase !== undefined) folder.ignoreGlobCase = query.ignoreGlobCase
  const out: ITextQuery = { type: QueryType.Text, folderQueries: [folder], contentPattern: query.contentPattern }
  if (query.maxResults !== undefined) out.maxResults = query.maxResults
  if (query.previewOptions) out.previewOptions = query.previewOptions
  if (query.surroundingContext !== undefined) out.surroundingContext = query.surroundingContext
  if (query.maxFileSize !== undefined) out.maxFileSize = query.maxFileSize
  if (query.ignoreGlobCase !== undefined) out.ignoreGlobCase = query.ignoreGlobCase
  return out
}

const isFile = (p: string): boolean => { try { return statSync(p).isFile() } catch { return false } }

/**
 * Searches one file again: the query is checked as `search` checks it and the file must lie inside its folders (the
 * same real-path guard as the disk replace). Undefined when the file has no match; an error when the arguments are
 * refused or the search fails (the caller leaves the file's results as they are).
 */
export async function searchFile(engine: RipgrepTextSearchEngine | undefined, rawQuery: unknown, path: unknown): Promise<IFileMatch | undefined> {
  const query = sanitizeQuery(rawQuery)
  if (!query) throw new Error('Consulta de pesquisa inválida.')
  if (typeof path !== 'string' || !allowedIn(query.folderQueries.map(f => f.folder))(path)) throw new Error('Arquivo fora das pastas pesquisadas.')
  if (!isFile(path)) return undefined
  if (!engine) throw new Error('O ripgrep não foi encontrado nesta instalação.')
  const results: NonNullable<IFileMatch['results']> = []
  await new TextSearchManager(fileQuery(query, path), engine)
    .search(batch => { for (const f of batch) results.push(...(f.results ?? [])) }, AbortSignal.timeout(SEARCH_FILE_TIMEOUT_MS))
  return results.length > 0 ? { resource: path, results } : undefined
}

export type ReadTextResult = { ok: true; text: string } | { ok: false; message: string }

/**
 * A file's text for the replace preview: only inside the folders of the last search (the disk replace's guard), at most
 * MAX_READ_BYTES, decoded as the disk replace decodes it (the BOM stays out of the text; invalid UTF-8 is refused).
 */
export async function readText(folders: readonly string[], path: unknown): Promise<ReadTextResult> {
  if (typeof path !== 'string' || !allowedIn(folders)(path)) return { ok: false, message: 'Arquivo fora das pastas pesquisadas.' }
  try {
    const st = await stat(path)
    if (!st.isFile()) return { ok: false, message: 'O arquivo não foi encontrado.' }
    if (st.size > MAX_READ_BYTES) return { ok: false, message: 'O arquivo é grande demais para a prévia (mais de 5 MB).' }
    const decoded = decode(await readFile(path))
    if (!decoded) return { ok: false, message: 'A codificação deste arquivo não é suportada.' }
    return { ok: true, text: decoded.text }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, message: 'O arquivo não foi encontrado.' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, message: 'Sem permissão para ler este arquivo.' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export type SaveEditorResult = { ok: true; path: string } | { ok: false; message: string }

/**
 * Writes a search editor's document in `dir` (created when missing) as `Pesquisa-AAAAMMDD-HHMMSS.code-search`, with
 * `-2`, `-3`… when the name is taken (written exclusively: two saves in the same second never share a file); then the
 * folder keeps only the KEEP_SEARCH_EDITORS most recent documents.
 */
export async function saveSearchEditor(dir: string, text: unknown, now = new Date(), keep = KEEP_SEARCH_EDITORS): Promise<SaveEditorResult> {
  if (typeof text !== 'string') return { ok: false, message: 'Documento de pesquisa inválido.' }
  if (Buffer.byteLength(text, 'utf8') > MAX_SEARCH_EDITOR_BYTES) return { ok: false, message: 'O documento de pesquisa é grande demais (mais de 50 MB).' }
  let path: string | undefined
  try {
    await mkdir(dir, { recursive: true })
    for (let attempt = 1; attempt <= 1000 && path === undefined; attempt++) {
      const candidate = join(dir, searchEditorName(now, attempt))
      try {
        await writeFile(candidate, text, { encoding: 'utf8', flag: 'wx' })
        path = candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
      }
    }
  } catch (error) {
    return { ok: false, message: `Não foi possível gravar o documento de pesquisa: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (path === undefined) return { ok: false, message: 'Não foi possível escolher um nome para o documento de pesquisa.' }
  // Pruning is best effort: a document that cannot be removed now goes on a later save.
  try {
    const names = await readdir(dir)
    const entries: { name: string; mtimeMs: number }[] = []
    for (const name of names) {
      try { const st = await stat(join(dir, name)); if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs }) } catch { /* gone meanwhile */ }
    }
    for (const name of editorsToPrune(entries, keep, basename(path))) await unlink(join(dir, name)).catch(() => {})
  } catch { /* the folder cannot be listed: nothing pruned */ }
  return { ok: true, path }
}

/**
 * The search editor's searches: one at a time on a SearchService of their own (its own worker), so the pad's live
 * search is never cancelled by them. The batches are joined and answered at once; a newer call replaces the running
 * one, which answers SUPERSEDED_MESSAGE.
 */
export class SearchOnce {
  private seq = 0
  private readonly service: SearchService
  constructor(service: SearchService) { this.service = service }

  async run(raw: unknown): Promise<SearchOnceResult> {
    const query = sanitizeQuery(raw)
    if (!query) return { ok: false, message: 'Consulta de pesquisa inválida.' }
    const id = ++this.seq
    const matches: IFileMatch[] = []
    const done = await this.service.search(id, query, (_id, batch) => { for (const m of batch) matches.push(m) })
    if (done.kind === 'cancelled') return { ok: false, message: SUPERSEDED_MESSAGE }
    if (done.kind === 'error') return { ok: false, message: done.message, ...(done.code ? { code: done.code } : {}) }
    return { ok: true, matches, limitHit: done.limitHit }
  }

  dispose(): Promise<void> { return this.service.dispose() }
}

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<SearchChannels>()
  const repo = join(main.dist, '..', '..')
  const workerPath = join(main.dist, 'text-search-worker.cjs')
  const service = new SearchService(workerPath, repo)
  const once = new SearchOnce(new SearchService(workerPath, repo))
  let engine: RipgrepTextSearchEngine | undefined
  const rgEngine = (): RipgrepTextSearchEngine | undefined => {
    if (!engine) { const rg = findRipgrep(repo) ?? findRipgrep(); if (rg) engine = new RipgrepTextSearchEngine(rg) }
    return engine
  }
  return [
    ipc.handle('search', (id, raw) => {
      const query = isInt(id) ? sanitizeQuery(raw) : undefined
      if (!isInt(id) || !query) return { started: false, message: 'Consulta de pesquisa inválida.' }
      // The end goes out as an event after the last batch (same path, ordered); the reply only confirms the start.
      void service.search(id, query, (sid, matches) => ipc.send('progress', sid, matches))
        .then(result => ipc.send('done', id, result))
      return { started: true }
    }),
    ipc.on('cancel', id => { if (isInt(id)) service.cancel(id) }),
    ipc.handle('searchFile', (query, path) => searchFile(rgEngine(), query, path)),
    ipc.handle('readText', path => readText(service.folders(), path)),
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
    ipc.handle('saveEditor', text => saveSearchEditor(join(main.userDir, SEARCH_EDITORS_DIR), text)),
    ipc.handle('searchOnce', query => once.run(query)),
    { dispose: () => { void service.dispose(); void once.dispose() } },
  ]
}
