// What opening a file means (core, F9 slice 2): the editor for text, the system's program for a binary or a file above
// 5 MB, never for what would run. Ctrl+P, a terminal link and the extensions' "open the source file" all ask this
// (`file:inspect`); the Quick Open extension only lists and ranks. No Electron here: the unit tests run it under plain Node.
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { FileTarget } from '../shared/file-open.ts'

/** Above this a file is not opened in the editor (the person is offered the system's program). */
export const MAX_EDITOR_BYTES = 5 * 1024 * 1024

/** Extensions never handed to the system's program from here: opening them would run them. */
const EXECUTABLE = new Set(['.exe', '.com', '.bat', '.cmd', '.msi', '.msix', '.scr', '.pif', '.lnk', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.reg', '.cpl', '.hta', '.jar', '.app', '.command', '.sh'])

/** Binary by extension, before reading anything (images, archives, documents, media, compiled code). */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.webp', '.tif', '.tiff', '.psd', '.pdf', '.zip', '.7z', '.rar', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.exe', '.dll', '.so', '.dylib', '.node', '.bin', '.dat', '.class', '.jar', '.pyc', '.wasm', '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.mov', '.avi', '.mkv', '.webm', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.msi', '.sqlite', '.db'])

function extOf(path: string): string {
  const name = basename(path).toLowerCase()
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i)
}

/** What opening `path` means: the editor for text, the system's program for binary or too large (never for what would run). */
export function inspectFile(path: string, readHead: (path: string) => Buffer): FileTarget {
  let st
  try { st = statSync(path) } catch { return { kind: 'missing' } }
  if (st.isDirectory()) return { kind: 'folder' }
  const ext = extOf(path)
  const runnable = EXECUTABLE.has(ext)
  if (BINARY_EXT.has(ext)) return { kind: 'binary', size: st.size, runnable }
  if (st.size > MAX_EDITOR_BYTES) return { kind: 'large', size: st.size, runnable }
  // VS Code's buffer check: a NUL in the first bytes means binary (UTF-16 files start with a BOM and are let through).
  let head: Buffer
  try { head = readHead(path) } catch { return { kind: 'missing' } }
  const utf16 = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
  if (!utf16 && head.includes(0)) return { kind: 'binary', size: st.size, runnable }
  return { kind: 'text', size: st.size }
}
