// The search results tree (VS Code's search view tree): folder -> file -> match rows drawn from the results model, with
// the keyboard, the row actions and the replace preview. The host mounts it, feeds it the model's changes and acts on
// what the person asks (open, replace, dismiss, menu).
// The tree is virtual, as the explorer's: the rows live in an IndexTreeModel and a ListView keeps in the DOM only the
// rows around the viewport, recycling row elements. A collapsed folder or file carries no children in the tree model
// (they are built from the results model when it expands), so a redraw costs what the person has expanded. The keyboard
// focus stays on the list's scrolling element (aria-activedescendant names the active row), so a recycled row never takes
// the focus with it. The folders and files above the first row in view stick on top (the tree's sticky scroll).
// Redraws: the results model announces every batch of a running search; the tree rebuilds from the model at most once per
// interval (100 ms, doubled after a slow rebuild, up to 800 ms), keeping the focus, the selection, the scroll position and
// the collapse state by element id.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e119f759ff710c1238fdc58d402d7a
//   src/vs/workbench/contrib/search/browser/searchResultsView.ts  (FolderMatchRenderer, FileMatchRenderer, MatchRenderer)
//   src/vs/workbench/contrib/search/browser/searchView.ts         (createSearchResultsView, refreshTree, onSearchResultsChanged,
//                                                                  selectNextMatch, selectPreviousMatch)
//   src/vs/workbench/contrib/search/browser/searchActionsNav.ts   (F4 / Shift+F4)
import type { ContextMenuEntry, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, setIcon, type IconName } from '../../../app/renderer/icons.ts'
import { ListView } from '../../../app/renderer/vscode-list-view.ts'
import { StickyScrollController } from '../../../app/renderer/vscode-tree-sticky-scroll.ts'
import { fileIcon } from '../../../app/shared/quick-open.ts'
import { Emitter, type Event } from '../../../app/shared/vscode-event.ts'
import { IndexTreeModel, type IIndexTreeNode, type IIndexTreeModelSpliceOptions, type ITreeNode } from '../../../app/shared/vscode-index-tree-model.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { FileMatch, Match, type FolderMatch, type IChangeEvent, type RenderableMatch, type SearchModel, type SearchSortOrder } from '../../../app/shared/vscode-search-model.ts'
import {
  afterDismiss, ancestorIds, ariaLabel, countTitle, DISMISS_LABEL, matchParts, nameOf, navigate, nextInterval, pageTarget, preorder, redrawDelay,
  REDRAW_MIN_MS, replaceLabel, showsReplace, stepMatch, survivor, treeElements, type BuildOptions, type CollapseMemory, type Indexed,
  type NavRow, type ResultItem,
} from './results-rules.ts'

export interface ResultsHost {
  model: SearchModel
  viewMode(): 'list' | 'tree'
  sortOrder(): SearchSortOrder
  collapseResults(): 'alwaysExpand' | 'auto' | 'alwaysCollapse'
  showLineNumbers(): boolean
  /** A match was activated (click, Enter, F4): open it. `side`: Ctrl/Alt+click or Ctrl+Enter. */
  open(match: Match, opts: { side: boolean }): void
  /** The replace action of a row (button, Ctrl+Shift+1); only offered while model.replaceActive. */
  replace(element: RenderableMatch): void
  /** The dismiss action of a row (button, Delete). The host removes it from the model; the tree follows the model's change event. */
  dismiss(element: RenderableMatch): void
  /** The "Copiar" of a row (Ctrl+C on the tree): its text to the clipboard. */
  copy(element: RenderableMatch): void
  /** The rows of the context menu for an element. */
  menu(element: RenderableMatch): ContextMenuEntry[]
  /** A folder's or file's description beside its name (the host knows the project roots): '' for none. */
  describe(element: RenderableMatch): string
}

export interface ResultsRow {
  kind: 'folder' | 'file' | 'match'; id: string; level: number; label: string; description: string; count?: number; expanded?: boolean
  line?: number; before?: string; inside?: string; after?: string; replacement?: string; focused: boolean; selected: boolean
}
export interface ResultsSnapshot { rows: ResultsRow[]; rendered: number; sticky: string[] }

type Node = ITreeNode<ResultItem>

