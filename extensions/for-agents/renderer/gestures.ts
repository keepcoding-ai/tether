// The gestures of ownership in the app (tether for agents): giving a pane or a desk (the picker, then the dialog, with "Voltar"),
// revoking, taking and giving back, pausing and resuming in the three scopes (pane, desk, everything of one owner), going to the
// owner. Each gesture is one write to `objects` (this extension's space), the very value `store.*` of the daemon writes
// (daemon/ownership.ts): the daemon's reconciler is what acts on the door, from the change event, so a gesture made with the
// daemon busy is not lost and both sides never decide differently. Nothing here activates a pane or switches a desk, but
// "Ir para", which is a request to go. The commands (`for-agents.give`, `.take`...) take `{ kind, id }`: with it they act
// there, with no picker for a given `to`; without it they act on the active pane.
import type { AgentPane } from '../../../app/renderer/agent-panes.ts'
import type { PaneEmblem, PickItem, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { agentHue } from '../../../app/shared/agent-color.ts'
import { OBJECT_KEYS, type Frozen, type Hand, type OwnerId, type Ownership } from '../rules.ts'
import { effOf, menus, openedPanes, readFacts, type Action, type MenuFacts, type Target } from './menus.ts'
import { PICK, closeOpenedDialog, giveDeskDialog, givePaneDialog, revokeDeskDialog, waitingWhat } from './texts.ts'
import { clockOf, initialOf } from './view-model.ts'

const MAX_RECENT = 3

// ---- the picker's rows (step 1), pure ----------------------------------------------------------------------------------------

export interface PickContext {
  /** The desk the target is in ("Nesta mesa"). */
  deskId?: string | undefined
  /** The owner the target has now: it is not offered again. */
  exclude?: OwnerId | undefined
  /** The agents given most recently, newest first. */
  recent: readonly OwnerId[]
  /** How many desks and panes each agent owns, for the line under its name. */
  owns(id: OwnerId): { mesas: number; guias: number }
  /** The pane being given: its own agent reads "ela mesma: de si". */
  paneId?: string | undefined
  /** Reads the emblem of a guia (its slot id); rows with none stay bare. */
  emblemOf?: ((id: string) => PaneEmblem | undefined) | undefined
}

/** Only live agents (F8); "Recentes", then "Nesta mesa", then "Outras mesas", each by name. */
export function pickItems(agents: readonly AgentPane[], c: PickContext): PickItem<OwnerId>[] {
  const live = agents.filter(a => a.alive && a.slotId !== c.exclude)
  const byName = (a: AgentPane, b: AgentPane): number => a.name.localeCompare(b.name)
  const recent = c.recent.map(id => live.find(a => a.slotId === id)).filter((a): a is AgentPane => a !== undefined)
  const rest = live.filter(a => !recent.includes(a))
  const here = rest.filter(a => c.deskId !== undefined && a.deskId === c.deskId).sort(byName)
  const elsewhere = rest.filter(a => !here.includes(a)).sort(byName)
  const row = (a: AgentPane, group: string): PickItem<OwnerId> => {
    const o = c.owns(a.slotId)
    const place = a.inDrawer ? 'a Gaveta' : (a.deskTitle ?? '')
    const detail = [a.slotId === c.paneId ? PICK.itself : place ? PICK.livesIn(place) : '', o.mesas + o.guias > 0 ? PICK.owns(o.mesas, o.guias) : ''].filter(Boolean).join(' · ')
    const emblem = c.emblemOf?.(a.slotId)
    return { value: a.slotId, label: a.name, icon: 'robot', letter: initialOf(a.name), hue: agentHue(a.slotId), ...(detail ? { detail } : {}), ...(emblem ? { emblem } : {}), group }
  }
  return [...recent.map(a => row(a, PICK.groupRecent)), ...here.map(a => row(a, PICK.groupHere)), ...elsewhere.map(a => row(a, PICK.groupElsewhere))]
}

// ---- the writes: the same values as OwnershipStore ----------------------------------------------------------------------------

export function writes(ui: TetherUi, now: () => string = () => new Date().toISOString()) {
  const set = (kind: 'pane' | 'desk', id: string, key: string, value: unknown): Promise<void> => ui.objects.set(kind, id, key, value)
  return {
    give(t: Target, to: OwnerId): Promise<void> {
      const value: Ownership = { owner: to, since: now(), givenBy: 'user' }
      return set(t.kind, t.id, OBJECT_KEYS.owner, value)
    },
    revoke: (t: Target): Promise<void> => set(t.kind, t.id, OBJECT_KEYS.owner, undefined),
    hand(t: Target, why: Hand['why']): Promise<void> {
      const value: Hand = { with: 'user', why, by: 'gesture', since: now() }
      return set(t.kind, t.id, OBJECT_KEYS.hand, value)
    },
    handBack: (t: Target): Promise<void> => set(t.kind, t.id, OBJECT_KEYS.hand, undefined),
    freeze(owner: OwnerId): Promise<void> {
      const value: Frozen = { since: now() }
      return set('pane', owner, OBJECT_KEYS.frozen, value)
    },
    unfreeze: (owner: OwnerId): Promise<void> => set('pane', owner, OBJECT_KEYS.frozen, undefined),
  }
}

const isTarget = (v: unknown): v is Target => {
  const o = v as Partial<Target> | null
  return typeof o === 'object' && o !== null && (o.kind === 'pane' || o.kind === 'desk') && typeof o.id === 'string' && o.id.length > 0
}

/** The argument of a command: a target, with an owner for the scope "all" and the agent to give to. */
interface CommandArg extends Partial<Target> { scope?: 'all'; to?: string }

export function gestures(ui: TetherUi): IDisposable[] {
  const w = writes(ui)
  const recent: OwnerId[] = []
  const warn = (what: string) => (e: unknown): void => { console.error(`for-agents: ${what}: ${(e as Error).message}`) }

  const remember = (to: OwnerId): void => {
    const at = recent.indexOf(to)
    if (at >= 0) recent.splice(at, 1)
    recent.unshift(to)
    recent.length = Math.min(recent.length, MAX_RECENT)
  }

  const deskName = (f: MenuFacts, id: string): string => f.desks.find(d => d.id === id)?.name ?? id
  const paneTitle = (f: MenuFacts, id: string): string => f.panes.find(p => p.id === id)?.title ?? id
  const ownsOf = (f: MenuFacts) => (id: OwnerId): { mesas: number; guias: number } => ({
    mesas: [...f.deskOwner].filter(([, o]) => !o.ended && o.owner === id).length,
    guias: [...f.paneOwner].filter(([pid, o]) => !o.ended && o.owner === id && pid !== id).length,
  })
  const deskOf = (f: MenuFacts, t: Target): string | undefined => (t.kind === 'desk' ? t.id : f.panes.find(p => p.id === t.id)?.deskId)

  /** The owner a target has now (live), whatever the way: its own, its desk's. */
  const ownerOfTarget = (f: MenuFacts, t: Target): OwnerId | undefined => {
    if (t.kind === 'desk') { const o = f.deskOwner.get(t.id); return o && !o.ended ? o.owner : undefined }
    return effOf(f, t.id).commander
  }

  /** The dialog of step 2 for `to` on the target, from the facts of now. */
  const dialogFor = (f: MenuFacts, t: Target, to: OwnerId) => {
    const name = f.nameOf(to)
    if (t.kind === 'desk') {
      const from = f.deskOwner.get(t.id)
      const members = f.panes.filter(p => p.deskId === t.id && p.id !== to)
      const kept = members.filter(p => { const o = f.paneOwner.get(p.id); return o && !o.ended && o.owner !== to })
      const toPane = f.panes.find(p => p.id === to)
      const away = toPane && toPane.deskId !== t.id ? (toPane.deskId !== undefined ? deskName(f, toPane.deskId) : 'a Gaveta') : undefined
      return giveDeskDialog({
        desk: deskName(f, t.id), to: name,
        ...(from && !from.ended ? { from: f.nameOf(from.owner) } : {}),
        commands: members.filter(p => { const o = f.paneOwner.get(p.id); return !o || o.owner === to }).length,
        keptByOthers: kept.map(p => ({ title: p.title, owner: f.nameOf(f.paneOwner.get(p.id)!.owner) })),
        livesIn: away,
      })
    }
    const eff = effOf(f, t.id)
    const w = f.waiting?.(t.id)
    const p = f.panes.find(x => x.id === t.id)
    const deskOwner = p?.deskId !== undefined ? f.deskOwner.get(p.deskId) : undefined
    return givePaneDialog({
      pane: paneTitle(f, t.id), to: name, itself: to === t.id,
      from: eff.commander !== undefined ? { name: f.nameOf(eff.commander), byDesk: eff.via === 'desk' } : undefined,
      viewer: deskOwner && !deskOwner.ended && deskOwner.owner !== to ? f.nameOf(deskOwner.owner) : undefined,
      pending: w ? `${waitingWhat(w.kind)}${w.at ? `, ${clockOf(w.at)}` : ''}` : undefined,
    })
  }

  /** Step 1 (the picker) and step 2 (the dialog); "Voltar" goes back to step 1; the write is the last thing. */
  async function giveFlow(t: Target): Promise<void> {
    for (;;) {
      const f = readFacts(ui)
      const current = ownerOfTarget(f, t)
      const passing = t.kind === 'desk' && current !== undefined
      const to = await ui.pick.list<OwnerId>({
        title: t.kind === 'desk' ? (passing ? PICK.titleDeskPass : PICK.titleDesk)(deskName(f, t.id)) : PICK.titlePane(paneTitle(f, t.id)),
        placeholder: PICK.placeholder,
        emptyText: PICK.empty,
        items: pickItems(ui.agents.list(), { deskId: deskOf(f, t), exclude: current, recent, owns: ownsOf(f), emblemOf: id => ui.panes.personEmblem(id), ...(t.kind === 'pane' ? { paneId: t.id } : {}) }),
      })
      if (to === undefined) return
      const answer = await ui.dialogs.ask(dialogFor(readFacts(ui), t, to))
      if (answer.choice === 'back') continue
      if (answer.choice !== 'give') return
      remember(to)
      await w.give(t, to)
      return
    }
  }

  async function revokeDesk(t: Target): Promise<void> {
    const f = readFacts(ui)
    const o = f.deskOwner.get(t.id)
    if (!o) return
    if (o.ended) { await w.revoke(t); return }
    const members = f.panes.filter(p => p.deskId === t.id)
    const answer = await ui.dialogs.ask(revokeDeskDialog({
      desk: deskName(f, t.id), owner: f.nameOf(o.owner),
      commands: members.filter(p => effOf(f, p.id).commander === o.owner && effOf(f, p.id).via === 'desk').length,
      keptByOthers: members.filter(p => { const po = f.paneOwner.get(p.id); return po && !po.ended && po.owner !== o.owner }).map(p => ({ owner: f.nameOf(f.paneOwner.get(p.id)!.owner) })),
    }))
    if (answer.choice === 'revoke') await w.revoke(t)
  }

  /** "Fechar as guias que <dono> abriu (N)…": the dialog says what happens to the agents; the panes close one by one, none activated. */
  async function closeOpened(deskId: string, owner: OwnerId): Promise<void> {
    const f = readFacts(ui)
    const ids = openedPanes(ui, f, owner, deskId)
    if (ids.length === 0) return
    const name = f.deskOwner.get(deskId)?.ended?.name ?? f.nameOf(owner)
    const answer = await ui.dialogs.ask(closeOpenedDialog({ owner: name, guias: ids.length, desk: deskName(f, deskId) }))
    if (answer.choice !== 'close' && answer.choice !== 'stop') return
    for (const id of ids) await ui.panes.closeGuide(id, { process: answer.choice === 'stop' ? 'stop' : 'keep' })
  }

  const goTo = (f: MenuFacts, t: Target): void => {
    if (t.kind === 'pane') { ui.panes.reveal(t.id); return }
    const first = f.panes.find(p => p.deskId === t.id)
    if (first) ui.panes.reveal(first.id)
  }

  /** What a row of a menu does. */
  function run(act: Action): void {
    const f = readFacts(ui)
    const done = (p: Promise<void>): void => { p.catch(warn(act.do)) }
    switch (act.do) {
      case 'go-owner': ui.agents.focus(act.owner); return
      case 'go': goTo(f, act.target); return
      case 'take': done(w.hand(act.target, 'taken')); return
      case 'pause': done(w.hand(act.target, 'paused')); return
      case 'resume': done(w.handBack(act.target)); return
      case 'pause-all': done(w.freeze(act.owner)); return
      case 'resume-all': done(w.unfreeze(act.owner)); return
      case 'give': done(giveFlow(act.target)); return
      case 'revoke': done(act.target.kind === 'desk' ? revokeDesk(act.target) : w.revoke(act.target)); return
      case 'keep-desk': done(w.revoke({ kind: 'desk', id: act.deskId })); return
      case 'inventory': void ui.commands.run('for-agents.inventory', act.target); return
      case 'close-opened': done(closeOpened(act.deskId, act.owner)); return
    }
  }

  // ---- the commands ----------------------------------------------------------------------------------------------------------------

  const targetOf = (arg: unknown): Target | undefined => {
    if (arg !== undefined) return isTarget(arg) ? arg : undefined
    const id = ui.panes.activeId()
    return id ? { kind: 'pane', id } : undefined
  }
  const command = (id: string, body: (t: Target, arg: CommandArg) => Promise<void> | void): IDisposable =>
    ui.commands.registerCommand(id, (_source, arg) => {
      const t = targetOf(arg)
      if (!t) return
      Promise.resolve(body(t, (arg ?? {}) as CommandArg)).catch(warn(id))
    })

  const commands: IDisposable[] = [
    command('for-agents.give', async (t, a) => {
      if (typeof a.to === 'string' && a.to) { remember(a.to); await w.give(t, a.to); return }
      await giveFlow(t)
    }),
    command('for-agents.take', t => w.hand(t, 'taken')),
    command('for-agents.return', t => w.handBack(t)),
    command('for-agents.revoke', t => w.revoke(t)),
    command('for-agents.pause', (t, a) => (a.scope === 'all' ? w.freeze(t.id) : w.hand(t, 'paused'))),
    command('for-agents.resume', (t, a) => (a.scope === 'all' ? w.unfreeze(t.id) : w.handBack(t))),
    command('for-agents.go-to-owner', t => {
      const owner = ownerOfTarget(readFacts(ui), t)
      if (owner !== undefined) ui.agents.focus(owner)
    }),
  ]
  // The e2e drives the commands with an argument (a palette run has none); the same entry the menus' `ui.commands.run` has.
  ui.test.expose('forAgentsRun', (id: string, arg?: unknown) => ui.commands.run(id, arg))
  return [...commands, ...menus(ui, run)]
}
