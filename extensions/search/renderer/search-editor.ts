// The search editor: a `.code-search` document opened in the note editor (its tab, editing, undo, saving and restoring
// are the note's). This module gives the document its language and its behaviour:
//   - the `search-result` language for `.code-search` files: a Monarch grammar (the header, the count line, the file
//     lines, the numbers of the result and context lines);
//   - Ctrl+click (a link of Monaco) and F12 on a file line open the file; on a result or context line, the file at that
//     line (and, on a result line, at the first match's column when its decoration is known);
//   - the matches decorated (after "Abrir novo editor de pesquisa" and after "pesquisar de novo"; a document opened
//     again from disk has none until it is searched again, as in VS Code);
//   - "pesquisar de novo" (command and Ctrl+Shift+R): the header is the query, run on main's `searchOnce` (a worker of
//     its own: the pad's live search goes on), and the body is rewritten in one undo step.
// No CodeLens over the first line (VS Code has none either, its query widget holds the button): the app's Monaco is built
// without the CodeLens contribution (app/renderer/monaco.ts).
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/searchEditor/browser/searchEditor.ts (doRunSearch, the match decorations)
//   extensions/search-result/src/extension.ts (the language: links, definition, the line grammar)
// Changes: the document is a plain file in the note editor (no query widget above it): the header is the query and is
// edited as text. The open editors' unsaved text is not searched (the disk is); the note writes itself a moment after
// each edit.
import type { TetherUi } from '../../../app/renderer/ext-api.ts'
import { monaco } from '../../../app/renderer/monaco.ts'
import type { DialogSpec } from '../../../app/shared/dialog.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { extractSearchQueryFromLines, serializeSearchResultForEditor, type SearchConfiguration, type SearchEditorRange } from '../../../app/shared/vscode-search-editor-serialization.ts'
import { dirname, SearchModel } from '../../../app/shared/vscode-search-model.ts'
import { QueryBuilder, type SearchFolder } from '../../../app/shared/vscode-search-query.ts'
import type { IFileMatch, ITextQuery } from '../../../app/shared/vscode-search.ts'
import type { SearchChannels } from '../ipc.ts'
import {
  classifyLines, composeDocument, headerLines, labelCandidates, labelFor, ownerOf, SEARCH_EDITOR_EXTENSION, SEARCH_RESULT_LANGUAGE, SUPERSEDED_MESSAGE,
  targetColumn,
} from './search-editor-rules.ts'
import { openPaneFiles, queryEnv, queryOptions, type QueryFields } from './view.ts'
import { engineErrorText, NO_FOLDER_MESSAGE, readSortOrder } from './view-rules.ts'

const PLATFORM: 'win32' | 'posix' = /^win/i.test(navigator.platform) ? 'win32' : 'posix'
const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)
/** The class of a match in the document. */
export const MATCH_CLASS = 'srch-ed-match'
/** The scheme of the document's links: the opener below follows them (they name the document and its line). */
const LINK_SCHEME = 'tether-search-editor'
/** How long an opened document is waited for (its text loaded in the note) to put its decorations on. */
const DECORATE_WAIT_MS = 15_000

type TextModel = monaco.editor.ITextModel
type Editor = monaco.editor.ICodeEditor
const LF = monaco.editor.EndOfLinePreference.LF

export const isSearchEditorPath = (path: string): boolean => path.toLowerCase().endsWith(SEARCH_EDITOR_EXTENSION)

export interface SearchEditorDocument { text: string; matchRanges: readonly SearchEditorRange[] }

export interface SearchEditorSnapshot {
  path: string
  language: string
  text: string
  /** The decorated matches, in document order. */
  matches: SearchEditorRange[]
  canUndo: boolean
}

