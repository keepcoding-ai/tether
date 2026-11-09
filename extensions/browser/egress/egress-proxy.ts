// COPY of packages/browser/src/egress-proxy.ts (keepcoding-ai/atrium, commit be174e406ad7088df77a53feb09dbd31241c2ebb, the
// commit the vendored bundle was built from: vendor/tether-browser/manifest.json). The bundle (server.mjs) does not export
// it, and the design (§4.1 item 2) reuses it without change, so it is copied, never edited here except mechanically: the
// constructor's parameter properties became fields (this repo compiles with `erasableSyntaxOnly`). Update it by copying the
// package's file again. Comments below are the package's, in Portuguese.
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { connect, type AddressInfo, type Socket } from 'node:net'
import type { Egress } from './egress.ts'

// Proxy HTTP local, um por sessão, por onde passa TODO o tráfego do contexto (`proxy` do contexto do
// Playwright). É ele quem aplica a política de egress, e por três razões que `context.route` não cumpre:
//   - redirecionamentos: o Chromium segue um 3xx sem devolver a requisição ao Playwright, então `context.route`
//     NÃO vê o salto; pelo proxy cada salto é uma requisição nova e é conferida;
//   - rebinding: o proxy resolve o nome UMA vez, confere o IP e conecta a esse IP (o Chromium nunca resolve);
//   - WebSocket, service workers e downloads: tudo sai pela mesma porta.
//
// BILHETE (E12, A1 re-auditoria). O proxy decide por destino e não sabe QUEM pede. Destino de classe privada
// (loopback, rede privada, nome que o operador listou) só passa mediante um bilhete: uso único, prazo curto,
// emitido ANTES pelo portão de origem (`origin-gate.ts`, que enxerga o frame de quem pede) ou pela navegação
// da LLM, para a URL exata (HTTP) ou para `host:porta` (CONNECT). Um salto de redirecionamento não tem bilhete,
// então é negado, exceto privado -> privado DA MESMA ORIGEM (host e porta) a partir de uma requisição que tinha bilhete
// (login -> dashboard num app local): o proxy lê o `Location` da resposta e emite o bilhete do salto. Outro host privado
// só se o operador o listou (`ATRIUM_BROWSER_PRIVATE_HOSTS`): senão um open redirect local seria um trampolim. WebSocket (CONNECT opaco,
// que `context.route` não vê) usa a regra do `ambient` (ver `setAmbient`), a ÚNICA exceção ao bilhete: vale para o CONNECT e para o
// GET de download (`<a download>`), que não tem como ter bilhete. O resto do HTTP sem bilhete é sempre negado.
// HTTPS e WebSocket entram por CONNECT (túnel opaco: só o destino é conferido, o TLS é do browser).
// Negado = a conexão é derrubada (nunca uma página 403 que pareça conteúdo): o gesto falha e a negação
// fica em `egress.blocks`.

const CHALLENGE = 'proxy-authenticate: Basic realm="atrium-egress"\r\n'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function end(client: Socket, status: string, extra = ''): void {
  client.end(`HTTP/1.1 ${status}
${extra}content-length: 0
connection: close

`)
}

/** Ociosidade (sem byte em nenhum sentido) que derruba uma conexão, e teto de conexões do browser por sessão. */
export const PROXY_IDLE_MS = 120_000
export const PROXY_MAX_CONNECTIONS = 256

/** Validade de um bilhete (ms). Curta: cobre o intervalo entre o portão de origem liberar a requisição e ela chegar ao proxy. */
export const TICKET_TTL_MS = 5_000
/** Janela em que o estado "contexto limpo" é reconferido antes de negar (ver `ambientClean`). */
export const AMBIENT_GRACE_MS = 400

export interface EgressProxyOptions {
  idleMs?: number
  maxConnections?: number
  ticketTtlMs?: number
}

/** Chave do bilhete: URL exata para HTTP simples; `host:porta` para o que entra por CONNECT (https, ws, wss). */
export function ticketKey(rawUrl: string): string | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  switch (u.protocol) {
    case 'http:':
      return u.href
    case 'https:':
    case 'ws:':
    case 'wss:':
      return tunnelKey(u.hostname, Number(u.port || (u.protocol === 'ws:' ? 80 : 443)))
    default:
      return null
  }
}

