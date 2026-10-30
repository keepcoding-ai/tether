// Shell adapter: a plain interactive shell in the slot's folder. No session to track; "resume" = a new shell
// in the same cwd. The user may pick the shell with SlotMeta.args (e.g. ["C:\\Program Files\\Git\\bin\\bash.exe",
// "--login", "-i"]); otherwise pwsh.exe if on PATH, else powershell.exe (Windows), else $SHELL or /bin/sh.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { withColorSupport } from './termenv.ts'
import type { SlotMeta } from '../core/event.ts'
import { canonicalDir } from '../core/paths.ts'
import type { ProfileLaunch } from '../core/profile.ts'
import type { LaunchPlan } from './types.ts'

export interface ShellPlanInput {
  slot: SlotMeta
  /** Folder to open the shell in (the slot's cwd, or a different one for "resume here"). */
  cwd?: string
  /** The slot's profile: its args name the shell the same way SlotMeta.args do (the slot's own args win). */
  profile?: ProfileLaunch
}

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
export function defaultShell(env: Record<string, string | undefined> = process.env): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = findOnPath('pwsh', env)
    if (pwsh) return { command: pwsh, args: ['-NoLogo'] }
    return { command: findOnPath('powershell', env) ?? 'powershell.exe', args: ['-NoLogo'] }
  }
  return { command: env.SHELL || '/bin/sh', args: [] }
}

/** The slot's args name a shell when the first one is an executable path or a command found on PATH. */
export function shellFromArgs(args: string[], env: Record<string, string | undefined> = process.env): { command: string; args: string[] } | undefined {
  const first = args[0]
  if (!first) return undefined
  if (existsSync(first)) return { command: first, args: args.slice(1) }
  const found = findOnPath(first, env)
  if (found) return { command: found, args: args.slice(1) }
  return undefined
}

function envWithoutUndefined(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v
  return out
}

export function plan(input: ShellPlanInput): LaunchPlan {
  const { slot, profile } = input
  const shell = shellFromArgs(slot.args) ?? (profile ? shellFromArgs(profile.args) : undefined) ?? defaultShell()
  const env = withColorSupport(envWithoutUndefined(process.env))
  Object.assign(env, profile?.env ?? {})
  return {
    command: shell.command,
    args: shell.args,
    cwd: canonicalDir(input.cwd ?? slot.cwd),
    env,
  }
}

export const shellAdapter = { name: 'shell' as const, plan }
