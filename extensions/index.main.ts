// The extensions with an Electron-main entry (extensions/<id>/main.ts). Not activated yet: the main host comes in slice 0b.
import type { ExtensionEntry } from './types.ts'

export const extensions: readonly ExtensionEntry<unknown>[] = []
