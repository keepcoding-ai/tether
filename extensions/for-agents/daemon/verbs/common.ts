// What every verb of `agents` shares: the dependencies the verbs read, the pane's resolution by id or name, the checks in the
// order the contract's table lists them (ownership, inventory, conductor), and the error shape. An error is a `ConductError`
// thrown anywhere below a verb; `verbs.ts` turns it into the verb's error result (`isError`, `data.error` = the code), the
// same for the CLI and the MCP tool because both read the same `VerbResult`.
import { slotTitle } from '../../../../app/shared/agent-info.ts'
import type { TetherDaemon, VerbCaller, VerbResult } from '../../../../src/daemon/ext-api.ts'
import { ConductError, conductorRegistry, type Conductor, type ConductorAct, type ConductorTarget } from '../../conductor-api.ts'
import { capabilityOn, relationOf, type CapabilityId, type Effective, type OwnerId } from '../../rules.ts'
import type { ScreenReaders } from '../../screen/index.ts'
import type { WriteGate } from '../guard.ts'
import type { OwnershipStore } from '../ownership.ts'
import type { PendingCommands } from './command.ts'

export type VerbApi = Pick<TetherDaemon, 'slots' | 'desks' | 'delivery' | 'attention' | 'objects' | 'agents' | 'profiles' | 'io' | 'home' | 'log'>

export interface VerbDeps {
  api: VerbApi
  store: OwnershipStore
  gate: WriteGate
  readers: ScreenReaders
  pending: PendingCommands
}

/** One verb of the `agents` namespace, before it is registered (verbs.ts adds the namespace and the shared handling). */
export interface VerbDef {
  name: string
  description: string
  help: string
  input: Record<string, unknown>
  positional?: readonly string[]
  run(deps: VerbDeps, caller: VerbCaller, args: Record<string, unknown>): Promise<VerbResult>
}

export const GUIA_PROP = { type: 'string', description: "The pane: its slot id, or its name when it is unique among the panes of yours." }

// ---- results ----------------------------------------------------------------------------------

const NOT_PROVEN = 'não provado pela sonda'

/** A success: the text the agent reads and the structured data. `proven: false` marks an act no probe proved on its engine. */
export function ok(text: string, data: Record<string, unknown>, proven = true): VerbResult {
  return proven ? { text, data } : { text: `${text} (${NOT_PROVEN})`, data: { ...data, proven: false } }
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): VerbResult {
  return { text: `${code}: ${message}`, data: { error: code, ...extra }, isError: true }
}

/** Any error becomes the verb's error result: one with a `code` keeps it, anything else is a bug and answers `internal`. */
export function failOf(e: unknown): VerbResult {
  const code = (e as { code?: unknown } | null)?.code
  const message = (e as Error | null)?.message ?? String(e)
  const extra = (e as { extra?: Record<string, unknown> } | null)?.extra
  return typeof code === 'string' && code ? fail(code, message, extra ?? {}) : fail('internal', message)
}

export function refuse(code: string, message: string, extra?: Record<string, unknown>): never {
  throw Object.assign(new ConductError(code, message), extra ? { extra } : {})
}

// ---- arguments --------------------------------------------------------------------------------

export function wantString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') refuse('bad-request', `${key}: texto obrigatório`)
  return v
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') refuse('bad-request', `${key}: esperava texto`)
  return v
}

export function optFlag(args: Record<string, unknown>, key: string): boolean {
  const v = args[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') refuse('bad-request', `${key}: esperava true ou false`)
  return v
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) refuse('bad-request', `${key}: esperava um número`)
  return v
}

// ---- panes ------------------------------------------------------------------------------------

/** The pane's type in the desk map (a slot's pane: 'terminal'); a slot with no pane yet reads as 'terminal'. */
export function paneTypeOf(deps: VerbDeps, paneId: string): string | undefined {
  const map = deps.api.desks.map()
  const hit = map?.desks.flatMap((d) => d.panes).find((p) => p.id === paneId) ?? map?.drawer.find((p) => p.id === paneId)
  return hit?.type ?? (deps.api.slots.get(paneId) ? 'terminal' : undefined)
}

/** A fresh target: the slot is read now, never kept from an earlier call. */
export function targetOf(deps: VerbDeps, paneId: string): ConductorTarget {
  const slot = deps.api.slots.get(paneId)
  return { paneId, type: paneTypeOf(deps, paneId) ?? 'unknown', ...(slot ? { slot } : {}) }
}

