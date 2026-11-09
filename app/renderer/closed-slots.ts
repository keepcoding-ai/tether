// The "Slots fechados" menu, as data (the DOM lives in main.ts). A slot with no pane falls in one of two groups:
// "Rodando sem painel" (a process is alive in tetherd, or about to be) and "Encerrados" (nothing runs; resumable).
import { groupClosed, forgetEndedSituation, type ClosedGroups } from './sessions-rules.ts'

// Moved to sessions-rules.ts; re-exported until the single menu replaces this one (S2).
export { groupClosed, forgetEndedSituation, type ClosedGroups }

/** "2 rodando · 12 encerrados" (a zero part is left out; both zero is the empty message). */
export function headerText(g: ClosedGroups): string {
  const parts: string[] = []
  if (g.running.length > 0) parts.push(`${g.running.length} rodando`)
  if (g.ended.length > 0) parts.push(`${g.ended.length} ${g.ended.length === 1 ? 'encerrado' : 'encerrados'}`)
  return parts.length > 0 ? parts.join(' · ') : 'Nenhum slot fechado'
}

/** The toolbar button's tooltip, with the counts. */
export function buttonTitle(g: ClosedGroups): string {
  const base = 'Slots fechados'
  if (g.running.length === 0 && g.ended.length === 0) return `${base}: nenhum`
  const parts: string[] = []
  if (g.running.length > 0) parts.push(`${g.running.length} rodando sem painel`)
  if (g.ended.length > 0) parts.push(`${g.ended.length} ${g.ended.length === 1 ? 'encerrado' : 'encerrados'}`)
  return `${base}: ${parts.join(' · ')}`
}

/** The badge shows the two numbers; a zero is not drawn. */
export function badgeParts(g: ClosedGroups): { running: string; ended: string } {
  return { running: g.running.length > 0 ? String(g.running.length) : '', ended: g.ended.length > 0 ? String(g.ended.length) : '' }
}
