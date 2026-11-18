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
// E7: the control channel `Tether.*` (browser level, design §3.3) and the control state: outside `agent` every command of the
// agent on that tab is refused with a named error (TAB_WITH_USER, TAB_PAUSED) and every event of it is dropped (rule 14:
// refusing commands alone lets the form's POST with the password reach the agent); `Tether.tabStateChanged` goes to the owner's
// browser sessions at each change. `cleanTab` removes the scripts the agents registered on a tab (the clean hand-off).
// MCP inside the daemon: `Tether.tabHandle` / `Tether.setActiveTab` give the agent's tool the id it calls each tab by and which
// one is active, kept with the tab (agent-tabs.ts), so a new server over the same tabs names them as before.
// E7b: auto-attach forwarded with the gate's filter (frames and dedicated workers only): a page's service worker is never
// attached, so it is never announced and never detached (detaching one crashed Electron's main process).
// E7c (the gatekeeper's security review): leaving `agent`, every command of the tab still waiting for its answer is answered at
// once with the held error and its late answer is dropped (H1b: nothing produced in the person's turn reaches the agent); the
// page's stored console and log are discarded when the tab leaves the agent and again when it comes back (H2: `Runtime.enable`
// and `Log.enable` replay them); a connection whose client stops reading is closed past a write ceiling (M2); a capture's clip
// is bounded before anything is drawn or decoded (M3); `<home>/browser` is the owner's alone (M4, private-dir.ts).
// E13 (files, review M1): `Tether.confirmUpload` asks the person (upload-consent.ts) and a yes is a grant for ONE attach on that tab
// into a frame of the origin asked, for a few seconds. The package's attach (playwright-core's `Runtime.callFunctionOn` that hands
// the files to the input, files-rules.ts `attachCarriesFiles`) goes out only under a fresh grant, after the gate read the origin
// of the frame it lands in (in that same object's context, just before forwarding); otherwise it is refused. The agent's own
// JavaScript that builds a file some other way is not recognised: the disk read stays in the agent's process, under the
// package's folder rule. Downloads (downloads.ts) reach the owner's connections as `Browser.downloadWillBegin` /
// `Browser.downloadProgress` with the final name and size (never the path), only while the agent has the tab.
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { nativeImage } from 'electron'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Surface } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { writeAtomicRetry } from './atomic-file.ts'
import { KeyStore } from './gate-keys.ts'
import { connectionQuestionKey, questionTabOf } from './local-network-rules.ts'
import {
  autoAttachParams, BROWSER_ALLOWED, captureTooLarge, childDisposal, cropRect, dragCarriesFiles, fromBrowser, GateError, type GateSession, hiddenCapture,
  inputScale, keyOf, loopbackHost, navigable, noTarget, PAGE_ALLOWED, refusal, refusalReason, scaleInput, scrubEvent, SessionTable, WRITE_CEILING,
} from './gate-rules.ts'
import { ensurePrivateDir } from './private-dir.ts'
import type { FirstTicket } from './tabs.ts'
import type { TabInfo } from './tab-rules.ts'
import { checkAsk, type Control, heldError } from './control-rules.ts'
import type { ControlHub } from './control.ts'
import { acceptOf, frame, FrameParser, OP_CLOSE, OP_PONG, OP_TEXT } from './ws-frames.ts'
import { actionKindOf, type ActionKind } from './pad-rules.ts'
import type { DownloadEvent } from './downloads.ts'
import { attachCarriesFiles, attachRefusal, UPLOAD_GRANT_MS, type UploadGrant } from './files-rules.ts'

