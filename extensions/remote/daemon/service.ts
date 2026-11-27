// The daemon half of the `remote` extension: the only writer of <home>/remote/ (house keys by role, the registry of devices
// with its states pending / active / revoked, a minimal append-only audit with a ceiling, the config), the person-facing
// requests on the pipe with the origin rules of E-7, and the portal it starts and stops by PID. The audit (audit.ts) gets
// a line for every act: its own and the portal's notes.
//
// What travels where: the pipe carries only the requests below and their replies, which go to the connection that asked
// and never in a transmission (no ext-event, no object). The pairing code (R and S), the typed SAS and the ticket's state
// go between this extension and the portal on the portal's private IPC channel. The SAS the house expects lives only in
// the portal's memory; nothing here ever sees it.
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { remoteBenchOn } from '../../../src/core/paths.ts'
import { setPortalCredential } from '../../../src/daemon/handshake.ts'
import { servedPipeOf } from '../../../src/daemon/pipe-key.ts'
import { pipePath } from '../../../src/daemon/protocol.ts'
import { DoorError } from '../../../src/daemon/door/port.ts'
import type { DaemonIo, ExtRequestContext } from '../../../src/daemon/ext-api.ts'
import type { Executor } from '../../../src/exec/executor.ts'
import { relayUrlAllowed } from '../../../src/remote/index.ts'
import { DEFAULT_SCOPES } from '../../../src/remoted/house.ts'
import { KEY_FILES } from '../../../src/remoted/keyfiles.ts'
import { LIMITS } from '../../../src/remoted/limits.ts'
import {
  PORTAL_EXIT, type FromPortal, type LiveDevice, type PairBegun, type PairView, type PortalAsk, type PortalNote, type PortalStatus,
  type SessionEnded,
} from '../../../src/remoted/ipc.ts'
import {
  denyList, deviceView, DEVICES_MAX, digitsOk, findDevice, isCredential, originAllowed, PAIR_ID_RE, parseConfig,
  parseRegistry, pruneRegistry, renewDevice, sanitizeLive, serializeRegistry, toPortalDevice, webUrlAllowed, type DeviceEntry, type RemoteConfig,
  type RemoteRequest,
} from '../rules.ts'
import { AuditLog } from './audit.ts'
import { ensureKeys } from './keys.ts'
import { newPortalCredential, spawnPortal, type PortalChild, type SpawnPortal } from './portal.ts'

/** The requests that only read: every other one of the pipe changes state or is a gesture, so it leaves a line even when refused. */
export const READ_REQUESTS: ReadonlySet<RemoteRequest> = new Set<RemoteRequest>(['remote.status', 'device.list', 'pair.state'])
const CMD_TIMEOUT_MS = 15_000
const PENDING_CMDS_MAX = 8
const RESPAWN_FIRST_MS = 2_000
const RESPAWN_MAX_MS = 5 * 60_000

export interface RemoteDeps {
  home: string
  io: DaemonIo
  log(msg: string): void
  env: NodeJS.ProcessEnv
  executor: Pick<Executor, 'run'>
  spawn?: SpawnPortal
  now?: () => number
}

type PortalState = { kind: 'off' } | { kind: 'starting' } | { kind: 'up' } | { kind: 'refused'; reason: string } | { kind: 'down'; reason: string }

export class RemoteService {
  readonly #d: RemoteDeps
  readonly #dir: string
  readonly #auditLog: AuditLog
  #devices: DeviceEntry[] = []
  #config: RemoteConfig = { v: 1, on: false, houseName: 'tether' }
  #loaded: Promise<void> | undefined
  #portal: PortalChild | undefined
  #portalState: PortalState = { kind: 'off' }
  #link: 'up' | 'down' = 'down'
  #sessions = 0
  /** The devices live now, as the portal's last note said (the status asks the portal itself when it is up). */
  #live: LiveDevice[] = []
  #cmdSeq = 0
  readonly #cmds = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  /** pairId → the connection that began it: only that connection sees or drives the ticket (E-7 (c)). */
  readonly #pairOwner = new Map<string, number>()
  #respawnMs = RESPAWN_FIRST_MS
  #respawnTimer: NodeJS.Timeout | undefined
  #stopping = false
  #chain: Promise<unknown> = Promise.resolve()

