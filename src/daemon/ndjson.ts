// NDJSON framing shared by the daemon and its clients: one JSON object per line, UTF-8.
// Chunks from the socket may split a line anywhere, so the parser keeps the partial tail.

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

export interface ParsedLine {
  /** The parsed object, or undefined when the line is not valid JSON / not an object. */
  value?: Record<string, unknown>
  /** The raw line (for logging and for the id lookup of a malformed line). */
  raw: string
}

export class LineParser {
  private tail = ''

  /** Feeds a chunk; returns every complete line it closed (empty lines are skipped). */
  push(chunk: string): ParsedLine[] {
    const text = this.tail + chunk
    const parts = text.split('\n')
    this.tail = parts.pop() ?? ''
    const out: ParsedLine[] = []
    for (const part of parts) {
      const raw = part.endsWith('\r') ? part.slice(0, -1) : part
      if (raw.trim() === '') continue
      out.push({ raw, value: parseObject(raw) })
    }
    return out
  }
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Best-effort request id of a malformed line, so the sender still gets its error reply. */
export function guessId(raw: string): number | undefined {
  const m = /"id"\s*:\s*(\d+)/.exec(raw)
  return m ? Number(m[1]) : undefined
}
