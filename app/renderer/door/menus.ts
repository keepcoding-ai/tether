// The rules of the extensions' menu rows: collecting what the providers give (a provider that throws is dropped, the rest
// stay) and placing the rows in a desk pill's menu and in a pane's menu. Pure: no DOM, the unit tests load it.
import type { ContextMenuEntry } from '../ext-api.ts'

/** The rows an extension's provider gave, or none when it threw (one bad provider never breaks the menu). */
export function collect<A>(providers: Iterable<{ ext: string; fn: (a: A) => ContextMenuEntry[] }>, arg: A, what: string): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = []
  for (const p of [...providers]) {
    try {
      const rows = p.fn(arg)
      if (Array.isArray(rows)) out.push(...rows)
    } catch (err) { console.error(`${what} (${p.ext})`, err) }
  }
  return out
}

/** Leading, trailing and doubled separators of a list of rows, removed. */
function tidy<E>(entries: readonly E[], sep: E): E[] {
  const out: E[] = []
  for (const e of entries) {
    if (e === sep && (out.length === 0 || out[out.length - 1] === sep)) continue
    out.push(e)
  }
  while (out.length && out[out.length - 1] === sep) out.pop()
  return out
}

/**
 * A desk pill's menu with the extensions' rows as a group of their own before `anchor` (the first item whose label it
 * matches: "Hibernar mesa", else "Fechar mesa…"), or at the end when neither is there. No rows: the menu as it was.
 */
export function withDeskMenuGroup<E>(items: readonly E[], extra: readonly E[], sep: E, labelOf: (e: E) => string | undefined, anchors: readonly string[]): E[] {
  const rows = tidy(extra, sep)
  if (rows.length === 0) return [...items]
  let at = items.length
  for (const a of anchors) { const i = items.findIndex(e => labelOf(e) === a); if (i >= 0) { at = i; break } }
  const before = items.slice(0, at)
  const after = items.slice(at)
  return [...before, ...(before.length ? [sep] : []), ...rows, ...(after.length ? [sep] : []), ...after]
}

/**
 * A pane menu with the extensions' rows before its floor: the trailing run of the link ("Copiar link do painel") and the
 * close (any "Fechar…"), after a separator. No rows: the menu as it was.
 */
export function withPaneMenuItems<E>(entries: readonly E[], extra: readonly E[], sep: E, isFloor: (e: E) => boolean): E[] {
  const rows = tidy(extra, sep)
  if (rows.length === 0) return [...entries]
  let at = entries.length
  while (at > 0 && entries[at - 1] !== sep && isFloor(entries[at - 1]!)) at--
  const before = entries.slice(0, at)
  const floor = entries.slice(at)
  const lead = before.length && before[before.length - 1] !== sep ? [sep] : []
  const trail = floor.length ? [sep] : []
  return [...before, ...lead, ...rows, ...trail, ...floor]
}
