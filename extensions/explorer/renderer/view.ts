// The explorer pad (F8): the window's project roots with the file tree under each, or the empty state. The roots come from
// the core's workspace service (TetherUi.workspace); this view shows and edits them (pin, close, move) and draws their
// folders. Slice 1b: a folder is read only when expanded (the main side lists one folder at a time on the bus
// `ext:explorer:*`) and the expanded folders are kept in the pad's state.
// Slice 3: the pad follows the disk (the main side tells which expanded folders changed; only those are read again, and the
// scroll, the selection and the keyboard stay where they were) and has "Atualizar" and "Recolher tudo" in its "⋯" menu.
// Slice 5: the file operations. New file/folder and rename edit the name in place (an input row, VS Code's explorerViewer
// edit mode, with fileActions' name validation), "Mover para a lixeira" asks first (setting confirmDelete), and the tree is
// redrawn by the disk watcher (slice 3), never by the operation itself.
// The tree is virtual: the rows live in an IndexTreeModel (every node in it is shown: a collapsed folder holds no children)
// and a ListView keeps in the DOM only the rows around the viewport, recycling row elements as they scroll out. The
// keyboard focus stays on the list's container (aria-activedescendant names the active row), so a recycled row never takes
// the focus with it.
// Sticky scroll (VS Code's tree sticky scroll): the folders above the first row in view stay drawn on top of the tree, by
// the same row renderer; a click on one scrolls to its real row, a click on its twistie collapses it.
// The model follows VS Code's explorer (explorerModel: children resolved lazily per expanded folder; explorerViewer: the
// twistie, the indent, the multi-root folder rows; the list's keys). The empty state follows VS Code's empty view
// ("You have not yet opened a folder" + "Open Folder"), made useful with the app's recent folders.
import type { ContextMenuEntry, PadHost, PadView, ProjectFolder, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, setIcon, type IconName } from '../../../app/renderer/icons.ts'
import { ListView } from '../../../app/renderer/vscode-list-view.ts'
import { StickyScrollController } from '../../../app/renderer/vscode-tree-sticky-scroll.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import { fileIcon } from '../../../app/shared/quick-open.ts'
import { rebasePath } from '../../../app/shared/notes.ts'
import { Emitter } from '../../../app/shared/vscode-event.ts'
import { IndexTreeModel, type IIndexTreeNode, type IIndexTreeModelSpliceOptions, type ITreeElement, type ITreeNode } from '../../../app/shared/vscode-index-tree-model.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { requestFindInFolder } from '../../search/api.ts'
import { renameSelection, validateFileName, type NameProblem } from '../file-names.ts'
import type { Entry, ExplorerChannels } from '../ipc.ts'
import { emptyState, isTypeAheadKey, joinPath, navigate, pageTarget, parentPath, readState, revealChain, TYPE_AHEAD_RESET_MS, typeAheadMatch, type Indexed, type NavRow } from '../tree-rules.ts'
import {
  agentsHint, agentsTooltip, deleteSituation, EMPTY_HELP, EMPTY_TITLE, itemMenu, type ItemAction, MISSING_TEXT, MISSING_TITLE, OPEN_FOLDER_LABEL, pinLabel,
  recentRow, recentToOffer, RECENT_TITLE, relativePath, rootMenu, rootTitle, type RootAction, failedSituation, trashFailedSituation,
} from './rules.ts'

const IS_WINDOWS = /^win/i.test(navigator.platform)

/** A file operation the commands run on the selected row. */
export type FileOp = 'new-file' | 'new-folder' | 'rename' | 'delete' | 'copy-path' | 'copy-relative-path' | 'new-pane'

/** The name being edited in place (new file/folder or rename), for the e2e and for the redraws that wait for it. */
interface Editing {
  dir: string
  input: HTMLInputElement
  /** The validation message: a layer over the tree just under the input (VS Code's InputBox), attached only while it says something. */
  message: HTMLElement
  problem: NameProblem | null
  /** What the message says ('' when nothing) and whether it is a warning (else an error). */
  text: string
  warning: boolean
  /** The row being renamed (its key), or the folder the new entry goes in (its key) with the new entry's icon. */
  renameKey?: string
  newIn?: string
  ico?: HTMLElement
  end(): void
}

const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)
/** Project roots whose expanded folders are remembered (the oldest are forgotten). */
const REMEMBERED_ROOTS = 50
/** The longest a press holds the redraws back (a release the window never saw). */
const PRESS_MAX_MS = 3000
/** How long an operation waits for its row to show up (the watcher redraws the folder). */
const ROW_WAIT_MS = 3000
/** Joins a root and a path into a row key (a control character no path holds). */
const KEY_SEP = '\u0001'
/** Row heights (fixed): a project root, any other row. */
const ROOT_HEIGHT = 28
const ROW_HEIGHT = 26
/** The breathing room above the first row and below the last. */
const LIST_PADDING = 6

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** A folder as the model keeps it: its entries, or why it could not be read. */
interface DirState { entries?: Entry[]; error?: string }

/** What the extension's entry gives the pad: the two toggles (settings) and the reveal command. */
export interface ExplorerControls {
  isOn(key: 'follow' | 'autoReveal' | 'confirmDelete'): boolean
  toggle(key: 'follow' | 'autoReveal'): void
  set(key: 'confirmDelete', value: boolean): void
  /** Fires when a toggle changes from anywhere (header button, palette, settings page, settings.json). */
  onChange(key: 'follow' | 'autoReveal', listener: () => void): IDisposable
  reveal(): void
  /** The view was shown or hidden (disposed counts as hidden): the disk is watched only while a view is shown. */
  visible?(visible: boolean): void
}

/**
 * One line of the tree as the model keeps it: a project root, a file or folder under it, the error a folder gave instead of
 * its entries (`msg`), or the input of a new entry (`edit`, the first child of its folder). Pure data: what the row shows that
 * changes without a redraw of the folder (selection, keyboard, current project, expanded) is read from the view and the node.
 */
interface Row {
  readonly kind: 'root' | 'item' | 'msg' | 'edit'
  readonly root: string
  /** The row's path; for a `msg` or `edit` row, its folder's. */
  readonly path: string
  readonly level: number
  readonly dir: boolean
  readonly key: string
  /** The name shown (a rename that went through shows the new name until the watcher redraws the folder). */
  name: string
  readonly link: boolean
  /** A root row's project. */
  readonly folder?: ProjectFolder
  /** A `msg` row's text. */
  readonly text?: string
  /** The in-place edit drawn on this row: the new entry's input, or the input that replaces the name while renaming. */
  edit?: Editing
}

type Node = ITreeNode<Row>

/** A row as the e2e reads it. */
interface SnapshotRow { root: string; path: string; name: string; level: number; kind: string; expanded: boolean; selected: boolean; focused: boolean }

const rowKey = (root: string, path: string): string => root + KEY_SEP + path
const normPath = (p: string): string => { const k = p.replace(/[\\/]+/g, '/').replace(/\/$/, ''); return CASE_INSENSITIVE ? k.toLowerCase() : k }
/** A row key that matches however the path is spelled (separators, a trailing one and, where the system ignores it, case). */
const pathKey = (root: string, path: string): string => normPath(root) + KEY_SEP + normPath(path)
const isTreeRow = (node: Node | undefined): node is Node => !!node && (node.element.kind === 'root' || node.element.kind === 'item')

/** The model's own root: the parent of the project roots, never shown. */
const TOP: Row = { kind: 'root', root: '', path: '', level: 0, dir: true, key: '', name: '', link: false }

