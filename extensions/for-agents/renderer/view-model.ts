// The view model of the marks of ownership (tether for agents): from the data in `objects` and the layout, what each desk
// pill and each pane tab should show. Pure: no DOM, no `ui`, so a unit test reads it state by state. marks.ts reads the app,
// calls `computeView` and hands the result to the seams (setSeal, setEmblems, setTabLine, setHeadItem).
//
// What each mark says (the approved preview, sections 1 and 2):
//   seal on a pill ........ the desk has an owner (solid) or its owner ended (struck)
//   crown ................. this pane is the live owner of the desk it is in
//   letter ................ a pane given to an agent (the agent's initial, in its hue); with the arrow "de si": its own pane
//   eye ................... the desk's owner only sees a pane given to another agent
//   hand / pause .......... the hand is with the person (taken / paused)
//   struck letter ......... the pane's owner was forgotten, the pane went back to the person
//   line under the tab .... the pane is commanded by its desk (inherited), quiet otherwise
//   status bar line ....... who commands and the last thing it did
// Nothing here is orange: the hue is always `agentHue(owner)`, or none.
import { agentHue } from '../../../app/shared/agent-color.ts'
import { effective, type DeskFacts, type Hand, type LastAct, type OwnerId, type Ownership, type PaneFacts } from '../rules.ts'

/** The most emblems one pane's tab takes (the app's MAX_TAB_EMBLEMS); the cases below never exceed it. */
export const MAX_EMBLEMS = 3

export interface ViewPane { id: string; type: string; deskId?: string | undefined }

/** What `computeView` reads: the layout and the `objects` of this extension, already out of the mirror. */
export interface ViewInput {
  panes: readonly ViewPane[]
  desks: readonly { id: string }[]
  paneOwner: ReadonlyMap<string, Ownership>
  paneHand: ReadonlyMap<string, Hand>
  paneLast: ReadonlyMap<string, LastAct>
  /** Panes carrying `frozen`: the agents the person paused everywhere. */
  frozen: ReadonlySet<OwnerId>
  deskOwner: ReadonlyMap<string, Ownership>
  deskHand: ReadonlyMap<string, Hand>
  /** The name an agent's tab shows (undefined: unknown, the id is shown). */
  nameOf(id: OwnerId): string | undefined
}

export interface SealMark {
  icon: 'robot'
  hue: number
  label: string
  tooltip: string
  /** The words where the seal is not clickable (the "+N" menu): the owner only, without the click. Absent: `tooltip`. */
  menuTooltip?: string
  variant: 'solid' | 'struck'
  /** The owner a click goes to ("Ir para Atrium"); absent when the owner ended. */
  focus?: OwnerId
}

export interface EmblemMark {
  kind: 'crown' | 'owner' | 'self' | 'viewer' | 'hand' | 'ended'
  icon: string
  label?: string
  hue?: number
  tooltip: string
  variant?: 'struck'
}

export interface HeadMark {
  icon: string
  hue?: number
  text: string
  tooltip: string
}

export interface PaneMarks {
  emblems: EmblemMark[]
  /** The hue of the line under the tab: the pane is commanded by its desk and the hand is with the owner. */
  line?: number
  /** Terminal panes only: the only panes with a status bar. */
  head?: HeadMark
}

export interface ViewModel {
  seals: Map<string, SealMark>
  panes: Map<string, PaneMarks>
}

/** What the owner did, in the line of the status bar ("enviou pedido 14:02"). Verbs of the daemon's `LastAct.verb`. */
const LAST_VERBS: Readonly<Record<string, string>> = {
  send: 'enviou pedido',
  interrupt: 'interrompeu',
  answer: 'respondeu um pedido de permissão',
  command: 'rodou um comando',
  type: 'digitou',
  keys: 'teclou',
  open: 'abriu uma guia',
  close: 'fechou uma guia',
  restart: 'reiniciou uma guia',
  give: 'deu uma guia',
  revoke: 'revogou uma guia',
}

/** "14:02" in the person's clock. */
export function clockOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** The first letter of an agent's name, upper case: the letter on its tab emblem and in the picker. */
export const initialOf = (name: string): string => {
  const first = [...name.trim()][0]
  return first ? first.toUpperCase() : '?'
}

