// The status icon's rules (F7 C4, design §5), pure and shared by main (which polls the daemon) and the renderer (which
// draws): what GET /status says, reduced to a snapshot with no secret and no raw header; the icon's state, badge and
// tooltip from that snapshot; how long ago something happened, in Portuguese. Main is the only side that reads api.key
// and talks HTTP; the renderer receives `StatusSnapshot` over the bus and nothing else.
/** The window in which a call makes the icon "busy" (§5: "agente usando agora (últimos 10 s)"). */
export const BUSY_WINDOW_MS = 10_000

// ---- the wire (what the bridge's GET /status returns; validated field by field, nothing else kept) -----------------

export interface WireTab { id?: unknown; windowId?: unknown; url?: unknown; title?: unknown; owner?: unknown }
export interface WireBrowser { id?: unknown; name?: unknown; userAgent?: unknown; connectedAt?: unknown; lastFocusedAt?: unknown; tabs?: unknown; active?: unknown; extensionVersion?: unknown; debug?: unknown; policy?: unknown }
export interface WireClient { id?: unknown; name?: unknown; lastTool?: unknown; lastSeenAt?: unknown; calls?: unknown; live?: unknown; browserId?: unknown }
export interface WireStatus { ok?: unknown; paused?: unknown; browsers?: unknown; clients?: unknown; activeBrowserId?: unknown; activeFallback?: unknown }

// ---- the snapshot (what crosses to the renderer) ----------------------------------------------------------------

export interface BrowserView {
  id: string
  /** "Chrome", "Edge", "Brave" or what the extension said. */
  name: string
  /** Tabs the bridge controls in this browser (a tab with an owner). */
  tabs: number
  /** Last focus or connection, epoch ms (undefined when the daemon gave none). */
  lastActivityAt?: number
  /** The active browser (`browsers[].active`: exactly one among the connected): the agents' calls without `browser` go here. */
  active?: boolean
  /** The manifest version the extension runs (absent on an extension older than the presence contract). */
  extensionVersion?: string
  /** The debug mode is on in this browser (its options page). */
  debug?: boolean
  /** Where an agent may run JS (`policy.evaluate`); absent when the daemon does not know (an older extension). */
  evaluate?: EvaluateMode
  /** `policy.source`: 'extension' = the browser stated it; 'config' = an older extension, the daemon only read config.json. */
  policySource?: 'extension' | 'config'
  /** A tab under control in this browser, to focus its window (`POST /browsers/:id/tabs/:tabId/focus`); none = no arrow. */
  focusTabId?: number
}

export type EvaluateMode = 'off' | 'own-tabs' | 'all'

export interface AgentView {
  /** The bridge client id (`tether:<slotId>` for a pane of this app). */
  clientId: string
  /** The pane behind the client, when it is one of ours. */
  slotId?: string
  /** "Claude · atrium" as the launch named it, or the id. */
  name: string
  /** Tabs this client owns across the browsers. */
  tabs: number
  lastTool?: string
  lastSeenAt?: number
  calls: number
  /** A live session (`clients[].live`: not released, acted in the last 15 min); the others are history. */
  live?: boolean
  /** The browser of the session's last tool call (absent before its first). */
  browserId?: string
  /** The agent's tab (its first owned tab in that browser, else anywhere): its arrow and its title. */
  tab?: { browserId: string; id: number; title?: string }
}

/** The active browser fell and another answers in its place until it comes back (`activeFallback`), with the names. */
export interface FallbackView { fromId: string; fromName: string; toId: string; toName: string; at?: number }

export type DaemonReach = 'up' | 'down' | 'no-key' | 'refused'

