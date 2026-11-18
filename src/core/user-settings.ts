// Read side of the person's settings.json for tetherd and the CLI (main's SettingsStore is the only writer). The file lives
// in userDir(); until main has migrated it, the old copy in the home is read. JSONC, like the writer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileSig } from './exe.ts'
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
