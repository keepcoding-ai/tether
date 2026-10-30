// Terminal font size shared by the main process (settings.json, menu) and the renderer (every xterm).
// One size for all panels; the keyboard steps it by 1 px between the bounds, "default" puts it back.

export const DEFAULT_FONT_SIZE = 13
export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 32
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
