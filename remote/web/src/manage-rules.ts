// Managing from afar (RR5 5.4), the pure rules: which rows a desk's, a pane's or a closed session's menu has for this device
// (its scopes) and in the state the house shows (a desk hibernating offers "Despertar mesa"); the questions the app asks
// before an act, in its own words (fechar guia, fechar mesa, esquecer, encerrar, hibernar com agente trabalhando, esquecer
// processo); the person's sentence for each refusal (never the code); what an answer means for an act that is on its way
// (done, send again under the same actId, prove again, give up); and the ceilings of the portal, checked before anything
// is sent. No DOM, no session: manage.ts holds the state, manage-view.ts draws.
import { L } from '../../../extensions/for-agents/renderer/texts.ts'
import { forceReasonError, refusalText } from '../../../extensions/regency/system-rules.ts'
import { DESK_COLORS, DESK_NAME_MAX, type DeskColor } from '../../../src/remote/app-acts.ts'
import { RES_STATUS, sanitizeDeclaredName } from '../../../src/remote/index.ts'
import { RONDA_INTERVAL_MAX, RONDA_TEXT_MAX, SLOT_NAME_MAX } from '../../../src/remote/manage.ts'

// ---------------------------------------------------------------- what this device may do

/**
 * The four families of management (src/remote/scopes.ts), as the device holds them, and `channels`: managing a channel from
 * afar (calling, muting, taking out, reopening, closing a poll, creating one) is the channels' own scope (fio-spec 18).
 */
export interface Caps { desks: boolean; agents: boolean; procs: boolean; destructive: boolean; channels: boolean }
export const NO_CAPS: Caps = { desks: false, agents: false, procs: false, destructive: false, channels: false }

/**
 * What the device may do from its scopes (`session.info`). A device without a presence credential acts on nothing (E-8):
 * its menus have no act at all.
 */
export function capsOf(scopes: readonly unknown[], credential: boolean): Caps {
  if (!credential) return NO_CAPS
  const has = (s: string): boolean => scopes.includes(s)
  return { desks: has('manage:desks'), agents: has('manage:agents'), procs: has('manage:procs'), destructive: has('manage:destructive'), channels: has('channels') }
}

export const managesAny = (c: Caps): boolean => c.desks || c.agents || c.procs || c.destructive

// ---------------------------------------------------------------- the rows of the menus

/** Every act a row of a menu may start. */
export type ManageAct =
  | 'desk.rename' | 'desk.color' | 'desk.hibernate' | 'desk.wake' | 'desk.close'
  | 'desk.give' | 'desk.take' | 'desk.return' | 'desk.revoke'
  | 'pane.peek' | 'pane.rename' | 'pane.move' | 'pane.hibernate' | 'pane.wake' | 'pane.suspend' | 'pane.close'
  | 'agent.restart' | 'agent.start' | 'agent.stop'
  | 'pane.give' | 'pane.take' | 'pane.return' | 'pane.revoke'
  | 'closed.reopen' | 'closed.forget'

export interface MenuRow { act: ManageAct; label: string; icon: string; danger?: true }
export type MenuLine = MenuRow | { heading: string } | 'sep'

export interface OwnerFacts { id: string; name: string }

/** A desk of the tree, as its menu needs it. */
export interface DeskFacts {
  id: string
  name: string
  kind: 'queue' | 'system' | 'drawer'
  asleep: boolean
  /** Desks of the queue, and how many of them are awake. */
  queue: number
  awake: number
  owner?: OwnerFacts
}

/** A pane of the tree, as its menu needs it. */
export interface PaneFacts {
  id: string
  deskId: string
  title: string
  /** 'terminal' for a slot's pane (an agent's or a shell's), else the pane type. */
  type: string
  /** The agent that runs in it, when one does. */
  agent?: { name: string }
  asleep: boolean
  exited: boolean
  busy: boolean
  /** Its own owner (given to an agent), and its desk's. */
  owner?: OwnerFacts
  deskOwner?: OwnerFacts
  /** Other awake desks of the queue it may move to. */
  moveTo: number
}

