// The tether's own lines in a channel (contract 1.2, 2.4, 2.5, 6.3): one line each, in Portuguese, and never a word written by
// someone else. What a notice may name: the room, a pane's name (its tab, as slotTitle shows it), the moderator's name,
// counts, an hour and a seq. Two kinds of text live here: the LINE every member and the channel's pane read (third person:
// "X entrou em #obra"), and the NOTICE the agent it is about gets ("você entrou em #obra"). Pure: no imports.

import { DOOR_MCP_SERVER } from '../../../src/daemon/door/types.ts'
import { VERB_NS } from '../manifest.ts'

/** A channels tool as Claude Code names it: `mcp__<server>__<ns>_<verb>` (the registry's own naming). */
export const claudeToolName = (verb: string): string => `mcp__${DOOR_MCP_SERVER}__${VERB_NS}_${verb}`

/** The sender of every notice of the channels. */
export const SYSTEM_FROM = { name: 'tether', id: 'tether', role: 'system' } as const

/** The moderator's default name (setting `extensions.channels.moderatorName`). */
export const MODERATOR_NAME = 'usuário'

/** How many speakers a merged notice names before "e mais N". */
export const NAMES_SHOWN = 5

// A pane that does not hear inside is taught the tool only when the door KNOWS its client has the tether's MCP tools (`tools`,
// from `delivery.hasTools`: sticky, true once its stream opened). Otherwise `tools` false means "not known", not "none", so both
// ways are taught, tool first: a sandboxed client (Codex) may be denied the CLI's pipe while the tool works.
/** The way to speak in `room` from a pane that does not hear inside (the ronda writes the CLI form the same way). */
const sayHow = (room: string, tools: boolean): string =>
  tools ? `pela ferramenta channels_say (room "${room}")` : `pela ferramenta channels_say (room "${room}") ou node "$TETHER_CLI" channels say ${room} "<texto>"`
/** The way to read `room` from such a pane; `since` narrows it to what came after that seq. */
const readHow = (room: string, tools: boolean, since?: number): string => {
  const tool = `pela ferramenta channels_read (room "${room}"${since === undefined ? '' : `, since ${since}`})`
  return tools ? tool : `${tool} ou node "$TETHER_CLI" channels read ${room}${since === undefined ? '' : ` --since ${since}`}`
}
/** The how-to line a pane that does not hear inside needs. */
function cliHint(room: string, tools: boolean): string {
  return `para falar: ${sayHow(room, tools)}; para ler o que perdeu: ${readHow(room, tools)}${tools ? '' : ' (no PowerShell, $env:TETHER_CLI)'}`
}

/**
 * The last line of a SPOKEN message delivered to a pane that does not hear inside (typed in its terminal): what it writes in its
 * own tab reaches nobody in the channel, and how to speak there. Notices and the `inside` road are left as they are.
 */
export function withReplyHint(body: string, room: string, path: 'inside' | 'terminal' | 'wait', tools = false): string {
  if (path === 'inside') return body
  return `${body.replace(/\n+$/, '')}\n(para responder no canal: o que você escreve na sua guia ninguém no canal vê; fale ${sayHow(room, tools)})`
}

