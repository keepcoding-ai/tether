// `agents list`: what the owner has: its desks with their panes, and the panes given to it outside them. Reading has no
// inventory line and needs no hand: a pane it only sees is listed too (`relation: 'see'`). This is how an owner finds its way
// again after compacting.
import { conductorRegistry } from '../../conductor-api.ts'
import { OBJECT_KEYS, type LastAct } from '../../rules.ts'
import { ok, me, offOf, optFlag, optString, paneName, paneTypeOf, targetOf, type VerbDef, type VerbDeps } from './common.ts'

type Relation = 'command' | 'see' | 'self'

/** What the app's desk map says of the pane (in a desk or in the drawer): hibernated (`asleep`) or suspended to save resources. */
export function sleepMarkOf(deps: VerbDeps, paneId: string): { asleep: boolean; suspended: boolean } {
  const map = deps.api.desks.map()
  const hit = map?.desks.flatMap((d) => d.panes).find((p) => p.id === paneId) ?? map?.drawer.find((p) => p.id === paneId)
  return { asleep: hit?.asleep === true, suspended: hit?.suspended === true }
}

function paneEntry(deps: VerbDeps, owner: string, paneId: string): Record<string, unknown> | undefined {
  const eff = deps.store.effectiveOf(paneId)
  let relation: Relation
  if (eff.commander === owner) relation = eff.via === 'self' ? 'self' : 'command'
  else if (eff.viewer === owner) relation = 'see'
  else return undefined
  const slot = deps.api.slots.get(paneId)
  const asks = slot?.attentionFor?.slotId === owner ? slot.attentionFor.value : undefined
  const last = deps.api.objects.get<LastAct>('pane', paneId, OBJECT_KEYS.last)
  const entry: Record<string, unknown> = {
    id: paneId,
    name: paneName(deps, paneId),
    type: paneTypeOf(deps, paneId) ?? 'unknown',
    kind: slot?.kind ?? null,
    cwd: slot?.cwd ?? null,
    status: slot?.status ?? null,
    turn: slot?.turn ?? 'idle',
    relation,
    hand: eff.hand === 'owner' ? 'owner' : eff.handWhy ?? 'taken',
    conductor: conductorRegistry.chain(targetOf(deps, paneId))[0]?.id ?? null,
    off: offOf(deps, paneId),
    path: deps.api.delivery.pathOf(paneId),
    pending: deps.api.delivery.pending(paneId).length + deps.pending.count(paneId),
  }
  const queued = deps.pending.held(paneId)
  if (queued.length > 0) entry.queued = queued
  // 'waiting' is a permission card; telling a question from it takes the screen (`read-screen` says which).
  if (asks) entry.asks = asks === 'waiting' ? 'permission' : 'done'
  // The sleep is the app's: it publishes it in the desk map (`asleep` on the pane).
  const mark = sleepMarkOf(deps, paneId)
  if (mark.asleep) entry.asleep = true
  else if (mark.suspended) entry.suspended = true
  if (last) entry.last = last
  return entry
}

export const listVerb: VerbDef = {
  name: 'list',
  description: 'List what you own in the tether: your desks (each with its panes) and the panes given to you outside them. `relation` says what you may do with a pane: command, self (your own pane), or see (read only). `off` lists the abilities turned off for it. Use it to find your way again after compacting.',
  help: 'Lista o que é seu: as mesas com as guias e as guias dadas a você.',
  input: { type: 'object', properties: { desk: { type: 'string', description: 'Only this desk (id or name).' }, all: { type: 'boolean', description: 'Also the panes you only see inside your desks (default: yes); false keeps only the ones you command.' } } },
  async run(deps, caller, args) {
    const owner = caller.slotId
    const wantDesk = optString(args, 'desk')
    const onlyCommand = args.all === false
    optFlag(args, 'all')
    const map = deps.api.desks.map()
    const keep = (e: Record<string, unknown> | undefined): e is Record<string, unknown> => !!e && (!onlyCommand || e.relation !== 'see')
    const inDesks = new Set<string>()
    const desks = deps.store.ownedDesks()
      .filter(([, o]) => o.owner === owner && !o.ended)
      .flatMap(([deskId]) => {
        const d = map?.desks.find((x) => x.id === deskId)
        if (!d || (wantDesk && wantDesk !== d.id && wantDesk !== d.name)) return []
        const hand = deps.store.deskFacts(deskId).hand
        // The empty board of a desk is no pane of the owner's: it is neither listed nor counted.
        const panes = d.panes.filter((p) => p.type !== 'empty').map((p) => { inDesks.add(p.id); return paneEntry(deps, owner, p.id) }).filter(keep)
        return [{ id: d.id, name: d.name, hand: hand ? hand.why : 'owner', ...(d.asleep ? { asleep: true } : {}), panes }]
      })
    const panes = wantDesk ? [] : deps.store.ownedPanes()
      .filter(([id, o]) => o.owner === owner && !o.ended && !inDesks.has(id))
      .filter(([id]) => paneTypeOf(deps, id) !== 'empty')
      .map(([id]) => paneEntry(deps, owner, id)).filter(keep)
    // The owner's own pane, "de si", is in `ownedPanes` already (its owner is itself).
    const total = desks.reduce((n, d) => n + d.panes.length, 0) + panes.length
    const line = (e: Record<string, unknown>): string => `  - ${e.name} (${e.kind ?? e.type}, ${e.asleep ? 'hibernada' : e.suspended ? 'suspensa' : e.turn === 'busy' ? 'em turno' : 'parada'})`
    const lines = [
      ...desks.flatMap((d) => [`Mesa "${d.name}"${'asleep' in d ? ' (hibernada)' : ''}:`, ...(d.panes.length === 0 ? ['  sem guias'] : d.panes.map(line))]),
      ...(panes.length > 0 ? ['Guias fora de mesas:', ...panes.map(line)] : []),
    ]
    const text = total === 0 && desks.length === 0 ? 'Você não é dono de nenhuma mesa nem de nenhuma guia.' : [`${desks.length} mesa(s), ${total} guia(s).`, ...lines].join('\n')
    return ok(text, { me: me(deps, caller), desks, panes })
  },
}