/** A closed session ("Fechadas"). */
export interface ClosedFacts { id: string; name: string; awakeDesks: number }

const isSlot = (p: PaneFacts): boolean => p.type === 'terminal'
const live = (p: PaneFacts): boolean => isSlot(p) && !p.asleep && !p.exited

/** The labels the app's menus use (manager-menu-rules.ts, main.ts deskMenuEntries/slotMenuEntries, the Regency's renderer). */
export const LABEL = {
  rename: 'Renomear',
  renamePane: 'Renomear…',
  color: 'Cor…',
  hibernateDesk: 'Hibernar mesa',
  wakeDesk: 'Despertar mesa',
  closeDesk: 'Fechar mesa…',
  peek: 'Espiar',
  move: 'Mover…',
  hibernatePane: 'Hibernar guia',
  wakePane: 'Despertar guia',
  suspend: 'Suspender guia',
  closePane: 'Fechar guia',
  restart: 'Reiniciar agente',
  start: 'Retomar agente',
  stop: 'Encerrar agente…',
  reopen: 'Reabrir em…',
  forget: 'Esquecer…',
  newDesk: 'Nova mesa',
} as const

const sep = 'sep' as const

/** Separators never lead, trail or come two in a row (manager-menu-rules.ts `tidy`). */
function tidy(lines: readonly MenuLine[]): MenuLine[] {
  const out: MenuLine[] = []
  for (const l of lines) {
    if (l === sep && (out.length === 0 || out[out.length - 1] === sep)) continue
    // A heading with nothing under it goes.
    if (l !== sep && 'heading' in l && out.length > 0) {
      const last = out[out.length - 1]!
      if (last !== sep && 'heading' in last) out.pop()
    }
    out.push(l)
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!
    if (last === sep || 'heading' in last) out.pop()
    else break
  }
  return out
}

/** The ownership rows (for-agents' words), of a desk or a pane, by what the device holds of the agents. */
function ownerRows(kind: 'desk' | 'pane', owner: OwnerFacts | undefined, caps: Caps, canGive: boolean): MenuLine[] {
  if (!caps.agents) return []
  if (!owner) return canGive ? [{ act: kind === 'desk' ? 'desk.give' : 'pane.give', label: kind === 'desk' ? L.giveDesk : L.givePane, icon: 'robot' }] : []
  return kind === 'desk'
    ? [
      { act: 'desk.take', label: L.takeDesk, icon: 'hand-grabbing' },
      { act: 'desk.return', label: L.returnDesk(owner.name), icon: 'arrow-u-up-left' },
      { act: 'desk.revoke', label: L.revokeDesk(owner.name), icon: 'x-circle' },
    ]
    : [
      { act: 'pane.take', label: L.take, icon: 'hand-grabbing' },
      { act: 'pane.return', label: L.returnPane(owner.name), icon: 'arrow-u-up-left' },
      { act: 'pane.revoke', label: L.revokeSelf(owner.name), icon: 'x-circle' },
    ]
}

/**
 * A desk's menu: the pill's rows the house can do from afar ("Renomear", "Cor…", "Hibernar mesa" or "Despertar mesa",
 * "Fechar mesa…") and who commands it. Browser and the drawer have nothing to manage from afar (the app's only row there is
 * "Ir até a mesa"). Empty: no menu.
 */
export function deskMenu(d: DeskFacts, caps: Caps, agents: number): MenuLine[] {
  if (d.kind !== 'queue') return []
  const rows: MenuLine[] = []
  if (caps.desks) {
    rows.push({ act: 'desk.rename', label: LABEL.rename, icon: 'pencil-simple' }, { act: 'desk.color', label: LABEL.color, icon: 'palette' })
    if (d.asleep) rows.push({ act: 'desk.wake', label: LABEL.wakeDesk, icon: 'sun' })
    else if (d.awake > 1) rows.push({ act: 'desk.hibernate', label: LABEL.hibernateDesk, icon: 'moon' })
  }
  if (caps.destructive && d.queue > 1) rows.push({ act: 'desk.close', label: LABEL.closeDesk, icon: 'x', danger: true })
  const owner = ownerRows('desk', d.owner, caps, agents > 0)
  return tidy([...rows, ...(owner.length > 0 ? [sep, { heading: `Quem manda aqui: ${d.owner?.name ?? 'você'}` }, ...owner] : [])])
}

