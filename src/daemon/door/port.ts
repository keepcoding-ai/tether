// The seam between tetherd's server (server.ts) and the agent door (door/*). The server hands the door a SlotPort (the slot
// operations it owns, the same methods the pipe's requests run) and calls the door's hooks (DoorSeams) at fixed points.
// Door code never reaches into server.ts beyond these two interfaces.
import type { AgentContribution } from '../../agents/registry.ts'
import type { LaunchPlan } from '../../agents/types.ts'
import type { SlotMeta } from '../../core/event.ts'
import type { RondaChannelAgent } from '../ronda-channel.ts'
import type { ErrorCode, Event, Reply, ScreenRead, SlotKind, SlotState } from '../protocol.ts'

/** A refusal from door code; the server answers it with its own code (an unknown error is `bad-request`). */
export class DoorError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'DoorError'
    this.code = code
  }
}

/** The refusal of every act of a door service that is not live (a satellite, or a slice not built yet). */
export function doorUnavailable(what: string): DoorError {
  return new DoorError('door-unavailable', `a porta do agente não está disponível neste processo (${what})`)
}

/** Who typed: the person through the pipe (`input`/`typed`), or an agent through the door (slots.write/keys, delivery). */
export type InputOrigin = 'user' | 'agent'

/** What the writer declares about its input: `answer` = the answer to a permission card (`agents answer`), not text for the box. */
export interface InputMark { answer?: boolean }

/** The `create` the pipe runs, plus the door's meta fields, written before the reply (and before any launch). */
export interface SlotCreateInput {
  kind: SlotKind
  cwd: string
  name?: string
  args?: string[]
  start?: boolean
  profileId?: string
  meta?: Pick<SlotMeta, 'createdBy' | 'paneRequest' | 'held' | 'attentionTo'>
}

/** The server's slot operations, as the door uses them. Unknown ids throw `unknown-slot`, like the pipe. */
export interface SlotPort {
  /** The daemon's home: where door services keep their own files. */
  readonly home: string
  create(input: SlotCreateInput): Promise<SlotState>
  start(slotId: string, choice?: 'resume' | 'new'): Promise<SlotState>
  stop(slotId: string): Promise<SlotState>
  restart(slotId: string): Promise<SlotState>
  forget(slotId: string): Promise<void>
  rename(slotId: string, name: string): Promise<SlotState>
  /** Bytes into the PTY (held while a launch brings it) and into the slot's attention. Throws `door-no-pty` when no process is or will be there. */
  write(slotId: string, data: string, origin: InputOrigin, mark?: InputMark): void
  /** The ring and the PTY size, without attaching or resizing. */
  readScreen(slotId: string, since?: number): ScreenRead
  stateOf(slotId: string): SlotState | undefined
  /** When (ms epoch) the slot's screen last received output bytes; 0 if it never painted, undefined if the slot does not exist. */
  paintedAt(slotId: string): number | undefined
  list(): SlotState[]
  /** Spawned and not exited. */
  isAlive(slotId: string): boolean
  /** The slot's live meta (mutate it, then `saveMeta`); undefined for an unknown slot. */
  meta(slotId: string): SlotMeta | undefined
  /** Writes the slot's meta as it is in memory and waits until it is on disk. */
  saveMeta(slotId: string): Promise<void>
  /** The slot's attention was seen: clears the core's `done`/`waiting` (what the pipe's `seen` does) and sends the state. */
  seen(slotId: string): void
  /** A conductor's `waiting`/`done` for the slot: the core attention takes it as an engine report would, and the state is sent. */
  signal(slotId: string, kind: 'waiting' | 'done'): void
  /** Sends the slot's state to every client (and to the `stateChanged` hook). */
  broadcastState(slotId: string): void
  /** An event to every client (the door's `desks` and `object`). */
  broadcast(event: Event): void
}

/** What a door request handler sees of the client that asked. */
export interface DoorRequestContext {
  /** From the hello: 'app' | 'cli' | 'test'. */
  client: string | undefined
}

/** The `ok` reply's fields, without `t` and `id` (the server adds them). */
export type DoorReplyBody = Omit<Extract<Reply, { t: 'ok' }>, 't' | 'id'>
export type DoorRequestHandler = (req: { t: string; id: number } & Record<string, unknown>, ctx: DoorRequestContext) => DoorReplyBody | Promise<DoorReplyBody>

/** A launch's grant of the door: the plan to spawn, and how to take back what was granted if the launch is cancelled. */
export interface LaunchGrant {
  plan: LaunchPlan
  /** The door's `tether` channel went into the plan (its start dialog may show: the daemon watches to confirm it). */
  channel?: boolean
  revoke(): void
}

/** The launch as the door hook sees it, after the ronda's offer. */
export interface LaunchContext {
  meta: SlotMeta
  /** The agent's contribution; undefined for a shell or an unregistered agent. */
  agent: AgentContribution | undefined
  /** How the ronda's channel was offered to this agent (the daemon's `channelOf`, which tests override); undefined when it takes none. */
  channel: RondaChannelAgent | undefined
  /** The ronda's channel went into this plan. */
  rondaOffered: boolean
}

/** The hooks the server calls. Every one of them is a no-op (or the identity) while no door service is on. */
export interface DoorSeams {
  /** Gets the server's port once, at construction. */
  attach(port: SlotPort): void
  /** `default` of the server's request switch: a handler for request types the core does not know. */
  requestHandler(t: string): DoorRequestHandler | undefined
  /** The end of `stateOf`: may edit the state being built (e.g. reroute `attention` into `attentionFor`). */
  decorate(meta: SlotMeta, state: SlotState): void
  /** A slot's state went to the clients. */
  stateChanged(state: SlotState): void
  /** Keystrokes reached the slot, with who typed them. */
  input(slotId: string, data: string, origin: InputOrigin, mark?: InputMark): void
  /** After the ronda's offer in `launch`: the door may add to the plan. A promise is awaited; a plain value is not. */
  prepareLaunch(plan: LaunchPlan, ctx: LaunchContext): LaunchGrant | Promise<LaunchGrant>
  /** The slot's process ended (`paneExit`). */
  exited(slotId: string): void
  /** The slot was forgotten (`forget`), before its files go; a promise is awaited before the reply. */
  forgotten(slotId: string): void | Promise<void>
  /** Resumes the slot when the app suspended its pane (door/suspend.ts); false when it is not suspended. */
  resumeSuspended?(slotId: string, why: string): boolean
  /** The pipe's `create` with a `desk` (id or name): the `paneRequest` to write, or a `DoorError` when the desk is unknown or asleep. Absent: the desk is taken as asked. */
  deskRequest?(ref: string): { deskId: string }
  /** A typist of an extension reserved the slot's window (DoorDelivery.claim), or it is settling after one: the ronda waits. */
  claimed?(slotId: string): boolean
}
