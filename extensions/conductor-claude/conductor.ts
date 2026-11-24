// The Claude Code conductor (tether for agents, contract 5.3): only what is the engine's. `type`, `keys` and `read` are absent and
// fall to the terminal conductor. Every byte goes through `ctx.write` / `ctx.keys` (the gate); the bytes and waits are the sonda's
// of 21/11 (Claude Code 2.1.330): one line = text, 150 ms, `\r` (always two writes); several lines = a bracketed paste, 400 ms,
// `\r` (the model receives `<pasted_content>`); `esc` once interrupts and fires no `Stop`; on a permission card the digit acts
// with no Enter (`1` once, `2` always, `4` or `esc` denies); a new folder opens the trust dialog whose default is "No, exit":
// down, 400 ms, enter. What no probe proved is marked `proven: false`.
import { slotAnswerPath } from '../../src/core/paths.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { ConductError, type Conductor, type ConductorContext, type ConductorTarget, type Detected, type LastAnswer, type Proven } from '../for-agents/conductor-api.ts'
import { hasAll, readClaudeScreen, TRUST_DIALOG, type ParsedOption, type Seen } from './screen.ts'

export const CLAUDE_CONDUCTOR_ID = 'claude'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ENTER_DELAY_MS = 150
const PASTE_ENTER_DELAY_MS = 400
const TRUST_GAP_MS = 400
const BOOT_MAX_MS = 90_000
const BOOT_POLL_MS = 300
const INTERRUPT_POLL_MS = 250
const INTERRUPT_MAX_MS = 4000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const asConduct = (e: unknown): e is ConductError => e instanceof ConductError

async function seeScreen(ctx: ConductorContext): Promise<Seen> {
  return readClaudeScreen((await ctx.screen()).screen)
}

const hasCard = (s: Seen): s is Extract<Seen, { card: unknown }> => s.kind === 'permission' || s.kind === 'question' || s.kind === 'dialog'

/** A card on the screen takes digits and Esc as answers: text typed then would pick an option, so nothing is typed. */
function refuseOverCard(s: Seen, what: string): void {
  if (hasCard(s)) throw new ConductError('busy', `há um pedido na tela desta guia (${s.card.title || s.kind}): responda com \`answer\` antes de ${what}`)
}

/** The text of one line, or the lines as a bracketed paste; the escape characters of the text never reach the terminal. */
export function sendChunks(text: string): { data: string; waitMs?: number }[] {
  const clean = text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (clean.trim() === '') throw new ConductError('bad-request', 'send: texto vazio')
  const lines = clean.split('\n')
  if (lines.length === 1) return [{ data: clean }, { data: '\r', waitMs: ENTER_DELAY_MS }]
  return [{ data: `${PASTE_START}${lines.join('\r')}${PASTE_END}` }, { data: '\r', waitMs: PASTE_ENTER_DELAY_MS }]
}

/** The digit an `answer` choice means on this card. */
function digitFor(seen: Extract<Seen, { card: unknown }>, choice: string): string | 'esc' {
  const options: ParsedOption[] = seen.options
  const byNumber = (n: number): string | undefined => (options.some((o) => o.n === n) ? String(n) : undefined)
  if (/^[1-9][0-9]*$/.test(choice)) {
    const d = byNumber(Number(choice))
    if (!d) throw new ConductError('bad-request', `não há a opção ${choice} neste pedido`)
    return d
  }
  if (seen.kind === 'permission') {
    const hit = options.find((o) => o.role === choice)
    if (choice === 'no') return hit?.n !== undefined ? String(hit.n) : 'esc'
    if (!hit || hit.n === undefined) {
      const names = [...new Set([...options.map((o) => o.role).filter((r) => r !== undefined), 'no'])]
      throw new ConductError('unsupported', `este pedido não tem a opção ${choice}; aceita: ${[...names, ...options.map((o) => String(o.n))].join(', ')}`)
    }
    return String(hit.n)
  }
  if (choice === 'no' && seen.kind === 'question') return 'esc'
  throw new ConductError('bad-request', `${seen.kind === 'question' ? 'pergunta' : 'diálogo'}: responda com o número da opção`)
}

function targetAnswerFile(ctx: ConductorContext): string {
  return slotAnswerPath(ctx.home, ctx.target.paneId)
}

