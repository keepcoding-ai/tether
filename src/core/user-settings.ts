// Read side of the person's settings.json for tetherd and the CLI (main's SettingsStore is the only writer). The file lives
// in userDir(); until main has migrated it, the old copy in the home is read. JSONC, like the writer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSettings } from '../../app/shared/settings-file.ts'
import { tetherHome, userDir } from './paths.ts'

/**
 * The settings values tree (dotted keys and nested objects both honoured, settings-file.ts): the userDir copy, else the legacy one in `home`, else `{}` (also when the file does not parse).
 * A `home` that is not the process's own (a test's private folder) is its own user folder too.
 */
export function readUserSettings(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const user = home === tetherHome(env) ? userDir(env) : home
  for (const dir of [user, home]) {
    let text: string
    try { text = readFileSync(join(dir, 'settings.json'), 'utf8') } catch { continue }
    return parseSettings(text).value
  }
  return {}
}
