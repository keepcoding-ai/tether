// Every situation the app puts to the user, one declarative definition each (app/shared/dialog.ts).
// Each one is written from what it has to communicate: what is at stake, what each choice does to it.
// The copy is consequence-first and differs by what is actually there (an agent running, nothing
// running, a shell with no session to resume).
import { agentTable } from './agent-ui.ts'
import type { Profile, SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { DialogContext, DialogSpec } from '../shared/dialog.ts'
import { KIND_ICON } from './icons.ts'

/** "o Claude", "o soul", "o shell": the subject of every sentence about the panel. */
const SUBJECT: Record<SlotKind, string> = agentTable('o shell', ui => `o ${ui.label}`, n => `o ${n}`)
const SUBJECT_CAP: Record<SlotKind, string> = agentTable('O shell', ui => `O ${ui.label}`, n => `O ${n}`)

export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** The slot has a process (or is about to get one). */
export function isLive(s: SlotState): boolean {
  return s.status === 'running' || s.status === 'starting' || s.status === 'queued'
}

function panelContext(s: SlotState): DialogContext {
  const lines = [s.cwd]
  if (s.binding?.sessionId) lines.push(`sessão ${s.binding.sessionId.slice(0, 8)}`)
  if (s.profileName) lines.push(`perfil ${s.profileName}`)
  const status = s.restarting ? { label: 'reiniciando', tone: 'warn' as const }
    : s.status === 'running' ? { label: 'rodando agora', tone: 'ok' as const }
    : s.status === 'starting' ? { label: 'iniciando', tone: 'warn' as const }
    : s.status === 'queued' ? { label: 'na fila para iniciar', tone: 'warn' as const }
    : { label: 'nada rodando', tone: 'dim' as const }
  return { icon: KIND_ICON[s.kind] ?? 'terminal-window', name: s.title ?? s.name ?? folderName(s.cwd), lines, status }
}

/**
 * Closing a panel. What it communicates: "there is (or is not) a process behind this tab; the × can mean
 * hide the panel or end the process — which one?" With a live agent the risk is killing work by accident;
 * with nothing running the question is whether to keep the slot (resumable) or forget it.
 */
export function closePanelSituation(s: SlotState): DialogSpec {
  const kind = s.kind
  const shell = kind === 'shell'
  if (isLive(s)) {
    const keep = shell
      ? 'O shell continua aberto em segundo plano. Reabra o painel em Slots fechados.'
      : `${SUBJECT_CAP[kind]} continua rodando em segundo plano. Reabra o painel em Slots fechados.`
    const stop = shell
      ? 'O processo e o que roda nele são finalizados agora. Um shell não tem sessão: reabrir cria um shell novo na mesma pasta.'
      : 'O processo é finalizado agora. A conversa fica salva: reabrir o slot em Slots fechados a retoma.'
    return {
      situation: 'close-panel-live',
      tone: 'warn',
      icon: 'warning',
      title: s.status === 'running'
        ? (shell ? 'Este painel tem um shell aberto' : `Este painel tem ${SUBJECT[kind]} rodando`)
        : `${SUBJECT_CAP[kind]} está iniciando neste painel`,
      context: panelContext(s),
      choices: [
        { id: 'detach', icon: 'arrow-square-out', label: 'Só fechar o painel', consequence: keep, tone: 'safe' },
        { id: 'stop', icon: 'stop-circle', label: `Encerrar ${SUBJECT[kind]}`, consequence: stop, tone: 'destructive' },
      ],
      cancelLabel: 'Deixar aberto',
      remember: { choice: 'detach', label: 'Não perguntar de novo: só fechar o painel' },
    }
  }
  const keep = shell
    ? 'O slot fica em Slots fechados; reabrir abre um shell novo na mesma pasta.'
    : 'O slot fica guardado em Slots fechados; reabrir retoma a conversa.'
  const forget = shell
    ? 'O slot some do tether. Um shell não tem sessão: nada se perde.'
    : `O slot some do tether. A conversa continua no histórico d${SUBJECT[kind]} e pode ser retomada por lá.`
  return {
    situation: 'close-panel-idle',
    tone: 'info',
    icon: 'question',
    title: shell ? 'Nenhum shell aberto neste painel' : `${SUBJECT_CAP[kind]} não está rodando neste painel`,
    context: panelContext(s),
    choices: [
      { id: 'detach', icon: 'arrow-square-out', label: 'Fechar o painel', consequence: keep, tone: 'safe' },
      { id: 'forget', icon: 'trash', label: 'Esquecer o slot', consequence: forget, tone: 'destructive' },
    ],
    cancelLabel: 'Deixar aberto',
    remember: { choice: 'detach', label: 'Não perguntar de novo: fechar o painel e guardar o slot' },
  }
}

/**
 * "Sair e encerrar tudo…" from the menu. What it communicates: "this kills every agent and the daemon;
 * the thing you may actually want (keep them running) is just closing the window."
 */
export function quitAllSituation(slots: SlotState[]): DialogSpec {
  const live = slots.filter(isLive)
  const names = live.map(s => s.title ?? s.name ?? folderName(s.cwd))
  const shown = names.slice(0, 4)
  if (names.length > 4) shown.push(`e mais ${names.length - 4}`)
  const context: DialogContext = live.length === 0
    ? { icon: 'tray', name: 'Nenhum agente rodando', lines: ['Não há processo para encerrar; só o tetherd fecha.'], status: { label: 'tudo encerrado', tone: 'dim' } }
    : { icon: 'tray', name: live.length === 1 ? '1 agente rodando agora' : `${live.length} agentes rodando agora`, lines: shown, status: { label: 'rodando', tone: 'ok' } }
  return {
    situation: 'quit-all',
    tone: 'danger',
    icon: 'power',
    title: 'Sair e encerrar tudo?',
    context,
    choices: [
      { id: 'close-window', icon: 'app-window', label: 'Só fechar a janela', consequence: 'Os agentes continuam rodando no tetherd. Ao abrir o tether de novo, tudo volta no lugar.', tone: 'safe' },
      { id: 'quit', icon: 'power', label: 'Encerrar tudo e sair', consequence: 'Todos os agentes e o tetherd são finalizados agora. As conversas ficam salvas e são retomadas quando o tether abrir de novo.', tone: 'destructive' },
    ],
    cancelLabel: 'Cancelar',
  }
}

/**
 * "Reiniciar tudo" from the menu. What it communicates: "this is not a page reload: every agent in every panel
 * is ended now, the tetherd restarts, and only then each panel resumes its session."
 */
export function reloadAllSituation(slots: SlotState[]): DialogSpec {
  const live = slots.filter(isLive)
  const names = live.map(s => s.title ?? s.name ?? folderName(s.cwd))
  const shown = names.slice(0, 4)
  if (names.length > 4) shown.push(`e mais ${names.length - 4}`)
  const context: DialogContext = live.length === 0
    ? { icon: 'tray', name: 'Nenhum agente rodando nos painéis', lines: ['Só o tetherd reinicia; os painéis retomam as sessões em seguida.'], status: { label: 'tudo parado', tone: 'dim' } }
    : { icon: 'tray', name: live.length === 1 ? '1 agente rodando num painel' : `${live.length} agentes rodando nos painéis`, lines: shown, status: { label: 'rodando', tone: 'ok' } }
  return {
    situation: 'reload-all',
    tone: 'danger',
    icon: 'arrow-clockwise',
    title: 'Reiniciar tudo?',
    message: 'Isto reinicia o app e o tetherd: o tetherd é reiniciado e todos os agentes dos painéis são encerrados agora. Depois cada painel retoma a sessão de onde parou.',
    context,
    choices: [
      { id: 'reload', icon: 'arrow-clockwise', label: 'Encerrar os agentes e reiniciar tudo', consequence: 'Todos os agentes param, o tetherd sobe de novo e os painéis retomam as sessões. O que estava sendo feito agora é interrompido.', tone: 'destructive' },
    ],
    cancelLabel: 'Não reiniciar',
  }
}

/**
 * A launch while the previous instance is still releasing the single-instance lock (shown in its own small
 * window: there is no main window yet). What it communicates: "nothing is broken and nothing was lost;
 * wait a moment and try again, or leave it."
 */
export function stillClosingSituation(): DialogSpec {
  return {
    situation: 'still-closing',
    tone: 'info',
    icon: 'hourglass',
    title: 'O tether ainda está fechando',
    message: 'A janela anterior ainda está liberando a instância única. Os agentes não foram afetados: eles continuam no tetherd.',
    choices: [
      { id: 'retry', icon: 'arrow-clockwise', label: 'Tentar de novo', consequence: 'Tenta abrir a janela agora. Costuma funcionar depois de alguns segundos.', tone: 'safe' },
      { id: 'close', icon: 'x', label: 'Fechar', consequence: 'Não abre nada. Abra o tether de novo mais tarde.', tone: 'neutral' },
    ],
    escChoice: 'close',
  }
}

/**
 * Deleting a launch profile. What it communicates: "the panels that use it are not touched (they keep the
 * snapshot of its args); what goes is the choice for new panels." `users` = slots that reference it now.
 */
export function deleteProfileSituation(p: Profile, users: SlotState[]): DialogSpec {
  const lines = [KIND_LABEL_OF[p.agent]!]
  const args = p.agent === 'shell' && p.shell ? [...p.shell.args, ...p.args] : p.args
  if (args.length) lines.push(args.join(' '))
  const status = users.length === 0
    ? { label: 'nenhum painel usa', tone: 'dim' as const }
    : { label: users.length === 1 ? '1 painel usa' : `${users.length} painéis usam`, tone: 'warn' as const }
  const consequence = users.length === 0
    ? 'O perfil some da lista. Nenhum painel depende dele.'
    : `O perfil some da lista. ${users.length === 1 ? 'O painel que usa ele continua' : `Os ${users.length} painéis que usam ele continuam`} rodando com os últimos argumentos dele, inclusive ao retomar; só não dá mais para escolhê-lo em um painel novo.`
  return {
    situation: 'delete-profile',
    tone: 'danger',
    icon: 'trash',
    title: `Apagar o perfil "${p.name}"?`,
    context: { icon: KIND_ICON[p.agent] ?? 'terminal-window', name: p.name, lines, status },
    choices: [
      { id: 'keep', icon: 'arrow-square-out', label: 'Manter o perfil', consequence: 'Nada muda.', tone: 'neutral' },
      { id: 'delete', icon: 'trash', label: 'Apagar o perfil', consequence, tone: 'destructive' },
    ],
    escChoice: 'keep',
  }
}

const KIND_LABEL_OF: Record<SlotKind, string> = agentTable('Shell', ui => ui.label, n => n)

/** The option id that means "no profile" in the switch-profile dialog (daemon: `profileId: null`). */
export const NO_PROFILE = '__none__'

/** The profile's command line as the list shows it (shell profiles show the executable's args too). */
function profileArgsOf(p: Profile): string[] {
  return p.agent === 'shell' && p.shell ? [...p.shell.args, ...p.args] : p.args
}

/**
 * Switching the profile of an existing panel. What it communicates: "the panel keeps its slot and its
 * conversation; what changes is how the agent is launched — now (a restart that resumes the same session)
 * or at the next start." The list holds the profiles of THIS agent plus "no profile"; the current one is
 * tagged and choosing it does nothing.
 */
export function switchProfileSituation(s: SlotState, profiles: Profile[]): DialogSpec {
  const kind = s.kind
  const shell = kind === 'shell'
  const currentId = s.profileId ?? NO_PROFILE
  const items = profiles.filter(p => p.agent === kind).map(p => {
    const args = profileArgsOf(p)
    return {
      id: p.id, icon: KIND_ICON[kind] ?? 'terminal-window', label: p.name,
      detail: args.length ? args.join(' ') : (shell && !p.shell ? 'shell padrão' : 'sem argumentos'),
      ...(p.args.includes('--dangerously-skip-permissions') ? { mark: 'sem restrições' } : {}),
      ...(p.id === currentId ? { current: true } : {}),
    }
  })
  items.push({ id: NO_PROFILE, icon: 'minus-circle', label: 'Sem perfil', detail: shell ? 'o shell padrão, sem argumentos de perfil' : 'só os argumentos do próprio painel', ...(currentId === NO_PROFILE ? { current: true } : {}) })
  // The slot references a profile that no longer exists: it is not in the list, so nothing is "current" there.
  const live = s.status === 'running' || s.status === 'starting'
  const session = s.binding?.sessionId ? ` (sessão ${s.binding.sessionId.slice(0, 8)})` : ''
  const choices = live
    ? [
        {
          id: 'now', icon: 'arrow-clockwise', label: 'Trocar e reiniciar agora', tone: 'safe' as const,
          consequence: shell
            ? 'O shell fecha e um novo abre com o perfil {option} na mesma pasta. O que roda nele é finalizado.'
            : `${SUBJECT_CAP[kind]} reinicia agora com o perfil {option} e continua a mesma conversa${session}. Uma resposta em andamento é interrompida.`,
        },
        {
          id: 'next', icon: 'clock-counter-clockwise', label: 'Trocar na próxima abertura', tone: 'neutral' as const,
          consequence: shell
            ? 'Nada muda agora. O perfil {option} vale quando este painel abrir um shell de novo.'
            : `Nada muda agora. O perfil {option} vale quando ${SUBJECT[kind]} for iniciado de novo neste painel.`,
        },
      ]
    : [{ id: 'next', icon: 'check', label: 'Trocar o perfil', tone: 'safe' as const, consequence: `O perfil {option} vale no próximo início deste painel${shell ? '' : '; a conversa é a mesma'}.` }]
  return {
    situation: 'switch-profile',
    tone: 'info',
    icon: 'sliders-horizontal',
    title: 'Trocar o perfil deste painel',
    context: panelContext(s),
    options: { label: 'Perfil', items, selected: items.some(o => o.id === currentId) ? currentId : NO_PROFILE },
    choices,
    cancelLabel: 'Cancelar',
  }
}

/**
 * The daemon refused the restart (`unconfirmed`): the running agent never reported which session it has, so
 * a restart would have to guess. What it communicates: "nothing changed; the safe way is the next start."
 */
export function switchProfileUnconfirmedSituation(s: SlotState, profileName: string): DialogSpec {
  return {
    situation: 'switch-profile-unconfirmed',
    tone: 'warn',
    icon: 'warning',
    title: `Não dá para reiniciar ${SUBJECT[s.kind]} com a mesma conversa`,
    message: `${SUBJECT_CAP[s.kind]} deste painel não registrou qual sessão está rodando; reiniciar agora poderia perder a conversa. O perfil ainda não foi trocado.`,
    context: panelContext(s),
    choices: [
      { id: 'next', icon: 'clock-counter-clockwise', label: 'Trocar na próxima abertura', consequence: `Nada muda agora. O perfil ${profileName} vale quando ${SUBJECT[s.kind]} for iniciado de novo neste painel.`, tone: 'safe' },
      { id: 'keep', icon: 'x', label: 'Deixar como está', consequence: 'O painel continua com o perfil de antes.', tone: 'neutral' },
    ],
    escChoice: 'keep',
  }
}

/** The daemon refused the switch for another reason: say it, with the one way out (nothing to decide). */
export function switchProfileFailedSituation(s: SlotState, message: string): DialogSpec {
  return {
    situation: 'switch-profile-failed',
    tone: 'danger',
    icon: 'x-circle',
    title: 'O perfil não foi trocado',
    message,
    context: panelContext(s),
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'O painel continua como estava.', tone: 'neutral' }],
    escChoice: 'ok',
  }
}

