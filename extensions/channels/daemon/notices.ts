// The tether's own lines in a channel (contract 1.2, 2.4, 2.5, 6.3): one line each, in Portuguese, and never a word written by
// someone else. What a notice may name: the room, a pane's name (its tab, as slotTitle shows it), the moderator's name,
// counts, an hour and a seq. Two kinds of text live here: the LINE every member and the channel's pane read (third person:
// "X entrou em #obra"), and the NOTICE the agent it is about gets ("você entrou em #obra"). Pure: no imports.

/** The sender of every notice of the channels. */
export const SYSTEM_FROM = { name: 'tether', id: 'tether', role: 'system' } as const

/** The moderator's default name (setting `extensions.channels.moderatorName`). */
export const MODERATOR_NAME = 'usuário'

/** How many speakers a merged notice names before "e mais N". */
export const NAMES_SHOWN = 5

/** The CLI line a pane that does not hear inside needs (the ronda writes it the same way). */
function cliHint(room: string): string {
  return `para falar: node "$TETHER_CLI" channels say ${room} "<texto>"; para ler o que perdeu: node "$TETHER_CLI" channels read ${room} (no PowerShell, $env:TETHER_CLI)`
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
export const ownerEndedLine = (room: string, who: string, moderator: string): string => `${who} deixou de ser o owner de #${room}; quem o comanda agora é ${moderator}`

// ---- the notices to the agent it is about -------------------------------------------------------

export const createdNotice = (room: string): string => `você abriu #${room} e é o owner dele`

/**
 * To the agent that joined. `by` absent: it joined itself. `path` is the delivery's `pathOf` now: a pane that does not hear
 * inside learns how to speak by the CLI, and one that hears nothing now (`wait`) is told the lines wait for it.
 */
export function joinedNotice(room: string, by: string | undefined, members: readonly string[], path: 'inside' | 'terminal' | 'wait'): string {
  let text = `você entrou em #${room}${by ? ` (por ${by})` : ''} · members: ${namesOf(members, 12) || 'só você'}`
  if (path !== 'inside') text += ` · ${cliHint(room)}`
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

const readHint = (room: string, since: number): string => `ler: channels read ${room} --since ${since - 1}`

/** In place of the second line that would wait behind the first: what waits now, and how to read it. */
export function mergedNotice(room: string, t: Tally): string {
  return `#${room}: ${amount(t)}; ${readHint(room, t.since)}`
}

/** The one notice per channel a member gets when its process runs again. */
export function returnNotice(room: string, t: Tally): string {
  return `você voltou · #${room}: ${amount(t)}; ${readHint(room, t.since)}`
}