/**
 * Download de `<a download>`: `context.route` não o enxerga, então não tem bilhete. É a ÚNICA requisição HTTP que pode
 * usar a exceção do contexto limpo, e só se for GET com `Sec-Fetch-Mode: navigate` e `Sec-Fetch-Dest: empty` (assinatura
 * do download; a navegação de documento chega com `document`, passa por `context.route` e o salto dela, sem bilhete, é
 * negado). Cabeçalhos `Sec-Fetch-*` são proibidos ao script de página: `fetch` nunca tem modo `navigate`. fetch, XHR,
 * POST e quem não traz esses cabeçalhos nunca usam a exceção. O Chromium só os envia a origens confiáveis
 * (`127.0.0.1`, `localhost`).
 */
function isDownloadRequest(req: IncomingMessage): boolean {
  return req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'empty'
}

function isTunnelKey(rawUrl: string): boolean {
  return !rawUrl.startsWith('http:')
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && (a.port || '80') === (b.port || '80')
}

function tunnelKey(host: string, port: number): string {
  let h = host.toLowerCase().replace(/\.$/, '')
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return `${h}:${port}`
}

const sha = (s: string) => createHash('sha256').update(s).digest()

export class EgressProxy {
  /** Endereço para `proxy.server` do contexto. */
  readonly server: string
  /** Credencial da sessão (`proxy.username/password` do contexto): sem ela, toda requisição é 407. */
  readonly username = 'atrium'
  readonly password = randomBytes(24).toString('hex')
  private readonly expected = sha(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`)
  private readonly sockets = new Set<Socket>()
  /** Conexões do browser ao proxy (as de saída, `dial`, não contam): o teto é conferido aqui, em JS. */
  private readonly clients = new Set<Socket>()
  private readonly tickets = new Map<string, { id: number; exp: number }[]>()
  private ticketSeq = 0
  private readonly ambientGraceMs = AMBIENT_GRACE_MS
  private ambient: ((sinceMs: number) => boolean | Promise<boolean>) | null = null

  private readonly http: Server
  private readonly egress: Egress
  private readonly idleMs: number
  private readonly ticketTtlMs: number
  private readonly maxConnections: number

  private constructor(http: Server, port: number, egress: Egress, idleMs: number, ticketTtlMs: number, maxConnections: number) {
    this.http = http
    this.egress = egress
    this.idleMs = idleMs
    this.ticketTtlMs = ticketTtlMs
    this.maxConnections = maxConnections
    this.server = `http://127.0.0.1:${port}`
    // Teto de conexões em JS, nunca `server.maxConnections`: no Node 24 do Windows a recusa nativa do excedente
    // derruba o PROCESSO inteiro (saída 0xC0000409, sem pilha nem stderr). Uma página do Vite em dev (centenas de módulos)
    // passava do teto e matava o MCP no meio de um gesto. Aqui a excedente é só destruída, como uma conexão qualquer.
    http.on('connection', (s) => {
      this.track(s)
      if (this.clients.size >= this.maxConnections) {
        s.destroy()
        return
      }
      this.clients.add(s)
      s.once('close', () => this.clients.delete(s))
    })
    http.on('connect', (req, client, head) => {
      if (!this.authorized(req.headers['proxy-authorization'])) return end(client as Socket, '407 Proxy Authentication Required', CHALLENGE)
      this.tunnel(req.url ?? '', client as Socket, head).catch(() => (client as Socket).destroy())
    })
    http.on('request', (req, res) => {
      if (!this.authorized(req.headers['proxy-authorization'])) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="atrium-egress"', 'content-length': '0', connection: 'close' }).end()
        return
      }
      this.forward(req, res).catch(() => (res.headersSent ? res.destroy() : res.writeHead(502).end()))
    })
    // Upgrade fora de CONNECT não é usado pelo Chromium com proxy; sem handler o Node fecha o socket.
    http.on('clientError', (_err, socket) => socket.destroy())
  }

  static async start(egress: Egress, opts: EgressProxyOptions = {}): Promise<EgressProxy> {
    const http = createServer()
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    return new EgressProxy(http, (http.address() as AddressInfo).port, egress, opts.idleMs ?? PROXY_IDLE_MS, opts.ticketTtlMs ?? TICKET_TTL_MS, opts.maxConnections ?? PROXY_MAX_CONNECTIONS)
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  /**
   * Emite um bilhete (uso único) para `rawUrl`: a URL exata se for http:, `host:porta` se for https/ws/wss.
   * Devolve o id (para `revoke`), ou null se a URL não é de rede.
   */
  grant(rawUrl: string): number | null {
    const key = ticketKey(rawUrl)
    if (key === null) return null
    const id = ++this.ticketSeq
    const now = Date.now()
    const entry = { id, exp: now + this.ticketTtlMs }
    if (isTunnelKey(rawUrl)) {
      // Um bilhete vale por `host:porta` e não acumula: no máximo um vivo (o novo substitui o anterior).
      this.tickets.set(key, [entry])
    } else {
      const list = (this.tickets.get(key) ?? []).filter((t) => t.exp > now)
      list.push(entry)
      this.tickets.set(key, list)
    }
    return id
  }

  /** Cancela um bilhete que ainda não foi usado (a requisição acabou sem consumi-lo, por exemplo num túnel reaproveitado). */
  revoke(id: number): void {
    for (const [key, list] of this.tickets) {
      const i = list.findIndex((t) => t.id === id)
      if (i < 0) continue
      list.splice(i, 1)
      if (list.length === 0) this.tickets.delete(key)
      // Bilhete de túnel que sobrou: a requisição acabou sem abrir túnel novo, ou seja, andou num túnel já aberto (keep-alive).
      if (!key.startsWith('http://')) this.egress.logInternal(`tunnel to ${key} reused by a request (its ticket was never consumed)`)
      return
    }
  }

  /** Consome UM bilhete válido da chave. */
  private take(key: string): boolean {
    const list = this.tickets.get(key)
    if (!list) return false
    const now = Date.now()
    const live = list.filter((t) => t.exp > now)
    const hit = live.shift()
    if (live.length) this.tickets.set(key, live)
    else this.tickets.delete(key)
    return hit !== undefined
  }

  /**
   * Requisições que `context.route` não enxerga (upgrade de WebSocket por CONNECT opaco) não têm bilhete por requisição. O
   * host diz, no momento, se o contexto está "limpo" (nenhum documento público vivo, nenhum frame neutro com opener ou
   * ancestral público, nenhuma navegação com salto público em curso, nenhum service worker público): então nenhum código público pode ser a
   * causa e o túnel privado sem bilhete passa. Contexto sujo, ou sem a função: negado. Usam esta via o CONNECT e o GET de
   * download (`isDownloadRequest`); o resto do HTTP sem bilhete é sempre negado. `fn(sinceMs)` também deve acusar sujeira
   * ocorrida desde `sinceMs` (aba pública que fechou logo antes).
   */
  setAmbient(fn: (sinceMs: number) => boolean | Promise<boolean>): void {
    this.ambient = fn
  }

  /**
   * O estado do contexto chega do Playwright por CDP e o socket do proxy por TCP: sob carga o byte pode ganhar do evento.
   * Por isso a decisão olha a janela inteira, nos dois sentidos: o contexto precisa estar limpo no início, no fim e em
   * toda amostra entre eles, e nada sujo pode ter acontecido na janela anterior. Sujo em QUALQUER ponto nega; um
   * contexto que só ficou limpo durante a espera (a aba pública fechou) não libera, porque o script que pediu o túnel já rodou.
   */
  private async ambientClean(): Promise<boolean> {
    if (!this.ambient) return false
    const t0 = Date.now()
    const until = t0 + this.ambientGraceMs
    for (;;) {
      if (!(await this.ambient(t0 - this.ambientGraceMs))) return false
      if (Date.now() >= until) return true
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  /** Comparação em tempo constante (hash de tamanho fixo + timingSafeEqual). */
  private authorized(header: string | string[] | undefined): boolean {
    return typeof header === 'string' && timingSafeEqual(sha(header), this.expected)
  }

  private track(s: Socket): void {
    this.sockets.add(s)
    s.setTimeout(this.idleMs, () => s.destroy())
    s.on('error', () => {})
    s.once('close', () => this.sockets.delete(s))
  }

  /** Conecta ao primeiro endereço validado que aceitar. */
  private async dial(ips: string[], port: number): Promise<Socket> {
    let last: unknown
    for (const ip of ips) {
      try {
        const s = await new Promise<Socket>((resolve, reject) => {
          const sock = connect({ host: ip, port })
          this.track(sock)
          sock.once('connect', () => resolve(sock))
          sock.once('error', (e) => {
            sock.destroy()
            reject(e)
          })
        })
        return s
      } catch (err) {
        last = err
      }
    }
    throw last ?? new Error('no address to connect to')
  }

  private async tunnel(target: string, client: Socket, head: Buffer): Promise<void> {
    this.track(client)
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target)
    if (!m) return end(client, '400 Bad Request')
    const port = Number(m[2])
    const verdict = await this.egress.inspect(m[1]!, port)
    if (verdict.reason) {
      this.egress.record(target, verdict.reason)
      client.destroy()
      return
    }
    if (verdict.private && !this.take(tunnelKey(m[1]!, port)) && !(await this.ambientClean())) {
      this.egress.denyOrigin(target, `tunnel to private destination ${target} without a ticket (no origin released it)`)
      client.destroy()
      return
    }
    let upstream: Socket
    try {
      upstream = await this.dial(verdict.ips, port)
    } catch {
      return end(client, '502 Bad Gateway')
    }
    if (client.destroyed) return void upstream.destroy()
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    const port = Number(url.port || 80)
    const verdict = await this.egress.inspect(url.hostname, port)
    if (verdict.reason) {
      this.egress.record(url.href, verdict.reason)
      req.socket.destroy()
      return
    }
    if (verdict.private && !this.take(url.href) && !(isDownloadRequest(req) && (await this.ambientClean()))) {
      this.egress.denyOrigin(url.href, `request to private destination ${url.host} without a ticket (a redirect hop, or no origin released it)`)
      req.socket.destroy()
      return
    }
    const ticketed = verdict.private === true
    const headers: IncomingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v
    // Conecta ao primeiro IP validado que aceitar (`localhost` resolve para ::1 e 127.0.0.1; o servidor pode ouvir só em um).
    let socket: Socket
    try {
      socket = await this.dial(verdict.ips, port)
    } catch {
      res.writeHead(502).end()
      return
    }
    const up = httpRequest({
      // O agente entrega o socket já conectado (`createConnection` solto é ignorado com `agent: false`).
      agent: Object.assign(new Agent(), { createConnection: () => socket }),
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
    })
    up.once('response', (pr) => {
      const out: IncomingHttpHeaders = {}
      for (const [k, v] of Object.entries(pr.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v
      // Privado -> privado da MESMA origem (ou host listado pelo operador), a partir de requisição que tinha bilhete: o salto ganha o seu (login -> dashboard).
      const location = pr.headers.location
      if (ticketed && typeof location === 'string' && (pr.statusCode ?? 0) >= 300 && (pr.statusCode ?? 0) < 400) {
        try {
          const next = new URL(location, url)
          if (this.egress.isPrivateHost(next.hostname)) {
            if (sameOrigin(next, url) || this.egress.isOperatorHost(next.hostname)) this.grant(next.href)
            else this.egress.logInternal(`redirect hop ${url.host} -> ${next.host} denied: private to a different private host (not listed by the operator)`)
          }
        } catch {
          // Location ilegível: o Chromium também não o segue.
        }
      }
      res.writeHead(pr.statusCode ?? 502, pr.statusMessage, out as Record<string, string | string[]>)
      pr.pipe(res)
    })
    up.once('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502).end()
    })
    res.once('close', () => up.destroy())
    req.pipe(up)
  }
}
