// The app's half of the published tree (RR3 3.2): the Regency's entry goes to tetherd when it changes, and the lease says
// "the app is still here" in between. Never in a loop: a change only arms one debounce; the flush publishes only a tree
// whose signature differs from the last one sent; the lease carries the signature alone and sends the tree again only
// when tetherd says it does not keep it. A tree over the ceiling is refused once and not sent again until it changes.
// Pure of the DOM: the clock and the request come in (renderer.ts gives `ui.daemon.request`).
import type { RegencyInput } from '../model.ts'
import { LEASE_MS, publishedTreeOf, signatureOf, TREE_MAX_BYTES, treeJson, utf8Length, type PublishAnswer } from '../publish-rules.ts'

export const PUBLISH_DEBOUNCE_MS = 400

export interface PublisherDeps {
  /** The Regency's entry as it is now. */
  read: () => RegencyInput
  /** `ui.daemon.request('tree.publish', args)`. */
  send: (args: { sig: string; tree?: RegencyInput }) => Promise<PublishAnswer>
  debounceMs?: number
  leaseMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (t: unknown) => void
  log?: (msg: string) => void
}

export class TreePublisher {
  readonly #d: Required<Omit<PublisherDeps, 'log'>> & { log: (msg: string) => void }
  #debounce: unknown
  #lease: unknown
  /** The signature tetherd last accepted. */
  #sent: string | undefined
  /** A signature refused (too big, or tetherd said no): not sent again until the tree changes. */
  #refused: string | undefined
  #inFlight = false
  /** A change came while a send was in flight: one more flush after it. */
  #again = false
  #disposed = false

  constructor(deps: PublisherDeps) {
    this.#d = {
      debounceMs: PUBLISH_DEBOUNCE_MS, leaseMs: LEASE_MS,
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: t => clearInterval(t as ReturnType<typeof setInterval>),
      log: m => console.warn(m),
      ...deps,
    }
  }

  /** At open: publish now and start the lease. */
  start(): void {
    if (this.#disposed || this.#lease !== undefined) return
    this.#lease = this.#d.setInterval(() => { void this.#renew() }, this.#d.leaseMs)
    void this.flush()
  }

  /** Something the entry reads changed: one flush after the debounce, however many changes come meanwhile. */
  changed(): void {
    if (this.#disposed || this.#debounce !== undefined) return
    this.#debounce = this.#d.setTimeout(() => { this.#debounce = undefined; void this.flush() }, this.#d.debounceMs)
  }

  get sent(): string | undefined { return this.#sent }

  /** Publishes the entry if its signature is new. `force`: send the tree even when tetherd should already have it. */
  async flush(force = false): Promise<void> {
    if (this.#disposed) return
    if (this.#inFlight) { this.#again = true; return }
    const tree = publishedTreeOf(this.#d.read())
    const json = treeJson(tree)
    const sig = signatureOf(json)
    if (!force && (sig === this.#sent || sig === this.#refused)) return
    const bytes = utf8Length(json)
    if (bytes > TREE_MAX_BYTES) {
      this.#refused = sig
      this.#d.log(`regência: árvore grande demais para publicar (${bytes} bytes; o teto é ${TREE_MAX_BYTES})`)
      return
    }
    this.#inFlight = true
    try {
      const a = await this.#d.send({ sig, tree })
      if ('sig' in a) { this.#sent = a.sig; this.#refused = undefined }
    } catch (e) {
      // A refusal of THIS tree (too big, not the app) waits for a change; a lost pipe is tried again by the lease.
      const code = (e as { code?: unknown })?.code
      if (code === 'bad-request' || code === 'door-denied' || code === 'unknown-request') this.#refused = sig
      // A tetherd older than the daemon half has no handler: nothing to say about it.
      if (code !== 'unknown-request') this.#d.log(`regência: publicar a árvore falhou: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.#inFlight = false
    }
    if (this.#again) { this.#again = false; await this.flush() }
  }

  /** The lease: the signature alone; the tree again only when tetherd does not keep it. */
  async #renew(): Promise<void> {
    if (this.#disposed || this.#inFlight) return
    if (this.#sent === undefined) { await this.flush(); return }
    try {
      const a = await this.#d.send({ sig: this.#sent })
      if ('need' in a) await this.flush(true)
    } catch (e) {
      this.#d.log(`regência: renovar a árvore falhou: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  dispose(): void {
    this.#disposed = true
    if (this.#debounce !== undefined) this.#d.clearTimeout(this.#debounce)
    if (this.#lease !== undefined) this.#d.clearInterval(this.#lease)
    this.#debounce = this.#lease = undefined
  }
}
