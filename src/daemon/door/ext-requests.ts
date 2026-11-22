// Extension requests (N1, daemon half): the pipe's `ext-request` reaches the handler the extension registered under that
// name. The core sets `ext` (an extension's API only ever registers under its own id), so two extensions may use the same
// name. Registering always works, satellites included: only tetherd gets requests from a pipe.
import { toDisposable, type DisposableStore, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import { DoorError, type DoorReplyBody, type DoorRequestContext } from './port.ts'
import type { DoorRequests, ExtRequestHandler } from './types.ts'

export class ExtRequestService {
  /** ext → name → handler. Grows with what the extensions register, not with clients or calls. */
  private readonly handlers = new Map<string, Map<string, ExtRequestHandler>>()

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
    const result = await handler(req.args, { client: ctx.client })
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
}
