// The agent door (porta do agente): the core services the daemon extensions consume to drive slots, ask for panes, expose
// verbs, deliver messages, reroute attention and keep per-object data. Types only; the live services sit behind
// DoorHost (host.ts), which in a satellite (CLI, Electron main) and before a slice turns a service on rejects every act
// with `door-unavailable` while registrations still work.
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { DeskMap, DeskMapDesk, ObjectKind, ScreenRead, SlotHold, SlotKind, SlotState } from '../protocol.ts'

export type { DeskMap, DeskMapDesk, ObjectKind, ScreenRead, SlotHold }

// ---- 1. slots --------------------------------------------------------------------------------

export interface SlotCreate {
  /** 'claude' | 'soul' | 'codex' | 'shell' | an extension's agent. */
  kind: SlotKind
  cwd: string
  profileId?: string
  args?: string[]
  name?: string
  /** The desk (layout desk id) the pane should be born in. Becomes SlotMeta.paneRequest. Absent: a session with no pane, as today. */
  desk?: string
  /**
   * Default true. The process starts at once even when `desk` is a hibernated desk: only the pane sleeps there (the owner
   * needs the work running). No start is ever deferred to the desk's wake.
   */
  start?: boolean
  /** Who asked, for the trace: the agent slot the extension acts for. Goes to SlotMeta.createdBy. */
  onBehalfOf?: string
}

/** Named keys; the core maps them to bytes (pure table in door/keys.ts). Anything else goes through `write`. */
export type KeyName =
  | 'enter' | 'esc' | 'tab' | 'shift+tab' | 'backspace' | 'up' | 'down' | 'left' | 'right'
  | 'ctrl+c' | 'ctrl+d' | 'ctrl+u' | 'ctrl+e' | 'paste-start' | 'paste-end'

export interface DoorSlots {
  create(input: SlotCreate): Promise<SlotState>
  /** Raw bytes into the PTY. Rejects `door-no-pty` when the slot has no live process and none is coming. Counts as AGENT typing. */
  write(slotId: string, data: string, opts?: { answer?: boolean }): Promise<void>
  /** Named keys, in order, `gapMs` apart (default 0). `answer: true` declares them the answer to a permission card (activity, never a draft). */
  keys(slotId: string, keys: readonly KeyName[], opts?: { gapMs?: number; answer?: boolean }): Promise<void>
  /** Reads the screen without attaching and without resizing. `since`: an offset a previous read returned. */
  readScreen(slotId: string, opts?: { since?: number }): ScreenRead
  start(slotId: string, choice?: 'resume' | 'new'): Promise<SlotState>
  stop(slotId: string): Promise<SlotState>
  restart(slotId: string): Promise<SlotState>
  /** Stops and removes the slot and its pane (today's `forget`). */
  forget(slotId: string): Promise<void>
  rename(slotId: string, name: string): Promise<SlotState>
  get(slotId: string): SlotState | undefined
  list(): SlotState[]
  /** Every change of a slot's state (the same SlotState the clients get): turn, attention, status. */
  onState(listener: (slot: SlotState) => void): IDisposable
  /** The pane is in an agent's hands; `undefined` gives it back to the user. Persisted in the slot's meta. */
  setHeld(slotId: string, held: SlotHold | undefined): Promise<void>
  /**
   * The person's first typing into a held pane, once per held period: a terminal answer (a chunk that starts with ESC) or
   * the agent's own writes do not count, a pane with no `held` never fires, and each `setHeld` arms it again.
   */
  onUserTyped(listener: (slotId: string) => void): IDisposable
  /**
   * No draft of the person's in the input box and USER_QUIET_MS of the person's silence (the delivery's interlock, read as
   * it is now, for the person alone: an agent's writes through the door do not count here, though the delivery waits for them).
   */
  userFree(slotId: string): boolean
  /** When (ms epoch) the person last typed into the slot; undefined when she never did. The agent's own keys do not count. */
  userTypedAt(slotId: string): number | undefined
  /** When (ms epoch) the slot's screen last received output bytes, always tracked; 0 if it never painted, undefined if the slot does not exist. */
  paintedAt(slotId: string): number | undefined
  /**
   * Before an act on the slot: when the app suspended its pane (an idle agent stopped to save resources), it is resumed and
   * this resolves once the agent is up ('running'), or the start settles without it, or a long timeout passes; then with the
   * slot's state. A slot that is not suspended resolves at once (a starting one once it runs). `why` goes to the log.
   */
  awake(slotId: string, why: string): Promise<SlotState | undefined>
}

