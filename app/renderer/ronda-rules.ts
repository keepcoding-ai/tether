// The ronda chip (status bar) and tab mark: label and tooltip from the slot's ronda. Pure, no DOM (unit-tested).
import type { SlotState } from '../../src/daemon/protocol.ts'

/** The ronda chip's tooltip: interval, next nudge, the assembled extras, and how to switch it off. Pure (unit-tested). */
export function rondaTooltip(r: NonNullable<SlotState['ronda']>, now = Date.now()): string {
  const min = Math.max(0, Math.round((Date.parse(r.nextAt) - now) / 60_000))
  const every = r.intervalMs % 60_000 === 0 ? (r.intervalMs >= 3_600_000 && r.intervalMs % 3_600_000 === 0 ? `${r.intervalMs / 3_600_000}h` : `${r.intervalMs / 60_000} min`) : `${Math.round(r.intervalMs / 1000)} s`
  const lines = [`Ronda ligada: o tether cutuca o agente a cada ${every}, quando ele está parado.`]
  if (r.channel === 'listening') lines.push('Canal: ouvindo. O cutucão chega ao agente por dentro, sem tocar a caixa de texto.')
  else if (r.channel === 'none') lines.push('Sem canal: o agente não está ouvindo agora (parado ou ainda abrindo); o cutucão espera.')
  lines.push(r.due ? 'Próximo cutucão: assim que o agente ficar parado.' : min < 1 ? 'Próximo cutucão: em menos de 1 min.' : `Próximo cutucão: em ${min} min.`)
  if (r.nudge) lines.push(`Cutucão extra: ${r.nudge}`)
  if (r.criterion) lines.push(`Critério de parada: ${r.criterion}`)
  lines.push('Clique para desligar.')
  return lines.join('\n')
}

/** The chip's short label: "Ronda 20m". */
export function rondaLabel(r: NonNullable<SlotState['ronda']>): string {
  const ms = r.intervalMs
  const t = ms % 60_000 !== 0 ? `${Math.round(ms / 1000)}s` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`
  return r.channel === 'none' ? `Ronda ${t} · sem canal` : `Ronda ${t}`
}
