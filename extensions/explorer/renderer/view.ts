// The explorer pad (F8): the window's project roots with the file tree under each, or the empty state. The roots come from
// the core's workspace service (TetherUi.workspace); this view shows and edits them (pin, close, move) and draws their
// folders. Slice 1b: a folder is read only when expanded (the main side lists one folder at a time on the bus
// `ext:explorer:*`), its rows are inserted after the folder's row, and the expanded folders are kept in the pad's state.
// Slice 3: the pad follows the disk (the main side tells which expanded folders changed; only those are read again, and the
// scroll, the selection and the keyboard stay where they were) and has "Atualizar" and "Recolher tudo" in its "⋯" menu.
// Slice 5: the file operations. New file/folder and rename edit the name in place (an input row, VS Code's explorerViewer
// edit mode, with fileActions' name validation), "Mover para a lixeira" asks first (setting confirmDelete), and the tree is
// redrawn by the disk watcher (slice 3), never by the operation itself.
// The model follows VS Code's explorer (explorerModel: children resolved lazily per expanded folder; explorerViewer: the
// twistie, the indent, the multi-root folder rows; the list's keys). The empty state follows VS Code's empty view
// ("You have not yet opened a folder" + "Open Folder"), made useful with the app's recent folders.
import type { ContextMenuEntry, PadHost, PadView, ProjectFolder, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, setIcon, type IconName } from '../../../app/renderer/icons.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import { fileIcon } from '../../../app/shared/quick-open.ts'
import { rebasePath } from '../../../app/shared/notes.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { renameSelection, validateFileName, type NameProblem } from '../file-names.ts'
import type { Entry, ExplorerChannels } from '../ipc.ts'
import { emptyState, isTypeAheadKey, joinPath, navigate, pageTarget, parentPath, readState, revealChain, samePath, TYPE_AHEAD_RESET_MS, typeAheadMatch, type NavRow } from '../tree-rules.ts'
import {
  agentsHint, agentsTooltip, deleteSituation, EMPTY_HELP, EMPTY_TITLE, itemMenu, type ItemAction, MISSING_TEXT, MISSING_TITLE, OPEN_FOLDER_LABEL, pinLabel,
  recentRow, recentToOffer, RECENT_TITLE, relativePath, rootMenu, rootTitle, type RootAction, failedSituation, trashFailedSituation,
} from './rules.ts'

const IS_WINDOWS = /^win/i.test(navigator.platform)

/** A file operation the commands run on the selected row. */
export type FileOp = 'new-file' | 'new-folder' | 'rename' | 'delete' | 'copy-path' | 'copy-relative-path' | 'new-pane'

/** The name being edited in place (new file/folder or rename), for the e2e and for the redraws that wait for it. */
interface Editing { dir: string; input: HTMLInputElement; message: HTMLElement; problem: NameProblem | null; end(): void }

const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)
/** How many rows a big folder paints at once; the rest follow in later tasks so the window never freezes on a folder of thousands. */
const CHUNK = 400
/** Project roots whose expanded folders are remembered (the oldest are forgotten). */
const REMEMBERED_ROOTS = 50
/** Joins a root and a path into a row key (a control character no path holds). */
const KEY_SEP = '\u0001'

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
  reveal(): void
}

/** What a tree row stands for (kept on the row's dataset). */
interface RowInfo { root: string; path: string; level: number; dir: boolean; isRoot: boolean; key: string }

const rowKey = (root: string, path: string): string => root + KEY_SEP + path

function infoOf(row: HTMLElement): RowInfo {
  const d = row.dataset
  return { root: d.root ?? '', path: d.path ?? '', level: Number(d.level ?? 1), dir: d.kind === 'dir', isRoot: d.isRoot === 'true', key: d.key ?? '' }
}

