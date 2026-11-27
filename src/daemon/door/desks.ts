// The desk map of the agent door: the app tells the daemon which panes sit in which desk (`desk-map`), the daemon keeps it in
// <home>/desks.json (so it answers while the app is closed) and uses it for the `paneRequest` bookkeeping: a slot asked a pane
// in a desk keeps `paneRequest` until a map shows the slot in some desk. A hibernated desk changes nothing here: the process
// of a slot asked into it starts at once and only the pane sleeps (the renderer's job).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { DeskMap, DeskMapDesk, DeskMapPane } from '../protocol.ts'
import { DoorError, type DoorReplyBody, type DoorRequestHandler, type SlotPort } from './port.ts'
import type { DoorDesks } from './types.ts'

export interface DeskServiceOptions {
  log: (msg: string) => void
}

export function desksPath(home: string): string {
  return join(home, 'desks.json')
}

const isPane = (p: unknown): p is { id: string; type: string } =>
  typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string' && typeof (p as { type?: unknown }).type === 'string'

/** A pane of the map, normalised: `asleep`, `suspended` and `noSuspend` kept only when they are `true`. */
const paneOf = (p: DeskMapPane): DeskMapPane => ({ id: p.id, type: p.type, ...(p.asleep === true ? { asleep: true as const } : {}), ...(p.suspended === true ? { suspended: true as const } : {}), ...(p.noSuspend === true ? { noSuspend: true as const } : {}) })

/** Validates and normalises what the app sent (or what the disk holds); undefined when it is not a desk map. */
export function parseDeskMap(raw: unknown): DeskMap | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as { desks?: unknown; drawer?: unknown }
  if (!Array.isArray(r.desks) || !Array.isArray(r.drawer) || !r.drawer.every(isPane)) return undefined
  const desks: DeskMapDesk[] = []
  for (const d of r.desks) {
    if (typeof d !== 'object' || d === null) return undefined
    const x = d as Partial<DeskMapDesk>
    if (typeof x.id !== 'string' || typeof x.name !== 'string' || (x.kind !== 'queue' && x.kind !== 'system')) return undefined
    if (!Array.isArray(x.panes) || !x.panes.every(isPane)) return undefined
    desks.push({ id: x.id, name: x.name, kind: x.kind, ...(x.asleep === true ? { asleep: true as const } : {}), panes: x.panes.map(paneOf) })
  }
  return { desks, drawer: (r.drawer as DeskMapPane[]).map(paneOf) }
}

export class DeskService implements DoorDesks {
  private readonly log: (msg: string) => void
  private port: SlotPort | undefined
  private current: DeskMap | undefined
  private currentText: string | undefined
  private byPane = new Map<string, DeskMapDesk>()
  /** The slots whose terminal pane sits in a desk. */
  private shownSlots = new Set<string>()
  /** The panes the app suspended to save resources (map `suspended`), in desks or in the drawer. */
  private suspendedPanes = new Set<string>()
  private readonly listeners = new Set<(map: DeskMap) => void>()
  private writing: Promise<void> = Promise.resolve()

  private resolveReady!: () => void

