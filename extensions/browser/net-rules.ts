// The tabs' network filter, as pure rules (Tether Browser E3, design §4.1 item 1; probe S4, mechanism M1): which hosts are on
// the local network, which schemes a request may use, and whether one request (or one redirect hop) passes.
//
// The rule: a destination on the local network (loopback, private and link-local ranges — cloud metadata 169.254.169.254
// included —, carrier-grade NAT, `0.0.0.0`, local IPv6, `localhost`, `.local` and the other local suffixes, single-label
// names) passes only when the ORIGIN of the request is local too, or when it is a main-frame navigation the browser itself
// started (no initiator, GET) carrying a ticket: an exact address, for one tab, one use, a few seconds. A redirect hop keeps
// the chain's grant only as a same-origin local → local continuation (login → dashboard); a hop from a ticket to ANOTHER local
// destination, or from a public page to a local one, is refused. Schemes: a main frame is http(s) only; any other request is
// http(s), ws(s), data: or blob: (file:, chrome:, devtools: and the rest are refused).
//
// What this filter cannot see (the egress proxy of E4 closes it): it judges the NAME, so a public name that resolves to a
// local address (DNS rebinding, nip.io) passes here; and it sees only http(s)/ws(s), never UDP.
//
// The IP rules are copied from the package's egress policy (packages/browser/src/egress.ts: parseV4/parseV6/FORBIDDEN/
// V6_EMBEDDED_BLOCKED/ISATAP/NAT64), unchanged except that IPv4 is parsed the WHATWG way (decimal, octal and hex parts, one to
// four of them: `2130706433`, `0x7f.1`, `017700000001` are 127.0.0.1), since a host string may reach these rules unparsed.
// The origin rule is the package's origin gate (packages/browser/src/origin-gate.ts) translated from Playwright's frame chain
// to Electron's `initiatorOrigin`, which Electron keeps across redirects and leaves absent for browser-started requests.

// ---- IP: bigint per version (from egress.ts) ----

interface Ip { v: 4 | 6; n: bigint }

const V4_MASK = 0xffffffffn

/** One WHATWG IPv4 part (`0x…` hex, `0…` octal, decimal), or null when it is not a number. */
function v4Part(p: string): bigint | null {
  if (/^0[xX][0-9a-fA-F]*$/.test(p)) return p.length === 2 ? 0n : BigInt(p)
  if (/^0[0-7]+$/.test(p)) return BigInt(`0o${p.slice(1)}`)
  if (/^(0|[1-9]\d*)$/.test(p)) return BigInt(p)
  return null
}

/**
 * A host in the WHATWG IPv4 forms: 1 to 4 numeric parts, each below 256 except the last, which fills the remaining bytes.
 * `undefined` when the host does not end in a number (a name); `null` when it does but is not a valid address (the URL
 * parser rejects it: treated as local, closed).
 */
export function parseV4(s: string): bigint | null | undefined {
  const parts = s.split('.')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const last = parts[parts.length - 1] ?? ''
  if (!/^(\d+|0[xX][0-9a-fA-F]*)$/.test(last)) return undefined
  if (parts.length > 4) return null
  const nums = parts.map(v4Part)
  if (nums.some(n => n === null)) return null
  const head = nums.slice(0, -1) as bigint[]
  const tail = nums[nums.length - 1] as bigint
  if (head.some(n => n > 255n)) return null
  if (tail >= 256n ** BigInt(5 - nums.length)) return null
  let n = 0n
  head.forEach((p, i) => { n |= p << BigInt(8 * (3 - i)) })
  return n | tail
}

function parseV6(raw: string): bigint | null {
  let s = raw
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  let tail = 0n
  let tailGroups = 0
  const dot = s.lastIndexOf('.')
  if (dot >= 0) {
    const colon = s.lastIndexOf(':')
    const v4 = strictV4(s.slice(colon + 1))
    if (v4 === null) return null
    tail = v4
    tailGroups = 2
    s = s.slice(0, colon + 1) + '0:0'
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = groups(halves[0]!)
  const rest = halves.length === 2 ? groups(halves[1]!) : []
  if (!head || !rest) return null
  let all: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    all = [...head, ...new Array<number>(fill).fill(0), ...rest]
  } else all = head
  if (all.length !== 8) return null
  let n = 0n
  for (const g of all) n = (n << 16n) | BigInt(g)
  if (tailGroups) n = (n & ~V4_MASK) | tail
  return n
}

/** The dotted-quad inside an IPv6 address (strict: four decimal parts). */
function strictV4(s: string): bigint | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = (n << 8n) | BigInt(p)
  }
  return n
}

/** An IP literal (IPv4 in any WHATWG form, IPv6 with or without brackets); `null` for a broken numeric host; `undefined` for a name. */
export function parseIp(host: string): Ip | null | undefined {
  if (host.includes(':')) {
    const n = parseV6(host)
    if (n === null) return null
    // ::ffff:a.b.c.d is the IPv4 a.b.c.d; the rule and its exceptions speak of the IPv4.
    if (n >> 32n === 0xffffn) return { v: 4, n: n & V4_MASK }
    return { v: 6, n }
  }
  const v4 = parseV4(host)
  if (v4 === undefined || v4 === null) return v4
  return { v: 4, n: v4 }
}

