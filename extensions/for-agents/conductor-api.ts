// The conductors' contract (tether for agents): a conductor teaches the extension how to command one kind of content
// (a terminal, an agent CLI; later a note, a browser tab). Each conductor is an extension of its own (conductor-<id>,
// daemon only, requires for-agents) that imports this module and registers itself in `conductorRegistry`, in the mould
// of the agents' registry. With for-agents off the registry still exists and nobody reads it.
//
// The chain: every conductor says how much it wants a pane (`match`); the highest wins, and an act the winner lacks falls
// to the next one in that order. The CLI conductors answer 10 for their agent kind, the terminal 0 for every slot pane,
// so `type`, `keys` and `read` of the terminal serve every engine and a CLI conductor writes only what is its engine's.
// Daemon side only: the renderer never imports this file.
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { DaemonIo } from '../../src/daemon/ext-api.ts'
import type { KeyName, VerbResult } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { CapabilityId } from './rules.ts'

export interface ConductorTarget {
  paneId: string
  /** The pane's type in the desk map: 'terminal', 'note', 'browser.tab'... */
  type: string
  /** Only for a slot's pane. */
  slot?: SlotState
}

/** A screen as the person sees it, as text (the headless terminal of screen/). */
export interface ScreenText {
  /** The screen now: lines baseY to baseY+rows, wrapped ones (isWrapped) joined. */
  screen: string[]
  /** The scrollback: 0 to baseY. */
  history: string[]
  cols: number
  rows: number
  /** The offset read up to: the next read's `since`. */
  end: number
}

export interface DetectedCard { title: string; text: string; options: { id: string; label: string }[] }

export type Detected =
  | { state: 'busy' | 'idle' | 'unknown' }
  | { state: 'permission' | 'question' | 'dialog'; card: DetectedCard }

/** An act's result and whether a probe proved that act on this engine (an unproven act still runs, marked). */
export interface Proven<T> { value: T; proven: boolean }

export interface ConductorContext {
  target: ConductorTarget
  /** The screen as the person sees it. */
  screen(opts?: { since?: number }): Promise<ScreenText>
  /** The only write a conductor has: through the guard (never over the person); rejects `with-user`. */
  write(chunks: readonly { data: string; waitMs?: number }[]): Promise<void>
  keys(keys: readonly KeyName[], opts?: { gapMs?: number }): Promise<void>
  io: DaemonIo
  home: string
  log(msg: string): void
}

/** A verb of the content's own ('note', 'navigate'): registered under `agents`, wrapped in the ownership and inventory checks. */
export interface ConductedVerb {
  name: string
  capability: CapabilityId
  description: string
  help: string
  input: Record<string, unknown>
  positional?: readonly string[]
  run(ctx: ConductorContext, args: Record<string, unknown>): Promise<VerbResult>
}

export interface LastAnswer { text: string; at: string; source: string; turn?: string }

export interface Conductor {
  /** 'terminal', 'claude', 'soul', 'codex'; later 'note', 'web'. Unique. */
  id: string
  /** How much this conductor wants this pane; the highest wins; undefined = not its pane. */
  match(target: ConductorTarget): number | undefined
  /** The lines it puts in the inventory. */
  capabilities: readonly { id: CapabilityId; label: string }[]
  /** Joins the screen watch. */
  watch?: boolean
  /** Every act is optional: a missing one falls to the next conductor of the chain, or answers `unsupported`. */
  launchArgs?(req: { model?: string; effort?: string; cwd: string }): Proven<string[]>
  boot?(ctx: ConductorContext): Promise<void>
  send?(ctx: ConductorContext, text: string): Promise<Proven<void>>
  interrupt?(ctx: ConductorContext): Promise<Proven<{ stopped: boolean }>>
  answer?(ctx: ConductorContext, choice: string): Promise<Proven<void>>
  command?(ctx: ConductorContext, name: string, args?: string): Promise<Proven<void>>
  detect?(ctx: ConductorContext): Promise<Detected>
  lastAnswer?(ctx: ConductorContext): Promise<Proven<LastAnswer> | undefined>
  read?(ctx: ConductorContext, opts: { part?: string; lines?: number; since?: number }): Promise<{ text: string; meta?: Record<string, unknown> }>
  verbs?: readonly ConductedVerb[]
}

/** The acts a conductor may have (each optional member that is a function). */
export type ConductorAct = 'launchArgs' | 'boot' | 'send' | 'interrupt' | 'answer' | 'command' | 'detect' | 'lastAnswer' | 'read'
export const CONDUCTOR_ACTS: readonly ConductorAct[] = ['launchArgs', 'boot', 'send', 'interrupt', 'answer', 'command', 'detect', 'lastAnswer', 'read']

const CONDUCTOR_ID_RE = /^[a-z][a-z0-9-]*$/

export class ConductorRegistry {
  private readonly list: Conductor[] = []
  private readonly listeners = new Set<() => void>()

  register(c: Conductor): IDisposable {
    if (!CONDUCTOR_ID_RE.test(c.id)) throw new Error(`id de condutor inválido: ${JSON.stringify(c.id)}`)
    if (this.list.some(x => x.id === c.id)) throw new Error(`o condutor ${c.id} já está registrado`)
    this.list.push(c)
    this.changed()
    return toDisposable(() => {
      const i = this.list.indexOf(c)
      if (i < 0) return
      this.list.splice(i, 1)
      this.changed()
    })
  }

  all(): readonly Conductor[] {
    return [...this.list]
  }

  get(id: string): Conductor | undefined {
    return this.list.find(c => c.id === id)
  }

  /** The conductors that want this pane, highest `match` first; a tie keeps the registration order. A throwing `match` is out. */
  chain(target: ConductorTarget): Conductor[] {
    const scored: { c: Conductor; score: number; i: number }[] = []
    this.list.forEach((c, i) => {
      let score: number | undefined
      try { score = c.match(target) } catch { score = undefined }
      if (typeof score === 'number' && Number.isFinite(score)) scored.push({ c, score, i })
    })
    return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(s => s.c)
  }

  /** Who performs `act` on this pane: the first of the chain that has it; undefined = `unsupported` (or `no-conductor`). */
  pick(target: ConductorTarget, act: ConductorAct): Conductor | undefined {
    return this.chain(target).find(c => typeof c[act] === 'function')
  }

  /** The inventory lines for this pane: every conductor of the chain's, first label wins for a shared id. */
  capabilitiesOf(target: ConductorTarget): { id: CapabilityId; label: string }[] {
    const out: { id: CapabilityId; label: string }[] = []
    for (const c of this.chain(target)) for (const cap of c.capabilities) if (!out.some(o => o.id === cap.id)) out.push({ ...cap })
    return out
  }

  /** The content verbs for this pane, with the conductor that runs each: the first of the chain wins for a shared name. */
  verbsOf(target: ConductorTarget): { conductor: Conductor; verb: ConductedVerb }[] {
    const out: { conductor: Conductor; verb: ConductedVerb }[] = []
    for (const c of this.chain(target)) for (const v of c.verbs ?? []) if (!out.some(o => o.verb.name === v.name)) out.push({ conductor: c, verb: v })
    return out
  }

  onDidChange(listener: () => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private changed(): void {
    for (const l of [...this.listeners]) {
      try { l() } catch { /* a listener's failure is its own */ }
    }
  }
}

/** The process-wide registry the conductor extensions register into and for-agents reads. */
export const conductorRegistry = new ConductorRegistry()
