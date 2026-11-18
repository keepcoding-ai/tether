// Recipe -> launch plan for tether-procd, the part that stats the disk (the folder, the command on PATH). Only the executor's
// `procPlan` operation and the tests import it; tetherd's loop awaits `planForAsync` (proc-launch.ts) instead.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { findOnPath } from '../agents/shell-sync.ts'
import { canonicalDir } from '../core/paths-sync.ts'
import type { ProcPlan } from '../procd/protocol.ts'
import { cmdQuote, LaunchError, procEnv } from './proc-launch.ts'
import type { RecipeFields } from './procs.ts'

/** A path or a name with a separator is taken as given (relative to the folder); a bare name is looked up on PATH. */
function resolveCommand(command: string, cwd: string, env: Record<string, string>, platform: NodeJS.Platform): string | undefined {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    const full = resolve(cwd, command)
    const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
    for (const ext of exts) if (existsSync(full + ext) && statSync(full + ext).isFile()) return full + ext
    return undefined
  }
  return findOnPath(command, env)
}

export function planFor(recipe: Pick<RecipeFields, 'command' | 'args' | 'cwd' | 'env'>, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ProcPlan {
  const cwd = canonicalDir(recipe.cwd)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new LaunchError(`a pasta ${cwd} não existe; corrija com --cwd e inicie de novo`)
  const env = procEnv(base, recipe.env)
  const command = resolveCommand(recipe.command, cwd, env, platform)
  if (!command) throw new LaunchError(`comando não encontrado: ${recipe.command} (nem como caminho, nem no PATH do tetherd); use o caminho completo`)
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const line = [command, ...recipe.args].map(cmdQuote).join(' ')
    return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: `/d /s /c "${line}"`, cwd, env }
  }
  return { command, args: [...recipe.args], cwd, env }
}
