// The browser extension's texts (design §5.3 and §12a), pure so the unit test and the views share them.
export const EMPTY_TITLE = 'Nenhuma guia aberta'
export const EMPTY_HELP = 'Nenhuma guia aberta. Quando um agente abrir uma, ela aparece aqui.'
export const OFF_HELP = 'O navegador está desligado neste perfil: os agentes não recebem as ferramentas dele.'
export const OFF_ACTION = 'Ligar em Configurações (browser.serveToAgents)'
export const WEB_EMPTY = 'Esta guia ainda não tem página.'
export const NOT_LOADED = 'Não carregada desde que o tether reabriu'
export const CRED_NOT_KEPT = 'Endereço não guardado: ele levava uma credencial'
export const LOADING = 'Carregando…'
export const LOGINS_NOT_KEPT = 'Logins não são guardados: as guias usam uma sessão em memória, que acaba quando o tether fecha.'

/** The owner chip: the agent's name, "‹Agente› encerrado" once it exited, or a neutral word when no pane shows it. */
export function ownerLabel(agent: { name: string; alive: boolean } | undefined, _slotId: string): string {
  if (!agent) return 'Agente'
  return agent.alive ? agent.name : `${agent.name} encerrado`
}
