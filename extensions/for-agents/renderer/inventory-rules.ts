// The rules of the inventory pad (tether for agents, "O que <dono> pode"): from the facts (the layout and the `objects` of this
// extension) the model the pad draws, and the pure writes a click stands for. Pure: no `ui`, no DOM. What a capability is
// worth on a pane is `capabilityOn` / `paneCapabilityState` of rules.ts (the same functions the daemon's verbs ask), and who
// commands a pane is `effective()` through `effOf`; nothing here decides either. Stored shape (rules.ts, `Inventory`): on a desk
// only what is OFF; on a pane only what the person set there (`true` = on here, `false` = off here, absent = as the desk).
import {
  DESK_CAPABILITIES, capabilityOn, paneCapabilityState, type CapabilityId, type Effective, type Inventory, type OwnerId,
} from '../rules.ts'
import { effOf, type MenuFacts } from './menus.ts'

/** Where the pad is told to look: a desk, a pane (its line opens), or nothing (the desk on screen). */
export interface PadTarget { deskId?: string; paneId?: string }

/**
 * The lines the conductors put in the inventory, as the app knows them. The daemon's conductors declare theirs
 * (`conductorRegistry.capabilitiesOf`) and the app has no way to read that list, so these are the ids the verbs check today
 * (`capOn` in daemon/verbs): `send`, `interrupt`, `answer`, `command`, and the terminal's `type` and `keys`. An id found in
 * the data that is not here is still drawn, with its id as the label, so nothing the daemon obeys stays hidden.
 */
export const CONDUCTOR_CAPABILITIES: readonly { id: CapabilityId; label: string }[] = [
  { id: 'send', label: 'Enviar pedido e corrigir em curso' },
  { id: 'interrupt', label: 'Interromper' },
  { id: 'answer', label: 'Responder pedido de permissão' },
  { id: 'command', label: 'Rodar comandos do CLI (/compact…)' },
  { id: 'type', label: 'Digitar texto na guia' },
  { id: 'keys', label: 'Teclar' },
]

const DESK_ONLY: ReadonlySet<CapabilityId> = new Set(DESK_CAPABILITIES.map(c => c.id))

export const T = {
  /** The pad's name in the strip and its tooltip; the header shows the person's own line (`title`). */
  padName: 'O que o agente pode',
  title: (owner: string | undefined, desk: string): string => `${owner ? `O que ${owner} pode` : 'O que um agente pode'} · ${desk}`,
  goTo: (o: string): string => `Ir para ${o}`,
  allOn: 'Ligar tudo',
  allOnTip: 'Ligar tudo: volta a mesa e as guias dela ao que nasce (tudo ligado)',
  deskHeading: (o: string | undefined): string => `A mesa · vale para toda guia que ${o ?? 'um agente'} ${o ? 'comanda' : 'comandar'} pela mesa`,
  free: 'Esta mesa não foi dada a ninguém.',
  freeEnded: (name: string): string => `${name} encerrou: esta mesa não tem dono agora.`,
  giveDesk: 'Dar a mesa a um agente…',
  storedWhileFree: 'O que ficou guardado para quando a mesa tiver dono',
  paneHeading: (title: string): string => `Esta guia · ${title}`,
  paneNote: {
    desk: (o: string): string => `${o} a comanda pela mesa`,
    pane: (o: string): string => `Dada a ${o}`,
    self: (o: string): string => `${o} roda nela`,
    none: 'Nenhum agente comanda esta guia',
  },
  paneOutside: 'Esta guia não está em nenhuma mesa: vale só o que está marcado aqui.',
  exceptions: 'Guias que diferem da mesa',
  follows: (o: string, n: number): string => `${n === 1 ? 'A outra guia' : `As outras ${n} guias`} que ${o} comanda ${n === 1 ? 'segue' : 'seguem'} a mesa.`,
  followsAll: (o: string, n: number): string => `${n === 1 ? 'A guia' : `As ${n} guias`} que ${o} comanda ${n === 1 ? 'segue' : 'seguem'} a mesa.`,
  others: (hasOwner: boolean): string => (hasOwner ? 'Guias desta mesa com outro dono' : 'Guias desta mesa com dono'),
  ofOwner: (name: string, self: boolean): string => `de ${name}${self ? ', de si' : ''}`,
  openOf: (name: string): string => `abrir o de ${name}`,
  allOnSummary: 'tudo ligado',
  offSummary: (n: number): string => `${n} ${n === 1 ? 'desligado' : 'desligados'}`,
  on: 'ligado',
  off: 'desligado',
  state: {
    desk: (on: boolean): string => `como a mesa · ${on ? 'ligado' : 'desligado'}`,
    on: 'ligado aqui',
    off: 'desligado aqui',
  },
  inherit: 'herdar',
  inheritTip: 'Volta a valer o que a mesa diz',
  noDesk: 'Esta mesa é do sistema e não aceita dono.',
} as const

// ---- the facts ------------------------------------------------------------------------------------------------------------------

export interface InventoryFacts extends MenuFacts {
  deskInv: ReadonlyMap<string, Inventory>
  paneInv: ReadonlyMap<string, Inventory>
}

