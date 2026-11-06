// The explorer pad (F8): the window's project roots with the file tree under each, or the empty state. The roots come from
// the core's workspace service (TetherUi.workspace); this view shows and edits them (pin, close, move) and draws their
// folders. Slice 1b: a folder is read only when expanded (the main side lists one folder at a time on the bus
// `ext:explorer:*`), its rows are inserted after the folder's row, and the expanded folders are kept in the pad's state.
// The model follows VS Code's explorer (explorerModel: children resolved lazily per expanded folder; explorerViewer: the
// twistie, the indent, the multi-root folder rows; the list's keys). The empty state follows VS Code's empty view
// ("You have not yet opened a folder" + "Open Folder"), made useful with the app's recent folders.
import type { ContextMenuEntry, PadHost, PadView, ProjectFolder, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, setIcon, type IconName } from '../../../app/renderer/icons.ts'
import type { UiIpc } from '../../../app/shared/ext-ipc.ts'
import { fileIcon } from '../../../app/shared/quick-open.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { Entry, ExplorerChannels } from '../ipc.ts'
import { emptyState, joinPath, navigate, parentPath, readState, type NavRow } from '../tree-rules.ts'
import {
  agentsHint, agentsTooltip, EMPTY_HELP, EMPTY_TITLE, itemMenu, type ItemAction, MISSING_TEXT, MISSING_TITLE, OPEN_FOLDER_LABEL, pinLabel,
  recentRow, recentToOffer, RECENT_TITLE, rootMenu, rootTitle, type RootAction,
} from './rules.ts'

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

/** What a tree row stands for (kept on the row's dataset). */
interface RowInfo { root: string; path: string; level: number; dir: boolean; isRoot: boolean; key: string }

const rowKey = (root: string, path: string): string => root + KEY_SEP + path

function infoOf(row: HTMLElement): RowInfo {
  const d = row.dataset
  return { root: d.root ?? '', path: d.path ?? '', level: Number(d.level ?? 1), dir: d.kind === 'dir', isRoot: d.isRoot === 'true', key: d.key ?? '' }
}

export class ExplorerView implements PadView {
  readonly element = el('div', 'xp')
  private readonly ui: TetherUi
  private readonly host: PadHost
  private readonly ipc: UiIpc<ExplorerChannels>
  private readonly subs: IDisposable[] = []
  private recent: string[] = []
  /** Per project root, the folders expanded under it (the root itself included); the pad's persisted state. */
  private readonly expanded = new Map<string, Set<string>>()
  /** The folders read so far, by path (a folder shared by two roots is read once). */
  private readonly dirs = new Map<string, DirState>()
  private readonly inflight = new Map<string, Promise<void>>()
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

  constructor(ui: TetherUi, host: PadHost) {
    this.ui = ui
    this.host = host
    this.ipc = ui.ipc<ExplorerChannels>()
    for (const [root, dirs] of Object.entries(readState(host.state).expanded)) this.expanded.set(root, new Set(dirs))
    this.subs.push(ui.workspace.onDidChange(() => this.render()))
    this.render()
    void this.loadRecent()
  }

  // ---------- PadView ----------

  focus(): void {
    const target = this.rowByKey(this.focused) ?? this.tree?.querySelector<HTMLElement>('.xp-row[tabindex="0"]') ?? this.element.querySelector<HTMLElement>('.xp-row') ?? this.element.querySelector<HTMLElement>('.xp-primary')
    target?.focus()
  }

  setVisible(visible: boolean): void {
    if (!visible) return
    void this.loadRecent()
    // A project folder that came back (a drive plugged in again) or went away is noticed when the pad is shown.
    this.probed.clear()
    this.probeRoots(this.ui.workspace.folders())
  }

  serialize(): unknown {
    const state = emptyState()
    for (const [root, dirs] of this.expanded) state.expanded[root] = [...dirs]
    return state
  }

  dispose(): void {
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
    else if (action === 'copy-path') this.ui.shell.writeClipboard(info.path)
    else void this.ui.shell.openPath(info.dir ? info.path : parentPath(info.path))
  }

  private showItemMenu(info: RowInfo, x: number, y: number): void {
    this.ui.menus.context(x, y, itemMenu(info.dir ? 'dir' : 'file').map((e): ContextMenuEntry => e === 'sep' ? 'sep' : {
      icon: e.icon, label: e.label, run: () => this.itemAction(e.action, info),
    }))
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
      try {
        const res = await this.ipc.invoke('readDir', path)
        if (res.ok) { next = { entries: res.entries }; this.missing.delete(path) }
        else { next = { error: res.message }; if (res.missing) this.missing.add(path); else this.missing.delete(path) }
      } catch (err) { next = { error: `Não foi possível ler a pasta: ${(err as Error).message}` } }
      const prev = this.dirs.get(path)
      this.dirs.set(path, next)
      if (this.disposed) return
      if (next.error !== undefined && this.missing.has(path)) this.forget(path)
      if (JSON.stringify(prev) !== JSON.stringify(next)) for (const row of this.expandedRowsOf(path)) this.fill(row)
      this.updateMissing()
    })().finally(() => { this.inflight.delete(path) })
    this.inflight.set(path, p)
    return p
  }

  /** A folder that is gone is no longer expanded (a project root stays expanded: the warning is on its row). */
  private forget(path: string): void {
    let changed = false
    for (const [root, set] of this.expanded) if (root !== path && set.delete(path)) changed = true
    if (changed) this.host.persist()
  }

  private expandedRowsOf(path: string): HTMLElement[] {
    return this.rows().filter(r => r.dataset.path === path && r.dataset.kind === 'dir' && r.getAttribute('aria-expanded') === 'true')
  }

  // ---------- expanding and collapsing ----------

  private toggle(row: HTMLElement): void {
    const info = infoOf(row)
    if (!info.dir) return
    const set = this.setOf(info.root)
    if (set.has(info.path)) { set.delete(info.path); this.collapseRow(row) } else { set.add(info.path); this.expandRow(row, true) }
    this.host.persist()
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
  private fill(row: HTMLElement): void {
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
      if (next < entries.length) setTimeout(step, 0)
    }
    step()
  }

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
    for (const r of this.tree?.querySelectorAll<HTMLElement>('.xp-row.selected') ?? []) { r.classList.remove('selected'); r.setAttribute('aria-selected', 'false') }
    this.selected = row.dataset.key
    if (row.dataset.isRoot !== 'true') { row.classList.add('selected'); row.setAttribute('aria-selected', 'true') }
    this.setRoving(row, false)
    const root = row.dataset.root!
    if (this.ui.workspace.current() !== root) this.ui.workspace.setCurrent(root)
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
    if (ev.altKey || ev.metaKey || (ev.ctrlKey && ev.key !== 'Enter')) return
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
    if (folders.length === 0) { this.tree = undefined; this.element.replaceChildren(this.emptyState()) }
    else {
      this.element.replaceChildren(this.roots(folders))
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
      r.setAttribute('aria-selected', String(on))
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
    tree.addEventListener('keydown', ev => this.onKey(ev))
    wrap.append(tree, this.button('xp-add', OPEN_FOLDER_LABEL, 'folder-open', () => { void this.pickFolder() }))
    this.tree = tree
    const current = this.ui.workspace.current()
    // A root met for the first time starts expanded (VS Code's roots are); a person's collapse is remembered.
    let changed = false
    for (const f of folders) if (!this.expanded.has(f.path)) { this.setOf(f.path).add(f.path); changed = true }
    if (changed) this.host.persist()
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
    row.setAttribute('aria-selected', String(current))
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
    }
  }
}
