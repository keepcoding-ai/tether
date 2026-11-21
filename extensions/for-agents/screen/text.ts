// The screen as text: the pure part. `XtermTerminal` is the slice of @xterm/headless the reader uses (the vendored package is
// not typechecked: it is imported by path at the first read), and `readText` turns a fed terminal into a ScreenText.

/** What the reader uses of a buffer line and of the terminal (structural: the vendored package has no types here). */
export interface XtermLine { isWrapped: boolean; translateToString(trimRight?: boolean): string }
export interface XtermBuffer { readonly baseY: number; readonly length: number; getLine(y: number): XtermLine | undefined }
export interface XtermTerminal {
  readonly rows: number
  readonly cols: number
  readonly buffer: { readonly active: XtermBuffer }
  write(data: string, callback?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
}
export interface XtermModule {
  Terminal: new (options: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => XtermTerminal
}

export interface ScreenText {
  /** The screen now: the rows from baseY to baseY+rows, the wrapped ones (isWrapped) joined into one line. */
  screen: string[]
  /** The history: the rows from 0 to baseY, wrapped rows joined. */
  history: string[]
  cols: number
  rows: number
  /** The offset read up to: the `since` of the next read. */
  end: number
}

/** The lines of rows [from, to): a wrapped row is glued to the line before it, and a row that continues on the next one keeps its trailing blanks. */
function linesOf(buf: XtermBuffer, from: number, to: number, join: boolean): string[] {
  const out: string[] = []
  for (let i = from; i < to; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    const continues = join && buf.getLine(i + 1)?.isWrapped === true
    const text = line.translateToString(!continues)
    if (join && line.isWrapped && out.length) out[out.length - 1] += text
    else out.push(text)
  }
  return out
}

/**
 * The text of a terminal that has been fed: the screen now and the history (of the active buffer; the alternate one has none).
 * `joinWrapped` false gives one line per row of the screen, as a person sees it.
 */
export function readText(term: XtermTerminal, end: number, joinWrapped = true): ScreenText {
  const buf = term.buffer.active
  return { screen: linesOf(buf, buf.baseY, buf.baseY + term.rows, joinWrapped), history: linesOf(buf, 0, buf.baseY, joinWrapped), cols: term.cols, rows: term.rows, end }
}

/** The screen as the probes recorded it: lines joined by a line feed, the trailing whitespace of the whole cut. */
export function screenString(text: ScreenText): string {
  return text.screen.join('\n').trimEnd()
}

/** The history as one string, the same way. */
export function historyString(text: ScreenText): string {
  return text.history.join('\n').trimEnd()
}
