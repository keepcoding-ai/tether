// Managing a channel from afar (RR5, fio-spec 18), the pure rules: whether the channel's view manages at all and whether it
// closes (the device's scopes), the app's dialogs put on the web's box (DialogSpec to the box's Question), the agents the
// "Chamar agente…" picker offers (the house's tree as the app's agents list), and the sentence of a refusal: the channels'
// own words for the channels' codes, the web's for what the distance adds (no app, the session, the pace). No DOM.
import type { DialogSpec } from '../../../app/shared/dialog.ts'
import type { RegencyInput } from '../../../extensions/regency/model.ts'
import { failedDialog, type AgentChoice } from '../../../extensions/channels/renderer/texts.ts'
import { refusalWords, type Caps, type Question } from './manage-rules.ts'

/** What the channel's view may manage on this device: nothing without `channels`; closing needs `manage:destructive`. */
export function channelAfarOf(caps: Caps): { close: boolean } | undefined {
  return caps.channels ? { close: caps.destructive } : undefined
}

/** The codes the channels' rules answer (extensions/channels/renderer/texts.ts REFUSALS), said in their own words. */
const CHANNEL_CODES: ReadonlySet<string> = new Set([
  'not-owner', 'closed', 'not-closed', 'desk', 'removed', 'unknown-agent', 'unknown-channel', 'name-taken', 'bad-name', 'not-member',
])

/** The app's "could not" dialog, with the distance's own sentence when the code is the web's (no app, timeout, locked…). */
export function failedAfar(what: string, code: string): DialogSpec {
  if (CHANNEL_CODES.has(code)) return failedDialog(what, code)
  return { ...failedDialog(what, code), message: refusalWords(code) }
}

/** The plain words of a channel's refusal: the channels' for their codes, else the web's. */
export function channelRefusal(code: string): string {
  return CHANNEL_CODES.has(code) ? (failedDialog('', code).message ?? '') : refusalWords(code)
}

/**
 * An app's dialog on the web's box: the title, the context, the message as the lead, the choices with their consequences,
 * the cancel (none when the dialog has only its answer, as "Entendi"). `proof`: the choices that travel with the proof of
 * the act, so the box says "Para isso, o tether pede a biometria deste aparelho." before its buttons.
 */
export function questionOf(spec: DialogSpec, proof: readonly string[] = []): Question {
  const c = spec.context
  return {
    title: spec.title,
    ...(c ? { context: { name: c.name, lines: [...c.lines], ...(c.status ? { status: c.status.label } : {}) } } : {}),
    ...(spec.message ? { lead: spec.message } : {}),
    choices: spec.choices.map(x => ({ id: x.id, label: x.label, consequence: x.consequence, tone: x.tone, ...(proof.includes(x.id) ? { proof: true as const } : {}) })),
    cancel: spec.cancelLabel ?? '',
  }
}

/**
 * The house's agents as the app's "Chamar agente…" reads them (commands.ts `agents`): each with its desk (the tree's pane of
 * it) and whether it runs. An agent no desk of the tree shows is "sem mesa".
 */
export function agentChoicesOf(input: Pick<RegencyInput, 'agents' | 'desks'>): AgentChoice[] {
  return input.agents.map(a => {
    for (const d of input.desks.desks) {
      const p = d.panes.find(x => x.id === a.id)
      if (!p) continue
      const alive = p.exited !== true && p.asleep !== true
      return { slotId: a.id, kind: a.kind, name: a.name, alive, ...(d.kind === 'queue' ? { deskId: d.id, deskTitle: d.name } : {}) }
    }
    return { slotId: a.id, kind: a.kind, name: a.name, alive: true, placed: false as const }
  })
}

/** The brief notice after calling agents into a channel ("conferente chamado a #obra."), or undefined when none came in. */
export function joinedText(names: readonly string[], channel: string): string | undefined {
  if (names.length === 0) return undefined
  const list = names.length < 2 ? names[0]! : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
  return `${list} ${names.length === 1 ? 'chamado' : 'chamados'} a #${channel}.`
}

/** The brief notice after a gesture on a member or the channel, in the web's toast (the app shows the line in the channel). */
export function doneText(kind: 'mute' | 'unmute' | 'remove' | 'close' | 'reopen', channel: string, member?: string): string {
  switch (kind) {
    case 'mute': return `${member ?? 'O agente'} calado em #${channel}.`
    case 'unmute': return `${member ?? 'O agente'} tem a voz de volta em #${channel}.`
    case 'remove': return `${member ?? 'O agente'} saiu de #${channel}.`
    case 'close': return `#${channel} encerrado.`
    case 'reopen': return `#${channel} reaberto.`
  }
}
