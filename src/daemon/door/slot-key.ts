// The slot's per-launch key (TETHER_SLOT_KEY): proves a CLI call inherited the environment of that slot's launch. The key
// itself only ever lives in the launch environment of the agent process; the daemon keeps the sha256 digest, in memory, and
// compares in constant time. It dies with the run (exit, forget, cancelled launch). It separates one agent from another;
// it is no fence against a hostile process of the same user (that one can already write to the pipe).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const digest = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest()

export class SlotKeys {
  private readonly bySlot = new Map<string, Buffer>()

  /** A new key (192 bits) for the slot's next run; replaces the previous one. The caller puts it in the env and keeps no copy. */
  issue(slotId: string): string {
    const key = randomBytes(24).toString('base64url')
    this.bySlot.set(slotId, digest(key))
    return key
  }

  /** True only for the key issued for this slot's current run. A missing or wrong key is false, never an error. */
  verify(slotId: string, key: string | undefined): boolean {
    const want = this.bySlot.get(slotId)
    if (!want || typeof key !== 'string' || key === '') return false
    return timingSafeEqual(want, digest(key))
  }

  /** Ends the slot's key. With `key`, only if it is still the current one (a cancelled launch must not revoke a newer run's key). */
  revoke(slotId: string, key?: string): void {
    if (key !== undefined) {
      const cur = this.bySlot.get(slotId)
      if (!cur || !timingSafeEqual(cur, digest(key))) return
    }
    this.bySlot.delete(slotId)
  }
}
