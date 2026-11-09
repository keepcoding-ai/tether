// COPY of packages/browser/src/egress.ts (keepcoding-ai/atrium, commit be174e406ad7088df77a53feb09dbd31241c2ebb, the
// commit the vendored bundle was built from), for the egress proxy (egress-proxy.ts, same origin). Changed only
// mechanically: the constructor's parameter property became a field (`erasableSyntaxOnly`) and the package's BrowserError
// is a local stand-in. Update it by copying the package's file again. Comments below are the package's, in Portuguese.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Stands in for the package's BrowserError (core/errors.ts): same `code` and message, nothing else is used here. */
class BrowserError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

// Política de egress da sessão (manifesto §3.6). Todo tráfego do browser — navegação, subrecurso, popup,
// download, WebSocket e cada passo de redirecionamento — passa por um proxy em Node (`egress-proxy.ts`)
// que consulta `Egress.inspect` e conecta ao IP validado.
// Default deny: destino privado, loopback, link-local (inclui o metadata 169.254.169.254), ULA v6 (inclui
// a rede 6PN do nó) e esquemas locais (`file:` etc.) são negados. Quem hospeda libera destinos por código
// (`egress.allow`); não existe env var nem arquivo de configuração.

export interface EgressPolicy {
  /**
   * Destinos liberados mesmo sendo privados. Cada item é um hostname exato (`intranet.corp`), um IP
   * (`127.0.0.1`, `::1`) ou um bloco CIDR (`10.1.0.0/16`). Um destino liberado vale em qualquer porta.
   * Portão do destino privado: um bloco CIDR (ou IP) só vale para quem é IP LITERAL na URL. Um NOME que resolve
   * para endereço privado é negado mesmo dentro de um bloco liberado (nip.io, localtest.me e DNS rebinding
   * apontam nomes públicos para o loopback); nome só passa se estiver listado aqui, por extenso, pelo operador.
   * Default: nenhum. `['0.0.0.0/0', '::/0']` desliga a política (decisão explícita de quem hospeda).
   */
  allow?: string[]
  /** Portas permitidas para destinos NÃO liberados por `allow`. Default `[80, 443, 8080, 8443]`. */
  ports?: number[]
  /**
   * Teto de portas para QUALQUER destino, inclusive os liberados por `allow` (que sem isto valem em qualquer porta).
   * Aditivo: ausente = comportamento de sempre. Serve a quem libera um loopback para UM servidor descartável
   * (a prova do architect) e não pode deixar os outros serviços do mesmo IP ao alcance.
   */
  allowedPortsOnly?: number[]
}

export const DEFAULT_EGRESS_PORTS = [80, 443, 8080, 8443]

export interface EgressBlock {
  seq: number
  /** URL completa (HTTP simples e `navigate`) ou `host:porta` (túnel HTTPS/WebSocket, onde só o destino é visível). */
  url: string
  reason: string
  ts: number
}

export interface Verdict {
  reason: string | null
  /** Endereços validados (texto) a que o chamador deve conectar; vazio quando negado. */
  ips: string[]
  /** Destino de classe privada (IP privado/loopback literal, `localhost` ou nome listado pelo operador). Só vale quando liberado. */
  private?: boolean
  /** Detalhe da negação (IP resolvido, categoria). SÓ para o log interno do host: nunca vai à página nem ao agente. */
  detail?: string
}

/** Única razão que a página e o agente veem para destino negado por nome/IP: não distingue "não resolve" de "privado". */
export const DENIED_REASON = 'destination is not allowed by the egress policy'

// ---- IP: bigint por versão ----

interface Ip {
  v: 4 | 6
  n: bigint
}

const V4_MASK = 0xffffffffn

function parseV4(s: string): bigint | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = (n << 8n) | BigInt(p)
  }
  return n
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
    const v4 = parseV4(s.slice(colon + 1))
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
  } else {
    all = head
  }
  if (all.length !== 8) return null
  let n = 0n
  for (const g of all) n = (n << 16n) | BigInt(g)
  if (tailGroups) n = (n & ~V4_MASK) | tail
  return n
}

