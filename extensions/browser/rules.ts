// The browser extension's texts (design §5.3 and §12a), pure so the unit test and the views share them.
import { agentHue } from '../../app/shared/agent-color.ts'

export const EMPTY_TITLE = 'Nenhuma guia aberta'
export const EMPTY_HELP = 'Quando um agente abrir uma guia, ela aparece aqui.'
export const OFF_ACTION = 'Abrir as configurações do navegador'
/** The panel menu's two entries (the empty state's profile button has its own, PROFILE_OPEN). */
export const SETTINGS_ENTRY = 'Configurações do navegador'
export const PROFILE_ACTION = 'Perfis'
export const PROFILE_OPEN = 'Abrir os perfis'

/** `extensions.browser.serveToAgents`: who gets the browser's tools. */
export type ServeMode = 'perProfile' | 'all' | 'off'
export const SERVE_MODES: readonly ServeMode[] = ['perProfile', 'all', 'off']
/** The profile option (`profile.extensions.browser.serve`) that marks a profile under `perProfile`. */
export const PROFILE_OPTION = 'serve'
export const PROFILE_OPTION_LABEL = 'Navegador para os agentes'
export const PROFILE_OPTION_HINT = 'Os agentes do Tether recebem as ferramentas do navegador e podem usar todas as contas logadas nas guias. Os logins são os mesmos para todos os perfis: ligar aqui não separa contas.'

/** A stored value as a mode: the old boolean `true` is `all`; `false`, absent or anything else is `perProfile`. */
export function serveModeOf(raw: unknown): ServeMode {
  if (raw === true) return 'all'
  return SERVE_MODES.includes(raw as ServeMode) ? (raw as ServeMode) : 'perProfile'
}

/** The rule: `all` serves every agent, `off` none, `perProfile` only the ones launched with a marked profile (no profile: no browser). */
export function servesAgent(mode: ServeMode, profileMarked: boolean): boolean {
  return mode === 'all' || (mode === 'perProfile' && profileMarked)
}

/** The pad's empty-state line for the current mode (Portuguese, for the person). */
export function offHelpFor(mode: ServeMode): string | undefined {
  if (mode === 'all') return undefined
  if (mode === 'off') return 'O navegador está desligado: nenhum agente recebe as ferramentas dele.'
  return 'Só os agentes lançados com um perfil marcado recebem o navegador.'
}
export const WEB_EMPTY = 'Esta guia ainda não tem página.'
export const NOT_LOADED = 'Não carregada desde que o Tether reabriu'
export const CRED_NOT_KEPT = 'Endereço não guardado: ele levava uma credencial'
export const LOADING = 'Carregando…'
/** The crash state of a tab (its pane shows one of these with REOPEN). */
export const CRASH_GONE = 'A página parou'
export const CRASH_HUNG = 'A página não responde'
export const CRASH_BROWSER = 'O navegador parou'
export const CRASH_PAUSED = 'Pausada: o navegador caiu duas vezes com esta guia aberta'
export const REOPEN = 'Reabrir'
/** E7c (H3): the tab's seal when its page tried to open too many windows. */
export const POPUPS_REFUSED = 'Esta página tentou abrir janelas demais; as que passaram do limite foram recusadas.'
export const LOGINS_NOT_KEPT = 'Logins não são guardados: as guias usam uma sessão em memória, que acaba quando o Tether fecha.'

/** The person's own tabs (owner PERSON_OWNER): the owner's name on the pill, the chips and the closed history. */
export const PERSON_NAME = 'Você'
export const PERSON_TITLE = 'Sua guia'
/** The fixed line on the bar of her tab: the tabs share one partition, so whatever account she signs in to, the agents can use. */
export const SHARED_LOGINS = 'Contas em que você entrar aqui ficam disponíveis aos agentes.'
/** The pad's section of her own tabs (first), and the gestures that open one. */
export const PAD_MINE = 'Suas guias'
export const NEW_TAB = 'Nova guia'
/** The address field while the person can type in it, and its hint. */
export const EDIT_ADDRESS = 'Endereço da página'
export const EDIT_ADDRESS_HINT = 'Digite um endereço e tecle Enter (Ctrl+L)'
export const BAD_ADDRESS = 'Endereço inválido: só http e https.'

export const BACK = 'Voltar'
export const FORWARD = 'Avançar'
export const RELOAD = 'Recarregar'
export const READ_ONLY_ADDRESS = 'Endereço da página (só leitura)'
/**
 * The facts of the tab behind the ⓘ of the address (a popover): cookies of the site, logins kept in memory only, the debug mode
 * (`extensions.browser.debug`, debug-file.ts) and an address that was not kept. The ⓘ carries a dot while any of them applies.
 */
export type TabFactId = 'cookies' | 'memory' | 'debug' | 'address'
export const TAB_INFO_BUTTON = 'Sobre esta guia'
export const TAB_INFO_TITLE = 'Sobre esta guia'
export const TAB_INFO_NONE = 'Nada a avisar sobre esta guia.'
export const TAB_FACTS: Record<TabFactId, { icon: string; title: string; text: string }> = {
  cookies: { icon: 'shield-warning', title: 'Há cookies deste site', text: 'Pode haver uma conta logada nesta guia.' },
  memory: { icon: 'clock', title: 'Logins em memória', text: 'Eles acabam quando o Tether fecha.' },
  debug: { icon: 'bug', title: 'Depuração ligada', text: 'O registro guarda mais detalhes. Desligue em Configurações › Browser › Depuração.' },
  address: { icon: 'link-break', title: 'Endereço não guardado', text: 'Ele levava uma credencial, por isso a guia não volta sozinha.' },
}
/** Whether the debug mode is on: the setting alone decides (the tab's ⓘ, the doctor's line, debug.json). */
export const debugOn = (s: { get(key: string): unknown }): boolean => s.get('debug') === true
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

/** The owner's hue is the agent's hue: one colour function for every host (app/shared/agent-color.ts). */
export const ownerHue = agentHue

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
