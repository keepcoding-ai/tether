// The reading module of who owns each desk: for-agents publishes it, anyone may read it (the channels extension does).
// Pure: no runtime import of the daemon or the renderer, and it knows nothing of its readers. With for-agents off the
// feed is inactive and empty. `bindDeskOwners` is the one place that feeds it from the door's objects.
import type { DoorObjects } from '../../src/daemon/ext-api.ts'
import { OBJECT_KEYS, type Ownership } from './rules.ts'

export interface DeskOwnerFact {
  deskId: string
  /** The owner's slotId. */
  owner: string
  since: string
  /** The owner was forgotten: the desk keeps the struck mark, nobody commands through it. */
  ended?: { at: string; name: string }
}

export interface DeskOwnerFeed {
  /** for-agents is on and publishing in this process. */
  readonly active: boolean
  all(): readonly DeskOwnerFact[]
  get(deskId: string): DeskOwnerFact | undefined
  /** `fact` is undefined when the desk lost its owner (revoked, or the desk is gone). */
  onDidChange(listener: (deskId: string, fact: DeskOwnerFact | undefined) => void): { dispose(): void }
  /** Resolves when the first publication of the current activation is done (already resolved while inactive). */
  readonly ready: Promise<void>
}

export interface DeskOwnerPublisher extends DeskOwnerFeed {
  /** Equal facts do not notify. */
  publish(deskId: string, fact: DeskOwnerFact | undefined): void
  /** On: a fresh `ready` starts. Off: the facts are cleared without notifying (the readers keep what they have). */
  setActive(on: boolean): void
  /** Ends the first publication of the activation. */
  markReady(): void
}

const same = (a: DeskOwnerFact | undefined, b: DeskOwnerFact | undefined): boolean => JSON.stringify(a) === JSON.stringify(b)

export function createDeskOwnerFeed(): DeskOwnerPublisher {
  const facts = new Map<string, DeskOwnerFact>()
  const listeners = new Set<(deskId: string, fact: DeskOwnerFact | undefined) => void>()
  let active = false
  let ready: Promise<void> = Promise.resolve()
  let resolveReady: (() => void) | undefined
  return {
    get active() { return active },
    get ready() { return ready },
    all: () => [...facts.values()],
    get: (deskId) => facts.get(deskId),
    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    publish(deskId, fact) {
      if (same(facts.get(deskId), fact)) return
      if (fact) facts.set(deskId, fact)
      else facts.delete(deskId)
      for (const l of [...listeners]) l(deskId, fact)
    },
    setActive(on) {
      if (on === active) return
      active = on
      if (on) {
        ready = new Promise<void>((r) => { resolveReady = r })
      } else {
        facts.clear()
        resolveReady?.()
        resolveReady = undefined
      }
    },
    markReady() {
      resolveReady?.()
      resolveReady = undefined
    },
  }
}

/** The one of the process: for-agents feeds it, any reader may read it. */
export const deskOwnerFeed: DeskOwnerPublisher = createDeskOwnerFeed()

function factOf(deskId: string, v: unknown): DeskOwnerFact | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Partial<Ownership>
  if (typeof o.owner !== 'string' || !o.owner) return undefined
  return { deskId, owner: o.owner, since: typeof o.since === 'string' ? o.since : '', ...(o.ended ? { ended: o.ended } : {}) }
}

/**
 * Feeds `feed` from the desk objects: a pass after `objects.ready`, then every change of the 'owner' key on a desk and every
 * desk that drops. The returned disposables stop it and turn the feed off.
 */
export function bindDeskOwners(
  objects: Pick<DoorObjects, 'ready' | 'entries' | 'onDidChange' | 'onDidDrop'>,
  feed: DeskOwnerPublisher = deskOwnerFeed,
): { dispose(): void }[] {
  let live = true
  feed.setActive(true)
  objects.ready.then(() => {
    if (!live) return
    const now = new Map<string, DeskOwnerFact>()
    for (const [id, v] of objects.entries<unknown>('desk', OBJECT_KEYS.owner)) {
      const f = factOf(id, v)
      if (f) now.set(id, f)
    }
    for (const f of feed.all()) if (!now.has(f.deskId)) feed.publish(f.deskId, undefined)
    for (const [id, f] of now) feed.publish(id, f)
    feed.markReady()
  }, () => { if (live) feed.markReady() })
  return [
    objects.onDidChange((e) => { if (live && e.kind === 'desk' && e.key === OBJECT_KEYS.owner) feed.publish(e.id, factOf(e.id, e.value)) }),
    objects.onDidDrop((e) => { if (live && e.kind === 'desk') feed.publish(e.id, undefined) }),
    { dispose: () => { live = false; feed.setActive(false) } },
  ]
}
