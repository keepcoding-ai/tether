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

export const BACK = 'Voltar'
export const FORWARD = 'Avançar'
export const RELOAD = 'Recarregar'
export const READ_ONLY_ADDRESS = 'Endereço da página (só leitura)'
export const COOKIES_HERE = 'Esta partição guarda cookies deste site: pode haver uma conta logada'
export const COOKIES_HERE_SHORT = 'Com cookies'
export const BAR_LOGINS_NOT_KEPT = 'Logins não guardados'
export const ADDRESS_MAX = 90
export const SHORT_NAME_MAX = 16

/** The agent's name as the chip shows it: one line, the first words, never longer than SHORT_NAME_MAX. */
export function shortName(name: string | undefined): string {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return 'Agente'
  return clean.length <= SHORT_NAME_MAX ? clean : `${clean.slice(0, SHORT_NAME_MAX - 1).trimEnd()}…`
}

/** The owner chip: the short name, "‹Agente› encerrado" once it exited (the chip then dimmed), or a neutral word when no pane shows it. */
export function ownerChip(agent: { name: string; alive: boolean } | undefined): { text: string; ended: boolean; known: boolean } {
  if (!agent) return { text: 'Agente', ended: false, known: false }
  return agent.alive ? { text: shortName(agent.name), ended: false, known: true } : { text: `${shortName(agent.name)} encerrado`, ended: true, known: true }
}

/**
 * The hue (0-359) of an owner: the same slot id always gives the same one, in every run and on every machine (FNV-1a, 32 bits).
 * Only the hue is derived; saturation and lightness belong to the theme (the CSS), so the chip reads in both.
 */
export function ownerHue(slotId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < slotId.length; i++) { h ^= slotId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h % 360
}

/**
 * The address as the bar writes it: never longer than `max` characters; a `data:` address (which can be megabytes) shows only its
 * type and a mark that it was cut; a long one keeps its start and its end (where the page usually differs).
 */
export function displayUrl(url: string, max = ADDRESS_MAX): string {
  if (/^data:/i.test(url)) {
    if (url.length <= 60) return url
    const head = url.slice(0, Math.min(url.indexOf(',') >= 0 ? url.indexOf(',') : url.length, 40))
    return url.length <= head.length + 1 ? url : `${head},…`
  }
  if (url.length <= max) return url
  const end = Math.floor((max - 1) / 3)
  return `${url.slice(0, max - 1 - end)}…${url.slice(url.length - end)}`
}

/** The tab's letterbox: true when the fitted page leaves bands (smaller than its area). */
export function hasBands(host: { width: number; height: number }, effective: { width: number; height: number } | undefined): boolean {
  return !!effective && (effective.width < host.width - 1 || effective.height < host.height - 1)
}

export function ownerLabel(agent: { name: string; alive: boolean } | undefined, _slotId: string): string {
  return ownerChip(agent).text
}