/** A "Mover…" that could not be done: everything is back where it was (no pane is ever lost). */
export function moveFailedSituation(message: string): DialogSpec {
  return {
    situation: 'move-failed',
    tone: 'danger',
    icon: 'x-circle',
    title: 'Não foi possível mover',
    message: `${message} Tudo continua onde estava.`,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Os painéis seguem rodando, no mesmo lugar.', tone: 'neutral' }],
    escChoice: 'ok',
  }
}

/**
 * "Reiniciar o app" could not start the next instance, so this one stays. What it communicates: "nothing
 * closed, nothing was lost; here is why, and the app is still the one you were using."
 */
export function relaunchFailedSituation(message: string): DialogSpec {
  return {
    situation: 'relaunch-failed',
    tone: 'danger',
    icon: 'x-circle',
    title: 'Não foi possível reiniciar o app',
    message: `${message} O app continua aberto como estava; os agentes não foram afetados.`,
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada muda: esta janela e os painéis continuam como estão.', tone: 'neutral' }],
    escChoice: 'ok',
  }
}

export const STANDALONE_SITUATIONS: Record<string, () => DialogSpec> = { 'still-closing': stillClosingSituation }

/**
 * Closing a desk that still has panes. What it communicates: "these panes (and what runs in them) are on this
 * desk; the safe way is to take them to another desk; the other way stops what runs and closes the panes."
 * The slots are never forgotten: a closed pane stays under "Slots fechados".
 */
