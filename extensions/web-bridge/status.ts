// The status icon's rules (F7 C4, design §5), pure and shared by main (which polls the daemon) and the renderer (which
// draws): what GET /status says, reduced to a snapshot with no secret and no raw header; the icon's state, badge and
// tooltip from that snapshot; how long ago something happened, in Portuguese. Main is the only side that reads api.key
// and talks HTTP; the renderer receives `StatusSnapshot` over the bus and nothing else.
/** The window in which a call makes the icon "busy" (§5: "agente usando agora (últimos 10 s)"). */
export const BUSY_WINDOW_MS = 10_000

// ---- the wire (what the bridge's GET /status returns; validated field by field, nothing else kept) -----------------

export interface WireTab { id?: unknown; url?: unknown; title?: unknown; owner?: unknown }
export interface WireBrowser { id?: unknown; name?: unknown; userAgent?: unknown; connectedAt?: unknown; lastFocusedAt?: unknown; tabs?: unknown }
export interface WireClient { id?: unknown; name?: unknown; lastTool?: unknown; lastSeenAt?: unknown; calls?: unknown }
export interface WireStatus { ok?: unknown; paused?: unknown; browsers?: unknown; clients?: unknown }

// ---- the snapshot (what crosses to the renderer) ----------------------------------------------------------------

export interface BrowserView {
  id: string
  /** "Chrome", "Edge", "Brave" or what the extension said. */
  name: string
  /** Tabs the bridge controls in this browser (a tab with an owner). */
  tabs: number
  /** Last focus or connection, epoch ms (undefined when the daemon gave none). */
  lastActivityAt?: number
}

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
}

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
  /** "Opções da extensão": the browser it opens in (hidden when none). */
  options?: { browserId: string; browserName: string }
}

export const EMPTY_SNAPSHOT: StatusSnapshot = Object.freeze({ at: 0, daemon: 'down', everUp: false, paused: false, pauseSupported: true, browsers: [], agents: [], version: { pendingReload: false } }) as StatusSnapshot

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

/** The sanitized part of a /status body (browsers, agents, paused). Anything malformed is dropped, never thrown on. */
export function reduceStatus(raw: unknown): Pick<StatusSnapshot, 'paused' | 'browsers' | 'agents'> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as WireStatus
  const owned = new Map<string, number>()
  const browsers: BrowserView[] = []
  for (const b of Array.isArray(body.browsers) ? (body.browsers as WireBrowser[]) : []) {
    const id = str(b?.id)
    if (!id) continue
    let tabs = 0
    for (const t of Array.isArray(b.tabs) ? (b.tabs as WireTab[]) : []) {
      const owner = str(t?.owner)
      if (!owner) continue
      tabs++
      owned.set(owner, (owned.get(owner) ?? 0) + 1)
    }
    const last = num(b.lastFocusedAt) ?? num(b.connectedAt)
    browsers.push({ id, name: browserLabel(str(b.name), str(b.userAgent)), tabs, ...(last === undefined ? {} : { lastActivityAt: last }) })
  }
  const agents: AgentView[] = []
  for (const c of Array.isArray(body.clients) ? (body.clients as WireClient[]) : []) {
    const id = str(c?.id)
    if (!id) continue
    const slotId = slotIdOf(id)
    const lastTool = str(c.lastTool)
    const lastSeenAt = num(c.lastSeenAt)
    const calls = num(c.calls)
    agents.push({ clientId: id, ...(slotId ? { slotId } : {}), name: str(c.name) ?? id, tabs: owned.get(id) ?? 0, ...(lastTool ? { lastTool } : {}), ...(lastSeenAt === undefined ? {} : { lastSeenAt }), calls: calls === undefined ? 0 : Math.max(0, Math.floor(calls)) })
  }
  agents.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.name.localeCompare(b.name))
  return { paused: body.paused === true, browsers, agents }
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

// ---- what the icon shows -----------------------------------------------------------------------------------------

/** The agents that called in the last BUSY_WINDOW_MS, most recent first. */
export function activeAgents(s: StatusSnapshot, now: number): AgentView[] {
  return s.agents.filter(a => a.lastSeenAt !== undefined && now - a.lastSeenAt >= 0 && now - a.lastSeenAt < BUSY_WINDOW_MS)
}

export type IconState = 'idle' | 'normal' | 'busy' | 'warn' | 'error'

/**
 * §5: grey without a browser, normal with N browsers, busy while an agent calls, amber paused, red when the daemon fell.
 * The debug mode (`debug`, extensions.web-bridge.debug) is amber too while the daemon is up: it should not go unnoticed.
 */
export function stateOf(s: StatusSnapshot, now: number, debug = false): IconState {
  if (s.daemon !== 'up') return s.everUp ? 'error' : 'idle'
  if (s.paused || debug) return 'warn'
  if (!s.browsers.length) return 'idle'
  if (activeAgents(s, now).length) return 'busy'
  return 'normal'
}

/** A dot while busy, the browser count otherwise (none without browsers or without the daemon). */
export function badgeOf(s: StatusSnapshot, now: number): number | 'dot' | undefined {
  const state = stateOf(s, now)
  if (state === 'busy') return 'dot'
  if (state === 'error' || s.daemon !== 'up') return undefined
  return s.browsers.length || undefined
}

/** "Chrome, Edge" (distinct labels, in order). */
export function browserNames(s: StatusSnapshot): string[] {
  return [...new Set(s.browsers.map(b => b.name))]
}

/** Whether the debug mode is on (extensions.web-bridge.debug): the setting alone decides (icon, popover, doctor, capabilities). */
export const bridgeDebugOn = (s: { get(key: string): unknown }): boolean => s.get('debug') === true

/** The popover's line and the tooltip's suffix while the debug mode is on. */
export const DEBUG_LINE = 'Modo de depuração ligado: o registro guarda mais detalhes de cada chamada. Desligue em Configurações quando terminar.'
export const DEBUG_SUFFIX = 'modo de depuração ligado'

/** The tooltip (§5), in Portuguese. `product` is the Bridge's name ("Tether Bridge"); with `debug`, the mode is named last. */
export function titleOf(s: StatusSnapshot, now: number, product: string, debug = false): string {
  const t = baseTitleOf(s, now, product)
  return debug ? `${t} · ${DEBUG_SUFFIX}` : t
}

function baseTitleOf(s: StatusSnapshot, now: number, product: string): string {
  const state = stateOf(s, now)
  if (state === 'error') return 'O daemon do bridge caiu; a próxima chamada o reinicia'
  if (s.daemon === 'no-key') return `${product}: instalação ainda não preparada (abra o tether de novo)`
  if (s.daemon === 'refused') return `${product}: o daemon recusou a chave do tether`
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
  return { text: differ ? `Extensão: ${vendored} no tether · ${v.installed} instalada` : `Extensão ${vendored}`, reload }
}
