// Operations the daemon extensions need beyond the basic file set (api.io): a private atomic write that also creates
// the folders. Synchronous on purpose, like ops-fs.ts: it runs inside an executor worker (exempt area of the sync ratchet).
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

let seq = 0

export const extOps = {
  /** mkdir -p of the parent, then temp + rename with owner-only mode (a no-op on Windows: the folder's DACL rules). */
  writeTextAtomicDir: (path: string, text: string): null => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${seq++}.tmp`
    try {
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, path)
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
      throw e
    }
    return null
  },
}