// ---- 2. desks --------------------------------------------------------------------------------

export interface DoorDesks {
  /** The last map the app sent (from disk when the app is closed). `undefined` before the first one. */
  map(): DeskMap | undefined
  deskOf(paneId: string): DeskMapDesk | undefined
  onDidChange(listener: (map: DeskMap) => void): IDisposable
  /** Asks for a terminal pane for an existing slot (`create` with `desk` does this itself). */
  requestPane(slotId: string, deskId: string): Promise<void>
  /** Resolves once <home>/desks.json was read (at once in a satellite); `map()` before it may be undefined. */
  readonly ready: Promise<void>
}

// ---- 3. verbs --------------------------------------------------------------------------------

export interface VerbCaller {
  /** The caller's slot. */
  slotId: string
  state: SlotState
  /** The way the call came in. */
  via: 'mcp' | 'cli'
  /** Identity proven by the slot's key (TETHER_SLOT_KEY). Always true over 'mcp'. */
  proven: boolean
}

export interface VerbResult {
  /** The text the agent reads (tool) or the CLI prints. */
  text: string
  /** Structured, for `--json` on the CLI and `structuredContent` on the tool. */
  data?: unknown
  isError?: boolean
}

export interface VerbContribution<A = Record<string, unknown>> {
  /** The extension's namespace, lowercase: 'agents', 'channel'. One per extension, unique across extensions. */
  ns: string
  /** 'send', 'list', 'read-screen'. */
  name: string
  /** For the agent (English, like the Browser's tools). */
  description: string
  /** For `tether help` (Portuguese). */
  help: string
  /** JSON Schema of `args` (an object): the tool's inputSchema and the source of the CLI's flags. */
  input: Record<string, unknown>
  /** On the CLI, which properties are positional, in order: `tether agents send <slot> <text>`. */
  positional?: readonly string[]
  /** Where it shows. Default: both. */
  exits?: readonly ('mcp' | 'cli')[]
  run(caller: VerbCaller, args: A): Promise<VerbResult> | VerbResult
}

export interface DoorVerbs {
  register(verb: VerbContribution): IDisposable
  /** A paragraph for the `instructions` of the `tether` MCP server, under the extension's header. */
  instructions(text: string): IDisposable
}

/** The MCP server the core serves per slot for the door, and the env var that carries its bearer key. */
export const DOOR_MCP_SERVER = 'tether'
export const ENV_DOOR_MCP_KEY = 'TETHER_MCP_KEY'
/** The per-launch key that proves a CLI call inherited the slot's environment. */
export const ENV_SLOT_KEY = 'TETHER_SLOT_KEY'

// ---- 4. delivery -----------------------------------------------------------------------------

export type DeliveryKind = 'message' | 'request' | 'notice'
export type DeliveryRole = 'user' | 'moderator' | 'owner' | 'member' | 'system'

export interface DeliveryMessage {
  kind: DeliveryKind
  /** The room (channel), when there is one. Short name, no spaces. */
  room?: string
  /** Who spoke: the shown name and the stable id (an agent's slotId, or 'user'). */
  from: { name: string; id: string; role: DeliveryRole }
  body: string
  /** To answer an earlier message. */
  inReplyTo?: string
  /** The names the message is addressed to (an address, not a secret: everyone in the room still hears it). */
  to?: readonly string[]
  /** The message's own id in its room, the same for every addressee (unlike the delivery id, one per addressee). */
  ref?: string
  /**
   * Reactions to the addressee's own lines that ride on this delivery (`38 ❓ soul · bancada; 36 ✅ Guga`), written by the
   * extension, never by who wrote the body: the `reactions` attribute inside, a part of the header when typed.
   */
  reactions?: string
  /**
   * A poll, written by the extension from its record, never by who wrote the body. On a `request` (the poll asked of the
   * addressee): `poll` is its type, `options` the numbered options, `closes` the deadline. On the result `notice` (to its
   * author): `poll` is the poll's ref, `closedBy` why it closed, `tally` the counts. Inside, the attributes `poll`, `options`,
   * `closes`, `closed_by`, `tally`; typed, parts of the header.
   */
  poll?: DeliveryPoll
}

