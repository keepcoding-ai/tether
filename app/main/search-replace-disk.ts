// Applies the search panel's "Replace" to files on disk, main-process side (no Electron: unit tests run it under plain Node).
//
// AI agents edit the same files while the person searches, so a range the search reported can describe text that
// no longer exists. Every edit therefore carries the text the search found (`expected`); a file is written only if
// ALL its ranges still hold exactly that text, otherwise it is left untouched (all or nothing per file). A second
// guard re-stats the file right before writing: if size or mtime moved since it was read, nothing is written.
//
// Positions follow Monaco: 1-based lines, 1-based columns counted in UTF-16 code units, end exclusive. Lines are
// split on "\n" only (the way ripgrep counts); a "\r" before the "\n" belongs to its line and is never part of a
// single-line range. Encoding (UTF-8/UTF-16 BOMs) and every untouched byte are preserved; the write goes to the
// file itself (no temp file) so permissions and links stay.
import { readFile, stat, writeFile } from 'node:fs/promises'

/** A range as Monaco's: 1-based lines, 1-based columns in UTF-16 code units; the end is exclusive. */
export interface EditRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface DiskEdit {
  range: EditRange
  /** The text the search found in the range. */
  expected: string
  /** What replaces it. */
  text: string
}

export interface FileEdits {
  path: string
  edits: DiskEdit[]
}

export type FileOutcome =
  | { path: string; status: 'replaced'; count: number }
  | { path: string; status: 'changed' } // the file no longer holds the found text: nothing written
  | { path: string; status: 'missing' }
  | { path: string; status: 'refused' } // outside what `allowed` permits
  | { path: string; status: 'failed'; message: string } // message in Portuguese

/** Offset of every line start; lines split on "\n" only. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** End of a line's content (offset of its "\n", or the text end). */
function lineEnd(text: string, starts: readonly number[], line: number): number {
  const next = starts[line]
  return next === undefined ? text.length : next - 1
}

/** Offset of a position, or undefined when the line or column is outside the text. */
function offsetOf(text: string, starts: readonly number[], line: number, column: number): number | undefined {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return undefined
  const start = starts[line - 1]
  if (start === undefined) return undefined
  const offset = start + column - 1
  return offset <= lineEnd(text, starts, line) ? offset : undefined
}

/**
 * Applies the edits to `text`. Returns undefined when any range is out of bounds, ranges overlap, or the text in a
 * range is not the `expected` one: the caller must then write nothing.
 */
export function applyEdits(text: string, edits: readonly DiskEdit[]): string | undefined {
  const starts = lineStarts(text)
  const resolved: { start: number; end: number; text: string }[] = []
  for (const edit of edits) {
    const r = edit.range
    const start = offsetOf(text, starts, r.startLineNumber, r.startColumn)
    const end = offsetOf(text, starts, r.endLineNumber, r.endColumn)
    if (start === undefined || end === undefined || end < start) return undefined
    // A "\r" ending a line is part of the line break for single-line ranges.
    if (r.startLineNumber === r.endLineNumber) {
      const limit = lineEnd(text, starts, r.endLineNumber)
      if (end > limit - (text[limit - 1] === '\r' && limit > (starts[r.endLineNumber - 1] ?? 0) ? 1 : 0)) return undefined
    }
    if (text.slice(start, end) !== edit.expected) return undefined
    resolved.push({ start, end, text: edit.text })
  }
  resolved.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1]
    const cur = resolved[i]
    if (prev && cur && cur.start < prev.end) return undefined
  }
  // Back to front: earlier offsets stay valid.
  let out = text
  for (let i = resolved.length - 1; i >= 0; i--) {
    const e = resolved[i]
    if (e) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  return out
}

type Encoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'

const NOT_SUPPORTED = 'A codificação deste arquivo não é suportada para substituição.'

function decode(bytes: Buffer): { text: string; encoding: Encoding } | undefined {
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3)), encoding: 'utf8-bom' }
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2)), encoding: 'utf16le' }
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const body = Buffer.from(bytes.subarray(2))
      if (body.length % 2 !== 0) return undefined
      return { text: new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(body.swap16()), encoding: 'utf16be' }
    }
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf8' }
  } catch {
    return undefined
  }
}

function encode(text: string, encoding: Encoding): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
    default:
      return Buffer.from(text, 'utf8')
  }
}

function ioMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'Sem permissão para gravar neste arquivo.'
  if (code === 'EBUSY' || code === 'ETXTBSY') return 'O arquivo está em uso por outro programa.'
  return error instanceof Error ? error.message : String(error)
}

/** Replaces in one file; writes only if every edit still matches and the file did not move meanwhile. */
export async function replaceInFile(file: FileEdits): Promise<FileOutcome> {
  const { path } = file
  try {
    const before = await stat(path)
    const bytes = await readFile(path)
    const decoded = decode(bytes)
    if (!decoded) return { path, status: 'failed', message: NOT_SUPPORTED }
    const next = applyEdits(decoded.text, file.edits)
    if (next === undefined) return { path, status: 'changed' }
    const after = await stat(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { path, status: 'changed' }
    await writeFile(path, encode(next, decoded.encoding))
    return { path, status: 'replaced', count: file.edits.length }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { path, status: 'missing' }
    return { path, status: 'failed', message: ioMessage(error) }
  }
}

/** One file at a time, in the order given; an aborted signal stops before the next file (the rest are not reported). */
export async function replaceInFiles(
  files: readonly FileEdits[],
  opts: { allowed(path: string): boolean; signal?: AbortSignal },
): Promise<FileOutcome[]> {
  const out: FileOutcome[] = []
  for (const file of files) {
    if (opts.signal?.aborted) break
    out.push(opts.allowed(file.path) ? await replaceInFile(file) : { path: file.path, status: 'refused' })
  }
  return out
}
