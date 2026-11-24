// The words and the rows of the channel commands (U2), as pure functions: the picker's items, the confirmation dialogs and the
// refusals in plain language. No DOM and no daemon, so a unit test reads them. Words on the screen are Portuguese (P12: dono,
// membro, moderador, calado).
import { agentHue } from '../../../app/shared/agent-color.ts'
import type { DialogSpec } from '../../../app/shared/dialog.ts'
import type { PaneEmblem, PickItem } from '../../../app/renderer/ext-api.ts'
import type { ChannelSummary, MemberInfo } from '../daemon/requests.ts'
import { isRoomName } from '../rules.ts'
import { membersCount, type EmblemReader, type MembersAnswer } from './view-model.ts'

/** The picker's icon for a channel row, and the icons of the menus (names of app/renderer/icons.ts: the core's table). */
export const ICON = {
  channel: 'chats-circle', join: 'user-plus', remove: 'user-minus', mute: 'speaker-slash', unmute: 'speaker-high',
  close: 'prohibit', reopen: 'arrow-counter-clockwise', closed: 'lock',
} as const

/** What each command asks in its pickers. */
export const PICK = {
  open: { title: 'Abrir canal', placeholder: 'Buscar canal', empty: 'Não há canais ainda.' },
  join: { title: 'Juntar agente a que canal?', placeholder: 'Buscar canal', empty: 'Não há canais abertos.' },
  remove: { title: 'Tirar agente de que canal?', placeholder: 'Buscar canal', empty: 'Não há canais abertos.' },
  mute: { title: 'Calar agente em que canal?', placeholder: 'Buscar canal', empty: 'Não há canais abertos.' },
  unmute: { title: 'Devolver a voz em que canal?', placeholder: 'Buscar canal', empty: 'Não há canais abertos.' },
  close: { title: 'Encerrar que canal?', placeholder: 'Buscar canal', empty: 'Não há canais abertos para encerrar.' },
  reopen: { title: 'Reabrir que canal?', placeholder: 'Buscar canal', empty: 'Não há canais encerrados para reabrir.' },
  agentJoin: (channel: string, noAgents = false) => ({
    title: `Juntar a #${channel}`, placeholder: 'Buscar agente',
    empty: noAgents ? 'Não há guia de agente aberta. Abra um agente numa mesa e ele aparece aqui.' : 'Nenhum agente fora do canal.',
  }),
  agentRemove: (channel: string) => ({ title: `Tirar de #${channel}`, placeholder: 'Buscar membro', empty: 'Não há ninguém para tirar.' }),
  agentMute: (channel: string) => ({ title: `Calar em #${channel}`, placeholder: 'Buscar membro', empty: 'Ninguém para calar: todos já estão calados.' }),
  agentUnmute: (channel: string) => ({ title: `Devolver a voz em #${channel}`, placeholder: 'Buscar membro', empty: 'Não há calados neste canal.' }),
} as const

/** Which channels a command's first step lists. */
export type ChannelScope = 'all' | 'open' | 'closed' | 'common-open'

/** The channels a scope keeps: the desk's channel never closes or reopens by hand (C17). */
export function inScope(list: readonly ChannelSummary[], scope: ChannelScope): ChannelSummary[] {
  switch (scope) {
    case 'all': return [...list]
    case 'open': return list.filter(c => !c.closed)
    case 'closed': return list.filter(c => c.closed && c.desk === undefined)
    case 'common-open': return list.filter(c => !c.closed && c.desk === undefined)
  }
}

const ownerName = (c: ChannelSummary): string => (c.owner.kind === 'agent' ? c.owner.name : 'Você')

/** "4 membros · dono: Atrium", with the channel's condition first. */
export function channelDetail(c: ChannelSummary): string {
  const parts: string[] = []
  if (c.closed) parts.push('encerrado · só leitura')
  else if (c.desk !== undefined) parts.push('canal da mesa')
  // A closed channel keeps no members: the count would read "0".
  if (!c.closed) parts.push(membersCount(c.members), `dono: ${ownerName(c)}`)
  return parts.join(' · ')
}

/** The channel as a picker row: `#name`, the members' count and the owner (P2: the count is how the person tells them apart). */
export function channelItem(c: ChannelSummary): PickItem<string> {
  return {
    value: c.id, label: `#${c.name}`, detail: channelDetail(c),
    icon: c.closed ? ICON.closed : ICON.channel,
    ...(c.owner.kind === 'agent' ? { hue: agentHue(c.owner.id) } : {}),
  }
}

