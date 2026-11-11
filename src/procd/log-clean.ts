// Raw PTY (ConPTY) output → clean text lines for the on-disk log. Pure: no clock, no I/O.
// ConPTY paints rather than prints: it uses cursor-forward for spaces inside a line, absolute positioning in
// place of a line break, a window title (OSC 0) at start, and SGR colours everywhere; a blind strip glues words.
// Order matters: CUP → '\n', CUF → n spaces, then OSC, CSI, two-byte escapes and control characters go.
const CSI_CUP = /\x1b\[\d+;\d+[Hf]/g
const CSI_CUF = /\x1b\[(\d*)C/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC2 = /\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOPVWXZ\\^_c]/g
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g
/** A complete escape sequence starting at the last ESC of a chunk; anything else there is a partial one to hold. */
const COMPLETE_TAIL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[=>78DEHMNOPVWXZ\\^_c])/y

export function stripAnsi(s: string): string {
  return s
    .replace(CSI_CUP, '\n')
    .replace(CSI_CUF, (_m, n: string) => ' '.repeat(Number(n) || 1))
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC2, '')
    .replace(CTRL, '')
}

/** A lone `\r` rewrites the line from column 0: "abc\rXY" → "XYc". */
export function resolveCr(line: string): string {
  let cur = ''
  for (const p of line.split('\r')) cur = p.length >= cur.length ? p : p + cur.slice(p.length)
  return cur
}

const finish = (line: string): string => resolveCr(line).replace(/\s+$/, '')

export interface LineCleaner {
  /** Feeds a raw chunk; returns the lines it completed, clean (no trailing spaces, no escapes). */
  push(chunk: string): string[]
  /** The pending last line (output that did not end in a newline yet), if it has any text. */
  flush(): string[]
}

/** Holds an escape sequence split between two chunks and the unterminated last line until they complete. */
export function makeLineCleaner(): LineCleaner {
  let rawTail = ''
  let pending = ''
  return {
    push(chunk) {
      let s = rawTail + chunk
      rawTail = ''
      const i = s.lastIndexOf('\x1b')
      if (i >= 0) {
        COMPLETE_TAIL.lastIndex = i
        if (!COMPLETE_TAIL.test(s)) { rawTail = s.slice(i); s = s.slice(0, i) }
      }
      pending += stripAnsi(s)
      const lines = pending.split('\n')
      pending = lines.pop()!
      return lines.map(finish)
    },
    flush() {
      const line = finish(pending)
      pending = ''
      return line ? [line] : []
    },
  }
}