function parseIp(s: string): Ip | null {
  const kind = isIP(s)
  if (kind === 4) {
    const n = parseV4(s)
    return n === null ? null : { v: 4, n }
  }
  if (kind === 6) {
    const n = parseV6(s)
    if (n === null) return null
    // ::ffff:a.b.c.d é o IPv4 a.b.c.d; a regra e as exceções falam do IPv4.
    if (n >> 32n === 0xffffn) return { v: 4, n: n & V4_MASK }
    return { v: 6, n }
  }
  return null
}

interface Cidr {
  v: 4 | 6
  base: bigint
  bits: number
}

function cidr(text: string): Cidr {
  const [addr, len] = text.split('/') as [string, string]
  const ip = parseIp(addr)!
  const bits = Number(len)
  const width = ip.v === 4 ? 32 : 128
  const shift = BigInt(width - bits)
  return { v: ip.v, base: (ip.n >> shift) << shift, bits }
}

function inCidr(ip: Ip, c: Cidr): boolean {
  if (ip.v !== c.v) return false
  const shift = BigInt((ip.v === 4 ? 32 : 128) - c.bits)
  return (ip.n >> shift) << shift === c.base
}

const FORBIDDEN: { range: Cidr; label: string }[] = (
  [
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
    ['fc00::/7', 'unique-local (includes the node internal network)'],
    ['fe80::/10', 'link-local'],
    ['fec0::/10', 'site-local'],
    ['ff00::/8', 'multicast'],
  ] as const
).map(([text, label]) => ({ range: cidr(text), label }))

const NAT64 = cidr('64:ff9b::/96')

// Faixas inteiras bloqueadas (mais simples e seguro que decodificar o IPv4 embutido): o IPv4 de trás é
// alcançável por tradutor/túnel do nó. 64:ff9b::/96 (NAT64 global) segue decodificado: IPv4 público é legítimo.
const V6_EMBEDDED_BLOCKED: { range: Cidr; label: string }[] = (
  [
    ['64:ff9b:1::/48', 'local-use NAT64 (RFC 8215)'],
    ['::ffff:0:0:0/96', 'SIIT IPv4-translated (RFC 2765)'],
    ['2002::/16', '6to4'],
  ] as const
).map(([text, label]) => ({ range: cidr(text), label }))

/** ISATAP: o identificador de interface é `[02]00:5efe:a.b.c.d`. */
function isIsatap(n: bigint): boolean {
  const hi = (n >> 32n) & 0xffffffffn
  return hi === 0x00005efen || hi === 0x02005efen
}

/** Motivo de o IP ser proibido, ou null se for público. */
export function forbiddenIpReason(ip: Ip): string | null {
  for (const f of FORBIDDEN) if (inCidr(ip, f.range)) return f.label
  if (ip.v === 6) {
    for (const f of V6_EMBEDDED_BLOCKED) if (inCidr(ip, f.range)) return f.label
    if (isIsatap(ip.n)) return 'ISATAP tunnel'
    // NAT64 global chega ao IPv4 embutido: vale a regra do IPv4.
    if (inCidr(ip, NAT64)) return forbiddenIpReason({ v: 4, n: ip.n & V4_MASK })
  }
  return null
}

// ---- política ----

type AllowEntry = { kind: 'host'; host: string } | { kind: 'cidr'; range: Cidr }

function parseAllow(entry: unknown): AllowEntry {
  const bad = () =>
    new BrowserError(
      'INVALID_ARGUMENT',
      `egress.allow entries must be a hostname, an IP or a CIDR block; got ${JSON.stringify(entry)}.`,
    )
  if (typeof entry !== 'string' || entry === '') throw bad()
  const text = entry.toLowerCase()
  if (text.includes('/')) {
    const [addr, len, ...extra] = text.split('/') as [string, string, ...string[]]
    const ip = parseIp(addr)
    const bits = Number(len)
    if (extra.length || !ip || !/^\d{1,3}$/.test(len) || bits > (ip.v === 4 ? 32 : 128)) {
      throw bad()
    }
    return { kind: 'cidr', range: cidr(`${addr}/${len}`) }
  }
  const ip = parseIp(text)
  if (ip) return { kind: 'cidr', range: cidr(`${text}/${ip.v === 4 ? 32 : 128}`) }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(text)) throw bad()
  return { kind: 'host', host: text }
}