export class ExplorerView implements PadView {
  readonly element = el('div', 'xp')
  private readonly ui: TetherUi
  private readonly host: PadHost
  private readonly controls: ExplorerControls
  private readonly ipc: UiIpc<ExplorerChannels>
  private readonly subs: IDisposable[] = []
  private recent: string[] = []
  /** Per project root, the folders expanded under it (the root itself included); the pad's persisted state. */
  private readonly expanded = new Map<string, Set<string>>()
  /** The folders read so far, by path (a folder shared by two roots is read once). */
  private readonly dirs = new Map<string, DirState>()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Folders whose disk changed while a read of them was running: they are read once more when it ends. */
  private readonly rerun = new Set<string>()
  /** How many folder reads this pad asked main for (the e2e counts them). */
  private reads = 0
  /** The expanded folders last announced to main (a list that did not change is not sent again). */
  private sentSig: string | undefined
  /** Why the pad cannot follow the disk by itself (a watcher failed), shown with an "Atualizar" action. */
  private notice: string | undefined
  private readonly noticeEl = el('div', 'xp-notice')
  /** The pad's own top bar (title, "Abrir pasta…", the pad's "⋯"): the first child of the card, always there. */
  private readonly topbar = el('div', 'xp-topbar')
  /** The area under the bars: the scrolling tree (with the layers over it) or the empty state. */
  private readonly body = el('div', 'xp-body')
  /** The scrolling element of the list, the ARIA tree and the keyboard's target. */
  private readonly scroll = el('div', 'xp-scroll')
  private readonly model = new IndexTreeModel<Row>('explorer', TOP)
  private readonly list: ListView<Node>
  /** The folders stuck on top of the tree while it scrolls (a layer over the scrolling element). */
  private readonly sticky: StickyScrollController<Row>
  /** Every node of the model by row key, and the tree rows by path however it is spelled. */
  private readonly nodes = new Map<string, Node>()
  private readonly byPath = new Map<string, Node>()
  /** The `msg` and `edit` nodes: rows the keyboard steps over. */
  private readonly extras = new Set<Node>()
  /** The row elements in the DOM and the node each one draws. */
  private readonly rendered = new Map<HTMLElement, Node>()
  private readonly spliceOptions: IIndexTreeModelSpliceOptions<Row, void>
  /** Fires after every change of the model (an operation waiting for its row listens). */
  private readonly changed = new Emitter<void>()
  /** Project roots whose folder is gone. */
  private readonly missing = new Set<string>()
  private readonly probed = new Set<string>()
  private disposed = false
  private hasTree = false
  private sig = ''
  /** The row the keyboard is on (the list's focus) and the selected one, by row key. */
  private focused: string | undefined
  private selected: string | undefined
  /** Type to navigate: the prefix typed so far and the timer that forgets it. */
  private typed = ''
  private typedTimer: ReturnType<typeof setTimeout> | undefined
  /** The name being edited in place; its folder's redraws wait until it ends (they would drop the input). */
  private editing: Editing | undefined
  private readonly deferred = new Set<string>()
  /**
   * A pointer press that started on the tree and has not ended yet. A row replaced between the press and the release would
   * make the browser drop the click (it is dispatched on the common ancestor of both targets), and any change of the model
   * can redraw the row under the pointer, so the redraws wait for the release and run right after the click.
   */
  private pressed = false
  private pressTimer: ReturnType<typeof setTimeout> | undefined
  private renderWaits: { force: boolean } | undefined
  private readonly onRelease = (ev: Event): void => { if (ev.type !== 'blur' || ev.target === window) this.release() }

  constructor(ui: TetherUi, host: PadHost, controls: ExplorerControls) {
    this.ui = ui
    this.host = host
    this.controls = controls
    this.ipc = ui.ipc<ExplorerChannels>()
    for (const [root, dirs] of Object.entries(readState(host.state).expanded)) this.expanded.set(root, new Set(dirs))
    this.spliceOptions = {
      onDidCreateNode: node => {
        this.nodes.set(node.element.key, node)
        if (isTreeRow(node)) this.byPath.set(pathKey(node.element.root, node.element.path), node)
        else this.extras.add(node)
      },
      // A redrawn folder creates its new nodes before it deletes the old ones of the same keys.
      onDidDeleteNode: node => {
        if (this.nodes.get(node.element.key) === node) this.nodes.delete(node.element.key)
        const pk = pathKey(node.element.root, node.element.path)
        if (isTreeRow(node) && this.byPath.get(pk) === node) this.byPath.delete(pk)
        this.extras.delete(node)
      },
    }
    this.buildTree()
    this.list = new ListView<Node>(this.scroll, { getHeight: node => node.element.kind === 'root' ? ROOT_HEIGHT : ROW_HEIGHT }, {
      renderElement: (node, _index, row) => this.renderRow(node, row),
      disposeElement: (_node, _index, row) => { this.rendered.delete(row) },
    }, { paddingTop: LIST_PADDING, paddingBottom: LIST_PADDING, rowRole: 'treeitem' })
    this.subs.push(this.list)
    this.subs.push(this.model.onDidSpliceRenderedNodes(({ start, deleteCount, elements }) => { this.list.splice(start, deleteCount, elements) }))
    // After the list's own splice listener: the sticky state is computed over a list that already matches the model.
    this.sticky = new StickyScrollController<Row>(this.body, this.list, this.model, (node, dom) => this.drawRow(node, dom, true), {
      paddingTop: LIST_PADDING, containerClassName: 'xp-sticky', rowClassName: 'xp-sticky-row',
    })
    this.subs.push(this.sticky)
    this.buildSticky()
    this.subs.push(this.list.onDidScroll(() => { this.syncActive(); this.placeMessage() }))
    this.subs.push(ui.workspace.onDidChange(() => this.render()))
    this.element.addEventListener('pointerdown', () => this.press(), true)
    for (const type of ['pointerup', 'pointercancel', 'dragend', 'blur'] as const) window.addEventListener(type, this.onRelease, true)
    this.subs.push(this.ipc.on('changed', dirs => this.onDiskChanged(dirs)))
    this.subs.push(this.ipc.on('rootMissing', (root, missing) => this.onRootMissing(root, missing)))
    this.subs.push(this.ipc.on('watchFailed', (_root, message) => this.setNotice(message)))
    this.buildTopbar()
    host.setMenuHosted(true)
    this.paintNotice()
    this.element.append(this.topbar, this.noticeEl, this.body)
    this.render()
    void this.loadRecent()
  }

  // ---------- PadView ----------

  focus(): void {
    if (!this.hasTree) { this.element.querySelector<HTMLElement>('.xp-primary')?.focus(); return }
    // Lands on the selected row (the file being worked on), else where the keyboard last was.
    const target = this.treeNode(this.selected) ?? this.treeNode(this.focused) ?? this.firstRow()
    if (target) this.setFocused(target, true)
    else this.scroll.focus()
  }

  /** The pad's "⋯" menu: the command and the two actions on the tree (the two toggles live in the header). */
  menu(): ContextMenuEntry[] {
    return [
      { icon: 'target', label: 'Revelar no explorador', run: () => this.controls.reveal() },
      'sep',
      { icon: 'arrows-clockwise', label: 'Atualizar', run: () => this.refresh() },
      { icon: 'arrows-in-line-vertical', label: 'Recolher tudo', run: () => this.collapseAll() },
    ]
  }

  /** "Seguir": the project of the agent that took the focus becomes the current one, shown (expanded, in view). */
  follow(root: string): void {
    this.ui.workspace.setCurrent(root)
    this.updateCurrent()
    const node = this.treeNode(rowKey(root, root))
    if (!node) return
    if (node.collapsed) { this.setOf(root).add(root); this.persist(); this.expandNode(node, false) }
    this.revealNode(node)
  }

  /** "Revelar no explorador": opens the folders down to the file, selects its row and scrolls to it. False when no project holds it. */
  async reveal(file: string): Promise<boolean> {
    const folder = this.ui.workspace.folderOf(file)
    if (!folder) return false
    const chain = revealChain(folder.path, file, CASE_INSENSITIVE)
    if (chain.length === 0) return false
    const root = folder.path
    this.ui.workspace.setCurrent(root)
    for (const dir of chain) {
      const node = await this.waitNode(root, dir)
      if (!node) return false
      // The row's own spelling is what the expanded set keeps (the disk's, not the note's).
      const path = node.element.path
      this.setOf(root).add(path)
      this.syncExpanded()
      if (node.collapsed) this.expandNode(node, false)
      await this.load(path).catch(() => {})
    }
    this.persist()
    const target = await this.waitNode(root, file)
    if (!target || this.disposed) return false
    this.select(target)
    this.updateCurrent()
    this.revealNode(target)
    return true
  }

  setVisible(visible: boolean): void {
    this.controls.visible?.(visible)
    if (!visible) return
    void this.loadRecent()
    // A project folder that came back (a drive plugged in again) or went away is noticed when the pad is shown.
    this.probed.clear()
    this.probeRoots(this.ui.workspace.folders())
    this.ipc.send('rewatch')
  }

  serialize(): unknown {
    const state = emptyState()
    for (const [root, dirs] of this.expanded) state.expanded[root] = [...dirs]
    return state
  }

  dispose(): void {
    clearTimeout(this.typedTimer)
    clearTimeout(this.pressTimer)
    for (const type of ['pointerup', 'pointercancel', 'dragend', 'blur'] as const) window.removeEventListener(type, this.onRelease, true)
    this.disposed = true
    this.changed.fire()
    this.changed.dispose()
    this.controls.visible?.(false)
    for (const s of this.subs) s.dispose()
    this.element.remove()
  }

  // ---------- a press in progress ----------

  /** The pointer went down on the tree: its redraws wait (a release that never reaches the window ends the wait on its own). */
  private press(): void {
    this.pressed = true
    clearTimeout(this.pressTimer)
    this.pressTimer = setTimeout(() => this.release(), PRESS_MAX_MS)
  }

  /** The pointer is up: the click runs first, then the redraws that waited (a task later). */
  private release(): void {
    if (!this.pressed) return
    this.pressed = false
    clearTimeout(this.pressTimer)
    setTimeout(() => this.flushWaiting(), 0)
  }