/** One height for every row. */
const ROW_HEIGHT = 24
/** The breathing room above the first row and below the last. */
const LIST_PADDING = 4
/** The longest a press holds the redraws back (a release the window never saw). */
const PRESS_MAX_MS = 3000
/** Rows remembered on each side of the focused one, to find its nearest survivor after a redraw. */
const NEIGHBOURS = 64

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** The tree model's own root: never shown. */
const TOP: ResultItem = { kind: 'folder', id: '', element: undefined as unknown as RenderableMatch, level: 0, count: 0 }

export class SearchResults {
  readonly element = el('div', 'sr')
  private readonly ui: TetherUi
  private readonly host: ResultsHost
  /** The scrolling element of the list, the ARIA tree and the keyboard's target. */
  private readonly scroll = el('div', 'sr-scroll')
  private readonly model = new IndexTreeModel<ResultItem>('search', TOP)
  private readonly list: ListView<Node>
  private readonly sticky: StickyScrollController<ResultItem>
  private readonly subs: IDisposable[] = []
  /** Every node of the tree model by element id. */
  private readonly nodes = new Map<string, Node>()
  /** The row elements of the list in the DOM and the node each one draws. */
  private readonly rendered = new Map<HTMLElement, Node>()
  private readonly spliceOptions: IIndexTreeModelSpliceOptions<ResultItem, void>
  private readonly memory: CollapseMemory = new Map()
  /** The row the keyboard is on and the selected one, by element id. */
  private focusedId: string | undefined
  private selectedId: string | undefined
  /** The redraw's pace: the interval, the last rebuild's time and the pending one. */
  private interval = REDRAW_MIN_MS
  private lastBuild: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The last value of isAllCollapsed() announced. */
  private allCollapsed = true
  private disposed = false
  /**
   * A pointer press that started on the tree and has not ended yet. A row replaced between the press and the release would
   * make the browser drop the click (it is dispatched on the common ancestor of both targets), so a rebuild waits for the
   * release and runs right after the click.
   */
  private pressed = false
  private pressTimer: ReturnType<typeof setTimeout> | undefined
  private waiting = false
  private readonly onRelease = (ev: globalThis.Event): void => { if (ev.type !== 'blur' || ev.target === window) this.release() }
  private readonly onPress = (): void => this.press()

  private readonly _onDidChangeCollapseState = new Emitter<void>()
  readonly onDidChangeCollapseState: Event<void> = this._onDidChangeCollapseState.event
  private readonly _onDidRequestFocusInput = new Emitter<void>()
  readonly onDidRequestFocusInput: Event<void> = this._onDidRequestFocusInput.event

  constructor(ui: TetherUi, host: ResultsHost) {
    this.ui = ui
    this.host = host
    this.spliceOptions = {
      onDidCreateNode: node => { this.nodes.set(node.element.id, node) },
      // A rebuild creates the new nodes before it deletes the old ones of the same ids.
      onDidDeleteNode: node => { if (this.nodes.get(node.element.id) === node) this.nodes.delete(node.element.id) },
    }
    this.buildTree()
    this.element.append(this.scroll)
    this.list = new ListView<Node>(this.scroll, { getHeight: () => ROW_HEIGHT }, {
      renderElement: (node, _index, row) => { this.rendered.set(row, node); this.drawRow(node, row) },
      disposeElement: (_node, _index, row) => { this.rendered.delete(row) },
    }, { paddingTop: LIST_PADDING, paddingBottom: LIST_PADDING, rowRole: 'treeitem' })
    this.subs.push(this.list)
    this.subs.push(this.model.onDidSpliceRenderedNodes(({ start, deleteCount, elements }) => { this.list.splice(start, deleteCount, elements) }))
    // After the list's own splice listener: the sticky state is computed over a list that already matches the model.
    this.sticky = new StickyScrollController<ResultItem>(this.element, this.list, this.model, (node, dom) => this.drawRow(node, dom), {
      paddingTop: LIST_PADDING, containerClassName: 'sr-sticky', rowClassName: 'sr-sticky-row',
    })
    this.subs.push(this.sticky)
    this.buildSticky()
    this.subs.push(this.list.onDidScroll(() => this.syncActive()))
    this.element.addEventListener('pointerdown', this.onPress, true)
    for (const type of ['pointerup', 'pointercancel', 'dragend', 'blur'] as const) window.addEventListener(type, this.onRelease, true)
    this.rebuild()
  }

