import { join } from 'node:path'
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

/**
 * Root folder of each area: sync is the `sync` subfolder of the person's folder (`userDir`, which also holds the working
 * files such as settings.json), local is the machine state (`tetherHome`).
 */
export function storageRoots(env: NodeJS.ProcessEnv = process.env): StorageRoots {
  return { sync: join(userDir(env), 'sync'), local: tetherHome(env) }
}
