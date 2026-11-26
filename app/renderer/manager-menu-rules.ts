// The menus of a view that manages desks and panes apart from the strip and the tabs (the Regência): the core's own
// desk-pill and tab menus, aimed at a target, reshaped by rule. The core builds the entries; these rules only move,
// replace and add rows, so the pill's and the tab's menus called as always stay exactly as they are.

/** The pill menu's four "move" rows, gathered under one submenu in a manager. */
export const DESK_MOVE_LABELS: readonly string[] = ['Mover para a esquerda', 'Mover para a direita', 'Mover para o início', 'Mover para o fim']
export const DESK_PLACE_LABEL = 'Mudar de lugar'
export const GO_DESK_LABEL = 'Ir até a mesa'
export const GO_PANE_LABEL = 'Ir até a guia'
export const WAKE_DESK_LABEL = 'Despertar mesa'
export const WAKE_PANE_LABEL = 'Despertar guia'
export const EMBLEM_LABEL = 'Emblema…'
/** The rename row of the pill ("Renomear") and of the tab ("Renomear…"). */
export const RENAME_LABELS: readonly string[] = ['Renomear', 'Renomear…']
/** "Acordar guia" goes right after the last of these the pane's menu has (the slot menu's name-and-process group). */
export const WAKE_PANE_AFTER: readonly string[] = ['Renomear…', 'Trocar perfil…', 'Reiniciar agente']

/** Separators never lead, trail or come two in a row. */
function tidy<E>(entries: readonly E[], sep: E): E[] {
  const out: E[] = []
  for (const e of entries) {
    if (e === sep && (out.length === 0 || out[out.length - 1] === sep)) continue
    out.push(e)
  }
  while (out.length && out[out.length - 1] === sep) out.pop()
  return out
}

/** `entries` with the rename row (by label) replaced by `rename`; none given: as they are. */
function withRename<E>(entries: readonly E[], rename: E | undefined, labelOf: (e: E) => string | undefined): E[] {
  if (rename === undefined) return [...entries]
  return entries.map(e => (RENAME_LABELS.includes(labelOf(e) ?? '') ? rename : e))
}

/** The caller's rows, then the go row alone at the very end (each its own group). */
function withTail<E>(entries: readonly E[], extra: readonly E[], go: E | undefined, sep: E): E[] {
  return tidy([...entries, sep, ...extra, sep, ...(go === undefined ? [] : [go])], sep)
}

export interface ManagerDeskParts<E> {
  /** "Mudar de lugar ›" holding the given move rows (the caller draws the submenu). */
  place(children: E[]): E
  /** "Renomear" doing the caller's rename (an input in its own row) instead of the pill's. */
  rename?: E
  /** "Acordar mesa", given when the desk sleeps (the pill menu has no "Hibernar mesa" then). */
  wake?: E
}

/**
 * The pill menu's own items (before the extensions' group joins them) for a manager: the rename replaced, the four move
 * rows in one submenu where the first of them was, and "Acordar mesa" before "Fechar mesa…" when given.
 */
export function managerDeskItems<E>(items: readonly E[], parts: ManagerDeskParts<E>, labelOf: (e: E) => string | undefined): E[] {
  const renamed = withRename(items, parts.rename, labelOf)
  const moves = renamed.filter(e => DESK_MOVE_LABELS.includes(labelOf(e) ?? ''))
  const out: E[] = []
  for (const e of renamed) {
    if (!DESK_MOVE_LABELS.includes(labelOf(e) ?? '')) out.push(e)
    else if (e === moves[0]) out.push(parts.place(moves))
  }
  if (parts.wake !== undefined) {
    const close = out.findIndex(e => labelOf(e) === 'Fechar mesa…')
    out.splice(close < 0 ? out.length : close, 0, parts.wake)
  }
  return out
}

/** A manager's desk menu, the extensions' group already in: the caller's rows, then "Ir até a mesa" last when given. */
export function managerDeskTail<E>(entries: readonly E[], extra: readonly E[], go: E | undefined, sep: E): E[] {
  return withTail(entries, extra, go, sep)
}

