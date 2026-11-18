// The synchronous lookups of the shell adapter: an executable on PATH and the platform's default shell. They stat the disk, so
// tetherd's coordinator never imports this file: the executor's operations (ops-agents.ts), the CLI and the tests do.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Finds an executable on PATH (Windows: tries the PATHEXT-like extensions). Returns undefined when absent. */
export function findOnPath(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? ''
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** The default shell command and its args. */
export function defaultShell(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    const pwsh = findOnPath('pwsh', env)
    if (pwsh) return { command: pwsh, args: ['-NoLogo'] }
    return { command: findOnPath('powershell', env) ?? 'powershell.exe', args: ['-NoLogo'] }
  }
  // macOS: the user's login shell, started as a login shell (a GUI app's PATH lacks what ~/.zprofile adds).
  if (platform === 'darwin') return { command: env.SHELL || '/bin/zsh', args: ['-l'] }
  return { command: env.SHELL || '/bin/sh', args: [] }
}
