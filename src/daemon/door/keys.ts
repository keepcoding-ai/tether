// The named keys of the agent door (slots.keys) as the bytes a terminal sends for them. A pure table: no state, no I/O.
// Anything not here goes through slots.write as raw bytes.
import type { KeyName } from './types.ts'

const ESC = '\x1b'

export const KEY_BYTES: Readonly<Record<KeyName, string>> = {
  enter: '\r',
  esc: ESC,
  tab: '\t',
  'shift+tab': `${ESC}[Z`,
  backspace: '\x7f',
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+u': '\x15',
  'ctrl+e': '\x05',
  'paste-start': `${ESC}[200~`,
  'paste-end': `${ESC}[201~`,
}

export function isKeyName(name: unknown): name is KeyName {
  return typeof name === 'string' && Object.hasOwn(KEY_BYTES, name)
}

/** The bytes of a key; an unknown name throws (the caller's typo must not type something else). */
export function keyBytes(name: string): string {
  if (!isKeyName(name)) throw new Error(`tecla desconhecida: ${name}`)
  return KEY_BYTES[name]
}
