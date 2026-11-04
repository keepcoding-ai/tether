// Situations raised by the tray flow (app/main/main.ts asks, the renderer shows them). Same dialog component as
// app/renderer/situations.ts; kept in their own file so the tray work does not share hunks with it.
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { DialogContext, DialogSpec } from '../shared/dialog.ts'
import { slotLabel } from '../shared/tray.ts'

/** First time the window is closed to the tray: "nothing stopped; the app is in the tray". */
export function trayFirstCloseSituation(): DialogSpec {
  return {
    situation: 'tray-first-close',
    tone: 'info',
    icon: 'tray',
    title: 'O tether continua na bandeja',
    message: 'Os agentes seguem rodando. Clique no ícone da bandeja para abrir a janela de novo; o menu do ícone também sai do tether.',
    choices: [
      { id: 'ok', icon: 'check', label: 'Entendi', consequence: 'A janela se esconde e os agentes continuam rodando. Este aviso aparece só desta vez.', tone: 'safe' },
    ],
    escChoice: 'ok',
  }
}

/** "Reiniciar o tetherd" from the tray: it kills the agents' processes, so say so and what comes back. */
export function restartDaemonSituation(slots: SlotState[]): DialogSpec {
  const live = slots.filter(s => s.status === 'running' || s.status === 'starting' || s.status === 'queued')
  const shown = live.slice(0, 4).map(slotLabel)
  if (live.length > 4) shown.push(`e mais ${live.length - 4}`)
  const context: DialogContext = live.length === 0
    ? { icon: 'tray', name: 'Nenhum agente rodando', lines: ['Só o tetherd reinicia.'], status: { label: 'nada a interromper', tone: 'dim' } }
    : { icon: 'tray', name: live.length === 1 ? '1 agente rodando agora' : `${live.length} agentes rodando agora`, lines: shown, status: { label: 'rodando', tone: 'ok' } }
  return {
    situation: 'restart-daemon',
    tone: 'danger',
    icon: 'arrow-clockwise',
    title: 'Reiniciar o tetherd?',
    message: 'O tetherd é quem mantém os terminais e os agentes vivos. Reiniciá-lo interrompe o que está rodando.',
    context,
    choices: [
      { id: 'keep', icon: 'app-window', label: 'Manter como está', consequence: 'Nada é interrompido.', tone: 'safe' },
      { id: 'restart', icon: 'arrow-clockwise', label: 'Reiniciar o tetherd', consequence: 'Os agentes em execução são interrompidos agora. As conversas ficam salvas e os painéis são retomados assim que o serviço subir.', tone: 'destructive' },
    ],
    cancelLabel: 'Cancelar',
  }
}
