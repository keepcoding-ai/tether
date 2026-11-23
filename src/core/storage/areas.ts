import { tetherHome, userDir } from '../paths.ts'

/**
 * The two disk areas. `sync` holds small, persistent, one-file-per-entity data that travels between machines
 * (rewritten in place, never appended to); `local` holds the machine's transient state.
 */
export type StorageArea = 'sync' | 'local'

export interface StorageRoots {
  sync: string
  local: string
}

/** Root folder of each area: sync is the person's folder (`userDir`), local is the machine state (`tetherHome`). */
export function storageRoots(env: NodeJS.ProcessEnv = process.env): StorageRoots {
  return { sync: userDir(env), local: tetherHome(env) }
}
