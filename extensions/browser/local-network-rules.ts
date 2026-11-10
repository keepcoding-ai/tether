// The local-network question, as pure rules (Tether Browser E4, design §4.1, Temper A3): when an agent asks to open
// `localhost` or another address of the local network, the setting `extensions.browser.localNetwork` decides — `allow`
// grants without asking, `deny` refuses without asking, `ask` (the default) asks the person unless "Sempre para este perfil"
// was chosen before for that exact destination (host:port) and the agent's profile. Settings have no per-profile layer in
// this repo, so the "always" answers live in a file of the extension (<TETHER_HOME>/browser/local-network.json), one list of
// destinations per profile id ('' for an agent without a profile).
//
// Also here: which addresses the egress proxy must be told about when the filter lets a request through (`egressGrantUrl`).
import type { DialogSpec } from '../../app/shared/dialog.ts'

export type LocalNetworkSetting = 'ask' | 'allow' | 'deny'
export type LocalNetworkChoice = 'once' | 'always' | 'deny'
export type LocalNetworkVerdict = 'allow' | 'deny' | 'ask'

export const LOCAL_NETWORK_FILE = 'local-network.json'
export const LOCAL_NETWORK_SITUATION = 'browser.localNetwork'
/** Per profile: a person who said "always" more than this many times keeps the newest ones. */
export const GRANTS_PER_PROFILE_MAX = 200

/** The setting as stored; anything unknown is `ask` (the closed side that still lets the person decide). */
export function settingOf(raw: unknown): LocalNetworkSetting {
  return raw === 'allow' || raw === 'deny' ? raw : 'ask'
}

/** `host:port` of an http(s) address (host lowercased, IPv6 in brackets, the scheme's port when absent); null otherwise. */
export function destinationOf(url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.hostname === '') return null
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  return `${u.hostname.toLowerCase().replace(/\.$/, '')}:${port}`
}

/**
 * The key a local-network question is filed under when the agent has no tab to attach it to (its last tab closed, a `new_tab`
 * as the first move): the question belongs to the connection that asked, and goes away when the connection does. Tab ids
 * are UUIDs the tether mints (tabs.ts) or ones it saved itself, never starting with `conn:`, so the key never meets one.
 */
export const connectionQuestionKey = (slotId: string, connectionId: string): string => `conn:${slotId}:${connectionId}`

/**
 * The tab a `Tether.requestLocalNetwork` is about: the one the agent named, else its last page command's, else its newest.
 * Undefined when the agent has no tab at all (the question then goes under `connectionQuestionKey`, and is still asked).
 */
export function questionTabOf(mine: readonly { tabId: string }[], named: { tabId: string } | undefined, lastTab: string | undefined): string | undefined {
  return (named ?? mine.find(x => x.tabId === lastTab) ?? mine[mine.length - 1])?.tabId
}

/** The key of an agent's profile in the grants file. */
export const profileKeyOf = (profileId: string | undefined): string => profileId ?? ''

/** The "always" answers: per profile key, the destinations (host:port) its agents open without asking. */
export interface LocalNetworkGrants { profiles: Record<string, string[]> }

const DEST = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/

/** The file's content, validated: anything that is not a list of destinations is dropped. */
export function grantsOf(raw: unknown): LocalNetworkGrants {
  const out: LocalNetworkGrants = { profiles: {} }
  const profiles = (raw as { profiles?: unknown } | null)?.profiles
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return out
  for (const [key, list] of Object.entries(profiles)) {
    if (key.length > 200 || !Array.isArray(list)) continue
    const dests = [...new Set(list.filter((d): d is string => typeof d === 'string' && DEST.test(d)))].slice(-GRANTS_PER_PROFILE_MAX)
    if (dests.length) out.profiles[key] = dests
  }
  return out
}

export function hasGrant(grants: LocalNetworkGrants, profileKey: string, destination: string): boolean {
  return Object.hasOwn(grants.profiles, profileKey) && grants.profiles[profileKey]!.includes(destination)
}

