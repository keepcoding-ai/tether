// The extensions with a daemon entry (extensions/<id>/daemon.ts). Not activated yet: the daemon host comes in slice 0c.
import type { ExtensionEntry } from './types.ts'

export const extensions: readonly ExtensionEntry<unknown>[] = []