/** Monarch grammar of a `.code-search` document; the tokens are ones the app's two themes colour. */
const GRAMMAR: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenizer: {
    root: [
      [/^(# [^:]*:)(.*)$/, ['comment', 'string']],
      [/^#.*$/, 'comment'],
      [/^(?:\d+ resultados? - \d+ arquivos?|Nenhum resultado)$/, 'comment'],
      [/^O conjunto de resultados contém só parte das ocorrências\..*$/, 'comment'],
      [/^(\s+\d+:)(.*)$/, ['number', '']],
      [/^(\s+\d+)(\s\s.*)$/, ['comment', '']],
      [/^\S.*:$/, 'keyword'],
      [/.+$/, ''],
    ],
  },
}

export class SearchEditors {
  private readonly ui: TetherUi
  private readonly ipc: UiIpc<SearchChannels>
  private readonly decorations = new WeakMap<TextModel, string[]>()
  /** Documents opened from the pad whose decorations wait for their text to load in the note. */
  private readonly waiting = new Set<IDisposable>()
  private rerunSeq = 0
  private disposed = false
  private links: monaco.languages.LinkProvider | undefined

  constructor(ui: TetherUi) {
    this.ui = ui
    this.ipc = ui.ipc<SearchChannels>()
  }

  activate(): IDisposable[] {
    const subs: IDisposable[] = []
    // A language cannot be unregistered: once registered it stays (the extension switched off and on reuses it).
    if (!monaco.languages.getLanguages().some(l => l.id === SEARCH_RESULT_LANGUAGE)) {
      monaco.languages.register({ id: SEARCH_RESULT_LANGUAGE, extensions: [SEARCH_EDITOR_EXTENSION], aliases: ['Resultado da pesquisa'] })
    }
    subs.push(monaco.languages.setMonarchTokensProvider(SEARCH_RESULT_LANGUAGE, GRAMMAR))
    // Models made before the language existed (a layout restored before this extension) got plain text.
    for (const m of monaco.editor.getModels()) {
      if (m.uri.scheme === 'file' && isSearchEditorPath(m.uri.fsPath) && m.getLanguageId() !== SEARCH_RESULT_LANGUAGE) monaco.editor.setModelLanguage(m, SEARCH_RESULT_LANGUAGE)
    }
    this.links = { provideLinks: model => ({ links: this.linksOf(model) }) }
    subs.push(monaco.languages.registerLinkProvider(SEARCH_RESULT_LANGUAGE, this.links))
    // Registered after the app's own link opener (installMonacoLinks runs before the extensions): Monaco asks the newest first.
    subs.push(monaco.editor.registerLinkOpener({
      open: resource => {
        if (resource.scheme !== LINK_SCHEME) return false
        const params = new URLSearchParams(resource.query)
        const model = monaco.editor.getModel(monaco.Uri.parse(params.get('doc') ?? ''))
        const line = Number(params.get('line'))
        if (model && Number.isInteger(line)) void this.goTo(model, line)
        return true
      },
    }))
    subs.push({ dispose: () => { this.disposed = true; for (const w of [...this.waiting]) w.dispose() } })
    return subs
  }

  // ---------- opening from the pad ----------

  /** Writes the document (main) and opens it in the note editor; its matches are decorated once its text is in. */
  async open(doc: SearchEditorDocument): Promise<void> {
    const r = await this.ipc.invoke('saveEditor', doc.text).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }))
    if (this.disposed) return
    if (!r.ok) { this.warn(r.message); return }
    this.decorateWhenLoaded(monaco.Uri.file(r.path), doc)
    await this.ui.openers.open(r.path, { side: false, root: dirname(r.path) })
  }

  /** The note creates the model empty and then puts the file's text in: the decorations go on once the text is the document's. */
  private decorateWhenLoaded(uri: monaco.Uri, doc: SearchEditorDocument): void {
    const key = uri.toString()
    const listeners: IDisposable[] = []
    const done: IDisposable = {
      dispose: () => { clearTimeout(timer); for (const l of listeners) l.dispose(); listeners.length = 0; this.waiting.delete(done) },
    }
    const timer = setTimeout(() => done.dispose(), DECORATE_WAIT_MS)
    const tryModel = (m: TextModel): boolean => {
      if (m.isDisposed() || m.getValue(LF) !== doc.text) return false
      this.decorate(m, doc.matchRanges)
      done.dispose()
      return true
    }
    const watch = (m: TextModel): void => {
      if (m.uri.toString() !== key || tryModel(m)) return
      listeners.push(m.onDidChangeContent(() => { tryModel(m) }))
    }
    this.waiting.add(done)
    listeners.push(monaco.editor.onDidCreateModel(watch))
    const existing = monaco.editor.getModel(uri)
    if (existing) watch(existing)
  }

  private decorate(model: TextModel, ranges: readonly SearchEditorRange[]): void {
    const old = this.decorations.get(model) ?? []
    const ids = model.deltaDecorations(old, ranges.map(range => ({
      range,
      options: { description: 'search-editor-match', className: MATCH_CLASS, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    })))
    this.decorations.set(model, ids)
  }

  /** The decorated matches of a model, in document order. */
  private matchesOf(model: TextModel): monaco.Range[] {
    return (this.decorations.get(model) ?? [])
      .map(id => model.getDecorationRange(id))
      .filter((r): r is monaco.Range => r !== null && !r.isEmpty())
      .sort(monaco.Range.compareRangesUsingStarts)
  }

  // ---------- the document's links and "go to the file" ----------

  /** The document's links: each file label, and the number and the text of each result or context line. */
  private linksOf(model: TextModel): monaco.languages.ILink[] {
    const lines = model.getLinesContent()
    const classified = classifyLines(lines)
    const links: monaco.languages.ILink[] = []
    const url = (line: number): monaco.Uri => monaco.Uri.from({ scheme: LINK_SCHEME, path: '/', query: new URLSearchParams({ doc: model.uri.toString(), line: String(line) }).toString() })
    classified.forEach((c, i) => {
      const n = i + 1
      const text = lines[i] ?? ''
      if (c.kind === 'file') links.push({ range: new monaco.Range(n, 1, n, c.label.length + 1), url: url(n), tooltip: 'Abrir o arquivo' })
      else if (c.kind === 'result' || c.kind === 'context') {
        // Two links: the number, and the text (a path inside the text found by the app's own link detection replaces only the second).
        links.push({ range: new monaco.Range(n, 1, n, c.prefix - 1), url: url(n), tooltip: 'Abrir o arquivo nesta linha' })
        if (text.length > c.prefix) links.push({ range: new monaco.Range(n, c.prefix + 1, n, text.length + 1), url: url(n), tooltip: 'Abrir o arquivo nesta linha' })
      }
    })
    return links
  }

  /**
   * Opens what line `lineNumber` of the document names: a file line its file; a result or context line its file at that
   * line (a result line at its first decorated match's column). The label is resolved against the open projects now.
   */
  async goTo(model: TextModel, lineNumber: number): Promise<boolean> {
    const lines = model.getLinesContent()
    const classified = classifyLines(lines)
    const c = classified[lineNumber - 1]
    if (!c || (c.kind !== 'file' && c.kind !== 'result' && c.kind !== 'context')) return false
    const label = ownerOf(classified, lineNumber - 1)
    if (label === undefined) return false
    const firstMatch = c.kind === 'result' ? this.matchesOf(model).find(r => r.startLineNumber === lineNumber) : undefined
    const position = c.kind === 'file' ? undefined : { line: c.lineNumber, column: targetColumn(c, firstMatch?.startColumn) }
    const path = await this.resolve(label)
    if (this.disposed) return false
    if (!path) { this.warn(`Arquivo não encontrado: ${label}`); return false }
    const root = this.ui.workspace.folderOf(path)?.path ?? dirname(path)
    await this.ui.openers.open(path, { side: false, root, ...(position ? { position } : {}) })
    return true
  }

  /** The first candidate path of a label that exists as a file. */
  private async resolve(label: string): Promise<string | undefined> {
    for (const p of labelCandidates(label, this.roots(), PLATFORM)) {
      const target = await window.tether.inspectFile(p).catch(() => undefined)
      if (target && target.kind !== 'missing' && target.kind !== 'folder') return p
    }
    return undefined
  }

  /** F12: the line under the cursor of the active search editor. */
  goToActive(): void {
    const active = this.active()
    const line = active?.editor?.getPosition()?.lineNumber
    if (active && line !== undefined) void this.goTo(active.model, line)
  }

  // ---------- "pesquisar de novo" ----------

  /** Ctrl+Shift+R / the command: the active pane, when it is a search editor. */
  rerunActive(): void {
    const active = this.active()
    if (active) void this.rerun(active.model, active.editor)
  }

  /**
   * Searches again with the document's header and rewrites the whole document (the header normalized, the results with
   * their context lines) in one undo step; the matches are decorated again and the cursor goes to the `# Query:` line.
   * A header that cannot be read, an empty term or an engine error leave the text as it is (with a warning).
   */
  async rerun(model: TextModel, editor: Editor | undefined): Promise<boolean> {
    let config: SearchConfiguration
    try {
      config = extractSearchQueryFromLines(headerLines(model.getLinesContent()))
    } catch (e) {
      this.warn(e instanceof Error ? e.message : String(e))
      return false
    }
    if (config.query === '') { this.warn('O cabeçalho não tem termo de pesquisa: escreva-o depois de “# Query: ”.'); return false }
    const contextLines = Number.isFinite(config.contextLines) ? Math.min(100, Math.max(0, Math.trunc(config.contextLines))) : 0
    config = { ...config, contextLines }
    const folders = this.roots()
    if (folders.length === 0) { this.warn(NO_FOLDER_MESSAGE); return false }
    const fields: QueryFields = {
      search: config.query, regex: config.isRegexp, caseSensitive: config.isCaseSensitive, wholeWord: config.matchWholeWord,
      include: config.filesToInclude, exclude: config.filesToExclude, useExcludesAndIgnoreFiles: config.useExcludeSettingsAndIgnoreFiles,
      onlyOpenEditors: config.onlyOpenEditors,
    }
    let query: ITextQuery
    try {
      const key = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p)
      const builder = new QueryBuilder(queryEnv(this.ui, folders, () => openPaneFiles(this.ui, key)))
      query = builder.text({ pattern: fields.search, isRegExp: fields.regex, isCaseSensitive: fields.caseSensitive, isWordMatch: fields.wholeWord }, folders, queryOptions(this.ui, fields))
    } catch (e) {
      this.warn(e instanceof Error ? e.message : String(e))
      return false
    }
    if (contextLines > 0) query.surroundingContext = contextLines
    const seq = ++this.rerunSeq
    let matches: IFileMatch[] = []
    let limitHit = false
    // Nothing the header allows lies in the projects (only open editors, none open): nothing to ask the engine.
    if (query.folderQueries.length > 0) {
      const r = await this.ipc.invoke('searchOnce', query).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }))
      if (this.disposed || seq !== this.rerunSeq) return false
      if (!r.ok) {
        // A newer "pesquisar de novo" took its place: that one answers.
        if (r.message !== SUPERSEDED_MESSAGE) this.warn(engineErrorText(r))
        return false
      }
      matches = r.matches
      limitHit = r.limitHit
    }
    if (model.isDisposed()) return false
    const doc = this.serialize(query, matches, config, folders, limitHit)
    const end = new monaco.Selection(1, model.getLineMaxColumn(1), 1, model.getLineMaxColumn(1))
    model.pushStackElement()
    model.pushEditOperations(editor?.getSelections() ?? [], [{ range: model.getFullModelRange(), text: doc.text }], () => [end])
    model.pushStackElement()
    this.decorate(model, doc.matchRanges)
    if (editor && editor.getModel() === model) {
      const column = model.getLineMaxColumn(1)
      editor.setPosition({ lineNumber: 1, column })
      editor.revealLine(1)
    }
    return true
  }

  /** The document of a search's results: a results model of its own, serialized with the header's context lines. */
  private serialize(query: ITextQuery, matches: IFileMatch[], config: SearchConfiguration, roots: SearchFolder[], limitHit: boolean): SearchEditorDocument {
    const model = new SearchModel({ caseInsensitive: CASE_INSENSITIVE })
    try {
      model.query = query
      model.searchResult.add(matches, true)
      const out = serializeSearchResultForEditor(model.searchResult, config.filesToInclude, config.filesToExclude, config.contextLines, p => labelFor(p, roots, PLATFORM),
        readSortOrder(this.ui.settings.get<string>('sortOrder')), limitHit)
      return composeDocument(config, out)
    } finally {
      model.dispose()
    }
  }

  // ---------- helpers ----------

  private roots(): SearchFolder[] {
    return this.ui.workspace.folders().filter(f => !f.missing).map(f => ({ path: f.path, name: f.name }))
  }

  /** The active pane's search editor (its model, and the editor that shows it there). */
  private active(): { model: TextModel; editor: Editor | undefined } | undefined {
    const id = this.ui.panes.activeId() ?? this.ui.panes.deskActiveId()
    const file = id ? this.ui.panes.describe(id)?.file : undefined
    if (!file || !isSearchEditorPath(file)) return undefined
    const model = monaco.editor.getModel(monaco.Uri.file(file))
    return model ? { model, editor: this.editorOf(model) } : undefined
  }

  /** The editor showing the model: the one with the keyboard, else one on screen, else any. */
  private editorOf(model: TextModel): Editor | undefined {
    const editors = monaco.editor.getEditors().filter(e => e.getModel() === model)
    return editors.find(e => e.hasTextFocus()) ?? editors.find(e => (e.getDomNode()?.offsetWidth ?? 0) > 0) ?? editors[0]
  }

  private warn(message: string): void {
    const spec: DialogSpec = {
      situation: 'search-editor-warning',
      tone: 'warn',
      icon: 'warning',
      title: 'Editor de pesquisa',
      message,
      choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'O documento fica como está.', tone: 'neutral' }],
      escChoice: 'ok',
    }
    void this.ui.dialogs.ask(spec)
  }

  // ---------- test hooks ----------

  snapshot(): SearchEditorSnapshot[] {
    return monaco.editor.getModels()
      .filter(m => m.uri.scheme === 'file' && isSearchEditorPath(m.uri.fsPath))
      .map(m => ({
        path: m.uri.fsPath,
        language: m.getLanguageId(),
        text: m.getValue(LF),
        matches: this.matchesOf(m).map(r => ({ startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn })),
        canUndo: m.canUndo(),
      }))
  }

  /** The links the language gives a document (what Ctrl+click follows): range and target line. */
  linksFor(path: string): { range: SearchEditorRange; line: number }[] {
    const model = monaco.editor.getModel(monaco.Uri.file(path))
    if (!model) return []
    return this.linksOf(model).map(l => ({
      range: { startLineNumber: l.range.startLineNumber, startColumn: l.range.startColumn, endLineNumber: l.range.endLineNumber, endColumn: l.range.endColumn },
      line: Number(new URLSearchParams(typeof l.url === 'string' ? '' : l.url?.query ?? '').get('line')),
    }))
  }

  /** Page coordinates of a document position in the editor that shows it (for a real Ctrl+click). */
  pointOf(path: string, line: number, column: number): { x: number; y: number } | undefined {
    const model = monaco.editor.getModel(monaco.Uri.file(path))
    const editor = model ? this.editorOf(model) : undefined
    const node = editor?.getDomNode()
    if (!editor || !node) return undefined
    editor.revealLine(line, monaco.editor.ScrollType.Immediate)
    const pos = editor.getScrolledVisiblePosition({ lineNumber: line, column })
    if (!pos) return undefined
    const box = node.getBoundingClientRect()
    return { x: box.left + pos.left + 2, y: box.top + pos.top + pos.height / 2 }
  }

  /** Runs "pesquisar de novo" on a document and says whether it rewrote it. */
  rerunPath(path: string): Promise<boolean> {
    const model = monaco.editor.getModel(monaco.Uri.file(path))
    return model ? this.rerun(model, this.editorOf(model)) : Promise.resolve(false)
  }
}
