// The agent door's host: owns the request registry and the server hooks (DoorSeams), and builds the door part of each
// daemon extension's API (DoorApi). Inertia rule: registering always works (it lands in the extension's store and goes
// with it); acting rejects with `door-unavailable` until a service is live. A satellite (CLI, Electron main) never gets a
// SlotPort, so its door stays inert for good. Reads that find nothing answer empty rather than throw, except readScreen,
// which has no honest empty answer.
import { DisposableStore, toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { LaunchPlan } from '../../agents/types.ts'
import type { SlotMeta } from '../../core/event.ts'
import type { SlotState } from '../protocol.ts'
import { doorUnavailable, type DoorRequestHandler, type DoorSeams, type InputOrigin, type LaunchContext, type LaunchGrant, type SlotPort } from './port.ts'
import { SlotKeys } from './slot-key.ts'
import { ENV_SLOT_KEY, type DoorApi, type DoorAttention, type DoorDelivery, type DoorDesks, type DoorObjects, type DoorSlots, type DoorVerbs } from './types.ts'
import { VerbRegistry } from './verbs.ts'

export interface DoorHostOptions {
  log: (msg: string) => void
}

/** A registration that does nothing yet but is owned (and disposed) like a real one. */
function owned(own: DisposableStore): IDisposable {
  return own.add(toDisposable(() => {}))
}

const reject = (what: string): Promise<never> => Promise.reject(doorUnavailable(what))

export class DoorHost implements DoorSeams {
  private readonly opts: DoorHostOptions
  private readonly handlers = new Map<string, DoorRequestHandler>()
  private portRef: SlotPort | undefined
  /** The per-launch slot keys (digests only) that prove a CLI verb call came from that slot's environment. */
  readonly slotKeys = new SlotKeys()
  /** The contributed verbs: the CLI's `verb-list`/`verb` read it here, and the MCP server (D5) reads the same one. */
  readonly verbs: VerbRegistry

  constructor(opts: DoorHostOptions) {
    this.opts = opts
    this.verbs = new VerbRegistry({ keys: this.slotKeys, stateOf: (slotId) => this.portRef?.stateOf(slotId) })
    this.requests.register('verb-list', this.verbs.handleList)
    this.requests.register('verb', this.verbs.handleRun)
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
  }

  requestHandler(t: string): DoorRequestHandler | undefined {
    return this.handlers.get(t)
  }

  decorate(_meta: SlotMeta, _state: SlotState): void {}

  stateChanged(_state: SlotState): void {}

  input(_slotId: string, _data: string, _origin: InputOrigin): void {}

  /** A new slot key goes into the run's environment, after the profile's env (a profile cannot set it). */
  prepareLaunch(plan: LaunchPlan, ctx: LaunchContext): LaunchGrant {
    const slotId = ctx.meta.slotId
    const key = this.slotKeys.issue(slotId)
    return { plan: { ...plan, env: { ...plan.env, [ENV_SLOT_KEY]: key } }, revoke: () => this.slotKeys.revoke(slotId, key) }
  }

  exited(slotId: string): void { this.slotKeys.revoke(slotId) }

  forgotten(slotId: string): void { this.slotKeys.revoke(slotId) }

  // ---- the extensions' API ---------------------------------------------------------------------

  /** The door part of extension `ext`'s TetherDaemon; its registrations land in `own`. */
  apiFor(ext: string, own: DisposableStore): DoorApi {
    const what = (service: string): string => `${service}, extensão ${ext}`
    const slots: DoorSlots = {
      create: () => reject(what('slots.create')),
      write: () => reject(what('slots.write')),
      keys: () => reject(what('slots.keys')),
      readScreen: () => { throw doorUnavailable(what('slots.readScreen')) },
      start: () => reject(what('slots.start')),
      stop: () => reject(what('slots.stop')),
      restart: () => reject(what('slots.restart')),
      forget: () => reject(what('slots.forget')),
      rename: () => reject(what('slots.rename')),
      get: () => undefined,
      list: () => [],
      onState: () => owned(own),
      setHeld: () => reject(what('slots.setHeld')),
    }
    const desks: DoorDesks = {
      map: () => undefined,
      deskOf: () => undefined,
      onDidChange: () => owned(own),
      requestPane: () => reject(what('desks.requestPane')),
    }
    const verbs: DoorVerbs = {
      register: (verb) => own.add(this.verbs.register(ext, verb)),
      instructions: (text) => own.add(this.verbs.instructions(ext, text)),
    }
    const delivery: DoorDelivery = {
      enable: () => owned(own),
      deliver: () => reject(what('delivery.deliver')),
      pending: () => [],
      cancel: () => false,
      onDidDeliver: () => owned(own),
      pathOf: () => 'wait',
    }
    const attention: DoorAttention = {
      route: () => reject(what('attention.route')),
      unroute: () => reject(what('attention.unroute')),
      routeOf: () => undefined,
      seen: () => { throw doorUnavailable(what('attention.seen')) },
    }
    const objects: DoorObjects = {
      get: () => undefined,
      set: () => reject(what('objects.set')),
      entries: () => [],
      onDidChange: () => owned(own),
      onDidDrop: () => owned(own),
    }
    return { slots, desks, verbs, delivery, attention, objects }
  }

  /** Logs through tetherd's log (for the services the next slices add). */
  protected log(msg: string): void { this.opts.log(`door: ${msg}`) }
}