  // ---------- the contract ----------

  /** Rebuilds from the model, forgetting collapse state (a new search, results cleared). */
  reset(): void {
    this.memory.clear()
    this.focusedId = undefined
    this.selectedId = undefined
    this.interval = REDRAW_MIN_MS
    this.lastBuild = undefined
    this.rebuild({ top: true })
  }

  /** The model changed: a rebuild, at the redraw's pace. */
  update(_e: IChangeEvent): void {
    this.schedule()
  }

  /** View mode, sort order, line numbers or the replace text changed: rebuild now, keeping state. */
  refresh(): void {
    this.rebuild()
  }

  collapseAll(): void {
    this.setAll(true)
  }

  expandAll(): void {
    this.setAll(false)
  }

  /** No folder or file row is expanded: a row in view that is expanded has its top row expanded too, so the top rows tell. */
  isAllCollapsed(): boolean {
    for (const node of this.model.getNode([]).children) if (node.collapsible && !node.collapsed) return false
    return true
  }

  focus(): void {
    if (this.list.length === 0) return
    const target = this.nodeOf(this.focusedId) ?? this.nodeOf(this.selectedId) ?? this.list.element(0)
    this.setFocused(target, true)
  }

  hasFocus(): boolean {
    return document.activeElement === this.scroll
  }

  focused(): RenderableMatch | undefined {
    return this.nodeOf(this.focusedId)?.element.element
  }

  next(): Match | undefined { return this.step(false) }
  previous(): Match | undefined { return this.step(true) }

  /** Expands what hides the element and scrolls it into view (the focus stays where it is). */
  reveal(element: RenderableMatch): void {
    const node = this.expandTo(element)
    if (node) this.revealNode(node)
  }

  layout(): void {
    this.list.layout()
    this.sticky.refresh()
    this.fitSticky()
  }

  /** For the e2e: every row of the flat list (in the DOM or not), how many are in the DOM, the sticky rows' ids. */
  snapshot(): ResultsSnapshot {
    const replace = showsReplace(this.host.model)
    const lines = this.host.showLineNumbers()
    const rows: ResultsRow[] = []
    for (let i = 0; i < this.list.length; i++) {
      const node = this.list.element(i)
      const item = node.element
      const base = { id: item.id, level: item.level, focused: item.id === this.focusedId, selected: item.id === this.selectedId }
      const e = item.element
      if (e instanceof Match) {
        const p = matchParts(e, replace)
        rows.push({
          kind: 'match', ...base, label: p.title, description: '', before: p.before, inside: p.inside, after: p.after,
          ...(p.replacement !== undefined ? { replacement: p.replacement } : {}), ...(lines ? { line: p.line } : {}),
        })
      } else {
        rows.push({
          kind: item.kind, ...base, label: nameOf(e), description: this.host.describe(e), count: item.count,
          ...(node.collapsible ? { expanded: !node.collapsed } : {}),
        })
      }
    }
    return { rows, rendered: this.rendered.size, sticky: this.sticky.rows().map(([, node]) => node.element.id) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    clearTimeout(this.pressTimer)
    this.element.removeEventListener('pointerdown', this.onPress, true)
    for (const type of ['pointerup', 'pointercancel', 'dragend', 'blur'] as const) window.removeEventListener(type, this.onRelease, true)
    for (const s of this.subs) s.dispose()
    this.subs.length = 0
    this._onDidChangeCollapseState.dispose()
    this._onDidRequestFocusInput.dispose()
    this.element.remove()
  }

  // ---------- rebuilding ----------

  private options(): BuildOptions {
    return { tree: this.host.viewMode() === 'tree', sortOrder: this.host.sortOrder(), collapseResults: this.host.collapseResults() }
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return
    const delay = redrawDelay(Date.now(), this.lastBuild, this.interval)
    this.timer = setTimeout(() => { this.timer = undefined; this.rebuild() }, delay)
  }

  /** Builds the rows again from the results model, keeping focus, selection, scroll position and collapse state by id. */
  private rebuild(opts: { top?: boolean } = {}): void {
    if (this.disposed) return
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.pressed) { this.waiting = true; return }
    const started = performance.now()
    const anchor = opts.top ? undefined : this.scrollAnchor()
    const focusedNode = this.nodeOf(this.focusedId)
    const focusedAt = focusedNode ? this.indexOf(focusedNode) : -1
    const elements = treeElements(this.host.model.searchResult, 1, this.options(), this.memory)
    const top = this.model.getNode([])
    this.model.splice([0], top.children.length, elements, this.spliceOptions)
    if (this.focusedId !== undefined && !this.nodes.has(this.focusedId)) {
      const to = focusedAt < 0 ? -1 : survivor(focusedAt, this.list.length)
      this.focusedId = to >= 0 ? this.list.element(to).element.id : undefined
    }
    if (this.selectedId !== undefined && !this.nodes.has(this.selectedId)) this.selectedId = undefined
    if (opts.top) this.list.scrollTop = 0
    else if (anchor) {
      const node = this.nodes.get(anchor.id)
      const index = node ? this.indexOf(node) : -1
      this.list.scrollTop = index >= 0 ? this.list.elementTop(index) + anchor.offset : anchor.scrollTop
    }
    // An empty tree takes no keyboard (Tab passes over it).
    this.scroll.tabIndex = this.list.length > 0 ? 0 : -1
    this.sticky.refresh()
    this.paint()
    this.lastBuild = Date.now()
    this.interval = nextInterval(this.interval, performance.now() - started)
    this.announceCollapse(false)
  }

