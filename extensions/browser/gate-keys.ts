// The agents' keys as the gatekeeper reads them (design §3.2): `<home>/browser/keys/<slotId>.key`, written by the daemon side
// when an agent starts and deleted when it exits. The folder is read again when the copy in memory is older than `ttlMs`
// (one read per second at most, whatever the traffic), so a deleted key stops working within that time; the gate also
// sweeps its live connections on the same clock and closes the ones whose key is gone. A key's text never goes to a log.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keysEqual, ownerOfKey, parseKeyFile, slotOfKeyFile } from './gate-rules.ts'

export class KeyStore {
  private readonly dir: string
  private readonly ttlMs: number
  private readonly now: () => number
  private keys = new Map<string, string>()
  private readAt = -Infinity

  constructor(dir: string, ttlMs = 1000, now: () => number = Date.now) {
    this.dir = dir
    this.ttlMs = ttlMs
    this.now = now
  }

  private fresh(): ReadonlyMap<string, string> {
    if (this.now() - this.readAt < this.ttlMs) return this.keys
    const next = new Map<string, string>()
    let names: string[] = []
    try { names = readdirSync(this.dir) } catch { /* no folder: no keys */ }
    for (const name of names) {
      const slotId = slotOfKeyFile(name)
      if (!slotId) continue
      try {
        const key = parseKeyFile(readFileSync(join(this.dir, name), 'utf8'))
        if (key) next.set(slotId, key)
      } catch { /* deleted between the listing and the read */ }
    }
    this.keys = next
    this.readAt = this.now()
    return next
  }

  /** The slot id this key belongs to, or undefined (unknown or deleted key). */
  owner(key: string): string | undefined {
    return ownerOfKey(key, this.fresh())
  }

  /** Whether `slotId` still has exactly this key (false once the file is deleted or replaced by a new launch). */
  valid(slotId: string, key: string): boolean {
    const k = this.fresh().get(slotId)
    return k !== undefined && keysEqual(k, key)
  }
}
