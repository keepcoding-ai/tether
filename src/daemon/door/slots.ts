// The agent door's slot service (slice D1): what a daemon extension drives slots with. Every act goes through the server's
// SlotPort, the same methods the pipe's requests run, so there is no rule here that the core does not already have. The
// service also fans the server's `stateChanged` hook out to `onState` listeners and answers the pipe's `read-screen`.
import { toDisposable, type DisposableStore, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { SlotMeta } from '../../core/event.ts'
import type { SlotState } from '../protocol.ts'
import { DoorError, doorUnavailable, type DoorReplyBody, type DoorRequestHandler, type SlotPort } from './port.ts'
import { keyBytes } from './keys.ts'
import type { InputOrigin } from './port.ts'
import { countsAsTyping } from './user-presence.ts'
import type { DoorSlots, KeyName, SlotCreate, SlotHold } from './types.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** What the desks service (D2) offers `create`: the pane request for a desk, or `bad-request` when the map is known and the desk is not. */
export interface PaneRequester { paneRequestFor(deskId: string): { deskId: string } }

/** What `userFree` reads: the delivery's user interlock (UserPresence), for the person alone, at the present moment. */
export interface UserFreeness { isFree(slotId: string): boolean }

export class SlotsService {
  private readonly port: () => SlotPort | undefined
  private readonly log: (msg: string) => void
  private readonly desks: () => PaneRequester | undefined
  private readonly listeners = new Set<(slot: SlotState) => void>()
  private readonly typedListeners = new Set<(slotId: string) => void>()
  /** Held slots whose first user typing of the current held period was already told. `setHeld` takes the slot out. */
  private readonly typedTold = new Set<string>()
  private readonly presence: () => UserFreeness | undefined

  /** `port` is read at each act: it is undefined in a satellite (and before the server attaches), where every act is `door-unavailable`. */
  constructor(port: () => SlotPort | undefined, log: (msg: string) => void, desks: () => PaneRequester | undefined = () => undefined, presence: () => UserFreeness | undefined = () => undefined) {
    this.port = port
    this.log = log
    this.desks = desks
    this.presence = presence
  }

  /** The server's `input` hook: the person's first typing into a held pane goes to `onUserTyped`, once per held period. */
  input(slotId: string, data: string, origin: InputOrigin): void {
    if (origin !== 'user' || this.typedListeners.size === 0 || this.typedTold.has(slotId)) return
    if (!countsAsTyping(data) || !this.port()?.meta(slotId)?.held) return
    this.typedTold.add(slotId)
    for (const listener of [...this.typedListeners]) {
      try { listener(slotId) } catch (e) { this.log(`door: ouvinte de digitação falhou: ${e instanceof Error ? e.message : String(e)}`) }
    }
  }

  /** The slot was forgotten: nothing of it stays here. */
  forgotten(slotId: string): void { this.typedTold.delete(slotId) }

  /** The server's `stateChanged` hook: every listener hears it; one that throws does not silence the others. */
  stateChanged(state: SlotState): void {
    for (const listener of [...this.listeners]) {
      try { listener(state) } catch (e) { this.log(`door: ouvinte de estado falhou: ${e instanceof Error ? e.message : String(e)}`) }
    }
  }

  /** The pipe's `read-screen`: the same read the extensions get, for the CLI and for tests. */
  readonly handleReadScreen: DoorRequestHandler = (req): DoorReplyBody => {
    const slotId = req.slotId
    if (typeof slotId !== 'string' || !slotId) throw new DoorError('bad-request', 'read-screen precisa de slotId')
    const since = req.since
    if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) throw new DoorError('bad-request', 'read-screen: since deve ser um número não negativo')
    return { screen: this.need('slots.readScreen').readScreen(slotId, since) }
  }

  /** The slots part of extension `ext`'s API; its `onState` listeners land in `own`. */
  apiFor(ext: string, own: DisposableStore): DoorSlots {
    const live = (what: string): SlotPort => this.need(`${what}, extensão ${ext}`)
    const act = <T>(what: string, run: (port: SlotPort) => T | Promise<T>): Promise<T> => {
      try { return Promise.resolve(run(live(what))) } catch (e) { return Promise.reject(e) }
    }
    return {
      create: (input) => act('slots.create', (port) => port.create(createInput(ext, input, this.desks()))),
      write: (slotId, data) => act('slots.write', (port) => port.write(slotId, data, 'agent')),
      keys: (slotId, keys, opts) => act('slots.keys', (port) => typeKeys(port, slotId, keys, opts?.gapMs ?? 0)).then(() => undefined),
      readScreen: (slotId, opts) => live('slots.readScreen').readScreen(slotId, opts?.since),
      start: (slotId, choice) => act('slots.start', (port) => port.start(slotId, choice)),
      stop: (slotId) => act('slots.stop', (port) => port.stop(slotId)),
      restart: (slotId) => act('slots.restart', (port) => port.restart(slotId)),
      forget: (slotId) => act('slots.forget', (port) => port.forget(slotId)),
      rename: (slotId, name) => act('slots.rename', (port) => port.rename(slotId, name)),
      get: (slotId) => this.port()?.stateOf(slotId),
      list: () => this.port()?.list() ?? [],
      onState: (listener) => {
        this.listeners.add(listener)
        return own.add(toDisposable(() => { this.listeners.delete(listener) }))
      },
      setHeld: (slotId, held) => act('slots.setHeld', async (port) => { await setHeld(port, slotId, held); this.typedTold.delete(slotId) }),
      onUserTyped: (listener) => {
        this.typedListeners.add(listener)
        return own.add(toDisposable(() => { this.typedListeners.delete(listener) }))
      },
      userFree: (slotId) => this.presence()?.isFree(slotId) ?? true,
    }
  }

  private need(what: string): SlotPort {
    const port = this.port()
    if (!port) throw doorUnavailable(what)
    return port
  }
}

/** The door's meta (who created it, the desk asked for) rides with the create, so it is on disk before the reply and any launch. */
function createInput(ext: string, input: SlotCreate, desks: PaneRequester | undefined): Parameters<SlotPort['create']>[0] {
  const meta: NonNullable<Parameters<SlotPort['create']>[0]['meta']> = {
    createdBy: { ext, ...(input.onBehalfOf ? { slotId: input.onBehalfOf } : {}) },
    ...(input.desk ? { paneRequest: desks ? desks.paneRequestFor(input.desk) : { deskId: input.desk } } : {}),
  }
  return {
    kind: input.kind,
    cwd: input.cwd,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.args ? { args: input.args } : {}),
    // The contract's default is to start; the pipe's `create` starts only when asked.
    start: input.start ?? true,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    meta,
  }
}

async function typeKeys(port: SlotPort, slotId: string, keys: readonly KeyName[], gapMs: number): Promise<void> {
  // Translate first: a typo in the last key must not leave the first ones typed.
  const bytes = keys.map((k) => keyBytes(k))
  for (let i = 0; i < bytes.length; i++) {
    port.write(slotId, bytes[i]!, 'agent')
    if (gapMs > 0 && i < bytes.length - 1) await sleep(gapMs)
  }
}

async function setHeld(port: SlotPort, slotId: string, held: SlotHold | undefined): Promise<void> {
  const meta: SlotMeta | undefined = port.meta(slotId)
  if (!meta) throw new DoorError('unknown-slot', `slot desconhecido: ${slotId}`)
  if (held) meta.held = { ext: held.ext, by: held.by }
  else delete meta.held
  await port.saveMeta(slotId)
  port.broadcastState(slotId)
}