/**
 * A pane's menu, in the app's blocks: "O agente <nome>" (restart, resume, end), "Esta guia" (see, name, place, sleep, close)
 * and "Quem manda aqui: <dono>" (ownership). Only what the device's scopes allow and what the pane's state makes sense of.
 */
export function paneMenu(p: PaneFacts, caps: Caps, agents: number): MenuLine[] {
  const agent: MenuLine[] = []
  if (p.agent && caps.agents) {
    if (live(p)) agent.push({ act: 'agent.restart', label: LABEL.restart, icon: 'arrow-clockwise' }, { act: 'agent.stop', label: LABEL.stop, icon: 'stop-circle', danger: true })
    else if (p.exited && !p.asleep) agent.push({ act: 'agent.start', label: LABEL.start, icon: 'play' })
  }
  const pane: MenuLine[] = [{ act: 'pane.peek', label: LABEL.peek, icon: 'eye' }]
  if (isSlot(p) && caps.agents) pane.push({ act: 'pane.rename', label: LABEL.renamePane, icon: 'pencil-simple' })
  if (caps.desks) {
    if (p.moveTo > 0) pane.push({ act: 'pane.move', label: LABEL.move, icon: 'arrow-square-out' })
    if (isSlot(p) && p.asleep) pane.push({ act: 'pane.wake', label: LABEL.wakePane, icon: 'sun' })
    else if (live(p)) {
      pane.push({ act: 'pane.hibernate', label: LABEL.hibernatePane, icon: 'moon' })
      if (p.agent) pane.push({ act: 'pane.suspend', label: LABEL.suspend, icon: 'leaf' })
    }
  }
  if (caps.destructive) pane.push(sep, { act: 'pane.close', label: LABEL.closePane, icon: 'x', danger: true })
  const owns = isSlot(p) ? ownerRows('pane', p.owner, caps, agents > 0) : []
  const commander = p.owner?.name ?? p.deskOwner?.name ?? 'você'
  return tidy([
    ...(agent.length > 0 ? [{ heading: `O agente ${p.agent!.name}` }, ...agent, sep] : []),
    { heading: 'Esta guia' }, ...pane,
    ...(owns.length > 0 ? [sep, { heading: `Quem manda aqui: ${commander}` }, ...owns] : []),
  ])
}

/** A closed session's menu: "Reabrir em…" and "Esquecer…", as the app's. */
export function closedMenu(c: ClosedFacts, caps: Caps): MenuLine[] {
  return tidy([
    ...(caps.desks && c.awakeDesks > 0 ? [{ act: 'closed.reopen' as const, label: LABEL.reopen, icon: 'arrow-clockwise' }] : []),
    sep,
    ...(caps.destructive ? [{ act: 'closed.forget' as const, label: LABEL.forget, icon: 'trash', danger: true as const }] : []),
  ])
}

/** The acts whose proof is this very act (the portal's `per-act` lines). */
const PER_ACT: ReadonlySet<ManageAct> = new Set(['desk.close', 'pane.close', 'closed.forget'])
export const provedByAct = (a: ManageAct): boolean => PER_ACT.has(a)

// ---------------------------------------------------------------- the questions, in the app's words

export interface Choice { id: string; label: string; consequence: string; tone: 'safe' | 'neutral' | 'destructive'; proof?: true }
export interface Question {
  title: string
  /** What is at stake (the dialog's context: a name and its lines). */
  context?: { name: string; lines: string[]; status?: string }
  lead?: string
  choices: Choice[]
  cancel: string
  /** A reason is asked (a force over another's use): its label and its ceiling. */
  reason?: { label: string; placeholder: string }
}

/** What the person reads before the system asks for the biometrics: what is going to be done, and why it asks. */
export const PROOF_LINE = 'Para isso, o tether pede a biometria deste aparelho.'
export const PROVING = 'Confirme com a biometria deste aparelho…'

