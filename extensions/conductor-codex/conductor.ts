// The Codex conductor (tether for agents, contract 5.3): only what is the engine's. `type`, `keys` and `read` are absent and fall to the
// terminal conductor. Every byte goes through `ctx.write` / `ctx.keys` (the gate). The bytes and waits are the sonda's of 21/11
// (Codex 0.169.0): one line = text, 300 ms, `\r` (130 and 150 ms are taken as a paste and do not submit); several lines = a bracketed
// paste, 400 ms, `\r`; typing while a turn runs queues the message in the same turn; `esc` once interrupts; on the approval card `y`
// approves, `p` approves "always", `esc` denies and aborts the turn, all with no Enter; `/compact` is a line, 500 ms, `\r`, and only
// runs idle (busy it is refused by Codex, and not queued). The approval request is NOT told by Codex's `notify`: only the screen shows
// it (the watch calls `detect`). The last answer is the K2 file of the pane (`codex-notify`, never the title notice).
// What no probe proved is marked `proven: false`.
import { slotAnswerPath } from '../../src/core/paths.ts'
import type { KeyName } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { ConductError, type Conductor, type ConductorContext, type ConductorTarget, type Detected, type LastAnswer, type Proven } from '../for-agents/conductor-api.ts'
import { winKeyEvents } from '../codex/typing.ts'
import { alnum, composerDraft, echoedAbove, hasAll, NEW_CONVERSATION_DIALOG, readCodexScreen, UPDATE_DIALOG, type ParsedOption, type Seen } from './screen.ts'

export const CODEX_CONDUCTOR_ID = 'codex'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** The Enter must come this long after the text: nearer than ~170 ms Codex takes both as one paste and does not submit. */
export const ENTER_DELAY_MS = 300
const PASTE_ENTER_DELAY_MS = 400
const COMMAND_ENTER_DELAY_MS = 500
const BOOT_MAX_MS = 90_000
const BOOT_POLL_MS = 300
const INTERRUPT_POLL_MS = 250
const INTERRUPT_MAX_MS = 6000
const NEW_DIALOG_MAX_MS = 3000
/** An Enter that Codex did not take leaves the text in the box (seen with a 137-character line): look after this long, press Enter again, at most this many times. */
const SUBMIT_CHECK_MS = 800
const SUBMIT_RETRIES = 3
const SUBMIT_POLL_MS = 200
const SUBMIT_MAX_MS = 8000

/** A TOML basic string (JSON's escapes are valid TOML), the value of a `-c key=value`. */
const tomlString = (s: string): string => JSON.stringify(s)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const asConduct = (e: unknown): e is ConductError => e instanceof ConductError

async function seeScreen(ctx: ConductorContext): Promise<Seen> {
  return readCodexScreen((await ctx.screen()).screen)
}

const hasCard = (s: Seen): s is Extract<Seen, { card: unknown }> => s.kind === 'permission' || s.kind === 'dialog'

/** The screen can miss the "Working" line while the text streams: the slot's own turn says it too. */
const running = (ctx: ConductorContext, s: Seen): boolean => s.kind === 'busy' || (s.kind !== 'unknown' && ctx.slot()?.turn === 'busy')

/** A card takes `y`, `p` and Esc as answers: text typed then would approve, so nothing is typed. */
function refuseOverCard(s: Seen, what: string): void {
  if (hasCard(s)) throw new ConductError('busy', `há um pedido na tela desta guia (${s.card.title || s.kind}): responda com \`answer\` antes de ${what}`)
}

/**
 * After the text and its Enter, the send counts only on evidence that Codex took it: the composer no longer holds the text AND the
 * screen shows the turn (the "esc to interrupt" line) or the message echoed in the transcript above the composer. An empty box
 * alone is not evidence (the text may not be drawn yet). While the text stays in the box the Enter was not taken: it is pressed
 * again (only then, so a message is never sent twice), SUBMIT_CHECK_MS apart, at most SUBMIT_RETRIES times. No evidence by
 * SUBMIT_MAX_MS, or the text still in the box after the last Enter: `unsent`. Returns how many extra Enters it took.
 */
