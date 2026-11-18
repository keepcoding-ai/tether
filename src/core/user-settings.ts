// Read side of the person's settings.json for tetherd (main's SettingsStore is the only writer): a snapshot in memory, reloaded
// by the executor. The file lives in userDir(); until main has migrated it, the old copy in the home is read. JSONC, like the
// writer. The synchronous reader of the CLI and Electron main is user-settings-sync.ts.
import { join } from 'node:path'
import { FileSnapshot, type SnapshotIo } from './file-snapshot.ts'
import { parseSettings } from '../../app/shared/settings-file.ts'
import { tetherHome, userDir } from './paths.ts'

/**
 * The settings tree as tetherd keeps it: a snapshot in memory (`get()` costs nothing, `fresh()` reloads through the executor).
 * Empty until the first reload ends.
 */
export class UserSettings {
  private readonly files: FileSnapshot<Record<string, unknown> | undefined>[]

  constructor(home: string, io: SnapshotIo, env: NodeJS.ProcessEnv = process.env, log?: (msg: string) => void) {
    const user = home === tetherHome(env) ? userDir(env) : home
    const dirs = user === home ? [home] : [user, home]
    this.files = dirs.map((dir) => new FileSnapshot<Record<string, unknown> | undefined>(join(dir, 'settings.json'), io, {
      decode: (text) => (text === undefined ? undefined : parseSettings(text).value),
      initial: undefined,
      ...(log ? { log } : {}),
    }))
  }

  /** The values tree: the first settings file that exists (as in readUserSettings), else {}. Shared between calls: do not mutate. */
  get(): Record<string, unknown> {
    for (const f of this.files) { const v = f.get(); if (v !== undefined) return v }
    return {}
  }

  /** Reloads what changed (the executor stats and reads) and resolves with the newest tree. */
  async fresh(): Promise<Record<string, unknown>> {
    await Promise.all(this.files.map((f) => f.fresh()))
    return this.get()
  }

  /** Starts the watcher and the periodic check. */
  start(): void { for (const f of this.files) f.start() }
  stop(): void { for (const f of this.files) f.stop() }
}
