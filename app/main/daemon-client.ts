// Client side of src/daemon/protocol.ts: NDJSON over a named pipe. Requests get numbered here and
// matched to their reply by id; events are forwarded to a listener.
import { connect, type Socket } from 'node:net'
import { PROTOCOL_VERSION, type DaemonMessage, type Event as DaemonEvent, type Notice, type Reply, type Request } from '../../src/daemon/protocol.ts'
import type { RequestBody } from '../shared/api.ts'

interface Pending { resolve: (r: Reply) => void; reject: (e: Error) => void }

export class DaemonClient {
  private sock: Socket | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  onEvent: ((ev: DaemonEvent) => void) | undefined
  /** Called once per lost connection (after a successful connect). */
  onClose: ((reason: string) => void) | undefined

  get connected(): boolean { return this.sock !== undefined }

  async connect(pipe: string, timeoutMs = 3000): Promise<void> {
    this.close()
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe)
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`tempo esgotado ao conectar em ${pipe}`)) }, timeoutMs)
      s.once('connect', () => { clearTimeout(timer); resolve(s) })
      s.once('error', err => { clearTimeout(timer); reject(err) })
    })
    sock.setEncoding('utf8')
    let buffer = ''
    sock.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim()) this.handle(line)
      }
    })
    const lost = (reason: string): void => {
      if (this.sock !== sock) return
      this.sock = undefined
      this.failPending(new Error(reason))
      this.onClose?.(reason)
    }
    sock.on('close', () => lost('conexão com o tetherd fechada'))
    sock.on('error', (err: Error) => lost(err.message))
    this.sock = sock
    const hello = await this.request({ t: 'hello', v: PROTOCOL_VERSION, client: 'app' })
    if (hello.t === 'error') throw new Error(`hello recusado: ${hello.message}`)
    if (hello.hello && hello.hello.v !== PROTOCOL_VERSION) throw new Error(`versão do protocolo incompatível: daemon ${hello.hello.v}, app ${PROTOCOL_VERSION}`)
  }

  close(): void {
    const s = this.sock
    this.sock = undefined
    if (s) { s.removeAllListeners(); s.destroy() }
    this.failPending(new Error('conexão encerrada'))
  }

  request(body: RequestBody): Promise<Reply> {
    const sock = this.sock
    if (!sock) return Promise.reject(new Error('sem conexão com o tetherd'))
    const id = this.nextId++
    const req = { ...body, id } as Request
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      sock.write(JSON.stringify(req) + '\n')
    })
  }

  notice(notice: Notice): void {
    this.sock?.write(JSON.stringify(notice) + '\n')
  }

  private handle(line: string): void {
    let msg: DaemonMessage
    try { msg = JSON.parse(line) as DaemonMessage } catch { return }
    if (msg.t === 'ok' || msg.t === 'error') {
      const p = this.pending.get(msg.id)
      if (p) { this.pending.delete(msg.id); p.resolve(msg) }
      return
    }
    this.onEvent?.(msg)
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}
