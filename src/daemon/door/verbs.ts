// The verb registry of the agent door: an extension registers a verb once; the core exposes it on the CLI (`tether <ns> <name>`,
// the two request handlers below) and, in slice D5, as a tool of the `tether` MCP server (which reads this same registry).
// The handler always runs inside tetherd and learns who called through `VerbCaller`.
import { toDisposable, type IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { SlotState } from '../protocol.ts'
import { DoorError, type DoorReplyBody, type DoorRequestHandler } from './port.ts'
import type { SlotKeys } from './slot-key.ts'
import type { VerbCaller, VerbContribution, VerbResult } from './types.ts'

const WORD = /^[a-z][a-z0-9-]*$/

/** A registered verb with the extension that owns it. */
export interface RegisteredVerb {
  ext: string
  verb: VerbContribution
}

export interface VerbRegistryOptions {
  keys: SlotKeys
  /** The state of a slot; undefined for an unknown one (or when there is no port, as in a satellite). */
  stateOf: (slotId: string) => SlotState | undefined
}

export class VerbRegistry {
  private readonly opts: VerbRegistryOptions
  private readonly verbs = new Map<string, RegisteredVerb>()
  private readonly nsOwner = new Map<string, string>()
  private readonly paragraphs = new Map<symbol, { ext: string; text: string }>()
  private readonly changeListeners = new Set<() => void>()

  constructor(opts: VerbRegistryOptions) {
    this.opts = opts
  }

  /** Registers `verb` for extension `ext`. A namespace belongs to one extension; a name is unique inside it. */
  register(ext: string, verb: VerbContribution): IDisposable {
    if (!WORD.test(verb.ns)) throw new Error(`namespace de verbo inválido: ${JSON.stringify(verb.ns)} (minúsculas, dígitos e hífen)`)
    if (!WORD.test(verb.name)) throw new Error(`nome de verbo inválido: ${JSON.stringify(verb.name)} (minúsculas, dígitos e hífen)`)
    const owner = this.nsOwner.get(verb.ns)
    if (owner !== undefined && owner !== ext) throw new Error(`o namespace ${verb.ns} é da extensão ${owner}`)
    const id = `${verb.ns} ${verb.name}`
    if (this.verbs.has(id)) throw new Error(`o verbo ${id} já está registrado`)
    const entry: RegisteredVerb = { ext, verb }
    this.verbs.set(id, entry)
    this.nsOwner.set(verb.ns, ext)
    this.changed()
    return toDisposable(() => {
      if (this.verbs.get(id) !== entry) return
      this.verbs.delete(id)
      if (![...this.verbs.values()].some((v) => v.verb.ns === verb.ns)) this.nsOwner.delete(verb.ns)
      this.changed()
    })
  }

  /** A paragraph for the `tether` server's instructions, under the extension's header. */
  instructions(ext: string, text: string): IDisposable {
    const id = Symbol('instructions')
    this.paragraphs.set(id, { ext, text })
    this.changed()
    return toDisposable(() => { if (this.paragraphs.delete(id)) this.changed() })
  }

  /** Every registered verb, in registration order. `exit` keeps only the ones shown there (a verb with no `exits` shows in both). */
  list(exit?: 'mcp' | 'cli'): RegisteredVerb[] {
    const all = [...this.verbs.values()]
    return exit ? all.filter((v) => (v.verb.exits ?? ['mcp', 'cli']).includes(exit)) : all
  }

  find(ns: string, name: string): RegisteredVerb | undefined {
    return this.verbs.get(`${ns} ${name}`)
  }

  /** The instruction paragraphs, grouped by extension, in registration order. */
  instructionParagraphs(): { ext: string; texts: string[] }[] {
    const by = new Map<string, string[]>()
    for (const p of this.paragraphs.values()) {
      const texts = by.get(p.ext) ?? []
      texts.push(p.text)
      by.set(p.ext, texts)
    }
    return [...by].map(([ext, texts]) => ({ ext, texts }))
  }

  /** The verbs or the instructions changed (the MCP server's `notifications/tools/list_changed`). */
  onDidChange(listener: () => void): IDisposable {
    this.changeListeners.add(listener)
    return toDisposable(() => { this.changeListeners.delete(listener) })
  }

  /** Runs a verb; a handler that throws becomes an error result, so a bug in one extension never breaks the caller's channel. */
  async run(entry: RegisteredVerb, caller: VerbCaller, args: Record<string, unknown>): Promise<VerbResult> {
    try {
      return await entry.verb.run(caller, args)
    } catch (e) {
      return { text: `${entry.verb.ns} ${entry.verb.name}: ${(e as Error).message}`, isError: true }
    }
  }

  // ---- the pipe's two requests -----------------------------------------------------------------

  /** `verb-list`: the verbs the CLI shows. */
  readonly handleList: DoorRequestHandler = (): DoorReplyBody => ({
    verbs: this.list('cli').map(({ verb }) => ({
      ns: verb.ns, name: verb.name, help: verb.help, input: verb.input,
      ...(verb.positional ? { positional: [...verb.positional] } : {}),
    })),
  })

  /** `verb`: runs one in the name of a slot. No key, or a wrong one, still runs it, with `proven: false`. */
  readonly handleRun: DoorRequestHandler = async (req): Promise<DoorReplyBody> => {
    const { ns, name, slotId, key, args } = req as { ns?: unknown; name?: unknown; slotId?: unknown; key?: unknown; args?: unknown }
    if (typeof ns !== 'string' || typeof name !== 'string') throw new DoorError('bad-request', 'verb precisa de ns e name')
    if (typeof slotId !== 'string' || slotId === '') throw new DoorError('bad-request', 'verb precisa de slotId')
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new DoorError('bad-request', 'os args do verbo precisam ser um objeto')
    const entry = this.find(ns, name)
    if (!entry || !(entry.verb.exits ?? ['mcp', 'cli']).includes('cli')) throw new DoorError('unknown-verb', `não há o verbo ${ns} ${name}`)
    const state = this.opts.stateOf(slotId)
    if (!state) throw new DoorError('unknown-slot', `slot desconhecido: ${slotId}`)
    const proven = this.opts.keys.verify(slotId, typeof key === 'string' ? key : undefined)
    return { verb: await this.run(entry, { slotId, state, via: 'cli', proven }, (args ?? {}) as Record<string, unknown>) }
  }

  private changed(): void {
    for (const l of [...this.changeListeners]) l()
  }
}
