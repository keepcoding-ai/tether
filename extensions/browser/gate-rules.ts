// The pure rules of the CDP gatekeeper (Tether Browser E5, design §3.1, §3.2, §12b): who may talk to it (no browser engine:
// a request with Origin, Referer or Sec-Fetch-* is refused; only a loopback Host), how a key is read and compared (constant
// time, never logged), which page methods pass by exact name (the strict list of bench B4 plus the two of rule 21) and which
// addresses `Page.navigate` may open, and the table that maps the gate's session ids to the debugger's own (an agent never
// sees nor names an internal session).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

type Headers = Record<string, string | string[] | undefined>

/**
 * True when the request came from a browser engine (a web page): Origin, Referer, or a fetch-metadata header a browser sends
 * (Sec-Fetch-Site, -Dest, -User; browsers send Site with every request). `Sec-Fetch-Mode` alone is not a browser: Node's own
 * fetch (undici, what the MCP server uses) always adds `sec-fetch-mode: cors` and nothing else.
 */
export function fromBrowser(headers: Headers): boolean {
  if (headers.origin !== undefined || headers.referer !== undefined) return true
  return Object.keys(headers).some(h => {
    const n = h.toLowerCase()
    return n.startsWith('sec-fetch-') && n !== 'sec-fetch-mode'
  })
}