/** What the gate needs of the tab registry (tabs.ts). */
export interface GateTabs {
  list(): TabInfo[]
  surface(tabId: string): Surface | undefined
  /** The tab that opened `tabId` (a popup), if any. */
  opener?(tabId: string): string | undefined
  create(owner: string, url: string, opts: { ticket?: FirstTicket }): Promise<TabInfo>
  close(tabId: string): void
  requestLocalNetwork(tabId: string, ownerSlotId: string, url: string): Promise<boolean>
  /** The same question for an agent with no tab: filed under `questionKey` (no ticket; the tab is created afterwards). */
  requestLocalNetworkNoTab(questionKey: string, ownerSlotId: string, url: string): Promise<boolean>
  /** Refuses and withdraws the questions filed under `questionKey` (the connection that asked went away). */
  cancelQuestions(questionKey: string): void
  /** One ticket for `url` on the tab without asking: only after the person allowed it through `Tether.requestLocalNetwork`. */
  grantLocal?(tabId: string, url: string): Promise<boolean>
  watch(w: { added(info: TabInfo): void; closed(tabId: string): void }): IDisposable
}

export interface GateOptions {
  /** TETHER_HOME: endpoint.json and keys/ live in `<home>/browser`. */
  home: string
  tabs: GateTabs
  log(msg: string): void
  /** How often a deleted key is noticed (ms). */
  keyTtlMs?: number
  /** Who has each tab (E7). Without it every tab is the agent's and `Tether.*` is unknown. */
  control?: Pick<ControlHub, 'control' | 'view' | 'onChange' | 'openAsks' | 'ask'>
  /** E13: the person's answer to an upload (`Tether.confirmUpload`); without it every upload is refused. */
  confirmUpload?: (req: { tabId: string; slotId: string; path: string; frameOrigin: string }) => Promise<boolean>
  /**
   * What an agent's tool knows each tab by, kept with the tab (agent-tabs.ts): `Tether.tabHandle` and `Tether.setActiveTab`.
   * Without it the gate does not know those two (the tool numbers the tabs itself).
   */
  agentTabs?: { handle(owner: string, tabId: string): { handle: string; active: boolean }; setActive(owner: string, tabId: string): void; forget(tabId: string): void }
  /** E9: the agent's command reached a tab it has (the tab's "agent acting" dot). E11: and the coarse kind of it ("typing"), nothing of the command's content. */
  activity?: (tabId: string, kind: ActionKind) => void
  /** Test builds only: one line per command, answer and event (method names and ids, never params nor keys). */
  trace?: (line: string) => void
  /** M2: the bytes a connection may have waiting in its socket before it is closed (tests lower it). */
  writeCeiling?: number
}

export interface Gate extends IDisposable {
  readonly port: number
  readonly instance: string
  /** Live connections by owner (tests and the interface). */
  connections(): { slotId: string }[]
  /** Removes, on every agent session of the tab, the scripts that session's connection registered (the clean hand-off). */
  cleanTab(tabId: string): Promise<number>
  /** E13: a download of a tab, told to its owner's connections that asked for download events. */
  download(e: DownloadEvent): void
}

