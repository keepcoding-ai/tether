// What a broadcast may say about environment variables: their names. A broadcast reaches every identified client (the app,
// every CLI and agent pane that is listening), and a value there may be a token; none of them needs it. tetherd launches
// with the values it keeps on disk; the profile editor gets them in the reply to its own `profiles-list`. Every value in a
// broadcast is replaced by ENV_VALUE_HIDDEN, whatever its name (the old mask of process cards went by the name only).
import type { DaemonMessage } from './protocol.ts'
import { SECRET_MASK } from './procs.ts'

export const ENV_VALUE_HIDDEN = SECRET_MASK

export function envNamesOnly(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(env)) out[k] = ENV_VALUE_HIDDEN
  return out
}

/** The message as it may go to everyone: profiles and process cards with the names of their variables only. */
export function forBroadcast(msg: DaemonMessage): DaemonMessage {
  if (msg.t === 'profiles') return { t: 'profiles', profiles: msg.profiles.map((p) => p.env ? { ...p, env: envNamesOnly(p.env) } : p) }
  if (msg.t === 'proc') return { t: 'proc', proc: { ...msg.proc, card: { ...msg.proc.card, env: envNamesOnly(msg.proc.card.env) } } }
  return msg
}