export interface StatusSnapshot {
  /** When main took it (epoch ms). */
  at: number
  daemon: DaemonReach
  /** The daemon answered at least once since the app started: a later silence is a fall, not a start-up. */
  everUp: boolean
  paused: boolean
  /** POST /pause answered 404 (a bundle older than A11): the button says so instead of failing again. */
  pauseSupported: boolean
  browsers: BrowserView[]
  agents: AgentView[]
  /** The extension's versions: vendored in the tether, the folder installed on this machine, and a pending reload (C5 marker). */
  version: { vendored?: string; installed?: string; pendingReload: boolean }
  /** Some browser of the daemon has the debug mode on (turned on in the extension's options page in the browser). */
  debug: boolean
  /** "Opções da extensão": the browser it opens in (hidden when none). */
  options?: { browserId: string; browserName: string }
  /** The chosen active browser (persisted at the daemon), connected or not. */
  activeBrowserId?: string
  /** Present while the chosen one is away and a substitute answers. */
  activeFallback?: FallbackView
}

export const EMPTY_SNAPSHOT: StatusSnapshot = Object.freeze({ at: 0, daemon: 'down', everUp: false, paused: false, pauseSupported: true, debug: false, browsers: [], agents: [], version: { pendingReload: false } }) as StatusSnapshot

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined)

/** agents.ts clientIdOf's prefix, repeated here because this module is bundled into the renderer (agents.ts needs node:fs); the unit test keeps them equal. */
export const TETHER_PREFIX = 'tether:'

/** The slot behind a `tether:<slotId>` client; undefined for any other client. */
export function slotIdOf(clientId: string): string | undefined {
  return clientId.startsWith(TETHER_PREFIX) && clientId.length > TETHER_PREFIX.length ? clientId.slice(TETHER_PREFIX.length) : undefined
}