  private flushWaiting(): void {
    if (this.disposed || this.pressed) return
    const waits = this.renderWaits
    this.renderWaits = undefined
    for (const dir of [...this.deferred]) {
      if (this.editing?.dir === dir) continue
      this.deferred.delete(dir)
      // A whole redraw draws every folder from the model, so it covers the waiting ones.
      if (!waits) for (const node of this.expandedNodesOf(dir)) this.refill(node)
    }
    if (waits) this.render(waits.force)
  }

  // ---------- what the person does ----------

  /** "Abrir pasta…": the native folder picker, then open and pin what was picked. */
  async pickFolder(): Promise<void> {
    const picked = await this.ui.folders.pickFolder(this.ui.workspace.current())
    if (picked) this.openFolder(picked)
  }

  /** Open = open and pin (idempotent); it also goes to the app's recent folders. */
  private openFolder(path: string): void {
    this.ui.workspace.open(path)
    this.ui.folders.remember(path)
    const folder = this.ui.workspace.folderOf(path)
    if (folder) this.focused = rowKey(folder.path, folder.path)
    this.ui.workspace.setCurrent(path)
    this.render()
  }

  private act(action: RootAction, f: ProjectFolder): void {
    const ws = this.ui.workspace
    if (action === 'pin' || action === 'unpin' || action === 'close') {
      if (action === 'pin' ? !f.pinned : f.pinned) ws.togglePin(f.path)
    } else if (action === 'move-up') ws.move(f.path, 'up')
    else if (action === 'move-down') ws.move(f.path, 'down')
    else if (action === 'copy-path') this.ui.shell.writeClipboard(f.path)
    else if (action === 'reveal') void this.ui.shell.openPath(f.path)
    else if (action === 'find-in-folder') requestFindInFolder(f.path)
    else if (action === 'new-file' || action === 'new-folder' || action === 'new-pane') {
      const node = this.treeNode(rowKey(f.path, f.path))
      if (node) this.runOn(node, action)
    }
  }

  private showRootMenu(f: ProjectFolder, x: number, y: number): void {
    const list = this.ui.workspace.folders()
    const entries = rootMenu(f, list.findIndex(g => g.path === f.path), list.length, { search: this.searchActive() })
    this.ui.menus.context(x, y, entries.map((e): ContextMenuEntry => e === 'sep' ? 'sep' : {
      icon: e.icon, label: e.label, run: () => this.act(e.action, f), ...(e.disabled ? { disabled: true } : {}),
    }))
  }

  /** A file opens in the focused pane's tab group (or beside it): the core's file opening decides text, binary or too large. */
  private openFile(row: Row, side: boolean): void {
    void this.ui.openers.open(row.path, { side, root: row.root })
  }

  private itemAction(action: ItemAction, row: Row): void {
    if (action === 'open') this.openFile(row, false)
    else if (action === 'open-side') this.openFile(row, true)
    else if (action === 'reveal') void this.ui.shell.openPath(row.dir ? row.path : parentPath(row.path))
    else if (action === 'find-in-folder') requestFindInFolder(row.path)
    else {
      const node = this.treeNode(row.key)
      if (node) this.runOn(node, action)
    }
  }

  /** The search extension is active (optional: the explorer offers "Pesquisar na pasta…" only then). */
  private searchActive(): boolean {
    return this.ui.commands.ids().includes('search.focus')
  }

  private showItemMenu(row: Row, x: number, y: number): void {
    this.ui.menus.context(x, y, itemMenu(row.dir ? 'dir' : 'file', { search: this.searchActive() }).map((e): ContextMenuEntry => e === 'sep' ? 'sep' : {
      icon: e.icon, label: e.label, run: () => this.itemAction(e.action, row), ...(e.danger ? { danger: true } : {}),
    }))
  }

  // ---------- file operations (slice 5) ----------

  /** A command on the selected row, else the row the keyboard is on, else the current project's root, else the first root. */
  run(op: FileOp): void {
    const current = this.ui.workspace.current()
    const node = this.treeNode(this.selected) ?? this.treeNode(this.focused) ?? (current ? this.treeNode(rowKey(current, current)) : undefined) ?? this.rootNodes()[0]
    if (node) this.runOn(node, op)
  }

  private runOn(node: Node, op: FileOp): void {
    const row = node.element
    if (op === 'copy-path') this.ui.shell.writeClipboard(row.path)
    else if (op === 'copy-relative-path') this.ui.shell.writeClipboard(relativePath(row.root, row.path))
    else if (op === 'new-pane') this.ui.panes.newPanelDialog(this.ui.panes.activeId() ?? '', { cwd: row.dir ? row.path : parentPath(row.path) })
    else if (op === 'new-file' || op === 'new-folder') void this.newEntry(node, op === 'new-folder' ? 'dir' : 'file')
    else if (op === 'rename') { if (row.kind !== 'root') this.startRename(node) }
    else if (op === 'delete') { if (row.kind !== 'root') void this.trash(node) }
  }

  /** The keyboard fell to the page (an input row was removed under it): it goes back to the tree; a click elsewhere keeps its target. */
  private keyboardLost(): boolean { return !document.activeElement || document.activeElement === document.body }

  /** The names in a folder as last read (the validation's "already exists"). */
  private siblingsOf(dir: string): string[] { return (this.dirs.get(dir)?.entries ?? []).map(e => e.name) }

