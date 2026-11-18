// The explorer's pure rules (F8 slice 1a): the texts of a project root's row and the items of its menu, by state. No DOM.
// The row follows the multi-root folder rows of VS Code's explorer (explorerViewer.ts @7faf984); the pinned/inferred
// distinction is tether's (a push-pin, and what holds an inferred folder open). Slice 5: the file operations in the menus
// (VS Code's explorer context menu, files.contribution @7faf984), the relative path and the delete confirmation.
import type { DialogSpec } from '../../../app/shared/dialog.ts'

/** What the rows need of a project (the core's ProjectFolder, structurally). */
export interface RootInfo {
  path: string
  name: string
  pinned: boolean
  agents: readonly string[]
}

export const EMPTY_TITLE = 'Nenhum projeto aberto'
export const EMPTY_HELP = 'Abra um agente numa pasta, ou escolha uma pasta aqui.'
export const OPEN_FOLDER_LABEL = 'Abrir pasta…'
export const RECENT_TITLE = 'Pastas recentes'
/** How many recent folders the empty state lists. */
export const RECENT_LIMIT = 6

/** "1 agente" / "2 agentes"; nothing for a root no agent is in. */
export function agentsHint(count: number): string {
  return count <= 0 ? '' : count === 1 ? '1 agente' : `${count} agentes`
}

/** 'claude' → 'Claude'; any other agent keeps its own name. */
export function agentLabel(kind: string): string {
  return kind === 'claude' ? 'Claude' : kind
}

/** The tooltip of the agents hint: one line per agent pane, "Claude · Mesa 2". */
export function agentsTooltip(agents: readonly { agent?: string | undefined; place?: string | undefined }[]): string {
  return agents.map(a => [a.agent ? agentLabel(a.agent) : 'Agente', a.place].filter(Boolean).join(' · ')).join('\n')
}

/** The pin button's label: a pinned root is unpinned, any other is pinned. */
export function pinLabel(root: Pick<RootInfo, 'pinned' | 'agents'>): string {
  if (!root.pinned) return 'Fixar projeto'
  return root.agents.length > 0 ? 'Desafixar projeto (fica aberto enquanto houver agentes)' : 'Desafixar e fechar o projeto'
}

/** The row's tooltip: the full path, and what holds an inferred root open. */
export function rootTitle(root: Pick<RootInfo, 'path' | 'pinned'>): string {
  return root.pinned ? root.path : `${root.path}\nInferido dos agentes · fecha sozinho quando saírem`
}

/** What the menus offer depending on the window: "Pesquisar na pasta…" only while the search extension is active. */
export interface MenuOptions { search?: boolean }

/** A folder's (and a root's) entry that sends it to the search pad. */
const FIND_ITEM = { action: 'find-in-folder', label: 'Pesquisar na pasta…', icon: 'magnifying-glass' } as const

export type RootAction = 'pin' | 'find-in-folder' | 'unpin' | 'close' | 'auto-close' | 'move-up' | 'move-down' | 'copy-path' | 'reveal' | 'new-file' | 'new-folder' | 'new-pane'
export interface RootMenuItem { action: RootAction; label: string; icon: string; disabled?: boolean }

/** A root's context menu, by state: the groups are separated by `'sep'`. */
export function rootMenu(root: RootInfo, index: number, count: number, options: MenuOptions = {}): (RootMenuItem | 'sep')[] {
  const out: (RootMenuItem | 'sep')[] = []
  if (root.pinned) {
    out.push({ action: 'unpin', label: 'Desafixar', icon: 'push-pin' })
    // A pinned root with no agent in it just goes away; with agents, unpinning leaves it inferred (it stays).
    if (root.agents.length === 0) out.push({ action: 'close', label: 'Fechar projeto', icon: 'x' })
  } else {
    out.push({ action: 'pin', label: 'Fixar', icon: 'push-pin' })
    out.push({ action: 'auto-close', label: 'Fecha sozinho quando os agentes saírem', icon: 'info', disabled: true })
  }
  out.push('sep', ...CREATE_ITEMS)
  if (options.search) out.push('sep', FIND_ITEM)
  const moves: RootMenuItem[] = []
  if (index > 0) moves.push({ action: 'move-up', label: 'Mover para cima', icon: 'arrow-up' })
  if (index < count - 1) moves.push({ action: 'move-down', label: 'Mover para baixo', icon: 'arrow-down' })
  if (moves.length) out.push('sep', ...moves)
  out.push('sep', { action: 'copy-path', label: 'Copiar caminho', icon: 'copy' }, { action: 'reveal', label: 'Abrir no explorador de arquivos', icon: 'arrow-square-out' })
  return out
}

/** A recent folder as the empty state lists it: its name and where it is. */
export function recentRow(path: string): { name: string; parent: string } {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  const parent = i > 0 ? trimmed.slice(0, i) : ''
  return { name: trimmed.slice(i + 1) || path, parent: /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent }
}

/** The recent folders to offer: not already open as a project, newest first, a few. */
export function recentToOffer(recent: readonly string[], open: readonly string[], caseInsensitive: boolean): string[] {
  const key = (p: string): string => { const k = p.replace(/[\\/]+/g, '/').replace(/\/$/, ''); return caseInsensitive ? k.toLowerCase() : k }
  const taken = new Set(open.map(key))
  return recent.filter(p => !taken.has(key(p))).slice(0, RECENT_LIMIT)
}

