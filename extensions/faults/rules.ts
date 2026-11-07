// The Faults screen's rules as pure functions (no DOM, unit-tested): the tabs and their counts, the filters, what is "nova",
// the top bar's sentence, the stack note, and the agent chooser of "Mandar para o agente" (which panes can take the command
// now, why the others cannot, which row starts selected). The panel only draws what these return.
import type { Profile, SlotState } from '../../src/daemon/protocol.ts'
import type { FaultRow } from '../../src/core/faults-ops.ts'
import type { FaultStatus } from '../../src/core/faults.ts'
import { returnedText } from '../../src/core/faults-labels.ts'
import { FAULTS_FEATURE } from './manifest.ts'

// ---- the list ----------------------------------------------------------------------------------------------------------

export type Tab = FaultStatus | 'all'
export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'open', label: 'Abertas' }, { id: 'investigating', label: 'Investigando' }, { id: 'done', label: 'Resolvidas' }, { id: 'ignored', label: 'Ignoradas' }, { id: 'all', label: 'Todas' },
]

export function counts(rows: readonly FaultRow[]): Record<Tab, number> {
  const c: Record<Tab, number> = { open: 0, investigating: 0, done: 0, ignored: 0, all: rows.length }
  for (const r of rows) c[r.status]++
  return c
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export interface Filter { tab: Tab; query: string; tag: string }

/** The rows a tab, a search (id, message, tag, process: every word must match) and a tag leave, in the order given. */
export function visibleRows(rows: readonly FaultRow[], f: Filter): FaultRow[] {
  const words = fold(f.query).split(/\s+/).filter(Boolean)
  return rows.filter(r => {
    if (f.tab !== 'all' && r.status !== f.tab) return false
    if (f.tag && !r.tags.includes(f.tag)) return false
    if (!words.length) return true
    const hay = fold(`${r.id} ${r.message} ${r.proc} ${r.tags.join(' ')}`)
    return words.every(w => hay.includes(w))
  })
}

export const allTags = (rows: readonly FaultRow[]): string[] => [...new Set(rows.flatMap(r => r.tags))].sort()

/** Newest occurrence first, or the one that happened most often. */
export function sortRows(rows: readonly FaultRow[], by: 'last' | 'count'): FaultRow[] {
  return rows.slice().sort((a, b) => (by === 'count' ? b.count - a.count : 0) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
}

/** "nova": open, and first seen — or back — after the person last had the screen open (never opened = all open ones). */
export function isNew(r: FaultRow, seenAt: string | null): boolean {
  if (r.status !== 'open') return false
  if (!seenAt) return true
  return r.first > seenAt || (r.returned !== undefined && r.returned.ts > seenAt)
}

export const newCount = (rows: readonly FaultRow[], seenAt: string | null): number => rows.filter(r => isNew(r, seenAt)).length

/** The top bar's sentence: "3 falhas novas no tether". */
export function statusSentence(n: number): string {
  return n === 1 ? '1 falha nova no tether' : `${n} falhas novas no tether`
}

/** What marks a status without color: open ●, investigating ◐, done ✓, ignored –. */
export const STATUS_MARK: Record<FaultStatus, string> = { open: '●', investigating: '◐', done: '✓', ignored: '–' }

/** The "voltou" sentence for a row, with its detail (voltou na v0.9.4, depois do fix def4567). */
export function returnedOf(r: FaultRow): string | undefined {
  return returnedText({ returned: r.returned, ...(r.returned?.fix ? { fix: { commit: r.returned.fix, ts: r.returned.ts } } : {}) })
}

/** Frames of a bundle (dist/*.cjs, *.js) rather than of the source: the screen says it is showing the bundle's stack. */
export function isBundleStack(stack: string): boolean {
  return /\bat .*[\\/]dist[\\/][^\s:]+\.(?:cjs|mjs|js)\b/.test(stack) || /\.(?:cjs|mjs):\d+:\d+/.test(stack)
}

export function stackNote(stack: string, version: string): string | undefined {
  return isBundleStack(stack) ? `mostrando a stack do bundle: sem source map da v${version.replace(/^v/, '')}` : undefined
}

// ---- "Mandar para o agente" --------------------------------------------------------------------------------------------

export interface ChoiceInput {
  /** The agent slots the daemon runs. */
  slots: readonly SlotState[]
  /** Slots that have a pane open right now. */
  openPanes: ReadonlySet<string>
  labelOf(slotId: string): string
  profiles: readonly Profile[]
  /** agents.features.faults in force. */
  general: boolean
  /** The folder "Novo painel" opens in. */
  cwd: string
  agentLabel(kind: string): string
}

export interface Choice {
  /** `pane:<slotId>` or `new:<profileId>`. */
  key: string
  kind: 'pane' | 'new'
  label: string
  /** The state in words, written on the row (never in a tooltip): livre / trabalhando / não sei se está livre. */
  state: string
  enabled: boolean
  /** Why it cannot be picked. */
  reason?: string
  /** A line under the row that the person should know before choosing it. */
  hint?: string
  /** A "Ligar" link, for the feature switched off: opens the profile editor at that profile. */
  link?: { text: string; profileId: string }
  slotId?: string
  profileId?: string
}

export interface Chooser { choices: Choice[]; selected: string | undefined }

/** The feature in force for a profile (its own switch, else the general one). */
export const featureOn = (profile: Pick<Profile, 'features'> | undefined, general: boolean): boolean => profile?.features?.[FAULTS_FEATURE] ?? general

export const FEATURE_OFF = 'feature faults desligada neste perfil'
/** A new Claude pane in a folder Claude has not been trusted in yet stops at its trust dialog. */
export const TRUST_HINT = 'a pasta precisa estar confiada no Claude'
/** The profile has it on now, but this pane's agent started without it: only a new start gets the skills. */
export const FEATURE_NOT_LAUNCHED = 'este painel abriu sem a feature faults; reinicie o agente'

/** Whether a running pane's agent actually received the feature: what it launched with (SlotState.features), not today's switches. Undefined while nothing runs or on a daemon that does not say. */
export const launchedWith = (s: Pick<SlotState, 'features'>): boolean | undefined => s.features ? s.features.includes(FAULTS_FEATURE) : undefined

/** "workspace/tether": the last two segments of a folder. */
export function shortFolder(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

/** What the pane's turn allows: livre (selectable), trabalhando, esperando você, não sei se está livre; a pane without a running agent never is. */
export function turnState(s: SlotState): { state: string; enabled: boolean } {
  if (s.status === 'starting' || s.status === 'queued') return { state: 'iniciando', enabled: false }
  if (s.status !== 'running') return { state: s.status === 'exited' ? 'parado' : 'com erro', enabled: false }
  switch (s.turn) {
    case 'idle': return { state: 'livre', enabled: true }
    case 'busy': return { state: 'trabalhando', enabled: false }
    case 'blocked': return { state: 'esperando uma resposta sua', enabled: false }
    default: return { state: 'não sei se está livre', enabled: false }
  }
}

export function buildChooser(input: ChoiceInput): Chooser {
  const choices: Choice[] = []
  for (const s of input.slots) {
    if (s.kind === 'shell' || !input.openPanes.has(s.slotId)) continue
    const profile = s.profileId ? input.profiles.find(p => p.id === s.profileId) : undefined
    const label = input.labelOf(s.slotId)
    const t = turnState(s)
    const launched = launchedWith(s)
    const has = launched ?? featureOn(profile, input.general)
    if (!has) {
      const reason = launched === false && featureOn(profile, input.general) ? FEATURE_NOT_LAUNCHED : FEATURE_OFF
      choices.push({ key: `pane:${s.slotId}`, kind: 'pane', label, state: t.state, enabled: false, reason, ...(reason === FEATURE_OFF && s.profileId && profile ? { link: { text: 'Ligar', profileId: s.profileId } } : {}), slotId: s.slotId })
    } else {
      choices.push({ key: `pane:${s.slotId}`, kind: 'pane', label, state: t.state, enabled: t.enabled, ...(t.enabled ? {} : { reason: t.state }), slotId: s.slotId })
    }
  }
  // Selectable first, the others in the order the panes came.
  choices.sort((a, b) => Number(b.enabled) - Number(a.enabled))
  // "Novo painel": every profile of an AI agent, the defaults first. The feature is resolved per profile (its own switch,
  // else the general one): a profile with it off is listed, disabled, with the link that turns it on. When an agent has
  // more than one profile the row names the profile.
  const agentProfiles = input.profiles.filter(p => p.agent !== 'shell')
  const perAgent = new Map<string, number>()
  for (const p of agentProfiles) perAgent.set(p.agent, (perAgent.get(p.agent) ?? 0) + 1)
  for (const p of [...agentProfiles.filter(x => x.default), ...agentProfiles.filter(x => !x.default)]) {
    const on = featureOn(p, input.general)
    const agentName = input.agentLabel(p.agent)
    const who = agentName + ((perAgent.get(p.agent) ?? 0) > 1 && p.name.trim().toLowerCase() !== agentName.toLowerCase() ? ` · ${p.name}` : '')
    choices.push({
      key: `new:${p.id}`, kind: 'new', label: `Novo painel ${who} em ${shortFolder(input.cwd)}`, state: 'novo', enabled: on,
      ...(on ? {} : { reason: FEATURE_OFF, link: { text: 'Ligar', profileId: p.id } }),
      ...(p.agent === 'claude' ? { hint: TRUST_HINT } : {}), profileId: p.id,
    })
  }
  const first = choices.find(c => c.enabled)
  return { choices, selected: first?.key }
}

/** The command typed into the pane: the skill, then the fault's id. */
export const investigateCommand = (id: string): string => `/tether:fault-investigate ${id}`

/** Whether a row that was sent to a pane still shows "enviada para ...": until the fault is no longer open. */
export const stillSent = (status: FaultStatus): boolean => status === 'open'

/** "Mandar para o agente" is offered while the fault is still to be looked at; a resolved or ignored one is only reopened. */
export const canSend = (status: FaultStatus): boolean => status === 'open' || status === 'investigating'
