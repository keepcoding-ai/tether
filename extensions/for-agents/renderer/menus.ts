// The menus of ownership (tether for agents): what the menu of a desk pill and the menu of a tab say, state by state, in the
// approved preview's words (section 3). `deskMenu` and `paneMenu` are pure: from the facts (the layout and the `objects` of this
// extension) they give the rows, with the action each one stands for; `menus(ui, run)` is the thin part that reads the app,
// turns the rows into the seams' rows (`ui.desks.menu`, `ui.panes.tabMenu` with `place: 'top'`) and hands an action to `run`.
// The state of a pane comes from `effective()` (rules.ts), the one place the rules live; nothing here decides who commands.
import type { ContextMenuRow, MenuPin, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import {
  OBJECT_KEYS, effective, type DeskFacts, type Effective, type Frozen, type Hand, type OwnerId, type Ownership,
} from '../rules.ts'
import { EXT_ID } from '../manifest.ts'
import { INFO, L, waitingWhat } from './texts.ts'
import { clockOf } from './view-model.ts'

/** What a gesture is done to: a pane (by id), or a desk. */
export interface Target { kind: 'pane' | 'desk'; id: string }

/** What a row stands for; `run` in gestures.ts does it. */
export type Action =
  | { do: 'go-owner'; owner: OwnerId }
  | { do: 'go'; target: Target }
  | { do: 'take'; target: Target }
  | { do: 'pause'; target: Target }
  | { do: 'resume'; target: Target }
  | { do: 'pause-all'; owner: OwnerId }
  | { do: 'resume-all'; owner: OwnerId }
  | { do: 'give'; target: Target }
  | { do: 'revoke'; target: Target }
  | { do: 'inventory'; target: Target }
  | { do: 'keep-desk'; deskId: string }
  | { do: 'close-opened'; deskId: string; owner: OwnerId }

export type Row =
  | { kind: 'info'; text: string }
  | { kind: 'sep' }
  | { kind: 'item'; icon: string; label: string; act: Action; pin?: MenuPin; danger?: boolean; disabled?: boolean }
  | { kind: 'submenu'; icon: string; label: string; children: Row[] }

/** A request waiting on a pane, when the app can tell (the pane's attention, routed to its owner or the person's own). */
export interface Waiting { kind: 'waiting' | 'done'; at?: string }

/** Everything the models read: the layout and this extension's data, out of the mirror. */
export interface MenuFacts {
  panes: readonly { id: string; type: string; deskId?: string | undefined; title: string; agent: boolean }[]
  desks: readonly { id: string; name: string }[]
  paneOwner: ReadonlyMap<string, Ownership>
  paneHand: ReadonlyMap<string, Hand>
  deskOwner: ReadonlyMap<string, Ownership>
  deskHand: ReadonlyMap<string, Hand>
  frozen: ReadonlyMap<string, Frozen>
  nameOf(id: OwnerId): string
  /** Absent: the app does not say (no row or line depends on it then). */
  waiting?(paneId: string): Waiting | undefined
  /** How many panes of a desk the owner opened (SlotMeta.createdBy); absent: unknown, the row is not drawn. */
  openedBy?(owner: OwnerId, deskId: string): number
  clock?(iso: string): string
}

const clockOfFacts = (f: MenuFacts, iso: string): string => (f.clock ?? clockOf)(iso)

export function deskFactsOf(f: MenuFacts, deskId: string): DeskFacts {
  const owner = f.deskOwner.get(deskId)
  const hand = f.deskHand.get(deskId)
  return { id: deskId, ...(owner ? { owner } : {}), ...(hand ? { hand } : {}) }
}

/** The effective ownership of a pane, by the pure rule. */
export function effOf(f: MenuFacts, paneId: string): Effective {
  const p = f.panes.find(x => x.id === paneId)
  const owner = f.paneOwner.get(paneId)
  const hand = f.paneHand.get(paneId)
  return effective({ id: paneId, ...(owner ? { owner } : {}), ...(hand ? { hand } : {}) }, p?.deskId !== undefined ? deskFactsOf(f, p.deskId) : undefined, new Set(f.frozen.keys()))
}

const liveOwner = (o: Ownership | undefined): OwnerId | undefined => (o && !o.ended ? o.owner : undefined)
const item = (icon: string, label: string, act: Action, extra: { pin?: MenuPin; danger?: boolean } = {}): Row => ({ kind: 'item', icon, label, act, ...extra })
const pane = (id: string): Target => ({ kind: 'pane', id })
const desk = (id: string): Target => ({ kind: 'desk', id })

// ---- the pill's menu (section 3, "Menu da pílula") -------------------------------------------------------------------------------

export function deskMenu(f: MenuFacts, deskId: string): Row[] {
  if (!f.desks.some(d => d.id === deskId)) return []
  const o = f.deskOwner.get(deskId)
  const t = desk(deskId)
  if (!o) return [item('robot', L.giveDesk, { do: 'give', target: t })]

  if (o.ended) {
    const rows: Row[] = [{ kind: 'info', text: INFO.deskEnded(o.ended.name, clockOfFacts(f, o.ended.at)) }]
    const opened = f.openedBy?.(o.owner, deskId) ?? 0
    if (opened > 0) rows.push(item('broom', L.closeOpened(o.ended.name, opened), { do: 'close-opened', deskId, owner: o.owner }, { danger: true }))
    rows.push(item('robot', L.giveDesk, { do: 'give', target: t }), item('check', L.keepDesk, { do: 'keep-desk', deskId }))
    return rows
  }

  const n = f.nameOf(o.owner)
  const hand = f.deskHand.get(deskId)
  const frozen = f.frozen.get(o.owner)
  const goTo = item('arrow-square-out', L.goTo(n), { do: 'go-owner', owner: o.owner })
  const takeIt = item('hand-grabbing', L.takeDesk, { do: 'take', target: t })
  const inventory = item('sliders-horizontal', L.inventoryDesk(n), { do: 'inventory', target: t })
  const passIt = item('swap', L.giveDeskOther, { do: 'give', target: t })
  const revoke = item('link-break', L.revokeDesk, { do: 'revoke', target: t }, { danger: true })

  if (hand?.why === 'taken') {
    return [{ kind: 'info', text: INFO.deskTaken(n) }, item('arrow-u-up-left', L.returnDesk(n), { do: 'resume', target: t }), inventory, revoke]
  }
  if (hand?.why === 'paused') {
    return [{ kind: 'info', text: INFO.deskPaused(n, clockOfFacts(f, hand.since)) }, item('play', L.resumeDesk(n), { do: 'resume', target: t }), goTo, takeIt, inventory, passIt, revoke]
  }
  if (frozen) {
    return [{ kind: 'info', text: INFO.deskPausedAll(n, clockOfFacts(f, frozen.since)) }, item('play', L.resumeAll(n), { do: 'resume-all', owner: o.owner }), goTo, takeIt, inventory, passIt, revoke]
  }
  let commands = 0
  let sees = 0
  for (const p of f.panes) {
    if (p.deskId !== deskId) continue
    const e = effOf(f, p.id)
    if (e.commander === o.owner) commands++
    else if (e.viewer === o.owner && p.id !== o.owner) sees++
  }
  return [
    { kind: 'info', text: INFO.deskLive(n, commands, sees) }, goTo,
    item('pause', L.pauseDesk(n), { do: 'pause', target: t }), takeIt, inventory, passIt, revoke,
  ]
}

// ---- the tab's menu (section 3, "Menu da aba") --------------------------------------------------------------------------------------

/** The owner's own section: what is theirs and "pausar em tudo" (the menu of the tab of the agent that owns). */
function ownerSection(f: MenuFacts, paneId: string): Row[] {
  const p = f.panes.find(x => x.id === paneId)
  if (!p?.agent) return []
  const n = f.nameOf(paneId)
  const frozen = f.frozen.get(paneId)
  const deskNameOf = (deskId: string | undefined): string => f.desks.find(d => d.id === deskId)?.name ?? 'Gaveta'
  const mesas = f.desks.filter(d => liveOwner(f.deskOwner.get(d.id)) === paneId)
  const guias = f.panes.filter(x => x.id !== paneId && liveOwner(f.paneOwner.get(x.id)) === paneId)
  if (frozen) {
    return [{ kind: 'info', text: INFO.ownerPausedAll(clockOfFacts(f, frozen.since)) }, item('play', L.resumeAll(n), { do: 'resume-all', owner: paneId }, { pin: 'primary' })]
  }
  if (mesas.length === 0 && guias.length === 0) return []
  const places = [...new Set(guias.map(g => deskNameOf(g.deskId)))]
  const children: Row[] = [
    ...mesas.map(d => item('cards', L.deskChild(d.name), { do: 'go', target: desk(d.id) })),
    ...guias.map(g => item('terminal-window', L.paneChild(deskNameOf(g.deskId), g.title), { do: 'go', target: pane(g.id) })),
  ]
  return [
    { kind: 'info', text: INFO.ownerOwns(mesas.map(d => d.name), guias.length, places) },
    item('pause', L.pauseAll(n), { do: 'pause-all', owner: paneId }, { pin: 'icon' }),
    { kind: 'submenu', icon: 'list-numbers', label: L.whatIsOf(n), children },
  ]
}

/** Where the hand of a commanded pane is held: its own, its desk's, or the owner's pause everywhere. */
function handSource(f: MenuFacts, paneId: string, eff: Effective): { at: 'pane' | 'desk' | 'all'; hand?: Hand; since: string } | undefined {
  if (eff.hand !== 'user' || eff.commander === undefined) return undefined
  const own = f.paneHand.get(paneId)
  if (own) return { at: 'pane', hand: own, since: own.since }
  const p = f.panes.find(x => x.id === paneId)
  const dh = eff.via === 'desk' && p?.deskId !== undefined ? f.deskHand.get(p.deskId) : undefined
  if (dh) return { at: 'desk', hand: dh, since: dh.since }
  return { at: 'all', since: f.frozen.get(eff.commander)?.since ?? '' }
}

export function paneMenu(f: MenuFacts, paneId: string): Row[] {
  const p = f.panes.find(x => x.id === paneId)
  // Ownership is about terminal tabs (they have a slot); a note, preview, browser or channel tab is never given.
  if (!p || p.type !== 'terminal') return []
  const rows: Row[] = []
  const own = ownerSection(f, paneId)
  const owner = own.length > 0
  if (owner) rows.push(...own)
  if (owner && f.frozen.has(paneId)) return rows // paused everywhere: the preview shows only the way back

  const eff = effOf(f, paneId)
  const t = pane(paneId)
  const pane1: Row[] = []
  const cmd = eff.commander

  if (cmd === undefined) {
    if (eff.ended?.on === 'pane') {
      const w = f.waiting?.(paneId)
      pane1.push({ kind: 'info', text: INFO.paneEnded(eff.ended.name, w?.kind === 'waiting') })
      if (w?.kind === 'waiting') pane1.push({ kind: 'info', text: INFO.answerInPane })
      pane1.push(item('robot', L.givePane, { do: 'give', target: t }))
      const deskOwner = p.deskId !== undefined ? liveOwner(f.deskOwner.get(p.deskId)) : undefined
      pane1.push(deskOwner !== undefined
        ? item('arrow-u-up-left', L.returnToDesk(f.nameOf(deskOwner)), { do: 'revoke', target: t })
        : item('check', L.keepPane, { do: 'revoke', target: t }))
    } else {
      pane1.push(item('robot', L.givePane, { do: 'give', target: t }))
    }
  } else {
    const n = f.nameOf(cmd)
    const inventory = item('sliders-horizontal', eff.via === 'self' ? L.inventorySelf(n) : L.inventoryPane(n), { do: 'inventory', target: t })
    const src = handSource(f, paneId, eff)
    if (src) {
      const what = src.hand?.why ?? 'paused'
      const target = src.at === 'desk' && p.deskId !== undefined ? desk(p.deskId) : t
      const before = eff.via === 'desk' ? `${n}, pela mesa` : eff.via === 'self' ? `${n}, de si` : n
      if (what === 'taken') {
        pane1.push({ kind: 'info', text: INFO.paneTaken(before) })
        pane1.push(src.at === 'desk'
          ? item('arrow-u-up-left', L.returnDesk(n), { do: 'resume', target }, { pin: 'highlight' })
          : item('arrow-u-up-left', L.returnPane(n), { do: 'resume', target }, { pin: 'highlight' }))
      } else {
        pane1.push({ kind: 'info', text: src.at === 'all' ? INFO.ownerPausedAll(clockOfFacts(f, src.since)) : INFO.panePaused(n, clockOfFacts(f, src.since)) })
        pane1.push(src.at === 'all'
          ? item('play', L.resumeAll(n), { do: 'resume-all', owner: cmd }, { pin: 'primary' })
          : src.at === 'desk'
            ? item('play', L.resumeDesk(n), { do: 'resume', target }, { pin: 'primary' })
            : item('play', eff.via === 'self' ? L.resumeSelf(n) : L.resumePane(n), { do: 'resume', target }, { pin: 'primary' }))
      }
      if (eff.via !== 'self') pane1.push(item('swap', L.givePaneOtherShort, { do: 'give', target: t }))
      pane1.push(inventory)
    } else {
      const w = f.waiting?.(paneId)
      const goTo = item('arrow-square-out', L.goTo(n), { do: 'go-owner', owner: cmd }, { pin: 'icon' })
      const pause = item('pause', eff.via === 'self' ? L.pauseSelf(n) : L.pausePane(n), { do: 'pause', target: t }, eff.via === 'self' ? {} : { pin: 'icon' })
      if (eff.via === 'desk') {
        const take = item('hand-grabbing', w ? L.takeAndAnswer : L.take, { do: 'take', target: t }, { pin: 'icon' })
        if (w) pane1.push({ kind: 'info', text: INFO.paneWaits(n, waitingWhat(w.kind), w.at ? clockOfFacts(f, w.at) : '') }, goTo, take)
        else pane1.push({ kind: 'info', text: INFO.paneByDesk(n) }, take)
        pane1.push(pause, item('robot', L.givePaneOther, { do: 'give', target: t }), inventory)
      } else if (eff.via === 'pane') {
        const take = item('hand-grabbing', w ? L.takeAndAnswer : L.take, { do: 'take', target: t }, { pin: 'icon' })
        const tail = [item('swap', L.givePaneOtherShort, { do: 'give', target: t }), item('arrow-u-up-left', L.backToDesk(n), { do: 'revoke', target: t }), inventory]
        if (w) pane1.push({ kind: 'info', text: INFO.paneWaits(n, waitingWhat(w.kind), w.at ? clockOfFacts(f, w.at) : '') }, goTo, take, pause, ...tail)
        else pane1.push({ kind: 'info', text: INFO.paneGiven(n, eff.viewer !== undefined ? f.nameOf(eff.viewer) : undefined) }, take, pause, goTo, ...tail)
      } else {
        pane1.push({ kind: 'info', text: INFO.paneSelf(n) }, pause, inventory, item('arrow-u-up-left', L.revokeSelf, { do: 'revoke', target: t }))
      }
    }
  }
  if (rows.length > 0 && pane1.length > 0) rows.push({ kind: 'sep' })
  rows.push(...pane1)
  return rows
}

// ---- the seams ---------------------------------------------------------------------------------------------------------------------

/** The app's rows for a model: an info line is a heading, an item runs its action, a submenu has its items as children. */
export function toRows(rows: readonly Row[], run: (act: Action) => void): ContextMenuRow[] {
  const out: ContextMenuRow[] = []
  for (const r of rows) {
    if (r.kind === 'info') out.push({ heading: r.text })
    else if (r.kind === 'sep') out.push('sep')
    else if (r.kind === 'item') {
      out.push({ icon: r.icon, label: r.label, run: () => run(r.act), ...(r.pin ? { pin: r.pin } : {}), ...(r.danger ? { danger: true } : {}), ...(r.disabled ? { disabled: true } : {}) })
    } else {
      out.push({ icon: r.icon, label: r.label, run: () => {}, children: toRows(r.children, run) })
    }
  }
  return out
}

const titleOf = (ui: TetherUi, p: { id: string; file?: string; cwd?: string; type: string }): string => {
  const a = ui.agents.get(p.id)
  if (a) return a.name
  const path = p.file ?? p.cwd
  return path ? (path.split(/[\\/]/).filter(Boolean).pop() ?? p.type) : p.type
}

/** The facts as the app has them now. */
export function readFacts(ui: TetherUi): MenuFacts {
  const desks = ui.desks.list()
  const deskOf = new Map<string, string>()
  for (const d of desks) for (const id of d.panes) deskOf.set(id, d.id)
  const map = <T>(kind: 'desk' | 'pane', key: string): Map<string, T> => new Map(ui.objects.entries<T>(kind, key))
  const facts: MenuFacts = {
    panes: ui.panes.all().map(p => ({ id: p.id, type: p.type, deskId: deskOf.get(p.id), title: titleOf(ui, p), agent: p.agent !== undefined })),
    desks: desks.map(d => ({ id: d.id, name: d.name })),
    paneOwner: map<Ownership>('pane', OBJECT_KEYS.owner),
    paneHand: map<Hand>('pane', OBJECT_KEYS.hand),
    deskOwner: map<Ownership>('desk', OBJECT_KEYS.owner),
    deskHand: map<Hand>('desk', OBJECT_KEYS.hand),
    frozen: map<Frozen>('pane', OBJECT_KEYS.frozen),
    nameOf: id => ui.agents.get(id)?.name ?? id,
    waiting: id => waitingOf(ui, facts, id),
    openedBy: (owner, deskId) => openedPanes(ui, facts, owner, deskId).length,
  }
  return facts
}

/**
 * What a pane waits for, as the menus say it. A pane commanded by someone waits for that owner when the daemon sent the attention
 * to it (the diamond); a pane nobody commands (its owner ended) waits for the person, and says so in its own words.
 */
function waitingOf(ui: TetherUi, f: MenuFacts, paneId: string): Waiting | undefined {
  const s = ui.panes.slotFacts(paneId)
  if (!s) return undefined
  if (s.routed) return { kind: s.routed.value, ...(s.routed.since ? { at: s.routed.since } : {}) }
  if (s.attention && effOf(f, paneId).commander === undefined) return { kind: s.attention.value, ...(s.attention.since ? { at: s.attention.since } : {}) }
  return undefined
}

/** The panes of a desk the owner's agent opened (SlotMeta.createdBy: this extension, acting for that slot). */
export function openedPanes(ui: TetherUi, f: MenuFacts, owner: OwnerId, deskId: string): string[] {
  return f.panes.filter(p => p.deskId === deskId && p.id !== owner).filter(p => {
    const c = ui.panes.slotFacts(p.id)?.createdBy
    return c?.ext === EXT_ID && c.slotId === owner
  }).map(p => p.id)
}

/** Puts the menus of ownership in the pill and in every tab; `run` does the action of a picked row. */
export function menus(ui: TetherUi, run: (act: Action) => void): IDisposable[] {
  return [
    ui.desks.menu(deskId => toRows(deskMenu(readFacts(ui), deskId), run)),
    ui.panes.tabMenu(p => toRows(paneMenu(readFacts(ui), p.id), run), { place: 'top' }),
  ]
}
