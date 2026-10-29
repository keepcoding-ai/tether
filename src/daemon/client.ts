// Typed client of tetherd for the app and the CLI: connect (spawning the daemon detached when it is not
// running), send requests and await their replies, receive `state` / `data` / `removed` events.
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureRenamedNode, exeLog } from '../core/exe.ts'
import { tetherHome } from '../core/paths.ts'
import { encode, LineParser } from './ndjson.ts'
import { PROTOCOL_VERSION, pipePath, type DaemonMessage, type ErrorCode, type Profile, type Reply, type Request, type SlotState } from './protocol.ts'

export type Hello = { v: number; pid: number; version: string; exec?: string }
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

export interface ClientOptions extends Partial<SpawnOptions> {
  home?: string
  pipe?: string
  client?: 'app' | 'cli' | 'test'
  /** Start tetherd (detached) when nothing answers on the pipe. Default true. */
  spawn?: boolean
  /** Max wait for the daemon to come up after spawning it (ms). Default 15 000. */
  startTimeoutMs?: number
}

/** Something answers on the pipe, but it is not a tetherd (no `hello` came back). The client never spawns over it. */
export class NotTetherError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotTetherError'
  }
}

/** How many times a connection that answers nothing is retried before the pipe counts as taken by a stranger
 *  (a tetherd that is just going down closes the socket before the hello too). */
const FOREIGN_RETRIES = 3
const FOREIGN_RETRY_MS = 300

type Events = {
  state: [slot: SlotState]
  data: [slotId: string, data: string]
  removed: [slotId: string]
  profiles: [profiles: Profile[]]
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
    let foreign = 0
    const foreignError = (e: NotTetherError): Error =>
      new Error(`o canal ${pipe} está ocupado por um programa que não é o tetherd (${e.message}); feche-o ou use outro TETHER_PIPE`)
    // Something listens but never says hello: a stranger owns the pipe (or a tetherd is shutting down right now).
    // Spawning over it would only make the new daemon exit with "pipe taken"; retry a little, then give up clearly.
    const tolerate = async (e: unknown): Promise<boolean> => {
      if (!(e instanceof NotTetherError)) return false
      if (++foreign >= FOREIGN_RETRIES) throw foreignError(e)
      await new Promise((r) => setTimeout(r, FOREIGN_RETRY_MS))
      return true
    }
    for (;;) {
      try {
        return await DaemonClient.open(pipe, kind)
      } catch (e) {
        if (opts.spawn === false || e instanceof DaemonError) throw e // a tetherd answered (and refused): nothing to spawn
        if (!(await tolerate(e))) break // nothing listening: start one
      }
    }
    await spawnDaemon({ home, pipe, execPath: opts.execPath, mainPath: opts.mainPath, env: opts.env })
    const deadline = Date.now() + (opts.startTimeoutMs ?? 15_000)
    let lastError: Error | undefined
    while (Date.now() < deadline) {
      try {
        return await DaemonClient.open(pipe, kind)
      } catch (e) {
        if (e instanceof DaemonError) throw e
        lastError = e as Error
        if (!(await tolerate(e))) await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error(`tetherd não respondeu em ${pipe}: ${lastError?.message ?? 'timeout'}`)
  }

  /** Connects and completes the hello handshake; no spawning. */
  static async open(pipe: string, kind: 'app' | 'cli' | 'test'): Promise<DaemonClient> {
    const socket = await connectSocket(pipe)
    let client: DaemonClient | undefined
    const pendingHello = new Promise<Hello>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NotTetherError('sem resposta ao hello')), 5_000)
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
        reject(new NotTetherError('conexão fechada antes do hello'))
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
      case 'profiles':
        this.emit('profiles', msg.profiles)
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

export interface SpawnOptions {
  home: string
  pipe: string
  /** The node that runs the daemon (default: this process' node). Electron passes a system node: its own cannot load node-pty. */
  execPath?: string
  /** The daemon's entry point (default: src/daemon/main.ts next to this file). */
  mainPath?: string
  /** Base environment (default: process.env). TETHER_HOME / TETHER_PIPE are always set from `home` / `pipe`. */
  env?: NodeJS.ProcessEnv
  /** Where to note what was done about the executable (default: a line in <home>/tetherd.log). */
  log?: (msg: string) => void
}

/**
 * Starts tetherd outside this process' tree, sharing nothing with it. Resolves with the daemon's pid once it
 * was created (the pipe may still take a moment to answer).
 *
 * The daemon runs as <home>/bin/tetherd.exe, a copy of `execPath` kept up to date by ensureRenamedNode, so
 * that killing every node.exe does not reach it; TETHER_NODE tells the daemon which node it was made from
 * (the soul panels get their own copy, tether-soul.exe, from the same source). The copy failing is logged and
 * the plain node runs instead.
 *
 * Windows: a plain detached spawn is not enough. The daemon would stay a child of the caller, so "End task"
 * / `taskkill /T` on the app takes it (and every agent) down; and CreateProcess through libuv always inherits
 * handles, so the daemon would hold whatever the app holds (Playwright's CDP pipe, for one). The daemon is
 * therefore started by a short-lived `powershell Start-Process`: ShellExecuteEx creates the process without
 * handle inheritance, and the PowerShell exits at once, leaving the daemon with a dead parent, outside any
 * tree a kill could walk. Measured: handles not inherited, ~1.3 s. (Verified by test/unit/daemon.spawn.test.ts.)
 */
export function spawnDaemon(opts: SpawnOptions): Promise<number | undefined> {
  const node = opts.execPath ?? process.execPath
  const execPath = ensureRenamedNode(opts.home, 'tetherd', node, opts.log ?? exeLog(opts.home, 'spawn')).path
  const mainPath = opts.mainPath ?? fileURLToPath(new URL('./main.ts', import.meta.url))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v
  env.TETHER_HOME = opts.home
  env.TETHER_PIPE = opts.pipe
  env.TETHER_NODE = node
  if (process.platform !== 'win32') {
    const child = spawn(execPath, [mainPath], { detached: true, stdio: 'ignore', env })
    child.unref()
    return Promise.resolve(child.pid)
  }
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const script =
    `$p = Start-Process -FilePath ${q(execPath)} -ArgumentList ${q(`"${mainPath}"`)} -WorkingDirectory ${q(dirname(mainPath))} ` +
    '-WindowStyle Hidden -PassThru; Write-Output $p.Id'
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env, windowsHide: true, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`não consegui iniciar o tetherd: ${stderr.trim() || err.message}`))
        const pid = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(pid) ? undefined : pid)
      })
  })
}
