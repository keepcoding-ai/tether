// The pure rules of the CDP gatekeeper (Tether Browser E5-E6, design §3.1, §3.2, §12b): who may talk to it (no browser engine:
// a request with Origin, Referer or Sec-Fetch-* is refused; only a loopback Host), how a key is read and compared (constant
// time, never logged), which page methods pass by exact name (the strict list of bench B4, the two of rule 21, the touch and
// drag input of rule 4) and why the rest is refused (by name and by whole domain), which addresses `Page.navigate` may open,
// the remappings (input scale, a hidden tab's capture), the event filter (rule 12), and the table that maps the gate's session
// ids to the debugger's own (an agent never sees nor names an internal session).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { PERSON_OWNER } from './tab-rules.ts'

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
  // No key may stand for the person: a connection as PERSON_OWNER would be served her own tabs.
  return m && !m[1]!.startsWith('.') && m[1] !== PERSON_OWNER ? m[1] : undefined
}

/**
 * Page level: the strict list by exact name (bench B4: 28 names; rule 21 adds `Page.setFontFamilies` and
 * `Page.removeScriptToEvaluateOnNewDocument`; rule 4 adds the touch and drag input the gate scales). Several are answered or
 * rewritten by the gate rather than forwarded: `Page.bringToFront` (no-op), `Page.reload` (the tab's reload), the two Emulation
 * methods (the tether's: rule 3), `Page.navigate` (scheme and local network), `Page.removeScriptToEvaluateOnNewDocument` (own
 * scripts only), the input methods (scaled), `Page.captureScreenshot` (emulation re-applied; a hidden tab's capture rewritten).
 */
export const PAGE_ALLOWED: ReadonlySet<string> = new Set([
  'DOM.describeNode', 'DOM.getBoxModel', 'DOM.getFrameOwner', 'DOM.resolveNode',
  'Emulation.setDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Emulation.setFocusEmulationEnabled',
  'Input.dispatchDragEvent', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.dispatchTouchEvent',
  'Log.enable', 'Network.enable',
  'Page.addScriptToEvaluateOnNewDocument', 'Page.bringToFront', 'Page.captureScreenshot', 'Page.createIsolatedWorld', 'Page.enable',
  'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.handleJavaScriptDialog', 'Page.navigate', 'Page.reload',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.setFontFamilies', 'Page.setLifecycleEventsEnabled',
  'Runtime.callFunctionOn', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.releaseObject', 'Runtime.runIfWaitingForDebugger',
  'Target.getTargetInfo', 'Target.setAutoAttach',
])

/**
 * Browser level: the 11 the gate answers on its own (bench B1), plus `Target.setDiscoverTargets` and (E13) `Browser.cancelDownload`
 * (answered without effect: the tether keeps the agent's download). Nothing here is forwarded.
 */
export const BROWSER_ALLOWED: ReadonlySet<string> = new Set([
  'Browser.cancelDownload', 'Browser.getVersion', 'Browser.setDownloadBehavior', 'Runtime.runIfWaitingForDebugger', 'Target.attachToBrowserTarget',
  'Target.attachToTarget', 'Target.closeTarget', 'Target.createTarget', 'Target.detachFromTarget', 'Target.getTargetInfo',
  'Target.getTargets', 'Target.setAutoAttach', 'Target.setDiscoverTargets',
])

const COOKIES = 'cookies of every account'
const BODY = 'a body the page itself may not read'
const TETHERS = "the tether's"

/** Methods refused by name, with the reason the Temper asked for (C1): the account is used, never exported. */
const NAMED_REFUSALS: Record<string, string> = {
  'Network.getCookies': COOKIES, 'Network.getAllCookies': COOKIES, 'Network.setCookie': COOKIES, 'Network.setCookies': COOKIES,
  'Network.deleteCookies': COOKIES, 'Network.clearBrowserCookies': COOKIES, 'Page.getCookies': COOKIES,
  'Network.setExtraHTTPHeaders': 'headers of every request', 'Network.setUserAgentOverride': `the page identity is ${TETHERS}`,
  'Network.getResponseBody': `${BODY} (a cross-origin response)`, 'Network.getRequestPostData': BODY,
  'Network.loadNetworkResource': 'a load outside the page', 'Network.takeResponseBodyForInterceptionAsStream': BODY,
  'Page.getResourceContent': BODY, 'DOM.setFileInputFiles': 'files from disk', 'Page.setDownloadBehavior': `downloads are ${TETHERS}`,
  'Page.printToPDF': 'not in Electron', 'Page.close': 'closing goes through Target.closeTarget', 'Page.crash': 'crashing the page',
  'Emulation.clearDeviceMetricsOverride': `the page size is ${TETHERS}`, 'Emulation.setVisibleSize': `the page size is ${TETHERS}`,
  'Browser.getBrowserCommandLine': "the machine's command line", 'Page.setInterceptFileChooserDialog': `the file chooser is ${TETHERS}`,
}

