// tetherd's side of the host pipe: connect (hello + protocol check), requests with replies, `exit` / `data`
// events, and launching tether-procd detached when nothing answers (only when asked: a boot only connects).
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { encode, LineParser, type ParsedLine } from '../daemon/ndjson.ts'
import { spawnDetachedNode } from '../daemon/client.ts'
import { HandshakeReader } from '../daemon/handshake.ts'
import { clientProof, daemonProof, hostKeyPath, isNonce, newNonce, readKeyFile, sameProof, servedHome } from '../daemon/pipe-key.ts'
import { tetherHome } from '../core/paths.ts'
import type { ExeName } from '../core/exe.ts'
import {
  PROCD_PROTOCOL_VERSION,
  type HostCap,
  type HostErrorCode,
  type HostEvent,
  type HostHello,
  type HostReply,
  type HostRequest,
  type RunExit,
} from './protocol.ts'

export type HostOkReply = Extract<HostReply, { t: 'ok' }>
type HostRequestBody = { [K in HostRequest['t']]: Omit<Extract<HostRequest, { t: K }>, 'id'> }[HostRequest['t']]

export class HostRequestError extends Error {
  readonly code: HostErrorCode
  constructor(code: HostErrorCode, message: string) {
    super(message)
    this.name = 'HostRequestError'
    this.code = code
  }
}

type Events = {
  exit: [name: string, run: number, exit: RunExit]
  /** `off` is the run's output offset after this chunk (hosts with the `offsets` cap). */
  data: [name: string, data: string, off?: number]
  /** The host says this client fell behind on `name`: re-attach with the last offset. */
  lag: [name: string]
  close: []
}

/** What differs between the hosts that speak this protocol: tether-procd (the default) and tether-ptyd. */
export interface HostTarget {
  /** The executable name it runs under (<home>/bin/<exe>.exe). */
  exe: ExeName
  /** For the error messages: "o anfitrião de processos (tether-procd)". */
  what: string
  /** The host's entry script. */
  main: string
  /** The environment variable that carries the pipe to the host. */
  pipeEnv: string
}

export const PROCD_TARGET: HostTarget = {
  exe: 'tether-procd',
  what: 'o anfitrião de processos (tether-procd)',
  // Lazy: the app bundles this module as CJS, where import.meta.url is empty and evaluating it at load would throw.
  get main() { return fileURLToPath(new URL('./main.ts', import.meta.url)) },
  pipeEnv: 'TETHER_PROCD_PIPE',
}

export interface HostOpenOptions {
  /** The tether home that holds the host's key (pipe-key.ts hostKeyPath). Default: the home of a host in this process on that pipe, else tetherHome(). */
  home?: string
  /** Accept a host before protocol 2 (it checks nobody): only to ping it or ask it to leave. */
  legacy?: boolean
}

export interface LaunchHostOptions {
  home: string
  /** Where the key of a host ALREADY on the pipe lives, when not in `home` (a test's shared host; ptyd/paths.ts ptydKeyHome). */
  keyHome?: string
  /** The host's pipe (TETHER_PROCD_PIPE in its environment). */
  pipe: string
  /** The node to make tether-procd.exe from (tetherd's own TETHER_NODE, else its execPath). */
  node: string
  env: NodeJS.ProcessEnv
  log?: (msg: string) => void
}

export class HostClient extends EventEmitter<Events> {
  readonly hello: HostHello
  private readonly socket: Socket
  private parser = new LineParser()
  private nextId = 1
  private readonly waiting = new Map<number, { resolve: (r: HostOkReply) => void; reject: (e: Error) => void }>()
  private closed = false

  private constructor(socket: Socket, hello: HostHello) {
    super()
    this.socket = socket
    this.hello = hello
  }

