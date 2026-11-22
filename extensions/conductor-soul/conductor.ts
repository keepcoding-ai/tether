// The Soul conductor (tether for agents, contract 5.3): only what is the engine's. `type`, `keys` and `read` are absent and fall to
// the terminal conductor. Every byte goes through `ctx.write` / `ctx.keys` (the gate). The bytes and waits are the sonda's of 21/11
// (soul 0.1.188): one line = text, 130 ms, `\r`; several lines = a bracketed paste then `\r`; typing while a turn runs queues the
// message for the next turn; `esc` once interrupts; the permission card has only `1. Yes` and `2. No` and the digit acts with no
// Enter; there is no "always"; `/compact` and `/clear` are a line cleared with Ctrl+U first; the last answer is in the local
// session (`.soul/profiles/<profile>/sessions/<id>/session.jsonl`), which exists when the Soul runs in process (`-g`, no `-H`).
// What no probe proved is marked `proven: false`.
import { join } from 'node:path'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { ConductError, type Conductor, type ConductorContext, type ConductorTarget, type Detected, type LastAnswer, type Proven } from '../for-agents/conductor-api.ts'
import { readSoulScreen, type ParsedOption, type Seen } from './screen.ts'

export const SOUL_CONDUCTOR_ID = 'soul'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const CTRL_U = '\x15'
const ENTER_DELAY_MS = 130
const BOOT_MAX_MS = 90_000
const BOOT_POLL_MS = 300
const INTERRUPT_POLL_MS = 250
const INTERRUPT_MAX_MS = 6000
/**
 * The Soul reports `turn idle` a few hundred ms AFTER the timestamp of its last answer line, but the line reaches the session file
 * after the report (seen in the E2E: the file had no answer at idle + 20 ms). Right after a turn, the answer of that turn is waited
 * for: a text whose timestamp is no earlier than the idle edge minus ANSWER_LEAD_MS, for at most SETTLE_MAX_MS.
 */
const ANSWER_LEAD_MS = 3000
const SETTLE_MAX_MS = 3000
const SETTLE_POLL_MS = 200
const SETTLE_RECENT_MS = 5000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const asConduct = (e: unknown): e is ConductError => e instanceof ConductError

async function seeScreen(ctx: ConductorContext): Promise<Seen> {
  return readSoulScreen((await ctx.screen()).screen)
}

const hasCard = (s: Seen): s is Extract<Seen, { kind: 'permission' | 'question' }> => s.kind === 'permission' || s.kind === 'question'

/** A card on the screen takes digits as answers: nothing is typed over it. */
function refuseOverCard(s: Seen, what: string): void {
  if (s.kind === 'permission' || s.kind === 'question' || s.kind === 'dialog') {
    throw new ConductError('busy', `há um pedido na tela desta guia (${s.card.title || s.kind}): responda com \`answer\` antes de ${what}`)
  }
}

/** The text of one line, or the lines as a bracketed paste; the escape characters of the text never reach the terminal. */
export function sendChunks(text: string): { data: string; waitMs?: number }[] {
  const clean = text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (clean.trim() === '') throw new ConductError('bad-request', 'send: texto vazio')
  const lines = clean.split('\n')
  if (lines.length === 1) return [{ data: clean }, { data: '\r', waitMs: ENTER_DELAY_MS }]
  return [{ data: `${PASTE_START}${lines.join('\r')}${PASTE_END}` }, { data: '\r', waitMs: ENTER_DELAY_MS }]
}

/** The digit an `answer` choice means on this card. */
function digitFor(seen: Extract<Seen, { kind: 'permission' | 'question' }>, choice: string): string {
  const options: ParsedOption[] = seen.options
  if (/^[1-9][0-9]*$/.test(choice)) {
    if (!options.some((o) => o.n === Number(choice))) throw new ConductError('bad-request', `não há a opção ${choice} neste pedido`)
    return choice
  }
  if (seen.kind === 'permission') {
    if (choice === 'always') throw new ConductError('unsupported', 'o Soul não tem "sempre permitir" no pedido; o equivalente é trocar o modo (shift+tab), e isso o condutor não faz')
    const hit = options.find((o) => o.role === choice)
    if (!hit || hit.n === undefined) throw new ConductError('bad-request', `este pedido não tem a opção ${choice}`)
    return String(hit.n)
  }
  throw new ConductError('bad-request', 'pergunta: responda com o número da opção')
}

