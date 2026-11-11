// The bridge's upload authorizations of an agent (a folder allowed for a site), kept WITH THE AGENT'S PANE instead of in the
// memory of its MCP server: `<home>/web-bridge/grants/<slotId>.json`, one file per slot, in a folder only its owner reaches
// (private-dir.ts), written in one move. The server inside the daemon (the vendored bundle's upload policy) reads the list
// when it is made and hands the whole list back at every change, so a new server of the same slot (the daemon restarted, the
// agent's session was resumed, the client reconnected) asks the person nothing she already answered. The file goes when the
// slot is forgotten (its pane closed for good) or the last authorization is revoked. What comes back from the disk is not
// trusted as it is: the policy puts every pair through the rules of a new one (inside the allowed folders, not too broad, an
// exact origin) and drops the rest.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLOT_ID_RE } from '../../src/core/store.ts'
import { ensurePrivateDir } from '../browser/private-dir.ts'

export const grantsDirOf = (home: string): string => join(home, 'web-bridge', 'grants')
export const grantsFileOf = (home: string, slotId: string): string => join(grantsDirOf(home), `${slotId}.json`)

/** How the consent question says until when an authorization holds. */
export const GRANT_LIFETIME = 'this panel of the tether is closed (it is kept across restarts of the agent and of the tether)'

/** The store the bundle's upload policy takes (packages/browser host/policy.ts UploadGrantStore). */
export interface GrantStore {
  load(): unknown
  save(grants: unknown[]): void
  lifetime: string
}

export function grantStoreOf(home: string, slotId: string, log: (msg: string) => void = () => {}): GrantStore {
  if (!SLOT_ID_RE.test(slotId)) throw new Error('slot id inválido')
  const file = grantsFileOf(home, slotId)
  return {
    lifetime: GRANT_LIFETIME,
    load() {
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; grants?: unknown }
        return doc.v === 1 && Array.isArray(doc.grants) ? doc.grants : []
      } catch { return [] } // no file: nothing was authorized
    },
    save(grants) {
      if (grants.length === 0) { rmSync(file, { force: true }); return }
      const dir = grantsDirOf(home)
      mkdirSync(dir, { recursive: true })
      // Owner-only before an authorization lands in it; a folder that cannot be made so holds none (the policy logs it and
      // keeps the pair in memory for this server).
      ensurePrivateDir(dir)
      const tmp = `${file}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, `${JSON.stringify({ v: 1, grants })}\n`, { mode: 0o600 })
        renameSync(tmp, file)
      } finally { rmSync(tmp, { force: true }) }
      log(`autorizações de upload do slot ${slotId} guardadas (${grants.length})`)
    },
  }
}

/** The slot is gone for good: its authorizations go with it. Never throws. */
export function dropGrants(home: string, slotId: string): void {
  if (!SLOT_ID_RE.test(slotId)) return
  try { rmSync(grantsFileOf(home, slotId), { force: true }) } catch { /* best effort */ }
}