export interface ManagerPaneParts<E> {
  /** "Renomear…" doing the caller's rename instead of the tab's input. */
  rename?: E
  /** The caller's own rows, before the go row. */
  extra: readonly E[]
  /**
   * The full manager menu (`goLast`): "Ir até a guia" (the only primary) replaces "Focar guia" at the top and goes last,
   * after "Fechar guia" (unpinned). Without it the menu keeps "Focar guia" and "Fechar guia" on top, as before.
   */
  goLast?: {
    go: E
    close: E
    /** "Acordar guia", given when the pane sleeps. */
    wake?: E
    /** "Emblema…", given when the pane has a tab to wear it. */
    emblem?: E
  }
}

/**
 * A pane's menu for a manager, from `base` (the pane's own menu with its primaries unpinned) and the two top rows the
 * menu had so far (`top`: "Focar guia", "Fechar guia"). With no parts beyond `extra: []`: `[...top, sep, ...base]`, as before.
 */
export function managerPaneEntries<E>(base: readonly E[], top: readonly E[], parts: ManagerPaneParts<E>, sep: E, labelOf: (e: E) => string | undefined): E[] {
  const own = withRename(base, parts.rename, labelOf)
  const full = parts.goLast
  if (full === undefined) {
    const before = [...top, sep, ...own]
    return parts.extra.length === 0 ? before : withTail(before, parts.extra, undefined, sep)
  }
  const rows = [...own]
  if (full.wake !== undefined) {
    let at = -1
    rows.forEach((e, i) => { if (WAKE_PANE_AFTER.includes(labelOf(e) ?? '')) at = i })
    rows.splice(at + 1, 0, full.wake)
  }
  // Where the tab menu puts it: before the menu's last group (tab-emblems.ts, showContextMenu).
  if (full.emblem !== undefined) {
    const last = rows.lastIndexOf(sep)
    rows.splice(last < 0 ? rows.length : last, 0, ...(last < 0 ? [sep, full.emblem] : [full.emblem]))
  }
  return tidy([...rows, sep, ...parts.extra, sep, full.close, full.go], sep)
}

// ---------------------------------------------------------------- the menu in blocks (`groups`)

/** The titles of the blocks of a pane's menu in blocks. */
export const AGENT_BLOCK = (name: string): string => `O agente ${name}`
export const PANE_BLOCK = 'Esta guia'
export const OWNER_BLOCK = (owner: string): string => `Quem manda aqui: ${owner}`
/** The gestures of the frame and of the status bar: the menu in blocks has none (they are the tab's, never a list's). */
export const FRAME_GESTURES: readonly RegExp[] = [
  /^Novo painel/, /^Duplicar /, /^Novo quadro/, /^(Mostrar|Ocultar) barra de status$/, /^Dividir /,
]
/** Every close row of the pane's own menu ("Fechar painel…", "Fechar"): the block has one, "Fechar guia". */
const CLOSE_ROW = /^Fechar\b/
/** The pane's own rows that are about the agent that runs in it, in the agent block's order (the caller's rows fit in by label). */
export const AGENT_ROWS: readonly RegExp[] = [
  /^Falar com /, /^O que .+ tem$/, /^Chamar para um canal/, /^Dar uma mesa nova/, /^Ver guias d/, /^Trocar perfil/, /^Reiniciar agente/,
]
/** The tab block's order: these first, by rank; the pane type's own rows after them, as its menu has them. */
const PANE_ROWS: readonly RegExp[] = [
  /^Espiar$/, /^Renomear/, /^Mover…$/, /^Emblema…$/, /^(Hibernar|Despertar) guia$/, /^Marcar como /, /^Copiar link do painel$/,
]
/** The ownership block's line that says only what its title says ("Comandada por X, pela mesa"): left out. */
const SAME_AS_TITLE: readonly RegExp[] = [/^Comandada por [^·]+$/]
/** The agent's own section of the ownership rows (what it owns, "Pausar X em tudo"): it goes to the agent block. */
const AGENT_OWNS = /^(É dono de|Pausada em tudo)/

const rankOf = (label: string | undefined, rules: readonly RegExp[]): number => {
  const i = label === undefined ? -1 : rules.findIndex(r => r.test(label))
  return i < 0 ? rules.length : i
}

