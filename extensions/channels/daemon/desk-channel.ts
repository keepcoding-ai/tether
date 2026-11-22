// The desk channel follows its desk (contract 4.1, P4, C8, C14, C20): one desk, one channel `desk_<deskId>`, which exists while
// the desk has an owner. Three sources meet here: who owns the desk (for-agents' reading module, desk-owners.ts, C3), the
// desk map the app sends (`desks`), and the channel's record. This file only decides WHEN; the gestures themselves are the
// fan-out's (`Channels.desk`), each in its channel's lane.
//
//   owner appears        -> born (name: slug of the desk's name, C14), or the same channel reopened with its history
//   another owner        -> setOwner; the same owner given again after it gave the channel up (`since` after `ownerEnded.at`) too
//   no owner / `ended`   -> closed by the person, readable
//   desk gone from map   -> closed
//   desk renamed         -> the title follows, the name stays
//   for-agents off       -> nothing follows (the feed is inactive: the channels stay as they are); on again, one pass
//   system desk          -> no channel
//
// Work is serialized in one queue. What changes per event is looked at only for the desks with an open desk channel and the
// desks with an owner, never every channel. Memory: the set of desks with an open channel (bounded by desks).
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../../src/daemon/ext-api.ts'
import type { DeskMap, DeskMapDesk } from '../../../src/daemon/protocol.ts'
import { deskOwnerFeed, type DeskOwnerFact, type DeskOwnerFeed } from '../../for-agents/desk-owners.ts'
import { deskChannelId, isDeskChannel, slugOf, type AgentId, type Channel } from '../rules.ts'
import type { Channels } from './fanout.ts'

/** What the desk channel uses of the daemon API. */
export type DeskChannelsApi = Pick<TetherDaemon, 'desks' | 'slots' | 'log'>

/** The owner a fact gives the desk: none when it ended (the owner's pane was forgotten). */
const liveOwner = (fact: DeskOwnerFact | undefined): AgentId | undefined => (fact && !fact.ended ? fact.owner : undefined)

/**
 * Whether the desk's owner is not the channel's owner now: another agent, or the same one given the desk again after it
 * gave the channel up (C20.3: a new act of the person, read from `since`).
 */
export function ownerMoved(ch: Channel, fact: DeskOwnerFact): boolean {
  if (ch.owner.kind !== 'agent' || ch.owner.id !== fact.owner) return true
  return ch.ownerEnded !== undefined && fact.since > ch.ownerEnded.at
}

export function wireDeskChannels(api: DeskChannelsApi, ready: Promise<Channels>, feed: DeskOwnerFeed = deskOwnerFeed): IDisposable[] {
  let live: Channels | undefined
  let disposed = false
  /** Desks whose desk channel is open. */
  const open = new Set<string>()
  /** The feed activation already passed over (a new `ready` is for-agents on again). */
  let passed: Promise<void> | undefined

  let queue: Promise<void> = Promise.resolve()
  const run = (what: string, fn: (c: Channels) => Promise<void>): void => {
    queue = queue.then(() => (disposed || !live ? undefined : fn(live))).catch((e: unknown) => api.log(`canal da mesa: ${what}: ${(e as Error).message}`))
  }

  const isAgent = (id: string): boolean => { const s = api.slots.get(id); return s !== undefined && s.kind !== 'shell' }
  const agentPanes = (desk: DeskMapDesk): AgentId[] => desk.panes.filter((p) => p.type === 'terminal' && isAgent(p.id)).map((p) => p.id)
  const deskIn = (map: DeskMap | undefined, deskId: string): DeskMapDesk | undefined => map?.desks.find((d) => d.id === deskId)
  const refused = (what: string, r: { ok: boolean; error?: string }): boolean => {
    if (!r.ok) api.log(`canal da mesa: ${what}: ${r.error}`)
    return !r.ok
  }

  /** Brings the desk's channel in line with its owner and its desk. */
  async function follow(c: Channels, deskId: string): Promise<void> {
    if (!feed.active) return
    const map = api.desks.map()
    const desk = deskIn(map, deskId)
    if (desk?.kind === 'system') return
    const id = deskChannelId(deskId)
    const ch = c.store.get(id)
    const fact = feed.get(deskId)
    const owner = liveOwner(fact)
    const gone = map !== undefined && desk === undefined
    if (!owner || gone) {
      if (ch && !ch.closed) refused(`encerrar ${id}`, await c.desk.close(id, gone ? 'gone' : fact?.ended ? 'ended' : 'revoked'))
      open.delete(deskId)
      return
    }
    if (!desk) return // no map yet: the desk's name is not known
    if (!ch || ch.closed) {
      const r = await c.desk.open(deskId, { name: ch?.name ?? slugOf(desk.name, c.store.openNames()), title: desk.name, owner, panes: agentPanes(desk) })
      if (!refused(`abrir ${id}`, r)) open.add(deskId)
      return
    }
    open.add(deskId)
    if (ch.title !== desk.name) refused(`título ${id}`, await c.desk.retitle(id, desk.name))
    if (ownerMoved(ch, fact!)) refused(`owner ${id}`, await c.desk.setOwner(id, owner))
  }

  /** The desks to look at: those with an open desk channel and those with an owner. */
  const watched = (): Set<string> => new Set([...open, ...feed.all().map((f) => f.deskId)])
  function pass(): void {
    for (const deskId of watched()) run(`mesa ${deskId}`, (c) => follow(c, deskId))
  }
  /** for-agents on again (a fresh `ready`): once it published, one pass reconciles. */
  function activation(): void {
    if (!feed.active || feed.ready === passed) return
    passed = feed.ready
    void passed.then(pass)
  }

  void Promise.all([ready, api.desks.ready]).then(([c]) => {
    if (disposed) return
    live = c
    // Once at the start: the desk channels left open by the last run.
    for (const ch of c.store.channels()) if (isDeskChannel(ch) && !ch.closed) open.add(ch.desk!)
    activation()
  }).catch((e: unknown) => api.log(`canal da mesa: ${(e as Error).message}`))

  return [
    feed.onDidChange((deskId) => {
      if (!live) return
      activation()
      run(`mesa ${deskId}`, (c) => follow(c, deskId))
    }),
    api.desks.onDidChange(() => {
      if (!live || !feed.active) return
      activation()
      pass()
    }),
    { dispose: () => { disposed = true } },
  ]
}
