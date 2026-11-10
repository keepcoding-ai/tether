// The tabs' egress proxy (Tether Browser E4, design §4.1 item 2, probe S4 M2): the package's EgressProxy (egress/, a copy)
// on loopback, an ephemeral port, started with the tabs' session and closed with it. The partition points at it with
// `session.setProxy` and `<-loopback>` (Chromium's built-in exception for loopback and link-local is removed: those are
// exactly what the policy must see), so every TCP connection of every tab — navigation, sub-resource, WebSocket, service
// worker, each redirect hop — goes through it. The proxy resolves the name once, refuses a connection whose final IP is local
// unless it holds a grant from the filter for that exact destination, and dials the validated IP (no second resolution: DNS
// rebinding is closed). With a proxy, Chromium uses no QUIC and removes `window.WebTransport` (S4 case 8b); WebRTC is held by
// `disable_non_proxied_udp` (session.ts): no UDP leaves a tab.
//
// The policy (TAB_EGRESS_POLICY, local-network-rules.ts) lists every local range and `localhost`, so a grant can open them,
// and every port; a NAME that resolves to a local address stays refused, granted or not (`.local`, intranet names: use the IP).
// The proxy's credential (a random password per start) is answered on Electron's `login` event only for our proxy's
// host:port; the proxy refuses anything without it (another process on the machine cannot use it as a door into loopback).
import { app, type Session } from 'electron'
import { lookup } from 'node:dns/promises'
import { Egress } from './egress/egress.ts'
import { EgressProxy } from './egress/egress-proxy.ts'
import { TAB_EGRESS_POLICY } from './local-network-rules.ts'
import type { EgressGrants } from './net-filter.ts'

export type Resolve = (host: string) => Promise<string[]>

const systemResolve: Resolve = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address)

export interface TabEgress extends EgressGrants {
  /** `127.0.0.1:<port>`. */
  readonly address: string
  /** How many connections the proxy refused so far (the reasons stay inside it; never the address in the log). */
  blockedCount(): number
  /** E2E only (the test hook): names resolved by the test instead of the system, so no lookup leaves the machine. */
  setTestResolver(resolve: Resolve | undefined): void
  close(): Promise<void>
}

export async function startTabEgress(ses: Session): Promise<TabEgress> {
  let testResolve: Resolve | undefined
  const egress = new Egress(TAB_EGRESS_POLICY, host => (testResolve ?? systemResolve)(host))
  const proxy = await EgressProxy.start(egress)
  const { hostname, port } = new URL(proxy.server)
  const onLogin = (e: Electron.Event, _wc: unknown, _details: unknown, info: Electron.AuthInfo, callback: (user?: string, pass?: string) => void): void => {
    if (!info.isProxy || info.host !== hostname || String(info.port) !== port) return
    e.preventDefault()
    callback(proxy.username, proxy.password)
  }
  app.on('login', onLogin as never)
  try {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `${hostname}:${port}`, proxyBypassRules: '<-loopback>' })
    await ses.closeAllConnections()
  } catch (e) {
    app.removeListener('login', onLogin as never)
    await proxy.close()
    throw e
  }
  let closed = false
  return {
    address: `${hostname}:${port}`,
    grant: url => (closed ? null : proxy.grant(url)),
    revoke: id => proxy.revoke(id),
    isPrivateHost: host => egress.isPrivateHost(host),
    blockedCount: () => egress.blocks.length === 0 ? 0 : egress.blocks[egress.blocks.length - 1]!.seq,
    setTestResolver: r => { testResolve = r },
    close: async () => {
      if (closed) return
      closed = true
      // The partition keeps pointing at the closed port: every request fails (the closed side) instead of going direct.
      app.removeListener('login', onLogin as never)
      await proxy.close()
    },
  }
}
