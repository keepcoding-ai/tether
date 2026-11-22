// `agents open`: a new pane in one of the owner's desks. It is born by `slots.create({ desk, onBehalfOf })`: the pane enters
// inactive (it never takes the front) and, being in a desk of the owner, is commanded by inheritance with no data of its own.
// The launch arguments come from the engine's conductor (`model` and `effort` included). The first-open dialogs are the conductor's
// `boot`, run in the background: the verb does not wait for the agent to come up. `brief` is a `send` queued right after.
import { slotTitle } from '../../../../app/shared/agent-info.ts'
import type { SlotKind, SlotState } from '../../../../src/daemon/protocol.ts'
import { conductorRegistry, type ConductorTarget } from '../../conductor-api.ts'
import { buildContext } from '../context.ts'
import { capabilityOn, OBJECT_KEYS, type Inventory } from '../../rules.ts'
import { ok, optString, refuse, touch, wantString, type VerbDef, type VerbDeps } from './common.ts'
import { deliverAsOwner } from './send.ts'

/** The conductor's view of a pane that does not exist yet: only the engine's kind is known. */
function futureTarget(kind: string): ConductorTarget {
  return { paneId: '', type: 'terminal', slot: { slotId: '', kind, status: 'queued', cwd: '' } as unknown as SlotState }
}

export const openVerb: VerbDef = {
  name: 'open',
  description: 'Open a new pane (an agent of an engine, or a shell) in one of your desks. It is born commanded by you, and never takes the front from the person. `brief` is sent to the agent as its first message when it is ready. Returns the pane id at once; the agent may still be starting.',
  help: 'Abre uma guia nova (agente ou shell) numa mesa sua.',
  input: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: "The engine ('claude', 'soul', 'codex'...) or 'shell'." },
      cwd: { type: 'string', description: 'The working folder.' },
      desk: { type: 'string', description: 'The desk (id or name). Absent: your only desk.' },
      name: { type: 'string' },
      profile: { type: 'string', description: 'Launch profile id.' },
      model: { type: 'string' },
      effort: { type: 'string' },
      args: { type: 'array', items: { type: 'string' }, description: 'Extra launch arguments.' },
      brief: { type: 'string', description: 'The first message for the agent.' },
    },
    required: ['kind', 'cwd'],
  },
  positional: ['kind', 'cwd'],
  async run(deps: VerbDeps, caller, args) {
    const owner = caller.slotId
    const kind = wantString(args, 'kind')
    const cwd = wantString(args, 'cwd')
    const name = optString(args, 'name')
    const profile = optString(args, 'profile')
    const model = optString(args, 'model')
    const effort = optString(args, 'effort')
    const brief = optString(args, 'brief')
    const extra = args.args
    if (extra !== undefined && !(Array.isArray(extra) && extra.every((x) => typeof x === 'string'))) refuse('bad-request', 'args: esperava uma lista de textos')
    if (kind !== 'shell' && !deps.api.agents.get(kind)) refuse('agent-unavailable', `o motor ${kind} não está disponível`)
    if (kind === 'shell' && (model || effort || brief)) refuse('bad-request', 'um shell não leva model, effort nem brief')
    if (profile && !deps.api.profiles.get(profile)) refuse('bad-request', `não existe o perfil ${profile}`)

    // The desk: the one asked for, else the only desk the caller owns.
    const map = deps.api.desks.map()
    const mine = deps.store.ownedDesks().filter(([, o]) => o.owner === owner && !o.ended).map(([id]) => id)
    const wanted = optString(args, 'desk')
    let deskId: string
    if (wanted) {
      const d = map?.desks.find((x) => x.id === wanted) ?? map?.desks.find((x) => x.name === wanted)
      if (!d) refuse('unknown-desk', `a mesa ${wanted} não existe`)
      if (!mine.includes(d.id)) refuse('not-owner', `a mesa ${d.name} não é sua`)
      deskId = d.id
    } else {
      if (mine.length !== 1) refuse('no-desk', mine.length === 0 ? 'você não é dono de nenhuma mesa' : 'você tem mais de uma mesa: diga qual em `desk`')
      deskId = mine[0]!
    }
    const inv = deps.api.objects.get<Inventory>('desk', deskId, OBJECT_KEYS.inventory)
    if (!capabilityOn('open-close', inv)) refuse('off', 'abrir e fechar guias está desligado nesta mesa')

    let launch: string[] = []
    let proven = true
    // The engine's conductor always speaks for the launch, with what there is (model, effort, cwd): it carries what the engine
    // needs to come up quietly (Codex: no update dialog, the folder trusted), not only the translation of model and effort.
    const c = conductorRegistry.pick(futureTarget(kind), 'launchArgs')
    if (c) {
      const r = c.launchArgs!({ ...(model ? { model } : {}), ...(effort ? { effort } : {}), cwd })
      launch = r.value
      proven = r.proven
    } else if (model || effort) {
      refuse('bad-request', `o motor ${kind} não sabe traduzir model nem effort`)
    }
    const all = [...launch, ...((extra as string[] | undefined) ?? [])]
    const slot = await deps.api.slots.create({
      kind: kind as SlotKind, cwd, desk: deskId, onBehalfOf: owner,
      ...(name ? { name } : {}), ...(profile ? { profileId: profile } : {}), ...(all.length ? { args: all } : {}),
    })
    const paneId = slot.slotId
    touch(deps, paneId, owner, 'open')

    // First-open dialogs: the conductor's, in the background (the agent is not up yet).
    const target: ConductorTarget = { paneId, type: 'terminal', slot }
    const booter = conductorRegistry.pick(target, 'boot')
    if (booter) {
      booter.boot!(buildContext(deps, owner, target)).catch((e: unknown) => deps.api.log(`boot de ${paneId} falhou: ${(e as Error).message}`))
    }
    if (brief) await deliverAsOwner(deps, caller, paneId, brief)
    return ok(`Guia ${slotTitle(slot)} aberta (${paneId}).`, { pane: paneId, state: slot.status, proven }, proven)
  },
}