  constructor(deps: RemoteDeps) {
    this.#d = deps
    this.#dir = join(deps.home, 'remote')
    this.#auditLog = new AuditLog({
      dir: this.#dir, io: deps.io, now: () => this.#now, log: deps.log,
      ensureDir: async () => { if (!(await deps.io.exists(this.#dir))) await deps.executor.run('ensurePrivateDir', [this.#dir]) },
    })
  }

  get #now(): number { return (this.#d.now ?? Date.now)() }
  get #bench(): boolean { return remoteBenchOn(this.#d.env, this.#d.home) }

  /** One writer at a time: every change of the registry, the config or the keys runs in this chain. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.catch(() => undefined)
    return run
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      this.#config = parseConfig(await this.#d.io.tryReadText(join(this.#dir, 'config.json')).catch(() => undefined))
      const reg = parseRegistry(await this.#d.io.tryReadText(join(this.#dir, 'devices.json')).catch(() => undefined))
      if (reg.dropped) this.#d.log(`remote: ${reg.dropped} unreadable entr${reg.dropped === 1 ? 'y' : 'ies'} of devices.json ignored`)
      this.#devices = pruneRegistry(reg.devices, Math.floor(this.#now / 1000))
    })()
    return this.#loaded
  }

  // ---- the folder -------------------------------------------------------------------------------------------------

  /**
   * <home>/remote/ private to the user before anything is written (M-7). A folder that does not exist yet is created
   * private; one that exists and is open is refused, not fixed: whoever could write there may have planted a device.
   */
  async #privateFolder(): Promise<void> {
    if (!(await this.#d.io.exists(this.#dir))) {
      await this.#d.executor.run('ensurePrivateDir', [this.#dir])
    }
    if (!(await this.#d.executor.run('isPrivateFolder', [this.#dir]).catch(() => false))) {
      throw new DoorError('bad-request', `a pasta ${this.#dir} está aberta a outras contas da máquina: a remota não liga. Restrinja a pasta ao seu usuário ou apague-a para parear de novo`)
    }
  }

  async #write(name: string, text: string): Promise<void> {
    await this.#d.io.writeTextAtomic(join(this.#dir, name), text)
  }

  #saveRegistry(): Promise<void> { return this.#write('devices.json', serializeRegistry(this.#devices)) }
  #saveConfig(): Promise<void> { return this.#write('config.json', JSON.stringify(this.#config, null, 2) + '\n') }

  /** One line per act, never content (M-10): queued here, written and rotated by AuditLog without holding the loop. */
  #audit(act: string, result: string, deviceId?: string, target?: string): void {
    this.#auditLog.record({ act, result, ...(deviceId ? { device: deviceId } : {}), ...(target ? { target } : {}) })
  }

  // ---- the portal -------------------------------------------------------------------------------------------------

  #pipe(): string {
    return servedPipeOf(this.#d.home) ?? this.#d.env.TETHER_PIPE ?? pipePath(this.#d.home, userInfo().username)
  }

  /** tetherd owns its pipe: the remote comes back on if it was on. */
  async started(): Promise<void> {
    await this.#load()
    if (this.#config.on) await this.#serial(() => this.#startPortal()).catch((e: Error) => this.#d.log(`remote: not started (${e.message})`))
  }

  async #startPortal(): Promise<void> {
    if (this.#portal) return
    if (!this.#config.relayUrl || !relayUrlAllowed(this.#config.relayUrl)) throw new DoorError('bad-request', 'sem relay válido configurado (wss://, ou ws:// só para localhost)')
    await this.#privateFolder()
    const keys = await ensureKeys({
      house: await this.#d.io.tryReadText(join(this.#dir, KEY_FILES.house)),
      relay: await this.#d.io.tryReadText(join(this.#dir, KEY_FILES.relay)),
      ticket: await this.#d.io.tryReadText(join(this.#dir, KEY_FILES.ticket)),
    }, Math.floor(this.#now / 1000))
    if (keys.house) await this.#write(KEY_FILES.house, keys.house)
    if (keys.relay) await this.#write(KEY_FILES.relay, keys.relay)
    if (keys.ticket) await this.#write(KEY_FILES.ticket, keys.ticket)
    if (keys.house) { this.#devices = []; await this.#saveRegistry() } // a new identity: no device of the old one can connect
    const cred = newPortalCredential()
    setPortalCredential(this.#d.home, cred)
    this.#portalState = { kind: 'starting' }
    this.#stopping = false
    const spawn = this.#d.spawn ?? spawnPortal
    let child: PortalChild | undefined
    try {
      child = await spawn({
        home: this.#d.home, pipe: this.#pipe(), node: this.#d.env.TETHER_NODE?.trim() || process.execPath, env: this.#d.env, cred,
        onMessage: (m) => this.#onPortal(child, m),
        onExit: (code) => this.#onExit(child, code),
      })
    } finally { cred.fill(0) }
    this.#portal = child
    this.#d.log(`remote: portal started (pid ${child.pid ?? '?'})`)
  }

  async #stopPortal(): Promise<void> {
    clearTimeout(this.#respawnTimer)
    const p = this.#portal
    this.#stopping = true
    this.#portal = undefined
    setPortalCredential(this.#d.home, undefined)
    for (const [, w] of this.#cmds) { clearTimeout(w.timer); w.reject(new DoorError('bad-request', 'a remota foi desligada')) }
    this.#cmds.clear()
    this.#pairOwner.clear()
    this.#link = 'down'
    this.#sessions = 0
    this.#live = []
    this.#portalState = { kind: 'off' }
    if (p) await p.kill()
  }

  #onExit(child: PortalChild | undefined, code: number | null): void {
    if (child === undefined || this.#portal !== child) return
    this.#portal = undefined
    setPortalCredential(this.#d.home, undefined)
    this.#link = 'down'
    this.#sessions = 0
    this.#live = []
    for (const [, w] of this.#cmds) { clearTimeout(w.timer); w.reject(new DoorError('bad-request', 'o portal saiu')) }
    this.#cmds.clear()
    this.#pairOwner.clear()
    if (this.#stopping) return
    const permanent = code === PORTAL_EXIT.folderOpen || code === PORTAL_EXIT.config || code === PORTAL_EXIT.keys || code === PORTAL_EXIT.badCredential
    if (this.#portalState.kind !== 'refused') this.#portalState = permanent ? { kind: 'refused', reason: `saiu com o código ${code}` } : { kind: 'down', reason: `saiu com o código ${code ?? 'sinal'}` }
    this.#d.log(`remote: portal exited (code ${code ?? 'signal'})`)
    this.#audit('portal.exit', String(code ?? 'signal'))
    if (permanent || !this.#config.on) return
    const wait = this.#respawnMs
    this.#respawnMs = Math.min(RESPAWN_MAX_MS, this.#respawnMs * 2)
    this.#respawnTimer = setTimeout(() => {
      if (this.#config.on && !this.#portal) void this.#serial(() => this.#startPortal()).catch((e: Error) => this.#d.log(`remote: respawn failed (${e.message})`))
    }, wait)
    this.#respawnTimer.unref?.()
  }

  #onPortal(child: PortalChild | undefined, m: FromPortal): void {
    if (child === undefined || this.#portal !== child) return
    switch (m.t) {
      case 'want-init':
        child.send({
          t: 'init', relayUrl: this.#config.relayUrl!, houseName: this.#config.houseName,
          ...(this.#config.webUrl ? { webUrl: this.#config.webUrl } : {}),
          devices: this.#devices.map(toPortalDevice), deny: denyList(this.#devices, Math.floor(this.#now / 1000)),
        })
        return
      case 'ready':
        this.#portalState = { kind: 'up' }
        this.#respawnMs = RESPAWN_FIRST_MS
        return
      case 'fatal':
        this.#portalState = { kind: 'refused', reason: m.reason }
        this.#d.log(`remote: the portal refused to serve: ${m.reason}`)
        return
      case 'reply': {
        const w = this.#cmds.get(m.id)
        if (!w) return
        this.#cmds.delete(m.id)
        clearTimeout(w.timer)
        if (m.ok) w.resolve(m.result)
        else w.reject(new DoorError('bad-request', m.error))
        return
      }
      case 'ask': {
        const { id, t: _t, ...a } = m
        void this.#serial(() => this.#answerAsk(a as PortalAsk)).then(
          () => child.send({ t: 'answer', id, ok: true }),
          (e: Error) => child.send({ t: 'answer', id, ok: false, error: e.message }),
        )
        return
      }
      case 'note': {
        const { t: _t, ...n } = m
        void this.#serial(() => this.#onNote(n as PortalNote)).catch((e: Error) => this.#d.log(`remote: note failed (${e.message})`))
      }
    }
  }

  async #answerAsk(a: PortalAsk): Promise<void> {
    const nowIso = new Date(this.#now).toISOString()
    if (a.ask === 'paired') {
      if (this.#devices.some((d) => d.deviceId === a.device.deviceId)) throw new Error('device already in the registry')
      if (this.#devices.filter((d) => d.state !== 'revoked').length >= DEVICES_MAX) throw new Error('too many devices')
      this.#devices.push({
        deviceId: a.device.deviceId, pubD: a.device.pubD, name: a.device.name, access: a.device.access, state: 'pending',
        scopes: [...DEFAULT_SCOPES], createdAt: nowIso, maxVerUsed: a.device.ver, tickets: [a.ticket], usedKeyIds: [a.ticket.keyId], denied: [],
      })
      await this.#saveRegistry()
      this.#audit('pair.sas-ok', 'pending', a.device.deviceId)
      return
    }
    const d = this.#devices.find((x) => x.deviceId === a.deviceId)
    if (a.ask === 'credential') {
      // Once per device, never over another one: changing the credential is pairing again (spec 7.4 point 1).
      if (!d || d.state === 'revoked') throw new Error('device not paired')
      if (d.credential) throw new Error('credential already registered')
      if (!isCredential(a.credential)) throw new Error('credential malformed')
      d.credential = { ...a.credential }
      d.registeredAt = nowIso
      await this.#saveRegistry()
      return
    }
    if (a.ask === 'sign-count') {
      if (!d || d.state === 'revoked' || !d.credential) throw new Error('no credential')
      if (!Number.isInteger(a.signCount) || a.signCount < 0 || a.signCount > 0xffffffff) throw new Error('sign count out of range')
      d.credential = { ...d.credential, signCount: a.signCount }
      await this.#saveRegistry()
      return
    }
    // A revocation is written before anything else happens to the device (spec 6.1), so a renewal after it is refused.
    if (!d || d.state !== 'active') throw new Error('device not active')
    renewDevice(d, a.ticket, Math.floor(this.#now / 1000), LIMITS.deniedPerDevice, LIMITS.usedKeyIdsPerDevice)
    await this.#saveRegistry()
  }

  async #onNote(n: PortalNote): Promise<void> {
    const d = 'deviceId' in n && n.deviceId ? this.#devices.find((x) => x.deviceId === n.deviceId) : undefined
    switch (n.note) {
      case 'acked':
        if (d && d.state === 'pending') { d.state = 'active'; d.activatedAt = new Date(this.#now).toISOString(); await this.#saveRegistry() }
        this.#audit('pair.done', d ? 'active' : 'unknown', n.deviceId)
        return
      case 'erase':
        if (d && d.state === 'pending') { this.#devices = this.#devices.filter((x) => x !== d); await this.#saveRegistry() }
        this.#audit('pair.erase', 'ok', n.deviceId)
        return
      case 'seen':
        if (d) { d.lastSeenAt = new Date(this.#now).toISOString(); d.maxVerUsed = Math.max(d.maxVerUsed, n.ver); await this.#saveRegistry() }
        return
      case 'revoke-self':
        if (d) await this.#revoke(d, 'device')
        return
      case 'revoke-device': {
        // The portal checked the proof of the act (spec 6.1, from another device); the asking device must still be paired.
        const target = this.#devices.find((x) => x.deviceId === n.target)
        if (d && d.state !== 'revoked' && target) await this.#revoke(target, `device:${n.deviceId}`)
        return
      }
      case 'link': this.#link = n.state; return
      case 'sessions': this.#sessions = n.count; this.#live = sanitizeLive(n.live); return
      case 'audit': this.#audit(n.act, n.result, n.deviceId, n.target); return
    }
  }

  /** Spec 6.1, in order: (1) write `revoked`; (2)+(3) the portal closes its sessions and denies its tickets; (4) the portal drops its state. */
  async #revoke(d: DeviceEntry, by: string): Promise<void> {
    if (d.state === 'revoked') return
    d.state = 'revoked'
    d.revokedAt = new Date(this.#now).toISOString()
    await this.#saveRegistry()
    this.#audit('device.revoke', `by:${by}`, d.deviceId)
    this.#portal?.send({ t: 'revoke', deviceId: d.deviceId, deny: d.tickets.map((t) => ({ ticketId: t.ticketId, exp: t.exp })) })
  }

  #command(cmd: Record<string, unknown> & { cmd: string }): Promise<unknown> {
    const p = this.#portal
    if (!p || this.#portalState.kind !== 'up') return Promise.reject(new DoorError('bad-request', 'o portal da remota não está no ar'))
    if (this.#cmds.size >= PENDING_CMDS_MAX) return Promise.reject(new DoorError('bad-request', 'pedidos demais em curso'))
    const id = ++this.#cmdSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#cmds.delete(id); reject(new DoorError('bad-request', 'o portal não respondeu')) }, CMD_TIMEOUT_MS)
      this.#cmds.set(id, { resolve, reject, timer })
      p.send({ t: 'cmd', id, ...cmd } as never)
    })
  }

  // ---- the pipe's requests ----------------------------------------------------------------------------------------

  /** The handler of one request, after the origin rule. */
  async handle(name: RemoteRequest, args: unknown, ctx: ExtRequestContext): Promise<unknown> {
    try { return await this.#handle(name, args, ctx) } catch (e) {
      // A request that changes state or is a gesture leaves a line when refused too: at the door, for a ticket that is not
      // the connection's, for a bad argument or a portal that is not up. Only the kind of refusal is said, never the argument.
      if (!READ_REQUESTS.has(name)) this.#audit(name, `refused:${e instanceof DoorError ? e.code : 'failed'}`, undefined, ctx.client ?? '?')
      throw e
    }
  }

  async #handle(name: RemoteRequest, args: unknown, ctx: ExtRequestContext): Promise<unknown> {
    if (!originAllowed(name, ctx.client, this.#bench)) {
      throw new DoorError('door-denied', `${name} só é aceito do app do tether, pela tela, com a pessoa diante da máquina`)
    }
    await this.#load()
    const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    switch (name) {
      case 'remote.status': return this.#status()
      case 'device.list': return { devices: this.#devices.map(deviceView) }
      case 'remote.off':
        return this.#serial(async () => {
          const was = this.#config.on
          this.#config = { ...this.#config, on: false }
          if (await this.#d.io.exists(this.#dir)) await this.#saveConfig()
          await this.#stopPortal()
          this.#audit('remote.off', `${was ? 'by' : 'already-off:by'}:${ctx.client ?? '?'}`)
          return { on: false }
        })
      case 'remote.on': {
        const url = a.relayUrl === undefined ? this.#config.relayUrl : a.relayUrl
        if (typeof url !== 'string' || !relayUrlAllowed(url)) throw new DoorError('bad-request', 'relay inválido: wss://, ou ws:// só para localhost, sem usuário nem senha na URL')
        // The phone app's address goes with the relay: absent, kept; '' or null, forgotten; else https (http only for localhost).
        const web = a.webUrl === undefined ? this.#config.webUrl : a.webUrl === null || a.webUrl === '' ? undefined : a.webUrl
        if (web !== undefined && !webUrlAllowed(web)) throw new DoorError('bad-request', 'endereço do app do celular inválido: https://, ou http:// só para localhost, sem usuário, senha nem # na URL')
        return this.#serial(async () => {
          await this.#privateFolder()
          const changed = url !== this.#config.relayUrl
          if (changed && this.#portal) await this.#stopPortal()
          const { webUrl: old, ...rest } = this.#config
          // A portal already up keeps serving: it only learns the new origin of the PWA (one that is starting reads it in init).
          const tellWeb = this.#portal !== undefined && this.#portalState.kind === 'up' && old !== web
          this.#config = { ...rest, on: true, relayUrl: url, ...(web !== undefined ? { webUrl: web } : {}) }
          await this.#saveConfig()
          this.#audit('remote.on', `by:${ctx.client ?? '?'}`)
          await this.#startPortal()
          if (tellWeb) this.#portal?.send(web !== undefined ? { t: 'web', webUrl: web } : { t: 'web' })
          return { on: true }
        })
      }
      case 'device.revoke': {
        const d = findDevice(this.#devices, a.device)
        if (d === 'ambiguous') throw new DoorError('bad-request', 'esse começo de id serve a mais de um aparelho: dê mais dígitos')
        if (!d) throw new DoorError('bad-request', 'nenhum aparelho com esse id')
        await this.#serial(() => this.#revoke(d, ctx.client ?? '?'))
        return { device: deviceView(d) }
      }
      case 'session.end': {
        const d = findDevice(this.#devices, a.device)
        if (d === 'ambiguous') throw new DoorError('bad-request', 'esse começo de id serve a mais de um aparelho: dê mais dígitos')
        if (!d || d.state === 'revoked') throw new DoorError('bad-request', 'nenhum aparelho pareado com esse id')
        // Not revoked, nothing denied: the device may connect again. The line says who ended it.
        const r = await this.#command({ cmd: 'session.end', deviceId: d.deviceId }) as SessionEnded
        this.#audit('session.end', `by:${ctx.client ?? '?'}`, d.deviceId)
        return { device: deviceView(d), ended: r.ended }
      }
      case 'pair.begin': {
        if (ctx.conn === undefined) throw new DoorError('bad-request', 'conexão sem número')
        const r = await this.#command({ cmd: 'pair.begin' }) as PairBegun
        this.#pairOwner.clear() // one ticket at a time: a new one voids the old
        this.#pairOwner.set(r.pairId, ctx.conn)
        this.#audit('pair.begin', `by:${ctx.client ?? '?'}`)
        return r
      }
      case 'pair.sas':
      case 'pair.cancel':
      case 'pair.state': {
        const pairId = a.pairId
        if (typeof pairId !== 'string' || !PAIR_ID_RE.test(pairId)) throw new DoorError('bad-request', 'pairId inválido')
        if (ctx.conn === undefined || this.#pairOwner.get(pairId) !== ctx.conn) throw new DoorError('door-denied', 'esse pareamento é de outra tela')
        if (name === 'pair.sas') {
          if (!digitsOk(a.digits)) throw new DoorError('bad-request', 'digite os 6 números que o aparelho mostra')
          const view = await this.#command({ cmd: 'pair.sas', pairId, digits: a.digits }) as PairView
          this.#audit('pair.sas', 'submitted') // the digits are never in the line
          return view
        }
        const view = await this.#command({ cmd: name, pairId }) as PairView
        if (name === 'pair.cancel') this.#audit('pair.cancel', `by:${ctx.client ?? '?'}`)
        return view
      }
    }
  }

  async #status(): Promise<unknown> {
    let portal: PortalStatus | undefined
    if (this.#portal && this.#portalState.kind === 'up') portal = await this.#command({ cmd: 'status' }).catch(() => undefined) as PortalStatus | undefined
    const st = this.#portalState
    return {
      on: this.#config.on,
      relay: this.#config.relayUrl ? new URL(this.#config.relayUrl).host : undefined,
      portal: st.kind === 'refused' || st.kind === 'down' ? { state: st.kind, reason: st.reason, ...(this.#portal?.pid ? { pid: this.#portal.pid } : {}) } : { state: st.kind, ...(this.#portal?.pid ? { pid: this.#portal.pid } : {}) },
      link: portal?.link ?? this.#link,
      sessions: portal?.sessions ?? this.#sessions,
      live: this.#config.on ? (portal ? sanitizeLive(portal.live) : this.#live) : [],
      ...(portal ? { fingerprint: portal.houseFingerprint } : {}),
      ...(this.#config.webUrl ? { webUrl: this.#config.webUrl } : {}),
      devices: this.#devices.map(deviceView),
    }
  }

  async dispose(): Promise<void> {
    await this.#stopPortal()
    await this.#auditLog.flush()
  }
}
