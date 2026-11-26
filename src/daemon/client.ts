// Typed client of tetherd for the app and the CLI: connect (spawning the daemon detached when it is not
// running), send requests and await their replies, receive `state` / `data` / `removed` events.
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentExecutor } from '../agents/agent-exec.ts'
import { exeLog, type ExeName, type ExeResult } from '../core/exe.ts'
import type { Probe } from '../core/perf-probe.ts'
import { tetherHome } from '../core/paths.ts'
import { HandshakeReader } from './handshake.ts'
import { encode, LineParser, type ParsedLine } from './ndjson.ts'
import { clientProof, daemonProof, isNonce, newNonce, pipeKeyPath, readPipeKey, sameProof, servedHome } from './pipe-key.ts'
import { PROTOCOL_VERSION, pipePath, type DaemonMessage, type DeskMap, type ErrorCode, type ObjectKind, type PauseBatch, type ProcState, type Profile, type Reply, type Request, type SlotState } from './protocol.ts'

/** `legacy`: a tetherd before protocol 2 (no proof either way), reached only by an `open` that allows it (see OpenOptions). */
export type Hello = { v: number; pid: number; version: string; exec?: string; client?: string; legacy?: true }

export interface OpenOptions {
  /** This client reads hosted panes straight from tether-ptyd (see the `hello` request). */
  direct?: boolean
  /** The tether home whose key proves this client (pipe-key.ts). Default: the home of a tetherd in this process on that pipe, else tetherHome(). */
  home?: string
  /**
   * Accept a tetherd before protocol 2, which checks nobody: only to find out it is there and to shut it down (ping,
   * restart). Without it such a tetherd is refused with `daemon-outdated`.
   */
  legacy?: boolean
  /** The remote portal's credential (64 hex), sent in the hello of a `remote` client (see the `hello` request). */
  cred?: string
}
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
  /** This client reads hosted panes straight from tether-ptyd: tetherd sends it no output of them (see the `hello` request). */
  direct?: boolean
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
  data: [slotId: string, data: string, probe?: Probe]
  removed: [slotId: string]
  profiles: [profiles: Profile[]]
  pause: [batch: PauseBatch]
  proc: [proc: ProcState]
  'proc-removed': [name: string]
  'proc-data': [name: string, data: string]
  /** Agent door: the desk map changed. */
  desks: [map: DeskMap]
  /** Agent door: one key of an extension's object data changed (`value` undefined: deleted). */
  object: [e: { ext: string; kind: ObjectKind; objectId: string; key: string; value?: unknown }]
  /** Agent door: an extension's event (`ext` set by the daemon's core, never by the extension). */
  'ext-event': [e: { ext: string; name: string; payload?: unknown }]
  close: []
}

export class DaemonClient extends EventEmitter<Events> {
  readonly hello: Hello
  private readonly socket: Socket
  private parser = new LineParser()
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
    const how: OpenOptions = opts.direct ? { direct: true, home } : { home }
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
        return await DaemonClient.open(pipe, kind, how)
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
        return await DaemonClient.open(pipe, kind, how)
      } catch (e) {
        if (e instanceof DaemonError) throw e
        lastError = e as Error
        if (!(await tolerate(e))) await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error(`tetherd não respondeu em ${pipe}: ${lastError?.message ?? 'timeout'}`)
  }

  /**
   * Connects and completes the handshake (pipe-key.ts): `auth` with this client's nonce, a check of tetherd's proof (a
   * program that took the pipe's name is refused before it learns anything), then the hello with this client's proof.
   * No spawning. A tetherd before protocol 2 is refused with `daemon-outdated` unless `how.legacy`.
   */
  static async open(pipe: string, kind: 'app' | 'cli' | 'test' | 'remote', how: OpenOptions = {}): Promise<DaemonClient> {
    const home = how.home ?? servedHome(pipe) ?? tetherHome()
    const socket = await connectSocket(pipe)
    const replies = new HandshakeReader<Reply>(socket, (why) => new NotTetherError(why === 'closed' ? 'conexão fechada antes do hello' : 'sem resposta ao hello'))
    try {
      const nonce = newNonce()
      socket.write(encode({ t: 'auth', id: 0, nonce }))
      const auth = await replies.next()
      let hello: Hello
      if (auth.t === 'error' && auth.code === 'bad-request') {
        // A tetherd before protocol 2 does not know `auth`: its own hello (unproven) says who it is.
        socket.write(encode({ t: 'hello', id: 0, v: 1, client: kind }))
        const old = await replies.next()
        if (old.t !== 'ok' || !old.hello) throw new NotTetherError('resposta inesperada ao hello')
        if (!how.legacy) throw new DaemonError('daemon-outdated', outdatedMessage(old.hello))
        hello = { ...old.hello, legacy: true }
      } else if (auth.t === 'error') {
        throw new DaemonError(auth.code, auth.message)
      } else {
        const theirs = auth.auth
        if (!theirs || !isNonce(theirs.nonce) || typeof theirs.proof !== 'string') throw new NotTetherError('resposta de identificação inválida')
        const key = await readPipeKey(home)
        if (!key) throw new DaemonError('auth-failed', `não encontrei a chave do tetherd em ${pipeKeyPath(home)}: este cliente e o tetherd usam a mesma pasta do tether (TETHER_HOME)?`)
        if (!sameProof(theirs.proof, daemonProof(key, nonce, theirs.nonce))) throw new NotTetherError(`quem responde não provou ter a chave de ${pipeKeyPath(home)}`)
        const proof = clientProof(key, nonce, theirs.nonce)
        socket.write(encode({
          t: 'hello', id: 0, v: PROTOCOL_VERSION, client: kind, ...(how.direct ? { direct: true } : {}), proof,
          ...(kind === 'remote' && how.cred !== undefined ? { cred: how.cred } : {}),
        }))
        const r = await replies.next()
        if (r.t === 'error') throw new DaemonError(r.code, r.message)
        if (!r.hello) throw new NotTetherError('resposta inesperada ao hello')
        hello = r.hello
      }
      const client = new DaemonClient(socket, hello)
      client.wire(replies.release())
      return client
    } catch (e) {
      replies.release()
      socket.destroy()
      throw e
    }
  }

  /** `start`: the parser of the handshake (it may hold the beginning of the next line) and the lines it read past it. */
  private wire(start: { parser: LineParser; lines: ParsedLine[] }): void {
    this.parser = start.parser
    for (const line of start.lines) if (line.value) this.onMessage(line.value as DaemonMessage)
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
        this.emit('data', msg.slotId, msg.data, msg.probe)
        return
      case 'removed':
        this.emit('removed', msg.slotId)
        return
      case 'profiles':
        this.emit('profiles', msg.profiles)
        return
      case 'pause':
        this.emit('pause', msg.batch)
        return
      case 'proc':
        this.emit('proc', msg.proc)
        return
      case 'proc-removed':
        this.emit('proc-removed', msg.name)
        return
      case 'proc-data':
        this.emit('proc-data', msg.name, msg.data)
        return
      case 'desks':
        this.emit('desks', msg.map)
        return
      case 'object': {
        const { t: _t, ...e } = msg
        this.emit('object', e)
        return
      }
      case 'ext-event': {
        const { t: _t, ...e } = msg
        this.emit('ext-event', e)
        return
      }
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

  /** Keystrokes (no reply); `probe` times key->echo (see Notice). */
  input(slotId: string, data: string, probe?: Probe): void {
    if (this.closed) return
    this.socket.write(encode(probe ? { t: 'input', slotId, data, probe } : { t: 'input', slotId, data }))
  }

  /** Keystrokes already written to the pane in the host (direct clients): tetherd only feeds the slot's attention (see Notice). */
  typed(slotId: string, data: string): void {
    if (this.closed) return
    this.socket.write(encode({ t: 'typed', slotId, data }))
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }
}