async function ensureSubmitted(ctx: ConductorContext, text: string): Promise<number> {
  const all = alnum(text)
  const head = all.slice(0, 20)
  // Long enough to carry the envelope's message id: an earlier message of the same owner in the history is not this one.
  const echo = all.slice(0, 60)
  const deadline = Date.now() + SUBMIT_MAX_MS
  let retries = 0
  let enterAt = Date.now()
  for (;;) {
    await sleep(SUBMIT_POLL_MS)
    const { screen, history } = await ctx.screen()
    const draft = composerDraft(screen)
    const stuck = draft !== undefined && alnum(draft).startsWith(head)
    if (!stuck && (readCodexScreen(screen).kind === 'busy' || echoedAbove(screen, history, echo))) return retries
    if (stuck && Date.now() - enterAt >= SUBMIT_CHECK_MS) {
      if (retries >= SUBMIT_RETRIES) throw new ConductError('unsent', 'o texto ficou na caixa do Codex: o Enter não foi aceito')
      await ctx.write([{ data: '\r' }])
      retries++
      enterAt = Date.now()
    }
    if (Date.now() >= deadline) throw new ConductError('unsent', stuck ? 'o texto ficou na caixa do Codex: o Enter não foi aceito' : 'o Codex não mostrou o turno começando depois do Enter')
  }
}

/** The text of one line, or the lines as a bracketed paste; the escape characters of the text never reach the terminal. */
export function sendChunks(text: string, platform: NodeJS.Platform = process.platform): { data: string; waitMs?: number }[] {
  const asKeyEvents = platform === 'win32' ? winKeyEvents : (s: string): string => s
  const clean = text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (clean.trim() === '') throw new ConductError('bad-request', 'send: texto vazio')
  const lines = clean.split('\n')
  if (lines.length === 1) return [{ data: asKeyEvents(clean) }, { data: '\r', waitMs: ENTER_DELAY_MS }]
  return [{ data: `${PASTE_START}${asKeyEvents(lines.join('\r'))}${PASTE_END}` }, { data: '\r', waitMs: PASTE_ENTER_DELAY_MS }]
}

/** What an `answer` choice does on this card: a key named on the screen (`y`, `p`) or Esc, with whether a probe proved it. */
function actionFor(seen: Extract<Seen, { card: unknown }>, choice: string): { act: 'key' | 'esc' | 'move'; data: string; proven: boolean; moves?: KeyName[] } {
  const options: ParsedOption[] = seen.options
  const viaOption = (o: ParsedOption): { act: 'key' | 'esc' | 'move'; data: string; proven: boolean; moves?: KeyName[] } => {
    if (seen.list) {
      // The MCP tool card has no key per option: Cancel is Esc ("esc to cancel"); the others move the selection, then Enter.
      if (o.role === 'no') return { act: 'esc', data: '', proven: false }
      const delta = o.n - seen.list.selected
      const step: KeyName = delta < 0 ? 'up' : 'down'
      return { act: 'move', data: '', proven: false, moves: [...Array<KeyName>(Math.abs(delta)).fill(step), 'enter'] }
    }
    if (o.key === 'esc') return { act: 'esc', data: '', proven: seen.kind === 'permission' }
    if (o.key) return { act: 'key', data: o.key, proven: seen.kind === 'permission' }
    // No key on the screen for this option: the digit is the way (unproven on Codex's lists).
    return { act: 'key', data: String(o.n), proven: false }
  }
  if (/^[1-9][0-9]*$/.test(choice)) {
    const hit = options.find((o) => o.n === Number(choice))
    if (!hit) throw new ConductError('bad-request', `não há a opção ${choice} neste pedido`)
    return viaOption(hit)
  }
  if (seen.kind === 'permission') {
    const hit = options.find((o) => o.role === choice)
    if (choice === 'no') return hit ? viaOption(hit) : { act: 'esc', data: '', proven: !seen.list }
    if (!hit) throw new ConductError('unsupported', `este pedido não tem a opção ${choice}`)
    return viaOption(hit)
  }
  if (choice === 'no') return { act: 'esc', data: '', proven: false }
  throw new ConductError('bad-request', 'diálogo: responda com o número da opção')
}

