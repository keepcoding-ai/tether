// The tab's dot: attention (orange, solid) beats busy (green, quiet) beats nothing. Pure.
import type { SlotState } from '../../src/daemon/protocol.ts'

export type TabMark = 'attention' | 'busy' | ''

export function tabMark(s: Pick<SlotState, 'attention' | 'turn'> | undefined): TabMark {
  if (s?.attention) return 'attention'
  if (s?.turn === 'busy') return 'busy'
  return ''
}

/** The dot's tooltip (Portuguese, what the person reads). */
export function tabMarkTip(s: Pick<SlotState, 'attention' | 'turn' | 'background'> | undefined): string {
  const m = tabMark(s)
  if (m === 'attention') return s?.attention === 'waiting' ? 'Pede sua atenção: esperando você' : 'Pede sua atenção: terminou'
  if (m !== 'busy') return ''
  const n = s?.background ?? 0
  return n > 0 ? `Em andamento: esperando ${n === 1 ? '1 subagente' : `${n} subagentes`} de fundo` : 'Em andamento'
}