/** Only booleans count: a stored value of another shape is not an inventory line. */
export function asInventory(v: unknown): Inventory | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Inventory = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === 'boolean') out[k] = x
  return Object.keys(out).length > 0 ? out : undefined
}

/** The ids with a line on a pane: the conductors' known ones, then any other id the data of this desk or pane carries. */
export function paneCapabilities(invs: readonly (Inventory | undefined)[]): { id: CapabilityId; label: string }[] {
  const known = CONDUCTOR_CAPABILITIES.map(c => ({ ...c }))
  const extra = new Set<CapabilityId>()
  for (const inv of invs) for (const id of Object.keys(inv ?? {})) if (!DESK_ONLY.has(id) && !known.some(k => k.id === id)) extra.add(id)
  return [...known, ...[...extra].sort().map(id => ({ id, label: id }))]
}

// ---- the model ------------------------------------------------------------------------------------------------------------------

export interface DeskLine { cap: CapabilityId; label: string; on: boolean }
export interface ItemLine { cap: CapabilityId; label: string; state: 'desk' | 'on' | 'off'; /** What the desk says for it. */ deskOn: boolean; /** What the pane has now. */ on: boolean }
export interface PaneBlock { paneId: string; title: string; note: string; items: ItemLine[]; outside: boolean }
export interface ExceptionLine { paneId: string; title: string; cap: CapabilityId; label: string; state: 'on' | 'off' }
export interface OtherLine { paneId: string; title: string; ownerId: OwnerId; ownerName: string; self: boolean; summary: string }

export interface InventoryModel {
  /** The header: "O que Atrium pode · kai-aware". */
  title: string
  deskId?: string
  deskName: string
  /** The desk's live owner, which "Ir para" goes to. */
  owner?: { id: OwnerId; name: string }
  /** What to say when the desk has no live owner: undefined when it has one. */
  free?: { text: string; canGive: boolean }
  /** The desk's lines; empty when there is nothing to show (a desk with no owner and nothing stored). */
  deskHeading: string
  deskLines: DeskLine[]
  /** The desk has no owner but kept lines the person set before: they are shown, under the free message. */
  deskStored: boolean
  focus?: PaneBlock
  exceptions: ExceptionLine[]
  /** How many panes the owner commands that follow the desk (the line under the exceptions); 0 draws nothing. */
  follow: { count: number; all: boolean }
  othersHeading: string
  others: OtherLine[]
  /** What "Ligar tudo" would clear: nothing to clear disables it. */
  writes: InvWrite[]
}

const letter = (name: string): string => { const c = [...name.trim()][0]; return c ? c.toUpperCase() : '?' }
export { letter as ownerLetter }

const hasData = (inv: Inventory | undefined): boolean => !!inv && Object.keys(inv).length > 0

