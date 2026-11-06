// The explorer pad (F8 slice 1a): the window's project roots, or the empty state. The roots come from the core's workspace
// service (TetherUi.workspace); this view shows them and edits them (pin, close, move). The tree under each root is slice 1b.
// The empty state follows VS Code's empty explorer view ("You have not yet opened a folder" + "Open Folder"), made useful
// with the app's recent folders.
import type { ContextMenuEntry, PadView, ProjectFolder, TetherUi } from '../../../app/renderer/ext-api.ts'
import { icon, type IconName } from '../../../app/renderer/icons.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import {
  agentsHint, agentsTooltip, EMPTY_HELP, EMPTY_TITLE, OPEN_FOLDER_LABEL, pinLabel, recentRow, recentToOffer, RECENT_TITLE, rootMenu, rootTitle,
  type RootAction,
} from './rules.ts'

const CASE_INSENSITIVE = /^(win|mac)/i.test(navigator.platform)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export class ExplorerView implements PadView {
  readonly element = el('div', 'xp')
  private readonly ui: TetherUi
  private readonly subs: IDisposable[] = []
  private recent: string[] = []
  /** The root the keyboard is on (roving focus), by path. */
  private focused: string | undefined

  constructor(ui: TetherUi) {
    this.ui = ui
    this.subs.push(ui.workspace.onDidChange(() => this.render()))
    this.render()
    void this.loadRecent()
  }

  // ---------- PadView ----------

  focus(): void {
    const target = this.rowOf(this.focused) ?? this.element.querySelector<HTMLElement>('.xp-root') ?? this.element.querySelector<HTMLElement>('.xp-primary')
    target?.focus()
  }

  setVisible(visible: boolean): void {
    if (visible) void this.loadRecent()
  }

  dispose(): void {
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
    this.focused = this.ui.workspace.folderOf(path)?.path
    this.ui.workspace.setCurrent(path)
    this.render()
  }

  private select(path: string): void {
    this.focused = path
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

  private async loadRecent(): Promise<void> {
    try { this.recent = await this.ui.folders.recent() } catch { this.recent = [] }
    if (this.ui.workspace.folders().length === 0) this.render()
  }

  // ---------- drawing ----------

  private rowOf(path: string | undefined): HTMLElement | null {
    if (!path) return null
    return [...this.element.querySelectorAll<HTMLElement>('.xp-root')].find(r => r.dataset.path === path) ?? null
  }

  private render(): void {
    const hadFocus = this.element.contains(document.activeElement)
    const folders = this.ui.workspace.folders()
    this.element.replaceChildren(folders.length === 0 ? this.emptyState() : this.roots(folders))
    if (hadFocus) this.focus()
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
    const current = this.ui.workspace.current()
    const tabbable = folders.some(f => f.path === this.focused) ? this.focused : folders[0]!.path
    for (const f of folders) tree.append(this.rootRow(f, f.path === current, f.path === tabbable))
    tree.addEventListener('keydown', ev => this.onKey(ev, folders))
    wrap.append(tree, this.button('xp-add', OPEN_FOLDER_LABEL, 'folder-open', () => { void this.pickFolder() }))
    return wrap
  }

  private rootRow(f: ProjectFolder, current: boolean, tabbable: boolean): HTMLElement {
    const row = el('div', 'xp-root')
    row.dataset.path = f.path
    row.dataset.pinned = String(f.pinned)
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-level', '1')
    row.setAttribute('aria-selected', String(current))
    row.tabIndex = tabbable ? 0 : -1
    row.title = rootTitle(f)
    if (current) row.classList.add('current')

    const name = el('span', 'xp-name', f.name)
    const hintText = agentsHint(f.agents.length)
    row.append(icon('folder', 'xp-folder'), name)
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

    row.addEventListener('click', () => this.select(f.path))
    row.addEventListener('contextmenu', ev => { ev.preventDefault(); this.focused = f.path; this.showRootMenu(f, ev.clientX, ev.clientY) })
    return row
  }

  private onKey(ev: KeyboardEvent, folders: readonly ProjectFolder[]): void {
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.xp-root')
    const path = row?.dataset.path
    const i = folders.findIndex(f => f.path === path)
    if (!row || i === -1) return
    const go = (j: number): void => {
      const to = folders[Math.max(0, Math.min(folders.length - 1, j))]!
      this.focused = to.path
      for (const r of this.element.querySelectorAll<HTMLElement>('.xp-root')) r.tabIndex = r.dataset.path === to.path ? 0 : -1
      this.rowOf(to.path)?.focus()
    }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); go(i + 1) }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(i - 1) }
    else if (ev.key === 'Home') { ev.preventDefault(); go(0) }
    else if (ev.key === 'End') { ev.preventDefault(); go(folders.length - 1) }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.select(folders[i]!.path) }
    else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      const r = row.getBoundingClientRect()
      this.showRootMenu(folders[i]!, r.left + 24, r.bottom)
    } else if (ev.key === 'Escape') {
      // The keyboard goes back to the pane that had it.
      const back = this.ui.panes.activeId()
      if (back) { ev.preventDefault(); this.ui.panes.focus(back) }
    }
  }

  /** For the e2e: what the pad shows. */
  snapshot(): { mode: 'empty' | 'roots'; roots: { path: string; name: string; pinned: boolean; hint: string; current: boolean }[]; recent: string[] } {
    return {
      mode: this.element.querySelector('.xp-empty') ? 'empty' : 'roots',
      roots: [...this.element.querySelectorAll<HTMLElement>('.xp-root')].map(r => ({
        path: r.dataset.path ?? '', name: r.querySelector('.xp-name')?.textContent ?? '', pinned: r.dataset.pinned === 'true',
        hint: r.querySelector('.xp-hint')?.textContent ?? '', current: r.classList.contains('current'),
      })),
      recent: [...this.element.querySelectorAll<HTMLElement>('.xp-recent-item')].map(b => b.title),
    }
  }
}