const names4 = (names: readonly string[]): string[] => (names.length > 4 ? [...names.slice(0, 4), `e mais ${names.length - 4}`] : [...names])

/** "o Claude", "o shell": the subject of the sentences about a pane (situations.ts SUBJECT). */
export const subjectOf = (engineLabel: string | undefined): { low: string; cap: string } =>
  engineLabel === undefined ? { low: 'o shell', cap: 'O shell' } : { low: `o ${engineLabel}`, cap: `O ${engineLabel}` }

/**
 * Closing a pane (situations.ts closePanelSituation): with a live process, keep it running without a pane or end it; with
 * none, close the pane or forget the session. A pane with no process (a note, a browser tab) only closes.
 */
export function closePaneQuestion(p: PaneFacts, engine: string | undefined): Question {
  const s = subjectOf(engine)
  const shell = engine === undefined
  if (!isSlot(p)) {
    return { title: `Fechar a guia "${p.title}"?`, choices: [{ id: 'keep', label: 'Fechar a guia', consequence: 'A guia sai da mesa.', tone: 'neutral', proof: true }], cancel: 'Deixar aberto' }
  }
  if (live(p)) {
    return {
      title: shell ? 'Esta guia tem um shell aberto' : `Esta guia tem ${s.low} rodando`,
      context: { name: p.title, lines: [], status: 'rodando agora' },
      choices: [
        { id: 'keep', label: 'Só fechar a guia', consequence: shell ? 'O shell continua rodando sem guia e usando memória. Dá para abrir de novo em Sessões.' : `${s.cap} continua rodando sem guia e usando memória. Dá para abrir de novo em Sessões.`, tone: 'safe', proof: true },
        { id: 'stop', label: `Encerrar ${s.low}`, consequence: shell ? 'O processo e o que roda nele terminam agora. Um shell não tem conversa: reabrir cria um shell novo na mesma pasta.' : 'Encerrar guarda a conversa; dá para reabrir em Sessões.', tone: 'destructive', proof: true },
      ],
      cancel: 'Deixar aberto',
    }
  }
  return {
    title: shell ? 'Nenhum shell aberto nesta guia' : `${s.cap} não está rodando nesta guia`,
    context: { name: p.title, lines: [], status: 'nada rodando' },
    choices: [{ id: 'keep', label: 'Fechar a guia', consequence: shell ? 'A sessão fica em Encerradas, em Sessões; reabrir abre um shell novo na mesma pasta.' : 'A sessão fica em Encerradas, em Sessões; reabrir retoma a conversa.', tone: 'safe', proof: true }],
    cancel: 'Deixar aberto',
  }
}

/** Ending the agent of a pane (the close dialog's "Encerrar …" without closing the pane): it keeps its conversation. */
export function stopAgentQuestion(p: PaneFacts, engine: string | undefined): Question {
  const s = subjectOf(engine)
  return {
    title: `Encerrar ${s.low} de "${p.agent?.name ?? p.title}"?`,
    context: { name: p.title, lines: [], status: p.busy ? 'trabalhando agora' : 'rodando agora' },
    choices: [{ id: 'stop', label: `Encerrar ${s.low}`, consequence: 'Encerrar guarda a conversa; dá para reabrir em Sessões.', tone: 'destructive' }],
    cancel: 'Deixar rodando',
  }
}

/**
 * Closing a desk (situations.ts closeDeskSituation): move its panes to the neighbour, or end what runs and close them. An
 * empty desk only closes.
 */