export interface ManagerGroups<E> {
  /** The block's title row (an information line). */
  heading(text: string): E
  /** The text of an information line (undefined for any other row). */
  headingOf(e: E): string | undefined
  /** The agent's name when the pane runs one: its rows get a block of their own, first. */
  agent?: string
  /** Who commands the pane ("você" when nobody else): the title of the ownership block. */
  owner: string
  /** The caller's "Espiar" (its own quick view and key), in place of the tab's. */
  peek?: E
}

/**
 * A pane's menu for a manager in blocks with a title: "O agente <nome>" (the agent's rows and the caller's), "Esta guia"
 * (see, name, place, sleep, mark, link, the type's own rows, one "Fechar guia") and "Quem manda aqui: <dono>" (the ownership
 * rows, `top`), then "Ir até a guia" alone and last. The frame's gestures and the other close rows are left out.
 */
export function managerGroupedEntries<E>(
  base: readonly E[], top: readonly E[], parts: ManagerPaneParts<E> & { goLast: NonNullable<ManagerPaneParts<E>['goLast']> }, groups: ManagerGroups<E>,
  sep: E, labelOf: (e: E) => string | undefined,
): E[] {
  const full = parts.goLast
  const isHeading = (e: E): boolean => e !== sep && groups.headingOf(e) !== undefined
  const agent: E[] = []
  const known: E[] = []
  const own: E[] = []
  for (const e of withRename(base, parts.rename, labelOf)) {
    const label = labelOf(e)
    if (label !== undefined && (CLOSE_ROW.test(label) || FRAME_GESTURES.some(r => r.test(label)))) continue
    if (label !== undefined && groups.peek !== undefined && /^Espiar$/.test(label)) { known.push(groups.peek); continue }
    if (groups.agent !== undefined && label !== undefined && rankOf(label, AGENT_ROWS) < AGENT_ROWS.length) agent.push(e)
    else if (label !== undefined && rankOf(label, PANE_ROWS) < PANE_ROWS.length) known.push(e)
    else own.push(e)
  }
  if (groups.peek !== undefined && !known.includes(groups.peek)) known.push(groups.peek)
  if (full.wake !== undefined) known.push(full.wake)
  if (full.emblem !== undefined) known.push(full.emblem)
  for (const e of parts.extra) (groups.agent !== undefined ? agent : own).push(e)
  agent.sort((a, b) => rankOf(labelOf(a), AGENT_ROWS) - rankOf(labelOf(b), AGENT_ROWS))
  known.sort((a, b) => rankOf(labelOf(a), PANE_ROWS) - rankOf(labelOf(b), PANE_ROWS))

  // The ownership rows come in groups; the one about what the agent itself owns goes to the agent's block.
  const chunks: E[][] = [[]]
  for (const e of top) { if (e === sep) chunks.push([]); else chunks[chunks.length - 1]!.push(e) }
  const owns: E[] = []
  const rule: E[] = []
  for (const c of chunks) {
    if (c.length === 0) continue
    const first = c.find(isHeading)
    const text = first !== undefined ? headingText(first, groups) : undefined
    if (groups.agent !== undefined && text !== undefined && AGENT_OWNS.test(text)) owns.push(sep, ...c)
    else rule.push(...(rule.length > 0 ? [sep] : []), ...c.filter(e => !(isHeading(e) && SAME_AS_TITLE.some(r => r.test(headingText(e, groups) ?? '')))))
  }

  const out: E[] = []
  if (groups.agent !== undefined && agent.length + owns.length > 0) out.push(groups.heading(AGENT_BLOCK(groups.agent)), ...agent, ...owns, sep)
  const ownRows = tidy(own, sep)
  // The close keeps a group of its own: a type's last row may be a danger one ("Encerrar canal…").
  out.push(groups.heading(PANE_BLOCK), ...known, sep, ...ownRows, sep, full.close, sep)
  if (rule.some(e => e !== sep && !isHeading(e))) out.push(groups.heading(OWNER_BLOCK(groups.owner)), ...rule, sep)
  out.push(full.go)
  return tidy(out, sep)
}

const headingText = <E>(e: E, groups: ManagerGroups<E>): string | undefined => groups.headingOf(e)
