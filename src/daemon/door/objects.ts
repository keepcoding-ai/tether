// Per-object data of the agent door: an extension keeps JSON values under (kind, objectId, key), where the object is a desk or a
// pane. The truth lives in the daemon (it needs the data with the app closed), one file per extension in <home>/objects/<ext>.json,
// written whole with temp + rename, one write at a time. The app reads and writes it through `object-get` / `object-set` and
// follows the `object` event.
//
// Life of the data: a pane of a slot dies with the slot (`dropPane`, called by the server's forget hook); a desk, and a pane that is
// not a slot, die when a `desk-map` no longer shows them (`handleDeskMap`). A drop deletes the data, tells the clients (one `object`
// event per key, value absent) and tells the owning extension (`onDidDrop`).
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DisposableStore, toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { DeskMap, ObjectKind } from '../protocol.ts'
import { DoorError, doorUnavailable, type DoorReplyBody, type DoorRequestHandler, type SlotPort } from './port.ts'
import type { DoorObjects } from './types.ts'

export interface ObjectServiceOptions {
  log: (msg: string) => void
}

export function objectsDir(home: string): string {
  return join(home, 'objects')
}

export function objectsPath(home: string, ext: string): string {
  return join(objectsDir(home), `${encodeURIComponent(ext)}.json`)
}

const KINDS: readonly ObjectKind[] = ['desk', 'pane']
const isKind = (k: unknown): k is ObjectKind => k === 'desk' || k === 'pane'
const isName = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512

/** kind -> objectId -> key -> value, for one extension. Maps all the way: ids and keys are arbitrary strings. */
type Space = Record<ObjectKind, Map<string, Map<string, unknown>>>

const newSpace = (): Space => ({ desk: new Map(), pane: new Map() })

export interface ObjectChange { kind: ObjectKind; id: string; key: string; value: unknown }
export interface ObjectDrop { kind: ObjectKind; id: string; data: Record<string, unknown> }

/** The data as a plain record (fromEntries defines own properties, so a key such as `__proto__` stays a key). */
function toRecord(m: Map<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(m)
}

type Snapshot = { desk: Record<string, Record<string, unknown>>; pane: Record<string, Record<string, unknown>> }

function snapshotOf(space: Space | undefined): Snapshot {
  const out: Snapshot = { desk: {}, pane: {} }
  if (space) for (const kind of KINDS) out[kind] = Object.fromEntries([...space[kind]].map(([id, keys]) => [id, toRecord(keys)]))
  return out
}

export class ObjectService {
  private readonly log: (msg: string) => void
  private port: SlotPort | undefined
  private readonly spaces = new Map<string, Space>()
  private readonly changeListeners = new Set<(ext: string, e: ObjectChange) => void>()
  private readonly dropListeners = new Set<(ext: string, e: ObjectDrop) => void>()
  private writing: Promise<void> = Promise.resolve()

  constructor(opts: ObjectServiceOptions) {
    this.log = opts.log
  }

  /** Resolves once the files in <home>/objects were read (the loop never blocks on it). Every write waits for it. */
  ready: Promise<void> = Promise.resolve()

  /** The server's port arrived: the home is known, so the files are read. Once. */
  attach(port: SlotPort): void {
    this.port = port
    this.ready = this.load(port.home)
  }

