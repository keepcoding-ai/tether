// Every situation the app puts to the user, one declarative definition each (app/shared/dialog.ts).
// Each one is written from what it has to communicate: what is at stake, what each choice does to it.
// The copy is consequence-first and differs by what is actually there (an agent running, nothing
// running, a shell with no session to resume).
import type { SlotKind, SlotState } from '../../src/daemon/protocol.ts'
import type { DialogContext, DialogSpec } from '../shared/dialog.ts'
import { KIND_ICON } from './icons.ts'

/** "o Claude", "o soul", "o shell": the subject of every sentence about the panel. */
const SUBJECT: Record<SlotKind, string> = { claude: 'o Claude', soul: 'o soul', shell: 'o shell' }
const SUBJECT_CAP: Record<SlotKind, string> = { claude: 'O Claude', soul: 'O soul', shell: 'O shell' }

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
  const status = s.status === 'running' ? { label: 'rodando agora', tone: 'ok' as const }
    : s.status === 'starting' ? { label: 'iniciando', tone: 'warn' as const }
    : s.status === 'queued' ? { label: 'na fila para iniciar', tone: 'warn' as const }
    : { label: 'nada rodando', tone: 'dim' as const }
  return { icon: KIND_ICON[s.kind], name: s.title ?? s.name ?? folderName(s.cwd), lines, status }
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
  }
}

export const STANDALONE_SITUATIONS: Record<string, () => DialogSpec> = { 'still-closing': stillClosingSituation }