  /** The input of an in-place edit with its validation message (VS Code's InputBox with a message). */
  private editor(
    dir: string, value: string, current: string | undefined, isDir: boolean, target: { renameKey: string } | { newIn: string; ico: HTMLElement },
    onCommit: (name: string) => Promise<string | undefined>, onEnd: () => void,
  ): Editing {
    this.editing?.end()
    const input = el('input', 'xp-input')
    input.type = 'text'
    input.value = value
    input.spellcheck = false
    input.setAttribute('aria-label', current === undefined ? (isDir ? 'Nome da nova pasta' : 'Nome do novo arquivo') : `Novo nome de ${current}`)
    const message = el('div', 'xp-validate')
    message.setAttribute('role', 'alert')
    let done = false
    let busy = false
    const editing: Editing = {
      dir, input, message, problem: null, text: '', warning: false, ...target,
      end: () => {
        if (done) return
        done = true
        if (this.editing === editing) this.editing = undefined
        message.remove()
        onEnd()
        // The redraws that waited for the edit (the disk changed meanwhile, this operation's own change among them).
        if (this.deferred.delete(dir)) for (const node of this.expandedNodesOf(dir)) this.refill(node)
      },
    }
    const show = (problem: NameProblem | null, text?: string): void => {
      editing.problem = problem
      const msg = text ?? problem?.message
      editing.text = msg ?? ''
      editing.warning = !text && problem?.severity === 'warning'
      message.textContent = editing.text
      message.classList.toggle('warning', editing.warning)
      input.classList.toggle('invalid', !!msg && (!!text || problem?.severity === 'error'))
      this.placeMessage()
    }
    const validate = (): NameProblem | null => validateFileName(input.value, { siblings: this.siblingsOf(dir), ...(current !== undefined ? { current } : {}), isWindows: IS_WINDOWS })
    const commit = async (fromBlur: boolean): Promise<void> => {
      if (done || busy) return
      const name = input.value
      // Leaving the field with nothing typed (or the same name) is a cancel; leaving it with an invalid name too (VS Code).
      if (name.trim() === '' || name === current) { editing.end(); return }
      const problem = validate()
      if (problem?.severity === 'error') { if (fromBlur) editing.end(); else show(problem); return }
      busy = true
      const failure = await onCommit(name).catch((err: unknown) => (err as Error).message)
      busy = false
      if (failure === undefined) { editing.end(); return }
      if (fromBlur || done) { editing.end(); void this.ui.dialogs.ask(failedSituation(current === undefined ? `Não foi possível criar "${name}"` : `Não foi possível renomear "${current}"`, failure)); return }
      show(null, failure)
      input.focus()
    }
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'] as const) input.addEventListener(type, ev => ev.stopPropagation())
    input.addEventListener('input', () => show(validate()))
    input.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') { ev.preventDefault(); void commit(false) }
      else if (ev.key === 'Escape') { ev.preventDefault(); editing.end() }
    })
    // The input also loses the keyboard when its row leaves the rendered range (the list recycles the row): the commit runs
    // once the list's change is over, never inside it, and not when the input got the keyboard back meanwhile.
    input.addEventListener('blur', () => { queueMicrotask(() => { if (document.activeElement !== input) void commit(true) }) })
    this.editing = editing
    return editing
  }

  /** Puts the validation message just under the input (above it when there is no room below), or takes it away. */
  private placeMessage(): void {
    const e = this.editing
    if (!e) return
    const m = e.message
    if (!e.text || !e.input.isConnected) { m.remove(); return }
    if (m.parentElement !== this.body) this.body.append(m)
    const r = e.input.getBoundingClientRect()
    const b = this.body.getBoundingClientRect()
    m.style.left = `${r.left - b.left}px`
    m.style.width = `${r.width}px`
    let top = r.bottom - b.top
    const h = m.offsetHeight
    if (top + h > b.height && r.top - b.top - h >= 0) top = r.top - b.top - h
    m.style.top = `${top}px`
  }

  /** "Novo arquivo…"/"Nova pasta…": an input row at the top of the folder (the folder of a file row); Enter creates, and a file opens. */
  private async newEntry(node: Node, kind: 'file' | 'dir'): Promise<void> {
    const target = node.element.dir ? node : this.parentOf(node) ?? node
    const folder = target.element
    if (!folder.dir) return
    if (target.collapsed) this.toggle(target)
    await this.load(folder.path).catch(() => {})
    // An ancestor redrawn meanwhile replaced the folder's node: the current one is looked up by its key.
    const host = this.treeNode(folder.key)
    if (this.disposed || !host || host.collapsed) return
    const ico = el('span', 'xp-ico')
    setIcon(ico, kind === 'dir' ? 'folder' : 'file')
    const editKey = folder.key + KEY_SEP + 'edit'
    const editing = this.editor(folder.path, '', undefined, kind === 'dir', { newIn: folder.key, ico }, async name => {
      const sep = folder.path.includes('\\') ? '\\' : '/'
      const parts = name.trim().split(/[\\/]+/).filter(s => s !== '')
      const path = joinPath(folder.path, parts.join(sep))
      const res = await this.ipc.invoke('create', path, kind)
      if (!res.ok) return res.message
      void this.afterCreate(folder.root, path, kind, parts.length > 1)
      return undefined
    }, () => {
      const line = this.nodes.get(editKey)
      if (line) { this.model.splice(this.model.getNodeLocation(line), 1, [], this.spliceOptions); this.afterChange() }
      if (this.keyboardLost()) this.focusBack(folder.key)
    })
    if (kind === 'file') editing.input.addEventListener('input', () => setIcon(ico, (fileIcon(editing.input.value) || 'file') as IconName))
    this.model.splice([...this.model.getNodeLocation(host), 0], 0, [{ element: this.editRow(folder, editing, kind === 'dir') }], this.spliceOptions)
    this.afterChange()
    const line = this.nodes.get(editKey)
    if (line) this.revealNode(line)
    editing.input.focus()
  }

  /** The new entry shows up when the watcher redraws its folder: it is selected; a file opens in the editor (VS Code). */
  private async afterCreate(root: string, path: string, kind: 'file' | 'dir', nested: boolean): Promise<void> {
    if (kind === 'file') void this.ui.openers.open(path, { side: false, root })
    const shown = nested ? await this.reveal(path) : !!(await this.waitNode(root, path))
    const node = shown ? await this.waitNode(root, path) : undefined
    if (!node || this.disposed) return
    this.select(node)
    this.revealNode(node)
    if (kind === 'dir') this.setFocused(node, true)
  }

  /** F2 / "Renomear…": the name becomes an input with the name without its extension selected (VS Code). */
  private startRename(node: Node): void {
    const row = node.element
    const current = row.name
    const dir = parentPath(row.path)
    this.select(node)
    const editing = this.editor(dir, current, current, row.dir, { renameKey: row.key }, async name => {
      const to = joinPath(dir, name)
      const res = await this.ipc.invoke('rename', row.path, to)
      if (!res.ok) return res.message
      const shown = this.nodes.get(row.key)?.element
      if (shown) shown.name = name
      this.afterRename(row, to)
      return undefined
    }, () => {
      const shown = this.nodes.get(row.key)
      if (shown?.element.edit === editing) { shown.element.edit = undefined; this.redraw(shown) }
      if (this.keyboardLost()) this.focusBack(row.key)
    })
    row.edit = editing
    this.revealNode(node)
    this.redraw(node)
    editing.input.focus()
    const sel = renameSelection(current, row.dir)
    editing.input.setSelectionRange(sel.start, sel.end)
  }

  /** After a rename: the expanded folders and the selection move with it, the editors follow (TetherUi.files), the new row is selected. */
  private afterRename(row: Row, to: string): void {
    for (const set of this.expanded.values()) {
      for (const d of [...set]) { const next = rebasePath(d, row.path, to); if (next !== undefined) { set.delete(d); set.add(next) } }
    }
    for (const path of [...this.dirs.keys()]) if (rebasePath(path, row.path, to) !== undefined) this.dirs.delete(path)
    this.persist()
    this.selected = rowKey(row.root, to)
    this.focused = this.selected
    this.ui.files.didRename(row.path, to)
    void this.waitNode(row.root, to).then(node => {
      if (!node || this.disposed) return
      this.select(node)
      if (!this.editing) this.setFocused(node, true)
    })
  }

  /** Delete / "Mover para a lixeira": asks first (unless confirmDelete is off), then the system's trash; a failure deletes nothing and says why. */
  private async trash(node: Node): Promise<void> {
    const row = node.element
    const name = row.name
    if (this.controls.isOn('confirmDelete')) {
      const answer = await this.ui.dialogs.ask(deleteSituation(name, row.path, row.dir))
      if (answer.choice !== 'trash') { this.focusBack(row.key); return }
      if (answer.remember) this.controls.set('confirmDelete', false)
    }
    // Where the keyboard goes once the row is gone: the next row out of its subtree, else the one above.
    let nextKey: string | undefined
    const shown = this.treeNode(row.key)
    if (shown) {
      const index = this.indexOf(shown)
      const end = index + this.model.getListRenderCount(this.model.getNodeLocation(shown))
      const after = end < this.list.length ? this.list.element(end) : undefined
      const before = index > 0 ? this.list.element(index - 1) : undefined
      nextKey = isTreeRow(after) && after.element.root === row.root ? after.element.key : isTreeRow(before) ? before.element.key : undefined
    }
    const res = await this.ipc.invoke('trash', row.path)
    if (!res.ok) { await this.ui.dialogs.ask(trashFailedSituation(name, res.message)); this.focusBack(row.key); return }
    let changed = false
    for (const set of this.expanded.values()) for (const d of [...set]) if (rebasePath(d, row.path, row.path) !== undefined) { set.delete(d); changed = true }
    if (changed) this.persist()
    const next = this.treeNode(nextKey)
    if (next) { this.select(next); this.setFocused(next, true) }
  }

  /** The keyboard goes back to the tree, on the row of `key` when it is still there. */
  private focusBack(key: string): void {
    const node = this.treeNode(key)
    if (node) this.setFocused(node, true)
  }

  private async loadRecent(): Promise<void> {
    try { this.recent = await this.ui.folders.recent() } catch { this.recent = [] }
    if (this.ui.workspace.folders().length === 0) this.render(true)
  }

  // ---------- the model: folders read on demand ----------

  private setOf(root: string): Set<string> {
    let set = this.expanded.get(root)
    if (!set) {
      set = new Set()
      this.expanded.set(root, set)
      while (this.expanded.size > REMEMBERED_ROOTS) this.expanded.delete(this.expanded.keys().next().value!)
    }
    return set
  }

  /** Reads a folder (one read at a time) and redraws the rows that show it when what it holds changed. */
  private load(path: string): Promise<void> {
    const running = this.inflight.get(path)
    if (running) return running
    const p = (async () => {
      let next: DirState
      this.reads++
      try {
        const res = await this.ipc.invoke('readDir', path)
        if (res.ok) { next = { entries: res.entries }; this.missing.delete(path) }
        else { next = { error: res.message }; if (res.missing) this.missing.add(path); else this.missing.delete(path) }
      } catch (err) { next = { error: `Não foi possível ler a pasta: ${(err as Error).message}` } }
      const prev = this.dirs.get(path)
      this.dirs.set(path, next)
      if (this.disposed) return
      if (next.error !== undefined && this.missing.has(path)) this.forget(path)
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        if (this.editing?.dir === path || this.pressed) this.deferred.add(path)
        else for (const node of this.expandedNodesOf(path)) this.refill(node)
      }
      this.updateMissing()
    })().finally(() => {
      this.inflight.delete(path)
      if (this.rerun.delete(path) && !this.disposed) void this.load(path)
    })
    this.inflight.set(path, p)
    return p
  }

  /** A folder that is gone is no longer expanded (a project root stays expanded: the warning is on its row). */
  private forget(path: string): void {
    let changed = false
    for (const [root, set] of this.expanded) if (root !== path && set.delete(path)) changed = true
    if (changed) this.persist()
  }

  /** The open rows of a folder: one per project that shows it. */
  private expandedNodesOf(path: string): Node[] {
    const out: Node[] = []
    for (const root of this.rootNodes()) {
      const node = this.nodes.get(rowKey(root.element.root, path))
      if (isTreeRow(node) && node.element.dir && !node.collapsed) out.push(node)
    }
    return out
  }

  /** The tree elements of a folder's children, from its listing; an open child folder brings its own children (`loads`: the open folders not read yet). */
  private childElements(folder: Row, loads: string[]): ITreeElement<Row>[] {
    const state = this.dirs.get(folder.path)
    if (!state || (folder.kind === 'root' && this.missing.has(folder.path))) return []
    if (state.error !== undefined) {
      return [{ element: { kind: 'msg', root: folder.root, path: folder.path, level: folder.level + 1, dir: false, key: folder.key + KEY_SEP + 'msg', name: '', link: false, text: state.error } }]
    }
    const out: ITreeElement<Row>[] = []
    const editing = this.editing
    if (editing?.newIn === folder.key) out.push({ element: this.editRow(folder, editing, false) })
    const set = this.setOf(folder.root)
    for (const e of state.entries ?? []) {
      const path = joinPath(folder.path, e.name)
      const dir = e.kind === 'dir'
      const row: Row = { kind: 'item', root: folder.root, path, level: folder.level + 1, dir, key: rowKey(folder.root, path), name: e.name, link: !!e.link }
      if (editing?.renameKey === row.key) row.edit = editing
      if (!dir) { out.push({ element: row }); continue }
      const open = set.has(path)
      if (open && !this.dirs.has(path)) loads.push(path)
      out.push({ element: row, collapsible: true, collapsed: !open, ...(open ? { children: this.childElements(row, loads) } : {}) })
    }
    return out
  }

  private editRow(folder: Row, editing: Editing, dir: boolean): Row {
    return { kind: 'edit', root: folder.root, path: folder.path, level: folder.level + 1, dir, key: folder.key + KEY_SEP + 'edit', name: '', link: false, edit: editing }
  }

  /** A project root's tree element, with what it shows under it when it is open. */
  private rootElement(f: ProjectFolder, loads: string[]): ITreeElement<Row> {
    const row: Row = { kind: 'root', root: f.path, path: f.path, level: 1, dir: true, key: rowKey(f.path, f.path), name: f.name, link: false, folder: f }
    const open = this.setOf(f.path).has(f.path)
    if (open && !this.dirs.has(f.path)) loads.push(f.path)
    return { element: row, collapsible: true, collapsed: !open, children: open ? this.childElements(row, loads) : [] }
  }

  // ---------- expanding and collapsing ----------

  private toggle(node: Node): void {
    const row = node.element
    if (!row.dir) return
    const set = this.setOf(row.root)
    const open = !set.has(row.path)
    if (open) set.add(row.path); else set.delete(row.path)
    // Main hears of the folder before the first read of it, so no change slips between the read and the watch.
    this.persist()
    if (open) this.expandNode(node, true); else this.collapseNode(node)
  }

  /** Shows the folder's children: the ones already read at once, then a fresh read when asked (or when none was made). */
  private expandNode(node: Node, refresh: boolean): void {
    const path = node.element.path
    if (node.collapsed) this.model.setCollapsed(this.model.getNodeLocation(node), false)
    if (this.dirs.has(path)) this.refill(node)
    else this.afterChange()
    this.paint()
    if (refresh || !this.dirs.has(path)) void this.load(path)
  }

  private collapseNode(node: Node): void {
    this.dropChildren(node)
    this.model.setCollapsed(this.model.getNodeLocation(node), true)
    this.paint()
  }

  /** Removes a folder's children from the tree; the keyboard stays on the folder when it was inside them. */
  private dropChildren(node: Node): void {
    if (node.children.length === 0) return
    const inside = this.keyboardInside(node)
    this.model.splice([...this.model.getNodeLocation(node), 0], node.children.length, [], this.spliceOptions)
    if (inside && !this.nodes.has(this.focused ?? '')) this.focused = node.element.key
    this.afterChange()
  }

  /** The tree has the keyboard and its active row is below `node`. */
  private keyboardInside(node: Node): boolean {
    if (document.activeElement !== this.scroll) return false
    for (let n = this.treeNode(this.focused) as IIndexTreeNode<Row> | undefined; n; n = n.parent) if (n.parent === node) return true
    return false
  }

  // ---------- following the disk ----------

  /** Draws a folder's children again from the model (it changed on disk) without moving the person: same scroll, same selection, the keyboard on the same row. */
  private refill(node: Node): void {
    const scroll = this.list.scrollTop
    const inside = this.keyboardInside(node)
    const loads: string[] = []
    this.model.splice([...this.model.getNodeLocation(node), 0], node.children.length, this.childElements(node.element, loads), this.spliceOptions)
    if (inside && !this.nodes.has(this.focused ?? '')) this.focused = node.element.key
    if (this.list.scrollTop !== scroll) this.list.scrollTop = scroll
    this.afterChange()
    for (const path of loads) void this.load(path)
  }

  /** The disk changed under these folders: the ones drawn open are read again; a listing that is not drawn is forgotten (read afresh when shown). */
  private onDiskChanged(dirs: readonly string[]): void {
    if (this.disposed || !Array.isArray(dirs)) return
    for (const dir of dirs) {
      if (typeof dir !== 'string') continue
      if (this.expandedNodesOf(dir).length > 0) this.reload(dir)
      else this.dirs.delete(dir)
    }
  }

  /** A read that cannot overlap itself: a change that comes while the folder is being read makes one more read after it. */
  private reload(path: string): void {
    if (this.inflight.has(path)) { this.rerun.add(path); return }
    void this.load(path)
  }

  private onRootMissing(root: string, missing: boolean): void {
    if (this.disposed) return
    if (missing) { this.missing.add(root); this.updateMissing() } else { this.probed.delete(root); this.probeRoots(this.ui.workspace.folders()) }
  }

  /** "Atualizar": every folder drawn open is read again (only a changed one is redrawn), failed watchers try again, vanished roots are looked for. */
  refresh(): void {
    this.setNotice(undefined)
    this.ipc.send('rewatch')
    this.probed.clear()
    this.probeRoots(this.ui.workspace.folders())
    const shown = new Set<string>()
    for (const node of [...this.nodes.values()]) {
      if (!isTreeRow(node) || !node.element.dir || node.collapsed || shown.has(node.element.path)) continue
      shown.add(node.element.path)
      this.reload(node.element.path)
    }
    for (const path of [...this.dirs.keys()]) if (!shown.has(path)) this.dirs.delete(path)
  }

  /** "Recolher tudo": every folder under the project roots closes; the roots stay open (they are the headings of the pad). */
  collapseAll(): void {
    for (const [root, set] of this.expanded) { const open = set.has(root); set.clear(); if (open) set.add(root) }
    this.persist()
    for (const root of [...this.rootNodes()]) if (!root.collapsed) this.refill(root)
    this.list.scrollTop = 0
  }

  private setNotice(message: string | undefined): void {
    this.notice = message
    this.paintNotice()
  }

  private paintNotice(): void {
    const n = this.noticeEl
    n.hidden = this.notice === undefined
    n.replaceChildren()
    if (this.notice === undefined) return
    n.setAttribute('role', 'status')
    const text = el('span', 'xp-notice-text', 'O explorador não está acompanhando o disco.')
    text.title = this.notice
    const button = el('button', 'xp-notice-btn', 'Atualizar')
    button.type = 'button'
    button.addEventListener('click', () => this.refresh())
    n.append(icon('warning'), text, button)
  }

  /** Tells main which folders are open (the whole list; unchanged lists are not sent). */
  private syncExpanded(): void {
    const all = new Set<string>()
    for (const set of this.expanded.values()) for (const d of set) all.add(d)
    const list = [...all].sort()
    const sig = list.join('\n')
    if (sig === this.sentSig) return
    this.sentSig = sig
    this.ipc.send('setExpanded', list)
  }

  /** The expanded folders changed: the layout saves them and main learns of them. */
  private persist(): void {
    this.host.persist()
    this.syncExpanded()
  }

  /** For the e2e: what the disk watchers of the main side hold. */
  watchStats(): Promise<unknown> { return this.ipc.invoke('watchStats') }

  // ---------- the model's nodes ----------

  private rootNodes(): Node[] { return this.model.getNode([]).children }

  /** The tree row (a root or an item) of a key, when the tree shows it. */
  private treeNode(key: string | undefined): Node | undefined {
    const node = key === undefined ? undefined : this.nodes.get(key)
    return isTreeRow(node) ? node : undefined
  }

  /** The tree row of a path under a root, however the path is spelled. */
  private nodeAt(root: string, path: string): Node | undefined { return this.byPath.get(pathKey(root, path)) }

  /** The row of a path once the tree shows it (a folder being read, a redraw that waits for a press or the watcher); undefined if it never shows. */
  private waitNode(root: string, path: string): Promise<Node | undefined> {
    const now = this.nodeAt(root, path)
    if (now || this.disposed) return Promise.resolve(now)
    return new Promise(resolve => {
      const done = (node: Node | undefined): void => { clearTimeout(timer); sub.dispose(); resolve(node) }
      const sub = this.changed.event(() => {
        const node = this.nodeAt(root, path)
        if (node || this.disposed) done(node)
      })
      const timer = setTimeout(() => done(this.nodeAt(root, path)), ROW_WAIT_MS)
    })
  }

  private parentOf(node: Node): Node | undefined {
    const parent = (node as IIndexTreeNode<Row>).parent
    return parent && parent.element !== TOP ? parent : undefined
  }

  private firstRow(): Node | undefined {
    for (let i = 0; i < this.list.length; i++) { const node = this.list.element(i); if (isTreeRow(node)) return node }
    return undefined
  }

  /** The list index of a node (linear in the siblings before it at each level). */
  private indexOf(node: Node): number { return this.model.getListIndex(this.model.getNodeLocation(node)) }

  /** The model changed: the active row's id, the message's place, and whoever waits for a row. */
  private afterChange(): void {
    this.syncActive()
    this.placeMessage()
    this.changed.fire()
  }

  // ---------- selection and keyboard ----------

  /** Moves the keyboard to `node`; `focus` also puts the keyboard in the tree and brings the row into view. */
  private setFocused(node: Node, focus: boolean): void {
    this.focused = node.element.key
    this.paint()
    if (!focus) return
    if (document.activeElement !== this.scroll) this.scroll.focus({ preventScroll: true })
    this.revealNode(node)
  }

  /**
   * Scrolls only as much as needed for the row to show below the folders that would stick above it (AbstractTree.reveal);
   * the first and the last row bring the list's padding along.
   */
  private revealNode(node: Node): void {
    const index = this.indexOf(node)
    if (index < 0 || index >= this.list.length) return
    this.list.reveal(index, undefined, this.sticky.nodePositionTopBelowWidget(node))
    if (index === 0) this.list.scrollTop = 0
    else if (index === this.list.length - 1 && this.list.getRelativeTop(index) !== null) this.list.scrollTop = this.list.scrollHeight
  }

  private select(node: Node): void {
    this.selected = node.element.key
    this.focused = node.element.key
    this.paint()
    const root = node.element.root
    if (this.ui.workspace.current() !== root) { this.ui.workspace.setCurrent(root); this.updateCurrent() }
  }

  /** The row the keys act on: where the keyboard is, else the first row. */
  private activeNode(): Node | undefined { return this.treeNode(this.focused) ?? this.firstRow() }

  private onClick(node: Node, ev: MouseEvent): void {
    this.select(node)
    if (node.element.dir) this.toggle(node)
    else this.openFile(node.element, ev.ctrlKey || ev.metaKey)
  }

  /**
   * The rows the keyboard walks: the list without the `msg` and `edit` rows (few: one per folder that failed, one input),
   * read one at a time, with the conversions between its indices and the list's.
   */
  private navRows(): { rows: Indexed<NavRow>; names: Indexed<string>; toList(i: number): number; fromList(i: number): number } {
    const skips = [...this.extras].map(n => this.indexOf(n)).filter(i => i >= 0).sort((a, b) => a - b)
    const toList = (i: number): number => { let at = i; for (const s of skips) { if (s <= at) at++; else break } return at }
    const fromList = (i: number): number => { let at = i; for (const s of skips) { if (s < i) at--; else break } return at }
    const length = this.list.length - skips.length
    const node = (i: number): Node | undefined => i >= 0 && i < length ? this.list.element(toList(i)) : undefined
    return {
      rows: { length, at: i => { const n = node(i); return n && { level: n.element.level, dir: n.element.dir, expanded: n.element.dir && !n.collapsed } } },
      names: { length, at: i => node(i)?.element.name },
      toList, fromList,
    }
  }

  private onKey(ev: KeyboardEvent): void {
    const node = this.activeNode()
    if (!node) return
    const row = node.element
    if (ev.key === 'Escape') {
      // The keyboard goes back to the pane that had it.
      const back = this.ui.panes.activeId()
      if (back) { ev.preventDefault(); this.ui.panes.focus(back) }
      return
    }
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      this.revealNode(node)
      const dom = this.domOf(node)
      const r = (dom ?? this.scroll).getBoundingClientRect()
      this.menuFor(node, r.left + 24, dom ? r.bottom : r.top)
      return
    }
    if (!ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && (ev.key === 'F2' || ev.key === 'Delete')) {
      ev.preventDefault()
      this.runOn(node, ev.key === 'F2' ? 'rename' : 'delete')
      return
    }
    if (ev.altKey || ev.metaKey || (ev.ctrlKey && ev.key !== 'Enter')) return
    if (ev.key === 'PageDown' || ev.key === 'PageUp') { ev.preventDefault(); this.page(node, ev.key === 'PageDown'); return }
    if (!ev.ctrlKey && isTypeAheadKey(ev.key, this.typed)) { ev.preventDefault(); this.typeAhead(node, ev.key); return }
    if (ev.ctrlKey && !row.dir) { ev.preventDefault(); this.openFile(row, true); return }
    const nav = this.navRows()
    const action = navigate(nav.rows, nav.fromList(this.indexOf(node)), ev.key)
    if (action.type === 'none') return
    ev.preventDefault()
    if (action.type === 'focus') { this.setFocused(this.list.element(nav.toList(action.index)), true); return }
    this.select(node)
    if (action.type === 'open') this.openFile(row, false)
    else this.toggle(node) // toggle, expand and collapse: the rule already checked the state
  }

  /** Type to navigate: the keyboard jumps to the next row whose name starts with what was typed (wrapping); 800 ms of silence starts over. */
  private typeAhead(node: Node, key: string): void {
    this.typed += key
    clearTimeout(this.typedTimer)
    this.typedTimer = setTimeout(() => { this.typed = '' }, TYPE_AHEAD_RESET_MS)
    const nav = this.navRows()
    const at = typeAheadMatch(nav.names, nav.fromList(this.indexOf(node)), this.typed)
    if (at >= 0) this.setFocused(this.list.element(nav.toList(at)), true)
  }

  /** PageUp/PageDown: the first press goes to the edge of what is in view, the next one a page further. */
  private page(node: Node, down: boolean): void {
    const nav = this.navRows()
    if (nav.rows.length === 0 || this.list.length === 0) return
    // The rows under the sticky folders are not in view (AbstractTree.focusPreviousPage's getPaddingTop).
    const covered = this.sticky.height
    const top = this.list.scrollTop + covered
    const height = this.list.renderHeight - covered
    const lastIndex = this.list.length - 1
    // The rows entirely in view.
    let first = Math.min(this.list.indexAt(top), lastIndex)
    if (this.list.elementTop(first) < top - 1 && first < lastIndex) first++
    let last = Math.min(this.list.indexAt(top + height - 1), lastIndex)
    if (this.list.elementTop(last) + this.list.elementHeight(last) > top + height + 1 && last > first) last--
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT))
    const at = pageTarget(nav.fromList(this.indexOf(node)), nav.rows.length, nav.fromList(first), nav.fromList(last), page, down)
    if (at >= 0) this.setFocused(this.list.element(nav.toList(at)), true)
  }

  private menuFor(node: Node, x: number, y: number): void {
    const row = node.element
    this.setFocused(node, false)
    if (row.kind === 'root') {
      const f = this.ui.workspace.folders().find(g => g.path === row.path)
      if (f) this.showRootMenu(f, x, y)
    } else this.showItemMenu(row, x, y)
  }

  // ---------- drawing ----------

  /** The tree's scrolling element, its ARIA role and its keys; the list's events are delegated to it (rows are recycled). */
  private buildTree(): void {
    const s = this.scroll
    s.tabIndex = 0
    s.setAttribute('role', 'tree')
    s.setAttribute('aria-label', 'Projetos')
    // F2 and Delete are the tree's (rename, trash), not the app's F2 "renomear painel".
    s.dataset.ownKeys = 'F2 Delete'
    s.addEventListener('keydown', ev => this.onKey(ev))
    // The keyboard arriving with no row to stand on (the first time, or its row is gone) lands on the first row.
    s.addEventListener('focus', () => { if (!this.treeNode(this.focused)) { const first = this.firstRow(); if (first) this.focused = first.element.key } this.paint() })
    const rowOf = (ev: Event): Node | undefined => {
      const dom = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.xp-row')
      const node = dom ? this.rendered.get(dom) : undefined
      return isTreeRow(node) ? node : undefined
    }
    s.addEventListener('click', ev => { const node = rowOf(ev); if (node) this.onClick(node, ev) })
    s.addEventListener('contextmenu', ev => {
      const node = rowOf(ev)
      if (!node) return
      ev.preventDefault()
      if (node.element.kind === 'item') this.select(node)
      this.menuFor(node, ev.clientX, ev.clientY)
    })
  }

  /**
   * The sticky layer's events (it lies over the scrolling element, not inside it). A click is VS Code's
   * handleStickyScrollMouseEvent: the folder's real row scrolls to just under its own sticky ancestors and takes the
   * selection and the keyboard; on the twistie it also collapses. The wheel scrolls the tree under it.
   */
  private buildSticky(): void {
    const s = this.sticky.domNode
    const stickyRow = (ev: Event): Node | undefined => {
      const node = this.sticky.nodeOfElement(ev.target as HTMLElement)
      return isTreeRow(node) ? node : undefined
    }
    s.addEventListener('click', ev => {
      const node = stickyRow(ev)
      if (!node) return
      const index = this.indexOf(node)
      if (index < 0 || index >= this.list.length) return
      const onTwistie = !!(ev.target as HTMLElement).closest('.xp-twist')
      this.list.scrollTop = this.list.getElementTop(index) - this.sticky.nodePositionTopBelowWidget(node)
      this.select(node)
      this.setFocused(node, true)
      if (onTwistie && node.element.dir) this.toggle(node)
    })
    s.addEventListener('contextmenu', ev => {
      const node = stickyRow(ev)
      if (!node) return
      ev.preventDefault()
      if (node.element.kind === 'item') this.select(node)
      this.menuFor(node, ev.clientX, ev.clientY)
    })
    s.addEventListener('wheel', ev => {
      ev.preventDefault()
      const unit = ev.deltaMode === 1 ? ROW_HEIGHT : ev.deltaMode === 2 ? this.list.renderHeight : 1
      this.scroll.scrollBy(ev.deltaX * unit, ev.deltaY * unit)
    }, { passive: false })
    // The layer leaves the vertical scrollbar uncovered: it is as wide as the scrolling element's content box.
    const fit = (): void => { s.style.width = `${this.scroll.clientWidth}px` }
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit)
      ro.observe(this.scroll)
      this.subs.push({ dispose: () => ro.disconnect() })
    }
    this.subs.push(this.list.onDidScroll(fit))
    fit()
  }

  private render(force = false): void {
    if (this.pressed) { this.renderWaits = { force: force || (this.renderWaits?.force ?? false) }; return }
    const folders = this.ui.workspace.folders()
    const sig = JSON.stringify(folders.map(f => [f.path, f.name, f.pinned, f.agents]))
    // Only the current project changed (a click, "seguir"): the rows stay as they are.
    if (!force && folders.length > 0 && this.hasTree && sig === this.sig) { this.updateCurrent(); return }
    this.sig = sig
    const hadFocus = this.element.contains(document.activeElement)
    const scroll = this.list.scrollTop
    this.ipc.send('setRoots', folders.map(f => f.path))
    const top = this.model.getNode([])
    if (folders.length === 0) {
      this.hasTree = false
      this.model.splice([0], top.children.length, [], this.spliceOptions)
      this.afterChange()
      this.body.replaceChildren(this.emptyState())
    } else {
      this.hasTree = true
      if (this.scroll.parentElement !== this.body) this.body.replaceChildren(this.scroll, this.sticky.domNode)
      // A root met for the first time starts expanded (VS Code's roots are); a person's collapse is remembered.
      let changed = false
      for (const f of folders) if (!this.expanded.has(f.path)) { this.setOf(f.path).add(f.path); changed = true }
      if (changed) this.host.persist()
      this.syncExpanded()
      const loads: string[] = []
      this.model.splice([0], top.children.length, folders.map(f => this.rootElement(f, loads)), this.spliceOptions)
      this.afterChange()
      for (const path of loads) void this.load(path)
      this.probeRoots(folders)
    }
    this.updateTopbar()
    this.list.scrollTop = scroll
    if (hadFocus) this.focus()
  }

  private probeRoots(folders: readonly ProjectFolder[]): void {
    for (const f of folders) {
      if (this.probed.has(f.path)) continue
      this.probed.add(f.path)
      void this.ipc.invoke('stat', f.path).then(s => {
        if (this.disposed) return
        if (s.kind === 'dir') {
          // The folder came back: read it again.
          if (this.missing.delete(f.path)) { this.dirs.delete(f.path); for (const n of this.expandedNodesOf(f.path)) this.expandNode(n, true) }
        } else this.missing.add(f.path)
        this.updateMissing()
      }, () => {})
    }
  }

  /** The "pasta não encontrada" warning on the root rows whose folder is gone (and no children under them). */
  private updateMissing(): void {
    for (const root of [...this.rootNodes()]) if (this.missing.has(root.element.path)) this.dropChildren(root)
    this.paint()
  }

  private updateCurrent(): void { this.paint() }

  /** Title on the left; on the right "Abrir pasta…" and the pad's "⋯" (the core's items, then the explorer's own). */
  private buildTopbar(): void {
    const open = el('button', 'ib xp-open')
    open.type = 'button'; open.title = OPEN_FOLDER_LABEL; open.setAttribute('aria-label', OPEN_FOLDER_LABEL)
    open.append(icon('folder-open'))
    open.addEventListener('click', () => { void this.pickFolder() })
    const more = el('button', 'ib xp-more')
    more.type = 'button'; more.title = 'Mais ações da prancheta'; more.setAttribute('aria-label', 'Mais ações da prancheta')
    more.append(icon('dots-three'))
    const follow = this.toggleButton('follow', 'target', 'Seguir o agente ativo')
    const autoReveal = this.toggleButton('autoReveal', 'eye', 'Revelar o arquivo ativo')
    more.addEventListener('click', ev => {
      ev.stopPropagation()
      const r = more.getBoundingClientRect()
      this.ui.menus.context(r.left, r.bottom + 4, [...this.host.menuItems(), 'sep', ...this.menu()])
    })
    this.topbar.append(
      el('span', 'xp-topbar-title', 'Explorador de Projeto'), el('span', 'xp-sp'),
      this.actionButton('xp-new-file', 'file-plus', 'Novo arquivo…', () => this.run('new-file')),
      this.actionButton('xp-new-folder', 'folder-plus', 'Nova pasta…', () => this.run('new-folder')),
      this.actionButton('xp-collapse', 'arrows-in-line-vertical', 'Recolher tudo', () => this.collapseAll()),
      follow, autoReveal, open, more,
    )
    this.updateTopbar()
  }

  /** A top bar icon button that acts on the tree. */
  private actionButton(className: string, ic: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', `ib ${className} xp-tree-action`)
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label)
    b.append(icon(ic))
    b.addEventListener('click', onClick)
    return b
  }

  /** The three tree actions need a tree: with no project open they are disabled. */
  private updateTopbar(): void {
    for (const b of this.topbar.querySelectorAll<HTMLButtonElement>('.xp-tree-action')) b.disabled = !this.hasTree
  }

  /** A header toggle: `aria-pressed` mirrors the setting, kept in sync when it changes elsewhere. */
  private toggleButton(key: 'follow' | 'autoReveal', ic: IconName, label: string): HTMLButtonElement {
    const b = el('button', 'ib xp-toggle')
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label)
    b.append(icon(ic))
    const paint = (): void => b.setAttribute('aria-pressed', String(this.controls.isOn(key)))
    paint()
    b.addEventListener('click', () => { this.controls.toggle(key); paint() })
    this.subs.push(this.controls.onChange(key, paint))
    return b
  }

  private button(className: string, label: string, ic: IconName, onClick: () => void): HTMLButtonElement {
    const b = el('button', className)
    b.type = 'button'
    b.append(icon(ic), el('span', 'xp-btn-text', label))
    b.addEventListener('click', onClick)
    return b
  }

  private emptyState(): HTMLElement {
    const box = el('div', 'xp-empty')
    const art = el('div', 'xp-empty-art')
    art.append(icon('folder-open'))
    box.append(art, el('h3', 'xp-empty-title', EMPTY_TITLE), el('p', 'xp-empty-help', EMPTY_HELP))
    box.append(this.button('xp-primary', OPEN_FOLDER_LABEL, 'folder-open', () => { void this.pickFolder() }))
    const offer = recentToOffer(this.recent, [], CASE_INSENSITIVE)
    if (offer.length) {
      const sec = el('section', 'xp-recent')
      sec.setAttribute('aria-label', RECENT_TITLE)
      sec.append(el('h4', 'xp-recent-title', RECENT_TITLE))
      for (const path of offer) {
        const r = recentRow(path)
        const b = el('button', 'xp-recent-item')
        b.type = 'button'
        b.title = path
        b.append(icon('folder'), el('span', 'xp-recent-name', r.name), el('span', 'xp-recent-dir', r.parent))
        b.addEventListener('click', () => this.openFolder(path))
        sec.append(b)
      }
      box.append(sec)
    }
    return box
  }

  // ---------- the rows ----------

  /** The row element of a node, when it is in the DOM. */
  private domOf(node: Node): HTMLElement | undefined {
    for (const [dom, n] of this.rendered) if (n === node) return dom
    return undefined
  }

  /** Draws a row again (its structure changed: an input in place of the name, or back). */
  private redraw(node: Node): void {
    const index = this.indexOf(node)
    if (index >= 0 && index < this.list.length) this.list.updateElement(index)
    if (this.sticky.state?.contains(node)) this.sticky.rerender()
    this.syncActive()
  }

  private twistie(dir: boolean): HTMLElement {
    const t = el('span', 'xp-twist')
    if (dir) t.append(icon('caret-right'))
    return t
  }

  private editBox(editing: Editing): HTMLElement {
    const box = el('div', 'xp-edit-box')
    // The same input across redraws of the row: what was typed, the selection and the listeners stay.
    box.append(editing.input)
    return box
  }

  /** The list's renderer: a row element (clean, positioned by the list) gets what the node shows. */
  private renderRow(node: Node, dom: HTMLElement): void {
    this.rendered.set(dom, node)
    this.drawRow(node, dom, false)
  }

  /** Draws a node into a row element: a row of the list, or a sticky copy of it (which never takes the in-place edit's input). */
  private drawRow(node: Node, dom: HTMLElement, sticky: boolean): void {
    const row = node.element
    const level = String(row.level)
    dom.dataset.level = level
    dom.style.setProperty('--lvl', level)
    if (row.kind === 'msg') {
      dom.className = 'xp-msg'
      dom.setAttribute('role', 'none')
      dom.title = row.text ?? ''
      dom.append(el('span', 'xp-msg-text', row.text ?? ''))
      return
    }
    if (row.kind === 'edit') {
      dom.className = 'xp-row xp-edit'
      dom.setAttribute('role', 'none')
      if (row.edit?.ico) dom.append(this.twistie(false), row.edit.ico, this.editBox(row.edit))
      return
    }
    const parent = (node as IIndexTreeNode<Row>).parent
    dom.className = row.kind === 'root' ? 'xp-row xp-root' : 'xp-row xp-item'
    dom.dataset.root = row.root
    dom.dataset.path = row.path
    dom.dataset.kind = row.dir ? 'dir' : 'file'
    dom.dataset.key = row.key
    dom.setAttribute('aria-level', level)
    if (parent) { dom.setAttribute('aria-setsize', String(parent.visibleChildrenCount)); dom.setAttribute('aria-posinset', String(node.visibleChildIndex + 1)) }
    if (row.kind === 'root') this.drawRoot(row, dom)
    else {
      const ico = el('span', 'xp-ico')
      if (!row.dir) setIcon(ico, fileIcon(row.name) as IconName)
      dom.title = row.link ? `${row.path}\nAtalho` : row.path
      dom.append(this.twistie(row.dir), ico, row.edit && !sticky ? this.editBox(row.edit) : el('span', 'xp-name', row.name))
    }
    this.paintRow(dom, node)
  }

  private drawRoot(row: Row, dom: HTMLElement): void {
    const f = row.folder!
    dom.dataset.isRoot = 'true'
    dom.dataset.pinned = String(f.pinned)
    dom.title = rootTitle(f)
    const ico = el('span', 'xp-ico')
    ico.append(icon('folder', 'xp-folder'))
    dom.append(this.twistie(true), ico, el('span', 'xp-name', f.name))
    const warn = el('span', 'xp-warn', MISSING_TEXT)
    warn.title = MISSING_TITLE
    dom.append(warn)
    const hintText = agentsHint(f.agents.length)
    if (hintText) {
      const hint = el('span', 'xp-hint', hintText)
      // The panes' places are read when the pointer arrives: a pane may have moved desks since the last render.
      const tip = (): void => { hint.title = agentsTooltip(f.agents.map(id => this.ui.panes.describe(id)).filter(p => p !== undefined)) }
      hint.addEventListener('mouseenter', tip)
      dom.append(hint)
    }
    dom.append(el('span', 'xp-sp'))
    const pin = el('button', 'xp-pin')
    pin.type = 'button'
    pin.tabIndex = -1
    pin.title = pinLabel(f)
    pin.setAttribute('aria-label', pinLabel(f))
    pin.setAttribute('aria-pressed', String(f.pinned))
    pin.append(icon(f.pinned ? 'push-pin-fill' : 'push-pin'))
    pin.addEventListener('click', ev => { ev.stopPropagation(); this.ui.workspace.togglePin(f.path) })
    dom.append(pin)
  }

  /** What a row shows that changes without redrawing it: expanded, selected, the keyboard, the current project, a missing folder. */
  private paintRow(dom: HTMLElement, node: Node): void {
    const row = node.element
    if (!isTreeRow(node)) return
    const open = row.dir && !node.collapsed
    if (row.dir) dom.setAttribute('aria-expanded', String(open))
    const selected = row.key === this.selected
    dom.setAttribute('aria-selected', String(selected))
    dom.classList.toggle('selected', selected && row.kind === 'item')
    dom.classList.toggle('focused', row.key === this.focused)
    if (row.kind === 'root') {
      const current = row.path === this.ui.workspace.current()
      dom.classList.toggle('current', current)
      if (current) dom.setAttribute('aria-current', 'true'); else dom.removeAttribute('aria-current')
      const gone = this.missing.has(row.path)
      dom.classList.toggle('missing', gone)
      const warn = dom.querySelector<HTMLElement>('.xp-warn')
      if (warn) warn.hidden = !gone
    } else if (row.dir) {
      const ico = dom.querySelector<HTMLElement>(':scope > .xp-ico')
      if (ico) setIcon(ico, open ? 'folder-open' : 'folder')
    }
  }

  /** Paints every row in the DOM again (the selection, the keyboard or the current project moved). */
  private paint(): void {
    for (const [dom, node] of this.rendered) this.paintRow(dom, node)
    for (const [dom, node] of this.sticky.rows()) this.paintRow(dom, node)
    this.syncActive()
  }

  /** The tree names its active row for assistive technology, while that row is in the DOM. */
  private syncActive(): void {
    let id: string | undefined
    if (this.focused !== undefined) for (const [dom, node] of this.rendered) if (node.element.key === this.focused) { id = dom.id; break }
    if (id) this.scroll.setAttribute('aria-activedescendant', id)
    else this.scroll.removeAttribute('aria-activedescendant')
  }

  /** For the e2e: what the pad shows (every row of the tree, in the DOM or not). */
  snapshot(): {
    mode: 'empty' | 'roots'
    roots: { path: string; name: string; pinned: boolean; hint: string; current: boolean; missing: boolean }[]
    rows: SnapshotRow[]
    messages: string[]
    recent: string[]
    reads: number
    notice: string
    edit: { value: string; message: string; severity: string; selection: [number, number] } | undefined
    rendered: number
    /** The paths of the sticky rows, top to bottom. */
    sticky: string[]
  } {
    const current = this.ui.workspace.current()
    const hasKeyboard = document.activeElement === this.scroll
    const rows: SnapshotRow[] = []
    const messages: string[] = []
    for (let i = 0; i < this.list.length; i++) {
      const node = this.list.element(i)
      const r = node.element
      if (r.kind === 'msg') { messages.push(r.text ?? ''); continue }
      rows.push({
        root: r.kind === 'edit' ? '' : r.root, path: r.kind === 'edit' ? '' : r.path, name: r.kind === 'edit' ? '' : r.name, level: r.level,
        kind: r.kind === 'edit' ? '' : r.dir ? 'dir' : 'file', expanded: r.kind !== 'edit' && r.dir && !node.collapsed,
        selected: r.kind === 'item' && r.key === this.selected, focused: hasKeyboard && r.kind !== 'edit' && r.key === this.focused,
      })
    }
    return {
      mode: this.hasTree ? 'roots' : 'empty',
      roots: this.rootNodes().map(n => {
        const f = n.element.folder!
        return { path: f.path, name: f.name, pinned: f.pinned, hint: agentsHint(f.agents.length), current: f.path === current, missing: this.missing.has(f.path) }
      }),
      rows,
      messages,
      recent: [...this.element.querySelectorAll<HTMLElement>('.xp-recent-item')].map(b => b.title),
      reads: this.reads,
      notice: this.notice === undefined ? '' : (this.noticeEl.textContent ?? ''),
      edit: this.editing ? {
        value: this.editing.input.value,
        message: this.editing.text,
        severity: this.editing.text ? (this.editing.warning ? 'warning' : 'error') : '',
        selection: [this.editing.input.selectionStart ?? 0, this.editing.input.selectionEnd ?? 0],
      } : undefined,
      rendered: this.rendered.size,
      sticky: this.sticky.rows().map(([, node]) => node.element.path),
    }
  }
}
