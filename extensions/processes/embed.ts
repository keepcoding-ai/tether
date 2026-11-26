// Feed P: what another extension (the Regency's "Sistema") reads of the background processes and the acts it asks of them.
// Pure: no DOM, no import of the renderer host. The processes extension publishes the list, the acts and the process'
// record (the `process:` pane) here in `activate`; with the extension off the feed is inactive: `list()` is empty and every
// act answers a refusal in plain words. The same pattern as channels/renderer/embed.ts and browser/renderer/embed.ts.
// The list never carries `card.env` (it may hold a secret): `toEmbedProc` drops it before any reader sees a process.
import type { Reply } from '../../src/daemon/protocol.ts'
import type { ProcCard, ProcState } from '../../src/daemon/procs.ts'
import { createRefusalText, maskEcho, refusalField, type NewProcField, type NewProcRecipe, type NewProcRequest } from '../regency/new-process-rules.ts'
import { forceReasonError, inUseRefusal, MAX_WAIT_MS, refusalText, type InUseRefusal } from '../regency/system-rules.ts'
import { HOLD_DURATION, HOLD_PURPOSE, othersUses } from './proc-rules.ts'

/** A process as a reader sees it: the same as the pad's, without `env`; `envNames` keeps only the variables' names. */
export type EmbedProc = Omit<ProcState, 'card'> & { card: Omit<ProcCard, 'env'>; envNames: string[] }

/** An act: done, or refused in plain words (pt-BR, ready to show). A refusal for others' uses carries who, until when, what for and the ways out. */
export type ProcAct = { ok: true } | { refusal: string; inUse?: InUseRefusal }

/** How a stop or restart goes past others' uses: wait for them (at most 5 min), or go ahead with the person's reason. */
export interface GuardedOptions {
  waitMs?: number
  force?: string
}

/**
 * "Novo processo": made and started (`failed`: registered, but the start failed, in plain words), or refused (the name's or
 * the port's sentence, `field` where the form shows it). No text of the answer carries a value of the recipe's env.
 */
export type ProcCreate = { ok: true; failed?: string } | { refusal: string; code: string; field?: NewProcField }

export interface ProcessEmbedActs {
  /** Starts the stored recipe. */
  start(name: string): Promise<ProcAct>
  /**
   * Registers and starts a new process (the CLI's `proc start <nome> … -- <comando…>`). The recipe's env values go to tetherd
   * in that request and are not kept: the answer is masked against them.
   */
  create(request: NewProcRequest): Promise<ProcCreate>
  stop(name: string, opts?: GuardedOptions): Promise<ProcAct>
  restart(name: string, opts?: GuardedOptions): Promise<ProcAct>
  /** Declares the person's use (default: 15 min, "segurado pela pessoa"). */
  hold(name: string, opts?: { duration?: string; purpose?: string }): Promise<ProcAct>
  /** Lets go of the person's use. */
  release(name: string): Promise<ProcAct>
  /**
   * Opens the process' record as a tab on a desk, without taking the person there; refused when the process is unknown, the
   * desk is unknown or the record already has a tab.
   */
  output(name: string, opts: { deskId: string; timeline?: boolean }): ProcAct
  /**
   * Peeks the record with no tab (a tab that already exists is lent to the card). `over`: the card docks on that element (the
   * Regency's conversation), as every quick view the Regency opens; the keyboard stays where it is.
   */
  peekOutput(name: string, opts?: PeekOver): ProcAct
}

/** Where the quick view docks (the Regency's conversation); absent: the modal card of always. */
export interface PeekOver { over?: HTMLElement }

/** What the processes extension gives the feed while it is on. */
export interface ProcessEmbedSource extends ProcessEmbedActs {
  /** The processes as the pad shows them (the feed drops `card.env`). */
  list(): readonly ProcState[]
  /** The list changed (an event of tetherd, or the list was read again). */
  onDidChange(listener: () => void): { dispose(): void }
}

export interface ProcessEmbedFeed extends ProcessEmbedActs {
  /** processes is on and publishing in this process. */
  readonly active: boolean
  list(): readonly EmbedProc[]
  get(name: string): EmbedProc | undefined
  /** The list changed, or the feed turned on or off. A listener lives across publications. */
  onDidChange(listener: () => void): { dispose(): void }
}

export interface ProcessEmbedPublisher extends ProcessEmbedFeed {
  /** Turns the feed on with `source`, replacing any earlier one; the returned handle turns it off (if it is still the current one). */
  publish(source: ProcessEmbedSource): { dispose(): void }
}

/** The process without the values of its `env` (the names stay, apart). */
export function toEmbedProc(p: ProcState): EmbedProc {
  const { env, ...card } = p.card
  return { ...p, card, envNames: Object.keys(env ?? {}) }
}

const OFF = { refusal: 'Os processos estão desligados.' } as const

