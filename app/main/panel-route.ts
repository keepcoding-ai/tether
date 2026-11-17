// Routes the window's terminal traffic in the main process between tetherd and the panel host (tether-ptyd). A pane
// that runs in the host (SlotState.ptyHost) has its output, scrollback and keystrokes go straight through the PanelLink;
// tetherd (connected as a `direct` client) keeps the slot's state, hears the keystrokes as `typed` for the attention, and
// remembers cols/rows for the next launch. Every other pane goes through tetherd as before. Pure: no Electron, no sockets.
import type { Reply, SlotState } from '../../src/daemon/protocol.ts'
import type { RequestBody } from '../shared/api.ts'

/** What the router needs from the PanelLink. */
export interface RouteLink {
  readonly connected: boolean
  has(slotId: string): boolean
  attach(slotId: string, from?: number, epoch?: string): Promise<{ scrollback: string }>
  detach(slotId: string): Promise<void>
  write(slotId: string, data: string): boolean
  resize(slotId: string, cols: number, rows: number): void
}

/** What the router needs from the tetherd connection (DaemonClient satisfies it). */
export interface RouteDaemon {
  typed(slotId: string, data: string): void
}

export interface PanelRouterOptions {
  link: RouteLink
  daemon: () => RouteDaemon | undefined
  /** A request to tetherd (errors already turned into an error reply). */
  request: (body: RequestBody) => Promise<Reply>
  /** Output for the window, exactly like tetherd's `data` event. */
  emit: (slotId: string, data: string) => void
  log: (msg: string) => void
  /** Runs `fn` after `ms`; returns the canceller. Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** How long a hosted pane that exited stays attached, so output the host sent just before the exit still lands. */
  exitGraceMs?: number
}

/** Where a keystroke went: the host, nowhere (hosted pane with the link down), or tetherd (the caller sends it). */
export type InputRoute = 'link' | 'dropped' | 'daemon'

/** ESC c (RIS): xterm resets the terminal, screen and scrollback, before the host's whole ring is painted again. */
export const TERMINAL_RESET = '\x1bc'

export const EXIT_GRACE_MS = 1_500

const LIVE: ReadonlySet<SlotState['status']> = new Set(['running', 'starting'])

export class PanelRouter {
  private readonly o: PanelRouterOptions
  /** Slots the window attached (and has not detached). */
  private readonly viewed = new Set<string>()
  /** Hosted slots with a live process: slotId -> pid of the run. */
  private readonly hosted = new Map<string, number>()
  /** Slots attached in the link: slotId -> pid of the run attached. */
  private readonly runs = new Map<string, number>()
  /** Output that arrives while the link attach of a slot is being handed over: it goes after the scrollback. */
  private readonly holding = new Map<string, string[]>()
  /** Link attaches started by the router itself (a launch seen with the window attached, the link back up). */
  private readonly following = new Map<string, Promise<void>>()
  /** Attach requests of the window in flight: the router does not follow these slots meanwhile. */
  private readonly windowAttaching = new Set<string>()
  private readonly exitTimers = new Map<string, () => void>()
  private dropLogged = false

  constructor(opts: PanelRouterOptions) {
    this.o = opts
  }

  // ---- window -> router ----------------------------------------------------------------------

  /** A keystroke of the window. 'daemon': the caller sends it to tetherd (with its probe, when any). */
  input(slotId: string, data: string): InputRoute {
    if (this.o.link.has(slotId)) {
      if (!this.o.link.write(slotId, data)) { this.noteDrop(slotId); return 'dropped' }
      this.dropLogged = false
      this.o.daemon()?.typed(slotId, data)
      return 'link'
    }
    if (this.viewed.has(slotId) && this.hosted.has(slotId)) { this.noteDrop(slotId); return 'dropped' }
    return 'daemon'
  }

  /** A request of the window: attach, detach and resize also touch the link; everything else goes to tetherd as is. */
  async request(body: RequestBody): Promise<Reply> {
    switch (body.t) {
      case 'attach': return this.attach(body)
      case 'detach':
        this.viewed.delete(body.slotId)
        this.unlink(body.slotId)
        return this.o.request(body)
      case 'resize':
        // tetherd keeps cols/rows for the next launch; the host resizes the live pane.
        if (this.o.link.has(body.slotId)) this.o.link.resize(body.slotId, body.cols, body.rows)
        return this.o.request(body)
      default:
        return this.o.request(body)
    }
  }

  private async attach(body: Extract<RequestBody, { t: 'attach' }>): Promise<Reply> {
    const id = body.slotId
    this.viewed.add(id)
    this.windowAttaching.add(id)
    try {
      await this.following.get(id)
      const reply = await this.o.request(body)
      if (reply.t !== 'ok') return reply
      if (reply.slot) this.noteState(reply.slot)
      // A direct client gets no scrollback of a live hosted pane: it reads the pane from the host.
      const slot = reply.slot
      if (!slot?.ptyHost || slot.pid === undefined || reply.scrollback !== undefined) {
        this.unlink(id)
        return reply
      }
      const scrollback = await this.linkAttach(id, slot.pid)
      return { ...reply, scrollback: scrollback ?? '' }
    } finally {
      this.windowAttaching.delete(id)
    }
  }

