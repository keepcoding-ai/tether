// Extension requests and events (N1, daemon half): the pipe's `ext-request` reaches the handler the extension registered
// under that name, and `events.emit` goes to every client as `ext-event`. The core sets `ext` (an extension's API only
// ever acts under its own id), so two extensions may use the same name. Registering always works, satellites included:
// only tetherd gets requests from a pipe, and only tetherd has clients to emit to.
import { toDisposable, type DisposableStore, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { DoorError, type DoorReplyBody, type DoorRequestContext, type SlotPort } from './port.ts'
import type { DoorEvents, DoorRequests, ExtRequestHandler } from './types.ts'

export class ExtRequestService {
  /** ext → name → handler. Grows with what the extensions register, not with clients or calls. */
  private readonly handlers = new Map<string, Map<string, ExtRequestHandler>>()
  /** The server's port: undefined in a satellite, where emitting does nothing. */
  private readonly port: () => SlotPort | undefined

  constructor(port: () => SlotPort | undefined) {
    this.port = port
  }

  register(ext: string, name: string, handler: ExtRequestHandler): IDisposable {
    if (typeof name !== 'string' || !name) throw new Error(`pedido de extensão sem nome (${ext})`)
    let byName = this.handlers.get(ext)
    if (!byName) { byName = new Map(); this.handlers.set(ext, byName) }
    if (byName.has(name)) throw new Error(`o pedido ${name} da extensão ${ext} já tem quem responda`)
    byName.set(name, handler)
    return toDisposable(() => {
      const now = this.handlers.get(ext)
      if (now?.get(name) !== handler) return
      now.delete(name)
      if (now.size === 0) this.handlers.delete(ext)
    })
  }

  /** The `ext-request` of the door's request registry. */
  readonly handleRequest = async (req: { t: string; id: number } & Record<string, unknown>, ctx: DoorRequestContext): Promise<DoorReplyBody> => {
    const { ext, name } = req
    if (typeof ext !== 'string' || !ext || typeof name !== 'string' || !name) throw new DoorError('bad-request', 'ext-request pede ext e name')
    const handler = this.handlers.get(ext)?.get(name)
    if (!handler) throw new DoorError('unknown-request', `a extensão ${ext} não responde ao pedido ${name}`)
    const result = await handler(req.args, ctx.conn === undefined ? { client: ctx.client } : { client: ctx.client, conn: ctx.conn })
    if (result === undefined) return {}
    // The reply is encoded after the request settles, outside any catch: what cannot become JSON must fail here, as the
    // request's error, not as a throw in the daemon's loop.
    try { JSON.stringify(result) } catch (e) { throw new DoorError('bad-request', `o pedido ${name} da extensão ${ext} respondeu algo que não é JSON: ${(e as Error).message}`) }
    return { result }
  }

  /** The `requests` part of extension `ext`'s DoorApi; its registrations land in `own`. */
  requestsFor(ext: string, own: DisposableStore): DoorRequests {
    return { handle: (name, handler) => own.add(this.register(ext, name, handler as ExtRequestHandler)) }
  }

  /** The `events` part of extension `ext`'s DoorApi: silent once `own` is disposed (the extension left). */
  eventsFor(ext: string, own: DisposableStore): DoorEvents {
    return {
      emit: (name, payload) => {
        if (typeof name !== 'string' || !name) throw new Error(`evento de extensão sem nome (${ext})`)
        const port = this.port()
        if (!port || own.isDisposed) return
        port.broadcast(payload === undefined ? { t: 'ext-event', ext, name } : { t: 'ext-event', ext, name, payload })
      },
    }
  }
}