export function createProcessEmbeds(): ProcessEmbedPublisher {
  const listeners = new Set<() => void>()
  let source: ProcessEmbedSource | undefined
  let sub: { dispose(): void } | undefined
  const notify = (): void => {
    for (const l of [...listeners]) { try { l() } catch (e) { console.error('process embeds listener', e) } }
  }
  const unpublish = (): void => {
    sub?.dispose()
    sub = undefined
    source = undefined
  }
  return {
    get active() { return source !== undefined },
    list: () => source?.list().map(toEmbedProc) ?? [],
    get: name => { const p = source?.list().find(x => x.name === name); return p ? toEmbedProc(p) : undefined },
    onDidChange(listener) {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    start: async name => source ? source.start(name) : OFF,
    create: async request => source ? source.create(request) : { ...OFF, code: 'off' },
    stop: async (name, opts) => source ? source.stop(name, opts) : OFF,
    restart: async (name, opts) => source ? source.restart(name, opts) : OFF,
    hold: async (name, opts) => source ? source.hold(name, opts) : OFF,
    release: async name => source ? source.release(name) : OFF,
    output: (name, opts) => source ? source.output(name, opts) : OFF,
    peekOutput: (name, opts) => source ? source.peekOutput(name, opts) : OFF,
    publish(next) {
      unpublish()
      source = next
      sub = next.onDidChange(notify)
      notify()
      let live = true
      return {
        dispose: () => {
          if (!live) return
          live = false
          if (source !== next) return
          unpublish()
          notify()
        },
      }
    },
  }
}

/** The one of the process: processes feeds it, the Regency reads it. */
export const processEmbeds: ProcessEmbedPublisher = createProcessEmbeds()

// ---------------------------------------------------------------- the acts, over the host's ports

/** The part of the host's panes the record needs (the app's `ui.panes`). */
export interface ProcessPanesPort {
  /** The pane id is a tab that exists. */
  has(paneId: string): boolean
  /** Adds the record's tab to a desk without switching to it; false when refused (unknown desk). */
  openOnDesk(name: string, deskId: string, timeline: boolean): boolean
  /** Lends an existing tab to the quick view card (docked on `opts.over` when given). */
  peekPane(paneId: string, opts?: PeekOver): void
  /** Builds the record in the card with no tab (docked on `opts.over` when given); false for an unknown type. */
  peekNew(name: string, paneId: string, opts?: PeekOver): boolean
}

export interface ProcessActsDeps {
  get(name: string): ProcState | undefined
  now(): number
  start(name: string): Promise<Reply>
  /** `proc-start` with a recipe (ui.procs.create). */
  create(name: string, recipe: NewProcRecipe): Promise<Reply>
  stop(name: string, opts: GuardedOptions): Promise<Reply>
  restart(name: string, opts: GuardedOptions): Promise<Reply>
  use(name: string, duration: string, purpose: string): Promise<Reply>
  release(name: string): Promise<Reply>
  panes: ProcessPanesPort
  /** The id of a process' tab. */
  paneIdOf(name: string): string
}

const UNKNOWN = { refusal: refusalText('unknown-proc') } as const

/** The acts of the feed, the same requests and rules as the pad's buttons. */
export function createProcessActs(deps: ProcessActsDeps): ProcessEmbedActs {
  const answer = (r: Reply): ProcAct => r.t === 'error' ? { refusal: refusalText(r.code, r.message) } : { ok: true }

  async function guarded(act: 'stop' | 'restart', name: string, opts: GuardedOptions = {}): Promise<ProcAct> {
    if (!deps.get(name)) return UNKNOWN
    const send: GuardedOptions = {}
    if (opts.force !== undefined) {
      const bad = forceReasonError(opts.force)
      if (bad) return { refusal: bad }
      send.force = opts.force.trim()
    } else if (opts.waitMs !== undefined) send.waitMs = Math.min(Math.max(0, opts.waitMs), MAX_WAIT_MS)
    const r = await (act === 'stop' ? deps.stop(name, send) : deps.restart(name, send))
    if (r.t === 'error' && r.code === 'proc-in-use') {
      const p = deps.get(name)
      const inUse = p ? inUseRefusal({ name, uses: othersUses(p) }, act, deps.now()) : undefined
      return inUse ? { refusal: inUse.sentence, inUse } : answer(r)
    }
    return answer(r)
  }

  return {
    start: async name => deps.get(name) ? answer(await deps.start(name)) : UNKNOWN,
    async create({ name, recipe }) {
      // A known name started with a recipe would change that process' recipe: the form refuses it, and so does the act.
      if (deps.get(name)) return { refusal: `Já existe um processo "${name}": escolha outro nome.`, code: 'proc-exists', field: 'name' }
      const values = Object.values(recipe.env)
      const r = await deps.create(name, recipe)
      if (r.t === 'error') {
        const field = refusalField(r.code)
        return { refusal: createRefusalText(r.code, r.message, values), code: r.code, ...(field ? { field } : {}) }
      }
      if (r.proc?.status === 'failed') {
        const why = maskEcho(r.proc.error ?? '', values).trim()
        return { ok: true, failed: why ? `${name} foi registrado, mas não iniciou: ${why}` : `${name} foi registrado, mas não iniciou.` }
      }
      return { ok: true }
    },
    stop: (name, opts) => guarded('stop', name, opts),
    restart: (name, opts) => guarded('restart', name, opts),
    hold: async (name, opts = {}) => {
      if (!deps.get(name)) return UNKNOWN
      const purpose = opts.purpose?.trim()
      return answer(await deps.use(name, opts.duration?.trim() || HOLD_DURATION, purpose ? purpose : HOLD_PURPOSE))
    },
    release: async name => deps.get(name) ? answer(await deps.release(name)) : UNKNOWN,
    output(name, { deskId, timeline }) {
      if (!deps.get(name)) return UNKNOWN
      if (deps.panes.has(deps.paneIdOf(name))) return { refusal: `O registro de "${name}" já está aberto como guia.` }
      return deps.panes.openOnDesk(name, deskId, timeline !== false) ? { ok: true } : { refusal: 'Não foi possível abrir o registro nessa mesa.' }
    },
    peekOutput(name, opts) {
      if (!deps.get(name)) return UNKNOWN
      const id = deps.paneIdOf(name)
      if (deps.panes.has(id)) { if (opts?.over) deps.panes.peekPane(id, opts); else deps.panes.peekPane(id); return { ok: true } }
      const made = opts?.over ? deps.panes.peekNew(name, id, opts) : deps.panes.peekNew(name, id)
      return made ? { ok: true } : { refusal: 'Não foi possível espiar o registro.' }
    },
  }
}