/** `-P <profile>` of a recipe's arguments, when the Soul wrote one. */
function profileOf(args: readonly string[] | undefined): string | undefined {
  const i = args?.indexOf('-P') ?? -1
  return i >= 0 ? args![i + 1] : undefined
}

/** The folder of the session: `<being>/.soul/profiles/<profile>/sessions/<id>`. The profile comes from `-P`, else from the one that has the session. */
async function sessionDir(ctx: ConductorContext, slot: SlotState, sessionId: string): Promise<string | undefined> {
  const roots = [...new Set([slot.binding?.cwd, slot.folder, slot.cwd].filter((x): x is string => !!x))]
  const named = profileOf(slot.binding?.resume?.args)
  for (const root of roots) {
    const profiles = join(root, '.soul', 'profiles')
    let candidates: string[]
    if (named) candidates = [named]
    else {
      try { candidates = (await ctx.io.readdir(profiles)).filter((e) => e.isDirectory).map((e) => e.name) } catch { continue }
    }
    for (const p of candidates) {
      const dir = join(profiles, p, 'sessions', sessionId)
      if (await ctx.io.exists(join(dir, 'session.jsonl'))) return dir
    }
  }
  return undefined
}

interface JsonlLine { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }

/** The last assistant line with text: its text blocks joined, and its timestamp. */
export function lastAssistantText(jsonl: string): { text: string; at: string } | undefined {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!.trim()
    if (!raw.includes('"assistant"')) continue
    let line: JsonlLine
    try { line = JSON.parse(raw) as JsonlLine } catch { continue }
    if (line.type !== 'assistant' || !Array.isArray(line.message?.content)) continue
    const text = (line.message!.content as { type?: unknown; text?: unknown }[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string).join('\n').trim()
    const t = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN
    if (text !== '' && !Number.isNaN(t)) return { text, at: new Date(t).toISOString() }
  }
  return undefined
}

