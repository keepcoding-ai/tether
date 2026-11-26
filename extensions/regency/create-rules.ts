// The rules of the Regency's "+ Novo": the step card (what › where › details), its validation in Portuguese and `planOf`, the
// ordered list of acts that makes the thing. Pure: no DOM, no `ui`, nothing from the app or the daemon but types. Everything in
// and out is JSON (the app's card runs the plan today; a remote interface runs the same list by requests), so there are no
// classes, no functions inside the data and no `undefined` values: an absent field is an absent key.
import type { DeskTree } from '../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../channels/daemon/requests.ts'
import { safeName, type RegencyInput } from './model.ts'

/** What "+ Novo" makes. `desk-for` is "Dar uma mesa nova" (the menu of an agent), never a tile. */
export type CreateWhat = 'agent' | 'terminal' | 'note' | 'browser' | 'channel' | 'desk' | 'desk-for'
export type CreateStep = 'what' | 'where' | 'details'

/** The id of "Mesa nova…" in `CreateDraft.deskId`. */
export const NEW_DESK = 'new'
/** Placeholders an act can carry, filled from what an earlier act made (`runPlan`). */
export const REF_DESK = '$desk'
export const REF_PANE = '$pane'
export const REF_CHANNEL = '$channel'

export const MAX_DESK_NAME = 40
export const MAX_CHANNEL_NAME = 40
const CHANNEL_NAME_RE = /^[a-z0-9-]{1,40}$/

export const STEP_LABELS: Readonly<Record<CreateStep, string>> = { what: 'O quê', where: 'Onde', details: 'Detalhes' }

/** The tiles of the first step, in order. The Agent and the Terminal open the profile picker; the others go straight on. */
export const CREATE_TILES: readonly { what: CreateWhat; group: 'desk' | 'tether'; label: string }[] = [
  { what: 'agent', group: 'desk', label: 'Agente' },
  { what: 'terminal', group: 'desk', label: 'Terminal' },
  { what: 'note', group: 'desk', label: 'Nota' },
  { what: 'browser', group: 'desk', label: 'Navegador' },
  { what: 'desk', group: 'tether', label: 'Mesa' },
  { what: 'channel', group: 'tether', label: 'Canal' },
]

export interface CreateDraft {
  what?: CreateWhat
  /** The slot kind of the chosen profile row ('claude', 'codex', 'shell', ...). Agent: required. Terminal: 'shell' when absent. */
  kind?: string
  profileId?: string
  /** The working folder (agent, terminal, note). */
  cwd?: string
  /** Optional name of the pane (agent, terminal) or the note's destination. */
  name?: string
  /** The desk it is born in: a desk id, or `NEW_DESK`. */
  deskId?: string
  /** The new desk (`what: 'desk'`, `'desk-for'`, or `deskId: NEW_DESK`). `after`: a desk id; absent = after the last. */
  newDesk?: { name: string; color?: string; after?: string }
  /** Bring the new pane to the front of its desk (default: it stays behind). */
  front?: boolean
  /** Agent: a channel (id) to join as soon as it is born. */
  joinChannel?: string
  /** Browser: the agent (id) it is for. Absent = for the person. */
  browserFor?: string
  url?: string
  /** Channel: the name (with or without `#`) and the agents (ids) that join it. */
  channel?: { name: string; members?: string[] }
  /** `desk-for`: give the new desk to the agent (default yes). */
  giveDesk?: boolean
  /** `desk-for`: carry the agent's pane to the new desk (default no, P6). */
  movePane?: boolean
}

/** What the entry already knows and the person cannot change. */
export interface CreateFixed {
  /** The "+" of a desk's row: the desk is known, the "where" step goes away. */
  deskId?: string
  /** "Dar uma mesa nova": the agent (its pane id) and the name to show. */
  forAgent?: string
  forName?: string
  /** "Agente aqui…" / "Terminal aqui…" of a project: the working folder comes filled (the person may still change it). */
  cwd?: string
}

/** What the rules may look at to refuse: the tree of desks and the open channels. All optional. */
export interface CreateContext { desks?: DeskTree; channels?: readonly ChannelSummary[] }

export interface CreateState {
  draft: CreateDraft
  fixed: CreateFixed
  step: CreateStep
  /** The sentence of the last refusal, shown under the step. */
  error?: string
  /** `ready`: the last step passed (run `planOf`). `closed`: the person went back from the first step. */
  outcome?: 'ready' | 'closed'
}

// ---------------------------------------------------------------- steps