  /** The first row in view and how far the view is into it (the list may grow or shrink above it). */
  private scrollAnchor(): { id: string; offset: number; scrollTop: number } | undefined {
    if (this.list.length === 0) return undefined
    const scrollTop = this.list.scrollTop
    const index = Math.min(this.list.indexAt(scrollTop), this.list.length - 1)
    if (index < 0) return undefined
    return { id: this.list.element(index).element.id, offset: scrollTop - this.list.elementTop(index), scrollTop }
  }

  private announceCollapse(force: boolean): void {
    const now = this.isAllCollapsed()
    if (!force && now === this.allCollapsed) return
    this.allCollapsed = now
    this._onDidChangeCollapseState.fire()
  }

  /** Collapse All / Expand All: every folder and file of the results (in the current view mode), then a rebuild. */
  private setAll(collapsed: boolean): void {
    for (const e of preorder(this.host.model.searchResult, this.options(), false)) this.memory.set(e.id(), collapsed)
    // Collapsing everything: the keyboard goes up to the top row that holds it (its neighbours vanish with it).
    const focused = collapsed ? this.focused() : undefined
    if (focused) { const top = ancestorIds(focused).find(id => this.nodes.has(id)); if (top) this.focusedId = top }
    this.rebuild({ top: collapsed })
    this.announceCollapse(true)
  }

  // ---------- expanding and collapsing ----------

  private toggle(node: Node): void {
    if (!node.collapsible) return
    this.setExpanded(node, node.collapsed)
  }

  private setExpanded(node: Node, expanded: boolean): void {
    if (!node.collapsible || node.collapsed !== expanded) return
    this.memory.set(node.element.id, !expanded)
    const location = this.model.getNodeLocation(node)
    if (expanded) {
      this.model.setCollapsed(location, false)
      this.model.splice([...location, 0], node.children.length, treeElements(node.element.element, node.element.level + 1, this.options(), this.memory), this.spliceOptions)
    } else {
      const inside = this.isInside(this.focusedId, node)
      this.model.splice([...location, 0], node.children.length, [], this.spliceOptions)
      this.model.setCollapsed(location, true)
      if (inside) this.focusedId = node.element.id
      if (this.selectedId !== undefined && !this.nodes.has(this.selectedId)) this.selectedId = undefined
    }
    this.paint()
    this.announceCollapse(true)
  }

  /** Whether the row of `id` lies below `node`. */
  private isInside(id: string | undefined, node: Node): boolean {
    for (let n = this.nodeOf(id) as IIndexTreeNode<ResultItem> | undefined; n; n = n.parent) if (n.parent === node) return true
    return false
  }