/** "Chrome", "Edge", "Brave", "Chromium" from a user agent, or the name the browser gave. */
export function browserLabel(name: string | undefined, userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  if (/\bEdg\//.test(ua)) return 'Edge'
  if (/\bBrave\b/.test(ua) || /brave/i.test(name ?? '')) return 'Brave'
  if (name) return name
  if (/\bChrome\//.test(ua)) return 'Chrome'
  if (/\bChromium\//.test(ua)) return 'Chromium'
  return 'Navegador'
}

/** What `reduceStatus` returns: the part of the snapshot that comes from the body. */
export type ReducedStatus = Pick<StatusSnapshot, 'paused' | 'browsers' | 'agents' | 'debug' | 'activeBrowserId' | 'activeFallback'>

const EVALUATE: readonly EvaluateMode[] = ['off', 'own-tabs', 'all']
const tabIdOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)

/**
 * The sanitized part of a /status body. Anything malformed is dropped, never thrown on. `knownNames` (browser id -> label,
 * kept by the poller across polls) names the browser of `activeFallback.from`, which is no longer in `browsers`.
 */
export function reduceStatus(raw: unknown, knownNames?: ReadonlyMap<string, string>): ReducedStatus {
  const body = (raw && typeof raw === 'object' ? raw : {}) as WireStatus
  const owned = new Map<string, number>()
  /** Each owner's tabs across the browsers, in the order the browsers listed them. */
  const ownedTabs = new Map<string, { browserId: string; id: number; title?: string }[]>()
  const browsers: BrowserView[] = []
  for (const b of Array.isArray(body.browsers) ? (body.browsers as WireBrowser[]) : []) {
    const id = str(b?.id)
    if (!id) continue
    let tabs = 0
    let focusTabId: number | undefined
    for (const t of Array.isArray(b.tabs) ? (b.tabs as WireTab[]) : []) {
      const tid = tabIdOf(t?.id)
      if (tid !== undefined && focusTabId === undefined) focusTabId = tid
      const owner = str(t?.owner)
      if (!owner) continue
      tabs++
      owned.set(owner, (owned.get(owner) ?? 0) + 1)
      if (tid === undefined) continue
      const title = str(t.title)
      const list = ownedTabs.get(owner) ?? []
      list.push({ browserId: id, id: tid, ...(title ? { title } : {}) })
      ownedTabs.set(owner, list)
    }
    const last = num(b.lastFocusedAt) ?? num(b.connectedAt)
    const policy = (b.policy && typeof b.policy === 'object' ? b.policy : undefined) as { source?: unknown; evaluate?: unknown } | undefined
    const evaluate = EVALUATE.find(m => m === policy?.evaluate)
    const policySource = policy?.source === 'extension' || policy?.source === 'config' ? policy.source : undefined
    const extensionVersion = str(b.extensionVersion)
    browsers.push({
      id, name: browserLabel(str(b.name), str(b.userAgent)), tabs,
      ...(last === undefined ? {} : { lastActivityAt: last }),
      active: b.active === true,
      ...(extensionVersion ? { extensionVersion } : {}),
      debug: (b.debug as { on?: unknown } | undefined)?.on === true,
      ...(evaluate ? { evaluate } : {}),
      ...(policySource ? { policySource } : {}),
      ...(focusTabId === undefined ? {} : { focusTabId }),
    })
  }
  const agents: AgentView[] = []
  for (const c of Array.isArray(body.clients) ? (body.clients as WireClient[]) : []) {
    const id = str(c?.id)
    if (!id) continue
    const slotId = slotIdOf(id)
    const lastTool = str(c.lastTool)
    const lastSeenAt = num(c.lastSeenAt)
    const calls = num(c.calls)
    const browserId = str(c.browserId)
    const mine = ownedTabs.get(id) ?? []
    const tab = mine.find(t => t.browserId === browserId) ?? mine[0]
    agents.push({
      clientId: id, ...(slotId ? { slotId } : {}), name: str(c.name) ?? id, tabs: owned.get(id) ?? 0,
      ...(lastTool ? { lastTool } : {}), ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
      calls: calls === undefined ? 0 : Math.max(0, Math.floor(calls)),
      live: c.live === true, ...(browserId ? { browserId } : {}), ...(tab ? { tab } : {}),
    })
  }
  agents.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.name.localeCompare(b.name))
  const activeBrowserId = str(body.activeBrowserId)
  const fb = (body.activeFallback && typeof body.activeFallback === 'object' ? body.activeFallback : {}) as { from?: unknown; to?: unknown; at?: unknown }
  const from = str(fb.from)
  const to = str(fb.to)
  const nameOf = (bid: string): string => browsers.find(x => x.id === bid)?.name ?? knownNames?.get(bid) ?? 'O navegador escolhido'
  const at = num(fb.at)
  const activeFallback: FallbackView | undefined = from && to ? { fromId: from, fromName: nameOf(from), toId: to, toName: nameOf(to), ...(at === undefined ? {} : { at }) } : undefined
  return {
    paused: body.paused === true, debug: debugOf(raw).length > 0, browsers, agents,
    ...(activeBrowserId ? { activeBrowserId } : {}), ...(activeFallback ? { activeFallback } : {}),
  }
}

/** A call in flight at the daemon (GET /status `browsers[].pending`, bridge layer 0): never arguments. */
export interface PendingCall { callId: string; tool: string; ageMs: number; browser: string }

/** Every browser's `pending` of a /status body, oldest first; a daemon older than the trace has none (empty). */
export function pendingOf(body: unknown): PendingCall[] {
  const out: PendingCall[] = []
  const browsers = (body as { browsers?: unknown } | undefined)?.browsers
  for (const b of Array.isArray(browsers) ? browsers as Array<Record<string, unknown>> : []) {
    const name = str(b?.name) ?? str(b?.id) ?? '?'
    for (const p of Array.isArray(b?.pending) ? b.pending as Array<Record<string, unknown>> : []) {
      const callId = str(p?.callId)
      const ageMs = num(p?.ageMs)
      if (callId) out.push({ callId, tool: str(p.tool) ?? '?', ageMs: ageMs ?? 0, browser: name })
    }
  }
  return out.sort((a, b) => b.ageMs - a.ageMs)
}

/** A browser with the debug mode on (GET /status `browsers[].debug`): its name and the call deadline in force (null = none). */
export interface DebugBrowser { browser: string; callTimeoutMs: number | null }

/** The browsers of a /status body whose `debug.on` is true; a daemon older than the mode reports none (off). */
export function debugOf(body: unknown): DebugBrowser[] {
  const out: DebugBrowser[] = []
  const browsers = (body as { browsers?: unknown } | undefined)?.browsers
  for (const b of Array.isArray(browsers) ? browsers as Array<Record<string, unknown>> : []) {
    const d = b?.debug as { on?: unknown; callTimeoutMs?: unknown } | undefined
    if (d?.on !== true) continue
    out.push({ browser: str(b.name) ?? str(b.id) ?? '?', callTimeoutMs: num(d.callTimeoutMs) ?? null })
  }
  return out
}

// ---- what the icon shows -----------------------------------------------------------------------------------------

/** The agents that called in the last BUSY_WINDOW_MS, most recent first. */
export function activeAgents(s: StatusSnapshot, now: number): AgentView[] {
  return s.agents.filter(a => a.lastSeenAt !== undefined && now - a.lastSeenAt >= 0 && now - a.lastSeenAt < BUSY_WINDOW_MS)
}

export type IconState = 'idle' | 'normal' | 'busy' | 'warn' | 'error'

/**
 * §5: grey without a browser, normal with N browsers, busy while an agent calls, amber paused, red when the daemon fell.
 * The debug mode (`s.debug`, turned on in the extension's options page) is amber too while the daemon is up: it should not go unnoticed.
 */
export function stateOf(s: StatusSnapshot, now: number): IconState {
  if (s.daemon !== 'up') return s.everUp ? 'error' : 'idle'
  if (s.paused || s.debug) return 'warn'
  if (!s.browsers.length) return 'idle'
  if (activeAgents(s, now).length) return 'busy'
  return 'normal'
}

/** A dot while busy, the browser count otherwise (none without browsers or without the daemon). */
export function badgeOf(s: StatusSnapshot, now: number): number | 'dot' | undefined {
  const state = stateOf({ ...s, debug: false }, now)
  if (state === 'busy') return 'dot'
  if (state === 'error' || s.daemon !== 'up') return undefined
  return s.browsers.length || undefined
}

/** "Chrome, Edge" (distinct labels, in order). */
export function browserNames(s: StatusSnapshot): string[] {
  return [...new Set(s.browsers.map(b => b.name))]
}

/** The tooltip's suffix while the debug mode is on (the popover marks it per browser: "dev"). */
export const DEBUG_SUFFIX = 'modo de depuração ligado'

/** The tooltip (§5), in Portuguese. `product` is the Bridge's name ("Tether Bridge"); while the debug mode is on, it is named last. */
export function titleOf(s: StatusSnapshot, now: number, product: string): string {
  const t = baseTitleOf(s, now, product)
  return s.debug ? `${t} · ${DEBUG_SUFFIX}` : t
}

function baseTitleOf(s: StatusSnapshot, now: number, product: string): string {
  const state = stateOf({ ...s, debug: false }, now) // the mode is the tooltip's suffix, not a state of the base text
  if (state === 'error') return 'O daemon do bridge caiu; a próxima chamada o reinicia'
  if (s.daemon === 'no-key') return `${product}: instalação ainda não preparada (abra o Tether de novo)`
  if (s.daemon === 'refused') return `${product}: o daemon recusou a chave do Tether`
  if (s.daemon !== 'up') return `${product}: serviço ainda não respondeu`
  if (state === 'warn') return `${product} pausado`
  if (state === 'idle') return `${product}: nenhum navegador conectado · Instalar…`
  if (state === 'busy') {
    const a = activeAgents(s, now)[0]!
    const where = s.browsers.length === 1 ? s.browsers[0]!.name : 'navegador'
    return a.name === a.clientId ? `Um agente está usando o ${where}` : `${a.name} está usando o ${where}`
  }
  const names = browserNames(s)
  return names.length === 1 ? `${names[0]} conectado` : `${names.join(', ')} conectados`
}

/** "agora", "há 8 s", "há 3 min", "há 2 h", "há 3 d"; '' without a time. */
export function ago(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 3) return 'agora'
  if (s < 60) return `há ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `há ${h} h`
  return `há ${Math.round(h / 24)} d`
}

/** "1 aba", "3 abas", "nenhuma aba". */
export function tabsLabel(n: number): string {
  return n === 0 ? 'nenhuma aba' : n === 1 ? '1 aba' : `${n} abas`
}

/** The footer's version line and whether the person must reload the extension in the browser. */
export function versionLine(v: StatusSnapshot['version']): { text: string; reload: boolean } {
  const vendored = v.vendored ?? '?'
  if (!v.installed) return { text: `Extensão ${vendored} · não instalada neste computador`, reload: false }
  const differ = v.installed !== vendored
  const reload = v.pendingReload || differ
  return { text: differ ? `Extensão: ${vendored} no Tether · ${v.installed} instalada` : `Extensão ${vendored}`, reload }
}

// ---- the popover's two sections (presence) ------------------------------------------------------------------------

/** One mark of a browser's state line ("JS ✓", "dev ●", "v0.2.0") with its tooltip; `tone` colours it. */
export interface StateMark { key: 'js' | 'dev' | 'version'; text: string; title: string; tone?: 'warn' | 'off' }

/** A state the tether cannot leave as is: the line under the browser's name, with its action. */
export interface BrowserAlert { text: string; action: { id: 'extension-page'; label: string } }

/** The short line under a browser's name: where JS runs, the debug mode, the extension's version. */
export function stateMarks(b: BrowserView): StateMark[] {
  const out: StateMark[] = []
  if (b.evaluate === 'own-tabs') out.push({ key: 'js', text: 'JS ✓', title: 'O agente pode rodar JavaScript nas abas dele' })
  else if (b.evaluate === 'all') out.push({ key: 'js', text: 'JS em todas', title: 'O agente pode rodar JavaScript em qualquer aba', tone: 'warn' })
  else if (b.evaluate === 'off') out.push({ key: 'js', text: 'JS ✗', title: 'O agente não roda JavaScript neste navegador', tone: 'off' })
  if (b.debug) out.push({ key: 'dev', text: 'dev ●', title: 'Modo de depuração ligado na extensão: o registro guarda mais detalhes de cada chamada. Desligue nas opções da extensão quando terminar.', tone: 'warn' })
  if (b.extensionVersion) out.push({ key: 'version', text: `v${b.extensionVersion}`, title: `Extensão ${b.extensionVersion} neste navegador` })
  return out
}

/**
 * The alert of a browser, if any. An extension other than the one the tether carries (no version, a different version,
 * or a policy the daemon only read from config.json) runs without what the tether expects; the tether cannot reload it,
 * so the action opens the extension's page in that browser.
 */
export function browserAlert(b: BrowserView, vendored: string | undefined): BrowserAlert | undefined {
  const differs = !!b.extensionVersion && vendored !== undefined && b.extensionVersion !== vendored
  if (b.extensionVersion && b.policySource !== 'config' && !differs) return undefined
  const text = differs ? `Extensão ${b.extensionVersion}; o Tether traz a ${vendored}` : 'Extensão desatualizada neste navegador'
  return { text, action: { id: 'extension-page', label: 'Recarregar…' } }
}

/** The fallback notice: "<A> desconectou; usando <B>". */
export function fallbackLine(f: FallbackView): string {
  return `${f.fromName} desconectou; usando ${f.toName}`
}

/** A group of the Agentes section: a browser (its name as the label) and its live agents. */
export interface AgentGroup { browserId: string; label: string; agents: AgentView[] }

/**
 * The Agentes section: only the live sessions, grouped by the browser of their last call, in the order of the browser
 * list (an agent that has not called a tool yet goes with the active browser, where its first call lands). A browser
 * without a live agent has no group; agents whose browser is gone stay under "Navegador desconectado".
 */
export function agentGroups(s: Pick<StatusSnapshot, 'browsers' | 'agents'>): AgentGroup[] {
  const active = s.browsers.find(b => b.active)?.id
  const groups = new Map<string, AgentView[]>()
  for (const a of s.agents) {
    if (!a.live) continue
    const key = a.browserId ?? active ?? ''
    const list = groups.get(key) ?? []
    list.push(a)
    groups.set(key, list)
  }
  const out: AgentGroup[] = []
  for (const b of s.browsers) {
    const list = groups.get(b.id)
    if (list) { out.push({ browserId: b.id, label: b.name, agents: list }); groups.delete(b.id) }
  }
  for (const [browserId, list] of groups) out.push({ browserId, label: 'Navegador desconectado', agents: list })
  return out
}
