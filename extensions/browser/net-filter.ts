// The tabs' network filter on their session (Tether Browser E3, design §4.1 item 1, probe S4 M1): the rules of net-rules.ts
// applied in `session.webRequest`. Electron accepts ONE listener per webRequest event and session, so this filter owns
// `onBeforeRequest`, `onBeforeRedirect`, `onCompleted` and `onErrorOccurred` of the tabs' partition; anything else that needs
// them goes through here.
//
// Electron calls `onBeforeRequest` again for every redirect hop, with the same request id, after `onBeforeRedirect`; the hop
// keeps the original `initiatorOrigin` (absent for a browser-started navigation). The filter keeps, per request id, the last
// address and the grant the chain had, so a hop is judged as a hop (net-rules `decide`). A refused request is cancelled: the
// tab shows Chromium's own error page (net::ERR_BLOCKED_BY_CLIENT), and `onBlocked` gets the tab's page id, the reason and
// the destination reduced to its origin. The log line never carries an address.
//
// E4: behind the filter sits the egress proxy (session.ts), which refuses every connection whose final IP is local unless it
// holds a grant for that exact destination. The filter is where grants come from: a request it lets through to a local IP
// literal or `localhost` (a local origin, a ticket, a same-origin hop) gets one proxy grant, for its exact address (http) or
// host:port (https, ws, wss), one use, a few seconds, revoked when the request ends. A public NAME never gets one, so a name
// that resolves to a local address is refused at the proxy even though the filter passed it (DNS rebinding).
import type { Session } from 'electron'
import { egressGrantUrl } from './local-network-rules.ts'
import { type BlockReason, decide, type Grant, isLocalOrigin, type NetOptions, originOnly, Tickets } from './net-rules.ts'

/** The egress proxy as the filter sees it (EgressProxy.grant/revoke and Egress.isPrivateHost). */
export interface EgressGrants {
  grant(url: string): number | null
  revoke(id: number): void
  isPrivateHost(host: string): boolean
}

export interface BlockedRequest {
  /** The page's webContents id (undefined for a service worker or another request without a page). */
  webContentsId: number | undefined
  reason: BlockReason
  resourceType: string
  /** The destination's origin (`scheme://host:port`) or bare scheme: never the path or the query. */
  destination: string
}

export interface NetFilter {
  /** A ticket for one main-frame navigation of the page `webContentsId` to exactly `url` (one use, a few seconds). */
  allowOnce(webContentsId: number, url: string): boolean
  /** Whether an address or origin is on the local network, as this filter judges it. */
  isLocal(urlOrOrigin: string): boolean
  /** Drops a closed page's tickets. */
  forget(webContentsId: number): void
  /** The E2E's public stand-ins (S4's 127.0.0.2); only the test hook calls it. */
  setPublicStandIns(hosts: readonly string[]): void
  dispose(): void
}

const REASON_TEXT: Record<BlockReason, string> = {
  'scheme': 'esquema não permitido',
  'local-from-public': 'rede local pedida por origem pública',
  'local-redirect': 'redirecionamento para a rede local',
  'local-without-ticket': 'rede local sem bilhete',
}
const CHAIN_MAX = 4_000

export function createNetFilter(ses: Session, egress: EgressGrants, log: (msg: string) => void, onBlocked: (b: BlockedRequest) => void): NetFilter {
  const tickets = new Tickets()
  const opts: { publicStandIns: Set<string> } & NetOptions = { publicStandIns: new Set() }
  /** Per live request id: the address it last asked for and the grant of the chain. */
  const chains = new Map<number, { url: string; grant: Grant; proxyGrants: number[] }>()
  /** Request ids whose next `onBeforeRequest` is a redirect hop (set by `onBeforeRedirect`). */
  const hopping = new Set<number>()
  const revoke = (ids: readonly number[] | undefined): void => { for (const id of ids ?? []) egress.revoke(id) }
  const end = (d: { id: number }): void => { revoke(chains.get(d.id)?.proxyGrants); chains.delete(d.id); hopping.delete(d.id) }

  ses.webRequest.onBeforeRedirect(d => { if (chains.has(d.id)) hopping.add(d.id) })
  ses.webRequest.onCompleted(end)
  ses.webRequest.onErrorOccurred(end)
  ses.webRequest.onBeforeRequest((d, callback) => {
    const prev = hopping.has(d.id) ? chains.get(d.id) : undefined
    hopping.delete(d.id)
    const wc = d.webContentsId
    let verdict
    try {
      verdict = decide({
        url: d.url, resourceType: d.resourceType, method: d.method, initiator: d.initiatorOrigin,
        hop: prev ? { prevUrl: prev.url, grant: prev.grant } : undefined,
        ticket: wc !== undefined && tickets.has(wc, d.url),
      }, opts)
    } catch { verdict = { allow: false as const, reason: 'scheme' as const } }
    if (verdict.allow) {
      if (verdict.useTicket && wc !== undefined) tickets.take(wc, d.url)
      if (chains.size >= CHAIN_MAX) { const oldest = chains.keys().next().value!; revoke(chains.get(oldest)?.proxyGrants); chains.delete(oldest) }
      const proxyGrants = prev?.proxyGrants ?? []
      const forProxy = egressGrantUrl(d.url, egress.isPrivateHost)
      const id = forProxy === null ? null : egress.grant(forProxy)
      chains.set(d.id, { url: d.url, grant: verdict.grant, proxyGrants: id === null ? proxyGrants : [...proxyGrants, id] })
      callback({})
      return
    }
    revoke(prev?.proxyGrants)
    chains.delete(d.id)
    log(`rede: requisição barrada (${REASON_TEXT[verdict.reason]}, ${d.resourceType})`)
    try { onBlocked({ webContentsId: wc, reason: verdict.reason, resourceType: d.resourceType, destination: originOnly(d.url) }) } catch { /* the event is advisory */ }
    callback({ cancel: true })
  })

  let disposed = false
  return {
    allowOnce: (webContentsId, url) => !disposed && tickets.grant(webContentsId, url),
    isLocal: u => isLocalOrigin(u, opts),
    forget: webContentsId => tickets.dropTab(webContentsId),
    setPublicStandIns: hosts => { opts.publicStandIns = new Set(hosts.map(h => h.toLowerCase())) },
    dispose: () => {
      // The filter stays installed: removing it would open the local network to pages that may still exist. Only the
      // tickets go, so nothing new is let through after the extension goes away.
      disposed = true
      for (const [k, c] of [...chains]) { revoke(c.proxyGrants); chains.delete(k) }
      tickets.dropAll()
    },
  }
}