export function computeView(input: ViewInput, clock: (iso: string) => string = clockOf): ViewModel {
  const name = (id: OwnerId): string => input.nameOf(id) ?? id
  const seals = new Map<string, SealMark>()

  for (const desk of input.desks) {
    const o = input.deskOwner.get(desk.id)
    if (!o) continue
    if (o.ended) {
      seals.set(desk.id, { icon: 'robot', hue: agentHue(o.owner), label: o.ended.name, variant: 'struck', tooltip: `${o.ended.name} encerrou: as guias voltaram para você` })
    } else {
      const n = name(o.owner)
      seals.set(desk.id, { icon: 'robot', hue: agentHue(o.owner), label: n, variant: 'solid', tooltip: `Dono: ${n} · clique: ir para ${n}`, menuTooltip: `Dono: ${n}`, focus: o.owner })
    }
  }

  const panes = new Map<string, PaneMarks>()
  for (const p of input.panes) {
    const deskOwner = p.deskId !== undefined ? input.deskOwner.get(p.deskId) : undefined
    const desk: DeskFacts | undefined = p.deskId === undefined ? undefined : {
      id: p.deskId,
      ...(deskOwner ? { owner: deskOwner } : {}),
      ...(input.deskHand.get(p.deskId) ? { hand: input.deskHand.get(p.deskId)! } : {}),
    }
    const facts: PaneFacts = {
      id: p.id,
      ...(input.paneOwner.get(p.id) ? { owner: input.paneOwner.get(p.id)! } : {}),
      ...(input.paneHand.get(p.id) ? { hand: input.paneHand.get(p.id)! } : {}),
    }
    const eff = effective(facts, desk, input.frozen)
    const emblems: EmblemMark[] = []
    const commander = eff.commander

    // The crown is the owner's pane in the desk it owns; an owner living in another desk has no tab here, and no crown elsewhere.
    const crowned = deskOwner !== undefined && !deskOwner.ended && deskOwner.owner === p.id
    if (crowned) emblems.push({ kind: 'crown', icon: 'crown-simple', hue: agentHue(p.id), tooltip: `${name(p.id)} · dono da mesa` })

    if (commander !== undefined) {
      const n = name(commander)
      const hue = agentHue(commander)
      if (eff.via === 'pane') emblems.push({ kind: 'owner', icon: '', label: initialOf(n), hue, tooltip: `Dono: ${n}` })
      if (eff.via === 'self') {
        if (!crowned) emblems.push({ kind: 'owner', icon: '', label: initialOf(n), hue, tooltip: `${n}, de si` })
        emblems.push({ kind: 'self', icon: 'arrow-u-down-left', tooltip: 'de si' })
      }
      if (eff.via === 'pane' && eff.viewer !== undefined && eff.viewer !== p.id) emblems.push({ kind: 'viewer', icon: 'eye', tooltip: `${name(eff.viewer)} vê` })
      if (eff.hand === 'user') {
        emblems.push(eff.handWhy === 'paused'
          ? { kind: 'hand', icon: 'pause', tooltip: `Pausada: ${n} não age aqui até você retomar` }
          : { kind: 'hand', icon: 'hand-grabbing', tooltip: `Com você: ${n} só volta a comandar quando você devolver` })
      }
    }

    if (eff.ended?.on === 'pane') {
      emblems.push({ kind: 'ended', icon: '', label: initialOf(eff.ended.name), hue: agentHue(eff.ended.owner), variant: 'struck', tooltip: `${eff.ended.name} encerrou` })
    }

    // Three at most, without a cut: the crown only goes with the pane being the desk's owner, who is then its own viewer
    // (no eye), and a pane that is its own owner has no letter beside the crown.

    const marks: PaneMarks = { emblems }
    if (commander !== undefined && eff.via === 'desk' && eff.hand === 'owner') marks.line = agentHue(commander)
    if (commander !== undefined && p.type === 'terminal') marks.head = headOf(commander, eff.via!, eff.hand, eff.handWhy, input.paneLast.get(p.id), name(commander), clock)
    if (emblems.length > 0 || marks.line !== undefined || marks.head) panes.set(p.id, marks)
  }
  return { seals, panes }
}

function headOf(commander: OwnerId, via: 'pane' | 'desk' | 'self', hand: 'owner' | 'user', why: 'taken' | 'paused' | undefined,
  last: LastAct | undefined, name: string, clock: (iso: string) => string): HeadMark {
  const tooltip = 'Quem comanda e a última coisa que fez'
  if (hand === 'user') {
    return why === 'paused'
      ? { icon: 'pause', text: 'pausada por você', tooltip: `${name} está pausada aqui: não age até você retomar` }
      : { icon: 'hand-grabbing', text: 'com você', tooltip: `Com você: ${name} só volta a comandar quando você devolver` }
  }
  const who = via === 'desk' ? `${name} pela mesa` : via === 'self' ? `${name} · de si` : name
  const did = last && last.by === commander ? `${LAST_VERBS[last.verb] ?? last.verb} ${clock(last.at)}`.trim() : ''
  return { icon: 'robot', hue: agentHue(commander), text: did ? `${who} · ${did}` : who, tooltip }
}