  /** Expands the rows above an element, top down, and returns its row when it shows. */
  private expandTo(element: RenderableMatch): Node | undefined {
    for (const id of ancestorIds(element)) {
      const node = this.nodes.get(id)
      if (node?.collapsed) this.setExpanded(node, true)
    }
    return this.nodes.get(element.id())
  }

  /** F4 / Shift+F4: the next (previous) match after the focused row, wrapping; focused, selected and revealed. */
  private step(backwards: boolean): Match | undefined {
    const opts = this.options()
    const from = this.focusedId ?? this.selectedId
    const match = stepMatch(this.host.model.searchResult, opts, from, backwards)
    if (!match) return undefined
    // A match the tree has not drawn yet (a rebuild pending) is drawn first.
    let node = this.expandTo(match)
    if (!node) { this.rebuild(); node = this.expandTo(match) }
    if (!node) return undefined
    this.selectedId = node.element.id
    this.setFocused(node, false)
    this.revealNode(node)
    return match
  }

  // ---------- a press in progress ----------

  private press(): void {
    this.pressed = true
    clearTimeout(this.pressTimer)
    this.pressTimer = setTimeout(() => this.release(), PRESS_MAX_MS)
  }

  /** The pointer is up: the click runs first, then the rebuild that waited (a task later). */
  private release(): void {
    if (!this.pressed) return
    this.pressed = false
    clearTimeout(this.pressTimer)
    setTimeout(() => { if (this.waiting && !this.disposed && !this.pressed) { this.waiting = false; this.rebuild() } }, 0)
  }

  // ---------- focus and selection ----------

  private nodeOf(id: string | undefined): Node | undefined {
    return id === undefined ? undefined : this.nodes.get(id)
  }

  /** The list index of a node, -1 when it is not shown. */
  private indexOf(node: Node): number {
    if (this.nodes.get(node.element.id) !== node) return -1
    return this.model.getListIndex(this.model.getNodeLocation(node))
  }

  /** Moves the keyboard to `node`; `focus` also puts the keyboard in the tree. The row is brought into view either way when `focus`. */
  private setFocused(node: Node, focus: boolean): void {
    this.focusedId = node.element.id
    this.paint()
    if (!focus) return
    if (document.activeElement !== this.scroll) this.scroll.focus({ preventScroll: true })
    this.revealNode(node)
  }

  private select(node: Node): void {
    this.selectedId = node.element.id
    this.focusedId = node.element.id
    this.paint()
  }

  /** Scrolls only as much as needed for the row to show below the rows that stick above it. */
  private revealNode(node: Node): void {
    const index = this.indexOf(node)
    if (index < 0 || index >= this.list.length) return
    this.list.reveal(index, undefined, this.sticky.nodePositionTopBelowWidget(node))
    if (index === 0) this.list.scrollTop = 0
    else if (index === this.list.length - 1 && this.list.getRelativeTop(index) !== null) this.list.scrollTop = this.list.scrollHeight
  }

  private activeNode(): Node | undefined {
    return this.nodeOf(this.focusedId) ?? (this.list.length > 0 ? this.list.element(0) : undefined)
  }

  // ---------- what the person does ----------

  private activate(node: Node, side: boolean): void {
    this.select(node)
    const e = node.element.element
    if (e instanceof Match) this.host.open(e, { side })
    else this.toggle(node)
  }

  private act(action: string, node: Node): void {
    const e = node.element.element
    // The replaced row is the focus anchor (as VS Code's performReplace): once it leaves, the keyboard goes to the next row.
    if (action === 'replace') { if (this.host.model.replaceActive) { this.setFocused(node, false); this.host.replace(e) } }
    else if (action === 'dismiss') this.dismiss(node)
  }

  /** Dismiss: the keyboard moves to the next row (the previous when it was the last) before the host removes the element. */
  private dismiss(node: Node): void {
    const index = this.indexOf(node)
    if (index >= 0 && this.focusedId === node.element.id) {
      const to = afterDismiss(this.navRows(), index)
      this.focusedId = to >= 0 ? this.list.element(to).element.id : undefined
      if (this.selectedId === node.element.id) this.selectedId = undefined
      this.paint()
    }
    this.host.dismiss(node.element.element)
  }