export function closeDeskQuestion(deskName: string, panes: readonly PaneFacts[], neighbour: string | undefined): Question {
  if (panes.length === 0 || neighbour === undefined) {
    return { title: `Fechar a mesa "${deskName}"?`, choices: [{ id: 'move', label: 'Fechar a mesa', consequence: 'A mesa vazia sai da fila.', tone: 'neutral', proof: true }], cancel: 'Cancelar' }
  }
  const running = panes.filter(live).length
  const word = panes.length === 1 ? '1 painel' : `${panes.length} painéis`
  return {
    title: running > 0 ? `A mesa "${deskName}" tem agentes rodando` : `Fechar a mesa "${deskName}"?`,
    context: {
      name: `${deskName}: ${word}`, lines: names4(panes.map(p => p.agent?.name ?? p.title)),
      status: running > 0 ? (running === 1 ? '1 processo rodando' : `${running} processos rodando`) : 'nada rodando',
    },
    choices: [
      { id: 'move', label: `Mover os painéis para "${neighbour}"`, consequence: 'Os painéis vão para a outra mesa, com tudo rodando como está, e esta mesa fecha.', tone: 'safe', proof: true },
      running > 0
        ? { id: 'stop', label: 'Encerrar e fechar a mesa', consequence: 'Os processos dos painéis são finalizados agora e a mesa fecha. As conversas ficam salvas: os slots ficam em Slots fechados e retomam ao reabrir.', tone: 'destructive', proof: true }
        : { id: 'stop', label: 'Fechar os painéis e a mesa', consequence: 'Nada está rodando. Os painéis saem da tela e ficam em Slots fechados.', tone: 'neutral', proof: true },
    ],
    cancel: 'Cancelar',
  }
}

/** Forgetting a closed session (the Regency's "Esquecer…"). */
export function forgetClosedQuestion(name: string): Question {
  return {
    title: `Esquecer a sessão de ${name}?`,
    lead: 'O tether deixa de guardar esta sessão encerrada. Isso não pode ser desfeito.',
    choices: [{ id: 'forget', label: 'Esquecer', consequence: 'A sessão sai de "Fechadas" e não volta.', tone: 'destructive', proof: true }],
    cancel: 'Cancelar',
  }
}

/** Hibernating panes whose agents are mid-turn (situations.ts hibernateSituation); asked only then. */
export function hibernateQuestion(where: string, busy: readonly string[]): Question {
  return {
    title: busy.length === 1 ? `Um agente ${where} está trabalhando` : `${busy.length} agentes ${where} estão trabalhando`,
    context: { name: where.replace(/^d[aeo] /, ''), lines: names4(busy), status: 'em andamento' },
    choices: [{ id: 'hibernate', label: 'Hibernar mesmo assim', consequence: 'Os processos param agora, no meio do turno. As conversas ficam salvas e retomam ao despertar.', tone: 'destructive' }],
    cancel: 'Cancelar',
  }
}

/** Forgetting a process (its recipe and its record): it cannot be undone. */
export function forgetProcQuestion(name: string): Question {
  return {
    title: `Esquecer o processo "${name}"?`,
    lead: 'O tether deixa de guardar este processo e a receita dele. Isso não pode ser desfeito.',
    choices: [{ id: 'forget', label: 'Esquecer', consequence: 'O processo sai da lista e não volta.', tone: 'destructive', proof: true }],
    cancel: 'Cancelar',
  }
}

/** Forgetting a process another uses: who, until when, what for, and the force with a reason, as a second act. */
export function forgetInUseQuestion(name: string, lines: readonly string[]): Question {
  return {
    title: `Não dá para esquecer "${name}" agora: ${lines.length === 1 ? 'outro o usa' : `${lines.length} o usam`}.`,
    context: { name, lines: [...lines] },
    choices: [{ id: 'force', label: 'Forçar agora', consequence: 'Passa por cima de quem usa; fica registrado com o seu motivo.', tone: 'destructive', proof: true }],
    cancel: 'Cancelar',
    reason: { label: 'Motivo (fica registrado):', placeholder: 'Por que forçar agora?' },
  }
}

// ---------------------------------------------------------------- the refusals, in the person's words

