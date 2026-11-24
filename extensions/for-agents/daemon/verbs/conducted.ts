// The verbs a conductor owns (`type` and `keys` of the terminal conductor; conductor-api.ts `ConductedVerb`) reached through
// the registry: the extension's verb of the same name (type.ts, keys.ts) resolves the pane, checks the ownership and the verb's
// own inventory line, and hands the arguments to the conductor's verb with a fresh context. Nothing here knows the terminal
// conductor.
import type { VerbCaller, VerbResult } from '../../../../src/daemon/ext-api.ts'
import { conductorRegistry } from '../../conductor-api.ts'
import { buildContext } from '../context.ts'
import { awakeTarget, capOn, commanded, refuse, touch, wantString, type VerbDeps } from './common.ts'

export async function runConducted(deps: VerbDeps, caller: VerbCaller, name: string, args: Record<string, unknown>): Promise<VerbResult> {
  const guia = wantString(args, 'guia')
  const { paneId, target: before } = commanded(deps, caller, guia, undefined)
  if (conductorRegistry.chain(before).length === 0) refuse('no-conductor', 'nenhum condutor sabe comandar esta guia')
  const target = await awakeTarget(deps, paneId, name)
  if (conductorRegistry.chain(target).length === 0) refuse('no-conductor', 'nenhum condutor sabe comandar esta guia')
  const hit = conductorRegistry.verbsOf(target).find((v) => v.verb.name === name)
  if (!hit) refuse('unsupported', `nenhum condutor desta guia tem o verbo ${name}`)
  if (!capOn(deps, hit.verb.capability, paneId)) refuse('off', `${hit.verb.capability} está desligado nesta guia`)
  const r = await hit.verb.run(buildContext(deps, caller.slotId, target), { ...args, guia: paneId })
  touch(deps, paneId, caller.slotId, name)
  return r
}
