// The upload consent on the main side (Tether Browser E13, design §2.3, §4.3, review M1). `Tether.confirmUpload` comes here: the
// renderer shows the tether's modal dialog (it freezes every surface; the page's picture is in the dialog) with the agent, the
// file and its folder, and the site that owns the field, and answers allow or deny. At most one question per tab: a second one
// while the first waits is refused at once. A question is withdrawn (refused) when its tab closes or leaves the agent (the person
// took it, paused it, or the agent asked for help), and when the extension goes.
import { randomUUID } from 'node:crypto'
import { splitPath, type UploadAsk } from './files-rules.ts'

export interface UploadRequest {
  tabId: string
  agent: string
  path: string
  frameOrigin: string
  pageOrigin: string
  image?: string
}

export interface UploadConsentOptions {
  ask(ask: UploadAsk): void
  cancelled(id: string): void
  log(msg: string): void
}

interface Pending { ask: UploadAsk; resolve(ok: boolean): void }

export class UploadConsent {
  private readonly opts: UploadConsentOptions
  private readonly pending = new Map<string, Pending>()
  private disposed = false

  constructor(opts: UploadConsentOptions) { this.opts = opts }

  /** True when the person allowed it; false when she did not, or the question was withdrawn, or one is already open on the tab. */
  request(req: UploadRequest): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    for (const p of this.pending.values()) {
      if (p.ask.tabId === req.tabId) {
        this.opts.log(`upload: já há um pedido aberto na guia ${req.tabId}; o novo foi recusado`)
        return Promise.resolve(false)
      }
    }
    const { folder, name } = splitPath(req.path)
    const ask: UploadAsk = {
      id: randomUUID(), tabId: req.tabId, agent: req.agent, fileName: name, folder, frameOrigin: req.frameOrigin, pageOrigin: req.pageOrigin,
      ...(req.image ? { image: req.image } : {}),
    }
    return new Promise<boolean>(resolve => {
      this.pending.set(ask.id, { ask, resolve })
      this.opts.log(`upload: perguntando à pessoa (guia ${req.tabId})`)
      this.opts.ask(ask)
    })
  }

  /** The person's answer; only 'allow' allows. An unknown or settled id is ignored. */
  answer(id: string, choice: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const ok = choice === 'allow'
    this.opts.log(`upload: a pessoa ${ok ? 'permitiu' : 'não permitiu'} (guia ${p.ask.tabId})`)
    p.resolve(ok)
  }

  open(): UploadAsk[] { return [...this.pending.values()].map(p => p.ask) }

  /** The tab closed or left the agent: its question is refused and withdrawn. */
  cancelTab(tabId: string, why: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.ask.tabId !== tabId) continue
      this.pending.delete(id)
      this.opts.log(`upload: pedido retirado (${why}, guia ${tabId})`)
      p.resolve(false)
      this.opts.cancelled(id)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [id, p] of this.pending) { p.resolve(false); this.opts.cancelled(id) }
    this.pending.clear()
  }
}
