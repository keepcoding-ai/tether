// The client half of the handshake every tether pipe speaks (pipe-key.ts): replies with id 0 read one at a time, and
// what was read past the last one handed on to the client's own parser.
import { timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { LineParser, type ParsedLine } from './ndjson.ts'

// ---- the remote portal's credential (fio-spec 1.5, M-5) ---------------------------------------------------------
// The `remote` extension draws 32 random bytes for each portal process it spawns, hands them to that process on its stdin
// and registers them here for its tetherd (by home: a test process may run several). A hello `client:'remote'` counts as
// `remote` only when it presents them; anything else is `cli`. A new spawn replaces the credential, so the previous
// portal's is dead. It is a bar, not a boundary: a process of the same user is still the real limit.

const portalCreds = new Map<string, Buffer>()

/** The credential of the portal now serving `home` (32 bytes), or undefined to accept no portal at all. */
export function setPortalCredential(home: string, cred: Buffer | undefined): void {
  const old = portalCreds.get(home)
  if (old) old.fill(0)
  if (cred) portalCreds.set(home, Buffer.from(cred))
  else portalCreds.delete(home)
}

/** Whether `presented` (64 hex from the hello) is the credential of `home`'s portal, compared in constant time. */
export function isPortalCredential(home: string, presented: unknown): boolean {
  const want = portalCreds.get(home)
  if (!want || typeof presented !== 'string' || !/^[0-9a-f]{64}$/.test(presented)) return false
  return timingSafeEqual(Buffer.from(presented, 'hex'), want)
}

/** Any reply of the handshake: `ok` or `error`, id 0. */
export interface StepReply { t: 'ok' | 'error'; id: number }

/** Reads the handshake's replies (id 0) one at a time; lines before each reply (an older server's events) are skipped. */
export class HandshakeReader<R extends StepReply> {
  private readonly parser = new LineParser()
  private lines: ParsedLine[] = []
  private closed = false
  private waiter: { resolve: (r: R) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | undefined
  private readonly socket: Socket
  /** The error a closed connection or a silent server gives (each client has its own class for "nobody answers"). */
  private readonly silent: (why: 'closed' | 'timeout') => Error

  constructor(socket: Socket, silent: (why: 'closed' | 'timeout') => Error) {
    this.socket = socket
    this.silent = silent
    socket.setEncoding('utf8')
    socket.on('data', this.onData)
    socket.on('close', this.onClose)
  }

  private readonly onData = (chunk: string): void => {
    this.lines.push(...this.parser.push(chunk))
    this.pump()
  }

  private readonly onClose = (): void => {
    this.closed = true
    this.pump()
  }

  private pump(): void {
    const w = this.waiter
    if (!w) return
    while (this.lines.length) {
      const v = this.lines.shift()!.value as R | undefined
      if (v && (v.t === 'ok' || v.t === 'error') && v.id === 0) {
        this.waiter = undefined
        clearTimeout(w.timer)
        w.resolve(v)
        return
      }
    }
    if (this.closed) {
      this.waiter = undefined
      clearTimeout(w.timer)
      w.reject(this.silent('closed'))
    }
  }

  next(timeoutMs = 5_000): Promise<R> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(this.silent('timeout')) }, timeoutMs)
      this.waiter = { resolve, reject, timer }
      this.pump()
    })
  }

  /** Stops reading; what was read past the last reply goes on to the client. */
  release(): { parser: LineParser; lines: ParsedLine[] } {
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onClose)
    if (this.waiter) clearTimeout(this.waiter.timer)
    this.waiter = undefined
    const lines = this.lines
    this.lines = []
    return { parser: this.parser, lines }
  }
}
