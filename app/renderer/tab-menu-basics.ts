// The floor of every tab's menu (pure): whatever a pane type draws (or nothing, when it has no menu), the menu ends with
// "Copiar link do painel" and a close. A type's own close (any label starting with "Fechar") counts as the close.

export interface BasicItem { label: string }

export const LINK_LABEL = 'Copiar link do painel'
export const CLOSE_LABEL = 'Fechar'

/** Whether an entry closes the pane (the type's own wording: "Fechar", "Fechar painel…", "Fechar guia"…). */
export function isCloseLabel(label: string): boolean {
  return /^Fechar\b/.test(label)
}

/**
 * The type's entries plus what is missing of the floor: the link and the close, after a separator when the type drew
 * anything. `sep` is the menu's separator value; entries without a label (separators, headings) are kept as they are.
 */
export function withTabMenuBasics<E>(entries: readonly E[], sep: E, basics: { link: E & BasicItem; close: E & BasicItem }): E[] {
  const labels = entries.map(e => (e && typeof e === 'object' && 'label' in e ? String((e as BasicItem).label) : ''))
  const missing: E[] = []
  if (!labels.includes(LINK_LABEL)) missing.push(basics.link)
  if (!labels.some(isCloseLabel)) missing.push(basics.close)
  if (missing.length === 0) return [...entries]
  return entries.length > 0 ? [...entries, sep, ...missing] : missing
}
