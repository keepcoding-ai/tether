// The Regency's daemon half (RR3 3.2): keeps the ONE tree the app last published (plano D2 (b)) and gives it, joined with
// the slots tetherd sees live, to whoever reads it. Memory is bounded: one tree of at most TREE_MAX_BYTES, one timer.
//
// Requests (ext `regency`):
// - `tree.publish { sig, tree? }`, from the app only: with `tree`, the tree is projected again by the allow list, measured,
//   signed and kept (`{ sig, at }`); without it, a lease: "still the tree `sig`" (`{ sig }`), or `{ need: 'tree' }` when
//   tetherd does not keep that tree (it restarted, or another tree came meanwhile).
// - `tree.read {}`: the view a remote screen draws (publish-rules.ts regencyViewOf): `{ input, live, asOf?, sig? }`.
// Event `tree.changed { sig?, at?, live }`: a new tree was kept, or its lease ran out (the app left). It carries no tree.
//
// How tetherd knows the app left: the lease. The open app renews it every LEASE_MS; a tree not renewed for STALE_MS is
// the app's last (the app closed, crashed or hangs). No connection hook is needed, and a reload simply publishes again.
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { DoorError } from '../../src/daemon/door/port.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { ExtRequestContext } from '../../src/daemon/door/types.ts'
import type { RegencyInput } from './model.ts'
import {
  isLive, publishedTreeOf, regencyViewOf, signatureOf, STALE_MS, TREE_CHANGED as EVT_CHANGED, TREE_MAX_BYTES, TREE_REQ as REQ,
  treeJson, utf8Length, type KeptTree, type PublishAnswer, type RegencyView,
} from './publish-rules.ts'
import type { RemoteState } from './remote-input.ts'

export { manifest } from './manifest.ts'

const SIG_RE = /^[0-9a-f]{16}$/

export interface TreeKeeperDeps {
  now?: () => number
  live?: () => RemoteState
  emit?: (name: string, payload: unknown) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** The bench: a `test` connection may publish too (never `cli` or `remote`). */
  bench?: boolean
}

/** The one kept tree and its lease. */
export class TreeKeeper {
  #kept: KeptTree | undefined
  #timer: unknown
  readonly #now: () => number
  readonly #live: () => RemoteState
  readonly #emit: (name: string, payload: unknown) => void
  readonly #setTimer: (fn: () => void, ms: number) => unknown
  readonly #clearTimer: (t: unknown) => void
  readonly #bench: boolean

  constructor(deps: TreeKeeperDeps = {}) {
    this.#now = deps.now ?? Date.now
    this.#live = deps.live ?? (() => ({}))
    this.#emit = deps.emit ?? (() => {})
    this.#setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.#clearTimer = deps.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.#bench = deps.bench ?? false
  }

  get kept(): KeptTree | undefined { return this.#kept }

  publish(args: unknown, ctx: ExtRequestContext): PublishAnswer {
    if (!(ctx.client === 'app' || (this.#bench && ctx.client === 'test'))) throw new DoorError('door-denied', 'só o app publica a árvore da Regência')
    const a = (args && typeof args === 'object' ? args : {}) as { sig?: unknown; tree?: unknown }
    const now = this.#now()
    if (a.tree === undefined) {
      if (typeof a.sig !== 'string' || !SIG_RE.test(a.sig)) throw new DoorError('bad-request', 'tree.publish sem sig nem árvore')
      if (!this.#kept || this.#kept.sig !== a.sig) return { need: 'tree' }
      const wasLive = isLive(this.#kept, now)
      this.#kept.seenAt = now
      this.#arm()
      if (!wasLive) this.#emit(EVT_CHANGED, { sig: this.#kept.sig, at: this.#kept.at, live: true })
      return { sig: this.#kept.sig }
    }
    if (!a.tree || typeof a.tree !== 'object') throw new DoorError('bad-request', 'tree.publish: árvore inválida')
    const tree = publishedTreeOf(a.tree as RegencyInput)
    const json = treeJson(tree)
    const bytes = utf8Length(json)
    if (bytes > TREE_MAX_BYTES) throw new DoorError('bad-request', `árvore grande demais (${bytes} bytes; o teto é ${TREE_MAX_BYTES})`)
    const sig = signatureOf(json)
    const same = this.#kept?.sig === sig
    const wasLive = isLive(this.#kept, now)
    // The same tree again keeps its time: "como estavam às" names when it last changed, not when it was last sent.
    this.#kept = { tree, sig, bytes, at: same ? this.#kept!.at : now, seenAt: now }
    this.#arm()
    if (!same || !wasLive) this.#emit(EVT_CHANGED, { sig, at: this.#kept.at, live: true })
    return { sig, at: this.#kept.at }
  }

  read(): RegencyView {
    return regencyViewOf(this.#kept, this.#live(), this.#now())
  }

  /** One timer: when the lease runs out, the screens hear that the app left. */
  #arm(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined
      const k = this.#kept
      if (k && !isLive(k, this.#now())) this.#emit(EVT_CHANGED, { sig: k.sig, at: k.at, live: false })
    }, STALE_MS + 1)
  }

  dispose(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
  }
}

export function activateWith(api: TetherDaemon, extra: TreeKeeperDeps = {}): { keeper: TreeKeeper; disposables: IDisposable[] } {
  const keeper = new TreeKeeper({
    live: () => ({ slots: api.slots.list(), deskMap: api.desks.map() }),
    emit: (name, payload) => api.events.emit(name, payload),
    bench: process.env.TETHER_TEST_REGENCY === '1',
    ...extra,
  })
  const disposables: IDisposable[] = [
    api.requests.handle(REQ.publish, (args, ctx) => keeper.publish(args, ctx)),
    api.requests.handle(REQ.read, () => keeper.read()),
    toDisposable(() => keeper.dispose()),
  ]
  return { keeper, disposables }
}

export function activate(api: TetherDaemon): IDisposable[] {
  return activateWith(api).disposables
}
