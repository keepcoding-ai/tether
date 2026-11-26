// The launch profiles an extension sees (TetherUi.profiles.list), pure (unit-tested). A profile's env may carry secrets, so
// the view has only the NAMES of its variables, never a value: nothing an extension reads can leak one. The args are masked the
// same way (redact-args.ts): option names stay, the values of key/token/password-looking options do not.
import type { Profile, ProfileAgent } from '../../src/core/profile.ts'
import { redactArgs } from '../../src/core/redact-args.ts'
import { isUnsafe } from '../../src/core/unsafe.ts'

export interface ProfileView {
  id: string
  name: string
  /** The engine ('claude', 'soul', 'codex', 'shell'…). */
  agent: ProfileAgent
  /** The args added to every launch (a shell profile: its executable's args, then its own), as the editor's list shows them, secret-looking values masked. */
  args: readonly string[]
  /** The folder suggested for new panes of this profile. */
  cwd?: string
  /** A shell profile's executable (absent: tether's default shell). */
  shell?: string
  default?: true
  /** The args skip the agent's permission prompts. */
  unsafe?: true
  /** The names of the env variables the profile sets, sorted; the values never leave the core. */
  envNames: readonly string[]
}

export function profileViewOf(p: Profile): ProfileView {
  // The editor's list rule (profiles.ts displayArgs): a shell profile shows its executable's args, then its own.
  const args = p.agent === 'shell' && p.shell ? [...p.shell.args, ...p.args] : p.args
  return {
    id: p.id,
    name: p.name,
    agent: p.agent,
    args: redactArgs(args),
    ...(p.cwd ? { cwd: p.cwd } : {}),
    ...(p.shell?.command ? { shell: redactArgs([p.shell.command])[0]! } : {}),
    ...(p.default ? { default: true as const } : {}),
    ...(isUnsafe(p.args) ? { unsafe: true as const } : {}),
    envNames: Object.keys(p.env ?? {}).sort(),
  }
}

export function profileViewsOf(list: readonly Profile[]): ProfileView[] {
  return list.map(profileViewOf)
}