export function stepsOf(draft: CreateDraft, fixed: CreateFixed = {}): CreateStep[] {
  if (draft.what === 'desk-for') return ['details']
  if (draft.what === 'desk' || draft.what === 'channel' || fixed.deskId !== undefined) return ['what', 'details']
  return ['what', 'where', 'details']
}

/** The card's first state. `forAgent` makes it "Dar uma mesa nova" (one step); `deskId` pre-fills and drops "Onde". */
export function startCreate(fixed: CreateFixed = {}, what?: CreateWhat): CreateState {
  const draft: CreateDraft = {}
  if (fixed.forAgent !== undefined) { draft.what = 'desk-for'; draft.giveDesk = true; draft.movePane = false }
  else if (what !== undefined) draft.what = what
  if (fixed.deskId !== undefined) draft.deskId = fixed.deskId
  if (fixed.cwd !== undefined && fixed.cwd !== '') draft.cwd = fixed.cwd
  return { draft, fixed, step: stepsOf(draft, fixed)[0] ?? 'what' }
}

/** Changing `what` drops what belonged to the old one (the folder, the desk and `front` stay). */
export function patchDraft(state: CreateState, patch: Partial<CreateDraft>): CreateState {
  let draft: CreateDraft = { ...state.draft, ...patch }
  if (patch.what !== undefined && patch.what !== state.draft.what) {
    draft = { what: patch.what, ...patch }
    for (const k of ['cwd', 'deskId', 'front', 'newDesk'] as const) {
      const keep = patch[k] ?? state.draft[k]
      if (keep !== undefined) (draft as Record<string, unknown>)[k] = keep
    }
  }
  const { error: _e, outcome: _o, ...rest } = state
  return { ...rest, draft }
}

const stepIndex = (state: CreateState): { steps: CreateStep[]; i: number } => {
  const steps = stepsOf(state.draft, state.fixed)
  return { steps, i: Math.max(0, steps.indexOf(state.step)) }
}

/** Validates the step in view; passes to the next one, or marks `ready` on the last. A refusal stays on the step with `error`. */
export function advance(state: CreateState, ctx: CreateContext = {}): CreateState {
  const { steps, i } = stepIndex(state)
  const step = steps[i] ?? 'what'
  const { error: _e, outcome: _o, ...rest } = state
  const error = stepError(step, state.draft, state.fixed, ctx)
  if (error !== undefined) return { ...rest, step, error }
  const nextStep = steps[i + 1]
  return nextStep === undefined ? { ...rest, step, outcome: 'ready' } : { ...rest, step: nextStep }
}

/** Esc: a step back; from the first step, `closed`; from `ready`, back to the last step. */
export function back(state: CreateState): CreateState {
  const { steps, i } = stepIndex(state)
  const { error: _e, outcome, ...rest } = state
  if (outcome === 'ready') return { ...rest, step: steps[i] ?? 'what' }
  if (i === 0) return { ...rest, step: steps[0] ?? 'what', outcome: 'closed' }
  return { ...rest, step: steps[i - 1] ?? 'what' }
}

/** The first step that is not right yet, with its sentence. `undefined`: the draft can be made. */
export function missing(state: CreateState, ctx: CreateContext = {}): { step: CreateStep; error: string } | undefined {
  for (const step of stepsOf(state.draft, state.fixed)) {
    const error = stepError(step, state.draft, state.fixed, ctx)
    if (error !== undefined) return { step, error }
  }
  return undefined
}

// ---------------------------------------------------------------- validation

/** A typed name through the one filter of names (model.ts safeName): spaces folded, no control or bidi characters. */
const cleanSpaces = (s: string): string => safeName(s)