  // ---- tetherd -> router ---------------------------------------------------------------------

  /** A slot state (event, list or attach reply): a launch in the host with the window attached is followed in the link. */
  onState(slot: SlotState): void {
    const id = slot.slotId
    const live = this.noteState(slot)
    if (!this.viewed.has(id)) return
    if (live) {
      this.cancelExit(id)
      if (this.runs.get(id) !== slot.pid && !this.windowAttaching.has(id) && !this.following.has(id)) this.follow(id, slot.pid!)
      return
    }
    if (!this.runs.has(id)) return
    if (!slot.ptyHost) { this.unlink(id); return }
    this.scheduleExit(id)
  }

  onRemoved(slotId: string): void {
    this.viewed.delete(slotId)
    this.hosted.delete(slotId)
    this.unlink(slotId)
  }

  /** The tetherd connection was lost, or the page reloads: the window attaches again from scratch. */
  reset(): void {
    for (const id of [...this.runs.keys()]) this.unlink(id)
    this.viewed.clear()
    this.hosted.clear()
    this.holding.clear()
  }

  // ---- link -> router ------------------------------------------------------------------------

  onLinkData(slotId: string, data: string): void {
    const held = this.holding.get(slotId)
    if (held) held.push(data)
    else this.o.emit(slotId, data)
  }

  /** The host answered a re-attach with its whole ring: the window's terminal is reset and painted again. */
  onLinkReset(slotId: string, scrollback: string): void {
    this.onLinkData(slotId, TERMINAL_RESET + scrollback)
  }

  onLinkState(connected: boolean): void {
    if (!connected) {
      this.o.log('panel host link down: keystrokes of hosted panes are dropped until it comes back (the link retries by itself)')
      return
    }
    this.o.log('panel host link up')
    this.dropLogged = false
    // Slots already in the link resync by themselves; a hosted slot that never got in is attached now.
    for (const [id, pid] of this.hosted) {
      if (this.viewed.has(id) && !this.o.link.has(id) && !this.windowAttaching.has(id) && !this.following.has(id)) this.follow(id, pid)
    }
  }

  // ---- internals -----------------------------------------------------------------------------

  /** Records whether the slot is a live hosted pane; true when it is. */
  private noteState(slot: SlotState): boolean {
    const live = !!slot.ptyHost && slot.pid !== undefined && LIVE.has(slot.status)
    if (live) this.hosted.set(slot.slotId, slot.pid!)
    else this.hosted.delete(slot.slotId)
    return live
  }

  /** Attaches in the link; the scrollback plus whatever output arrived meanwhile, or undefined when the link failed. */
  private async linkAttach(id: string, pid: number, from?: number): Promise<string | undefined> {
    if (!this.o.link.connected) {
      this.runs.delete(id)
      this.o.log(`panel host link down: ${id} will attach when it comes back`)
      return undefined
    }
    const held: string[] = []
    this.holding.set(id, held)
    try {
      const r = await this.o.link.attach(id, from)
      this.runs.set(id, pid)
      this.cancelExit(id)
      return r.scrollback + held.join('')
    } catch (e) {
      this.runs.delete(id)
      this.o.log(`panel host attach of ${id} failed: ${(e as Error).message}`)
      return undefined
    } finally {
      if (this.holding.get(id) === held) this.holding.delete(id)
    }
  }

  /** A new run of a slot the window shows: its whole output from the host, as output. */
  private follow(id: string, pid: number): void {
    const p = (async () => {
      const text = await this.linkAttach(id, pid, 0)
      if (text) this.o.emit(id, text)
    })().finally(() => { if (this.following.get(id) === p) this.following.delete(id) })
    this.following.set(id, p)
  }

  private unlink(id: string): void {
    this.cancelExit(id)
    this.runs.delete(id)
    if (this.o.link.has(id)) void this.o.link.detach(id)
  }

  private scheduleExit(id: string): void {
    if (this.exitTimers.has(id)) return
    const schedule = this.o.schedule ?? ((fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) })
    const cancel = schedule(() => {
      this.exitTimers.delete(id)
      if (!this.hosted.has(id)) this.unlink(id)
    }, this.o.exitGraceMs ?? EXIT_GRACE_MS)
    this.exitTimers.set(id, cancel)
  }

  private cancelExit(id: string): void {
    const cancel = this.exitTimers.get(id)
    if (!cancel) return
    this.exitTimers.delete(id)
    cancel()
  }

  private noteDrop(slotId: string): void {
    if (this.dropLogged) return
    this.dropLogged = true
    this.o.log(`panel host unreachable: keystrokes of hosted pane ${slotId} dropped (tetherd has no output relay for this window)`)
  }
}