/** The warning on a project root whose folder is gone. */
export const MISSING_TEXT = 'pasta não encontrada'
export const MISSING_TITLE = 'A pasta deste projeto não existe mais (ou o disco não está disponível). Feche o projeto ou restaure a pasta.'

export type ItemAction = 'find-in-folder' | 'open' | 'open-side' | 'copy-path' | 'copy-relative-path' | 'reveal' | 'new-file' | 'new-folder' | 'new-pane' | 'rename' | 'delete'
export interface ItemMenuItem { action: ItemAction; label: string; icon: string; danger?: boolean }

/** New file, new folder and "Novo painel aqui": a folder's (and a project root's) first group. */
const CREATE_ITEMS: { action: 'new-file' | 'new-folder' | 'new-pane'; label: string; icon: string }[] = [
  { action: 'new-file', label: 'Novo arquivo…', icon: 'file-plus' },
  { action: 'new-folder', label: 'Nova pasta…', icon: 'folder-plus' },
  { action: 'new-pane', label: 'Novo painel aqui…', icon: 'terminal-window' },
]

/** A tree row's context menu by kind: a file opens here or beside, a folder creates inside; both rename, go to the trash, copy their path and reveal. */
export function itemMenu(kind: 'file' | 'dir', options: MenuOptions = {}): (ItemMenuItem | 'sep')[] {
  const head: (ItemMenuItem | 'sep')[] = kind === 'file'
    ? [{ action: 'open', label: 'Abrir', icon: 'file-text' }, { action: 'open-side', label: 'Abrir ao lado', icon: 'square-split-horizontal' }]
    : [...CREATE_ITEMS, ...(options.search ? ['sep' as const, FIND_ITEM] : [])]
  return [
    ...head,
    'sep',
    { action: 'rename', label: 'Renomear…', icon: 'pencil-simple' },
    { action: 'delete', label: 'Mover para a lixeira', icon: 'trash', danger: true },
    'sep',
    { action: 'copy-path', label: 'Copiar caminho', icon: 'copy' },
    { action: 'copy-relative-path', label: 'Copiar caminho relativo', icon: 'copy' },
    'sep',
    { action: 'reveal', label: kind === 'file' ? 'Mostrar no explorador de arquivos' : 'Abrir no explorador de arquivos', icon: 'arrow-square-out' },
  ]
}

/** A path relative to its project root, in the path's own separators ('.' for the root itself), as VS Code's "Copy Relative Path". */
export function relativePath(root: string, path: string): string {
  const r = root.replace(/[\\/]+$/, '')
  if (path.length <= r.length) return '.'
  return path.slice(r.length).replace(/^[\\/]+/, '') || '.'
}

/** The situation id of the delete confirmation (the dialog's test selector). */
export const DELETE_SITUATION = 'explorer.delete'

/**
 * "Mover para a lixeira?" (VS Code's confirmDelete dialog). The trash can be undone from the system, so the box "Não perguntar
 * de novo" exists, as in VS Code; ticking it turns the setting `confirmDelete` off (it is visible and can be turned back on).
 * The card stays red: it removes the file from the project.
 */
export function deleteSituation(name: string, path: string, isDir: boolean): DialogSpec {
  return {
    situation: DELETE_SITUATION,
    tone: 'warn',
    icon: 'trash',
    title: `Mover "${name}" para a lixeira?`,
    message: isDir ? 'A pasta e tudo o que ela contém saem do projeto.' : 'O arquivo sai do projeto.',
    context: { icon: isDir ? 'folder' : 'file-text', name, lines: [path] },
    // The safe card takes Enter and Esc: the keyboard never lands on the red one by default.
    choices: [
      { id: 'keep', icon: 'x', label: 'Manter', consequence: 'Nada muda.', tone: 'safe' },
      { id: 'trash', icon: 'trash', label: 'Mover para a lixeira', consequence: 'Dá para restaurar pela Lixeira do sistema.', tone: 'destructive' },
    ],
    defaultChoice: 'keep',
    escChoice: 'keep',
    remember: { choice: 'trash', label: 'Não perguntar de novo' },
  }
}

/** A file operation that failed: what happened, and that nothing changed. */
export function failedSituation(title: string, message: string, consequence = 'Nada foi alterado.'): DialogSpec {
  return {
    situation: 'explorer.failed',
    tone: 'danger',
    icon: 'warning',
    title,
    message,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence, tone: 'safe' }],
  }
}

/** The trash could not take it: nothing was deleted. */
export function trashFailedSituation(name: string, message: string): DialogSpec {
  return failedSituation(`Não foi possível mover "${name}" para a lixeira`, message, 'Nada foi apagado.')
}

/**
 * Whether the disk is worth watching: some view of the explorer is shown and the window itself is not hidden (minimized).
 * `send` runs only when that answer changes.
 */
export class ActivityGate {
  private readonly shown = new Set<object>()
  private documentVisible: boolean
  private last = false
  private readonly send: (active: boolean) => void

  constructor(send: (active: boolean) => void, documentVisible = true) {
    this.send = send
    this.documentVisible = documentVisible
  }

  /** One view shown or hidden (a disposed view is hidden). */
  setView(view: object, visible: boolean): void {
    if (visible) this.shown.add(view); else this.shown.delete(view)
    this.update()
  }

  setDocument(visible: boolean): void {
    this.documentVisible = visible
    this.update()
  }

  get active(): boolean { return this.last }

  private update(): void {
    const active = this.documentVisible && this.shown.size > 0
    if (active === this.last) return
    this.last = active
    this.send(active)
  }
}
