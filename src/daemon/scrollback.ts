// Ring buffer of raw PTY output (strings as node-pty emits them). Bounded by total characters:
// when full, whole chunks fall off the front. A client that attaches later replays it to its terminal.

export const DEFAULT_SCROLLBACK_CHARS = 1_000_000

export class Scrollback {
  private chunks: string[] = []
  private total = 0
  readonly capacity: number

  constructor(capacity: number = DEFAULT_SCROLLBACK_CHARS) {
    this.capacity = capacity
  }

  push(data: string): void {
    if (data.length === 0) return
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

  text(): string {
    return this.chunks.join('')
  }

  clear(): void {
    this.chunks = []
    this.total = 0
  }
}