  constructor(opts: DeskServiceOptions) {
    this.log = opts.log
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve })
  }

  /** The server's port arrived: the home is known, so the last map is read from disk. Once. */
  attach(port: SlotPort): void {
    this.port = port
    readFile(desksPath(port.home), 'utf8').then((text) => {
      const map = parseDeskMap(JSON.parse(text))
      if (map && this.current === undefined) this.adopt(map)
    }).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`door: desks.json ilegível, ignorado: ${(e as Error).message}`)
    }).finally(this.resolveReady)
  }

  /**
   * Resolves once the map on disk was read (the loop never blocks on it); a map the app sent first wins over the disk's. One
   * promise for the life of the service: an extension takes it in activate(), before the server attaches the door, so it settles
   * only when `attach` finished the read. A door that is never attached (a satellite) never reads, and its `ready` stays pending.
   */
  readonly ready: Promise<void>

  // ---- DoorDesks ---------------------------------------------------------------------------------

  map(): DeskMap | undefined { return this.current }

  deskOf(paneId: string): DeskMapDesk | undefined { return this.byPane.get(paneId) }

  /** The app suspended this pane to save resources (map `suspended`): anything that needs it resumes it first. */
  isSuspended(paneId: string): boolean { return this.suspendedPanes.has(paneId) }

  onDidChange(listener: (map: DeskMap) => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  /** Asks a terminal pane for an existing slot. A slot already shown in a desk is left where it is. */
  async requestPane(slotId: string, deskId: string): Promise<void> {
    const port = this.live()
    const meta = port.meta(slotId)
    if (!meta) throw new DoorError('unknown-slot', `slot desconhecido: ${slotId}`)
    const request = this.paneRequestFor(deskId)
    if (this.shownSlots.has(slotId)) return
    meta.paneRequest = request
    await port.saveMeta(slotId)
    port.broadcastState(slotId)
  }

  // ---- for the slots service ---------------------------------------------------------------------

  /**
   * The `paneRequest` a slot born in `deskId` carries. With a known map, an unknown desk is refused (`bad-request`); with no
   * map yet (the app never ran) the request is kept as asked, and a later map that lacks the desk drops it.
   */
  paneRequestFor(deskId: string): { deskId: string } {
    if (this.current && !this.current.desks.some((d) => d.id === deskId)) throw new DoorError('bad-request', `a mesa ${deskId} não existe`)
    return { deskId }
  }

  /**
   * The `paneRequest` for a remote `create { desk }`: `ref` is a desk id, or else a desk name that only one desk has. Stricter
   * than `paneRequestFor`: the person is not at the app, so a sleeping desk is refused too. With no map yet, taken as asked.
   */
  requestForTarget(ref: string, asker?: string): { deskId: string } {
    const map = this.current
    if (!map) {
      if (asker !== undefined) throw new DoorError('bad-request', `a mesa ${ref} não existe`)
      return { deskId: ref }
    }
    const found = map.desks.find((d) => d.id === ref)
    const byName = found ? [] : map.desks.filter((d) => d.name === ref)
    if (byName.length > 1) throw new DoorError('bad-request', `há mais de uma mesa chamada "${ref}": use o id`)
    const desk = found ?? byName[0]
    if (!desk) throw new DoorError('bad-request', `a mesa ${ref} não existe`)
    // A system desk takes no pane from the pipe. An agent asking (its pane's identity came with the request) gets only a desk
    // that is its own, by the same rule `agents open` applies; the person (no asker) gets any ordinary desk.
    if (desk.kind === 'system') throw new DoorError('bad-request', `a mesa "${desk.name}" é de sistema`)
    if (asker !== undefined && !(this.ownership?.(asker, desk.id) ?? false)) throw new DoorError('door-denied', `a mesa ${desk.name} não é sua`)
    if (desk.asleep) throw new DoorError('bad-request', `a mesa "${desk.name}" está hibernando`)
    return { deskId: desk.id }
  }

  /** The ownership rule an extension registered (`DoorDesks.useOwnership`). */
  private ownership: ((slotId: string, deskId: string) => boolean) | undefined

  useOwnership(check: (slotId: string, deskId: string) => boolean): IDisposable {
    if (this.ownership) throw new Error('a regra de posse de mesa já tem quem responda')
    this.ownership = check
    return toDisposable(() => { if (this.ownership === check) this.ownership = undefined })
  }

  // ---- the pipe's `desk-map` ---------------------------------------------------------------------

  readonly handleMap: DoorRequestHandler = async (req): Promise<DoorReplyBody> => {
    const map = parseDeskMap((req as { map?: unknown }).map)
    if (!map) throw new DoorError('bad-request', 'desk-map precisa de um mapa de mesas válido')
    const port = this.live()
    await this.ready
    if (this.adopt(map)) {
      this.persist(port.home)
      port.broadcast({ t: 'desks', map })
      for (const l of [...this.listeners]) l(map)
    }
    await this.settleRequests(port, map)
    return {}
  }

  /** A slot shown in a desk loses its request; a request for a desk the map no longer has is dropped with a log line. */
  private async settleRequests(port: SlotPort, map: DeskMap): Promise<void> {
    for (const state of port.list()) {
      const meta = port.meta(state.slotId)
      const request = meta?.paneRequest
      if (!meta || !request) continue
      const shown = this.shownSlots.has(state.slotId)
      if (!shown && map.desks.some((d) => d.id === request.deskId)) continue
      if (!shown) this.log(`door: a mesa ${request.deskId} não existe; o slot ${state.slotId} fica sem guia`)
      delete meta.paneRequest
      await port.saveMeta(state.slotId)
      port.broadcastState(state.slotId)
    }
  }

  // ---- internals ---------------------------------------------------------------------------------

  private live(): SlotPort {
    if (!this.port) throw new DoorError('door-unavailable', 'a porta do agente não está disponível neste processo (desks)')
    return this.port
  }

  /** Takes the map as the current one; false when it is the same as before. */
  private adopt(map: DeskMap): boolean {
    const text = JSON.stringify(map)
    if (text === this.currentText) return false
    this.current = map
    this.currentText = text
    this.byPane = new Map()
    this.shownSlots = new Set()
    this.suspendedPanes = new Set()
    for (const d of map.desks) for (const p of d.panes) { this.byPane.set(p.id, d); if (p.type === 'terminal') this.shownSlots.add(p.id); if (p.suspended) this.suspendedPanes.add(p.id) }
    for (const p of map.drawer) if (p.suspended) this.suspendedPanes.add(p.id)
    return true
  }

  /** Whole file, temp + rename, one write at a time (the last map wins). */
  private persist(home: string): void {
    const text = this.currentText ?? ''
    this.writing = this.writing.then(async () => {
      const path = desksPath(home)
      const tmp = `${path}.${process.pid}.tmp`
      try {
        await mkdir(home, { recursive: true })
        await writeFile(tmp, text + '\n')
        await rename(tmp, path)
      } catch (e) {
        this.log(`door: não gravei desks.json: ${(e as Error).message}`)
      }
    })
  }

  /** Resolves when every map handed to `persist` is on disk. */
  flush(): Promise<void> { return this.writing }
}
