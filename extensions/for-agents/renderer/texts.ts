// The words of the gestures of ownership (tether for agents): the labels of the menus, the lines of information, the picker and
// the two dialogs ("dar" with its "Voltar", "revogar"), in one place. Pure: no `ui`, no DOM. The wording is the approved
// preview's (sections 3 and 4); "Dono" is written with no gender ("Dono: Atrium"), and an owner's name is the name of its tab.
import type { DialogSpec } from '../../../app/shared/dialog.ts'

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// ---- labels of the rows ----------------------------------------------------------------------------------------------
export const L = {
  goTo: (o: string) => `Ir para ${o}`,
  take: 'Assumir o comando',
  takeDesk: 'Assumir o comando da mesa',
  takeAndAnswer: 'Assumir o comando e responder eu',
  pausePane: (o: string) => `Pausar ${o} nesta guia`,
  pauseSelf: (o: string) => `Pausar ${o} em si mesmo`,
  pauseDesk: (o: string) => `Pausar ${o} nesta mesa`,
  pauseAll: (o: string) => `Pausar ${o} em tudo`,
  resumePane: (o: string) => `Retomar ${o} nesta guia`,
  resumeSelf: (o: string) => `Retomar ${o} em si mesmo`,
  resumeDesk: (o: string) => `Retomar ${o} nesta mesa`,
  resumeAll: (o: string) => `Retomar ${o} em tudo`,
  returnPane: (o: string) => `Devolver a ${o}`,
  returnDesk: (o: string) => `Devolver a mesa a ${o}`,
  inventoryPane: (o: string) => `O que ${o} pode nesta guia…`,
  inventorySelf: (o: string) => `O que ${o} pode em si…`,
  inventoryDesk: (o: string) => `O que ${o} pode aqui…`,
  givePane: 'Dar esta guia a um agente…',
  givePaneOther: 'Dar esta guia a outro agente…',
  givePaneOtherShort: 'Dar a outro agente…',
  giveDesk: 'Dar a mesa a um agente…',
  giveDeskOther: 'Dar a mesa a outro agente…',
  backToDesk: (o: string) => `Voltar para a mesa (tira de ${o})`,
  revokeSelf: (o: string) => `Tirar ${o ? `de ${o}` : 'do agente'} (volta para a mesa)`,
  revokeDesk: (o: string) => `Tirar a mesa ${o ? `de ${o}` : 'do agente'}…`,
  returnToDesk: (o: string) => `Devolver à mesa (${o})`,
  keepPane: 'Ficar com a guia (tira a marca)',
  keepDesk: 'Ficar com a mesa (tira o selo)',
  closeOpened: (o: string, n: number) => `Fechar as guias que ${o} abriu (${n})…`,
  whatIsOf: (o: string) => `O que é de ${o}`,
  deskChild: (name: string) => `${name} (mesa)`,
  paneChild: (place: string, title: string) => `${place} › ${title} (guia)`,
} as const

// ---- lines of information (the heading at the top of the group) ----------------------------------------------------------
export const INFO = {
  deskLive: (o: string, commands: number, sees: number): string => {
    const parts: string[] = []
    if (commands > 0) parts.push(`comanda ${plural(commands, 'guia', 'guias')}`)
    if (sees > 0) parts.push(`vê ${sees}`)
    return `Dono: ${o} · ${parts.length > 0 ? parts.join(', ') : 'sem guias'}`
  },
  deskPaused: (o: string, at: string) => `Dono: ${o} · pausada nesta mesa${at ? ` desde ${at}` : ''}`,
  deskPausedAll: (o: string, at: string) => `Dono: ${o} · pausada em tudo${at ? ` desde ${at}` : ''}`,
  deskTaken: (o: string) => `Dono: ${o} · a mesa está com você`,
  deskEnded: (name: string, at: string) => `${name} encerrou${at ? ` às ${at}` : ''} · as guias voltaram para você`,
  paneByDesk: (o: string) => `Comandada por ${o}, pela mesa`,
  paneGiven: (o: string, viewer: string | undefined) => `Dada a ${o}${viewer ? ` · ${viewer} vê` : ''}`,
  paneSelf: (o: string) => `Dada a ${o}, que roda nela (comanda a si mesmo)`,
  paneWaits: (o: string, what: string, at: string) => `Espera ${o}: ${what}${at ? ` às ${at}` : ''}`,
  paneEnded: (name: string, asks: boolean) => `${name} encerrou · voltou para você${asks ? ' · pede permissão' : ''}`,
  answerInPane: '(responde-se na própria guia, como hoje)',
  paneTaken: (before: string) => `Com você · antes: ${before}`,
  panePaused: (o: string, at: string) => `Pausada${at ? ` às ${at}` : ''} · ${o} não age aqui até você retomar`,
  ownerOwns: (mesas: string[], guias: number, places: string[]): string => {
    const parts: string[] = []
    if (mesas.length > 0) parts.push(`${plural(mesas.length, 'mesa', 'mesas')} (${mesas.join(', ')})`)
    if (guias > 0) parts.push(`${plural(guias, 'guia', 'guias')}${places.length > 0 ? ` em ${places.join(', ')}` : ''}`)
    return `É dono de ${parts.join(' e de ')}`
  },
  ownerPausedAll: (at: string) => `Pausada em tudo${at ? ` desde ${at}` : ''}`,
} as const

