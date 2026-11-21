// An extension's data on desks and panes (agent door), as the app sees it: a mirror of tetherd's store, which is the truth
// (the daemon needs the data with the app closed). The mirror is fed by `object-get` on each connection and by the daemon's
// `object` event; a write is an `object-set` request. Pure (no DOM, no Electron): the renderer's DoorHost and Electron main's
// door-objects.ts both build on it, each with its own way to ask the daemon.
import type { ExtObjectChange, ExtObjects, RequestBody } from '../../shared/api.ts'
import type { ObjectKind, Reply } from '../../../src/daemon/protocol.ts'
import { toDisposable, type IDisposable } from '../../shared/vscode-lifecycle.ts'

/** How a host talks to the daemon (an error reply resolves; a missing connection resolves as an error reply too). */
export type DaemonAsk = (body: RequestBody) => Promise<Reply>

/** The daemon's `object` event body (without the `t`). `value` absent: the key was deleted. */
export interface ObjectEventBody { ext: string; kind: ObjectKind; objectId: string; key: string; value?: unknown }

type Snapshot = { desk: Record<string, Record<string, unknown>>; pane: Record<string, Record<string, unknown>> }

const KINDS: readonly ObjectKind[] = ['desk', 'pane']

/** Structural equality for JSON values (what the daemon stores); key order does not matter. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** One extension's mirror: kind -> object id -> key -> value. An object with no keys left does not exist. */
class ObjectStore implements ExtObjects {
  private readonly data: Record<ObjectKind, Map<string, Map<string, unknown>>> = { desk: new Map(), pane: new Map() }
  private readonly listeners = new Set<(e: ExtObjectChange) => void>()
  /** Events that arrived while the snapshot was in flight; replayed over it. */
  private pending: ObjectEventBody[] | undefined

  private readonly ext: string
  private readonly ask: DaemonAsk

  constructor(ext: string, ask: DaemonAsk) { this.ext = ext; this.ask = ask }

  get<T>(kind: ObjectKind, id: string, key: string): T | undefined {
    const v = this.data[kind].get(id)?.get(key)
    return v === undefined ? undefined : structuredClone(v) as T
  }

  entries<T>(kind: ObjectKind, key: string): [string, T][] {
    const out: [string, T][] = []
    for (const [id, keys] of this.data[kind]) if (keys.has(key)) out.push([id, structuredClone(keys.get(key)) as T])
    return out
  }

  async set(kind: ObjectKind, id: string, key: string, value: unknown): Promise<void> {
    const copy = value === undefined ? undefined : structuredClone(value)
    const reply = await this.ask({ t: 'object-set', ext: this.ext, kind, objectId: id, key, ...(copy === undefined ? {} : { value: copy }) })
    if (reply.t === 'error') throw new Error(reply.message)
    // The event may reach this side after the reply does; applying here too is idempotent (an equal value tells no one twice).
    this.change(kind, id, key, copy)
  }

  onDidChange(listener: (e: ExtObjectChange) => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  /** The daemon's `object` event. */
  apply(e: ObjectEventBody): void {
    if (this.pending) { this.pending.push(e); return }
    this.change(e.kind, e.objectId, e.key, e.value)
  }

  /** Reads everything of this extension from the daemon and makes the mirror equal to it (listeners hear the differences). */
  async load(): Promise<void> {
    this.pending = []
    let snapshot: Snapshot | undefined
    try {
      const reply = await this.ask({ t: 'object-get', ext: this.ext })
      if (reply.t === 'ok') snapshot = reply.objects ?? { desk: {}, pane: {} }
    } catch { /* no connection yet: the next connection loads again */ }
    const queued = this.pending
    this.pending = undefined
    if (snapshot) this.replace(snapshot)
    for (const e of queued) this.change(e.kind, e.objectId, e.key, e.value)
  }

  private replace(snapshot: Snapshot): void {
    for (const kind of KINDS) {
      const next = snapshot[kind] ?? {}
      for (const [id, keys] of [...this.data[kind]]) {
        for (const key of [...keys.keys()]) if (!Object.hasOwn(next[id] ?? {}, key)) this.change(kind, id, key, undefined)
      }
      for (const [id, keys] of Object.entries(next)) for (const [key, value] of Object.entries(keys)) this.change(kind, id, key, value)
    }
  }

  private change(kind: ObjectKind, id: string, key: string, value: unknown): void {
    const objects = this.data[kind]
    const keys = objects.get(id)
    if (value === undefined) {
      if (!keys?.delete(key)) return
      if (keys.size === 0) objects.delete(id)
    } else {
      if (keys && sameValue(keys.get(key), value)) return
      const target = keys ?? new Map<string, unknown>()
      target.set(key, structuredClone(value))
      if (!keys) objects.set(id, target)
    }
    for (const l of [...this.listeners]) { try { l({ kind, id, key, value }) } catch (err) { console.error('objects.onDidChange', err) } }
  }
}

/** The mirrors of every extension that asked for its objects. */
export class ObjectMirrors {
  private readonly stores = new Map<string, ObjectStore>()

  private readonly ask: DaemonAsk

  constructor(ask: DaemonAsk) { this.ask = ask }

  /** This extension's objects (the same one on each call). The first call starts reading it from the daemon. */
  apiFor(ext: string): ExtObjects {
    let store = this.stores.get(ext)
    if (!store) {
      store = new ObjectStore(ext, this.ask)
      this.stores.set(ext, store)
      void store.load()
    }
    return store
  }

  /** The daemon's `object` event. An extension that never asked has no mirror, and the event is dropped. */
  apply(e: ObjectEventBody): void { this.stores.get(e.ext)?.apply(e) }

  /** A connection (the first or a new one): every mirror reads the daemon again. */
  reload(): Promise<void> { return Promise.all([...this.stores.values()].map(s => s.load())).then(() => {}) }
}

/** The renderer's way to the daemon: `window.tether.request`, read when used (no document in the unit tests: every call fails as door-unavailable). */
export function rendererAsk(): DaemonAsk {
  return async body => {
    const api = (globalThis as { window?: { tether?: { request(b: RequestBody): Promise<Reply> } } }).window?.tether
    return api ? api.request(body) : { t: 'error', id: -1, code: 'bad-request', message: 'door-unavailable: sem conexão com o tetherd' }
  }
}