/** The sentence for a refusal of an act (the house's code, or the device's own), never the code itself. */
export function refusalWords(code: string): string {
  switch (code) {
    case 'no-app': return 'O tether não está aberto na máquina. Nada foi feito.'
    case 'with-user': return 'Alguém está usando esta guia na máquina agora.'
    case 'in-view': return 'Esta mesa está na tela da máquina agora: ela não sai de debaixo de quem olha.'
    case 'last-desk': return 'É a última mesa desperta: ela fica de pé.'
    case 'same-desk': return 'A guia já está nessa mesa.'
    case 'not-closed': return 'Essa sessão já tem guia.'
    case 'not-given': return 'Nenhum agente tem isso agora.'
    case 'cannot': return 'Isso não se faz com esta guia.'
    case 'owners-off': return 'A posse dos agentes está desligada na máquina.'
    case 'unconfirmed': return 'Esta guia precisa de uma escolha (retomar ou começar de novo) na própria guia, na máquina.'
    case 'no-answer': return 'O tether na máquina não respondeu a tempo. Pode ter feito: a tela mostra quando ele contar.'
    case 'refused': return 'O tether na máquina não fez.'
    case 'timeout': return 'A máquina não respondeu a tempo. Pode ter feito: a tela mostra quando ela contar.'
    case 'busy': return 'Outro pedido espera a máquina agora. Tente de novo em instantes.'
    case 'slow-down': return 'Pedidos demais em seguida. Espere um pouco.'
    case 'unknown-desk': return 'Essa mesa não existe mais.'
    case 'stale': return 'A mesa mudou; confira e tente de novo.'
    case 'unknown-pane': return 'A guia não está mais nessa mesa.'
    case 'unknown-slot': return 'Essa sessão não existe mais.'
    case 'unknown-agent': return 'Esse agente não existe mais.'
    case 'too-long': return 'O texto passa do tamanho que dá para mandar.'
    case 'no-scope': return 'Este aparelho não tem permissão para isso.'
    case 'no-credential': return 'Este aparelho só lê: gerir pede a biometria cadastrada.'
    case 'locked': return 'O aparelho trancou. Destranque e tente de novo.'
    case 'cut': return 'A conexão caiu antes da resposta. Pode ter feito: a tela mostra quando a máquina voltar.'
    case 'cancelled': return 'A biometria foi cancelada. Nada foi feito.'
    case 'no-biometrics': case 'browser-refused': return 'Este navegador não fez a biometria. Nada foi feito.'
    case 'house-refused': return 'A máquina não aceitou a biometria. Nada foi feito.'
    case 'session-missing': return 'A conversa deste agente não existe mais.'
    case 'cwd-missing': return 'A pasta deste agente não existe mais.'
    case 'already-open': return 'O agente já está aberto.'
    case 'spawn-failed': return 'O agente não conseguiu subir.'
    case 'agent-unavailable': return 'Este motor não está disponível na máquina.'
    case 'bad-request': return 'A máquina não entendeu o pedido. Nada foi feito.'
    case 'desk-asleep': return 'Essa mesa está hibernando: desperte-a antes de criar nela.'
    case 'unknown-folder': return 'Essa pasta não está mais na lista do tether.'
    case 'unknown-profile': return 'Esse perfil não existe mais na máquina.'
    case 'unknown-engine': return 'Esse motor não está disponível na máquina.'
    case 'proc-exists': return 'Já existe um processo com esse nome: escolha outro nome.'
    default: return refusalText(code)
  }
}

/** The answer of an act that is done but changed nothing. */
export const ALREADY = 'Já estava assim.'

// ---------------------------------------------------------------- an act on its way

export type Reply = { status: number; body: Record<string, unknown> }

/** What an answer means for an act on its way. `proof`: the act travels with a proof (of the act, or the window). */
export type ActStep =
  | { do: 'done'; body: Record<string, unknown> }
  /** The session fell, or the house said `timeout`: the same actId again (the portal answers a repeat with the real outcome). */
  | { do: 'resend'; afterMs: number }
  /** The proof did not hold (a new session, the window ran out): prove again, the same act. */
  | { do: 'prove' }
  | { do: 'locked' }
  | { do: 'fail'; code: string }

export const RESEND_MS = 2_000
/** How long an act waits for a session and an answer before it gives up. */
export const ACT_DEADLINE_MS = 45_000

const errorOf = (body: Record<string, unknown>): string | undefined => (typeof body.error === 'string' && /^[a-z][a-z-]{0,31}$/.test(body.error) ? body.error : undefined)