  /**
   * A row action (a button that never takes the keyboard) leaves the keyboard on the tree: the button goes away with its row,
   * and a keyboard that was in a field would stay there while the person is working the results.
   */
  private keepKeyboard(): void {
    if (document.activeElement !== this.scroll) this.scroll.focus({ preventScroll: true })
  }

  private showMenu(node: Node, x: number, y: number): void {
    this.setFocused(node, false)
    const entries = this.host.menu(node.element.element)
    if (entries.length > 0) this.ui.menus.context(x, y, entries)
  }

  /** The rows the keyboard walks, read one at a time. */
  private navRows(): Indexed<NavRow> {
    return {
      length: this.list.length,
      at: i => {
        if (i < 0 || i >= this.list.length) return undefined
        const n = this.list.element(i)
        return { level: n.element.level, collapsible: n.collapsible, expanded: n.collapsible && !n.collapsed }
      },
    }
  }

  private onKey(ev: KeyboardEvent): void {
    const node = this.activeNode()
    if (!node) return
    const e = node.element.element
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      this.revealNode(node)
      const dom = this.domOf(node)
      const r = (dom ?? this.scroll).getBoundingClientRect()
      this.showMenu(node, r.left + 24, dom ? r.bottom : r.top)
      return
    }
    if (ev.key === 'Delete' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault()
      this.dismiss(node)
      return
    }
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'c') {
      // A text the person selected in the page is theirs to copy; otherwise the focused row is copied.
      if (window.getSelection()?.toString()) return
      ev.preventDefault()
      this.host.copy(e)
      return
    }
    if (ev.code === 'Digit1' && (ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey) {
      ev.preventDefault()
      if (this.host.model.replaceActive) this.host.replace(e)
      return
    }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault()
      if (e instanceof Match) { this.select(node); this.host.open(e, { side: true }) }
      return
    }
    if (ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return
    const index = this.indexOf(node)
    if (index < 0) return
    if (ev.key === 'PageDown' || ev.key === 'PageUp') { ev.preventDefault(); this.page(index, ev.key === 'PageDown'); return }
    const action = navigate(this.navRows(), index, ev.key)
    if (action.type === 'none') return
    ev.preventDefault()
    if (action.type === 'focus') this.setFocused(this.list.element(action.index), true)
    else if (action.type === 'leave') this._onDidRequestFocusInput.fire()
    else if (action.type === 'open' || action.type === 'toggle') this.activate(node, false)
    else this.setExpanded(node, action.type === 'expand')
  }

  /** PageUp/PageDown: the first press goes to the edge of what is in view, the next one a page further. */
  private page(index: number, down: boolean): void {
    const length = this.list.length
    if (length === 0) return
    // The rows under the sticky ones are not in view.
    const covered = this.sticky.height
    const top = this.list.scrollTop + covered
    const height = this.list.renderHeight - covered
    const lastIndex = length - 1
    let first = Math.min(this.list.indexAt(top), lastIndex)
    if (this.list.elementTop(first) < top - 1 && first < lastIndex) first++
    let last = Math.min(this.list.indexAt(top + height - 1), lastIndex)
    if (this.list.elementTop(last) + this.list.elementHeight(last) > top + height + 1 && last > first) last--
    const at = pageTarget(index, length, first, last, Math.max(1, Math.floor(height / ROW_HEIGHT)), down)
    if (at >= 0) this.setFocused(this.list.element(at), true)
  }

  // ---------- the DOM ----------

  /** The tree's scrolling element, its ARIA role and its keys; the rows' events are delegated to it (rows are recycled). */
  private buildTree(): void {
    const s = this.scroll
    s.tabIndex = 0
    s.setAttribute('role', 'tree')
    s.setAttribute('aria-label', 'Resultados da pesquisa')
    // Delete is the tree's (dismiss), not the app's.
    s.dataset.ownKeys = 'Delete'
    s.addEventListener('keydown', ev => this.onKey(ev))
    // The keyboard arriving with no row to stand on lands on the first row.
    s.addEventListener('focus', () => {
      if (!this.nodeOf(this.focusedId) && this.list.length > 0) this.focusedId = this.list.element(0).element.id
      this.paint()
    })
    s.addEventListener('blur', () => this.paint())
    // A press on a row action keeps the keyboard where it is (the button would take it).
    s.addEventListener('mousedown', ev => { if ((ev.target as HTMLElement | null)?.closest('.sr-act')) ev.preventDefault() })
    const rowOf = (ev: globalThis.Event): Node | undefined => {
      const dom = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.sr-row')
      return dom ? this.rendered.get(dom) : undefined
    }
    s.addEventListener('click', ev => {
      const node = rowOf(ev)
      if (!node) return
      const act = (ev.target as HTMLElement).closest<HTMLElement>('.sr-act')
      if (act) { ev.stopPropagation(); this.keepKeyboard(); this.act(act.dataset.act ?? '', node); return }
      if (document.activeElement !== this.scroll) this.scroll.focus({ preventScroll: true })
      this.activate(node, ev.ctrlKey || ev.metaKey || ev.altKey)
    })
    s.addEventListener('contextmenu', ev => {
      const node = rowOf(ev)
      if (!node) return
      ev.preventDefault()
      if (document.activeElement !== this.scroll) this.scroll.focus({ preventScroll: true })
      this.showMenu(node, ev.clientX, ev.clientY)
    })
  }

  /**
   * The sticky layer's events (it lies over the scrolling element). A click scrolls the row's real row to just under its
   * own sticky ancestors and gives it the keyboard; on the twistie it also collapses it; on an action it runs the action.
   * The wheel scrolls the tree under it.
   */
  private buildSticky(): void {
    const s = this.sticky.domNode
    s.addEventListener('mousedown', ev => { if ((ev.target as HTMLElement | null)?.closest('.sr-act')) ev.preventDefault() })
    s.addEventListener('click', ev => {
      const node = this.sticky.nodeOfElement(ev.target as HTMLElement)
      if (!node) return
      const act = (ev.target as HTMLElement).closest<HTMLElement>('.sr-act')
      if (act) { this.keepKeyboard(); this.act(act.dataset.act ?? '', node); return }
      const index = this.indexOf(node)
      if (index < 0) return
      const onTwistie = !!(ev.target as HTMLElement).closest('.sr-twist')
      this.list.scrollTop = this.list.getElementTop(index) - this.sticky.nodePositionTopBelowWidget(node)
      this.select(node)
      this.setFocused(node, true)
      if (onTwistie) this.toggle(node)
    })
    s.addEventListener('contextmenu', ev => {
      const node = this.sticky.nodeOfElement(ev.target as HTMLElement)
      if (!node) return
      ev.preventDefault()
      this.showMenu(node, ev.clientX, ev.clientY)
    })
    s.addEventListener('wheel', ev => {
      ev.preventDefault()
      const unit = ev.deltaMode === 1 ? ROW_HEIGHT : ev.deltaMode === 2 ? this.list.renderHeight : 1
      this.scroll.scrollBy(ev.deltaX * unit, ev.deltaY * unit)
    }, { passive: false })
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.fitSticky())
      ro.observe(this.scroll)
      this.subs.push({ dispose: () => ro.disconnect() })
    }
    this.subs.push(this.list.onDidScroll(() => this.fitSticky()))
    this.fitSticky()
  }

  /** The sticky layer leaves the vertical scrollbar uncovered: it is as wide as the scrolling element's content box. */
  private fitSticky(): void {
    this.sticky.domNode.style.width = `${this.scroll.clientWidth}px`
  }

  private domOf(node: Node): HTMLElement | undefined {
    for (const [dom, n] of this.rendered) if (n === node) return dom
    return undefined
  }

  private actionButton(act: 'replace' | 'dismiss', ic: IconName, label: string): HTMLButtonElement {
    const b = el('button', 'ib sr-act')
    b.type = 'button'
    b.tabIndex = -1
    b.dataset.act = act
    b.title = label
    b.setAttribute('aria-label', label)
    b.append(icon(ic))
    return b
  }

  /** Draws a node into a row element: a row of the list (clean, positioned by the list) or a sticky copy of it. */
  private drawRow(node: Node, dom: HTMLElement): void {
    const item = node.element
    const e = item.element
    const model = this.host.model
    const replace = showsReplace(model)
    dom.className = `sr-row sr-${item.kind}`
    dom.dataset.kind = item.kind
    dom.dataset.id = item.id
    dom.style.setProperty('--lvl', String(item.level))
    dom.setAttribute('aria-level', String(item.level))
    const parent = (node as IIndexTreeNode<ResultItem>).parent
    if (parent) { dom.setAttribute('aria-setsize', String(parent.visibleChildrenCount)); dom.setAttribute('aria-posinset', String(node.visibleChildIndex + 1)) }
    dom.setAttribute('aria-label', ariaLabel(e, replace))
    const acts = el('span', 'sr-acts')
    if (model.replaceActive) acts.append(this.actionButton('replace', 'swap', replaceLabel(item.kind)))
    acts.append(this.actionButton('dismiss', 'x', DISMISS_LABEL))
    const twist = el('span', 'sr-twist')
    if (e instanceof Match) {
      const p = matchParts(e, replace)
      dom.title = p.title
      const text = el('span', 'sr-text')
      const hit = el('span', p.replacement !== undefined ? 'sr-hit sr-hit-replaced' : 'sr-hit', p.inside)
      text.append(el('span', 'sr-before', p.before), hit)
      if (p.replacement !== undefined) text.append(el('span', 'sr-rep', p.replacement))
      text.append(el('span', 'sr-after', p.after))
      dom.append(twist, text, acts)
      const lineText = (this.host.showLineNumbers() ? String(p.line) : '') + (p.extraLines > 0 ? ` +${p.extraLines}` : '')
      if (lineText) {
        const line = el('span', 'sr-line', lineText.trim())
        line.title = p.extraLines > 0 ? `Da linha ${p.line}, mais ${p.extraLines} ${p.extraLines === 1 ? 'linha' : 'linhas'}` : `Linha ${p.line}`
        dom.append(line)
      }
    } else {
      const folderOrFile = e as FolderMatch | FileMatch
      twist.append(icon('caret-right'))
      const ico = el('span', 'sr-ico')
      if (e instanceof FileMatch) setIcon(ico, fileIcon(e.name()) as IconName)
      else setIcon(ico, node.collapsed ? 'folder' : 'folder-open')
      const name = el('span', 'sr-name', nameOf(folderOrFile))
      const description = this.host.describe(e)
      dom.title = e instanceof FileMatch ? e.resource : (folderOrFile.resource ?? nameOf(folderOrFile))
      dom.append(twist, ico, name)
      if (description) dom.append(el('span', 'sr-desc', description))
      const count = el('span', 'sr-count', String(item.count))
      count.title = countTitle(item.count)
      dom.append(el('span', 'sr-sp'), acts, count)
    }
    this.paintRow(dom, node)
  }

  /** What a row shows that changes without redrawing it: expanded, selected, the keyboard. */
  private paintRow(dom: HTMLElement, node: Node): void {
    const item = node.element
    if (node.collapsible) {
      dom.setAttribute('aria-expanded', String(!node.collapsed))
      if (item.kind === 'folder') { const ico = dom.querySelector<HTMLElement>(':scope > .sr-ico'); if (ico) setIcon(ico, node.collapsed ? 'folder' : 'folder-open') }
    } else dom.removeAttribute('aria-expanded')
    const selected = item.id === this.selectedId
    dom.setAttribute('aria-selected', String(selected))
    dom.classList.toggle('selected', selected)
    dom.classList.toggle('focused', item.id === this.focusedId)
  }

  /** Paints every row in the DOM again (the selection or the keyboard moved). */
  private paint(): void {
    for (const [dom, node] of this.rendered) this.paintRow(dom, node)
    for (const [dom, node] of this.sticky.rows()) this.paintRow(dom, node)
    this.syncActive()
  }

  /** The tree names its active row for assistive technology, while that row is in the DOM. */
  private syncActive(): void {
    let id: string | undefined
    if (this.focusedId !== undefined) for (const [dom, node] of this.rendered) if (node.element.id === this.focusedId) { id = dom.id; break }
    if (id) this.scroll.setAttribute('aria-activedescendant', id)
    else this.scroll.removeAttribute('aria-activedescendant')
  }
}

