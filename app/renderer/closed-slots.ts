// The "Slots fechados" menu, as data (the DOM lives in main.ts). A slot with no pane falls in one of two groups:
// "Rodando sem painel" (a process is alive in tetherd, or about to be) and "Encerrados" (nothing runs; resumable).
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { DialogSpec } from '../shared/dialog.ts'

/** A process is alive (or about to be). Same rule as situations.ts, kept here so the model stays free of the icon imports. */
const isLive = (s: SlotState): boolean => s.status === 'running' || s.status === 'starting' || s.status === 'queued'

export interface ClosedGroups {
  running: SlotState[]
  ended: SlotState[]
}

/** Splits the slots that have no pane into the two groups, each keeping the daemon's order. */
export function groupClosed(slots: Iterable<SlotState>, hasPane: (slotId: string) => boolean): ClosedGroups {
  const running: SlotState[] = []
  const ended: SlotState[] = []
  for (const s of slots) {
    if (hasPane(s.slotId)) continue
    ;(isLive(s) ? running : ended).push(s)
  }
  return { running, ended }
}

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

/** "Esquecer todos os encerrados": one question for the whole batch. Nothing live is in it, so nothing is killed. */
export function forgetEndedSituation(count: number): DialogSpec {
  const many = count === 1 ? '1 slot encerrado' : `${count} slots encerrados`
  return {
    situation: 'forget-ended',
    tone: 'warn',
    icon: 'trash',
    title: `Esquecer ${many}?`,
    message: 'Eles somem do tether. Nenhum processo está rodando neles; as conversas continuam no histórico do agente e podem ser retomadas por lá.',
    choices: [{ id: 'forget', icon: 'trash', label: count === 1 ? 'Esquecer o slot' : `Esquecer os ${count} slots`, consequence: 'Remove da lista de Slots fechados. Não dá para desfazer.', tone: 'destructive' }],
    cancelLabel: 'Cancelar',
  }
}
