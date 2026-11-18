// Basic filesystem operations, synchronous on purpose: they run inside an executor worker (or, in the inline
// fallback, in the loop through setImmediate). This is an exempt area of the sync ratchet; the coordinator never imports it.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'

let tmpSeq = 0

export const fsOps = {
  readText: (path: string): string => readFileSync(path, 'utf8'),
  /** Write to a temp name beside the target and rename over it, so a reader never sees half a file. */
  writeTextAtomic: (path: string, text: string): null => {
    const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
    try {
      writeFileSync(tmp, text)
      renameSync(tmp, path)
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
      throw e
    }
    return null
  },
  appendText: (path: string, text: string): null => { appendFileSync(path, text); return null },
  rm: (path: string): null => { rmSync(path, { recursive: true, force: true }); return null },
  mkdirp: (path: string): null => { mkdirSync(path, { recursive: true }); return null },
  stat: (path: string) => {
    const s = statSync(path)
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() }
  },
  readdir: (path: string) => readdirSync(path, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory() })),
  exists: (path: string): boolean => existsSync(path),
  /** sha256 hex of a file: the long kind of operation, lane `work`. */
  hashFile: (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex'),
}