const WS_PATH = '/devtools/browser/tether'
/** How long a local address the person allowed through `Tether.requestLocalNetwork` waits for the navigation that uses it. */
const PRE_ALLOWED_MS = 30_000
/** A capture that never answers (a page that draws no frame) fails instead of holding its session's lane forever. */
const CAPTURE_TIMEOUT_MS = 15_000
/** Reads, in the context of the object an attach is called on, the origin of the frame it belongs to. */
const FRAME_ORIGIN_FN = "function () { try { const o = window.origin; if (o && o !== 'null') return o } catch (e) {} return location.origin }"

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
  const controlOf = (tabId: string): Control => opts.control?.control(tabId) ?? 'agent'
  /** Tabs whose events were dropped while held: the agent's view of them is stale until resynced. */
  const heldTabs = new Set<string>()
  /**
   * A held tab back with the agent: its client missed the page's events (a reload, a navigation), so its execution contexts are
   * dead ids. Each page session is told its contexts are gone and Runtime is restarted, which makes Chromium announce the live
   * ones; in the session's lane, so the agent's next commands wait for it.
   */
  /**
   * H2: Chromium keeps the page's console messages (V8, per context group) and log entries (Blink) and replays them at every
   * `Runtime.enable` / `Log.enable`, the resync's and a new session's alike. Discarded on the core's own session (not an
   * agent's): when the tab leaves the agent (what the agent already saw goes) and again when it comes back (what the person's
   * turn left goes), before any agent session can enable anything.
   */
  const discardStored = (tabId: string): void => {
    const surface = opts.tabs.surface(tabId)
    if (!surface || surface.webContents.isDestroyed()) return
    surface.debugger.send('Runtime.discardConsoleEntries').catch(() => {})
    surface.debugger.send('Log.clear').catch(() => {})
  }
  const resync = (tabId: string): void => {
    if (!heldTabs.delete(tabId)) return
    const surface = opts.tabs.surface(tabId)
    if (!surface) return
    for (const c of conns) {
      for (const s of sessions.of(c, tabId)) {
        if (s.kind !== 'page') continue
        lane(s, async () => {
          c.event('Runtime.executionContextsCleared', {}, s.outer)
          await surface.debugger.send('Runtime.disable', {}, s.inner).catch(() => {})
          await surface.debugger.send('Runtime.enable', {}, s.inner).catch(() => {})
        }, () => {})
      }
    }
  }

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
    const agentHasTab = controlOf(tabId) === 'agent'
    if (method === 'Target.attachedToTarget') {
      // Only the page's own children (out-of-process frames, dedicated workers) are announced, and only while the agent has
      // the tab (rule 14). Anything else is let go: detached, or released when it is a worker of the origin (gate-rules,
      // CHILD_TARGETS: detaching a service worker's session crashes Electron's main process).
      const child = out.sessionId as string
      const disposal = childDisposal((out.targetInfo as Json | undefined)?.type, agentHasTab)
      if (disposal === 'detach') surface.debugger.send('Target.detachFromTarget', { sessionId: child }, inner).catch(() => {})
      else if (disposal === 'release' && out.waitingForDebugger === true) surface.debugger.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {})
      if (disposal !== 'announce') {
        if (!agentHasTab) { heldTabs.add(tabId); opts.trace?.(`-- held ${s.conn.slotId} ${method}`) }
        return
      }
      out = { ...out, sessionId: sessions.add(s.conn, tabId, child, 'child').outer }
    } else if (!agentHasTab) {
      // Rule 14: nothing of the page reaches the agent while it does not have the tab; a child that leaves is forgotten.
      if (method === 'Target.detachedFromTarget') { const c = sessions.ofInner(tabId, out.sessionId as string); if (c) sessions.remove(c) }
      heldTabs.add(tabId)
      opts.trace?.(`-- held ${s.conn.slotId} ${method}`)
      return
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
    /** Open `Tether.askUser` requests: the agent leaving gives them up. */
    readonly asks = new Set<() => void>()
    /** Local addresses the person allowed through `Tether.requestLocalNetwork`, waiting for their navigation (url → until). */
    readonly preAllowed = new Map<string, number>()
    /** H1b: page commands not answered yet, by tab; leaving `agent` answers them with the held error. */
    readonly inflight = new Map<string, Set<(e: GateError) => void>>()
    /** E13: the person's yes to an upload, by tab: one attach into a frame of that origin, before it runs out. */
    readonly uploadGrants = new Map<string, UploadGrant>()
    /** E13: `Browser.setDownloadBehavior` with events on; the downloads announced to it. */
    downloadEvents = false
    readonly downloads = new Set<string>()
    /** The tab of the last page command (what `Tether.requestLocalNetwork` without a target is about). */
    lastTab: string | undefined
    autoAttach = false
    discover = false
    closed = false
    /** Where this connection's local-network questions are filed when it has no tab (withdrawn when it goes). */
    readonly questionKey: string

    constructor(socket: Duplex, slotId: string, key: string) {
      this.socket = socket
      this.slotId = slotId
      this.questionKey = connectionQuestionKey(slotId, randomBytes(4).toString('hex'))
      this.key = key
    }

    send(obj: Json): void {
      opts.trace?.(`<< ${this.slotId} ${obj.id ?? ''} ${obj.method ?? (obj.error ? 'ERR ' + String((obj.error as Json).message).slice(0, 80) : 'ok')} ${String(obj.sessionId ?? '').slice(0, 6)}`)
      if (this.closed || this.socket.destroyed) return
      this.socket.write(frame(OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8')))
      // M2: a client that stops reading (stuck, suspended) would pile the page's events up in the main process.
      const waiting = (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0
      if (waiting > (opts.writeCeiling ?? WRITE_CEILING)) {
        opts.log(`porteiro: conexão de ${this.slotId} fechada (cliente não lê: ${Math.round(waiting / 1048576)} MB parados)`)
        this.dispose()
      }
    }
    event(method: string, params: unknown, sessionId?: string): void {
      this.send({ method, params, ...(sessionId ? { sessionId } : {}) })
    }
    /** An event of the browser level: the root of the connection and every browser session it attached (the package listens on the latter). */
    browserEvent(method: string, params: unknown): void {
      this.event(method, params)
      for (const bs of this.browserSessions) this.event(method, params, bs)
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
      const c = controlOf(s.tabId)
      if (c !== 'agent') throw new GateError(heldError(c).message, -32000, true)
      // H1b: one answer per command, and none produced after the tab left the agent (`cutInflight` answers first).
      let answered = false
      const pending = this.inflight.get(s.tabId) ?? new Set<(e: GateError) => void>()
      this.inflight.set(s.tabId, pending)
      const once = <A>(f: (a: A) => void) => (a: A): void => {
        if (answered) return
        answered = true
        pending.delete(cut)
        f(a)
      }
      const cut = once<GateError>(fail)
      pending.add(cut)
      const ok = once<unknown>(reply)
      const ko = once<unknown>(fail)
      try {
        const out = this.pageCommandHeld(s, method, params, ok, ko)
        return out ? out.catch(ko) : out
      } catch (e) {
        ko(e)
      }
    }

    /** Answers every command of the tab still waiting with the held error; their late answers are dropped (H1b). */
    cutInflight(tabId: string, c: Exclude<Control, 'agent'>): void {
      const pending = this.inflight.get(tabId)
      if (!pending) return
      this.inflight.delete(tabId)
      for (const cut of [...pending]) cut(new GateError(heldError(c).message, -32000, true))
    }

    /** `pageCommand` once the tab is the agent's and the answer is guarded. */
    pageCommandHeld(s: GateSession<Conn>, method: string, params: Json, reply: (r: unknown) => void, fail: (e: unknown) => void): Promise<void> | void {
      this.lastTab = s.tabId
      opts.activity?.(s.tabId, actionKindOf(method, params.type))
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
        case 'Target.setAutoAttach':
          // Only frames and dedicated workers are ever attached (gate-rules, CHILD_TARGETS): a service worker never reaches the
          // tab's debugger, so it is never announced and never detached.
          send(method, autoAttachParams(params)).then(reply, fail)
          return
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
          // B1: after a wait (the person's answer) the navigation goes out only if the connection is alive and the tab still the agent's.
          const still = (): void => {
            if (this.closed) throw new GateError('Target closed', -32000)
            const now = controlOf(s.tabId)
            if (now !== 'agent') throw new GateError(heldError(now).message, -32000, true)
          }
          if (url !== 'about:blank' && opts.tabs.grantLocal && this.takeAllowed(url)) {
            // The person already said yes to this address (`Tether.requestLocalNetwork`): not asked twice.
            return opts.tabs.grantLocal(s.tabId, url).then(() => { still(); send(method, params).then(reply, fail) }).catch(fail)
          }
          if (url !== 'about:blank') {
            // An agent's navigation to a local address asks first (E4); a public one needs nobody. The session's next
            // commands wait in its lane until the navigation is handed to the debugger.
            return opts.tabs.requestLocalNetwork(s.tabId, this.slotId, url).then(ok => {
              if (!ok) throw refusal(method, 'the local network was not allowed')
              still()
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
        case 'Page.captureScreenshot': {
          const tooLarge = captureTooLarge(params)
          if (tooLarge) throw refusal(method, tooLarge)
          return this.screenshot(s, surface, params, reply, fail)
        }
        case 'Runtime.callFunctionOn':
          if (attachCarriesFiles(params)) return this.attach(s, params, send, reply, fail)
          break
        case 'Page.createIsolatedWorld':
          // N7: a world that ignores CORS with the partition's cookies is never granted.
          send(method, { ...params, grantUniveralAccess: false }).then(reply, fail)
          return
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

    /**
     * The package's file attach (review M1): it goes out only under the person's fresh grant for this tab (used once), and only
     * when the frame it lands in, read now in the same object's context, is of the origin she was shown. A frame that navigated
     * meanwhile has a new context: the object is gone and the read fails, so nothing is attached.
     */
    async attach(s: GateSession<Conn>, params: Json, send: (m: string, p: Json) => Promise<unknown>, reply: (r: unknown) => void, fail: (e: unknown) => void): Promise<void> {
      const grant = this.uploadGrants.get(s.tabId)
      this.uploadGrants.delete(s.tabId)
      const where: Json = typeof params.objectId === 'string' ? { objectId: params.objectId } : typeof params.executionContextId === 'number' ? { executionContextId: params.executionContextId } : {}
      let origin: string | undefined
      if (grant && Object.keys(where).length > 0) {
        const r = await send('Runtime.callFunctionOn', { ...where, functionDeclaration: FRAME_ORIGIN_FN, returnByValue: true }).catch(() => undefined) as { result?: { value?: unknown } } | undefined
        if (typeof r?.result?.value === 'string') origin = r.result.value
      }
      const why = attachRefusal(grant, origin, Date.now())
      if (why) {
        opts.log(`porteiro: anexo de arquivo recusado na guia ${s.tabId} (${why})`)
        fail(refusal('Runtime.callFunctionOn', `file attach refused: ${why}`))
        return
      }
      opts.log(`porteiro: anexo de arquivo permitido na guia ${s.tabId}`)
      send('Runtime.callFunctionOn', params).then(reply, fail)
    }

    /** Consumes the person's yes to `url`, if still fresh. */
    takeAllowed(url: string): boolean {
      const until = this.preAllowed.get(url)
      this.preAllowed.delete(url)
      return until !== undefined && until >= Date.now()
    }

    /** The `Tether.*` domain (README of the package, "Canal de controle"). */
    async tetherCommand(method: string, params: Json): Promise<unknown> {
      const control = opts.control
      if (!control) throw new GateError(`'${method}' wasn't found`, -32601)
      const tabOf = async (): Promise<TabInfo> => {
        const t = await tabOfTarget(this.slotId, params.targetId)
        if (!t) throw noTarget()
        return t
      }
      switch (method) {
        case 'Tether.getTabState': {
          const v = control.view((await tabOf()).tabId)
          return { control: v.control, ...(v.reason ? { reason: v.reason } : {}) }
        }
        case 'Tether.askUser': {
          const t = await tabOf()
          const input = checkAsk(params, control.openAsks(t.tabId, this.slotId))
          if (typeof input === 'string') throw new GateError(`Tether.askUser: ${input}`, -32602)
          const req = control.ask(t.tabId, this.slotId, input)
          this.asks.add(req.cancel)
          try { return { outcome: await req.outcome } } finally { this.asks.delete(req.cancel) }
        }
        case 'Tether.confirmUpload': {
          const t = await tabOf()
          if (typeof params.path !== 'string' || params.path === '') throw new GateError('Tether.confirmUpload: a path is needed', -32602)
          // The site that owns the field is what the person decides on: without it there is nothing to show her.
          if (typeof params.frameUrl !== 'string' || params.frameUrl === '') return { allowed: false }
          if (controlOf(t.tabId) !== 'agent' || !opts.confirmUpload) return { allowed: false }
          this.uploadGrants.delete(t.tabId)
          const allowed = await opts.confirmUpload({ tabId: t.tabId, slotId: this.slotId, path: params.path, frameOrigin: params.frameUrl })
          // The answer counts only if the agent is still here and still has the tab (the person may have taken it meanwhile).
          if (!allowed || this.closed || controlOf(t.tabId) !== 'agent') return { allowed: false }
          this.uploadGrants.set(t.tabId, { origin: params.frameUrl, until: Date.now() + UPLOAD_GRANT_MS })
          return { allowed: true }
        }
        case 'Tether.tabHandle': {
          if (!opts.agentTabs) break
          // Answered whoever has the tab: it reads nothing of the page, only what the tether keeps with the tab.
          const h = opts.agentTabs.handle(this.slotId, (await tabOf()).tabId)
          return { handle: h.handle, ...(h.active ? { active: true } : {}) }
        }
        case 'Tether.setActiveTab': {
          if (!opts.agentTabs) break
          opts.agentTabs.setActive(this.slotId, (await tabOf()).tabId)
          return {}
        }
        case 'Tether.requestLocalNetwork': {
          const url = params.url
          if (typeof url !== 'string' || !navigable(url) || url === 'about:blank') return { allowed: false }
          const mine = opts.tabs.list().filter(x => x.ownerSlotId === this.slotId)
          const named = params.targetId !== undefined ? await tabOfTarget(this.slotId, params.targetId) : undefined
          // No tab (the last one closed, or `new_tab` as the first move): the question is still asked, under this connection.
          const tabId = questionTabOf(mine, named, this.lastTab)
          const allowed = tabId === undefined
            ? await opts.tabs.requestLocalNetworkNoTab(this.questionKey, this.slotId, url)
            : await opts.tabs.requestLocalNetwork(tabId, this.slotId, url)
          if (this.closed) return { allowed: false }
          if (allowed) this.preAllowed.set(url, Date.now() + PRE_ALLOWED_MS)
          return { allowed }
        }
      }
      throw new GateError(`'${method}' wasn't found`, -32601)
    }

    /** `Tether.tabStateChanged` on every browser session of this connection. */
    stateChanged(targetId: string, control: Control, reason: string | undefined): void {
      for (const bs of this.browserSessions) this.event('Tether.tabStateChanged', { targetId, control, ...(reason ? { reason } : {}) }, bs)
    }

    async browserCommand(method: string, params: Json): Promise<unknown> {
      if (method.startsWith('Tether.')) return this.tetherCommand(method, params)
      if (!BROWSER_ALLOWED.has(method)) throw refusal(method, refusalReason(method))
      const mine = (): TabInfo[] => opts.tabs.list().filter(t => t.ownerSlotId === this.slotId)
      switch (method) {
        case 'Browser.getVersion': {
          const wc = mine().map(t => opts.tabs.surface(t.tabId)?.webContents).find(w => w && !w.isDestroyed())
          const chrome = `Chrome/${process.versions.chrome ?? ''}`
          return { protocolVersion: '1.3', product: chrome, revision: '@tether', userAgent: wc?.getUserAgent() ?? chrome, jsVersion: process.versions.v8 }
        }
        case 'Runtime.runIfWaitingForDebugger': return {}
        // The tether decides where downloads land (downloads.ts); events on means the client wants to hear of them.
        case 'Browser.setDownloadBehavior': this.downloadEvents = params.eventsEnabled === true; return {}
        // The package's adopt mode cancels every download it cannot save itself; the agent's copy is the tether's and stays.
        case 'Browser.cancelDownload': return {}
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
          const t = await opts.tabs.create(this.slotId, url, { ticket: url !== 'about:blank' && this.takeAllowed(url) ? 'granted' : true })
          const targetId = await targetIdOf(t.tabId)
          if (this.autoAttach) await this.attachTab(t, true)
          return { targetId }
        }
        case 'Target.closeTarget': {
          // Decision 22: an explicit close by the agent is allowed, on its own tab only.
          const t = await tabOfTarget(this.slotId, params.targetId)
          if (!t) throw noTarget()
          const c = controlOf(t.tabId)
          if (c !== 'agent') throw new GateError(heldError(c).message, -32000, true)
          opts.agentTabs?.forget(t.tabId)
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
      this.uploadGrants.delete(tabId)
      this.scripts.delete(tabId)
      this.touched.delete(tabId)
      if ((mineTab || this.discover) && targetId) this.event('Target.targetDestroyed', { targetId })
    }

    dispose(): void {
      if (this.closed) return
      this.closed = true
      conns.delete(this)
      for (const cancel of [...this.asks]) cancel() // the agent gave up its requests
      opts.tabs.cancelQuestions(this.questionKey)
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

  const controlSub = opts.control?.onChange(v => {
    // H1b, H2: leaving the agent, what is in flight is answered with the held error and the stored console goes; back with it,
    // the console of the person's turn goes before the resync's Runtime.enable (and any new session's).
    discardStored(v.tabId)
    if (v.control !== 'agent') for (const c of conns) { c.cutInflight(v.tabId, v.control); c.uploadGrants.delete(v.tabId) }
    else resync(v.tabId)
    const owner = opts.tabs.list().find(t => t.tabId === v.tabId)?.ownerSlotId
    if (!owner) return
    targetIdOf(v.tabId).then(targetId => {
      for (const c of conns) if (c.slotId === owner) c.stateChanged(targetId, v.control, v.reason)
    }, () => {})
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

  // M4: `<home>/browser` and `keys/` are the owner's alone (a home outside the profile inherits a drive's open ACL). Failing
  // that, the gate does not serve: anyone who can write keys/ can plant a key.
  try {
    ensurePrivateDir(dir)
    ensurePrivateDir(join(dir, 'keys'))
  } catch (e) {
    server.close()
    throw e
  }
  // endpoint.json, atomically (temp file + rename): the MCP server reads it at every connection. B2: a reader or an antivirus
  // holding the file on Windows fails the rename for a moment; a few more tries, each from a temp file of its own.
  const endpointFile = join(dir, 'endpoint.json')
  await writeAtomicRetry(endpointFile, JSON.stringify({ v: 1, port, pid: process.pid, instance }))
  opts.log('porteiro aberto (só 127.0.0.1)')

  // Deleted keys: live connections are swept on the key store's clock.
  const sweep = setInterval(() => {
    for (const c of [...conns]) if (!keys.valid(c.slotId, c.key)) c.close()
  }, opts.keyTtlMs ?? 1000)
  sweep.unref()

  return {
    port,
    instance,
    connections: () => [...conns].map(c => ({ slotId: c.slotId })),
    cleanTab: async tabId => {
      const surface = opts.tabs.surface(tabId)
      if (!surface) return 0
      let removed = 0
      for (const c of [...conns]) {
        const ids = [...(c.scripts.get(tabId) ?? [])]
        for (const s of sessions.of(c, tabId)) {
          if (s.kind !== 'page') continue
          for (const identifier of ids) {
            await surface.debugger.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, s.inner).then(() => { removed++ }, () => {})
          }
        }
        c.scripts.delete(tabId)
      }
      return removed
    },
    download: e => {
      const tellable = (c: Conn): boolean => c.slotId === e.slotId && c.downloadEvents && !c.closed
      if (![...conns].some(tellable)) return
      targetIdOf(e.tabId).then(frameId => {
        for (const c of conns) {
          if (!tellable(c)) continue
          if (e.state === 'begin') {
            // Rule 14: a download that starts while the person holds the tab is hers.
            if (controlOf(e.tabId) !== 'agent') continue
            c.downloads.add(e.guid)
            c.browserEvent('Browser.downloadWillBegin', { frameId, guid: e.guid, url: e.url, suggestedFilename: e.name })
            continue
          }
          if (!c.downloads.has(e.guid)) continue
          if (e.state !== 'inProgress') c.downloads.delete(e.guid)
          c.browserEvent('Browser.downloadProgress', { guid: e.guid, totalBytes: e.total, receivedBytes: e.received, state: e.state })
        }
      }, () => {})
    },
    dispose: () => {
      controlSub?.dispose()
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