/** HH:MM, local time. */
export function hourOf(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function namesOf(names: readonly string[], shown: number = NAMES_SHOWN): string {
  if (names.length <= shown) return names.join(', ')
  return `${names.slice(0, shown).join(', ')} e mais ${names.length - shown}`
}

// ---- the lines (the record, and what the other members get) -----------------------------------

export const createdLine = (room: string, who: string): string => `${who} abriu #${room}`
export const joinedLine = (room: string, who: string): string => `${who} entrou em #${room}`
export const leftLine = (room: string, who: string): string => `${who} saiu de #${room}`
export const forgottenLine = (room: string, who: string): string => `${who} saiu de #${room} (a guia foi fechada)`
export const removedLine = (room: string, who: string): string => `${who} foi tirado de #${room}`
export const mutedLine = (room: string, who: string, by: string): string => `${who} foi calado em #${room} por ${by}`
export const unmutedLine = (room: string, who: string): string => `${who} pode falar de novo em #${room}`
export const closedLine = (room: string, by: string): string => `#${room} foi encerrado por ${by}`
export const reopenedLine = (room: string, by: string): string => `#${room} foi reaberto por ${by}`
// The desk channel's own lines: it follows its desk, nobody opens or closes it by hand. The desk's name is the person's text
// and never goes in a notice: the room says which desk.
export const deskCreatedLine = (room: string, owner: string): string => `#${room} nasceu com a mesa · owner: ${owner}`
/** `was`: the room it had, when another open channel took it while this one was closed. */
export const deskReopenedLine = (room: string, owner: string, was?: string): string =>
  `#${room} foi reaberto: a mesa é de ${owner}${was ? ` (antes #${was}; o nome estava tomado)` : ''}`
export const ownerChangedLine = (room: string, owner: string): string => `#${room} agora é de ${owner}`
const DESK_CLOSED_WHY = { revoked: 'a mesa ficou sem dono', ended: 'a guia dona da mesa foi fechada', gone: 'a mesa foi fechada' } as const
export type DeskClosedWhy = keyof typeof DESK_CLOSED_WHY
export const deskClosedLine = (room: string, why: DeskClosedWhy): string => `#${room} foi encerrado: ${DESK_CLOSED_WHY[why]}`
/** Who joins a pane to the desk channel, as the join notice names it. */
export const DESK_JOINER = 'a mesa'

export const ownerEndedLine =(room: string, who: string, moderator: string): string => `${who} deixou de ser o owner de #${room}; quem o comanda agora é ${moderator}`

// ---- the notices to the agent it is about -------------------------------------------------------

export const createdNotice = (room: string): string => `você abriu #${room} e é o owner dele`

/**
 * To the agent that joined. `by` absent: it joined itself. `path` is the delivery's `routeOf` (the road, not the instant): a pane that does not hear
 * inside learns how to speak by the CLI, and one that hears nothing now (`wait`) is told the lines wait for it.
 */
export function joinedNotice(room: string, by: string | undefined, members: readonly string[], path: 'inside' | 'terminal' | 'wait', tools = false): string {
  let text = `você entrou em #${room}${by ? ` (por ${by})` : ''} · members: ${namesOf(members, 12) || 'só você'}`
  if (path === 'inside') text += ` · para responder no canal chame a ferramenta ${claudeToolName('say')} (se ela não estiver carregada, carregue-a antes pela busca de ferramentas); o texto do seu turno não vai ao canal`
  else text += ` · ${cliHint(room, tools)}; o texto do seu turno não vai ao canal`
  if (path === 'wait') text += ' · agora esta guia não ouve as falas: elas esperam até ela poder ouvir, juntadas num aviso só'
  return text
}

export const removedNotice = (room: string, by: string): string => `você foi tirado de #${room} por ${by}`
export const mutedNotice = (room: string, by: string): string => `você foi calado em #${room} por ${by}: continua ouvindo`
export const unmutedNotice = (room: string): string => `você pode falar de novo em #${room}`

// ---- what was missed (the merge of 2.4 and the return of 2.5) -----------------------------------

/** What piled up for one member in one channel: counts and names only, never a body. */
export interface Tally {
  /** The first seq not delivered. */
  since: number
  /** When that first line was written (ISO). */
  at: string
  messages: number
  notices: number
  /** Agents' names that spoke, in order of first word. The moderator is counted apart. */
  speakers: string[]
  /** Lines of the moderator among `messages`. */
  fromUser: number
}

function amount(t: Tally): string {
  const parts: string[] = []
  if (t.messages > 0) parts.push(t.messages === 1 ? '1 fala nova' : `${t.messages} falas novas`)
  if (t.notices > 0) parts.push(t.notices === 1 ? '1 aviso' : `${t.notices} avisos`)
  let text = parts.join(' e ') || 'nada novo'
  text += ` desde ${hourOf(t.at)}`
  if (t.speakers.length > 0) text += `, de ${namesOf(t.speakers)}`
  if (t.fromUser > 0) text += ` (${t.fromUser === 1 ? 'uma' : t.fromUser} do usuário)`
  return text
}

type Path = 'inside' | 'terminal' | 'wait'

/** `inside` keeps the short form; any other road is taught the tool and the CLI. */
const readHint = (room: string, since: number, path: Path, tools: boolean): string =>
  path === 'inside' ? `ler: channels read ${room} --since ${since - 1}` : `ler: ${readHow(room, tools, since - 1)}`

/** In place of the second line that would wait behind the first: what waits now, and how to read it. */
export function mergedNotice(room: string, t: Tally, path: Path = 'inside', tools = false): string {
  return `#${room}: ${amount(t)}; ${readHint(room, t.since, path, tools)}`
}

/** The one notice per channel a member gets when its process runs again. */
export function returnNotice(room: string, t: Tally, path: Path = 'inside', tools = false): string {
  return `você voltou · #${room}: ${amount(t)}; ${readHint(room, t.since, path, tools)}`
}