/** True when the Host header names the gate on loopback (a DNS-rebinding name is refused). */
export function loopbackHost(host: unknown, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

/** The shape of a key (192 bits in base64url or hex: 16 to 256 characters of A-Za-z0-9_-). */
export function validKeyShape(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(v)
}

/** The key carried by a request (`x-tether-key`), or undefined when absent, repeated or malformed. */
export function keyOf(headers: Headers): string | undefined {
  const k = headers['x-tether-key']
  return validKeyShape(k) ? k : undefined
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

/** Constant-time comparison: both sides are hashed first, so neither the length nor a prefix leaks through timing. */
export function keysEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

/**
 * The slot id whose key matches `key`, comparing against EVERY known key (no early exit), or undefined. `keys` maps slot id
 * to key text as read from `<home>/browser/keys/<slotId>.key`.
 */
export function ownerOfKey(key: string, keys: ReadonlyMap<string, string>): string | undefined {
  let found: string | undefined
  for (const [slotId, k] of keys) if (keysEqual(key, k) && found === undefined) found = slotId
  return found
}

/** A key file's text, trimmed, or undefined when it is not a key. */
export function parseKeyFile(text: string): string | undefined {
  const k = text.trim()
  return validKeyShape(k) ? k : undefined
}

/** The slot id of a key file name (`<slotId>.key`), or undefined. */
export function slotOfKeyFile(name: string): string | undefined {
  const m = /^([\w.:-]{1,80})\.key$/.exec(name)
  return m && !m[1]!.startsWith('.') ? m[1] : undefined
}

/**
 * Page level: the strict list by exact name (bench B4: 29 names; rule 21 adds `Page.setFontFamilies` and
 * `Page.removeScriptToEvaluateOnNewDocument`). Several are answered or rewritten by the gate rather than forwarded:
 * `Page.bringToFront` (no-op), `Page.reload` (the tab's reload), the two Emulation methods (the tether's: rule 3),
 * `Page.navigate` (scheme and local network), `Page.removeScriptToEvaluateOnNewDocument` (own scripts only).
 */
export const PAGE_ALLOWED: ReadonlySet<string> = new Set([
  'DOM.describeNode', 'DOM.getBoxModel', 'DOM.getFrameOwner', 'DOM.resolveNode',
  'Emulation.setDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Emulation.setFocusEmulationEnabled',
  'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent',
  'Log.enable', 'Network.enable',
  'Page.addScriptToEvaluateOnNewDocument', 'Page.bringToFront', 'Page.captureScreenshot', 'Page.createIsolatedWorld', 'Page.enable',
  'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.handleJavaScriptDialog', 'Page.navigate', 'Page.reload',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.setFontFamilies', 'Page.setLifecycleEventsEnabled',
  'Runtime.callFunctionOn', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.releaseObject', 'Runtime.runIfWaitingForDebugger',
  'Target.getTargetInfo', 'Target.setAutoAttach',
])

/** Browser level: the 11 the gate answers on its own (bench B1), plus `Target.setDiscoverTargets`. Nothing here is forwarded. */
export const BROWSER_ALLOWED: ReadonlySet<string> = new Set([
  'Browser.getVersion', 'Browser.setDownloadBehavior', 'Runtime.runIfWaitingForDebugger', 'Target.attachToBrowserTarget',
  'Target.attachToTarget', 'Target.closeTarget', 'Target.createTarget', 'Target.detachFromTarget', 'Target.getTargetInfo',
  'Target.getTargets', 'Target.setAutoAttach', 'Target.setDiscoverTargets',
])

/** What `Page.navigate` may open: http(s), the blank page, `about:srcdoc`, `data:` and `blob:` (design §3.1). */
export function navigable(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2 * 1024 * 1024) return false
  if (url === 'about:blank' || url === 'about:srcdoc') return true
  return /^(https?:\/\/|data:|blob:)/i.test(url)
}

/** A CDP error the gate answers. `refused` marks a policy refusal (vs. a failure of the page). */
export class GateError extends Error {
  readonly code: number
  readonly refused: boolean
  constructor(message: string, code = -32000, refused = false) {
    super(message)
    this.code = code
    this.refused = refused
  }
}

/**
 * A policy refusal. The text keeps Chromium's "wasn't found" for an unknown method, which the package reads as "this host does
 * not have it" (a `Tether.*` method unknown to this gate means no control channel).
 */
export function refusal(method: string, reason: string): GateError {
  return new GateError(`'${method}' wasn't found (refused by the gate: ${reason})`, -32601, true)
}

/** The same answer for a target that does not exist and for another agent's: nothing tells them apart. */
export function noTarget(): GateError {
  return new GateError('No target with given id found', -32602, true)
}

/** Mouse coordinates in page px become view px under the tether's scale (rule 4); the wheel delta stays in page px. */
export function scaleMouse(params: Record<string, unknown>, scale: number): Record<string, unknown> {
  if (scale === 1 || typeof params.x !== 'number' || typeof params.y !== 'number') return params
  return { ...params, x: params.x * scale, y: params.y * scale }
}

/** One page session handed to a connection: the tab, the debugger's own id, page or child (frame, worker). */
export interface GateSession<C> {
  outer: string
  conn: C
  tabId: string
  inner: string
  kind: 'page' | 'child'
}

/**
 * The gate's session ids ↔ the debugger's. Each connection only ever sees ids the gate made (random, unguessable), and a
 * command naming a session of another connection is answered as unknown.
 */
export class SessionTable<C> {
  private readonly byOuterId = new Map<string, GateSession<C>>()
  private readonly byInnerId = new Map<string, GateSession<C>>()
  private readonly newId: () => string

  constructor(newId: () => string = () => randomBytes(16).toString('hex').toUpperCase()) { this.newId = newId }

  private static key(tabId: string, inner: string): string { return `${tabId} ${inner}` }

  add(conn: C, tabId: string, inner: string, kind: 'page' | 'child'): GateSession<C> {
    let outer = this.newId()
    while (this.byOuterId.has(outer)) outer = this.newId()
    const s: GateSession<C> = { outer, conn, tabId, inner, kind }
    this.byOuterId.set(outer, s)
    this.byInnerId.set(SessionTable.key(tabId, inner), s)
    return s
  }

  /** The session `outer` if it belongs to `conn` (another connection's id is unknown to this one). */
  get(conn: C, outer: string): GateSession<C> | undefined {
    const s = this.byOuterId.get(outer)
    return s && s.conn === conn ? s : undefined
  }

  /** The session behind an event of the tab's debugger. */
  ofInner(tabId: string, inner: string): GateSession<C> | undefined {
    return this.byInnerId.get(SessionTable.key(tabId, inner))
  }

  remove(s: GateSession<C>): void {
    if (this.byOuterId.get(s.outer) === s) this.byOuterId.delete(s.outer)
    const k = SessionTable.key(s.tabId, s.inner)
    if (this.byInnerId.get(k) === s) this.byInnerId.delete(k)
  }

  of(conn: C, tabId?: string): GateSession<C>[] {
    return [...this.byOuterId.values()].filter(s => s.conn === conn && (tabId === undefined || s.tabId === tabId))
  }

  ofTab(tabId: string): GateSession<C>[] {
    return [...this.byOuterId.values()].filter(s => s.tabId === tabId)
  }
}

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization'])

function scrubHeaders(h: unknown): unknown {
  if (!h || typeof h !== 'object') return h
  let copy: Record<string, unknown> | undefined
  for (const k of Object.keys(h)) {
    if (!SECRET_HEADERS.has(k.toLowerCase())) continue
    copy ??= { ...(h as Record<string, unknown>) }
    delete copy[k]
  }
  return copy ?? h
}

/**
 * Rule 12: cookie and credential headers leave every network event (the ExtraInfo pair carries HttpOnly cookies raw, of every
 * account in the shared partition). Returns the params to send, a shallow copy when something was removed.
 */
export function scrubEvent(method: string, params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  const p = params as Record<string, unknown>
  if (method === 'Network.requestWillBeSentExtraInfo') {
    const out = { ...p, headers: scrubHeaders(p.headers) }
    if ('associatedCookies' in out) out.associatedCookies = []
    return out
  }
  if (method === 'Network.responseReceivedExtraInfo') {
    const out: Record<string, unknown> = { ...p, headers: scrubHeaders(p.headers) }
    delete out.headersText
    delete out.cookiePartitionKey
    if ('exemptedCookies' in out) out.exemptedCookies = []
    return out
  }
  if (method === 'Network.requestWillBeSent' && p.request && typeof p.request === 'object') {
    const r = p.request as Record<string, unknown>
    return { ...p, request: { ...r, headers: scrubHeaders(r.headers) } }
  }
  if (method === 'Network.responseReceived' && p.response && typeof p.response === 'object') {
    const r = p.response as Record<string, unknown>
    const out: Record<string, unknown> = { ...r, headers: scrubHeaders(r.headers) }
    if ('requestHeaders' in r) out.requestHeaders = scrubHeaders(r.requestHeaders)
    delete out.headersText
    delete out.requestHeadersText
    return { ...p, response: out }
  }
  return params
}
