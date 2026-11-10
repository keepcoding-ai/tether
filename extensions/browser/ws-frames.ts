// The smallest WebSocket server side the gatekeeper needs (RFC 6455 over node:http's 'upgrade'), with no dependency: the
// handshake answer, server frames (never masked) and a parser of client frames (always masked; an unmasked frame, an unknown
// opcode, a control frame over 125 bytes or a message over the size limit ends the connection). Pure, so it is unit-tested.
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** The `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key` (undefined when the key is not a 16-byte base64). */
export function acceptOf(key: unknown): string | undefined {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return undefined
  return createHash('sha1').update(key + GUID).digest('base64')
}

export const OP_TEXT = 0x1
export const OP_CLOSE = 0x8
export const OP_PING = 0x9
export const OP_PONG = 0xa

/** One server frame (FIN set, unmasked). */
export function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length
  let head: Buffer
  if (n < 126) head = Buffer.from([0x80 | opcode, n])
  else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
  else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

export interface FrameSink {
  text(message: string): void
  ping(payload: Buffer): void
  close(): void
  /** The peer broke the protocol (or the limit): the connection must end. */
  error(reason: string): void
}

/** Reads client frames from a byte stream: feed it every chunk; it calls the sink with whole messages. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)
  private parts: Buffer[] = []
  private size = 0
  private dead = false
  private readonly sink: FrameSink
  private readonly maxMessage: number
  constructor(sink: FrameSink, maxMessage = 64 * 1024 * 1024) {
    this.sink = sink
    this.maxMessage = maxMessage
  }

  push(chunk: Buffer): void {
    if (this.dead) return
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    while (!this.dead) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0]! & 0x80) !== 0
      const opcode = b[0]! & 0x0f
      if ((b[0]! & 0x70) !== 0) return this.fail('reserved bits')
      if ((b[1]! & 0x80) === 0) return this.fail('unmasked client frame')
      let len = b[1]! & 0x7f
      let off = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (b.length < 10) return
        const big = b.readBigUInt64BE(2)
        if (big > BigInt(this.maxMessage)) return this.fail('message too large')
        len = Number(big)
        off = 10
      }
      const control = opcode >= 0x8
      if (control && (len > 125 || !fin)) return this.fail('bad control frame')
      if (!control && opcode !== 0x0 && opcode !== OP_TEXT && opcode !== 0x2) return this.fail('unknown opcode')
      if (!control && this.size + len > this.maxMessage) return this.fail('message too large')
      if (b.length < off + 4 + len) return
      const mask = b.subarray(off, off + 4)
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
      this.buf = b.subarray(off + 4 + len)
      if (opcode === OP_CLOSE) { this.dead = true; this.sink.close(); return }
      if (opcode === OP_PING) { this.sink.ping(payload); continue }
      if (opcode === OP_PONG) continue
      this.parts.push(payload)
      this.size += len
      if (fin) {
        const all = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts)
        this.parts = []
        this.size = 0
        this.sink.text(all.toString('utf8'))
      }
    }
  }

  private fail(reason: string): void {
    this.dead = true
    this.sink.error(reason)
  }
}