/** Where the person was in the tree when a folder is drawn again: the scroll and the row the keyboard was on. */
interface Keep { scroll: number; focusKey: string | undefined }

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
  /** Project roots whose folder is gone. */
  private readonly missing = new Set<string>()
  private readonly probed = new Set<string>()
  /** The latest fill of each folder row: a newer fill (or a collapse) cancels the chunks a big folder still has to paint. */
  private readonly fills = new WeakMap<HTMLElement, number>()
  private fillSeq = 0
  private disposed = false
  private tree: HTMLElement | undefined
  private sig = ''
  /** The row the keyboard is on (roving focus) and the selected one, by row key. */
  private focused: string | undefined
  private selected: string | undefined
  /** Type to navigate: the prefix typed so far and the timer that forgets it. */
  private typed = ''
  private typedTimer: ReturnType<typeof setTimeout> | undefined
  /** The name being edited in place; its folder's redraws wait until it ends (they would drop the input). */
  private editing: Editing | undefined
  private readonly deferred = new Set<string>()

  constructor(ui: TetherUi, host: PadHost, controls: ExplorerControls) {
    this.ui = ui
    this.host = host
    this.controls = controls
    this.ipc = ui.ipc<ExplorerChannels>()
    for (const [root, dirs] of Object.entries(readState(host.state).expanded)) this.expanded.set(root, new Set(dirs))
    this.subs.push(ui.workspace.onDidChange(() => this.render()))
    this.subs.push(this.ipc.on('changed', dirs => this.onDiskChanged(dirs)))
    this.subs.push(this.ipc.on('rootMissing', (root, missing) => this.onRootMissing(root, missing)))
    this.subs.push(this.ipc.on('watchFailed', (_root, message) => this.setNotice(message)))
    this.paintNotice()
    this.render()
    void this.loadRecent()
  }

  // ---------- PadView ----------

  focus(): void {
    // Lands on the selected row (the file being worked on), else where the keyboard last was.
    const target = this.rowByKey(this.selected) ?? this.rowByKey(this.focused) ?? this.tree?.querySelector<HTMLElement>('.xp-row[tabindex="0"]') ?? this.element.querySelector<HTMLElement>('.xp-row') ?? this.element.querySelector<HTMLElement>('.xp-primary')
    target?.focus()
  }

  /** The pad's "⋯" menu: the two toggles, the command, and the two actions on the tree. */
  menu(): ContextMenuEntry[] {
    return [
      { icon: 'target', label: 'Seguir o agente ativo', checked: this.controls.isOn('follow'), run: () => this.controls.toggle('follow') },
      { icon: 'eye', label: 'Revelar o arquivo ativo', checked: this.controls.isOn('autoReveal'), run: () => this.controls.toggle('autoReveal') },
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
    const row = this.rowByKey(rowKey(root, root))
    if (!row) return
    if (row.getAttribute('aria-expanded') !== 'true') { this.setOf(root).add(root); this.persist(); this.expandRow(row, false) }
    row.scrollIntoView({ block: 'nearest' })
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
      const row = await this.waitRow(root, dir)
      if (!row) return false
      // The row's own spelling is what the expanded set keeps (the disk's, not the note's).
      this.setOf(root).add(row.dataset.path!)
      this.syncExpanded()
      if (row.getAttribute('aria-expanded') !== 'true') this.expandRow(row, false)
      await this.load(row.dataset.path!).catch(() => {})
    }
    this.persist()
    const target = await this.waitRow(root, file)
    if (!target || this.disposed) return false
    this.select(target)
    this.updateCurrent()
    target.scrollIntoView({ block: 'nearest' })
    return true
  }

  /** A row that is drawn shortly (a folder just read paints its rows in tasks); undefined if it never shows. */
  private async waitRow(root: string, path: string): Promise<HTMLElement | undefined> {
    for (let i = 0; i < 100; i++) {
      const row = this.rows().find(r => r.dataset.root === root && samePath(r.dataset.path ?? '', path, CASE_INSENSITIVE))
      if (row) return row
      if (this.disposed) return undefined
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    return undefined
  }

  setVisible(visible: boolean): void {
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
    this.disposed = true
    for (const s of this.subs) s.dispose()
    this.element.remove()
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
    else if (action === 'new-file' || action === 'new-folder' || action === 'new-pane') {
      const row = this.rowByKey(rowKey(f.path, f.path))
      if (row) this.runOn(row, action)
    }
  }

  private showRootMenu(f: ProjectFolder, x: number, y: number): void {
    const list = this.ui.workspace.folders()
    const entries = rootMenu(f, list.findIndex(g => g.path === f.path), list.length)
    this.ui.menus.context(x, y, entries.map((e): ContextMenuEntry => e === 'sep' ? 'sep' : {
      icon: e.icon, label: e.label, run: () => this.act(e.action, f), ...(e.disabled ? { disabled: true } : {}),
    }))
  }

  /** A file opens in the focused pane's tab group (or beside it): the core's file opening decides text, binary or too large. */
  private openFile(info: RowInfo, side: boolean): void {
    void this.ui.openers.open(info.path, { side, root: info.root })
  }

  private itemAction(action: ItemAction, info: RowInfo): void {
    if (action === 'open') this.openFile(info, false)
    else if (action === 'open-side') this.openFile(info, true)
    else if (action === 'reveal') void this.ui.shell.openPath(info.dir ? info.path : parentPath(info.path))
    else {
      const row = this.rowByKey(info.key)
      if (row) this.runOn(row, action)
    }
  }

  private showItemMenu(info: RowInfo, x: number, y: number): void {
    this.ui.menus.context(x, y, itemMenu(info.dir ? 'dir' : 'file').map((e): ContextMenuEntry => e === 'sep' ? 'sep' : {
      icon: e.icon, label: e.label, run: () => this.itemAction(e.action, info), ...(e.danger ? { danger: true } : {}),
    }))
  }

  // ---------- file operations (slice 5) ----------

  /** A command on the selected row (else the one the keyboard is on, else the first project root). */
  run(op: FileOp): void {
    const row = this.rowByKey(this.selected) ?? this.rowByKey(this.focused) ?? this.tree?.querySelector<HTMLElement>('.xp-root') ?? null
    if (row) this.runOn(row, op)
  }

  private runOn(row: HTMLElement, op: FileOp): void {
    const info = infoOf(row)
    if (op === 'copy-path') this.ui.shell.writeClipboard(info.path)
    else if (op === 'copy-relative-path') this.ui.shell.writeClipboard(relativePath(info.root, info.path))
    else if (op === 'new-pane') this.ui.panes.newPanelDialog(this.ui.panes.activeId() ?? '', { cwd: info.dir ? info.path : parentPath(info.path) })
    else if (op === 'new-file' || op === 'new-folder') void this.newEntry(row, op === 'new-folder' ? 'dir' : 'file')
    else if (op === 'rename') { if (!info.isRoot) this.startRename(row) }
    else if (op === 'delete') { if (!info.isRoot) void this.trash(row) }
  }

  /** The keyboard fell to the page (an input row was removed under it): it goes back to the tree; a click elsewhere keeps its target. */
  private keyboardLost(): boolean { return !document.activeElement || document.activeElement === document.body }

  /** The names in a folder as last read (the validation's "already exists"). */
  private siblingsOf(dir: string): string[] { return (this.dirs.get(dir)?.entries ?? []).map(e => e.name) }

  /** The input of an in-place edit with its validation message under it (VS Code's InputBox with a message). */
  private editor(dir: string, value: string, current: string | undefined, isDir: boolean, onCommit: (name: string) => Promise<string | undefined>, onEnd: () => void): Editing {
    this.editing?.end()
    const input = el('input', 'xp-input')
    input.type = 'text'
    input.value = value
    input.spellcheck = false
    input.setAttribute('aria-label', current === undefined ? (isDir ? 'Nome da nova pasta' : 'Nome do novo arquivo') : `Novo nome de ${current}`)
    const message = el('div', 'xp-validate')
    message.hidden = true
    message.setAttribute('role', 'alert')
    let done = false
    let busy = false
    const editing: Editing = {
      dir, input, message, problem: null,
      end: () => {
        if (done) return
        done = true
        if (this.editing === editing) this.editing = undefined
        onEnd()
        // The redraws that waited for the edit (the disk changed meanwhile, this operation's own change among them).
        if (this.deferred.delete(dir)) for (const row of this.expandedRowsOf(dir)) this.refill(row)
      },
    }
    const show = (problem: NameProblem | null, text?: string): void => {
      editing.problem = problem
      const msg = text ?? problem?.message
      message.hidden = !msg
      message.textContent = msg ?? ''
      message.classList.toggle('warning', !text && problem?.severity === 'warning')
      input.classList.toggle('invalid', !!msg && (!!text || problem?.severity === 'error'))
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
    input.addEventListener('blur', () => { void commit(true) })
    this.editing = editing
    return editing
  }

  /** "Novo arquivo…"/"Nova pasta…": an input row at the top of the folder (the folder of a file row); Enter creates, and a file opens. */
  private async newEntry(row: HTMLElement, kind: 'file' | 'dir'): Promise<void> {
    let target = row
    if (!infoOf(row).dir) target = this.rowByKey(rowKey(infoOf(row).root, parentPath(infoOf(row).path))) ?? row
    const folder = infoOf(target)
    if (!folder.dir) return
    if (target.getAttribute('aria-expanded') !== 'true') this.toggle(target)
    await this.load(folder.path).catch(() => {})
    if (this.disposed || !target.isConnected) return
    const line = el('div', 'xp-row xp-edit')
    line.dataset.level = String(folder.level + 1)
    line.style.setProperty('--lvl', String(folder.level + 1))
    line.setAttribute('role', 'none')
    const ico = el('span', 'xp-ico')
    setIcon(ico, kind === 'dir' ? 'folder' : 'file')
    const editing = this.editor(folder.path, '', undefined, kind === 'dir', async name => {
      const sep = folder.path.includes('\\') ? '\\' : '/'
      const parts = name.trim().split(/[\\/]+/).filter(s => s !== '')
      const path = joinPath(folder.path, parts.join(sep))
      const res = await this.ipc.invoke('create', path, kind)
      if (!res.ok) return res.message
      void this.afterCreate(folder.root, path, kind, parts.length > 1)
      return undefined
    }, () => { line.remove(); if (this.keyboardLost()) target.focus() })
    if (kind === 'file') editing.input.addEventListener('input', () => setIcon(ico, (fileIcon(editing.input.value) || 'file') as IconName))
    const box = el('div', 'xp-edit-box')
    box.append(editing.input, editing.message)
    line.append(this.twistie(false), ico, box)
    target.after(line)
    line.scrollIntoView({ block: 'nearest' })
    editing.input.focus()
  }

  /** The new entry shows up when the watcher redraws its folder: it is selected; a file opens in the editor (VS Code). */
  private async afterCreate(root: string, path: string, kind: 'file' | 'dir', nested: boolean): Promise<void> {
    if (kind === 'file') void this.ui.openers.open(path, { side: false, root })
    const shown = nested ? await this.reveal(path) : !!(await this.waitRow(root, path))
    const row = shown ? await this.waitRow(root, path) : undefined
    if (!row || this.disposed) return
    this.select(row)
    row.scrollIntoView({ block: 'nearest' })
    if (kind === 'dir') row.focus()
  }

  /** F2 / "Renomear…": the name becomes an input with the name without its extension selected (VS Code). */
  private startRename(row: HTMLElement): void {
    const info = infoOf(row)
    const nameEl = row.querySelector<HTMLElement>('.xp-name')
    if (!nameEl) return
    const current = nameEl.textContent ?? ''
    const dir = parentPath(info.path)
    this.select(row)
    const editing = this.editor(dir, current, current, info.dir, async name => {
      const to = joinPath(dir, name)
      const res = await this.ipc.invoke('rename', info.path, to)
      if (!res.ok) return res.message
      nameEl.textContent = name
      this.afterRename(info, to)
      return undefined
    }, () => { box.replaceWith(nameEl); if (row.isConnected && this.keyboardLost()) row.focus() })
    const box = el('div', 'xp-edit-box')
    box.append(editing.input, editing.message)
    nameEl.replaceWith(box)
    editing.input.focus()
    const sel = renameSelection(current, info.dir)
    editing.input.setSelectionRange(sel.start, sel.end)
  }

  /** After a rename: the expanded folders and the selection move with it, the editors follow (TetherUi.files), the new row is selected. */
  private afterRename(info: RowInfo, to: string): void {
    for (const set of this.expanded.values()) {
      for (const d of [...set]) { const next = rebasePath(d, info.path, to); if (next !== undefined) { set.delete(d); set.add(next) } }
    }
    for (const path of [...this.dirs.keys()]) if (rebasePath(path, info.path, to) !== undefined) this.dirs.delete(path)
    this.persist()
    this.selected = rowKey(info.root, to)
    this.focused = this.selected
    this.ui.files.didRename(info.path, to)
    void this.waitRow(info.root, to).then(row => {
      if (!row || this.disposed) return
      this.select(row)
      if (!this.editing) row.focus()
    })
  }

  /** Delete / "Mover para a lixeira": asks first (unless confirmDelete is off), then the system's trash; a failure deletes nothing and says why. */
  private async trash(row: HTMLElement): Promise<void> {
    const info = infoOf(row)
    const name = row.querySelector('.xp-name')?.textContent ?? info.path
    if (this.controls.isOn('confirmDelete')) {
      const answer = await this.ui.dialogs.ask(deleteSituation(name, info.path, info.dir))
      if (answer.choice !== 'trash') { if (row.isConnected) row.focus(); return }
      if (answer.remember) this.controls.set('confirmDelete', false)
    }
    // Where the keyboard goes once the row is gone: the next row out of its subtree, else the one above.
    const after = this.subtreeEnd(row).nextElementSibling as HTMLElement | null
    const next = after?.classList.contains('xp-row') && after.dataset.root === info.root ? after : row.previousElementSibling as HTMLElement | null
    const res = await this.ipc.invoke('trash', info.path)
    if (!res.ok) { await this.ui.dialogs.ask(trashFailedSituation(name, res.message)); if (row.isConnected) row.focus(); return }
    let changed = false
    for (const set of this.expanded.values()) for (const d of [...set]) if (rebasePath(d, info.path, info.path) !== undefined) { set.delete(d); changed = true }
    if (changed) this.persist()
    if (next?.isConnected && next.classList.contains('xp-row')) { this.select(next); next.focus() }
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
        if (this.editing?.dir === path) this.deferred.add(path)
        else for (const row of this.expandedRowsOf(path)) this.refill(row)
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

  private expandedRowsOf(path: string): HTMLElement[] {
    return this.rows().filter(r => r.dataset.path === path && r.dataset.kind === 'dir' && r.getAttribute('aria-expanded') === 'true')
  }

  // ---------- expanding and collapsing ----------

  private toggle(row: HTMLElement): void {
    const info = infoOf(row)
    if (!info.dir) return
    const set = this.setOf(info.root)
    const open = !set.has(info.path)
    if (open) set.add(info.path); else set.delete(info.path)
    // Main hears of the folder before the first read of it, so no change slips between the read and the watch.
    this.persist()
    if (open) this.expandRow(row, true); else this.collapseRow(row)
  }

  private paintTwistie(row: HTMLElement, open: boolean): void {
    row.setAttribute('aria-expanded', String(open))
    if (row.dataset.isRoot !== 'true') setIcon(row.querySelector<HTMLElement>('.xp-ico')!, open ? 'folder-open' : 'folder')
  }

  /** Shows the folder's children: the ones already read at once, then a fresh read when asked (or when none was made). */
  private expandRow(row: HTMLElement, refresh: boolean): void {
    const path = row.dataset.path!
    this.paintTwistie(row, true)
    if (this.dirs.has(path)) this.fill(row)
    if (refresh || !this.dirs.has(path)) void this.load(path)
  }

  private collapseRow(row: HTMLElement): void {
    this.fills.set(row, ++this.fillSeq)
    this.paintTwistie(row, false)
    this.dropDescendants(row)
  }

  /** Removes the rows below a folder row; the keyboard stays on the folder when it was inside them. */
  private dropDescendants(row: HTMLElement): void {
    const below = this.descendantsOf(row)
    if (below.some(r => r === document.activeElement)) this.setRoving(row, true)
    for (const r of below) r.remove()
    this.ensureTabbable()
  }

  /** The rows below a folder row: the following rows of a deeper level. */
  private descendantsOf(row: HTMLElement): HTMLElement[] {
    const level = Number(row.dataset.level)
    const out: HTMLElement[] = []
    for (let n = row.nextElementSibling as HTMLElement | null; n && Number(n.dataset.level) > level; n = n.nextElementSibling as HTMLElement | null) out.push(n)
    return out
  }

  private subtreeEnd(row: HTMLElement): HTMLElement {
    const level = Number(row.dataset.level)
    let end = row
    for (let n = row.nextElementSibling as HTMLElement | null; n && Number(n.dataset.level) > level; n = n.nextElementSibling as HTMLElement | null) end = n
    return end
  }

  /**
   * Draws a folder's children after its row (what the model holds now): the first rows at once, a big folder's rest in later
   * tasks. A child folder that was left expanded is expanded in turn.
   */
  private fill(row: HTMLElement, keep?: Keep): void {
    const info = infoOf(row)
    this.dropDescendants(row)
    const token = ++this.fillSeq
    this.fills.set(row, token)
    const state = this.dirs.get(info.path)
    if (!state || (info.isRoot && this.missing.has(info.path))) return
    if (state.error !== undefined) {
      const msg = el('div', 'xp-msg', state.error)
      msg.dataset.level = String(info.level + 1)
      msg.style.setProperty('--lvl', String(info.level + 1))
      msg.setAttribute('role', 'none')
      row.after(msg)
      return
    }
    const entries = state.entries ?? []
    let next = 0
    let last = row
    const step = (): void => {
      if (this.fills.get(row) !== token || !row.isConnected || this.disposed) return
      const made = entries.slice(next, next + CHUNK).map(e => this.itemRow(e, info))
      next += CHUNK
      const frag = document.createDocumentFragment()
      frag.append(...made)
      this.subtreeEnd(last).after(frag)
      last = made[made.length - 1] ?? last
      for (const r of made) if (r.dataset.kind === 'dir' && this.setOf(info.root).has(r.dataset.path!)) this.expandRow(r, false)
      this.ensureTabbable()
      if (keep) this.restore(keep)
      if (next < entries.length) setTimeout(step, 0)
    }
    step()
  }

  // ---------- following the disk ----------

  /** Draws a folder again (it changed on disk) without moving the person: same scroll, same selection, the keyboard on the same row. */
  private refill(row: HTMLElement): void {
    const active = document.activeElement
    const focusKey = active && this.tree?.contains(active) ? (active as HTMLElement).closest<HTMLElement>('.xp-row')?.dataset.key : undefined
    this.fill(row, { scroll: this.element.scrollTop, focusKey })
  }

  /** Puts the scroll and the keyboard back after a folder's rows were replaced (a big folder's rest comes in later tasks, each restores). */
  private restore(keep: Keep): void {
    if (this.element.scrollTop !== keep.scroll) this.element.scrollTop = keep.scroll
    if (!keep.focusKey) return
    const active = document.activeElement
    if (active && active !== document.body && !this.tree?.contains(active)) return // the person went elsewhere meanwhile
    const target = this.rowByKey(keep.focusKey)
    if (target && target !== active) { this.setRoving(target, false); target.focus({ preventScroll: true }) }
  }

  /** The disk changed under these folders: the ones drawn open are read again; a listing that is not drawn is forgotten (read afresh when shown). */
  private onDiskChanged(dirs: readonly string[]): void {
    if (this.disposed || !Array.isArray(dirs)) return
    for (const dir of dirs) {
      if (typeof dir !== 'string') continue
      if (this.expandedRowsOf(dir).length > 0) this.reload(dir)
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
    for (const row of this.rows()) {
      if (row.dataset.kind !== 'dir' || row.getAttribute('aria-expanded') !== 'true') continue
      shown.add(row.dataset.path!)
      this.reload(row.dataset.path!)
    }
    for (const path of [...this.dirs.keys()]) if (!shown.has(path)) this.dirs.delete(path)
  }

  /** "Recolher tudo": every folder under the project roots closes; the roots stay open (they are the headings of the pad). */
  collapseAll(): void {
    for (const [root, set] of this.expanded) { const open = set.has(root); set.clear(); if (open) set.add(root) }
    this.persist()
    for (const row of this.tree?.querySelectorAll<HTMLElement>('.xp-root[aria-expanded="true"]') ?? []) this.fill(row)
    this.element.scrollTop = 0
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

  // ---------- selection and keyboard ----------

  private rows(): HTMLElement[] { return this.tree ? [...this.tree.querySelectorAll<HTMLElement>('.xp-row')] : [] }

  private rowByKey(key: string | undefined): HTMLElement | null {
    if (!key) return null
    return this.rows().find(r => r.dataset.key === key) ?? null
  }

  /** Makes `row` the tabbable one (roving focus); `focus` also moves the keyboard to it. */
  private setRoving(row: HTMLElement, focus: boolean): void {
    for (const r of this.tree?.querySelectorAll<HTMLElement>('.xp-row[tabindex="0"]') ?? []) r.tabIndex = -1
    row.tabIndex = 0
    this.focused = row.dataset.key
    if (focus) row.focus()
  }

  private ensureTabbable(): void {
    if (!this.tree || this.tree.querySelector('.xp-row[tabindex="0"]')) return
    const row = this.rowByKey(this.focused) ?? this.tree.querySelector<HTMLElement>('.xp-row')
    if (row) row.tabIndex = 0
  }

  private select(row: HTMLElement): void {
    for (const r of this.tree?.querySelectorAll<HTMLElement>('.xp-row[aria-selected="true"]') ?? []) { r.classList.remove('selected'); r.setAttribute('aria-selected', 'false') }
    this.selected = row.dataset.key
    row.setAttribute('aria-selected', 'true')
    if (row.dataset.isRoot !== 'true') row.classList.add('selected')
    this.setRoving(row, false)
    const root = row.dataset.root!
    if (this.ui.workspace.current() !== root) { this.ui.workspace.setCurrent(root); this.updateCurrent() }
  }

  private onClick(row: HTMLElement, ev: MouseEvent): void {
    this.select(row)
    const info = infoOf(row)
    if (info.dir) this.toggle(row)
    else this.openFile(info, ev.ctrlKey || ev.metaKey)
  }

  private onKey(ev: KeyboardEvent): void {
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.xp-row')
    if (!row) return
    if (ev.key === 'Escape') {
      // The keyboard goes back to the pane that had it.
      const back = this.ui.panes.activeId()
      if (back) { ev.preventDefault(); this.ui.panes.focus(back) }
      return
    }
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      const r = row.getBoundingClientRect()
      this.menuFor(row, r.left + 24, r.bottom)
      return
    }
    if (!ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && (ev.key === 'F2' || ev.key === 'Delete')) {
      ev.preventDefault()
      this.runOn(row, ev.key === 'F2' ? 'rename' : 'delete')
      return
    }
    if (ev.altKey || ev.metaKey || (ev.ctrlKey && ev.key !== 'Enter')) return
    if (ev.key === 'PageDown' || ev.key === 'PageUp') { ev.preventDefault(); this.page(row, ev.key === 'PageDown'); return }
    if (!ev.ctrlKey && isTypeAheadKey(ev.key, this.typed)) { ev.preventDefault(); this.typeAhead(row, ev.key); return }
    const info = infoOf(row)
    if (ev.ctrlKey && !info.dir) { ev.preventDefault(); this.openFile(info, true); return }
    const rows = this.rows()
    const nav: NavRow[] = rows.map(r => ({ level: Number(r.dataset.level), dir: r.dataset.kind === 'dir', expanded: r.getAttribute('aria-expanded') === 'true' }))
    const action = navigate(nav, rows.indexOf(row), ev.key)
    if (action.type === 'none') return
    ev.preventDefault()
    if (action.type === 'focus') { this.setRoving(rows[action.index]!, true); return }
    this.select(row)
    if (action.type === 'open') this.openFile(info, false)
    else this.toggle(row) // toggle, expand and collapse: the rule already checked the state
  }

  /** Type to navigate: the keyboard jumps to the next row whose name starts with what was typed (wrapping); 800 ms of silence starts over. */
  private typeAhead(row: HTMLElement, key: string): void {
    this.typed += key
    clearTimeout(this.typedTimer)
    this.typedTimer = setTimeout(() => { this.typed = '' }, TYPE_AHEAD_RESET_MS)
    const rows = this.rows()
    const at = typeAheadMatch(rows.map(r => r.querySelector('.xp-name')?.textContent ?? ''), rows.indexOf(row), this.typed)
    if (at >= 0) this.setRoving(rows[at]!, true)
  }

  /** PageUp/PageDown: the first press goes to the edge of what is in view, the next one a page further. */
  private page(row: HTMLElement, down: boolean): void {
    const rows = this.rows()
    if (rows.length === 0) return
    const view = this.element.getBoundingClientRect()
    let first = -1, last = -1
    rows.forEach((r, i) => {
      const b = r.getBoundingClientRect()
      if (b.height > 0 && b.top >= view.top - 1 && b.bottom <= view.bottom + 1) { if (first < 0) first = i; last = i }
    })
    const h = rows[0]!.getBoundingClientRect().height || 24
    const page = Math.max(1, Math.floor(view.height / h))
    const at = pageTarget(rows.indexOf(row), rows.length, first < 0 ? 0 : first, last < 0 ? 0 : last, page, down)
    if (at >= 0) this.setRoving(rows[at]!, true)
  }

  private menuFor(row: HTMLElement, x: number, y: number): void {
    const info = infoOf(row)
    this.setRoving(row, false)
    if (info.isRoot) {
      const f = this.ui.workspace.folders().find(g => g.path === info.path)
      if (f) this.showRootMenu(f, x, y)
    } else this.showItemMenu(info, x, y)
  }

  // ---------- drawing ----------

  private render(force = false): void {
    const folders = this.ui.workspace.folders()
    const sig = JSON.stringify(folders.map(f => [f.path, f.name, f.pinned, f.agents]))
    // Only the current project changed (a click, "seguir"): the rows stay as they are.
    if (!force && folders.length > 0 && this.tree && sig === this.sig) { this.updateCurrent(); return }
    this.sig = sig
    const hadFocus = this.element.contains(document.activeElement)
    const scroll = this.element.scrollTop
    this.ipc.send('setRoots', folders.map(f => f.path))
    if (folders.length === 0) { this.tree = undefined; this.element.replaceChildren(this.noticeEl, this.emptyState()) }
    else {
      this.element.replaceChildren(this.noticeEl, this.roots(folders))
      this.probeRoots(folders)
    }
    this.element.scrollTop = scroll
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
          if (this.missing.delete(f.path)) { this.dirs.delete(f.path); for (const r of this.expandedRowsOf(f.path)) this.expandRow(r, true) }
        } else this.missing.add(f.path)
        this.updateMissing()
      }, () => {})
    }
  }

  /** The "pasta não encontrada" warning on the root rows whose folder is gone (and no children under them). */
  private updateMissing(): void {
    for (const row of this.rows()) {
      if (row.dataset.isRoot !== 'true') continue
      const gone = this.missing.has(row.dataset.path!)
      const warn = row.querySelector<HTMLElement>('.xp-warn')
      if (warn) warn.hidden = !gone
      if (row.classList.contains('missing') === gone) continue
      row.classList.toggle('missing', gone)
      if (gone) this.dropDescendants(row)
    }
  }

  private updateCurrent(): void {
    const current = this.ui.workspace.current()
    for (const r of this.tree?.querySelectorAll<HTMLElement>('.xp-root') ?? []) {
      const on = r.dataset.path === current
      r.classList.toggle('current', on)
      if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current')
    }
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

  private roots(folders: readonly ProjectFolder[]): HTMLElement {
    const wrap = el('div', 'xp-roots-wrap')
    const tree = el('div', 'xp-roots')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', 'Projetos')
    // F2 and Delete are the tree's (rename, trash), not the app's F2 "renomear painel".
    tree.dataset.ownKeys = 'F2 Delete'
    tree.addEventListener('keydown', ev => this.onKey(ev))
    wrap.append(tree, this.button('xp-add', OPEN_FOLDER_LABEL, 'folder-open', () => { void this.pickFolder() }))
    this.tree = tree
    const current = this.ui.workspace.current()
    // A root met for the first time starts expanded (VS Code's roots are); a person's collapse is remembered.
    let changed = false
    for (const f of folders) if (!this.expanded.has(f.path)) { this.setOf(f.path).add(f.path); changed = true }
    if (changed) this.host.persist()
    this.syncExpanded()
    for (const f of folders) {
      const row = this.rootRow(f, f.path === current)
      tree.append(row)
      if (this.setOf(f.path).has(f.path)) this.expandRow(row, false)
      else this.paintTwistie(row, false)
    }
    this.ensureTabbable()
    return wrap
  }

  private rowBase(className: string, root: string, path: string, level: number, dir: boolean): HTMLElement {
    const row = el('div', `xp-row ${className}`)
    const key = rowKey(root, path)
    row.dataset.root = root
    row.dataset.path = path
    row.dataset.level = String(level)
    row.dataset.kind = dir ? 'dir' : 'file'
    row.dataset.key = key
    row.style.setProperty('--lvl', String(level))
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-level', String(level))
    row.tabIndex = key === this.focused ? 0 : -1
    return row
  }

  private twistie(dir: boolean): HTMLElement {
    const t = el('span', 'xp-twist')
    if (dir) t.append(icon('caret-right'))
    return t
  }

  private itemRow(e: Entry, parent: RowInfo): HTMLElement {
    const path = joinPath(parent.path, e.name)
    const dir = e.kind === 'dir'
    const row = this.rowBase('xp-item', parent.root, path, parent.level + 1, dir)
    const open = dir && this.setOf(parent.root).has(path)
    if (dir) row.setAttribute('aria-expanded', String(open))
    const isSelected = row.dataset.key === this.selected
    row.setAttribute('aria-selected', String(isSelected))
    if (isSelected) row.classList.add('selected')
    const ico = el('span', 'xp-ico')
    setIcon(ico, (dir ? (open ? 'folder-open' : 'folder') : fileIcon(e.name)) as IconName)
    row.title = e.link ? `${path}\nAtalho` : path
    row.append(this.twistie(dir), ico, el('span', 'xp-name', e.name))
    row.addEventListener('click', ev => this.onClick(row, ev))
    row.addEventListener('contextmenu', ev => { ev.preventDefault(); this.select(row); this.menuFor(row, ev.clientX, ev.clientY) })
    return row
  }

  private rootRow(f: ProjectFolder, current: boolean): HTMLElement {
    const row = this.rowBase('xp-root', f.path, f.path, 1, true)
    row.dataset.isRoot = 'true'
    row.dataset.pinned = String(f.pinned)
    row.setAttribute('aria-selected', String(row.dataset.key === this.selected))
    if (current) row.setAttribute('aria-current', 'true')
    row.title = rootTitle(f)
    if (current) row.classList.add('current')

    const ico = el('span', 'xp-ico')
    ico.append(icon('folder', 'xp-folder'))
    const name = el('span', 'xp-name', f.name)
    const hintText = agentsHint(f.agents.length)
    row.append(this.twistie(true), ico, name)
    const warn = el('span', 'xp-warn', MISSING_TEXT)
    warn.title = MISSING_TITLE
    warn.hidden = !this.missing.has(f.path)
    if (!warn.hidden) row.classList.add('missing')
    row.append(warn)
    if (hintText) {
      const hint = el('span', 'xp-hint', hintText)
      // The panes' places are read when the pointer arrives: a pane may have moved desks since the last render.
      const tip = (): void => { hint.title = agentsTooltip(f.agents.map(id => this.ui.panes.describe(id)).filter(p => p !== undefined)) }
      hint.addEventListener('mouseenter', tip)
      row.append(hint)
    }
    row.append(el('span', 'xp-sp'))
    const pin = el('button', 'xp-pin')
    pin.type = 'button'
    pin.tabIndex = -1
    pin.title = pinLabel(f)
    pin.setAttribute('aria-label', pinLabel(f))
    pin.setAttribute('aria-pressed', String(f.pinned))
    pin.append(icon(f.pinned ? 'push-pin-fill' : 'push-pin'))
    pin.addEventListener('click', ev => { ev.stopPropagation(); this.ui.workspace.togglePin(f.path) })
    row.append(pin)

    row.addEventListener('click', ev => this.onClick(row, ev))
    row.addEventListener('contextmenu', ev => { ev.preventDefault(); this.menuFor(row, ev.clientX, ev.clientY) })
    return row
  }

  /** For the e2e: what the pad shows. */
  snapshot(): {
    mode: 'empty' | 'roots'
    roots: { path: string; name: string; pinned: boolean; hint: string; current: boolean; missing: boolean }[]
    rows: { root: string; path: string; name: string; level: number; kind: string; expanded: boolean; selected: boolean; focused: boolean; icon: string }[]
    messages: string[]
    recent: string[]
    reads: number
    notice: string
    edit: { value: string; message: string; severity: string; selection: [number, number] } | undefined
  } {
    return {
      mode: this.element.querySelector('.xp-empty') ? 'empty' : 'roots',
      roots: [...this.element.querySelectorAll<HTMLElement>('.xp-root')].map(r => ({
        path: r.dataset.path ?? '', name: r.querySelector('.xp-name')?.textContent ?? '', pinned: r.dataset.pinned === 'true',
        hint: r.querySelector('.xp-hint')?.textContent ?? '', current: r.classList.contains('current'), missing: r.classList.contains('missing'),
      })),
      rows: this.rows().map(r => ({
        root: r.dataset.root ?? '', path: r.dataset.path ?? '', name: r.querySelector('.xp-name')?.textContent ?? '', level: Number(r.dataset.level),
        kind: r.dataset.kind ?? '', expanded: r.getAttribute('aria-expanded') === 'true', selected: r.classList.contains('selected'),
        focused: r === document.activeElement, icon: r.querySelector<HTMLElement>('.xp-ico')?.dataset.icon ?? '',
      })),
      messages: [...this.element.querySelectorAll<HTMLElement>('.xp-msg')].map(m => m.textContent ?? ''),
      recent: [...this.element.querySelectorAll<HTMLElement>('.xp-recent-item')].map(b => b.title),
      reads: this.reads,
      notice: this.notice === undefined ? '' : (this.noticeEl.textContent ?? ''),
      edit: this.editing ? {
        value: this.editing.input.value,
        message: this.editing.message.hidden ? '' : (this.editing.message.textContent ?? ''),
        severity: this.editing.message.hidden ? '' : this.editing.message.classList.contains('warning') ? 'warning' : 'error',
        selection: [this.editing.input.selectionStart ?? 0, this.editing.input.selectionEnd ?? 0],
      } : undefined,
    }
  }
}