export function paneName(deps: VerbDeps, paneId: string): string {
  const slot = deps.api.slots.get(paneId)
  return slot ? slotTitle(slot) : paneId
}

/** Resolves `guia` (an id, else a name unique in `pool`). Undefined when nothing matches; `ambiguous` when a name repeats. */
export function resolveIn(deps: VerbDeps, pool: Iterable<string>, guia: string): string | undefined {
  const ids = [...pool]
  if (ids.includes(guia)) return guia
  const named = ids.filter((id) => paneName(deps, id) === guia)
  if (named.length > 1) refuse('ambiguous', `mais de uma guia se chama ${JSON.stringify(guia)}`, { options: named.map((id) => ({ id, name: paneName(deps, id) })) })
  return named[0]
}

/** The panes an owner has to do with: given to it, in its desks, or its own. A superset; `relationOf` says what it may do. */
export function poolOf(deps: VerbDeps, owner: OwnerId): Set<string> {
  return deps.store.panesOf(owner)
}

export function relation(deps: VerbDeps, owner: OwnerId, paneId: string): { eff: Effective; rel: 'command' | 'view' | undefined } {
  const eff = deps.store.effectiveOf(paneId)
  return { eff, rel: relationOf(eff, owner) }
}

export function capOn(deps: VerbDeps, cap: CapabilityId, paneId: string): boolean {
  const inv = deps.store.inventoryOf(paneId)
  return capabilityOn(cap, inv.desk, inv.pane)
}

/** The capabilities that are off for a pane, among those a conductor or the desk offers it. */
export function offOf(deps: VerbDeps, paneId: string): CapabilityId[] {
  const ids = new Set<CapabilityId>(['open-close', 'give-revoke'])
  for (const c of conductorRegistry.capabilitiesOf(targetOf(deps, paneId))) ids.add(c.id)
  return [...ids].filter((id) => !capOn(deps, id, paneId))
}

/**
 * The checks of a verb that acts on a pane, in the table's order: the pane is one the caller commands (`not-commanded`), its
 * inventory has the capability on (`off`). Returns what the verb needs next.
 */
export function commanded(deps: VerbDeps, caller: VerbCaller, guia: string, cap: CapabilityId | undefined): { paneId: string; eff: Effective; target: ConductorTarget } {
  const paneId = resolveIn(deps, poolOf(deps, caller.slotId), guia)
  if (paneId === undefined) refuse('not-commanded', `nenhuma guia sua se chama ${JSON.stringify(guia)}`)
  const { eff, rel } = relation(deps, caller.slotId, paneId)
  if (rel !== 'command') refuse('not-commanded', rel === 'view' ? `a guia ${paneName(deps, paneId)} só pode ser vista por você` : `a guia ${paneName(deps, paneId)} não é sua`)
  if (cap !== undefined && !capOn(deps, cap, paneId)) refuse('off', `${cap} está desligado nesta guia`)
  return { paneId, eff, target: targetOf(deps, paneId) }
}

/** The conductor that does `act` on the target: none in the chain = `no-conductor`; the chain lacks the act = `unsupported`. */
export function conductorFor(target: ConductorTarget, act: ConductorAct): Conductor {
  const chain = conductorRegistry.chain(target)
  if (chain.length === 0) refuse('no-conductor', 'nenhum condutor sabe comandar esta guia')
  const c = conductorRegistry.pick(target, act)
  if (!c) refuse('unsupported', `o condutor desta guia não faz ${act}`)
  return c
}

/** Records the last act on the pane (the pad's line); a failure of the record never fails the verb. */
export function touch(deps: VerbDeps, paneId: string, owner: OwnerId, verb: string): void {
  deps.store.recordLast(paneId, owner, verb).catch((e: unknown) => deps.api.log(`registrar o último ato de ${paneId} falhou: ${(e as Error).message}`))
}

export function me(deps: VerbDeps, caller: VerbCaller): { id: string; name: string } {
  return { id: caller.slotId, name: paneName(deps, caller.slotId) }
}

/** close and restart act on a slot's process, and never on the caller's own pane (that would end the very call). */
export function mustBeSlot(deps: VerbDeps, paneId: string, ownerId: string): void {
  if (!deps.api.slots.get(paneId)) refuse('no-conductor', 'só guias de agente ou de terminal têm processo para parar')
  if (paneId === ownerId) refuse('bad-request', 'você não fecha nem reinicia a sua própria guia')
}
