// How the CLI sees the slots: through tetherd when it answers, straight from the store otherwise.
// Also resolves the `<slot>` argument (id, unique id prefix or unique name).
import { userInfo } from 'node:os'
import { pidExists } from '../core/liveness.ts'
import { tetherHome } from '../core/paths.ts'
import { isUnsafe, slotProfile, type Profile } from '../core/profile.ts'
import { listSlots, readEvents, readRun, readSlot } from '../core/store-sync.ts'
import { currentBinding } from '../core/store-model.ts'
import type { SlotMeta } from '../core/event.ts'
import { DaemonClient } from '../daemon/client.ts'
import { pipePath, type SlotState } from '../daemon/protocol.ts'

export interface Context {
  home: string
  pipe: string
}

export function context(): Context {
  const home = tetherHome()
  return { home, pipe: pipePath(home, userInfo().username) }
}

/** Connects to a running tetherd; undefined when nothing answers (never spawns one). */
export async function tryConnect(ctx: Context): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect({ home: ctx.home, pipe: ctx.pipe, client: 'cli', spawn: false })
  } catch {
    return undefined
  }
}

/**
 * A SlotState built from the store alone (no daemon): binding from the events; 'running' only when a
 * launcher recorded itself in the run file and that pid still exists (a `--here` run in some terminal).
 */
export function stateFromStore(home: string, meta: SlotMeta, profiles: Profile[] = []): SlotState {
  const binding = currentBinding(readEvents(home, meta.slotId), meta)
  const run = readRun(home, meta.slotId)
  const alive = run !== undefined && pidExists(run.pid)
  const s: SlotState = {
    slotId: meta.slotId,
    kind: meta.agent,
    cwd: binding?.cwd ?? meta.cwd,
    status: alive ? 'running' : 'exited',
  }
  if (meta.name) s.name = meta.name
  if (alive) s.pid = run.agentPid ?? run.pid
  if (binding) s.binding = binding
  if (binding?.title) s.title = binding.title
  const profile = slotProfile(meta, profiles)
  if (profile.id) s.profileId = profile.id
  if (profile.name) s.profileName = profile.name
  if (isUnsafe([...(profile.launch?.args ?? []), ...meta.args])) s.unsafe = true
  return s
}

export function statesFromStore(home: string, profiles: Profile[] = []): SlotState[] {
  return listSlots(home).map((m) => stateFromStore(home, m, profiles))
}

/** Timestamp of the slot's last event, else its creation time. */
export function lastActivity(home: string, slotId: string): string | undefined {
  const events = readEvents(home, slotId)
  const last = events[events.length - 1]
  if (last) return last.ts
  return readSlot(home, slotId)?.createdAt
}

export class SlotNotFound extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlotNotFound'
  }
}

/** Exact id wins; then a unique name; then a unique id prefix. Ambiguity and absence are errors. */
export function resolveSlot<T extends { slotId: string; name?: string }>(slots: T[], ref: string): T {
  const exact = slots.find((s) => s.slotId === ref)
  if (exact) return exact
  const byName = slots.filter((s) => s.name === ref)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) throw new SlotNotFound(`nome ambíguo "${ref}": ${byName.map((s) => s.slotId).join(', ')}`)
  const byPrefix = slots.filter((s) => s.slotId.startsWith(ref))
  if (byPrefix.length === 1) return byPrefix[0]!
  if (byPrefix.length > 1) throw new SlotNotFound(`prefixo ambíguo "${ref}": ${byPrefix.map((s) => s.slotId).join(', ')}`)
  throw new SlotNotFound(`slot não encontrado: ${ref} (veja \`tether ls\`)`)
}