interface Cidr { v: 4 | 6; base: bigint; bits: number }

function cidr(text: string): Cidr {
  const [addr, len] = text.split('/') as [string, string]
  const ip = parseIp(addr)!
  const bits = Number(len)
  const shift = BigInt((ip.v === 4 ? 32 : 128) - bits)
  return { v: ip.v, base: (ip.n >> shift) << shift, bits }
}

function inCidr(ip: Ip, c: Cidr): boolean {
  if (ip.v !== c.v) return false
  const shift = BigInt((ip.v === 4 ? 32 : 128) - c.bits)
  return (ip.n >> shift) << shift === c.base
}

const FORBIDDEN: { range: Cidr; label: string }[] = ([
  ['0.0.0.0/8', 'this-network'],
  ['10.0.0.0/8', 'private (RFC 1918)'],
  ['100.64.0.0/10', 'carrier-grade NAT'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local (cloud metadata)'],
  ['172.16.0.0/12', 'private (RFC 1918)'],
  ['192.0.0.0/24', 'IETF protocol assignments'],
  ['192.168.0.0/16', 'private (RFC 1918)'],
  ['198.18.0.0/15', 'benchmarking'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
  ['::/96', 'unspecified/loopback/IPv4-compatible'],
  ['100::/64', 'discard-only'],
  ['2001::/32', 'Teredo'],
  ['fc00::/7', 'unique-local'],
  ['fe80::/10', 'link-local'],
  ['fec0::/10', 'site-local'],
  ['ff00::/8', 'multicast'],
] as const).map(([text, label]) => ({ range: cidr(text), label }))

const NAT64 = cidr('64:ff9b::/96')

// Whole ranges refused (simpler and safer than decoding the embedded IPv4): the IPv4 behind them is reachable through a
// translator or tunnel. 64:ff9b::/96 (global NAT64) is decoded: a public IPv4 there is legitimate.
const V6_EMBEDDED_BLOCKED: { range: Cidr; label: string }[] = ([
  ['64:ff9b:1::/48', 'local-use NAT64 (RFC 8215)'],
  ['::ffff:0:0:0/96', 'SIIT IPv4-translated (RFC 2765)'],
  ['2002::/16', '6to4'],
] as const).map(([text, label]) => ({ range: cidr(text), label }))

/** ISATAP: the interface identifier is `[02]00:5efe:a.b.c.d`. */
function isIsatap(n: bigint): boolean {
  const hi = (n >> 32n) & 0xffffffffn
  return hi === 0x00005efen || hi === 0x02005efen
}

/** Why an IP is on the local network (or otherwise not public), or null when it is public. */
export function localIpReason(ip: Ip): string | null {
  for (const f of FORBIDDEN) if (inCidr(ip, f.range)) return f.label
  if (ip.v === 6) {
    for (const f of V6_EMBEDDED_BLOCKED) if (inCidr(ip, f.range)) return f.label
    if (isIsatap(ip.n)) return 'ISATAP tunnel'
    if (inCidr(ip, NAT64)) return localIpReason({ v: 4, n: ip.n & V4_MASK })
  }
  return null
}

// ---- hosts and origins ----

/** Name suffixes that only resolve inside the local network (mDNS `.local`, RFC 6761/8375 and the usual private zones). */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'intranet', 'corp', 'localdomain']

export interface NetOptions {
  /** Hosts treated as public although their address is local: the E2E's stand-in for a public site (S4's 127.0.0.2). */
  publicStandIns?: ReadonlySet<string>
}

/**
 * Whether a host is on the local network, by its text alone: an IP literal in a local range (any WHATWG form), a numeric host
 * the URL parser would reject, `localhost` and the local suffixes, or a single-label name (Windows resolves those over
 * LLMNR/NetBIOS and the DNS search suffix, i.e. to the LAN). A public name that RESOLVES to a local address is not caught
 * here (the E4 proxy pins the address).
 */
export function isLocalHost(rawHost: string, opts: NetOptions = {}): boolean {
  let host = rawHost.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (opts.publicStandIns?.has(host)) return false
  if (host === '') return true
  const ip = parseIp(host)
  if (ip === null) return true
  if (ip) return localIpReason(ip) !== null
  if (!host.includes('.')) return true
  return LOCAL_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`))
}

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** Whether an origin (`initiatorOrigin`) is local: a network origin whose host is local. `null` (opaque) and the rest are not. */
export function isLocalOrigin(origin: string, opts: NetOptions = {}): boolean {
  try {
    const u = new URL(origin)
    return NETWORK_SCHEMES.has(u.protocol) && isLocalHost(u.hostname, opts)
  } catch { return false }
}

/** An address reduced to its origin (`scheme://host:port`), or to its scheme when it has no network origin: what may be shown. */
export function originOnly(url: string): string {
  try {
    const u = new URL(url)
    return NETWORK_SCHEMES.has(u.protocol) ? `${u.protocol}//${u.host}` : u.protocol
  } catch { return '' }
}

function portOf(u: URL): string {
  return u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80')
}

/** Same scheme, host and port. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && x.hostname === y.hostname && portOf(x) === portOf(y)
  } catch { return false }
}

// ---- the decision ----

/** Why a grant was given: a public (or non-network) destination, a local origin, or a ticket. */
export type Grant = 'public' | 'origin' | 'ticket'

/** Why a request was refused (the `blocked` event's reason). */
export type BlockReason = 'scheme' | 'local-from-public' | 'local-redirect' | 'local-without-ticket'

export interface RequestFacts {
  url: string
  resourceType: string
  method: string
  /** Electron's `initiatorOrigin`: kept across redirects, absent when the browser started the request. */
  initiator?: string
  /** Set on a redirect hop: the previous hop's address and the grant the chain had. */
  hop?: { prevUrl: string; grant: Grant }
  /** A ticket for this exact address exists in this tab (only used, and then consumed, when the decision says so). */
  ticket: boolean
}

export type Decision = { allow: true; grant: Grant; useTicket: boolean } | { allow: false; reason: BlockReason }

const SUBRESOURCE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'])
const MAIN_FRAME_SCHEMES = new Set(['http:', 'https:'])

/** Whether one request (or redirect hop) of a tab passes the filter. */
export function decide(f: RequestFacts, opts: NetOptions = {}): Decision {
  let u: URL
  try { u = new URL(f.url) } catch { return { allow: false, reason: 'scheme' } }
  const mainFrame = f.resourceType === 'mainFrame'
  if (!(mainFrame ? MAIN_FRAME_SCHEMES : SUBRESOURCE_SCHEMES).has(u.protocol)) return { allow: false, reason: 'scheme' }
  if (!NETWORK_SCHEMES.has(u.protocol) || !isLocalHost(u.hostname, opts)) return { allow: true, grant: 'public', useTicket: false }
  // A local destination.
  if (f.initiator !== undefined) {
    if (isLocalOrigin(f.initiator, opts)) return { allow: true, grant: 'origin', useTicket: false }
    return { allow: false, reason: f.hop ? 'local-redirect' : 'local-from-public' }
  }
  if (f.hop) {
    // A browser-started chain (the ticket's): only a same-origin local → local continuation keeps the grant.
    const prev = f.hop.prevUrl
    let prevLocal = false
    try { const p = new URL(prev); prevLocal = NETWORK_SCHEMES.has(p.protocol) && isLocalHost(p.hostname, opts) } catch { /* closed */ }
    if (f.hop.grant === 'ticket' && prevLocal && sameOrigin(prev, f.url)) return { allow: true, grant: 'ticket', useTicket: false }
    return { allow: false, reason: 'local-redirect' }
  }
  if (mainFrame && f.method === 'GET' && f.ticket) return { allow: true, grant: 'ticket', useTicket: true }
  return { allow: false, reason: 'local-without-ticket' }
}

// ---- tickets ----

export const TICKET_TTL_MS = 5_000

/** The key a ticket is kept under: the exact address without fragment, normalized by the URL parser (undefined when not http(s)). */
export function ticketUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    // The fragment never reaches the network (webRequest sees the address without it).
    u.hash = ''
    return MAIN_FRAME_SCHEMES.has(u.protocol) ? u.href : undefined
  } catch { return undefined }
}