/** What an agent's request was, in the line "Espera Atrium: pediu permissão às 14:05". */
export const waitingWhat = (kind: 'waiting' | 'done'): string => (kind === 'waiting' ? 'pediu permissão' : 'terminou')

// ---- the picker (step 1) ---------------------------------------------------------------------------------------------------
export const PICK = {
  titleDesk: (desk: string) => `Dar a mesa ${desk} a…`,
  titleDeskPass: (desk: string) => `Passar a mesa ${desk} a…`,
  titlePane: (pane: string) => `Dar a guia ${pane} a…`,
  placeholder: 'buscar agente',
  empty: 'Nenhum agente aberto. Abra uma guia de agente para dar a ela.',
  groupRecent: 'Recentes',
  groupHere: 'Nesta mesa',
  groupElsewhere: 'Outras mesas',
  /** A live agent with no tab (outside any desk, drawer or pad); it can still own desks and panes. */
  groupNoDesk: 'Sem mesa',
  noDesk: 'sem mesa',
  livesIn: (place: string) => `mora em ${place}`,
  owns: (mesas: number, guias: number): string => {
    const parts: string[] = []
    if (mesas > 0) parts.push(plural(mesas, 'mesa', 'mesas'))
    if (guias > 0) parts.push(plural(guias, 'guia', 'guias'))
    return `dono de ${parts.join(' e ')}`
  },
  itself: 'ela mesma: de si',
} as const

// ---- the dialogs (step 2 of giving, revoking) -------------------------------------------------------------------------------------
export interface GiveDeskText {
  desk: string
  to: string
  /** The owner the desk has now (passing it), else undefined. */
  from?: string | undefined
  /** How many panes `to` will command. */
  commands: number
  /** The panes of the desk already given to another agent: they stay, and `to` only sees them. */
  keptByOthers: { title: string; owner: string }[]
  /** Where `to` lives when it is not in this desk ("atrium"). */
  livesIn?: string | undefined
}

export function giveDeskDialog(t: GiveDeskText): DialogSpec {
  const passing = t.from !== undefined
  const lines: string[] = []
  if (!passing) {
    if (t.keptByOthers.length === 1) lines.push(`1 guia já é de ${t.keptByOthers[0]!.owner} (${t.keptByOthers[0]!.title}): continua de ${t.keptByOthers[0]!.owner}, e ${t.to} só vê.`)
    else if (t.keptByOthers.length > 1) lines.push(`${t.keptByOthers.length} guias já são de outros agentes (${t.keptByOthers.map(k => `${k.title}: ${k.owner}`).join('; ')}): continuam deles, e ${t.to} só vê.`)
    if (t.livesIn) lines.push(`${t.to} mora em outra mesa (${t.livesIn}); continua lá.`)
    lines.push(`Tudo começa ligado. Para limitar: “${L.inventoryDesk(t.to)}”.`)
  }
  return {
    situation: passing ? 'for-agents.pass-desk' : 'for-agents.give-desk',
    tone: 'info',
    icon: passing ? 'swap' : 'robot',
    title: passing ? `Passar a mesa ${t.desk} de ${t.from} para ${t.to}` : `Dar a mesa ${t.desk} a ${t.to}`,
    message: passing
      ? `${t.from} deixa de comandar esta mesa. O que ${t.from} tinha deixado diferente no inventário fica para ${t.to} como está.`
      : `${t.to} passa a comandar ${t.commands === 1 ? 'a guia' : `as ${t.commands} guias`} desta mesa como você comanda.`,
    ...(lines.length > 0 ? { context: { icon: 'robot', name: t.to, lines } } : {}),
    choices: [
      { id: 'back', icon: 'arrow-u-up-left', label: 'Voltar', consequence: 'Escolher outro agente.', tone: 'safe' },
      { id: 'give', icon: passing ? 'swap' : 'robot', label: passing ? 'Passar a mesa' : 'Dar a mesa', consequence: `${t.to} passa a comandar; você pode assumir o comando ou tirar a mesa quando quiser.`, tone: 'neutral' },
    ],
    defaultChoice: 'give',
    cancelLabel: 'Cancelar',
  }
}

export interface GivePaneText {
  pane: string
  to: string
  /** The pane is the agent's own ("de si"). */
  itself: boolean
  /** Who commands the pane now, and whether through the desk. */
  from?: { name: string; byDesk: boolean } | undefined
  /** The desk's owner, who only sees the pane once it goes to `to`. */
  viewer?: string | undefined
  /** A request waiting on the pane ("permissão, 14:05"), when known. */
  pending?: string | undefined
}