/** The grants with `destination` added for the profile (newest last, the oldest dropped past the cap). */
export function withGrant(grants: LocalNetworkGrants, profileKey: string, destination: string): LocalNetworkGrants {
  const prev = Object.hasOwn(grants.profiles, profileKey) ? grants.profiles[profileKey]! : []
  const list = [...prev.filter(d => d !== destination), destination].slice(-GRANTS_PER_PROFILE_MAX)
  return { profiles: { ...grants.profiles, [profileKey]: list } }
}

/** Whether to grant, refuse or ask, before any person is involved. */
export function decideLocalNetwork(setting: LocalNetworkSetting, grants: LocalNetworkGrants, profileKey: string, destination: string): LocalNetworkVerdict {
  if (setting === 'allow') return 'allow'
  if (setting === 'deny') return 'deny'
  return hasGrant(grants, profileKey, destination) ? 'allow' : 'ask'
}

/** The person's answer as a choice; Esc, a closed dialog and anything unknown refuse. */
export function choiceOf(raw: unknown): LocalNetworkChoice {
  return raw === 'once' || raw === 'always' ? raw : 'deny'
}

/** What the renderer gets to ask: never the full address, only its destination. */
export interface LocalNetworkAsk {
  id: string
  agent: string
  /** The agent's profile name; undefined for an agent without a profile. */
  profile?: string
  destination: string
}

/** The question (design §4.1, tone of §12a): deny is the default and Esc; the two grants say how far they reach. */
export function localNetworkDialog(ask: LocalNetworkAsk): DialogSpec {
  const who = ask.profile === undefined ? 'os agentes sem perfil' : `os agentes do perfil ${ask.profile}`
  return {
    situation: LOCAL_NETWORK_SITUATION,
    tone: 'warn',
    icon: 'shield-warning',
    title: `Permitir que ${ask.agent} abra ${ask.destination}?`,
    message: 'É um endereço deste computador ou da sua rede. Uma página pode induzir o agente a pedir isso: permita só se você esperava que ele abrisse este endereço.',
    context: { icon: 'globe-simple', name: ask.destination, lines: [ask.profile === undefined ? `${ask.agent}, sem perfil` : `${ask.agent}, perfil ${ask.profile}`] },
    choices: [
      { id: 'once', icon: 'globe-simple', label: 'Só desta vez', consequence: `${ask.agent} abre ${ask.destination} agora; na próxima vez o tether pergunta de novo.`, tone: 'neutral' },
      { id: 'always', icon: 'globe-simple', label: 'Sempre para este perfil', consequence: `De agora em diante ${who} abrem ${ask.destination} sem perguntar.`, tone: 'neutral' },
      { id: 'deny', icon: 'shield-warning', label: 'Não permitir', consequence: `A página não abre e ${ask.agent} recebe a recusa.`, tone: 'safe' },
    ],
    defaultChoice: 'deny',
    escChoice: 'deny',
  }
}

// ---- the egress proxy's grants ----

/**
 * The address the egress proxy must get a grant for when the filter lets this request through, or null. The proxy refuses
 * every connection to a local IP without a grant; it grants nothing to a NAME other than `localhost` (a public name that
 * resolves to a local address stays refused whatever the filter said: DNS rebinding). So the filter grants exactly what it
 * judged and the proxy would refuse: an IP literal of a local range, or `localhost`. `isPrivateHost` is the proxy's own
 * textual test (Egress.isPrivateHost).
 */
export function egressGrantUrl(url: string, isPrivateHost: (host: string) => boolean): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
  return isPrivateHost(u.hostname) ? u.href : null
}

/**
 * The tabs' egress policy (egress-session.ts; the package's EgressPolicy). The package refuses a local IP literal outright
 * unless its range is listed, and then still demands a grant: here every local range a person may run something on is listed,
 * so the filter's grant (local origin, ticket, the person's answer) is what opens it. Names: only `localhost` (a NAME that
 * resolves to a local address is refused whatever the grant; a CIDR here never covers a name). Every port for public
 * destinations: the person's browser, not a hosted agent's (the package's 80/443/8080/8443 would break ordinary sites).
 */
export const TAB_EGRESS_POLICY = {
  allow: ['localhost', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'],
  ports: Array.from({ length: 65_535 }, (_, i) => i + 1),
}
