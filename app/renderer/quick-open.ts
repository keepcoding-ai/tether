// Quick Open (Ctrl+P): the palette's box without `>`. The files under the focused pane's opening folder (main
// lists and ranks them with VS Code's scorer: app/main/file-index.ts), the recently opened ones on top, as VS
// Code shows "recently opened" above "file results". `file:42` / `file:42:7` opens at the line and column.
// Enter opens in the focused pane's tab group (a tab already showing the file is focused, not duplicated),
// Ctrl+Enter beside it. A text file opens in a note tab (Monaco, language by extension); a binary or a file
// above 5 MB goes to the system's program (main refuses anything that would run).
// The history of opened files lives in the renderer's localStorage (a UI convenience, like the palette's
// recents; under TETHER_HOME/electron), one list for every root: each root shows the entries under it.
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import type { DialogSpec } from '../shared/dialog.ts'
import { rangeRuns } from './word-filter.ts'
import { failedResult, fileIcon, type LineColumn, listFailureText, parseLineSuffix, pushHistory, type QuickOpenItem, type QuickOpenResult, readHistory } from '../shared/quick-open.ts'

const HISTORY_KEY = 'tether.quickOpen.history'
const ICON_SET = new Set<string>(ICON_NAMES)
/** While main is still reading the session's first list, the box asks again this often. */
export const PENDING_POLL_MS = 250

export interface QuickOpenHost {
  /** The focused pane's opening folder (a terminal's cwd, a note's folder, an empty pane's suggestion); undefined without a pane. */
  paneCwd(): string | undefined
  /** Opens a text file in a note tab: in the focused pane's group, or beside it (`side`); an open tab of the file is focused instead. */
  openText(path: string, opts: { side: boolean; position?: LineColumn; root: string }): void
  /** Something to say to the person (a file that could not be opened). */
  notify(message: string): void
}

export interface QuickOpenSearch {
  result: QuickOpenResult
  position: LineColumn | undefined
  query: string
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
    try { window.tether.quickOpenRefresh(this.host.paneCwd()) } catch (err) { console.error('quick open:', err) }
  }

  /** The box closed: main drops the session's list and cache. */
  end(): void {
    try { window.tether.quickOpenEnd() } catch (err) { console.error('quick open:', err) }
  }

  /** Searches; null when a newer search replaced this one (the box shows that one). A failure comes back as a result with `error`. */
  async search(text: string): Promise<QuickOpenSearch | null> {
    const { query, position } = parseLineSuffix(text)
    const cwd = this.host.paneCwd()
    let result: QuickOpenResult | null
    try {
      result = await window.tether.quickOpenSearch(cwd, query, this.history())
    } catch (err) {
      console.error('quick open:', err)
      result = failedResult(cwd ?? '', err instanceof Error ? err.message : String(err))
    }
    if (!result) return null
    this.last = { result, position, query }
    return this.last
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
    if (s.query.trim() === '') return `Digite para procurar arquivos em ${where}. Digite > para procurar um comando.`
    if (s.result.pending && s.result.total === 0) return `Listando os arquivos de ${where}…`
    return `Nenhum arquivo para “${s.query.trim()}” em ${where}.`
  }

  /** Opens the file of a row. */
  async open(path: string, side: boolean): Promise<void> {
    const position = this.last?.position
    const root = this.last?.result.root ?? ''
    const target = await window.tether.quickOpenInspect(path)
    if (target.kind === 'text') {
      this.remember(path)
      this.host.openText(path, { side, root, ...(position ? { position } : {}) })
      return
    }
    if (target.kind === 'missing') { this.host.notify(`O arquivo não existe mais: ${path}`); return }
    if (target.kind === 'folder') { this.host.notify(`É uma pasta: ${path}`); return }
    const r = await window.tether.quickOpenExternal(path)
    if (r.ok) { this.remember(path); return }
    const why = target.kind === 'large' ? `Arquivo grande demais para o editor (${(target.size / 1024 / 1024).toFixed(1)} MB). ` : ''
    this.host.notify(`${why}${r.message}`)
  }
}

function appendRuns(host: HTMLElement, text: string, ranges: readonly { start: number; end: number }[]): void {
  for (const run of rangeRuns(text, ranges)) {
    if (run.hit) { const b = document.createElement('b'); b.textContent = run.text; host.append(b) }
    else host.append(document.createTextNode(run.text))
  }
}

/** A file Quick Open could not open (gone, a folder, too large or binary and refused by the system). */
export function quickOpenFailedSituation(message: string): DialogSpec {
  return {
    situation: 'quick-open-failed',
    tone: 'danger',
    icon: 'x-circle',
    title: 'Não foi possível abrir o arquivo',
    message,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada foi aberto.', tone: 'neutral' }],
    escChoice: 'ok',
  }
}