export const claudeConductor: Conductor = {
  id: CLAUDE_CONDUCTOR_ID,
  match: (t: ConductorTarget) => (t.type === 'terminal' && t.slot?.kind === 'claude' ? 10 : undefined),
  capabilities: [
    { id: 'send', label: 'Enviar texto digitado' },
    { id: 'interrupt', label: 'Interromper' },
    { id: 'answer', label: 'Responder permissão' },
    { id: 'command', label: 'Comandos de barra' },
  ],
  watch: true,

  /** `--model` is proven; the effort flag exists in the CLI (`--effort <level>`) but no probe ran it. */
  launchArgs(req): Proven<string[]> {
    const args: string[] = []
    if (req.model) args.push('--model', req.model)
    if (req.effort) args.push('--effort', req.effort)
    return { value: args, proven: req.effort === undefined }
  },

  /**
   * The trust dialog of a folder Claude has not met: only when every fragment is on the screen, and only once, then it waits for
   * the prompt. The channels dialog is the core's (`channelConfirm`). Ends with the prompt, the slot's end, or after BOOT_MAX_MS.
   */
  async boot(ctx: ConductorContext): Promise<void> {
    const deadline = Date.now() + BOOT_MAX_MS
    let answered = false
    while (Date.now() < deadline) {
      const slot: SlotState | undefined = ctx.slot()
      if (!slot || slot.status === 'exited' || slot.status === 'error') return
      const screen = (await ctx.screen()).screen
      if (!answered && hasAll(screen, TRUST_DIALOG)) {
        try {
          await ctx.keys(['down', 'enter'], { gapMs: TRUST_GAP_MS })
          answered = true
          ctx.log('boot: diálogo de confiança respondido')
        } catch (e) {
          // The pane is not in the owner's desk yet (the app adds it a moment after `open`): try again.
          if (!(asConduct(e) && e.code === 'not-commanded')) throw e
        }
      } else {
        const seen = readClaudeScreen(screen)
        if (seen.kind === 'idle' || seen.kind === 'busy') return
      }
      await sleep(BOOT_POLL_MS)
    }
    ctx.log('boot: o prompt não apareceu a tempo')
  },

  async send(ctx: ConductorContext, text: string): Promise<Proven<void>> {
    const chunks = sendChunks(text)
    refuseOverCard(await seeScreen(ctx), 'enviar texto')
    await ctx.write(chunks)
    return { value: undefined, proven: true }
  },

  /** `esc` once, then reread the screen: stopped when the turn is no longer running. */
  async interrupt(ctx: ConductorContext): Promise<Proven<{ stopped: boolean }>> {
    await ctx.keys(['esc'])
    const end = Date.now() + INTERRUPT_MAX_MS
    while (Date.now() < end) {
      await sleep(INTERRUPT_POLL_MS)
      const seen = await seeScreen(ctx)
      if (seen.kind === 'interrupted' || seen.kind === 'idle') return { value: { stopped: true }, proven: true }
    }
    return { value: { stopped: false }, proven: true }
  },

  async answer(ctx: ConductorContext, choice: string): Promise<Proven<void>> {
    const seen = await seeScreen(ctx)
    if (!hasCard(seen)) throw new ConductError('no-request', 'não há pedido na tela desta guia')
    const what = digitFor(seen, choice)
    if (what === 'esc') await ctx.keys(['esc'])
    else await ctx.write([{ data: what }])
    return { value: undefined, proven: seen.kind !== 'question' || what !== 'esc' }
  },

  /** `/name args`, typed as a line. Idle compact and clear are the sonda's; compact mid-turn and other commands are not. */
  async command(ctx: ConductorContext, name: string, args?: string): Promise<Proven<void>> {
    if (!/^[A-Za-z][\w:.-]*$/.test(name)) throw new ConductError('bad-request', `comando inválido: ${JSON.stringify(name)}`)
    if (args !== undefined && /[\r\n\x1b]/.test(args)) throw new ConductError('bad-request', 'os argumentos do comando têm de caber numa linha')
    const seen = await seeScreen(ctx)
    refuseOverCard(seen, `rodar /${name}`)
    const line = `/${name}${args ? ` ${args}` : ''}`
    await ctx.write([{ data: line }, { data: '\r', waitMs: ENTER_DELAY_MS }])
    const idle = seen.kind === 'idle' || seen.kind === 'interrupted'
    return { value: undefined, proven: name === 'clear' || (name === 'compact' && idle) }
  },

  async detect(ctx: ConductorContext): Promise<Detected> {
    const seen = await seeScreen(ctx)
    if (hasCard(seen)) return { state: seen.kind, card: seen.card }
    // An interrupted agent is stopped: for the owner that is idle.
    if (seen.kind === 'interrupted') return { state: 'idle' }
    return { state: seen.kind }
  },

  /** The answer the `Stop` hook wrote (K2): the file of the pane, replaced each turn; `at` is the hook's `ts`. */
  async lastAnswer(ctx: ConductorContext): Promise<Proven<LastAnswer> | undefined> {
    const raw = await ctx.io.tryReadText(targetAnswerFile(ctx))
    if (!raw) return undefined
    let file: { ts?: unknown; text?: unknown; from?: unknown; sessionId?: unknown }
    try { file = JSON.parse(raw) as typeof file } catch { return undefined }
    if (typeof file.text !== 'string' || file.text.trim() === '') return undefined
    const t = typeof file.ts === 'number' ? file.ts : typeof file.ts === 'string' ? Date.parse(file.ts) : Number.NaN
    if (Number.isNaN(t)) return undefined
    return {
      value: {
        text: file.text,
        at: new Date(t).toISOString(),
        source: typeof file.from === 'string' ? file.from : 'claude-stop',
        ...(typeof file.sessionId === 'string' ? { turn: file.sessionId } : {}),
      },
      proven: true,
    }
  },
}
