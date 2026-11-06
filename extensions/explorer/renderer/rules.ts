// The explorer's pure rules (F8 slice 1a): the texts of a project root's row and the items of its menu, by state. No DOM.
// The row follows the multi-root folder rows of VS Code's explorer (explorerViewer.ts @7faf984); the pinned/inferred
// distinction is tether's (a push-pin, and what holds an inferred folder open).

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

export type RootAction = 'pin' | 'unpin' | 'close' | 'auto-close' | 'move-up' | 'move-down' | 'copy-path' | 'reveal'
export interface RootMenuItem { action: RootAction; label: string; icon: string; disabled?: boolean }

/** A root's context menu, by state: the groups are separated by `'sep'`. */
export function rootMenu(root: RootInfo, index: number, count: number): (RootMenuItem | 'sep')[] {
  const out: (RootMenuItem | 'sep')[] = []
  if (root.pinned) {
    out.push({ action: 'unpin', label: 'Desafixar', icon: 'push-pin' })
    // A pinned root with no agent in it just goes away; with agents, unpinning leaves it inferred (it stays).
    if (root.agents.length === 0) out.push({ action: 'close', label: 'Fechar projeto', icon: 'x' })
  } else {
    out.push({ action: 'pin', label: 'Fixar', icon: 'push-pin' })
    out.push({ action: 'auto-close', label: 'Fecha sozinho quando os agentes saírem', icon: 'info', disabled: true })
  }
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

export type ItemAction = 'open' | 'open-side' | 'copy-path' | 'reveal'
export interface ItemMenuItem { action: ItemAction; label: string; icon: string }

/** A tree row's context menu by kind (the file operations are slice 5): a file opens here or beside; both can copy the path and reveal. */
export function itemMenu(kind: 'file' | 'dir'): (ItemMenuItem | 'sep')[] {
  const common: ItemMenuItem[] = [
    { action: 'copy-path', label: 'Copiar caminho', icon: 'copy' },
    { action: 'reveal', label: kind === 'file' ? 'Mostrar no explorador de arquivos' : 'Abrir no explorador de arquivos', icon: 'arrow-square-out' },
  ]
  return kind === 'file'
    ? [{ action: 'open', label: 'Abrir', icon: 'file-text' }, { action: 'open-side', label: 'Abrir ao lado', icon: 'square-split-horizontal' }, 'sep', ...common]
    : common
}