/** The model of the pad for a target, from the facts of now. */
export function inventoryModel(f: InventoryFacts, target: PadTarget): InventoryModel {
  const focusPane = target.paneId !== undefined ? f.panes.find(p => p.id === target.paneId) : undefined
  const deskId = target.deskId ?? focusPane?.deskId
  const desk = deskId !== undefined ? f.desks.find(d => d.id === deskId) : undefined
  const deskName = desk?.name ?? (target.paneId !== undefined || deskId === undefined ? 'Gaveta' : deskId)
  const deskOwner = deskId !== undefined ? f.deskOwner.get(deskId) : undefined
  const live = deskOwner && !deskOwner.ended ? deskOwner.owner : undefined
  const ownerName = live !== undefined ? f.nameOf(live) : undefined
  const deskInv = deskId !== undefined ? f.deskInv.get(deskId) : undefined
  const members = deskId !== undefined ? f.panes.filter(p => p.deskId === deskId) : []

  const everyInv = [deskInv, ...members.map(p => f.paneInv.get(p.id)), ...(focusPane ? [f.paneInv.get(focusPane.id)] : [])]
  const caps = paneCapabilities(everyInv)
  const labelOf = (id: CapabilityId): string => caps.find(c => c.id === id)?.label ?? DESK_CAPABILITIES.find(c => c.id === id)?.label ?? id

  const deskLines: DeskLine[] = [
    ...caps.map(c => ({ cap: c.id, label: c.label, on: capabilityOn(c.id, deskInv) })),
    ...DESK_CAPABILITIES.map(c => ({ cap: c.id, label: c.label, on: capabilityOn(c.id, deskInv) })),
  ]

  // A pane with an owner of its own (given to another, or "de si") does not inherit the desk's inventory: `via` says so.
  const itemsOf = (paneId: string): ItemLine[] => {
    const inv = f.paneInv.get(paneId)
    const via = effOf(f, paneId).via
    return caps.map(c => ({
      cap: c.id, label: c.label, state: paneCapabilityState(c.id, inv),
      deskOn: capabilityOn(c.id, via === 'pane' || via === 'self' ? undefined : deskInv), on: capabilityOn(c.id, deskInv, inv, via),
    }))
  }
  const offCount = (paneId: string, via: Effective['via']): number => caps.filter(c => !capabilityOn(c.id, deskInv, f.paneInv.get(paneId), via)).length

  let focus: PaneBlock | undefined
  if (focusPane) {
    const eff = effOf(f, focusPane.id)
    const who = eff.commander !== undefined ? f.nameOf(eff.commander) : undefined
    const note = eff.commander === undefined || who === undefined ? T.paneNote.none
      : eff.via === 'desk' ? T.paneNote.desk(who) : eff.via === 'self' ? T.paneNote.self(who) : T.paneNote.pane(who)
    focus = { paneId: focusPane.id, title: focusPane.title, note, items: itemsOf(focusPane.id), outside: focusPane.deskId === undefined }
  }

  const exceptions: ExceptionLine[] = []
  const others: OtherLine[] = []
  let followers = 0
  for (const p of members) {
    if (p.id === focus?.paneId) continue
    const eff = effOf(f, p.id)
    if (eff.commander === undefined) continue
    if (live !== undefined && eff.commander === live) {
      const before = exceptions.length
      for (const c of caps) {
        const st = paneCapabilityState(c.id, f.paneInv.get(p.id))
        if (st !== 'desk') exceptions.push({ paneId: p.id, title: p.title, cap: c.id, label: c.label, state: st })
      }
      if (exceptions.length === before) followers++
    } else {
      const off = offCount(p.id, eff.via)
      others.push({ paneId: p.id, title: p.title, ownerId: eff.commander, ownerName: f.nameOf(eff.commander), self: eff.via === 'self', summary: off === 0 ? T.allOnSummary : T.offSummary(off) })
    }
  }

  const free: InventoryModel['free'] = live !== undefined ? undefined
    : deskOwner?.ended ? { text: T.freeEnded(deskOwner.ended.name), canGive: true }
    : { text: T.free, canGive: true }
  if (free && desk === undefined) {
    // A pane outside any desk, or a system desk: nothing to give.
    free.text = deskId === undefined ? '' : T.noDesk
    free.canGive = false
  }

  return {
    title: T.title(ownerName, deskName),
    ...(deskId !== undefined ? { deskId } : {}),
    deskName,
    ...(live !== undefined && ownerName !== undefined ? { owner: { id: live, name: ownerName } } : {}),
    ...(free ? { free } : {}),
    deskHeading: T.deskHeading(ownerName),
    deskLines: desk === undefined ? [] : deskLines,
    deskStored: live === undefined && hasData(deskInv),
    ...(focus ? { focus } : {}),
    exceptions,
    follow: { count: followers, all: exceptions.length === 0 },
    othersHeading: T.others(live !== undefined),
    others,
    writes: allOnWrites(f, deskId, focus?.paneId),
  }
}

// ---- the writes -----------------------------------------------------------------------------------------------------------------

/** One write to `objects`: a desk's or a pane's `inventory` (undefined deletes the key). */
export interface InvWrite { kind: 'desk' | 'pane'; id: string; value: Inventory | undefined }

/** A desk's line on or off: on is the born state, so it is deleted; the stored desk inventory is only what is off. */
export function withDeskItem(inv: Inventory | undefined, cap: CapabilityId, on: boolean): Inventory | undefined {
  const next: Inventory = { ...(inv ?? {}) }
  if (on) delete next[cap]
  else next[cap] = false
  return hasData(next) ? next : undefined
}

/** A pane's line in one of its three states: 'desk' deletes it (herdar); 'on' and 'off' keep the person's word. */
export function withPaneItem(inv: Inventory | undefined, cap: CapabilityId, state: 'desk' | 'on' | 'off'): Inventory | undefined {
  const next: Inventory = { ...(inv ?? {}) }
  if (state === 'desk') delete next[cap]
  else next[cap] = state === 'on'
  return hasData(next) ? next : undefined
}

/** What a click on a pane's switch does: it states the opposite of what the line is now (the desk's word, then each way). */
export function nextPaneState(line: Pick<ItemLine, 'state' | 'deskOn'>): 'on' | 'off' {
  if (line.state === 'desk') return line.deskOn ? 'off' : 'on'
  return line.state === 'on' ? 'off' : 'on'
}

/**
 * "Ligar tudo": back to the born state. The desk's inventory goes, and so does the inventory of every pane of that desk (the
 * pane on screen too, when it has no desk). Only what has data is written, so nothing to clear is no write at all.
 */
export function allOnWrites(f: InventoryFacts, deskId: string | undefined, paneId?: string): InvWrite[] {
  const out: InvWrite[] = []
  if (deskId !== undefined) {
    if (hasData(f.deskInv.get(deskId))) out.push({ kind: 'desk', id: deskId, value: undefined })
    for (const p of f.panes) if (p.deskId === deskId && hasData(f.paneInv.get(p.id))) out.push({ kind: 'pane', id: p.id, value: undefined })
  }
  if (paneId !== undefined && !out.some(w => w.kind === 'pane' && w.id === paneId) && hasData(f.paneInv.get(paneId))) out.push({ kind: 'pane', id: paneId, value: undefined })
  return out
}