/** Whole domains refused, by name. */
const DOMAIN_REFUSALS: Record<string, string> = {
  Storage: `storage and ${COOKIES}`, Fetch: 'intercepts every request', IO: 'reads files and streams',
  Tracing: 'records memory and headers', HeapProfiler: 'reads memory', Memory: 'reads memory', SystemInfo: 'the machine',
  Audits: 'reports cookies and headers', Browser: `the browser is ${TETHERS}`, Target: "targets are the gate's",
  Cast: 'devices', DeviceAccess: 'devices', WebAuthn: 'credentials', Security: `certificates are ${TETHERS}`,
  ServiceWorker: "other tabs' workers", CacheStorage: `storage of every account`, IndexedDB: 'storage of every account',
  DOMStorage: 'storage of every account', BackgroundService: 'storage of every account', FedCm: 'accounts', Autofill: 'saved data',
  Extensions: `the browser is ${TETHERS}`, PWA: `the browser is ${TETHERS}`,
}

/** Why `method` is refused (the strict list refuses everything it does not name; some names carry a reason of their own). */
export function refusalReason(method: string): string {
  const named = NAMED_REFUSALS[method]
  if (named) return named
  const domain = method.split('.')[0] ?? ''
  const d = Object.hasOwn(DOMAIN_REFUSALS, domain) ? DOMAIN_REFUSALS[domain] : undefined
  return d ? `the ${domain} domain: ${d}` : 'not on the list'
}

/** What `Page.navigate` and `Target.createTarget` may open: http(s) and the blank page (the tab refuses every other scheme). */
export function navigable(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192) return false
  if (url === 'about:blank') return true
  return /^https?:\/\//i.test(url)
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

/**
 * The children a page session may have, announced to its agent: out-of-process frames and dedicated workers. A service or
 * shared worker serves every tab of its origin (another agent's too) and is never attached at all.
 *
 * Why at the source: on Electron 45, `Target.detachFromTarget` sent through `webContents.debugger` to an auto-attached
 * service worker's session crashes the main process (access violation, 0xC0000005: the whole app goes, from any page that
 * calls `navigator.serviceWorker.register`). So the gate never lets one be attached: every `Target.setAutoAttach` it forwards
 * carries this filter (whatever filter the client sent), and Chromium skips the other targets before attaching them.
 */
export const CHILD_TARGETS: readonly string[] = ['iframe', 'worker']

/** `Target.setAutoAttach` as forwarded: the client's flags, the gate's filter (only `CHILD_TARGETS`; the rest is excluded). */
export function autoAttachParams(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, filter: CHILD_TARGETS.map(type => ({ type, exclude: false })) }
}

/**
 * What the gate does with a child the debugger attached: `announce` it to the agent (a frame or dedicated worker while the agent
 * has the tab), `detach` it (a frame or worker of a held tab, an unknown kind), or `release` it: a worker of the origin (service,
 * shared) is never detached (the crash above) but resumed if it waits for a debugger and left unannounced; its session ends with
 * the page's. With the filter in force this last case does not happen; it is the guard if Chromium ever ignores the filter.
 */
export function childDisposal(type: unknown, agentHasTab: boolean): 'announce' | 'detach' | 'release' {
  if (type === 'service_worker' || type === 'shared_worker' || type === 'worklet' || type === 'shared_storage_worklet' || type === 'auction_worklet') return 'release'
  if (typeof type === 'string' && CHILD_TARGETS.includes(type)) return agentHasTab ? 'announce' : 'detach'
  return 'detach'
}

/**
 * The scale CDP input must be multiplied by (rule 4): the scale the page is drawn at, i.e. the fit while shown or parked and 1
 * while hidden (app/main/surfaces.ts, `drawScale`).
 */
