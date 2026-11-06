// The keybindings screen's Electron-main side: writes <TETHER_HOME>/keybindings.json (atomically) for the screen, on the
// bus `ext:keybindings-screen:*`. The core reads and watches the file itself (app/main/main.ts).
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { KEYBINDINGS_FILE } from '../../app/shared/keybindings.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { KeybindingsScreenChannels } from './ipc.ts'

export { manifest } from './manifest.ts'

const MAX_TEXT = 4 * 1024 * 1024

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<KeybindingsScreenChannels>()
  const path = join(main.home, KEYBINDINGS_FILE)
  const write = (text: unknown): { ok: true } | { ok: false; message: string } => {
    if (typeof text !== 'string' || text.length > MAX_TEXT) return { ok: false, message: 'Texto inválido.' }
    try {
      mkdirSync(main.home, { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, path)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
  return [
    ipc.handle('write', text => write(text)),
    ipc.handle('ensure', text => {
      if (existsSync(path)) return { ok: true, path }
      const r = write(text)
      return r.ok ? { ok: true, path } : r
    }),
  ]
}
