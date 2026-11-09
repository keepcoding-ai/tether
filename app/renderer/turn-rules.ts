// The tab's dot: attention (orange, solid) beats busy (green, quiet) beats nothing. Pure.
import type { SlotState } from '../../src/daemon/protocol.ts'

export type TabMark = 'attention' | 'busy' | ''

export function tabMark(s: Pick<SlotState, 'attention' | 'turn'> | undefined): TabMark {
  if (s?.attention) return 'attention'
  if (s?.turn === 'busy') return 'busy'
  return ''
}

/** The dot's tooltip (Portuguese, what the person reads). */
export function tabMarkTip(s: Pick<SlotState, 'attention' | 'turn'> | undefined): string {
  const m = tabMark(s)
  if (m === 'attention') return s?.attention === 'waiting' ? 'Pede sua atenção: esperando você' : 'Pede sua atenção: terminou'
  return m === 'busy' ? 'Em andamento' : ''
}
