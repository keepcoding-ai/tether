// The agent door's host: owns the request registry and the server hooks (DoorSeams), and builds the door part of each
// daemon extension's API (DoorApi). Inertia rule: registering always works (it lands in the extension's store and goes
// with it); acting rejects with `door-unavailable` until a service is live. A satellite (CLI, Electron main) never gets a
// SlotPort, so its door stays inert for good. Reads that find nothing answer empty rather than throw, except readScreen,
// which has no honest empty answer.
import { DisposableStore, toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { LaunchPlan } from '../../agents/types.ts'
import type { SlotMeta } from '../../core/event.ts'
import type { SlotState } from '../protocol.ts'
import { type DoorRequestHandler, type DoorSeams, type InputOrigin, type LaunchContext, type LaunchGrant, type SlotPort } from './port.ts'
import { DeliveryService } from './delivery.ts'
import { DeskService } from './desks.ts'
import { DoorMcp } from './mcp.ts'
import { AttentionRouteService } from './attention-route.ts'
import { ObjectService } from './objects.ts'
import { SlotKeys } from './slot-key.ts'
import { SlotsService } from './slots.ts'
import { ENV_SLOT_KEY, type DoorApi, type DoorAttention, type DoorDelivery, type DoorDesks, type DoorObjects, type DoorSlots, type DoorVerbs } from './types.ts'
import { VerbRegistry } from './verbs.ts'

export interface DoorHostOptions {
  log: (msg: string) => void
}

export class DoorHost implements DoorSeams {
  private readonly opts: DoorHostOptions
  private readonly handlers = new Map<string, DoorRequestHandler>()
  private portRef: SlotPort | undefined
  /** The per-launch slot keys (digests only) that prove a CLI verb call came from that slot's environment. */
  readonly slotKeys = new SlotKeys()
  /** The contributed verbs: the CLI's `verb-list`/`verb` read it here, and the MCP server (D5) reads the same one. */
  readonly verbs: VerbRegistry
  /** The desk map (D2): kept in <home>/desks.json, fed by the app's `desk-map`. */
  readonly desks: DeskService
  /** The slots service (D1): drives slots through the port, fans `stateChanged` out, answers `read-screen`. */
  private readonly slotsService: SlotsService
  /** The per-object data (D3): kept in <home>/objects/<ext>.json, pruned by a forgotten slot and by a desk-map. */
  readonly objects: ObjectService
  /** The rerouted attention (D7): the route is in the slot's meta; the service silences the state at the source. */
  private readonly attentionService: AttentionRouteService
  /** The `tether` MCP server (D5): the verbs with the `mcp` exit as tools, and the channel the delivery uses from inside. */
  readonly mcp: DoorMcp
  /** The delivery (D6): inside through `mcp`, through the terminal of a held pane, or queued in <home>/slots/<slot>.inbox.jsonl. */
  readonly delivery: DeliveryService

  constructor(opts: DoorHostOptions) {
    this.opts = opts
    this.verbs = new VerbRegistry({ keys: this.slotKeys, stateOf: (slotId) => this.portRef?.stateOf(slotId) })
    this.slotsService = new SlotsService(() => this.portRef, (msg) => this.opts.log(msg), () => this.desks, () => ({ isFree: (slotId) => this.delivery.presence.isFree(slotId, Date.now(), 'user') }))
    this.requests.register('read-screen', this.slotsService.handleReadScreen)
    this.desks = new DeskService({ log: (msg) => this.log(msg) })
    this.requests.register('desk-map', this.desks.handleMap)
    this.attentionService = new AttentionRouteService(() => this.portRef, (msg) => this.log(msg))
    this.objects = new ObjectService({ log: (msg) => this.log(msg) })
    this.requests.register('object-get', this.objects.handleGet)
    this.requests.register('object-set', this.objects.handleSet)
    this.desks.onDidChange((map) => { this.objects.handleDeskMap(map).catch((e: unknown) => this.log(`objects: ${(e as Error).message}`)) })
    this.requests.register('verb-list', this.verbs.handleList)
    this.requests.register('verb', this.verbs.handleRun)
    this.mcp = new DoorMcp({ log: (msg) => this.opts.log(msg), verbs: this.verbs, port: () => this.portRef })
    this.delivery = new DeliveryService({ log: (msg) => this.opts.log(msg), mcp: this.mcp, port: () => this.portRef })
  }

  /** The server's port; undefined in a satellite. */
  get port(): SlotPort | undefined { return this.portRef }

  /** tetherd owns the pipe here: the door may act. */
  get live(): boolean { return this.portRef !== undefined }

  // ---- request registry (the `default` of the server's switch) --------------------------------

  readonly requests = {
    /** One handler per request type; the core's own types never reach it (the server's switch answers them first). */
    register: (t: string, handler: DoorRequestHandler): IDisposable => {
      if (this.handlers.has(t)) throw new Error(`o pedido ${t} já tem quem responda`)
      this.handlers.set(t, handler)
      return toDisposable(() => { if (this.handlers.get(t) === handler) this.handlers.delete(t) })
    },
  }

  // ---- DoorSeams -------------------------------------------------------------------------------

  attach(port: SlotPort): void {
    if (this.portRef) throw new Error('a porta do agente já tem um servidor')
    this.portRef = port
    this.desks.attach(port)
    this.slotKeys.attach(port.home, (msg) => this.log(msg))
    this.objects.attach(port)
    this.delivery.attach(port)
  }

  requestHandler(t: string): DoorRequestHandler | undefined {
    return this.handlers.get(t)
  }

  decorate(meta: SlotMeta, state: SlotState): void { this.attentionService.decorate(meta, state) }

  stateChanged(state: SlotState): void { this.attentionService.stateChanged(state); this.slotsService.stateChanged(state); this.delivery.stateChanged(state) }

  input(slotId: string, data: string, origin: InputOrigin): void { this.delivery.input(slotId, data, origin); this.slotsService.input(slotId, data, origin) }

  /**
   * A new slot key goes into the run's environment, after the profile's env (a profile cannot set it). Then the `tether` MCP
   * server, only when this launch gets it (a promise then: its MCP file must be on disk before the spawn); otherwise the
   * grant is plain and the plan is the given one plus the slot key.
   */
  prepareLaunch(plan: LaunchPlan, ctx: LaunchContext): LaunchGrant | Promise<LaunchGrant> {
    const slotId = ctx.meta.slotId
    const key = this.slotKeys.issue(slotId)
    const keyed: LaunchGrant = { plan: { ...plan, env: { ...plan.env, [ENV_SLOT_KEY]: key } }, revoke: () => this.slotKeys.revoke(slotId, key) }
    if (!this.mcp.offers(ctx)) return keyed
    return this.mcp.prepare(keyed.plan, ctx).then((offer) => ({
      plan: offer.plan,
      channel: offer.channel,
      revoke: () => { keyed.revoke(); if (offer.offered) this.mcp.revoke(slotId, offer.run) },
    }))
  }

  exited(slotId: string): void { this.slotKeys.revoke(slotId); this.mcp.revoke(slotId); this.attentionService.exited(slotId) }

  forgotten(slotId: string): Promise<void> { this.slotKeys.revoke(slotId); this.mcp.revoke(slotId); this.slotsService.forgotten(slotId); return Promise.all([this.attentionService.forgotten(slotId), this.objects.dropPane(slotId), this.delivery.forgotten(slotId)]).then(() => undefined) }

  /**
   * The start, after the extensions activated: a hold whose extension is not active (turned off, failed, gone) is a hold
   * nobody keeps, so it goes, with the attention route of the same slot (the route is the hold's other half). A hold of an
   * active extension is left to it. One log line per slot cleared.
   */
  async releaseInactive(active: readonly string[]): Promise<void> {
    const port = this.portRef
    if (!port) return
    const keep = new Set(active)
    for (const s of port.list()) {
      const meta = port.meta(s.slotId)
      if (!meta?.held || keep.has(meta.held.ext)) continue
      const ext = meta.held.ext
      delete meta.held
      const routed = meta.attentionTo !== undefined
      if (routed) { delete meta.attentionTo; this.attentionService.unindex(s.slotId) }
      try { await port.saveMeta(s.slotId) } catch (e) { this.log(`não gravei o meta de ${s.slotId}: ${(e as Error).message}`) }
      port.broadcastState(s.slotId)
      this.log(`slot ${s.slotId}: posse da extensão inativa ${ext} desfeita${routed ? ', com a rota de atenção' : ''}`)
    }
  }

  // ---- the extensions' API ---------------------------------------------------------------------

  /** The door part of extension `ext`'s TetherDaemon; its registrations land in `own`. */
  apiFor(ext: string, own: DisposableStore): DoorApi {
    const slots: DoorSlots = this.slotsService.apiFor(ext, own)
    const desksService = this.desks
    const desks: DoorDesks = {
      map: () => this.desks.map(),
      deskOf: (paneId) => this.desks.deskOf(paneId),
      onDidChange: (listener) => own.add(this.desks.onDidChange(listener)),
      requestPane: (slotId, deskId) => this.desks.requestPane(slotId, deskId),
      get ready() { return desksService.ready },
    }
    const verbs: DoorVerbs = {
      register: (verb) => own.add(this.verbs.register(ext, verb)),
      instructions: (text) => own.add(this.verbs.instructions(ext, text)),
    }
    const delivery: DoorDelivery = {
      ...this.delivery.apiFor(ext, own),
      enable: () => own.add(this.mcp.enableDelivery()),
    }
    const attention: DoorAttention = this.attentionService.apiFor(ext, own)
    const objects: DoorObjects = this.objects.apiFor(ext, own)
    return { slots, desks, verbs, delivery, attention, objects }
  }

  /** Logs through tetherd's log (for the services the next slices add). */
  protected log(msg: string): void { this.opts.log(`door: ${msg}`) }
}