export function inputScale(state: { visibility: string; scale: number }): number {
  return state.visibility === 'hidden' ? 1 : state.scale
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Input coordinates in page px become view px under the tether's scale (rule 4): the mouse (x, y; the wheel delta stays in page
 * px, bench B1 `scale-wheel`), each touch point (x, y and its radii), the drag (x, y).
 */
export function scaleInput(method: string, params: Record<string, unknown>, scale: number): Record<string, unknown> {
  if (scale === 1) return params
  if (method === 'Input.dispatchTouchEvent') {
    if (!Array.isArray(params.touchPoints)) return params
    return {
      ...params,
      touchPoints: params.touchPoints.map((p: unknown) => {
        if (!p || typeof p !== 'object') return p
        const t = { ...(p as Record<string, unknown>) }
        for (const k of ['x', 'y', 'radiusX', 'radiusY']) if (num(t[k])) t[k] = (t[k] as number) * scale
        return t
      }),
    }
  }
  if (!num(params.x) || !num(params.y)) return params
  return { ...params, x: params.x * scale, y: params.y * scale }
}

/** The mouse case of `scaleInput`. */
export function scaleMouse(params: Record<string, unknown>, scale: number): Record<string, unknown> {
  return scaleInput('Input.dispatchMouseEvent', params, scale)
}

/** A drag that carries files from disk (`data.files`) is a disk read: refused like `DOM.setFileInputFiles`. */
export function dragCarriesFiles(params: Record<string, unknown>): boolean {
  const d = params.data as { files?: unknown } | undefined
  return !!d && typeof d === 'object' && Array.isArray(d.files) && d.files.length > 0
}

/** A page capture's region: the clip asked (CSS px of the document) or the viewport at the scroll offset. */
export interface Clip { x: number; y: number; width: number; height: number; scale: number }

/**
 * A hidden tab's capture (E6 probe): under a hidden window or the 1×1 view only a capture of at least the viewport's size comes
 * back (a smaller clip, or none, waits for a frame that is never drawn). The capture asked becomes one of at least the
 * viewport's size starting at the same point, beyond the viewport, and the answer is cropped back to what was asked.
 */
export function hiddenCapture(params: Record<string, unknown>, viewport: { x: number; y: number; width: number; height: number }): { request: Record<string, unknown>; want: Clip; got: Clip } {
  const c = params.clip as Partial<Clip> | undefined
  const want: Clip = c && num(c.x) && num(c.y) && num(c.width) && num(c.height)
    ? { x: c.x, y: c.y, width: c.width, height: c.height, scale: num(c.scale) && c.scale > 0 ? c.scale : 1 }
    : { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height, scale: 1 }
  const got: Clip = { x: want.x, y: want.y, width: Math.max(want.width, viewport.width), height: Math.max(want.height, viewport.height), scale: 1 }
  const request: Record<string, unknown> = { format: 'png', clip: got, captureBeyondViewport: true }
  return { request, want, got }
}

// ---- the gate's ceilings against exhausting the main process (M2, M3) ----

/** M2: bytes a connection may have waiting in its socket (a client that stopped reading) before the gate closes it. */
export const WRITE_CEILING = 32 * 1024 * 1024
/** M3: a capture's clip, after its scale: the scale, each side and the area. */
export const CAPTURE_MAX_SCALE = 4
export const CAPTURE_MAX_SIDE = 16384
export const CAPTURE_MAX_AREA = 64 * 1024 * 1024

/**
 * M3: why a capture is refused before anything is drawn or decoded (a hidden tab's capture is decoded and resized in the main
 * process), or undefined. The clip comes from the client unbounded; the package's own ceiling is the client's.
 */
export function captureTooLarge(params: Record<string, unknown>): string | undefined {
  const c = params.clip as Partial<Clip> | undefined
  if (c === undefined || c === null) return undefined
  if (typeof c !== 'object') return 'the clip must be an object'
  const scale = c.scale === undefined ? 1 : c.scale
  if (!num(scale) || scale <= 0 || scale > CAPTURE_MAX_SCALE) return `the clip's scale must be above 0 and at most ${CAPTURE_MAX_SCALE}`
  if (!num(c.width) || !num(c.height) || c.width <= 0 || c.height <= 0) return 'the clip needs a positive width and height'
  const w = c.width * scale
  const h = c.height * scale
  if (w > CAPTURE_MAX_SIDE || h > CAPTURE_MAX_SIDE) return `the capture would be ${Math.round(w)}x${Math.round(h)} px (each side at most ${CAPTURE_MAX_SIDE})`
  if (w * h > CAPTURE_MAX_AREA) return `the capture would be ${Math.round((w * h) / 1e6)} Mpx (at most ${Math.round(CAPTURE_MAX_AREA / 1e6)})`
  return undefined
}

