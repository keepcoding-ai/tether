// The terminal conductor (tether for agents): types, keys and reads the screen of any terminal pane of a slot, a shell or an
// agent CLI that has no conductor of its own. It is the last of the chain (`match` 0): a CLI conductor (10) answers for its
// engine and the acts it lacks fall here. Every write goes through `ctx.write` / `ctx.keys`, the gate of the contract's 2.3:
// this file never touches `slots.write`.
//
// What no probe proved on a real engine leaves marked `proven: false` (the contract's 3.2): `interrupt` of an agent CLI
// (`esc`) and `lastAnswer` (the end of the screen). The shell's `ctrl+c` and the typing bytes of the engine are the probes'.
import { isKeyName } from '../../src/daemon/door/keys.ts'
import { typingOf } from '../../src/daemon/door/typing.ts'
import type { KeyName, VerbResult } from '../../src/daemon/door/types.ts'
import { ConductError, type ConductedVerb, type Conductor, type ConductorContext, type ConductorTarget, type Detected, type LastAnswer, type Proven, type ScreenText } from '../for-agents/conductor-api.ts'

export const TERMINAL_CONDUCTOR_ID = 'terminal'

export { ConductError }

const isShell = (t: ConductorTarget): boolean => t.slot?.kind === 'shell'

/** The lines of a screen, the blank ones at the end cut (a TUI pads the screen to its rows). */
function trimEnd(lines: readonly string[]): string[] {
  let n = lines.length
  while (n > 0 && lines[n - 1]!.trim() === '') n--
  return lines.slice(0, n)
}

function pick(t: ScreenText, part: string | undefined): string[] {
  const screen = trimEnd(t.screen)
  if (part === 'history') return trimEnd(t.history)
  if (part === 'both') return [...t.history, ...screen]
  return screen
}

/** The last block of the screen: the lines after the last blank line. */
export function lastBlock(screen: readonly string[]): string {
  const lines = trimEnd(screen)
  let start = lines.length
  while (start > 0 && lines[start - 1]!.trim() !== '') start--
  return lines.slice(start).join('\n').trim()
}

function wantKeys(value: unknown): KeyName[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConductError('bad-request', 'keys: lista de teclas vazia')
  const bad = value.find((k) => !isKeyName(k))
  if (bad !== undefined) throw new ConductError('bad-request', `tecla desconhecida: ${String(bad)}; nenhuma tecla foi enviada`)
  return value as KeyName[]
}

const GUIA = { type: 'string', description: "The pane: its slot id, or its name when unique among the owner's." }

export const terminalVerbs: readonly ConductedVerb[] = [
  {
    name: 'type',
    capability: 'type',
    description: 'Type text into a terminal pane exactly as a person would, with no Enter. Use `keys` for Enter.',
    help: 'Digita o texto na guia, sem Enter.',
    input: { type: 'object', properties: { guia: GUIA, text: { type: 'string' } }, required: ['guia', 'text'] },
    positional: ['guia', 'text'],
    async run(ctx: ConductorContext, args: Record<string, unknown>): Promise<VerbResult> {
      const text = args.text
      if (typeof text !== 'string' || text === '') throw new ConductError('bad-request', 'type: texto vazio')
      await ctx.write([{ data: text }])
      return { text: 'digitado', data: { sent: true } }
    },
  },
  {
    name: 'keys',
    capability: 'keys',
    description: 'Press named keys in a terminal pane, in order (enter, esc, tab, shift+tab, backspace, up, down, left, right, ctrl+c, ctrl+d, ctrl+u, ctrl+e, paste-start, paste-end). An unknown key sends none.',
    help: 'Tecla as teclas nomeadas, em ordem.',
    input: { type: 'object', properties: { guia: GUIA, keys: { type: 'array', items: { type: 'string' } } }, required: ['guia', 'keys'] },
    positional: ['guia', 'keys'],
    async run(ctx: ConductorContext, args: Record<string, unknown>): Promise<VerbResult> {
      await ctx.keys(wantKeys(args.keys))
      return { text: 'teclado', data: { sent: true } }
    },
  },
]

export const terminalConductor: Conductor = {
  id: TERMINAL_CONDUCTOR_ID,
  // Every terminal pane of a slot; the CLI conductors (10) come before it.
  match: (t) => (t.type === 'terminal' && t.slot ? 0 : undefined),
  capabilities: [
    { id: 'send', label: 'Enviar texto digitado' },
    { id: 'interrupt', label: 'Interromper' },
    { id: 'read', label: 'Ler a tela' },
    { id: 'type', label: 'Digitar' },
    { id: 'keys', label: 'Teclar' },
  ],

  /** The text and its Enter by the engine's own typing (door/typing.ts; a shell has none: the default). */
  async send(ctx: ConductorContext, text: string): Promise<Proven<void>> {
    await ctx.write(typingOf(ctx.agent).submit(text))
    return { value: undefined, proven: true }
  },

  /** A shell takes `ctrl+c`; an agent CLI without a conductor takes `esc`, which no probe proved on it. */
  async interrupt(ctx: ConductorContext): Promise<Proven<{ stopped: boolean }>> {
    const shell = isShell(ctx.target)
    await ctx.keys([shell ? 'ctrl+c' : 'esc'])
    // The terminal cannot see the process stop: the key went, nothing more is claimed.
    return { value: { stopped: false }, proven: shell }
  },

  /** `busy` or `idle` by the slot's turn; a shell has no turn: `unknown`. */
  async detect(ctx: ConductorContext): Promise<Detected> {
    const slot = ctx.target.slot
    if (!slot || slot.kind === 'shell') return { state: 'unknown' }
    return { state: slot.turn === 'busy' ? 'busy' : 'idle' }
  },

  /** The last block of the screen, marked unproven: it may be a menu or the prompt, not an answer. */
  async lastAnswer(ctx: ConductorContext): Promise<Proven<LastAnswer> | undefined> {
    const text = lastBlock((await ctx.screen()).screen)
    if (!text) return undefined
    return { value: { text, at: new Date().toISOString(), source: 'screen' }, proven: false }
  },

  async read(ctx: ConductorContext, opts: { part?: string; lines?: number; since?: number }): Promise<{ text: string; meta?: Record<string, unknown> }> {
    const t = await ctx.screen(opts.since === undefined ? undefined : { since: opts.since })
    let lines = pick(t, opts.part)
    if (opts.lines !== undefined && opts.lines > 0) lines = lines.slice(-opts.lines)
    return { text: lines.join('\n'), meta: { cols: t.cols, rows: t.rows, end: t.end } }
  },

  verbs: terminalVerbs,
}
