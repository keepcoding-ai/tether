// Stepping the terminal font size from the keyboard and the menu (Cmd +/-/0 on macOS, Ctrl+Shift +/-/0 elsewhere).
// The size itself is the terminal appearance's fontSize ("Tema do tether", settings.json `terminal`): same
// default and bounds, one size for all panels; a step is 1 px, "default" puts the appearance's default back.
import { DEFAULT_APPEARANCE, FONT_SIZE_RANGE } from './terminal-theme.ts'

export const DEFAULT_FONT_SIZE = DEFAULT_APPEARANCE.fontSize
export const MIN_FONT_SIZE = FONT_SIZE_RANGE.min
export const MAX_FONT_SIZE = FONT_SIZE_RANGE.max
export const FONT_SIZE_STEP = 1

export type FontSizeCommand = 'increase' | 'decrease' | 'reset'

/** Labels shown in the menu. */
export const FONT_SIZE_LABEL: Record<FontSizeCommand, string> = {
  increase: 'Aumentar a fonte',
  decrease: 'Diminuir a fonte',
  reset: 'Tamanho padrão da fonte',
}

/** Anything that is not a whole number inside the bounds (missing, corrupt file, old value) becomes the default. */
export function normalizeFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_FONT_SIZE
  if (value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) return DEFAULT_FONT_SIZE
  return value
}

/** The size after a command, clamped to the bounds (a step past a bound stays on it). */
export function stepFontSize(current: number, command: FontSizeCommand): number {
  const base = normalizeFontSize(current)
  switch (command) {
    case 'increase': return Math.min(MAX_FONT_SIZE, base + FONT_SIZE_STEP)
    case 'decrease': return Math.max(MIN_FONT_SIZE, base - FONT_SIZE_STEP)
    case 'reset': return DEFAULT_FONT_SIZE
  }
}