/** The device-pixel rectangle of `want` inside an image of `got` that is `imageWidth` px wide, and the output size. */
export function cropRect(want: Clip, got: Clip, imageWidth: number): { x: number; y: number; width: number; height: number; outWidth: number; outHeight: number } {
  const ratio = imageWidth / got.width
  const width = Math.max(1, Math.round(want.width * ratio))
  const height = Math.max(1, Math.round(want.height * ratio))
  return {
    x: Math.round((want.x - got.x) * ratio), y: Math.round((want.y - got.y) * ratio), width, height,
    outWidth: Math.max(1, Math.round(width * want.scale)), outHeight: Math.max(1, Math.round(height * want.scale)),
  }
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

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'set-cookie2', 'authorization', 'proxy-authorization'])
/** Keys that hold headers (an object of name → value, or Fetch's array of { name, value }). */
const HEADER_KEYS = new Set(['headers', 'requestheaders', 'responseheaders'])
/** Raw header text (every header, cookies included). */
const RAW_KEYS = new Set(['headerstext', 'requestheaderstext', 'responseheaderstext'])
/** The cookie arrays of the ExtraInfo events and of the cookie issues. */
const COOKIE_KEYS = new Set(['associatedcookies', 'exemptedcookies', 'blockedcookies', 'cookies', 'cookie', 'rawcookieline', 'cookiepartitionkey'])

function scrubHeaders(h: unknown): unknown {
  if (Array.isArray(h)) {
    return h.filter(e => !(e && typeof e === 'object' && SECRET_HEADERS.has(String((e as { name?: unknown }).name ?? '').toLowerCase())))
  }
  if (!h || typeof h !== 'object') return h
  let copy: Record<string, unknown> | undefined
  for (const k of Object.keys(h)) {
    if (!SECRET_HEADERS.has(k.toLowerCase())) continue
    copy ??= { ...(h as Record<string, unknown>) }
    delete copy[k]
  }
  return copy ?? h
}

/** Walks an event's params: header sets lose the secret headers; raw header text and cookie arrays go. Copies only what changes. */
function scrubDeep(v: unknown, depth: number): unknown {
  if (!v || typeof v !== 'object' || depth > 16) return v
  if (Array.isArray(v)) {
    let out: unknown[] | undefined
    v.forEach((x, i) => {
      const y = scrubDeep(x, depth + 1)
      if (y !== x) { out ??= [...v]; out[i] = y }
    })
    return out ?? v
  }
  const o = v as Record<string, unknown>
  let out: Record<string, unknown> | undefined
  for (const k of Object.keys(o)) {
    const lk = k.toLowerCase()
    const x = o[k]
    if (RAW_KEYS.has(lk) || COOKIE_KEYS.has(lk)) {
      out ??= { ...o }
      if (Array.isArray(x)) out[k] = []
      else delete out[k]
      continue
    }
    const y = HEADER_KEYS.has(lk) ? scrubDeep(scrubHeaders(x), depth + 1) : scrubDeep(x, depth + 1)
    if (y !== x) { out ??= { ...o }; out[k] = y }
  }
  return out ?? v
}

/** Events not walked: the page's own console and DOM (what the page's JavaScript already sees). */
const UNSCRUBBED_DOMAINS = new Set(['Runtime', 'Log', 'DOM', 'Input', 'Emulation'])

/**
 * Rule 12: cookie and credential headers leave EVERY network event (the ExtraInfo pair carries HttpOnly cookies raw, of every
 * account in the shared partition; a redirect's `redirectResponse`, the WebSocket handshake, early hints and signed exchanges
 * carry headers too). `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization`, the raw header text and the cookie arrays
 * (`associatedCookies`, `exemptedCookies`, `blockedCookies`, ...) are removed wherever they sit, in every event outside the
 * page's own console and DOM. Returns the params to send, a copy when something was removed.
 */
export function scrubEvent(method: string, params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  return UNSCRUBBED_DOMAINS.has(method.slice(0, method.indexOf('.'))) ? params : scrubDeep(params, 0)
}