export function closeDeskSituation(deskName: string, slots: SlotState[], neighbourName: string): DialogSpec {
  const live = slots.filter(isLive)
  const names = slots.map(s => s.title ?? s.name ?? folderName(s.cwd))
  const shown = names.slice(0, 4)
  if (names.length > 4) shown.push(`e mais ${names.length - 4}`)
  const panes = slots.length === 1 ? '1 painel' : `${slots.length} painéis`
  const context: DialogContext = {
    icon: 'cards',
    name: `${deskName}: ${panes}`,
    lines: shown,
    status: live.length > 0
      ? { label: live.length === 1 ? '1 processo rodando' : `${live.length} processos rodando`, tone: 'ok' }
      : { label: 'nada rodando', tone: 'dim' },
  }
  const stop = live.length > 0
    ? { id: 'stop', icon: 'stop-circle', label: 'Encerrar e fechar a mesa', consequence: 'Os processos dos painéis são finalizados agora e a mesa fecha. As conversas ficam salvas: os slots ficam em Slots fechados e retomam ao reabrir.', tone: 'destructive' as const }
    : { id: 'stop', icon: 'x', label: 'Fechar os painéis e a mesa', consequence: 'Nada está rodando. Os painéis saem da tela e ficam em Slots fechados.', tone: 'neutral' as const }
  return {
    situation: 'close-desk',
    tone: live.length > 0 ? 'warn' : 'info',
    icon: live.length > 0 ? 'warning' : 'cards',
    title: live.length > 0 ? `A mesa "${deskName}" tem agentes rodando` : `Fechar a mesa "${deskName}"?`,
    context,
    choices: [
      { id: 'move', icon: 'arrow-square-out', label: `Mover os painéis para "${neighbourName}"`, consequence: 'Os painéis vão para a outra mesa, com tudo rodando como está, e esta mesa fecha.', tone: 'safe' },
      stop,
    ],
    cancelLabel: 'Cancelar',
  }
}

/** A tether:// link named a pane that is closed but still known (its slot is in "Slots fechados"). */
export function closedTabSituation(name: string): DialogSpec {
  return {
    situation: 'tether-link-closed',
    tone: 'info',
    icon: 'link',
    title: `A guia “${name}” está fechada`,
    message: 'O link aponta para uma guia que não está aberta em nenhum lugar do tether.',
    choices: [{ id: 'reopen', icon: 'arrow-counter-clockwise', label: 'Reabrir a guia', consequence: 'Ela volta para a mesa atual e retoma a sessão de onde parou.', tone: 'safe' }],
    cancelLabel: 'Agora não',
  }
}

/** A tether:// link named a pane the app no longer knows. */
export function missingTabSituation(): DialogSpec {
  return {
    situation: 'tether-link-missing',
    tone: 'warn',
    icon: 'link-break',
    title: 'Essa guia não existe mais',
    message: 'O link aponta para uma guia que foi esquecida ou que nunca existiu neste tether. Nada foi aberto.',
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Fecha este aviso.', tone: 'neutral' }],
  }
}