export function givePaneDialog(t: GivePaneText): DialogSpec {
  if (t.itself) {
    return {
      situation: 'for-agents.give-pane-self',
      tone: 'info',
      icon: 'robot',
      title: `Dar a guia ${t.pane} ao próprio ${t.to}`,
      message: `${t.to} passa a comandar a si mesmo nesta guia (por exemplo, compactar a própria sessão).`,
      choices: [
        { id: 'back', icon: 'arrow-u-up-left', label: 'Voltar', consequence: 'Escolher outro agente.', tone: 'safe' },
        { id: 'give', icon: 'robot', label: 'Dar a guia', consequence: `${t.to} passa a poder digitar nesta guia; o pedido dela continua indo para você.`, tone: 'neutral' },
      ],
      defaultChoice: 'give',
      cancelLabel: 'Cancelar',
    }
  }
  const message: string[] = []
  if (t.from) message.push(`Hoje ela é comandada por ${t.from.name}${t.from.byDesk ? ', pela mesa' : ''}.`)
  message.push(t.viewer && t.viewer !== t.to ? `Dada a ${t.to}, ${t.to} comanda e ${t.viewer} só vê.` : `${t.to} passa a comandar esta guia como você comanda.`)
  if (t.pending) message.push(`O pedido pendente (${t.pending}) passa a ir para ${t.to}.`)
  return {
    situation: 'for-agents.give-pane',
    tone: 'info',
    icon: 'robot',
    title: `Dar a guia ${t.pane} a ${t.to}`,
    message: message.join(' '),
    context: { icon: 'robot', name: t.to, lines: ['Tudo começa ligado, igual à mesa.'] },
    choices: [
      { id: 'back', icon: 'arrow-u-up-left', label: 'Voltar', consequence: 'Escolher outro agente.', tone: 'safe' },
      { id: 'give', icon: 'robot', label: 'Dar a guia', consequence: `${t.to} passa a comandar; você pode assumir o comando ou tirar a guia quando quiser.`, tone: 'neutral' },
    ],
    defaultChoice: 'give',
    cancelLabel: 'Cancelar',
  }
}

export interface RevokeDeskText {
  desk: string
  owner: string
  /** The panes the owner commands through the desk: they go back to the person. */
  commands: number
  /** The panes the desk's owner only sees (given to others): they stay. */
  keptByOthers: { owner: string }[]
  /** Requests waiting for the owner, when known. */
  waiting?: number | undefined
}

export function revokeDeskDialog(t: RevokeDeskText): DialogSpec {
  const message: string[] = [t.commands === 0
    ? `${t.owner} não comanda nenhuma guia desta mesa agora.`
    : `${t.commands === 1 ? 'A guia que' : `As ${t.commands} guias que`} ${t.owner} comanda ${t.commands === 1 ? 'volta' : 'voltam'} para você.`]
  if (t.waiting) message.push(`Pedidos que esperavam ${t.owner} (${t.waiting}) passam a esperar você.`)
  const others = t.keptByOthers.map(k => k.owner)
  if (others.length === 1) message.push(`A guia de ${others[0]} continua de ${others[0]}.`)
  else if (others.length > 1) message.push(`As ${others.length} guias de outros agentes continuam deles.`)
  return {
    situation: 'for-agents.revoke-desk',
    tone: 'danger',
    icon: 'link-break',
    title: `Tirar a mesa ${t.desk} de ${t.owner}`,
    message: message.join(' '),
    choices: [
      { id: 'revoke', icon: 'link-break', label: 'Tirar a mesa', consequence: `${t.owner} deixa de comandar esta mesa; você pode dá-la de novo quando quiser.`, tone: 'destructive' },
    ],
    cancelLabel: 'Cancelar',
  }
}

export interface CloseOpenedText {
  owner: string
  /** The guias the owner opened that are still on the desk. */
  guias: number
  desk: string
}

/** "Fechar as guias que <dono> abriu (N)…": the owner ended, the guias it opened stayed. Closing the panes never forgets the sessions. */
export function closeOpenedDialog(t: CloseOpenedText): DialogSpec {
  const n = t.guias
  const them = n === 1 ? 'a guia' : `as ${n} guias`
  return {
    situation: 'for-agents.close-opened',
    tone: 'danger',
    icon: 'broom',
    title: `Fechar ${them} que ${t.owner} abriu`,
    message: `${t.owner} encerrou. ${n === 1 ? 'A guia que ele abriu em' : `As ${n} guias que ele abriu em`} ${t.desk} ${n === 1 ? 'continua' : 'continuam'} aí, agora suas.`,
    choices: [
      { id: 'close', icon: 'x', label: n === 1 ? 'Fechar a guia' : `Fechar as ${n} guias`, consequence: 'Os agentes continuam rodando sem painel (em “Rodando sem painel”); dá para reabrir.', tone: 'neutral' },
      { id: 'stop', icon: 'stop', label: 'Parar e fechar', consequence: n === 1 ? 'O agente é encerrado antes de a guia fechar.' : 'Cada agente é encerrado antes de a guia dele fechar.', tone: 'destructive' },
    ],
    cancelLabel: 'Cancelar',
  }
}