function targetAnswerFile(ctx: ConductorContext): string {
  return slotAnswerPath(ctx.home, ctx.target.paneId)
}

export const codexConductor: Conductor = {
  id: CODEX_CONDUCTOR_ID,
  match: (t: ConductorTarget) => (t.type === 'terminal' && t.slot?.kind === 'codex' ? 10 : undefined),
  capabilities: [
    { id: 'send', label: 'Enviar texto digitado' },
    { id: 'interrupt', label: 'Interromper' },
    { id: 'answer', label: 'Responder permissão' },
    { id: 'command', label: 'Comandos de barra' },
  ],
  watch: true,

  /**
   * `-c` overrides, this launch only. The update check and the folder's trust are off as the sonda launched it (no update dialog, no
   * trust dialog). `--model` and the effort (`model_reasoning_effort`; Codex has no effort flag) are the sonda's with `low`.
   * NOTE: the `open` verb calls this only when a model or an effort is asked for.
   */
  launchArgs(req): Proven<string[]> {
    const args: string[] = ['-c', 'check_for_update_on_startup=false', '-c', `projects.${tomlString(req.cwd.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`))}.trust_level="trusted"`]
    if (req.model) args.push('-c', `model=${tomlString(req.model)}`)
    if (req.effort) args.push('-c', `model_reasoning_effort=${tomlString(req.effort)}`)
    return { value: args, proven: req.effort === undefined || req.effort === 'low' }
  },

  /**
   * The update dialog of a Codex that has a newer version, when the launch had no `check_for_update_on_startup=false`: Esc skips it
   * (Enter would run `npm install -g`, so Enter is never sent), only when every fragment is on the screen, once. Then it waits for the
   * composer. Ends with the composer, the slot's end, or after BOOT_MAX_MS.
   */
  async boot(ctx: ConductorContext): Promise<void> {
    const deadline = Date.now() + BOOT_MAX_MS
    let skipped = false
    while (Date.now() < deadline) {
      const slot: SlotState | undefined = ctx.slot()
      if (!slot || slot.status === 'exited' || slot.status === 'error') return
      const screen = (await ctx.screen()).screen
      if (!skipped && hasAll(screen, UPDATE_DIALOG)) {
        try {
          await ctx.keys(['esc'])
          skipped = true
          ctx.log('boot: diálogo de atualização dispensado')
        } catch (e) {
          // The pane is not in the owner's desk yet (the app adds it a moment after `open`): try again.
          if (!(asConduct(e) && e.code === 'not-commanded')) throw e
        }
      } else {
        const seen = readCodexScreen(screen)
        if (seen.kind === 'idle' || seen.kind === 'busy' || seen.kind === 'interrupted') return
      }
      await sleep(BOOT_POLL_MS)
    }
    ctx.log('boot: o prompt não apareceu a tempo')
  },

  async send(ctx: ConductorContext, text: string): Promise<Proven<void>> {
    const chunks = sendChunks(text)
    refuseOverCard(await seeScreen(ctx), 'enviar texto')
    await ctx.write(chunks)
    const retries = await ensureSubmitted(ctx, text)
    if (retries > 0) ctx.log(`send: o Enter não foi aceito de primeira; repetido ${retries}x`)
    return { value: undefined, proven: true }
  },

  /** `esc` once, then reread the screen: stopped when the turn is no longer running. */
  async interrupt(ctx: ConductorContext): Promise<Proven<{ stopped: boolean }>> {
    await ctx.keys(['esc'])
    const end = Date.now() + INTERRUPT_MAX_MS
    while (Date.now() < end) {
      await sleep(INTERRUPT_POLL_MS)
      const seen = await seeScreen(ctx)
      if (seen.kind === 'interrupted' || (seen.kind === 'idle' && ctx.slot()?.turn !== 'busy')) return { value: { stopped: true }, proven: true }
    }
    return { value: { stopped: false }, proven: true }
  },

  async answer(ctx: ConductorContext, choice: string): Promise<Proven<void>> {
    const seen = await seeScreen(ctx)
    if (!hasCard(seen)) throw new ConductError('no-request', 'não há pedido na tela desta guia')
    const what = actionFor(seen, choice)
    if (what.act === 'esc') await ctx.keys(['esc'])
    else if (what.act === 'move') await ctx.keys(what.moves!, { gapMs: 80 })
    else await ctx.write([{ data: what.data }])
    return { value: undefined, proven: what.proven }
  },

  /** `/name args` typed as a line, 500 ms before the Enter. Only idle: Codex refuses a command mid-turn and does not queue it. */
  async command(ctx: ConductorContext, name: string, args?: string): Promise<Proven<void>> {
    if (!/^[A-Za-z][\w:.-]*$/.test(name)) throw new ConductError('bad-request', `comando inválido: ${JSON.stringify(name)}`)
    if (args !== undefined && /[\r\n\x1b]/.test(args)) throw new ConductError('bad-request', 'os argumentos do comando têm de caber numa linha')
    const seen = await seeScreen(ctx)
    refuseOverCard(seen, `rodar /${name}`)
    if (running(ctx, seen)) throw new ConductError('busy', `o Codex só roda /${name} com a guia ociosa; nada foi digitado`)
    await ctx.write([{ data: `/${name}${args ? ` ${args}` : ''}` }, { data: '\r', waitMs: COMMAND_ENTER_DELAY_MS }])
    if (name === 'new') {
      // Inside a git repository `/new` asks where the conversation runs: option 1 is the selected one.
      const end = Date.now() + NEW_DIALOG_MAX_MS
      while (Date.now() < end) {
        await sleep(INTERRUPT_POLL_MS)
        if (hasAll((await ctx.screen()).screen, NEW_CONVERSATION_DIALOG)) { await ctx.keys(['enter']); break }
      }
    }
    return { value: undefined, proven: name === 'compact' }
  },

  async detect(ctx: ConductorContext): Promise<Detected> {
    const seen = await seeScreen(ctx)
    if (hasCard(seen)) return { state: seen.kind, card: seen.card }
    if (running(ctx, seen)) return { state: 'busy' }
    // An interrupted agent is stopped: for the owner that is idle.
    if (seen.kind === 'interrupted') return { state: 'idle' }
    return { state: seen.kind }
  },

  /** The answer the notify reporter wrote (K2): the file of the pane, replaced each turn (the title notice never writes it). */
  async lastAnswer(ctx: ConductorContext): Promise<Proven<LastAnswer> | undefined> {
    const raw = await ctx.io.tryReadText(targetAnswerFile(ctx))
    if (!raw) return undefined
    let file: { ts?: unknown; text?: unknown; from?: unknown; sessionId?: unknown; turnId?: unknown }
    try { file = JSON.parse(raw) as typeof file } catch { return undefined }
    if (typeof file.text !== 'string' || file.text.trim() === '') return undefined
    const t = typeof file.ts === 'number' ? file.ts : typeof file.ts === 'string' ? Date.parse(file.ts) : Number.NaN
    if (Number.isNaN(t)) return undefined
    const turn = typeof file.turnId === 'string' ? file.turnId : typeof file.sessionId === 'string' ? file.sessionId : undefined
    return {
      value: { text: file.text, at: new Date(t).toISOString(), source: typeof file.from === 'string' ? file.from : 'codex-notify', ...(turn ? { turn } : {}) },
      proven: true,
    }
  },
}