export const soulConductor: Conductor = {
  id: SOUL_CONDUCTOR_ID,
  match: (t: ConductorTarget) => (t.type === 'terminal' && t.slot?.kind === 'soul' ? 10 : undefined),
  capabilities: [
    { id: 'send', label: 'Enviar texto digitado' },
    { id: 'interrupt', label: 'Interromper' },
    { id: 'answer', label: 'Responder permissão' },
    { id: 'command', label: 'Comandos de barra' },
  ],
  watch: true,

  /** `--model` and `--effort` ran in the sonda. `-P` is not here: the request carries no profile (the owner passes it in `args`). */
  launchArgs(req): Proven<string[]> {
    const args: string[] = []
    if (req.model) args.push('--model', req.model)
    if (req.effort) args.push('--effort', req.effort)
    return { value: args, proven: true }
  },

  /**
   * The first-open dialogs: the trust one (Enter on `Yes, I trust this folder`) and the profile one (Enter on the highlighted named
   * profile; any other row is left to the person). Each is answered once, only with the whole dialog on the screen. Ends with the
   * composer, the slot's end, or after BOOT_MAX_MS.
   */
  async boot(ctx: ConductorContext): Promise<void> {
    const deadline = Date.now() + BOOT_MAX_MS
    const answered = new Set<string>()
    while (Date.now() < deadline) {
      const slot = ctx.slot()
      if (!slot || slot.status === 'exited' || slot.status === 'error') return
      const seen = await seeScreen(ctx)
      if (seen.kind === 'dialog') {
        if (seen.dialog === 'profile' && !seen.onProfile) { ctx.log('boot: o diálogo de perfil não está num perfil nomeado; fica para a pessoa'); return }
        if (!answered.has(seen.dialog)) {
          try {
            await ctx.keys(['enter'])
            answered.add(seen.dialog)
            ctx.log(`boot: diálogo ${seen.dialog === 'trust' ? 'de confiança' : 'de perfil'} respondido`)
            await sleep(1000)
          } catch (e) {
            // The pane is not in the owner's desk yet (the app adds it a moment after `open`): try again.
            if (!(asConduct(e) && e.code === 'not-commanded')) throw e
          }
        }
      } else if (seen.kind === 'idle' || seen.kind === 'busy') return
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

  /** `esc` once, then reread the screen: stopped when the composer is back with no turn running. */
  async interrupt(ctx: ConductorContext): Promise<Proven<{ stopped: boolean }>> {
    await ctx.keys(['esc'])
    const end = Date.now() + INTERRUPT_MAX_MS
    while (Date.now() < end) {
      await sleep(INTERRUPT_POLL_MS)
      if ((await seeScreen(ctx)).kind === 'idle') return { value: { stopped: true }, proven: true }
    }
    return { value: { stopped: false }, proven: true }
  },

  /** `1` or `2` with no Enter. `always` does not exist: the error, and nothing is typed. */
  async answer(ctx: ConductorContext, choice: string): Promise<Proven<void>> {
    const seen = await seeScreen(ctx)
    if (!hasCard(seen)) throw new ConductError('no-request', 'não há pedido na tela desta guia')
    const digit = digitFor(seen, choice)
    await ctx.write([{ data: digit }])
    return { value: undefined, proven: seen.kind === 'permission' }
  },

  /** Ctrl+U, `/name args`, Enter. Compact and clear, idle and busy, are the sonda's; any other command is not. */
  async command(ctx: ConductorContext, name: string, args?: string): Promise<Proven<void>> {
    if (!/^[A-Za-z][\w:.-]*$/.test(name)) throw new ConductError('bad-request', `comando inválido: ${JSON.stringify(name)}`)
    if (args !== undefined && /[\r\n\x1b]/.test(args)) throw new ConductError('bad-request', 'os argumentos do comando têm de caber numa linha')
    refuseOverCard(await seeScreen(ctx), `rodar /${name}`)
    const line = `/${name}${args ? ` ${args}` : ''}`
    await ctx.write([{ data: CTRL_U }, { data: line }, { data: '\r', waitMs: ENTER_DELAY_MS }])
    return { value: undefined, proven: name === 'compact' || name === 'clear' }
  },

  async detect(ctx: ConductorContext): Promise<Detected> {
    const seen = await seeScreen(ctx)
    if (seen.kind === 'permission' || seen.kind === 'question' || seen.kind === 'dialog') return { state: seen.kind, card: seen.card }
    return { state: seen.kind }
  },

  /** The local session's last assistant text; `at` is that line's timestamp (the notices compare it with the turn's start). */
  async lastAnswer(ctx: ConductorContext): Promise<Proven<LastAnswer> | undefined> {
    const slot = ctx.slot() ?? ctx.target.slot
    const sessionId = slot?.binding?.sessionId
    if (!slot || !sessionId) return undefined
    const dir = await sessionDir(ctx, slot, sessionId)
    if (!dir) return undefined
    const file = join(dir, 'session.jsonl')
    const idleAt = slot.idleSince ? Date.parse(slot.idleSince) : Number.NaN
    const justEnded = slot.turn !== 'busy' && !Number.isNaN(idleAt) && Date.now() - idleAt <= SETTLE_RECENT_MS
    const end = Date.now() + SETTLE_MAX_MS
    let found: { text: string; at: string } | undefined
    for (;;) {
      const raw = await ctx.io.tryReadText(file)
      found = raw ? lastAssistantText(raw) : undefined
      if (!justEnded || (found && Date.parse(found.at) >= idleAt - ANSWER_LEAD_MS) || Date.now() >= end) break
      await sleep(SETTLE_POLL_MS)
    }
    if (!found) return undefined
    return { value: { text: found.text, at: found.at, source: 'session', turn: sessionId }, proven: true }
  },
}
