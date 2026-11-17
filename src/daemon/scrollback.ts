// Ring buffer of raw PTY output (strings as node-pty emits them). Bounded by total characters:
// when full, whole chunks fall off the front. A client that attaches later replays it to its terminal.

export const DEFAULT_SCROLLBACK_CHARS = 1_000_000

export class Scrollback {
  private chunks: string[] = []
  private total = 0
  readonly capacity: number
  // Offsets are monotonic counts of UTF-16 code units (string length), the unit the ring is bounded by.
  private written = 0

  constructor(capacity: number = DEFAULT_SCROLLBACK_CHARS) {
    this.capacity = capacity
  }

  push(data: string): void {
    if (data.length === 0) return
    this.written += data.length
    if (data.length >= this.capacity) {
      this.chunks = [data.slice(-this.capacity)]
      this.total = this.chunks[0]!.length
      return
    }
    this.chunks.push(data)
    this.total += data.length
    while (this.total > this.capacity && this.chunks.length > 1) {
      this.total -= this.chunks.shift()!.length
    }
  }

  get length(): number {
    return this.total
  }

  /** Total code units ever pushed (monotonic, survives overflow and clear). */
  get end(): number {
    return this.written
  }

  /** Offset of the oldest code unit still in the ring. */
  get start(): number {
    return this.written - this.total
  }

  /** What is missing after `off`. Out-of-ring or invalid offsets get the whole ring with reset=true. */
  since(off: number): { data: string; off: number; reset: boolean } {
    const start = this.start
    const text = this.text()
    if (!Number.isInteger(off) || off < start || off > this.written) return { data: text, off: this.written, reset: true }
    return { data: text.slice(off - start), off: this.written, reset: false }
  }

  text(): string {
    return this.chunks.join('')
  }

  clear(): void {
    this.chunks = []
    this.total = 0
  }
}