type Resolve = (host: string) => Promise<string[]>

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

const BLOCK_LOG_MAX = 100

export class Egress {
  readonly blocks: EgressBlock[] = []
  /** Log INTERNO do host (detalhe das negações: IP resolvido, categoria). Não é exposto pela sessão. */
  readonly internalLog: string[] = []
  private readonly allow: AllowEntry[]
  private readonly ports: Set<number>
  private readonly portCeiling: Set<number> | undefined
  private seq = 0

  private readonly resolve: Resolve

  constructor(policy: EgressPolicy = {}, resolve: Resolve = resolveAll) {
    this.resolve = resolve
    if (policy === null || typeof policy !== 'object') {
      throw new BrowserError('INVALID_ARGUMENT', 'egress must be an object.')
    }
    if (policy.allow !== undefined && !Array.isArray(policy.allow)) {
      throw new BrowserError('INVALID_ARGUMENT', 'egress.allow must be an array of strings.')
    }
    this.allow = (policy.allow ?? []).map(parseAllow)
    const ports = policy.ports ?? DEFAULT_EGRESS_PORTS
    if (!Array.isArray(ports) || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
      throw new BrowserError('INVALID_ARGUMENT', 'egress.ports must be an array of integers from 1 to 65535.')
    }
    this.ports = new Set(ports)
    const ceiling = policy.allowedPortsOnly
    if (ceiling !== undefined && (!Array.isArray(ceiling) || ceiling.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))) {
      throw new BrowserError('INVALID_ARGUMENT', 'egress.allowedPortsOnly must be an array of integers from 1 to 65535.')
    }
    this.portCeiling = ceiling ? new Set(ceiling) : undefined
  }

  /**
   * Motivo de negar `rawUrl`, ou null se liberado. Serve ao `navigate` (erro nomeado antes de tocar a rede)
   * e aos testes; quem barra de verdade o tráfego do browser é o proxy (`egress-proxy.ts`), que chama `inspect`.
   */
  async check(rawUrl: string): Promise<string | null> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return `URL "${rawUrl}" is not valid`
    }
    switch (url.protocol) {
      case 'data:':
      case 'blob:':
        return null
      case 'about:':
        return url.pathname === 'blank' || url.pathname === 'srcdoc' ? null : `scheme "about:" is only allowed for about:blank`
      case 'http:':
      case 'https:':
      case 'ws:':
      case 'wss:':
        break
      default:
        return `scheme "${url.protocol}" is not allowed`
    }
    const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80))
    return (await this.inspect(url.hostname, port)).reason
  }

  /**
   * Decide sobre um destino host:porta. Quando libera, devolve os endereços VALIDADOS: quem conecta
   * deve usar esses IPs e nunca resolver o nome de novo (é o que fecha o DNS rebinding).
   */
  async inspect(rawHost: string, port: number): Promise<Verdict> {
    let host = rawHost.toLowerCase().replace(/\.$/, '')
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    if (this.portCeiling && !this.portCeiling.has(port)) {
      return { reason: `port ${port} is not allowed (allowed: ${[...this.portCeiling].join(', ')})`, ips: [] }
    }
    const hostAllowed = this.allow.some((a) => a.kind === 'host' && a.host === host)
    const deny = (detail: string): Verdict => {
      this.logInternal(detail)
      return { reason: DENIED_REASON, ips: [], detail }
    }

    const literal = parseIp(host)
    let ips: Ip[]
    if (literal) {
      ips = [literal]
    } else if (!hostAllowed && (host === 'localhost' || host.endsWith('.localhost'))) {
      return deny(`destination ${host} is loopback`)
    } else {
      let addrs: string[]
      try {
        addrs = await this.resolve(host)
      } catch {
        return deny(`host "${host}" could not be resolved`)
      }
      ips = addrs.map((a) => parseIp(a)).filter((i): i is Ip => i !== null)
      if (ips.length === 0) return deny(`host "${host}" resolved to no usable address`)
    }
    const pinned = ips.map(ipText)
    // Hostname liberado por quem hospeda: os IPs que ele resolve são decisão dele. O DNS fica fixado nestes IPs.
    if (hostAllowed && !literal) return { reason: null, ips: pinned, private: true }

    let released = true
    let isPrivate = false
    for (const ip of ips) {
      const why = forbiddenIpReason(ip)
      if (why) isPrivate = true
      // Bloco CIDR liberado só vale para IP literal: nome público que resolve para privado é negado (rebinding, nip.io).
      if (literal && this.allow.some((a) => a.kind === 'cidr' && inCidr(ip, a.range))) continue
      released = false
      if (why) return deny(`destination ${host}${literal ? '' : ` (${ipText(ip)})`} is ${why}${literal ? '' : ' (a name that resolves to a private address; only IP literals, localhost and operator-listed names pass)'}`)
    }
    if (!released && !this.ports.has(port)) {
      return { reason: `port ${port} is not allowed (allowed: ${[...this.ports].join(', ')})`, ips: [] }
    }
    return { reason: null, ips: pinned, private: isPrivate }
  }

  /**
   * Por forma textual, sem rede: o host é de classe privada (IP privado/loopback/link-local literal, `localhost` ou nome
   * listado pelo operador)? Um nome público que resolva para privado nem chega aqui: o `inspect` o nega. Serve ao portão de
   * origem (`origin-gate.ts`): requisição a destino privado só passa se a página de origem também é privada.
   */
  isPrivateHost(rawHost: string): boolean {
    let host = rawHost.toLowerCase().replace(/\.$/, '')
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    const literal = parseIp(host)
    if (literal) return forbiddenIpReason(literal) !== null
    return host === 'localhost' || host.endsWith('.localhost') || this.allow.some((a) => a.kind === 'host' && a.host === host)
  }

  /** O operador listou este NOME em `ATRIUM_BROWSER_PRIVATE_HOSTS` (não vale para IP literal nem para o `localhost` da base). */
  isOperatorHost(rawHost: string): boolean {
    const host = rawHost.toLowerCase().replace(/\.$/, '')
    if (host === 'localhost' || host.endsWith('.localhost')) return false
    return this.allow.some((a) => a.kind === 'host' && a.host === host)
  }

  /** Registra a negação do portão de origem (log interno com o detalhe; a página e o agente só veem o motivo genérico). */
  denyOrigin(url: string, detail: string): EgressBlock {
    this.logInternal(detail)
    return this.record(url, DENIED_REASON)
  }

  /** Linha no log interno (sem página nem agente no caminho). */
  logInternal(detail: string): void {
    this.internalLog.push(`${new Date().toISOString()} ${detail}`)
    if (this.internalLog.length > BLOCK_LOG_MAX) this.internalLog.shift()
  }

  /** Registra a negação (para `egressBlocks`, `read_network` e para o erro de `navigate`). */
  record(url: string, reason: string): EgressBlock {
    const block: EgressBlock = { seq: ++this.seq, url, reason, ts: Date.now() }
    this.blocks.push(block)
    if (this.blocks.length > BLOCK_LOG_MAX) this.blocks.shift()
    return block
  }

  /** Marca para `blocksSince`. */
  mark(): number {
    return this.seq
  }

  blocksSince(mark: number): EgressBlock[] {
    return this.blocks.filter((b) => b.seq > mark)
  }

  /**
   * Negação que corresponde a uma requisição: a URL exata (HTTP simples) ou o `host:porta` do túnel
   * (HTTPS e WebSocket, onde o proxy só vê o destino). A mais recente.
   */
  blockFor(requestUrl: string): EgressBlock | undefined {
    let key = ''
    try {
      const u = new URL(requestUrl)
      key = `${u.hostname}:${u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80)}`
    } catch {
      // URL ilegível: só a comparação exata
    }
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!
      if (b.url === requestUrl || b.url === key) return b
    }
    return undefined
  }
}

function ipText(ip: Ip): string {
  if (ip.v === 4) return [24n, 16n, 8n, 0n].map((s) => String((ip.n >> s) & 255n)).join('.')
  const groups: string[] = []
  for (let i = 7n; i >= 0n; i--) groups.push(((ip.n >> (i * 16n)) & 0xffffn).toString(16))
  return groups.join(':')
}

export function egressBlocked(url: string, reason: string): BrowserError {
  return new BrowserError('EGRESS_BLOCKED', `Egress blocked for ${url}: ${reason}.`)
}