/**
 * The first step: the desk's own channel on top (featured) when the scope keeps it and it is open, then the open channels,
 * then the closed ones apart. Rows keep the daemon's order.
 */
export function channelPick(list: readonly ChannelSummary[], scope: ChannelScope, deskId: string | undefined): { featured?: PickItem<string>; items: PickItem<string>[] } {
  const kept = inScope(list, scope)
  const here = deskId === undefined ? undefined : kept.find(c => c.desk === deskId && !c.closed)
  const rest = kept.filter(c => c !== here)
  const items = [
    ...rest.filter(c => !c.closed).map(c => ({ ...channelItem(c), group: 'Canais abertos' })),
    ...rest.filter(c => c.closed).map(c => ({ ...channelItem(c), group: 'Encerrados' })),
  ]
  return { ...(here ? { featured: channelItem(here) } : {}), items }
}

/** A channel the person named (by id, or by the name with or without the `#`). */
export function findChannel(list: readonly ChannelSummary[], ref: string): ChannelSummary | undefined {
  const byId = list.find(c => c.id === ref)
  if (byId) return byId
  const name = ref.replace(/^#/, '')
  return list.find(c => c.name === name && !c.closed) ?? list.find(c => c.name === name)
}

/** The row's `emblem` field for the agent with this id: the emblem its tab wears, or nothing. */
function emblemField(id: string, emblemOf: EmblemReader | undefined): { emblem?: PaneEmblem } {
  const emblem = emblemOf?.(id)
  return emblem ? { emblem } : {}
}

/** The agent panes the person can add: alive, not in the channel, not removed from the question (they come back by a join). */
export interface AgentChoice { slotId: string; kind: string; name: string; deskId?: string; deskTitle?: string; alive: boolean }

export function agentLabel(a: Pick<AgentChoice, 'kind' | 'name'>): string {
  return `${a.kind} · ${a.name}`
}

/** What the join's list knows besides the agents: who the daemon says was taken out, and the desks (order and sleep). */
export interface JoinContext {
  /** Ids the channel took out (`members.removed`): they come back by a join (C18) and the row says so. */
  removed?: ReadonlySet<string>
  /** The queue's desks in order; a sleeping one marks its agents "mesa dormindo". */
  desks?: readonly { id: string; asleep: boolean }[]
}

export const JOIN_GROUP = { drawer: 'Gaveta e blocos', stopped: 'Parados' } as const
export const JOIN_MARK = { removed: 'tirado deste canal', stopped: 'parado', asleep: 'mesa dormindo' } as const

/**
 * The join's list (G5): every agent pane outside the channel. Groups in order: the active desk ("Nesta mesa · nome"), the
 * other desks ("Mesa · nome", in the queue's order), "Gaveta e blocos" (panes with no desk), and last "Parados": a stopped
 * agent or one of a sleeping desk, still joinable (it reads what it missed when it wakes). A row says only what is worth
 * saying: "tirado deste canal", "parado", "mesa dormindo".
 */
export function joinItems(agents: readonly AgentChoice[], inside: ReadonlySet<string>, deskId: string | undefined, emblemOf?: EmblemReader, ctx: JoinContext = {}): PickItem<string>[] {
  const out = agents.filter(a => !inside.has(a.slotId))
  const asleepDesk = (a: AgentChoice): boolean => a.deskId !== undefined && ctx.desks?.find(d => d.id === a.deskId)?.asleep === true
  const stopped = (a: AgentChoice): boolean => !a.alive || asleepDesk(a)
  // A desk's rank: the active one first, then the queue's order, then first appearance among the agents.
  const seen: string[] = []
  for (const a of out) if (a.deskId !== undefined && a.deskId !== deskId && !seen.includes(a.deskId)) seen.push(a.deskId)
  const rank = (a: AgentChoice): number => {
    if (a.deskId === undefined) return Number.MAX_SAFE_INTEGER
    if (a.deskId === deskId) return -1
    const q = ctx.desks?.findIndex(d => d.id === a.deskId) ?? -1
    return q >= 0 ? q : 10_000 + seen.indexOf(a.deskId)
  }
  const groupOf = (a: AgentChoice): string => {
    if (stopped(a)) return JOIN_GROUP.stopped
    if (a.deskId === undefined) return JOIN_GROUP.drawer
    return `${a.deskId === deskId ? 'Nesta mesa' : 'Mesa'} · ${a.deskTitle ?? a.deskId}`
  }
  const marks = (a: AgentChoice): string[] => [
    ...(ctx.removed?.has(a.slotId) ? [JOIN_MARK.removed] : []),
    ...(!a.alive ? [JOIN_MARK.stopped] : []), ...(asleepDesk(a) ? [JOIN_MARK.asleep] : []),
  ]
  const row = (a: AgentChoice): PickItem<string> => {
    const m = marks(a)
    return {
      value: a.slotId, label: agentLabel(a), letter: a.name.charAt(0).toUpperCase() || '?', hue: agentHue(a.slotId),
      ...(m.length > 0 ? { detail: m.join(' · ') } : {}), group: groupOf(a), ...emblemField(a.slotId, emblemOf),
    }
  }
  const live = out.filter(a => !stopped(a)).map((a, i) => ({ a, i }))
  const down = out.filter(stopped).map((a, i) => ({ a, i }))
  const byDesk = (x: { a: AgentChoice; i: number }, y: { a: AgentChoice; i: number }): number => rank(x.a) - rank(y.a) || x.i - y.i
  return [...live.sort(byDesk), ...down.sort(byDesk)].map(x => row(x.a))
}

/** Which of the members a gesture offers. */
export type MemberGesture = 'remove' | 'mute' | 'unmute'

/** The second step of remove, mute and unmute: the owner first, as the pane lists them; muted ones only for "devolver a voz". */
export function memberItems(members: readonly MemberInfo[], ownerId: string | undefined, gesture: MemberGesture, emblemOf?: EmblemReader): PickItem<string>[] {
  const kept = members.filter(m => (gesture === 'unmute' ? m.muted : gesture === 'mute' ? !m.muted : true))
  const ordered = [...kept.filter(m => m.id === ownerId), ...kept.filter(m => m.id !== ownerId)]
  return ordered.map(m => ({
    value: m.id, label: m.name, letter: m.name.charAt(0).toUpperCase() || '?', hue: agentHue(m.id),
    detail: [m.id === ownerId ? 'dono' : 'membro', ...(m.muted ? ['calado'] : []), ...(m.by === 'desk' ? ['da mesa'] : [])].join(' · '),
    ...emblemField(m.id, emblemOf),
  }))
}

// ---------- the confirmations ----------

/** `isOwner`: the member is the channel's owner; `desk`: the channel is the desk's own (the owner is then the desk's). */
export interface MemberText { channel: string; member: string; fromDesk: boolean; isOwner?: boolean; desk?: boolean }

/** "Tirar": the consequence in words before the act. Taking the owner out tells that he abdicates (C16, C20). */
export function removeDialog(t: MemberText): DialogSpec {
  const message = ['Ele deixa de ouvir o canal e recebe um aviso da sala. A conversa continua com os outros.']
  if (t.isOwner) {
    message.push(t.desk
      ? 'Ele é o dono da mesa. O canal segue com você até a mesa trocar de dono.'
      : 'Ele é o dono deste canal. Ao sair deixa de ser dono, e o canal passa para você. Se for juntado de novo, volta como membro.')
  }
  if (t.fromDesk) message.push('Ele é membro da mesa, mas pode sair do canal mesmo assim. Fica de fora até ser juntado de novo, ou até sair da mesa e voltar.')
  return {
    situation: 'channels.remove', tone: 'danger', icon: ICON.remove,
    title: `Tirar ${t.member} de #${t.channel}?`, message: message.join(' '),
    choices: [{ id: 'remove', icon: ICON.remove, label: 'Tirar do canal', consequence: `${t.member} deixa de ouvir #${t.channel} até ser juntado de novo.`, tone: 'destructive' }],
    cancelLabel: 'Cancelar',
  }
}

/** "Calar": the member keeps hearing and stops speaking. */
export function muteDialog(t: MemberText): DialogSpec {
  return {
    situation: 'channels.mute', tone: 'warn', icon: ICON.mute,
    title: `Calar ${t.member} em #${t.channel}?`,
    message: 'Ele continua ouvindo tudo e deixa de falar neste canal. Você pode devolver a voz quando quiser.',
    choices: [{ id: 'mute', icon: ICON.mute, label: 'Calar', consequence: `${t.member} segue ouvindo #${t.channel}, mas não consegue falar nele.`, tone: 'neutral' }],
    cancelLabel: 'Cancelar',
  }
}

export interface CloseText { channel: string; members: number }

/** "Encerrar": nobody speaks any more, the history stays readable and can be reopened (P6). */
export function closeDialog(t: CloseText): DialogSpec {
  return {
    situation: 'channels.close', tone: 'danger', icon: ICON.close,
    title: `Encerrar #${t.channel}?`,
    message: `Ninguém mais fala nele, e ${t.members === 1 ? 'o 1 membro recebe' : `os ${t.members} membros recebem`} um aviso da sala. A conversa fica guardada e legível; você, ou o dono, pode reabrir o canal depois.`,
    choices: [{ id: 'close', icon: ICON.close, label: 'Encerrar canal', consequence: `#${t.channel} fica só para leitura até ser reaberto.`, tone: 'destructive' }],
    cancelLabel: 'Cancelar',
  }
}

// ---------- what could not be done ----------

const REFUSALS: Record<string, string> = {
  'not-owner': 'Só o dono do canal e você podem fazer isso.',
  closed: 'O canal está encerrado.',
  'not-closed': 'O canal já está aberto.',
  desk: 'O canal da mesa segue a mesa: ele se encerra e reabre sozinho com o dono dela.',
  removed: 'Esse agente foi tirado do canal e só volta se for juntado de novo.',
  'unknown-agent': 'Esse agente não existe mais.',
  'unknown-channel': 'Esse canal não existe mais.',
  'name-taken': 'Já há um canal aberto com esse nome.',
  'bad-name': 'Use letras minúsculas, números e hífen (1 a 40), começando e terminando com letra ou número.',
  'not-member': 'Esse agente não está no canal.',
  'no-daemon': 'O tetherd não respondeu.',
}

/** `reason` is the daemon's own message, told together with the plain words. */
export function failedDialog(what: string, code: string, reason?: string): DialogSpec {
  const words = REFUSALS[code] ?? `Não foi possível (${code}).`
  return {
    situation: 'channels.failed', tone: 'warn', icon: 'shield-warning',
    title: what, message: reason !== undefined && reason !== '' ? `${words} O tetherd respondeu: ${reason}` : words,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada foi alterado.', tone: 'safe' }],
  }
}

/** The picker that asks for the name of a new channel: the row is made by the typed text (PickSpec.create). */
export const NAME_PICK = { title: 'Criar canal', placeholder: 'Nome do canal (ex.: conferencia)', empty: 'Digite o nome do novo canal.' } as const

/**
 * The row "Criar #nome". The name goes as typed (trimmed, one leading `#` dropped): the daemon is the one that judges it, so the
 * rule's words show under the row while the text is not a name, and a refusal still comes back in a dialog.
 */
export function createRow(query: string): PickItem<string> | undefined {
  const name = query.trim().replace(/^#/, '')
  if (name === '') return undefined
  return {
    value: name, label: `Criar #${name}`, icon: ICON.channel,
    ...(isRoomName(name) ? {} : { detail: 'Só letras minúsculas, números e hífen (1 a 40)' }),
  }
}

// ---------- the menus ----------

/** The gestures drawn in the channel's own pane (header, members column, empty state, member rows). */
export const PANE_TEXT = {
  join: 'Juntar agente',
  joinMenu: 'Juntar agente…',
  reopen: 'Reabrir canal',
  more: 'Mais',
  members: 'Membros',
  toEnd: 'Ir para o fim',
  /** The empty channel: the title, the explanation and (below it) the button "Juntar agente…". */
  noMembers: 'Ninguém aqui ainda.',
  noMembersHelp: 'Junte um agente para a conversa começar. Você lê tudo e pode falar a qualquer momento.',
  mute: 'Calar',
  unmute: 'Devolver a voz',
  remove: 'Tirar do canal',
  /** Title of a member's action: "Calar Nome". */
  on: (verb: string, member: string): string => `${verb} ${member}`,
  talkTo: (member: string): string => `Falar com ${member}`,
  reveal: 'Ir para a guia do agente',
  /** The "⋯" of a member's row. */
  memberMore: (member: string): string => `Mais ações de ${member}`,
} as const

/** A row of the member's menu: an act the pane runs (`id`), a line of information, or a separator. */
export type MemberMenuEntry =
  | { heading: string }
  | 'sep'
  | { id: 'mute' | 'unmute' | 'remove' | 'talk' | 'reveal'; icon: string; label: string; danger?: boolean }

export interface MemberMenuInput { name: string; owner: boolean; muted: boolean; fromDesk: boolean }

/**
 * The member's menu (plan 2.6): who it is, then mute or give the voice back, take out, talk to, go to the agent's pane.
 * The owner has the same rows: taking him out is allowed and the dialog tells what follows.
 */
export function memberMenu(m: MemberMenuInput): MemberMenuEntry[] {
  const info = [m.name, m.owner ? 'dono' : 'membro', ...(m.muted ? ['calado'] : []), ...(m.fromDesk ? ['da mesa'] : [])].join(' · ')
  return [
    { heading: info },
    m.muted
      ? { id: 'unmute', icon: ICON.unmute, label: PANE_TEXT.unmute }
      : { id: 'mute', icon: ICON.mute, label: PANE_TEXT.mute },
    { id: 'remove', icon: ICON.remove, label: PANE_TEXT.remove, danger: true },
    'sep',
    { id: 'talk', icon: ICON.channel, label: PANE_TEXT.talkTo(m.name) },
    { id: 'reveal', icon: 'arrow-square-out', label: PANE_TEXT.reveal },
  ]
}

export type ChannelMenuId = 'join' | 'members' | 'toEnd' | 'mute' | 'unmute' | 'remove' | 'link' | 'move' | 'closePane' | 'close' | 'reopen'

/** A row of the channel's menu: an act the pane runs (`id`), a line of information, or a separator. */
export type ChannelMenuEntry =
  | { heading: string }
  | 'sep'
  | { id: ChannelMenuId; icon: string; label: string; danger?: boolean; checked?: boolean; disabled?: boolean }

/** What the pane knows that the daemon does not: whether the members column is open now. */
export interface ChannelMenuView { membersOpen: boolean }

/**
 * The channel's one menu (plan 2.5), drawn for the tab (right click) and for the bar's "⋯": two lines of information, the gestures,
 * the panel's own rows, and last "Encerrar canal…" (or "Reabrir canal"). Closed: the gestures that need an open channel go. The
 * desk's channel follows the desk (C17): it has neither "Encerrar" nor "Reabrir", and its second line says why.
 */
export function channelMenu(c: ChannelSummary, answer: MembersAnswer | undefined, view: ChannelMenuView = { membersOpen: false }): ChannelMenuEntry[] {
  const members = answer?.members ?? []
  const count = answer ? members.length : c.members
  const muted = members.filter(m => m.muted).length
  const closed = c.closed !== undefined
  const desk = c.desk !== undefined
  const info = [`Dono: ${ownerName(c)}`, membersCount(count), ...(muted > 0 ? [muted === 1 ? '1 calado' : `${muted} calados`] : [])].join(' · ')
  const kind = desk ? `canal da mesa · segue a mesa: encerra e reabre com o dono dela${closed ? ' · encerrado' : ''}` : closed ? 'canal avulso · encerrado' : 'canal avulso'
  const nobody = count === 0
  const rows: ChannelMenuEntry[] = [{ heading: info }, { heading: kind }]
  if (!closed) rows.push({ id: 'join', icon: ICON.join, label: PANE_TEXT.joinMenu })
  if (count > 0) rows.push({ id: 'members', icon: 'sidebar-simple', label: PANE_TEXT.members, checked: view.membersOpen })
  rows.push({ id: 'toEnd', icon: 'arrow-line-down', label: PANE_TEXT.toEnd })
  if (!closed) {
    rows.push({ id: 'mute', icon: ICON.mute, label: 'Calar agente…', ...(nobody ? { disabled: true } : {}) })
    if (muted > 0) rows.push({ id: 'unmute', icon: ICON.unmute, label: 'Devolver a voz…' })
    rows.push({ id: 'remove', icon: ICON.remove, label: 'Tirar agente…', ...(nobody ? { disabled: true } : {}) })
  }
  rows.push('sep',
    { id: 'link', icon: 'link', label: 'Copiar link do painel' },
    { id: 'move', icon: 'arrow-square-out', label: 'Mover…' },
    { id: 'closePane', icon: 'x', label: 'Fechar painel' })
  if (!desk) rows.push('sep', closed ? { id: 'reopen', icon: ICON.reopen, label: MENU.reopen } : { id: 'close', icon: ICON.close, label: MENU.close, danger: true })
  return rows
}

export const MENU = {
  join: 'Juntar a um canal…',
  openDesk: (name: string): string => `Abrir o canal da mesa (#${name})`,
  openAny: 'Abrir canal…',
  close: 'Encerrar canal…',
  reopen: 'Reabrir canal',
} as const