/** The name of a channel as the daemon takes it: no `#`, lowercase. */
export const channelNameOf = (raw: string): string => cleanSpaces(raw).replace(/^#+/, '').toLowerCase()

const queueDesk = (deskId: string, ctx: CreateContext) => ctx.desks?.desks.find(d => d.id === deskId && d.kind === 'queue')

function deskProblem(deskId: string, ctx: CreateContext): string | undefined {
  if (ctx.desks === undefined) return undefined
  const desk = queueDesk(deskId, ctx)
  if (desk === undefined) return 'Essa mesa não existe mais.'
  if (desk.asleep) return 'Essa mesa está dormindo: acorde-a antes de criar nela.'
  return undefined
}

function newDeskProblem(newDesk: CreateDraft['newDesk']): string | undefined {
  const name = cleanSpaces(newDesk?.name ?? '')
  if (name === '') return 'Dê um nome à mesa nova.'
  if (name.length > MAX_DESK_NAME) return `O nome da mesa tem até ${MAX_DESK_NAME} letras.`
  return undefined
}

const needsDesk = (what: CreateWhat | undefined): boolean => what === 'agent' || what === 'terminal' || what === 'note' || what === 'browser'

export function stepError(step: CreateStep, draft: CreateDraft, fixed: CreateFixed, ctx: CreateContext = {}): string | undefined {
  const what = draft.what
  if (step === 'what') {
    if (what === undefined) return 'Escolha o que criar.'
    if (what === 'agent' && (draft.kind ?? '') === '') return 'Escolha o agente: o motor e o perfil.'
    return undefined
  }
  if (step === 'where') {
    if ((draft.deskId ?? '') === '') return 'Escolha a mesa.'
    if (draft.deskId === NEW_DESK) return newDeskProblem(draft.newDesk)
    return deskProblem(draft.deskId as string, ctx)
  }
  // details
  if (what === undefined) return 'Escolha o que criar.'
  if (needsDesk(what) && !stepsOf(draft, fixed).includes('where')) {
    if ((draft.deskId ?? '') === '') return 'Escolha a mesa.'
    const bad = deskProblem(draft.deskId as string, ctx)
    if (bad !== undefined) return bad
  }
  if ((what === 'agent' || what === 'terminal' || what === 'note') && cleanSpaces(draft.cwd ?? '') === '') return 'Escolha a pasta de trabalho.'
  if (what === 'agent' && draft.joinChannel !== undefined && ctx.channels !== undefined) {
    if (!ctx.channels.some(c => c.id === draft.joinChannel && c.closed === undefined)) return 'Esse canal não está mais aberto.'
  }
  if (what === 'browser') {
    if (/\s/.test((draft.url ?? '').trim())) return 'O endereço não pode ter espaços.'
  }
  if (what === 'channel') {
    const name = channelNameOf(draft.channel?.name ?? '')
    if (name === '') return 'Dê um nome ao canal.'
    if (!CHANNEL_NAME_RE.test(name)) return `O nome do canal usa letras minúsculas sem acento, números e hífen, até ${MAX_CHANNEL_NAME}.`
    if (ctx.channels?.some(c => c.name === name && c.closed === undefined)) return 'Já existe um canal aberto com esse nome.'
  }
  if (what === 'desk' || what === 'desk-for') {
    const bad = newDeskProblem(draft.newDesk)
    if (bad !== undefined) return bad
    if (what === 'desk-for' && (fixed.forAgent ?? '') === '') return 'Escolha o agente que recebe a mesa.'
  }
  return undefined
}

// ---------------------------------------------------------------- the desks of "Onde"

export interface DeskChoice {
  id: string
  name: string
  color: string
  /** The name of the agent that owns the desk. */
  owner?: string
  /** The desk the "+" came from. */
  origin?: true
  /** "Mesa nova…". */
  isNew?: true
}

/** The awake queue desks (with their owner), then "Mesa nova…" last. Sleeping, system and drawer desks are not offered (P2). */
export function deskChoices(desks: DeskTree, owners: RegencyInput['owners'], origin?: string): DeskChoice[] {
  const rows: DeskChoice[] = []
  for (const d of desks.desks) {
    if (d.kind !== 'queue' || d.asleep) continue
    const owner = owners.desk[d.id]?.name
    rows.push({ id: d.id, name: d.name, color: d.color, ...(owner !== undefined ? { owner } : {}), ...(d.id === origin ? { origin: true as const } : {}) })
  }
  rows.push({ id: NEW_DESK, name: 'Mesa nova…', color: 'gray', isNew: true })
  return rows
}

/** The desk's own channel (the open one that belongs to it): the "already in" row is ticked and locked, the F1 joins by desk. */
export function deskChannelOf(deskId: string, channels: readonly ChannelSummary[]): ChannelSummary | undefined {
  return channels.find(c => c.desk === deskId && c.closed === undefined)
}

// ---------------------------------------------------------------- the plan

/** Who runs the act: the tetherd by a request, the app by a bridge (`no-app` when it is closed), or only the app's renderer. */
export type ActRuns = 'tetherd' | 'app-bridge' | 'renderer'

interface ActBase {
  runs: ActRuns
  /** "criar o terminal": after "Não consegui ...". */
  doing: string
  /** "criei o terminal": the first person, past; the failure text lists what is done. */
  done: string
  /** The act can fail and the plan goes on (it becomes a warning). */
  optional?: true
  /** The sentence added to the failure text when THIS act fails. */
  ifFails?: string
}

export type CreateAct =
  | (ActBase & { act: 'desk'; name: string; color?: string; after?: string })
  | (ActBase & { act: 'slot'; deskId: string; kind: string; cwd: string; profileId?: string; name?: string; front: boolean })
  | (ActBase & { act: 'item'; deskId: string; itemId: string; cwd: string; destination?: string; front: boolean })
  | (ActBase & { act: 'browser'; deskId: string; url?: string })
  | (ActBase & { act: 'channel'; name: string })
  | (ActBase & { act: 'join'; channel: string; agents: string[] })
  | (ActBase & { act: 'show'; channel: string })
  | (ActBase & { act: 'give'; kind: 'pane' | 'desk'; id: string; to: string })
  | (ActBase & { act: 'move'; pane: string; deskId: string })

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function planOf(state: CreateState, ctx: CreateContext = {}): CreateAct[] {
  if (missing(state, ctx) !== undefined) return []
  const { draft, fixed } = state
  const acts: CreateAct[] = []
  const newDeskAct = (): void => {
    const d = draft.newDesk as NonNullable<CreateDraft['newDesk']>
    const name = cleanSpaces(d.name)
    acts.push({
      act: 'desk', runs: 'app-bridge', name, ...(d.color !== undefined ? { color: d.color } : {}), ...(d.after !== undefined ? { after: d.after } : {}),
      doing: `criar a mesa «${name}»`, done: `criei a mesa «${name}»`,
    })
  }

  if (draft.what === 'desk') { newDeskAct(); return acts }

  if (draft.what === 'desk-for') {
    newDeskAct()
    const agent = fixed.forAgent as string
    const who = fixed.forName ?? 'o agente'
    const deskName = cleanSpaces((draft.newDesk as NonNullable<CreateDraft['newDesk']>).name)
    if (draft.giveDesk !== false) {
      acts.push({ act: 'give', runs: 'tetherd', kind: 'desk', id: REF_DESK, to: agent, doing: `dar a mesa a ${who}`, done: `dei a mesa a ${who}`, ifFails: `A mesa «${deskName}» ficou com você.` })
    }
    if (draft.movePane === true) {
      acts.push({ act: 'move', runs: 'renderer', pane: agent, deskId: REF_DESK, doing: `levar a guia de ${who} para a mesa nova`, done: `levei a guia de ${who} para a mesa nova` })
    }
    return acts
  }

  if (draft.what === 'channel') {
    const name = channelNameOf(draft.channel?.name ?? '')
    acts.push({ act: 'channel', runs: 'tetherd', name, doing: `criar o canal #${name}`, done: `criei o canal #${name}` })
    const members = draft.channel?.members ?? []
    if (members.length > 0) {
      acts.push({ act: 'join', runs: 'tetherd', channel: REF_CHANNEL, agents: [...members], optional: true, doing: 'juntar os agentes ao canal', done: 'juntei os agentes ao canal' })
    }
    acts.push({ act: 'show', runs: 'renderer', channel: REF_CHANNEL, optional: true, doing: 'abrir o canal no centro', done: 'abri o canal no centro' })
    return acts
  }

  // agent, terminal, note, browser: they are born in a desk, new or not
  let deskId = draft.deskId as string
  if (deskId === NEW_DESK) { newDeskAct(); deskId = REF_DESK }
  const front = draft.front === true
  const name = cleanSpaces(draft.name ?? '')
  if (draft.what === 'agent' || draft.what === 'terminal') {
    const agent = draft.what === 'agent'
    acts.push({
      act: 'slot', runs: 'tetherd', deskId, kind: agent ? (draft.kind as string) : (draft.kind ?? 'shell'), cwd: cleanSpaces(draft.cwd as string),
      ...(draft.profileId !== undefined ? { profileId: draft.profileId } : {}), ...(name !== '' ? { name } : {}), front,
      doing: agent ? 'criar o agente' : 'criar o terminal', done: agent ? 'criei o agente' : 'criei o terminal',
    })
    // the desk's own channel is joined by the desk (F1): asking again would answer "already"
    const own = deskId === REF_DESK ? undefined : deskChannelOf(deskId, ctx.channels ?? [])
    if (agent && draft.joinChannel !== undefined && own?.id !== draft.joinChannel) {
      acts.push({ act: 'join', runs: 'tetherd', channel: draft.joinChannel, agents: [REF_PANE], optional: true, doing: 'juntar o agente ao canal', done: 'juntei o agente ao canal' })
    }
  } else if (draft.what === 'note') {
    acts.push({
      act: 'item', runs: 'renderer', deskId, itemId: 'note-new', cwd: cleanSpaces(draft.cwd as string), ...(name !== '' ? { destination: name } : {}), front,
      doing: 'criar a nota', done: 'criei a nota',
    })
  } else if (draft.what === 'browser') {
    const url = (draft.url ?? '').trim()
    acts.push({ act: 'browser', runs: 'renderer', deskId, ...(url !== '' ? { url } : {}), doing: 'abrir o navegador', done: 'abri o navegador' })
    if (draft.browserFor !== undefined) {
      acts.push({ act: 'give', runs: 'tetherd', kind: 'pane', id: REF_PANE, to: draft.browserFor, doing: 'dar a aba ao agente', done: 'dei a aba ao agente', ifFails: 'A aba ficou com você.' })
    }
  }
  return acts
}

// ---------------------------------------------------------------- running the plan (the card and the remote share it)

export type ActResult =
  | { ok: true; deskId?: string; paneId?: string; channelId?: string; /** Agents the channel refused (names). */ refused?: string[] }
  | { ok: false; error: string }

export interface PlanRun {
  ok: boolean
  /** How many acts ran to the end (optional ones that failed do not count). */
  done: number
  failed?: { index: number; error: string }
  warnings: string[]
  /** The sentence for the person: the failure up to where it went, or the warnings. Absent when all went well. */
  text?: string
  /** What the Regency lights in the tree (`announce`): the last pane made and its desk. */
  announce?: { paneId: string; deskId: string }
  channelId?: string
}

function fill<T>(value: T, refs: Record<string, string>): T {
  if (typeof value === 'string') return (refs[value] ?? value) as T
  if (Array.isArray(value)) return value.map(v => fill(v, refs)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, refs)])) as T
  }
  return value
}

