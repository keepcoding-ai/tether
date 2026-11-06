// Quick Open (Ctrl+P), the renderer side: the palette's box without `>`. The files of the current project, that is the
// project that contains the focused pane's folder, else that folder itself, else the explorer's current project (F8: the
// scope is named in the field's placeholder). Main lists and ranks them with VS Code's scorer (app/main/file-index.ts), the recently opened ones on top, as
// VS Code shows "recently opened" above "file results". `file:42` / `file:42:7` opens at the line and column.
// Enter opens in the focused pane's tab group (a tab already showing the file is focused, not duplicated), Ctrl+Enter
// beside it; what a file opens as is the core's (app/renderer/file-open.ts) and the openers' (the note's).
// The history of opened files lives in the renderer's localStorage (a UI convenience, like the palette's recents; under
// TETHER_HOME/electron), one list for every root: each root shows the entries under it.
import { icon, ICON_NAMES, type IconName } from '../../app/renderer/icons.ts'
import type { OpenFileOptions } from '../../app/renderer/file-open.ts'
import { rangeRuns } from '../../app/renderer/word-filter.ts'
import { failedResult, fileIcon, type LineColumn, listFailureText, parseLineSuffix, pushHistory, type QuickOpenItem, type QuickOpenResult, readHistory } from '../../app/shared/quick-open.ts'

const HISTORY_KEY = 'tether.quickOpen.history'
const ICON_SET = new Set<string>(ICON_NAMES)

/** Where the box searches: a project (its name is shown), a plain folder, or nothing (main falls back to the notes folder). */
export interface QuickOpenScope {
  root: string | undefined
  kind: 'project' | 'folder' | 'none'
  /** The project's or the folder's name; empty for 'none'. */
  name: string
}

export interface QuickOpenHost {
  /** The scope now: the project holding the focused pane's folder, else that folder, else the explorer's current project. */
  scope(): QuickOpenScope
  /** The main side of the extension (extensions/quick-open/ipc.ts); `root` is the folder to list (undefined: the notes folder). */
  search(root: string | undefined, query: string, recent: string[]): Promise<QuickOpenResult | null>
  refresh(root: string | undefined): void
  end(): void
  /** Opens a file the way the core does (inspect, an opener, the system's program). */
  openFile(path: string, opts: OpenFileOptions): Promise<void>
}

export interface QuickOpenSearch {
  result: QuickOpenResult
  position: LineColumn | undefined
  query: string
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return caseSensitivePaths() ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase()
}

function caseSensitivePaths(): boolean {
  return !/Windows|Macintosh/.test(navigator.userAgent)
}

export class QuickOpen {
  private readonly host: QuickOpenHost
  private last: QuickOpenSearch | undefined

  constructor(host: QuickOpenHost) {
    this.host = host
  }

  history(): string[] {
    try { return readHistory(localStorage.getItem(HISTORY_KEY)) } catch { return [] }
  }

  /** A file was opened (by Quick Open or any other way): it goes on top of the history. */
  remember(path: string): void {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(pushHistory(this.history(), path, caseSensitivePaths()))) } catch { /* storage unavailable: no history */ }
  }

  /** The box opened in this mode: main starts a search session (lists the root now). */
  begin(): void {
    // Best effort: whatever fails here fails the search too, which says why in the box.
    try { this.host.refresh(this.host.scope().root) } catch (err) { console.error('quick open:', err) }
  }

  /** The box closed: main drops the session's list and cache. */
  end(): void {
    try { this.host.end() } catch (err) { console.error('quick open:', err) }
  }

  /** Searches; null when a newer search replaced this one (the box shows that one). A failure comes back as a result with `error`. */
  async search(text: string): Promise<QuickOpenSearch | null> {
    const { query, position } = parseLineSuffix(text)
    const cwd = this.host.scope().root
    let result: QuickOpenResult | null
    try {
      result = await this.host.search(cwd, query, this.history())
    } catch (err) {
      console.error('quick open:', err)
      result = failedResult(cwd ?? '', err instanceof Error ? err.message : String(err))
    }
    if (!result) return null
    this.last = { result, position, query }
    return this.last
  }

  /** The field's placeholder: it names the scope, so the person knows where the search looks. */
  placeholder(): string {
    const { kind, name } = this.host.scope()
    const where = kind === 'project' ? ` no projeto ${name}` : kind === 'folder' ? ` em ${name}` : ''
    return `Procurar arquivo${where} pelo nome (arquivo:linha vai à linha); > procura comandos`
  }

  /** "em <folder>", or "no projeto <name>" when the root searched is the current project's. */
  private inWhere(root: string): string {
    const scope = this.host.scope()
    return scope.kind === 'project' && scope.root !== undefined && samePath(scope.root, root) ? `no projeto ${scope.name}` : `em ${root}`
  }

  /** The rows for a search, under the two separators; returns how many items there are. */
  render(list: HTMLUListElement, s: QuickOpenSearch, idBase: string): number {
    const { recent, files } = s.result
    let i = 0
    const section = (label: string, items: QuickOpenItem[], kind: 'recent' | 'file'): void => {
      if (items.length === 0) return
      const sep = document.createElement('li'); sep.className = 'pal-sep'; sep.setAttribute('role', 'presentation'); sep.textContent = label
      list.append(sep)
      for (const item of items) list.append(this.row(item, kind, `${idBase}-${i++}`))
    }
    section('abertos recentemente', recent, 'recent')
    if (s.query.trim() !== '') section(recent.length ? 'resultados de arquivo' : 'arquivos', files, 'file')
    return i
  }

  private row(item: QuickOpenItem, kind: 'recent' | 'file', id: string): HTMLLIElement {
    const li = document.createElement('li')
    li.id = id
    li.setAttribute('role', 'option')
    li.className = 'pal-item qo-item'
    li.dataset.file = item.path
    li.dataset.kind = kind
    li.title = item.path
    const ic = document.createElement('span'); ic.className = 'pal-icon'
    const name = fileIcon(item.label)
    ic.append(icon((ICON_SET.has(name) ? name : 'file') as IconName))
    const text = document.createElement('span'); text.className = 'pal-text'
    const title = document.createElement('span'); title.className = 'pal-title'
    appendRuns(title, item.label, item.labelMatch)
    text.append(title)
    if (item.description) {
      const d = document.createElement('span'); d.className = 'pal-group qo-folder'
      appendRuns(d, item.description, item.descriptionMatch)
      text.append(d)
    }
    li.append(ic, text)
    return li
  }

  /** The text under the list when nothing matched (or nothing was opened yet). */
  emptyText(s: QuickOpenSearch | undefined): string {
    if (!s) return 'Procurando arquivos…'
    const where = s.result.root
    if (s.result.error !== undefined) return `Não consegui listar os arquivos${where ? ` de ${where}` : ''}: ${listFailureText(s.result.error)}`
    if (s.query.trim() === '') return `Digite para procurar arquivos ${this.inWhere(where)}. Digite > para procurar um comando.`
    if (s.result.pending && s.result.total === 0) return `Listando os arquivos de ${where}…`
    return `Nenhum arquivo para “${s.query.trim()}” ${this.inWhere(where)}.`
  }

  /** Opens the file of a row. */
  async open(path: string, side: boolean): Promise<void> {
    const position = this.last?.position
    await this.host.openFile(path, { side, root: this.last?.result.root ?? '', ...(position ? { position } : {}) })
  }
}

function appendRuns(host: HTMLElement, text: string, ranges: readonly { start: number; end: number }[]): void {
  for (const run of rangeRuns(text, ranges)) {
    if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; host.append(b) }
    else host.append(document.createTextNode(run.text))
  }
}
