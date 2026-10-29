// Typed client of tetherd for the app and the CLI: connect (spawning the daemon detached when it is not
// running), send requests and await their replies, receive `state` / `data` / `removed` events.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { tetherHome } from '../core/paths.ts'
import { encode, LineParser } from './ndjson.ts'
import { PROTOCOL_VERSION, pipePath, type DaemonMessage, type ErrorCode, type Reply, type Request, type SlotState } from './protocol.ts'

export type Hello = { v: number; pid: number; version: string }
export type OkReply = Extract<Reply, { t: 'ok' }>
/** A request without its `id` (the client assigns one); still a discriminated union on `t`. */
export type RequestBody = { [K in Request['t']]: Omit<Extract<Request, { t: K }>, 'id'> }[Request['t']]

export class DaemonError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'DaemonError'
    this.code = code
  }
}

export interface ClientOptions {
  home?: string
  pipe?: string
  client?: 'app' | 'cli' | 'test'
  /** Start tetherd (detached) when nothing answers on the pipe. Default true. */
  spawn?: boolean
  /** Max wait for the daemon to come up after spawning it (ms). Default 15 000. */
  startTimeoutMs?: number
}

type Events = {
  state: [slot: SlotState]
  data: [slotId: string, data: string]
  removed: [slotId: string]
  close: []
}

export class DaemonClient extends EventEmitter<Events> {
  readonly hello: Hello
  private readonly socket: Socket
  private readonly parser = new LineParser()
  private nextId = 1
  private readonly waiting = new Map<number, { resolve: (r: OkReply) => void; reject: (e: Error) => void }>()
  private closed = false

  private constructor(socket: Socket, hello: Hello) {
    super()
    this.socket = socket
    this.hello = hello
  }

  /** Connects to the daemon; with `spawn` (default) starts one when the pipe does not answer. */
  static async connect(opts: ClientOptions = {}): Promise<DaemonClient> {
    const home = opts.home ?? tetherHome()
    const pipe = opts.pipe ?? pipePath(home, userInfo().username)
    const kind = opts.client ?? 'cli'
    try {
      return await DaemonClient.open(pipe, kind)
    } catch (e) {
      if (opts.spawn === false) throw e
    }
    spawnDaemon({ home, pipe })
    const deadline = Date.now() + (opts.startTimeoutMs ?? 15_000)
    let lastError: Error | undefined
    while (Date.now() < deadline) {
      try {
        return await DaemonClient.open(pipe, kind)
      } catch (e) {
        lastError = e as Error
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error(`tetherd não respondeu em ${pipe}: ${lastError?.message ?? 'timeout'}`)
  }

  /** Connects and completes the hello handshake; no spawning. */
  static async open(pipe: string, kind: 'app' | 'cli' | 'test'): Promise<DaemonClient> {
    const socket = await connectSocket(pipe)
    let client: DaemonClient | undefined
    const pendingHello = new Promise<Hello>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sem resposta ao hello')), 5_000)
      const parser = new LineParser()
      const onData = (chunk: string): void => {
        for (const line of parser.push(chunk)) {
          const v = line.value as Reply | undefined
          if (v && v.t === 'ok' && v.id === 0 && v.hello) {
            clearTimeout(timer)
            socket.off('data', onData)
            socket.off('close', onClose)
            resolve(v.hello)
            return
          }
          if (v && v.t === 'error' && v.id === 0) {
            clearTimeout(timer)
            reject(new DaemonError(v.code, v.message))
            return
          }
        }
      }
      const onClose = (): void => {
        clearTimeout(timer)
        reject(new Error('conexão fechada antes do hello'))
      }
      socket.setEncoding('utf8')
      socket.on('data', onData)
      socket.on('close', onClose)
      socket.write(encode({ t: 'hello', id: 0, v: PROTOCOL_VERSION, client: kind }))
    })
    try {
      const hello = await pendingHello
      client = new DaemonClient(socket, hello)
      client.wire()
      return client
    } catch (e) {
      socket.destroy()
      throw e
    }
  }

  private wire(): void {
    this.socket.on('data', (chunk: string) => {
      for (const line of this.parser.push(chunk)) if (line.value) this.onMessage(line.value as DaemonMessage)
    })
    this.socket.on('error', () => { /* surfaces as close */ })
    this.socket.on('close', () => {
      this.closed = true
      for (const w of this.waiting.values()) w.reject(new Error('conexão com o tetherd fechada'))
      this.waiting.clear()
      this.emit('close')
    })
  }

  private onMessage(msg: DaemonMessage): void {
    switch (msg.t) {
      case 'ok': {
        const w = this.waiting.get(msg.id)
        if (w) { this.waiting.delete(msg.id); w.resolve(msg) }
        return
      }
      case 'error': {
        const w = this.waiting.get(msg.id)
        if (w) { this.waiting.delete(msg.id); w.reject(new DaemonError(msg.code, msg.message)) }
        return
      }
      case 'state':
        this.emit('state', msg.slot)
        return
      case 'data':
        this.emit('data', msg.slotId, msg.data)
        return
      case 'removed':
        this.emit('removed', msg.slotId)
        return
    }
  }

  /** Sends a request; resolves with the `ok` reply, rejects with DaemonError on an `error` reply. */
  request(body: RequestBody): Promise<OkReply> {
    if (this.closed) return Promise.reject(new Error('conexão com o tetherd fechada'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.socket.write(encode({ ...body, id }))
    })
  }

  /** Keystrokes (no reply). */
  input(slotId: string, data: string): void {
    if (this.closed) return
    this.socket.write(encode({ t: 'input', slotId, data }))
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }
}

function connectSocket(pipe: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe)
    socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
    socket.once('error', reject)
  })
}

/** Connects, sends `hello` and disconnects. Undefined when nothing answers. */
export async function pingDaemon(pipe: string): Promise<Hello | undefined> {
  try {
    const c = await DaemonClient.open(pipe, 'cli')
    c.close()
    return c.hello
  } catch {
    return undefined
  }
}

/** Starts tetherd detached from this process (own console-less process, nothing shared). Returns its pid. */
export function spawnDaemon(opts: { home: string; pipe: string }): number | undefined {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url))
  const child = spawn(process.execPath, [main], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TETHER_HOME: opts.home, TETHER_PIPE: opts.pipe },
  })
  child.unref()
  return child.pid
}
