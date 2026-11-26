// What a broadcast may say about environment variables: their names. A broadcast reaches every identified client (the app,
// every CLI and agent pane that is listening), and a value there may be a token; none of them needs it. tetherd launches
// with the values it keeps on disk; the profile editor gets them in the reply to its own `profiles-list`. Every value in a
// broadcast is replaced by ENV_VALUE_HIDDEN, whatever its name (the old mask of process cards went by the name only). The
// arguments of profiles and process cards go out masked where they look like a secret (`--token x`, `--password=x`,
// `API_KEY=x`, also inside one argument that is a command line).
import { redactArgs } from '../core/redact-args.ts'
import type { DaemonMessage, Profile } from './protocol.ts'
import { SECRET_MASK } from './procs.ts'

export const ENV_VALUE_HIDDEN = SECRET_MASK

export function envNamesOnly(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(env)) out[k] = ENV_VALUE_HIDDEN
  return out
}

/** A profile as it may go to everyone: variable names only, and its args (and its shell's) with secret-looking values masked. */
function profileForEveryone(p: Profile): Profile {
  const out: Profile = { ...p, args: redactArgs(p.args) }
  if (p.env) out.env = envNamesOnly(p.env)
  if (p.shell) out.shell = { ...p.shell, args: redactArgs(p.shell.args) }
  return out
}

/**
 * The message as it may go to everyone: profiles and process cards with the names of their variables only, and their
 * arguments masked where an option or a `NAME=value` looks like a secret (core/redact-args.ts, the rule the views use).
 * Direct replies (profiles-list, proc-info...) go to the one client that asked and stay as they are.
 */
export function forBroadcast(msg: DaemonMessage): DaemonMessage {
  if (msg.t === 'profiles') return { t: 'profiles', profiles: msg.profiles.map(profileForEveryone) }
  if (msg.t === 'proc') return { t: 'proc', proc: { ...msg.proc, card: { ...msg.proc.card, env: envNamesOnly(msg.proc.card.env), args: redactArgs(msg.proc.card.args) } } }
  return msg
}
