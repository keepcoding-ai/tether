// The menus of a view that manages desks and panes apart from the strip and the tabs (the Regência): the core's own
// desk-pill and tab menus, aimed at a target, reshaped by rule. The core builds the entries; these rules only move,
// replace and add rows, so the pill's and the tab's menus called as always stay exactly as they are.

/** The pill menu's four "move" rows, gathered under one submenu in a manager. */
export const DESK_MOVE_LABELS: readonly string[] = ['Mover para a esquerda', 'Mover para a direita', 'Mover para o início', 'Mover para o fim']
export const DESK_PLACE_LABEL = 'Mudar de lugar'
export const GO_DESK_LABEL = 'Ir até a mesa'
export const GO_PANE_LABEL = 'Ir até a guia'
export const WAKE_DESK_LABEL = 'Acordar mesa'
export const WAKE_PANE_LABEL = 'Acordar guia'
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
