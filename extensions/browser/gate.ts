// The CDP gatekeeper (Tether Browser E5, design §3.1–§3.2, §12b), part 1: the endpoint the agents' `tether-browser` MCP server
// connects to (the package's adopt mode, with playwright-core's connectOverCDP).
//   - HTTP + WebSocket on 127.0.0.1 only, ephemeral port; `<home>/browser/endpoint.json` ({ v, port, pid, instance }) is
//     rewritten atomically at every opening with a new random instance. Routes: `GET /tether/identity` (no key: the instance),
//     `GET /json/version` (with key: the WebSocket path), the WebSocket. Anything from a browser engine (Origin, Referer,
//     Sec-Fetch-*) or with a non-loopback Host is refused (403); a missing or unknown key is 401; the rest is 404.
//   - The key (`x-tether-key`) names the owner (its slot id): the agent never chooses whose tabs it sees. Keys are read from
//     `<home>/browser/keys/` (gate-keys.ts); a connection whose key was deleted is closed (checked at each message and swept
//     every second).
//   - Browser level is answered here from the tab registry, only ever with the owner's tabs; nothing target-related is
//     forwarded. Page level is forwarded through the tab surface's debugger by the strict list (gate-rules.ts), under session
//     ids the gate makes; events go back only to the session they belong to, in the order the debugger produced them.
// E6 hardened it: refusals named by domain, every network event scrubbed of cookies and credentials (rule 12), input scaled
// (mouse, touch, drag; rule 4), emulation re-applied after a clipped capture and when an agent leaves (rules 3, 5), a hidden
// tab's capture rewritten so it comes back, only http(s) and the blank page navigable, and one lane per session: commands go out
// in the order they came even when one waits (the local-network question, a hidden capture).
// Later slices: E7 adds `Tether.*` and the control state.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { nativeImage } from 'electron'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Surface } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { KeyStore } from './gate-keys.ts'
import {
  BROWSER_ALLOWED, cropRect, dragCarriesFiles, fromBrowser, GateError, type GateSession, hiddenCapture, inputScale, keyOf,
  loopbackHost, navigable, noTarget, PAGE_ALLOWED, refusal, refusalReason, scaleInput, scrubEvent, SessionTable,
} from './gate-rules.ts'
import type { FirstTicket } from './tabs.ts'
import type { TabInfo } from './tab-rules.ts'
import { acceptOf, frame, FrameParser, OP_CLOSE, OP_PONG, OP_TEXT } from './ws-frames.ts'

/** What the gate needs of the tab registry (tabs.ts). */
export interface GateTabs {
  list(): TabInfo[]
  surface(tabId: string): Surface | undefined
  /** The tab that opened `tabId` (a popup), if any. */
  opener?(tabId: string): string | undefined
  create(owner: string, url: string, opts: { ticket?: FirstTicket }): Promise<TabInfo>
  close(tabId: string): void
  requestLocalNetwork(tabId: string, ownerSlotId: string, url: string): Promise<boolean>
  watch(w: { added(info: TabInfo): void; closed(tabId: string): void }): IDisposable
}

export interface GateOptions {
  /** TETHER_HOME: endpoint.json and keys/ live in `<home>/browser`. */
  home: string
  tabs: GateTabs
  log(msg: string): void
  /** How often a deleted key is noticed (ms). */
  keyTtlMs?: number
  /** Test builds only: one line per command, answer and event (method names and ids, never params nor keys). */
  trace?: (line: string) => void
}

export interface Gate extends IDisposable {
  readonly port: number
  readonly instance: string
  /** Live connections by owner (tests and the interface). */
  connections(): { slotId: string }[]
}

const WS_PATH = '/devtools/browser/tether'
/** A capture that never answers (a page that draws no frame) fails instead of holding its session's lane forever. */
const CAPTURE_TIMEOUT_MS = 15_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GateError(`${what}: no answer in ${ms / 1000} s`)), ms) })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