const joinPt = (items: string[]): string => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`
const bare = (s: string): string => s.replace(/[.\s]+$/, '')

/** The sentence for a plan that stopped at `index`: what is done stays, and it says up to where it went. */
export function failureText(acts: readonly CreateAct[], index: number, error: string): string {
  const failed = acts[index]
  if (failed === undefined) return bare(error) + '.'
  const done = acts.slice(0, index).filter(a => a.optional !== true).map(a => a.done)
  const tail = failed.ifFails ?? (done.length > 0 ? 'O que já foi feito ficou.' : 'Nada foi criado.')
  const head = done.length > 0 ? `${cap(joinPt(done))}. Mas não consegui ${failed.doing}: ${bare(error)}.` : `Não consegui ${failed.doing}: ${bare(error)}.`
  return `${head} ${tail}`
}

/** Runs the acts in order through `exec` (the app's or the remote's). A required act that fails stops the plan; what is done stays. */
export async function runPlan(acts: readonly CreateAct[], exec: (act: CreateAct) => Promise<ActResult>): Promise<PlanRun> {
  const refs: Record<string, string> = {}
  const warnings: string[] = []
  const run: PlanRun = { ok: true, done: 0, warnings }
  let lastDesk: string | undefined
  let lastPane: string | undefined
  for (let index = 0; index < acts.length; index++) {
    const act = fill(acts[index] as CreateAct, refs)
    let result: ActResult
    try { result = await exec(act) } catch (e) { result = { ok: false, error: e instanceof Error ? e.message : String(e) } }
    if (!result.ok) {
      if (act.optional === true) { warnings.push(`Não consegui ${act.doing}: ${bare(result.error)}.`); continue }
      run.ok = false
      run.failed = { index, error: result.error }
      run.text = failureText(acts, index, result.error)
      break
    }
    run.done++
    if (result.deskId !== undefined) { refs[REF_DESK] = result.deskId; lastDesk = result.deskId }
    if (result.paneId !== undefined) { refs[REF_PANE] = result.paneId; lastPane = result.paneId }
    if (result.channelId !== undefined) { refs[REF_CHANNEL] = result.channelId; run.channelId = result.channelId }
    if (result.refused !== undefined && result.refused.length > 0) warnings.push(`Não entraram no canal: ${result.refused.join(', ')}.`)
  }
  if (lastPane !== undefined && lastDesk !== undefined) run.announce = { paneId: lastPane, deskId: lastDesk }
  if (run.ok && warnings.length > 0) run.text = warnings.join(' ')
  return run
}