export function actStepOf(r: Reply, proof: 'none' | 'act' | 'window'): ActStep {
  if (r.status === -1) return { do: 'resend', afterMs: RESEND_MS }
  if (r.status === RES_STATUS.ok) return { do: 'done', body: r.body }
  const code = errorOf(r.body)
  switch (r.status) {
    case RES_STATUS.locked: return { do: 'locked' }
    case RES_STATUS.presenceRequired: return proof === 'none' ? { do: 'fail', code: 'no-credential' } : { do: 'prove' }
    case RES_STATUS.noScope: return { do: 'fail', code: 'no-scope' }
    case RES_STATUS.noApp: return { do: 'fail', code: 'no-app' }
    case RES_STATUS.limit: return { do: 'fail', code: code === 'slow-down' ? 'slow-down' : 'busy' }
    case RES_STATUS.notFound: return { do: 'fail', code: code ?? 'unknown-desk' }
    case RES_STATUS.badRequest: return { do: 'fail', code: code ?? 'bad-request' }
    case RES_STATUS.failed: return code === 'timeout' ? { do: 'resend', afterMs: RESEND_MS } : { do: 'fail', code: code ?? 'refused' }
    default: return { do: 'fail', code: code ?? 'refused' }
  }
}

/** A proof is asked again at most this many times for one act (a cancelled biometrics ends it at once). */
export const PROOF_TRIES = 2

// ---------------------------------------------------------------- the ceilings, before anything is sent

export type Checked<T> = { ok: true; value: T } | { ok: false; why: string }

/** What the portal does to a declared name: one line, no controls, bidi or zero width (the same function). */
const fold = sanitizeDeclaredName

export function deskNameCheck(name: string): Checked<string> {
  if (name.length > DESK_NAME_MAX) return { ok: false, why: `O nome da mesa passa de ${DESK_NAME_MAX} letras.` }
  const v = fold(name)
  return v === '' ? { ok: false, why: 'Diga o nome da mesa.' } : { ok: true, value: v }
}

export function slotNameCheck(name: string): Checked<string> {
  if (name.length > SLOT_NAME_MAX) return { ok: false, why: `O nome passa de ${SLOT_NAME_MAX} letras.` }
  const v = fold(name)
  return v === '' ? { ok: false, why: 'Diga o nome.' } : { ok: true, value: v }
}

export const isDeskColor = (c: string): c is DeskColor => (DESK_COLORS as readonly string[]).includes(c)
export { DESK_COLORS, type DeskColor }

/** The ronda's change as the portal takes it: an interval of `[0-9a-z ]`, a nudge and a criterion of at most 500. */
export function rondaCheck(change: { interval?: string; nudge?: string; criterion?: string }): Checked<{ interval?: string; nudge?: string; criterion?: string }> {
  const out: { interval?: string; nudge?: string; criterion?: string } = {}
  if (change.interval !== undefined) {
    const i = change.interval.trim().toLowerCase()
    if (i.length > RONDA_INTERVAL_MAX || !/^[0-9a-z ]{1,16}$/.test(i)) return { ok: false, why: 'Intervalo inválido (ex.: 20m, 1h).' }
    out.interval = i
  }
  for (const k of ['nudge', 'criterion'] as const) {
    const v = change[k]
    if (v === undefined) continue
    if (v.length > RONDA_TEXT_MAX) return { ok: false, why: `${k === 'nudge' ? 'O cutucão' : 'O critério'} passa de ${RONDA_TEXT_MAX} letras.` }
    out[k] = fold(v)
  }
  return { ok: true, value: out }
}

/** The reason of a force (system-rules.ts forceReasonError: required, at most 200, the portal's PROC_REASON_MAX). */
export function reasonCheck(reason: string): Checked<string> {
  const bad = forceReasonError(reason)
  return bad ? { ok: false, why: bad } : { ok: true, value: fold(reason) }
}

/** The desk next to `id` in the queue (the one a closed desk's panes go to): the next, else the one before. */
export function neighbourOf<T extends { id: string }>(queue: readonly T[], id: string): T | undefined {
  const i = queue.findIndex(d => d.id === id)
  if (i < 0) return undefined
  return queue[i + 1] ?? queue[i - 1]
}