export interface DeliveryPoll {
  poll: string
  options?: string
  closes?: string
  closedBy?: string
  tally?: string
}

export type DeliveryState =
  | 'inside'   // delivered inside (the engine's channel)
  | 'typed'    // typed into the terminal
  | 'queued'   // waiting
  | 'dropped'  // the slot was forgotten before delivery

export interface DeliveryReceipt {
  id: string
  slotId: string
  state: DeliveryState
  at: string
  /**
   * `typed` only: the text was typed and not submitted (the person typed in between, or the engine's typist saw the Enter not
   * taken); the text stays in the box.
   */
  unsent?: true
}

/** One write of a typist: `waitMs` waits BEFORE the data (the Enter's delay is on the Enter's chunk). */
export interface TypistChunk { data: string; waitMs?: number }

/** What the terminal path hands a typist for one delivery. */
export interface TypistContext {
  readonly slotId: string
  /**
   * The only write a typist has, through the delivery's interlocks. Before the first byte of the delivery the terminal path's
   * conditions are checked again (held, alive, running, idle, not `waiting`, the user free, settled); before every chunk after
   * it, the pane still held, the process alive and the user silent since the first byte. A failed check writes nothing more
   * of this delivery, ever: it resolves `false` and every later call resolves `false` at once. `true`: all chunks written.
   */
  write(chunks: readonly TypistChunk[]): Promise<boolean>
  log(msg: string): void
}

/**
 * How one engine types and submits a delivery's text in its terminal (contract N5), in place of its `typing`: a typist may
 * look at the screen and press Enter again until the engine took the text. `'unsent'`: the text may sit in the box, not
 * submitted (the receipt says `unsent`). A typist that wrote nothing leaves the item queued, whatever it answers or throws.
 */
export interface Typist {
  type(ctx: TypistContext, text: string): Promise<'sent' | 'unsent'>
}

export interface DoorDelivery {
  /** Turns delivery on for this extension: from then on the `tether` server is offered to agents even with no tool. */
  enable(): IDisposable
  /**
   * The typist of an engine (`SlotMeta.agent`: 'codex', 'soul'...) for the terminal path. One per engine: a later one replaces
   * it, and disposing removes only the one in place. None: the engine's `typing` (as before this seam).
   */
  useTypist(agent: string, typist: Typist): IDisposable
  /**
   * Never rejects for lack of a path: answers 'queued' and delivers when it can. `until` (ISO): a queued delivery still waiting
   * at that time is `dropped` instead of delivered late (a restart keeps it, on disk).
   */
  deliver(slotId: string, msg: DeliveryMessage, opts?: { paths?: readonly ('inside' | 'terminal')[]; until?: string }): Promise<DeliveryReceipt>
  /** What waits for a slot (this extension's). */
  pending(slotId: string): DeliveryReceipt[]
  /** Takes out of the queue what still waits. */
  cancel(id: string): boolean
  onDidDeliver(listener: (r: DeliveryReceipt) => void): IDisposable
  /** How a slot receives now. */
  pathOf(slotId: string): 'inside' | 'terminal' | 'wait'
  /** The route a slot has, ignoring the interlock (busy, draft, settle): `pathOf` is the instant, `routeOf` is the road. */
  routeOf(slotId: string): 'inside' | 'terminal' | 'wait'
  /**
   * The slot's client has the tether's MCP tools: its MCP stream is open now or opened once in this daemon's life (sticky; a
   * client that has the tools but does not wake on a channel message, like Codex, counts). False means "not known", not "none":
   * a client that never opened its stream, or one the daemon has not seen since it started.
   */
  hasTools(slotId: string): boolean
  /**
   * Pure: the delivery leaves the slot's input box alone now. True only when no extension's item waits for the slot, none is
   * being typed, the last terminal delivery settled (DOOR_SETTLE_MS), and no `unsent` text of the tether's sits in the box
   * (cleared when the turn goes busy or the person types there). Another typist of the tether waits for it.
   */
  quiet(slotId: string): boolean
  /**
   * Reserves the slot's turn window for a typist of this extension (a command it will type itself): while the claim holds,
   * no delivery STARTS on the slot by any path (inside or terminal, busy turn or not; the queue keeps its order), and the
   * slot counts as claimed for the ronda (`DoorSeams.claimed`). A delivery already past its first byte finishes. The queue
   * stops counting against `quiet` (the claimer is the one that may type); typing, settle and unsent text still count.
   * `release(true)`: the claimer typed, so the slot settles (DOOR_SETTLE_MS) before anything else starts; `release(false)`:
   * nothing was typed. Idempotent; disposing the extension releases (false) what it still holds.
   */
  claim(slotId: string, why: string): DeliveryClaim
}