  /**
   * Connects and completes the handshake (daemon/pipe-key.ts, scope 'tether-host'): the host proves it holds the key of
   * <home>/host-*.key for this pipe before this client sends its own proof, so a program that took the pipe's name never
   * gets a plan (whose env carries secrets) nor a keystroke. Rejects when nothing answers; HostRequestError('version') for
   * another protocol; HostRequestError('outdated') for a host before protocol 2, unless `how.legacy` (ping and shutdown only).
   */
  static async open(pipe: string, timeoutMs = 5_000, how: HostOpenOptions = {}): Promise<HostClient> {
    const home = how.home ?? servedHome(pipe) ?? tetherHome()
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe)
      s.once('connect', () => { s.off('error', reject); resolve(s) })
      s.once('error', reject)
    })
    const replies = new HandshakeReader<HostReply>(socket, (why) => new Error(why === 'closed' ? 'conexão com o anfitrião fechada antes do hello' : 'o anfitrião não respondeu ao hello'))
    try {
      const nonce = newNonce()
      socket.write(encode({ t: 'auth', id: 0, nonce }))
      const auth = await replies.next(timeoutMs)
      let hello: HostHello
      if (auth.t === 'error' && auth.code === 'bad-request') {
        // A host before protocol 2 does not know `auth`; its unproven hello says who it is.
        socket.write(encode({ t: 'hello', id: 0, v: 1 }))
        const old = await replies.next(timeoutMs)
        if (old.t !== 'ok' || !old.hello) throw new Error('hello sem resposta válida')
        if (!how.legacy) {
          throw new HostRequestError('outdated', `o anfitrião rodando (pid ${old.hello.pid}, versão ${old.hello.version}) é anterior à identificação dos clientes e não recebe mais pedidos; `
            + 'ele sai sozinho quando não tiver processos, ou encerre-o: tether proc host stop --force (processos de fundo) / tether daemon restart (painéis)')
        }
        hello = { ...old.hello, legacy: true }
      } else if (auth.t === 'error') {
        throw new HostRequestError(auth.code, auth.message)
      } else {
        const theirs = auth.auth
        if (!theirs || !isNonce(theirs.nonce) || typeof theirs.proof !== 'string') throw new Error('resposta de identificação inválida do anfitrião')
        const keyPath = hostKeyPath(home, pipe)
        const key = await readKeyFile(keyPath)
        if (!key) throw new HostRequestError('auth-failed', `não encontrei a chave do anfitrião em ${keyPath}: este cliente e o anfitrião usam a mesma pasta do tether (TETHER_HOME)?`)
        // A HostRequestError: `ensure` must not launch a host over it (that one could not listen anyway); the caller is told.
        if (!sameProof(theirs.proof, daemonProof(key, nonce, theirs.nonce, 'tether-host'))) throw new HostRequestError('auth-failed', `quem responde em ${pipe} não provou ter a chave de ${keyPath}`)
        socket.write(encode({ t: 'hello', id: 0, v: PROCD_PROTOCOL_VERSION, proof: clientProof(key, nonce, theirs.nonce, 'tether-host') }))
        const r = await replies.next(timeoutMs)
        if (r.t === 'error') throw new HostRequestError(r.code, r.message)
        if (!r.hello) throw new Error('hello sem resposta válida')
        hello = r.hello
      }
      if (!hello.legacy && hello.v !== PROCD_PROTOCOL_VERSION) {
        throw new HostRequestError('version', `o anfitrião rodando (pid ${hello.pid}) fala a versão ${hello.v} do protocolo; esta é a ${PROCD_PROTOCOL_VERSION}`)
      }
      const client = new HostClient(socket, hello)
      client.wire(replies.release())
      return client
    } catch (e) {
      replies.release()
      socket.destroy()
      throw e
    }
  }

  /** Like `open`, but never throws: undefined when no host answers on the pipe (or it speaks another protocol version). */
  static async tryOpen(pipe: string, timeoutMs = 5_000, how: HostOpenOptions = {}): Promise<HostClient | undefined> {
    try {
      return await HostClient.open(pipe, timeoutMs, how)
    } catch {
      return undefined
    }
  }

  /** What the host announced in `hello` (empty for a host that predates caps). */
  get caps(): readonly HostCap[] {
    return this.hello.caps ?? []
  }

  /** The host's hello, or undefined when nothing (or no host) answers. */
  static async ping(pipe: string, home?: string): Promise<HostHello | undefined> {
    try {
      const c = await HostClient.open(pipe, 2_000, { legacy: true, ...(home !== undefined ? { home } : {}) })
      c.close()
      return c.hello
    } catch {
      return undefined
    }
  }

  /** Connects, launching the host (tether-procd unless `target` says otherwise) detached when nothing answers; waits up to `timeoutMs` for it. */
  static async ensure(opts: LaunchHostOptions, timeoutMs = 20_000, target: HostTarget = PROCD_TARGET): Promise<HostClient> {
    const keyHome = opts.keyHome ?? opts.home
    try {
      return await HostClient.open(opts.pipe, 5_000, { home: keyHome })
    } catch (e) {
      if (!(e instanceof HostRequestError)) { /* nothing answers: launch one below */ }
      else if (e.code !== 'outdated' || !(await HostClient.retireIdle(opts.pipe, keyHome, opts.log))) throw e
    }
    // The host launched here runs with TETHER_HOME = opts.home: its key is there.
    const how = { home: opts.home }
    await spawnDetachedNode({
      name: target.exe,
      what: target.what,
      home: opts.home,
      node: opts.node,
      mainPath: target.main,
      env: { ...opts.env, TETHER_HOME: opts.home, [target.pipeEnv]: opts.pipe },
      ...(opts.log ? { log: opts.log } : {}),
    })
    const deadline = Date.now() + timeoutMs
    let last: Error | undefined
    while (Date.now() < deadline) {
      try {
        return await HostClient.open(opts.pipe, 5_000, how)
      } catch (e) {
        if (e instanceof HostRequestError) throw e
        last = e as Error
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    throw new Error(`${target.what} não respondeu em ${opts.pipe}: ${last?.message ?? 'timeout'}`)
  }

  /**
   * An upgrade's way past a host of protocol 1: when it runs nothing, it is asked to leave (an unproven connection gets only
   * `list` and `shutdown`, never a plan) and the pipe is waited free. True when it left; false when it still runs something
   * (it refuses, and the caller reports `outdated`).
   */
  static async retireIdle(pipe: string, home: string, log?: (msg: string) => void): Promise<boolean> {
    let old: HostClient
    try { old = await HostClient.open(pipe, 5_000, { home, legacy: true }) } catch { return false }
    try {
      if (!old.hello.legacy) return false
      if (((await old.request({ t: 'list' })).runs ?? []).some((r) => !r.exit)) return false
      await old.request({ t: 'shutdown' })
      log?.(`host pid ${old.hello.pid} predates protocol ${PROCD_PROTOCOL_VERSION} and ran nothing: asked it to leave`)
    } catch {
      return false
    } finally {
      old.close()
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (!(await HostClient.ping(pipe, home))) return true
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** `start`: the handshake's parser (it may hold the beginning of the next line) and the lines it read past the hello. */
  private wire(start: { parser: LineParser; lines: ParsedLine[] }): void {
    this.parser = start.parser
    for (const line of start.lines) if (line.value) this.onMessage(line.value as HostReply | HostEvent)
    this.socket.on('data', (chunk: string) => {
      for (const line of this.parser.push(chunk)) if (line.value) this.onMessage(line.value as HostReply | HostEvent)
    })
    this.socket.on('error', () => { /* surfaces as close */ })
    this.socket.on('close', () => {
      this.closed = true
      for (const w of this.waiting.values()) w.reject(new Error('conexão com o anfitrião fechada'))
      this.waiting.clear()
      this.emit('close')
    })
  }

  private onMessage(msg: HostReply | HostEvent): void {
    if (msg.t === 'exit') { this.emit('exit', msg.name, msg.run, msg.exit); return }
    if (msg.t === 'data') { this.emit('data', msg.name, msg.data, msg.off); return }
    if (msg.t === 'lag') { this.emit('lag', msg.name); return }
    const w = this.waiting.get(msg.id)
    if (!w) return
    this.waiting.delete(msg.id)
    if (msg.t === 'ok') w.resolve(msg)
    else w.reject(new HostRequestError(msg.code, msg.message))
  }

  request(body: HostRequestBody): Promise<HostOkReply> {
    if (this.closed) return Promise.reject(new Error('conexão com o anfitrião fechada'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.socket.write(encode({ ...body, id }))
    })
  }

  /** Fire-and-forget input to a hosted process (no reply; unknown names are ignored by the host). */
  write(name: string, data: string): void {
    if (this.closed) return
    this.socket.write(encode({ t: 'write', name, data }))
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }
}
