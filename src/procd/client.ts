// tetherd's side of the host pipe: connect (hello + protocol check), requests with replies, `exit` / `data`
// events, and launching tether-procd detached when nothing answers (only when asked: a boot only connects).
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { encode, LineParser } from '../daemon/ndjson.ts'
import { spawnDetachedNode } from '../daemon/client.ts'
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

export interface LaunchHostOptions {
  home: string
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
  private readonly parser = new LineParser()
  private nextId = 1
  private readonly waiting = new Map<number, { resolve: (r: HostOkReply) => void; reject: (e: Error) => void }>()
  private closed = false

  private constructor(socket: Socket, hello: HostHello) {
    super()
    this.socket = socket
    this.hello = hello
  }

  /** Connects and checks the protocol; rejects when nothing answers, or with HostRequestError('version'). */
  static async open(pipe: string, timeoutMs = 5_000): Promise<HostClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe)
      s.once('connect', () => { s.off('error', reject); resolve(s) })
      s.once('error', reject)
    })
    socket.setEncoding('utf8')
    try {
      const hello = await new Promise<HostHello>((resolve, reject) => {
        const parser = new LineParser()
        const timer = setTimeout(() => reject(new Error('o anfitrião não respondeu ao hello')), timeoutMs)
        const onData = (chunk: string): void => {
          for (const line of parser.push(chunk)) {
            const v = line.value as HostReply | undefined
            if (!v || v.id !== 0) continue
            clearTimeout(timer)
            socket.off('data', onData)
            socket.off('close', onClose)
            if (v.t === 'ok' && v.hello) resolve(v.hello)
            else reject(v.t === 'error' ? new HostRequestError(v.code, v.message) : new Error('hello sem resposta válida'))
            return
          }
        }
        const onClose = (): void => { clearTimeout(timer); reject(new Error('conexão com o anfitrião fechada antes do hello')) }
        socket.on('data', onData)
        socket.on('close', onClose)
        socket.write(encode({ t: 'hello', id: 0, v: PROCD_PROTOCOL_VERSION }))
      })
      if (hello.v !== PROCD_PROTOCOL_VERSION) {
        throw new HostRequestError('version', `o anfitrião rodando (pid ${hello.pid}) fala a versão ${hello.v} do protocolo; esta é a ${PROCD_PROTOCOL_VERSION}`)
      }
      const client = new HostClient(socket, hello)
      client.wire()
      return client
    } catch (e) {
      socket.destroy()
      throw e
    }
  }

  /** Like `open`, but never throws: undefined when no host answers on the pipe (or it speaks another protocol version). */
  static async tryOpen(pipe: string, timeoutMs = 5_000): Promise<HostClient | undefined> {
    try {
      return await HostClient.open(pipe, timeoutMs)
    } catch {
      return undefined
    }
  }

  /** What the host announced in `hello` (empty for a host that predates caps). */
  get caps(): readonly HostCap[] {
    return this.hello.caps ?? []
  }

  /** The host's hello, or undefined when nothing (or no host) answers. */
  static async ping(pipe: string): Promise<HostHello | undefined> {
    try {
      const c = await HostClient.open(pipe, 2_000)
      c.close()
      return c.hello
    } catch {
      return undefined
    }
  }

  /** Connects, launching the host (tether-procd unless `target` says otherwise) detached when nothing answers; waits up to `timeoutMs` for it. */
  static async ensure(opts: LaunchHostOptions, timeoutMs = 20_000, target: HostTarget = PROCD_TARGET): Promise<HostClient> {
    try {
      return await HostClient.open(opts.pipe)
    } catch (e) {
      if (e instanceof HostRequestError) throw e
    }
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
        return await HostClient.open(opts.pipe)
      } catch (e) {
        if (e instanceof HostRequestError) throw e
        last = e as Error
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    throw new Error(`${target.what} não respondeu em ${opts.pipe}: ${last?.message ?? 'timeout'}`)
  }

  get isClosed(): boolean {
    return this.closed
  }

  private wire(): void {
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