/** A reservation of a slot's window (DoorDelivery.claim). */
export interface DeliveryClaim {
  release(typed: boolean): void
}

// ---- 5. rerouted attention -------------------------------------------------------------------

export interface DoorAttention {
  /** `slotId`'s attention goes to `to` (another slot), not to the person. One route per slot; calling again replaces. Persisted in the meta. */
  route(slotId: string, to: string): Promise<void>
  unroute(slotId: string): Promise<void>
  routeOf(slotId: string): string | undefined
  /** The recipient saw it: clears the rerouted attention (the owner's `seen`). */
  seen(slotId: string): void
  /**
   * A conductor tells the core what the engine did not: `waiting` (a permission card on the screen) or `done` (the turn
   * ended, e.g. after an interrupt). The same core path as the engines' own reports; a route, if any, applies as usual.
   */
  signal(slotId: string, kind: 'waiting' | 'done'): void
}

// ---- 7. per-object data ----------------------------------------------------------------------

/** On the daemon: TetherDaemon.objects. Each extension sees only its own space. */
export interface DoorObjects {
  /** Resolves once <home>/objects was read (at once in a satellite); `get`/`entries` before it may answer empty. */
  readonly ready: Promise<void>
  get<T>(kind: ObjectKind, id: string, key: string): T | undefined
  /** `undefined` deletes the key. Any JSON. Written to <home>/objects/<ext>.json (temp + rename). */
  set(kind: ObjectKind, id: string, key: string, value: unknown): Promise<void>
  /** Every object of a kind that has the key: [id, value]. */
  entries<T>(kind: ObjectKind, key: string): [string, T][]
  onDidChange(listener: (e: { kind: ObjectKind; id: string; key: string; value: unknown }) => void): IDisposable
  /** An object ceased to exist (the pane was forgotten, the desk closed): its data was deleted. */
  onDidDrop(listener: (e: { kind: ObjectKind; id: string; data: Record<string, unknown> }) => void): IDisposable
}

// ---- 8. extension requests and events (the pipe between an extension's two halves) -----------

/** Who asked, as the handler sees it: the asking client's kind from its hello ('app' | 'cli' | 'test'). */
export interface ExtRequestContext {
  client: string | undefined
}

/** The answer of `ext-request`: any JSON (it goes back as the reply's `result`); `undefined` sends no `result`. */
export type ExtRequestHandler<A = unknown> = (args: A, ctx: ExtRequestContext) => unknown | Promise<unknown>

export interface DoorRequests {
  /**
   * Answers the pipe's `{ t: 'ext-request', ext, name, args }` for this extension (`ext` is set by the core: one extension
   * never answers for another). One handler per name per extension: a repeated name throws. A handler that throws becomes
   * the request's error (a DoorError keeps its code, anything else is `bad-request`); the daemon carries on.
   */
  handle<A = unknown>(name: string, handler: ExtRequestHandler<A>): IDisposable
}

export interface DoorEvents {
  /**
   * Sends `{ t: 'ext-event', ext, name, payload }` to every client of the pipe, `ext` set by the core. Fire-and-forget: a
   * no-op in a satellite and after the extension was disposed. `payload`: any JSON.
   */
  emit(name: string, payload?: unknown): void
}

/** What one daemon extension gets of the door (spread into TetherDaemon). */
export interface DoorApi {
  slots: DoorSlots
  desks: DoorDesks
  verbs: DoorVerbs
  delivery: DoorDelivery
  attention: DoorAttention
  objects: DoorObjects
  requests: DoorRequests
  events: DoorEvents
}