  private async load(home: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(objectsDir(home))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`door: pasta objects ilegível, ignorada: ${(e as Error).message}`)
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let ext: string
      try { ext = decodeURIComponent(name.slice(0, -'.json'.length)) } catch { continue }
      try {
        const raw: unknown = JSON.parse(await readFile(join(objectsDir(home), name), 'utf8'))
        const space = parseSpace(raw)
        if (!space) throw new Error('formato inesperado')
        this.spaces.set(ext, space)
      } catch (e) {
        this.log(`door: objects/${name} ilegível, ignorado: ${(e as Error).message}`)
      }
    }
  }

  // ---- reads (sync, memory) ---------------------------------------------------------------------

  get<T>(ext: string, kind: ObjectKind, id: string, key: string): T | undefined {
    return this.spaces.get(ext)?.[kind].get(id)?.get(key) as T | undefined
  }

  entries<T>(ext: string, kind: ObjectKind, key: string): [string, T][] {
    const out: [string, T][] = []
    for (const [id, keys] of this.spaces.get(ext)?.[kind] ?? []) if (keys.has(key)) out.push([id, keys.get(key) as T])
    return out
  }

  /** Everything one extension holds, in the shape of the `object-get` reply. */
  snapshot(ext: string): Snapshot { return snapshotOf(this.spaces.get(ext)) }

  // ---- writes -----------------------------------------------------------------------------------

  /** `undefined` deletes the key. The value is normalised through JSON, so memory equals what a reload gives. Resolves when on disk. */
  async set(ext: string, kind: ObjectKind, id: string, key: string, value: unknown): Promise<void> {
    const port = this.live('objects.set')
    if (!isName(ext) || !isKind(kind) || !isName(id) || !isName(key)) throw new DoorError('bad-request', 'objeto, chave e extensão precisam de nomes válidos')
    let stored: unknown
    if (value !== undefined) {
      const text = JSON.stringify(value)
      if (text === undefined) throw new DoorError('bad-request', 'o valor não é JSON')
      stored = JSON.parse(text)
    }
    await this.ready
    const space = this.spaces.get(ext) ?? newSpace()
    const keys = space[kind].get(id)
    if (stored === undefined) {
      if (!keys?.has(key)) return
      keys.delete(key)
      if (keys.size === 0) space[kind].delete(id)
    } else {
      if (keys?.has(key) && JSON.stringify(keys.get(key)) === JSON.stringify(stored)) return
      if (keys) keys.set(key, stored)
      else space[kind].set(id, new Map([[key, stored]]))
      this.spaces.set(ext, space)
    }
    this.announce(port, ext, { kind, id, key, value: stored })
    await this.persist(port.home, ext)
  }

  /** The slot was forgotten: its pane's data goes, in every extension. */
  async dropPane(slotId: string): Promise<void> {
    if (!this.port) return
    await this.ready
    await this.drop('pane', (id) => id === slotId)
  }

  /**
   * A desk-map arrived: a desk it lacks, and a pane it lacks that is not a slot, lose their data. A slot's pane is never dropped
   * by a map (it lives with the slot, even in a drawer-less moment); the slot's forget drops it.
   */
  async handleDeskMap(map: DeskMap): Promise<void> {
    const port = this.port
    if (!port) return
    await this.ready
    const desks = new Set(map.desks.map((d) => d.id))
    const panes = new Set<string>(map.drawer.map((p) => p.id))
    for (const d of map.desks) for (const p of d.panes) panes.add(p.id)
    await this.drop('desk', (id) => !desks.has(id))
    await this.drop('pane', (id) => !panes.has(id) && port.meta(id) === undefined)
  }

  private async drop(kind: ObjectKind, doomed: (id: string) => boolean): Promise<void> {
    const port = this.port
    if (!port) return
    for (const [ext, space] of [...this.spaces]) {
      const gone: ObjectDrop[] = []
      for (const [id, keys] of [...space[kind]]) {
        if (!doomed(id)) continue
        gone.push({ kind, id, data: toRecord(keys) })
        space[kind].delete(id)
      }
      if (gone.length === 0) continue
      for (const g of gone) {
        for (const key of Object.keys(g.data)) port.broadcast({ t: 'object', ext, kind, objectId: g.id, key })
        for (const l of [...this.dropListeners]) l(ext, g)
      }
      await this.persist(port.home, ext)
    }
  }

  private announce(port: SlotPort, ext: string, e: ObjectChange): void {
    port.broadcast({ t: 'object', ext, kind: e.kind, objectId: e.id, key: e.key, ...(e.value === undefined ? {} : { value: e.value }) })
    for (const l of [...this.changeListeners]) l(ext, e)
  }

  /** The extension's whole space as it is when the write runs; one write at a time, the last state wins. */
  private persist(home: string, ext: string): Promise<void> {
    const run = async (): Promise<void> => {
      const path = objectsPath(home, ext)
      const tmp = `${path}.${process.pid}.tmp`
      try {
        await mkdir(objectsDir(home), { recursive: true })
        await writeFile(tmp, JSON.stringify(snapshotOf(this.spaces.get(ext))) + '\n')
        await rename(tmp, path)
      } catch (e) {
        this.log(`door: não gravei objects/${ext}: ${(e as Error).message}`)
      }
    }
    this.writing = this.writing.then(run)
    return this.writing
  }

  /** Resolves when every write handed to `persist` is on disk. */
  flush(): Promise<void> { return this.writing }

  private live(what: string): SlotPort {
    if (!this.port) throw doorUnavailable(what)
    return this.port
  }

  // ---- the pipe ---------------------------------------------------------------------------------

  readonly handleGet: DoorRequestHandler = async (req): Promise<DoorReplyBody> => {
    const ext = (req as { ext?: unknown }).ext
    if (!isName(ext)) throw new DoorError('bad-request', 'object-get precisa de ext')
    this.live('objects.get')
    await this.ready
    return { objects: this.snapshot(ext) }
  }

  readonly handleSet: DoorRequestHandler = async (req): Promise<DoorReplyBody> => {
    const r = req as { ext?: unknown; kind?: unknown; objectId?: unknown; key?: unknown; value?: unknown }
    if (!isName(r.ext) || !isKind(r.kind) || !isName(r.objectId) || !isName(r.key)) {
      throw new DoorError('bad-request', 'object-set precisa de ext, kind (desk|pane), objectId e key')
    }
    await this.set(r.ext, r.kind, r.objectId, r.key, r.value)
    return {}
  }

  // ---- the extensions' API ----------------------------------------------------------------------

  /** The `objects` of extension `ext`: it sees only its own space; its listeners land in `own`. */
  apiFor(ext: string, own: DisposableStore): DoorObjects {
    const service = this
    return {
      get ready() { return service.ready },
      get: (kind, id, key) => this.get(ext, kind, id, key),
      set: (kind, id, key, value) => this.set(ext, kind, id, key, value),
      entries: (kind, key) => this.entries(ext, kind, key),
      onDidChange: (listener) => own.add(this.listen(this.changeListeners, (who, e) => { if (who === ext) listener(e) })),
      onDidDrop: (listener) => own.add(this.listen(this.dropListeners, (who, e) => { if (who === ext) listener(e) })),
    }
  }

  private listen<A extends unknown[]>(set: Set<(...a: A) => void>, fn: (...a: A) => void): IDisposable {
    set.add(fn)
    return toDisposable(() => { set.delete(fn) })
  }
}

/** Validates what the disk holds; undefined when it is not an objects file. */
function parseSpace(raw: unknown): Space | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const space = newSpace()
  for (const kind of KINDS) {
    const part = (raw as Record<string, unknown>)[kind]
    if (part === undefined) continue
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return undefined
    for (const [id, keys] of Object.entries(part)) {
      if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return undefined
      const m = new Map<string, unknown>(Object.entries(keys))
      if (m.size > 0) space[kind].set(id, m)
    }
  }
  return space
}