/** Tickets: one exact address in one tab (by its page's id), one use, `TICKET_TTL_MS` to use it. */
export class Tickets {
  private readonly items = new Map<string, number>()
  private readonly ttl: number
  constructor(ttl = TICKET_TTL_MS) { this.ttl = ttl }

  private static key(tab: number, url: string): string | undefined {
    const href = ticketUrl(url)
    return href === undefined ? undefined : `${tab} ${href}`
  }

  /** Grants a ticket; false when the address is not http(s). A second grant for the same address renews it (still one use). */
  grant(tab: number, url: string, now = Date.now()): boolean {
    const k = Tickets.key(tab, url)
    if (k === undefined) return false
    this.prune(now)
    this.items.set(k, now + this.ttl)
    return true
  }

  has(tab: number, url: string, now = Date.now()): boolean {
    const k = Tickets.key(tab, url)
    const until = k === undefined ? undefined : this.items.get(k)
    return until !== undefined && until > now
  }

  /** Uses the ticket: true once, then it is gone. */
  take(tab: number, url: string, now = Date.now()): boolean {
    const ok = this.has(tab, url, now)
    const k = Tickets.key(tab, url)
    if (k !== undefined) this.items.delete(k)
    return ok
  }

  /** Every ticket of one tab goes (the tab closed). */
  dropTab(tab: number): void {
    for (const k of [...this.items.keys()]) if (k.startsWith(`${tab} `)) this.items.delete(k)
  }

  dropAll(): void { this.items.clear() }

  get size(): number { return this.items.size }

  private prune(now: number): void {
    for (const [k, until] of this.items) if (until <= now) this.items.delete(k)
  }
}