/** The person reads this when the tetherd running is older than this client (protocol 1: it checks nobody). */
function outdatedMessage(h: Hello): string {
  return `o tetherd em execução (versão ${h.version}, pid ${h.pid}) é anterior a esta versão do tether e não confere quem se conecta a ele: `
    + 'reinicie o tetherd (no app: Reiniciar o tetherd; no terminal: tether daemon restart). Os agentes retomam as sessões.'
}

function connectSocket(pipe: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe)
    socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
    socket.once('error', reject)
  })
}

/** Connects, completes the hello and disconnects. Undefined when no tetherd answers (an older one counts: see OpenOptions.legacy). */
export async function pingDaemon(pipe: string, home?: string): Promise<Hello | undefined> {
  try {
    const c = await DaemonClient.open(pipe, 'cli', { legacy: true, ...(home !== undefined ? { home } : {}) })
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
  return spawnDetachedNode({
    name: 'tetherd',
    what: 'o tetherd',
    home: opts.home,
    node: opts.execPath ?? process.execPath,
    mainPath: opts.mainPath ?? fileURLToPath(new URL('./main.ts', import.meta.url)),
    env: { ...(opts.env ?? process.env), TETHER_HOME: opts.home, TETHER_PIPE: opts.pipe },
    ...(opts.log ? { log: opts.log } : {}),
  })
}

export interface DetachedNodeOptions {
  /** The executable name it runs under (<home>/bin/<name>.exe, see core/exe.ts). */
  name: ExeName
  /** For the error message: "o tetherd", "o anfitrião de processos". */
  what: string
  home: string
  /** The node the renamed executable is made from (TETHER_NODE in the child's environment). */
  node: string
  mainPath: string
  /** The child's complete environment (TETHER_NODE is added). */
  env: NodeJS.ProcessEnv
  log?: (msg: string) => void
}

/**
 * The renamed node copy for a detached start, made by the executor's `renamedNode` operation: on tetherd's workers inside the
 * daemon, on the inline executor (same operation, run in its own loop) in the CLI and Electron main.
 */
async function renamedNodeFor(opts: DetachedNodeOptions): Promise<ExeResult> {
  const log = opts.log ?? exeLog(opts.home, 'spawn')
  const reply = await agentExecutor().run('renamedNode', [opts.home, opts.name, opts.node, process.platform])
  for (const line of reply.logs) log(line)
  return reply.result
}

/**
 * Starts a long-lived tether node process (tetherd, tether-procd) outside the caller's tree, as described on
 * spawnDaemon. Resolves with its pid once created.
 */
export async function spawnDetachedNode(opts: DetachedNodeOptions): Promise<number | undefined> {
  const exe = await renamedNodeFor(opts)
  const execPath = exe.path
  const mainPath = opts.mainPath
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v
  env.TETHER_NODE = opts.node
  if (process.platform !== 'win32') {
    // macOS: the real node with its name in argv[0] (see core/exe.ts); elsewhere the renamed file names itself.
    const child = spawn(execPath, [mainPath], { detached: true, stdio: 'ignore', env, ...(exe.argv0 ? { argv0: exe.argv0 } : {}) })
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
        if (err) return reject(new Error(`não consegui iniciar ${opts.what}: ${stderr.trim() || err.message}`))
        const pid = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isNaN(pid) ? undefined : pid)
      })
  })
}