/** A capture's image cropped (device px) and encoded the way it was asked. */
function encodeShot(data: string, plan: ReturnType<typeof hiddenCapture>, format: unknown, quality: unknown): string {
  const { want, got } = plan
  const same = want.x === got.x && want.y === got.y && want.width === got.width && want.height === got.height && want.scale === 1
  if (same && format !== 'jpeg') return data
  let img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  const r = cropRect(want, got, img.getSize().width)
  if (!same) img = img.crop({ x: r.x, y: r.y, width: r.width, height: r.height })
  if (r.outWidth !== r.width || r.outHeight !== r.height) img = img.resize({ width: r.outWidth, height: r.outHeight, quality: 'best' })
  const buf = format === 'jpeg' ? img.toJPEG(typeof quality === 'number' ? quality : 80) : img.toPNG()
  return buf.toString('base64')
}

type Json = Record<string, unknown>

export async function startGate(opts: GateOptions): Promise<Gate> {
  const dir = join(opts.home, 'browser')
  const keys = new KeyStore(join(dir, 'keys'), opts.keyTtlMs ?? 1000)
  const instance = randomBytes(16).toString('hex')
  const sessions = new SessionTable<Conn>()
  const conns = new Set<Conn>()
  /** tabId → the page's own CDP target id (asked once of its debugger). */
  const targetIds = new Map<string, Promise<string>>()
  /** tabId → the subscription to its debugger's messages. */
  const hooked = new Map<string, IDisposable>()
  /** Each page session's lane: the hand-off of the command still waiting (a question, a capture); later ones queue behind it. */
  const lanes = new WeakMap<GateSession<Conn>, Promise<void>>()
  const lane = (s: GateSession<Conn>, run: () => Promise<void> | void, fail: (e: unknown) => void): void => {
    const go = (): Promise<void> | void => { try { return run() } catch (e) { fail(e) } }
    const prev = lanes.get(s)
    const next = prev ? prev.then(go) : go()
    if (!next) return
    const p: Promise<void> = next.catch(() => {}).then(() => { if (lanes.get(s) === p) lanes.delete(s) })
    lanes.set(s, p)
  }
  let port = 0

  const ownedTab = (slotId: string, tabId: string): TabInfo | undefined => {
    const t = opts.tabs.list().find(x => x.tabId === tabId)
    return t && t.ownerSlotId === slotId ? t : undefined
  }
  const targetIdOf = (tabId: string): Promise<string> => {
    let p = targetIds.get(tabId)
    if (!p) {
      const surface = opts.tabs.surface(tabId)
      if (!surface) return Promise.reject(noTarget())
      p = surface.debugger.send('Target.getTargetInfo').then(r => (r as { targetInfo: { targetId: string } }).targetInfo.targetId)
      p.catch(() => targetIds.delete(tabId))
      targetIds.set(tabId, p)
    }
    return p
  }
  const tabOfTarget = async (slotId: string, targetId: unknown): Promise<TabInfo | undefined> => {
    if (typeof targetId !== 'string') return undefined
    for (const t of opts.tabs.list()) {
      if (t.ownerSlotId !== slotId) continue
      if ((await targetIdOf(t.tabId).catch(() => '')) === targetId) return t
    }
    return undefined
  }
  const targetInfoOf = async (t: TabInfo, conn: Conn): Promise<Json> => {
    const wc = opts.tabs.surface(t.tabId)?.webContents
    const alive = wc && !wc.isDestroyed()
    // A popup names its opener, only when the opener is a tab of the same owner (a popup is always the opener's owner's).
    const openerTab = opts.tabs.opener?.(t.tabId)
    const openerId = openerTab !== undefined && ownedTab(t.ownerSlotId, openerTab) ? await targetIdOf(openerTab).catch(() => undefined) : undefined
    return {
      targetId: await targetIdOf(t.tabId), type: 'page', title: alive ? wc.getTitle() : '', url: alive ? wc.getURL() : '',
      attached: true, canAccessOpener: false, browserContextId: conn.contextId, ...(openerId ? { openerId } : {}),
    }
  }

  /** Events of a tab's debugger: queued in a microtask each, so they keep their order relative to the answers (`.then`). */
  const hook = (tabId: string, surface: Surface): void => {
    if (hooked.has(tabId)) return
    hooked.set(tabId, surface.debugger.onMessage((method, params, inner) => {
      if (!inner) return // the core's own root session
      queueMicrotask(() => route(tabId, surface, method, params, inner))
    }))
  }
  const route = (tabId: string, surface: Surface, method: string, params: unknown, inner: string): void => {
    const s = sessions.ofInner(tabId, inner)
    if (!s) return
    let out = params as Json
    if (method === 'Target.attachedToTarget') {
      const child = out.sessionId as string
      const type = (out.targetInfo as Json | undefined)?.type
      // Only the page's own children (out-of-process frames, dedicated workers): a service or shared worker serves every tab
      // of its origin (another agent's too), so it is let go and never announced, like anything else.
      if (type !== 'iframe' && type !== 'worker') {
        surface.debugger.send('Target.detachFromTarget', { sessionId: child }, inner).catch(() => {})
        return
      }
      out = { ...out, sessionId: sessions.add(s.conn, tabId, child, 'child').outer }
    } else if (method === 'Target.detachedFromTarget') {
      const c = sessions.ofInner(tabId, out.sessionId as string)
      if (!c) return
      sessions.remove(c)
      out = { ...out, sessionId: c.outer }
    }
    s.conn.event(method, scrubEvent(method, out), s.outer)
  }

  class Conn {
    readonly socket: Duplex
    readonly slotId: string
    readonly key: string
    readonly contextId = randomBytes(8).toString('hex').toUpperCase()
    readonly browserTargetId = randomBytes(8).toString('hex').toUpperCase()
    readonly browserSessions = new Set<string>()
    readonly attaching = new Map<string, Promise<GateSession<Conn>>>()
    /** Script identifiers this connection registered, by tab (only those it may remove). */
    readonly scripts = new Map<string, Set<string>>()
    readonly touched = new Set<string>()
    autoAttach = false
    discover = false
    closed = false

    constructor(socket: Duplex, slotId: string, key: string) {
      this.socket = socket
      this.slotId = slotId
      this.key = key
    }

    send(obj: Json): void {
      opts.trace?.(`<< ${this.slotId} ${obj.id ?? ''} ${obj.method ?? (obj.error ? 'ERR ' + String((obj.error as Json).message).slice(0, 80) : 'ok')} ${String(obj.sessionId ?? '').slice(0, 6)}`)
      if (!this.closed && !this.socket.destroyed) this.socket.write(frame(OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8')))
    }
    event(method: string, params: unknown, sessionId?: string): void {
      this.send({ method, params, ...(sessionId ? { sessionId } : {}) })
    }
    close(): void {
      if (this.closed) return
      if (!this.socket.destroyed) this.socket.end(frame(OP_CLOSE, Buffer.from([0x03, 0xe8])))
      this.dispose()
    }

    /** Opens a page session on an owned tab and announces it (auto-attach). One per tab per connection. */
    attachTab(t: TabInfo, announce: boolean): Promise<GateSession<Conn>> {
      // Auto-attach announces one session per tab; an explicit attachToTarget (a CDPSession of the client) is always a new one.
      const known = announce ? this.attaching.get(t.tabId) : undefined
      if (known) return known
      const p = (async () => {
        const surface = opts.tabs.surface(t.tabId)
        if (!surface) throw noTarget()
        hook(t.tabId, surface)
        const targetId = await targetIdOf(t.tabId)
        const { sessionId: inner } = await surface.debugger.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string }
        if (this.closed) { surface.debugger.send('Target.detachFromTarget', { sessionId: inner }).catch(() => {}); throw noTarget() }
        const s = sessions.add(this, t.tabId, inner, 'page')
        if (announce) this.event('Target.attachedToTarget', { sessionId: s.outer, targetInfo: await targetInfoOf(t, this), waitingForDebugger: false })
        return s
      })()
      if (announce) {
        this.attaching.set(t.tabId, p)
        p.catch(() => this.attaching.delete(t.tabId))
      }
      return p
    }

    onText(text: string): void {
      let msg: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown }
      try { msg = JSON.parse(text) } catch { return }
      if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return
      const id = msg.id
      const method = msg.method
      const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
      const head = { id, ...(sessionId ? { sessionId } : {}) }
      opts.trace?.(`>> ${this.slotId} ${id} ${method} ${(sessionId ?? '').slice(0, 6)}`)
      const reply = (result: unknown): void => this.send({ ...head, result: result ?? {} })
      const fail = (err: unknown): void => {
        const e = err as { code?: unknown; message?: unknown }
        this.send({ ...head, error: { code: typeof e?.code === 'number' ? e.code : -32000, message: String(e?.message ?? err) } })
      }
      // A deleted key ends the connection, even mid-traffic.
      if (!keys.valid(this.slotId, this.key)) { this.close(); return }
      try {
        if (!sessionId || this.browserSessions.has(sessionId)) {
          this.browserCommand(method, params).then(reply, fail)
          return
        }
        const s = sessions.get(this, sessionId)
        if (!s) throw new GateError('Session with given id not found.', -32001)
        lane(s, () => this.pageCommand(s, method, params, reply, fail), fail)
      } catch (err) {
        fail(err)
      }
    }

    /**
     * Page level: by the strict list. Returns, when the command waits before reaching the debugger, the promise of that
     * hand-off: the session's lane holds the next commands behind it (their order is kept).
     */
    pageCommand(s: GateSession<Conn>, method: string, params: Json, reply: (r: unknown) => void, fail: (e: unknown) => void): Promise<void> | void {
      if (!PAGE_ALLOWED.has(method)) throw refusal(method, refusalReason(method))
      const surface = opts.tabs.surface(s.tabId)
      if (!surface) throw new GateError('Target closed', -32000)
      const send = (m: string, p: Json): Promise<unknown> => surface.debugger.send(m, p, s.inner)
      /** On a hidden tab, `run` with the page drawing (the core's `whileDrawing`); a shown or parked one draws anyway. */
      const drawn = <T>(run: () => Promise<T>): Promise<T> => (surface.state().visibility === 'hidden' ? surface.whileDrawing(run) : run())
      switch (method) {
        case 'Page.bringToFront': return reply({}) // never brings the window forward
        case 'Emulation.setFocusEmulationEnabled':
          if (params.enabled === true) return reply({}) // already on, by the tether
          throw refusal(method, 'focus emulation is the tether\'s')
        case 'Emulation.setDeviceMetricsOverride': throw refusal(method, 'the page size is fixed by the tether (1280x800)')
        case 'Page.reload': {
          if (s.kind !== 'page') throw refusal(method, 'only the tab itself reloads')
          const wc = surface.webContents
          if (params.ignoreCache === true) wc.reloadIgnoringCache()
          else wc.reload()
          return reply({})
        }
        case 'Target.getTargetInfo':
          if (params.targetId !== undefined) {
            return targetIdOf(s.tabId).then(own => {
              if (s.kind !== 'page' || params.targetId !== own) throw noTarget()
              send(method, params).then(reply, fail)
            }).catch(fail)
          }
          break
        case 'Page.navigate': {
          const url = params.url
          if (!navigable(url)) throw refusal(method, 'only http(s) and about:blank')
          if (url !== 'about:blank') {
            // An agent's navigation to a local address asks first (E4); a public one needs nobody. The session's next
            // commands wait in its lane until the navigation is handed to the debugger.
            return opts.tabs.requestLocalNetwork(s.tabId, this.slotId, url).then(ok => {
              if (!ok) throw refusal(method, 'the local network was not allowed')
              send(method, params).then(reply, fail)
            }).catch(fail)
          }
          break
        }
        case 'Page.addScriptToEvaluateOnNewDocument':
          send(method, params).then(r => {
            const ident = (r as { identifier?: unknown })?.identifier
            if (typeof ident === 'string') {
              const set = this.scripts.get(s.tabId) ?? new Set<string>()
              set.add(ident)
              this.scripts.set(s.tabId, set)
            }
            reply(r)
          }, fail)
          return
        case 'Page.removeScriptToEvaluateOnNewDocument': {
          const set = this.scripts.get(s.tabId)
          if (typeof params.identifier !== 'string' || !set?.has(params.identifier)) throw refusal(method, 'not a script of this connection')
          set.delete(params.identifier)
          break
        }
        case 'Input.dispatchDragEvent':
          if (dragCarriesFiles(params)) throw refusal(method, 'files from disk')
          drawn(() => send(method, scaleInput(method, params, inputScale(surface.state())))).then(reply, fail)
          return
        case 'Input.dispatchMouseEvent':
        case 'Input.dispatchTouchEvent':
          // A hidden page handles pointer moves on its frames: without any, each one waits out Chromium's own timeout (~1 s).
          drawn(() => send(method, scaleInput(method, params, inputScale(surface.state())))).then(reply, fail)
          return
        case 'Page.captureScreenshot':
          return this.screenshot(s, surface, params, reply, fail)
      }
      send(method, params).then(reply, fail)
    }

    /**
     * A capture. Clipped or beyond the viewport, it drops the tether's emulation (rule 5): re-applied, always, before the answer
     * goes back. A hidden tab draws no frame for a capture smaller than its viewport: the capture is asked at least that size,
     * beyond the viewport, and cropped back here (never on a shown tab, where the person would see the page resized); and it
     * draws no frame at all unless the core keeps it drawing (`whileDrawing`) while the capture is out.
     */
    screenshot(s: GateSession<Conn>, surface: Surface, params: Json, reply: (r: unknown) => void, fail: (e: unknown) => void): Promise<void> {
      const send = (p: Json): Promise<unknown> => withTimeout(surface.debugger.send('Page.captureScreenshot', p, s.inner), CAPTURE_TIMEOUT_MS, 'Page.captureScreenshot')
      const hidden = surface.state().visibility === 'hidden'
      const resets = hidden || !!params.clip || params.captureBeyondViewport === true
      if (resets) this.touched.add(s.tabId)
      const restore = (): Promise<void> => (resets ? surface.reapplyEmulation().catch(() => {}) : Promise.resolve())
      const shot: Promise<unknown> = !hidden ? send(params) : surface.whileDrawing(async () => {
        const m = await surface.debugger.send('Page.getLayoutMetrics', {}, s.inner) as { cssVisualViewport?: Json; visualViewport?: Json }
        const vv = (m.cssVisualViewport ?? m.visualViewport ?? {}) as { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }
        const plan = hiddenCapture(params, { x: vv.pageX ?? 0, y: vv.pageY ?? 0, width: vv.clientWidth ?? 1280, height: vv.clientHeight ?? 800 })
        const r = await send(plan.request) as { data: string }
        return { data: encodeShot(r.data, plan, params.format, params.quality) }
      })
      return shot.then(r => restore().then(() => reply(r)), e => restore().then(() => fail(e)))
    }

    async browserCommand(method: string, params: Json): Promise<unknown> {
      if (!BROWSER_ALLOWED.has(method)) throw refusal(method, refusalReason(method))
      const mine = (): TabInfo[] => opts.tabs.list().filter(t => t.ownerSlotId === this.slotId)
      switch (method) {
        case 'Browser.getVersion': {
          const wc = mine().map(t => opts.tabs.surface(t.tabId)?.webContents).find(w => w && !w.isDestroyed())
          const chrome = `Chrome/${process.versions.chrome ?? ''}`
          return { protocolVersion: '1.3', product: chrome, revision: '@tether', userAgent: wc?.getUserAgent() ?? chrome, jsVersion: process.versions.v8 }
        }
        case 'Runtime.runIfWaitingForDebugger': return {}
        case 'Browser.setDownloadBehavior': return {} // accepted, no effect yet (downloads are E13)
        case 'Target.setDiscoverTargets': {
          this.discover = params.discover === true
          if (this.discover) for (const t of mine()) this.event('Target.targetCreated', { targetInfo: await targetInfoOf(t, this) })
          return {}
        }
        case 'Target.setAutoAttach': {
          this.autoAttach = params.autoAttach === true
          if (this.autoAttach) await Promise.all(mine().map(t => this.attachTab(t, true)))
          return {}
        }
        case 'Target.getTargets': {
          const infos: Json[] = []
          for (const t of mine()) infos.push(await targetInfoOf(t, this))
          return { targetInfos: infos }
        }
        case 'Target.getTargetInfo': {
          if (params.targetId === undefined || params.targetId === this.browserTargetId) {
            return { targetInfo: { targetId: this.browserTargetId, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } }
          }
          const t = await tabOfTarget(this.slotId, params.targetId)
          if (!t) throw noTarget()
          return { targetInfo: await targetInfoOf(t, this) }
        }
        case 'Target.attachToBrowserTarget': {
          const sessionId = randomBytes(16).toString('hex').toUpperCase()
          this.browserSessions.add(sessionId)
          return { sessionId }
        }
        case 'Target.attachToTarget': {
          if (params.flatten !== true) throw refusal(method, 'only flat sessions')
          const t = await tabOfTarget(this.slotId, params.targetId)
          if (!t) throw noTarget()
          const s = await this.attachTab(t, false)
          return { sessionId: s.outer }
        }
        case 'Target.detachFromTarget': {
          const id = params.sessionId
          if (typeof id === 'string' && this.browserSessions.delete(id)) return {}
          const s = typeof id === 'string' ? sessions.get(this, id) : undefined
          if (!s || s.kind !== 'page') throw new GateError('No session with given id', -32602)
          this.drop(s)
          return {}
        }
        case 'Target.createTarget': {
          const url = typeof params.url === 'string' && params.url !== '' ? params.url : 'about:blank'
          if (!navigable(url)) throw refusal(method, 'only http(s) and about:blank')
          // The agent's request: a local address goes to the local-network question before the tab loads it.
          const t = await opts.tabs.create(this.slotId, url, { ticket: true })
          const targetId = await targetIdOf(t.tabId)
          if (this.autoAttach) await this.attachTab(t, true)
          return { targetId }
        }
        case 'Target.closeTarget': {
          // Decision 22: an explicit close by the agent is allowed, on its own tab only.
          const t = await tabOfTarget(this.slotId, params.targetId)
          if (!t) throw noTarget()
          opts.tabs.close(t.tabId)
          return { success: true }
        }
      }
      throw refusal(method, 'not on the browser-level list')
    }

    /** Lets go of one page session (and its children) of this connection. */
    drop(s: GateSession<Conn>): void {
      for (const c of sessions.of(this, s.tabId)) if (c.kind === 'child') sessions.remove(c)
      sessions.remove(s)
      this.attaching.get(s.tabId)?.then(a => { if (a === s) this.attaching.delete(s.tabId) }, () => {})
      this.touched.add(s.tabId)
      opts.tabs.surface(s.tabId)?.debugger.send('Target.detachFromTarget', { sessionId: s.inner }).catch(() => {})
    }

    tabAdded(t: TabInfo): void {
      if (t.ownerSlotId !== this.slotId || this.closed) return
      if (this.discover) targetInfoOf(t, this).then(info => this.event('Target.targetCreated', { targetInfo: info }), () => {})
      if (this.autoAttach) this.attachTab(t, true).catch(e => opts.log(`porteiro: guia ${t.tabId} não anexada (${(e as Error).message})`))
    }

    tabClosed(tabId: string, targetId: string | undefined): void {
      let mineTab = false
      for (const s of sessions.of(this, tabId)) {
        sessions.remove(s)
        mineTab = true
        if (s.kind === 'page') this.event('Target.detachedFromTarget', { sessionId: s.outer, ...(targetId ? { targetId } : {}) })
      }
      this.attaching.delete(tabId)
      this.scripts.delete(tabId)
      this.touched.delete(tabId)
      if ((mineTab || this.discover) && targetId) this.event('Target.targetDestroyed', { targetId })
    }

    dispose(): void {
      if (this.closed) return
      this.closed = true
      conns.delete(this)
      for (const s of sessions.of(this)) {
        sessions.remove(s)
        if (s.kind === 'page') {
          this.touched.add(s.tabId)
          opts.tabs.surface(s.tabId)?.debugger.send('Target.detachFromTarget', { sessionId: s.inner }).catch(() => {})
        }
      }
      // Whatever the agent did to the page's emulation, the tether's recipe comes back when it leaves.
      for (const tabId of this.touched) opts.tabs.surface(tabId)?.reapplyEmulation().catch(() => {})
      if (!this.socket.destroyed) this.socket.destroy()
    }
  }

  const watcher = opts.tabs.watch({
    added: info => { for (const c of conns) c.tabAdded(info) },
    closed: tabId => {
      const known = targetIds.get(tabId)
      targetIds.delete(tabId)
      hooked.get(tabId)?.dispose()
      hooked.delete(tabId)
      const notify = (targetId: string | undefined): void => { for (const c of [...conns]) c.tabClosed(tabId, targetId) }
      if (known) known.then(notify, () => notify(undefined))
      else notify(undefined)
    },
  })

  /** The common checks of every request: not from a browser engine, loopback Host. Returns the HTTP status to refuse with. */
  const refusedStatus = (req: IncomingMessage): number => (fromBrowser(req.headers) || !loopbackHost(req.headers.host, port) ? 403 : 0)
  const ownerOf = (req: IncomingMessage): { slotId: string; key: string } | undefined => {
    const key = keyOf(req.headers)
    const slotId = key && keys.owner(key)
    return key && slotId ? { slotId, key } : undefined
  }
  const answer = (res: ServerResponse, status: number, body?: Json): void => {
    if (body) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
    else res.writeHead(status).end()
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const status = refusedStatus(req)
    if (status) return answer(res, status)
    if (req.method !== 'GET') return answer(res, 405)
    if (path === '/tether/identity') return answer(res, 200, { instance })
    if (!ownerOf(req)) return answer(res, 401)
    if (path === '/json/version' || path === '/json/version/') {
      return answer(res, 200, { Browser: `Chrome/${process.versions.chrome ?? ''}`, 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}${WS_PATH}` })
    }
    answer(res, 404)
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    socket.on('error', () => {})
    const deny = (status: number, text: string): void => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`) }
    const status = refusedStatus(req)
    if (status) return deny(status, 'Forbidden')
    const who = ownerOf(req)
    if (!who) return deny(401, 'Unauthorized')
    if ((req.url ?? '') !== WS_PATH) return deny(404, 'Not Found')
    const accept = acceptOf(req.headers['sec-websocket-key'])
    if (!accept || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return deny(400, 'Bad Request')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const conn = new Conn(socket, who.slotId, who.key)
    conns.add(conn)
    const parser = new FrameParser({
      text: t => conn.onText(t),
      ping: p => { if (!socket.destroyed) socket.write(frame(OP_PONG, p)) },
      close: () => conn.close(),
      error: () => conn.dispose(),
    })
    socket.on('data', (chunk: Buffer) => parser.push(chunk))
    socket.on('close', () => conn.dispose())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  port = (server.address() as AddressInfo).port

  // endpoint.json, atomically (temp file + rename): the MCP server reads it at every connection.
  mkdirSync(dir, { recursive: true })
  const endpointFile = join(dir, 'endpoint.json')
  const tmp = `${endpointFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, port, pid: process.pid, instance }))
  renameSync(tmp, endpointFile)
  opts.log(`porteiro em 127.0.0.1:${port}`)

  // Deleted keys: live connections are swept on the key store's clock.
  const sweep = setInterval(() => {
    for (const c of [...conns]) if (!keys.valid(c.slotId, c.key)) c.close()
  }, opts.keyTtlMs ?? 1000)
  sweep.unref()

  return {
    port,
    instance,
    connections: () => [...conns].map(c => ({ slotId: c.slotId })),
    dispose: () => {
      clearInterval(sweep)
      watcher.dispose()
      for (const c of [...conns]) c.close()
      for (const h of hooked.values()) h.dispose()
      hooked.clear()
      server.close()
      server.closeAllConnections()
      try {
        const cur = JSON.parse(readFileSync(endpointFile, 'utf8')) as { instance?: unknown }
        if (cur.instance === instance) rmSync(endpointFile, { force: true })
      } catch { /* already gone */ }
    },
  }
}
