// Read side of the person's settings.json for tetherd and the CLI (main's SettingsStore is the only writer). The file lives
// in userDir(); until main has migrated it, the old copy in the home is read. JSONC, like the writer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileSig } from './exe.ts'
import { FileSnapshot, type SnapshotIo } from './file-snapshot.ts'
import { parseSettings } from '../../app/shared/settings-file.ts'
import { tetherHome, userDir } from './paths.ts'

/** The parsed tree of each settings file, kept while its size and mtime stay what they were (a launch asks several times). */
const parsed = new Map<string, { sig: string; value: Record<string, unknown> }>()

/**
 * The settings values tree (dotted keys and nested objects both honoured, settings-file.ts): the userDir copy, else the legacy one in `home`, else `{}` (also when the file does not parse).
 * A `home` that is not the process's own (a test's private folder) is its own user folder too.
 * An unchanged file costs one stat (not a read and a parse); the returned tree is shared between calls, callers must not mutate it.
 */
export function readUserSettings(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const user = home === tetherHome(env) ? userDir(env) : home
  for (const dir of [user, home]) {
    const file = join(dir, 'settings.json')
    const sig = fileSig(file)
    if (sig === undefined) { parsed.delete(file); continue }
    const hit = parsed.get(file)
    if (hit?.sig === sig) return hit.value
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { parsed.delete(file); continue }
    const value = parseSettings(text).value
    if (parsed.size >= 32) parsed.clear()
    parsed.set(file, { sig, value })
    return value
  }
  return {}
}

/**
 * The settings tree as tetherd keeps it: with an executor, a snapshot in memory (`get()` costs nothing, `fresh()` reloads
 * through the executor); without one (the CLI, Electron main) it is `readUserSettings` as before.
 */
export class UserSettings {
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly files: FileSnapshot<Record<string, unknown> | undefined>[]

  constructor(home: string, io?: SnapshotIo, env: NodeJS.ProcessEnv = process.env, log?: (msg: string) => void) {
    this.home = home
    this.env = env
    const user = home === tetherHome(env) ? userDir(env) : home
    const dirs = user === home ? [home] : [user, home]
    this.files = io
      ? dirs.map((dir) => new FileSnapshot<Record<string, unknown> | undefined>(join(dir, 'settings.json'), io, {
          decode: (text) => (text === undefined ? undefined : parseSettings(text).value),
          initial: undefined,
          ...(log ? { log } : {}),
        }))
      : []
  }

  /** The values tree: the first settings file that exists (as in readUserSettings), else {}. Shared between calls: do not mutate. */
  get(): Record<string, unknown> {
    if (this.files.length === 0) return readUserSettings(this.home, this.env)
    for (const f of this.files) { const v = f.get(); if (v !== undefined) return v }
    return {}
  }

  /** Reloads what changed (the executor stats and reads) and resolves with the newest tree. */
  async fresh(): Promise<Record<string, unknown>> {
    await Promise.all(this.files.map((f) => f.fresh()))
    return this.get()
  }

  /** Starts the watcher and the periodic check (snapshot mode only). */
  start(): void { for (const f of this.files) f.start() }
  stop(): void { for (const f of this.files) f.stop() }
}
