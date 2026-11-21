// The slot's per-launch key (TETHER_SLOT_KEY): proves a CLI call inherited the environment of that slot's launch. The key
// itself only ever lives in the launch environment of the agent process; the daemon keeps the sha256 digest (in memory and in
// <home>/door/slot-keys.json, so an adopted pane still proves itself after a tetherd restart) and compares in constant time.
// It dies with the run (exit, forget, cancelled launch). It separates one agent from another;
// it is no fence against a hostile process of the same user (that one can already write to the pipe).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function slotKeysPath(home: string): string {
  return join(home, 'door', 'slot-keys.json')
}

const digest = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest()

export class SlotKeys {
  private readonly bySlot = new Map<string, Buffer>()
  private path: string | undefined
  private log: (msg: string) => void = () => {}
  private writing: Promise<void> = Promise.resolve()

  /** The home is known: the digests of the last run are read from disk (a key issued meanwhile wins over the disk's). Once. */
  attach(home: string, log?: (msg: string) => void): void {
    this.path = slotKeysPath(home)
    if (log) this.log = log
    const path = this.path
    this.ready = readFile(path, 'utf8').then((text) => {
      const raw = JSON.parse(text) as unknown
      if (typeof raw !== 'object' || raw === null) return
      for (const [slotId, hex] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex) || this.bySlot.has(slotId)) continue
        this.bySlot.set(slotId, Buffer.from(hex, 'hex'))
      }
    }).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`door: slot-keys.json ilegível, ignorado: ${(e as Error).message}`)
    })
  }

  /** Resolves once the digests on disk were read. */
  ready: Promise<void> = Promise.resolve()

  /** Resolves when every change handed to `persist` is on disk. */
  flush(): Promise<void> { return this.writing }

  /** Digests only, whole file, temp + rename, one write at a time, after the read (the last state wins). */
  private persist(): void {
    const path = this.path
    if (!path) return
    this.writing = this.writing.then(() => this.ready).then(async () => {
      const text = JSON.stringify(Object.fromEntries([...this.bySlot].map(([id, d]) => [id, d.toString('hex')])))
      const tmp = `${path}.${process.pid}.tmp`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, `${text}\n`)
        await rename(tmp, path)
      } catch (e) {
        this.log(`door: não gravei slot-keys.json: ${(e as Error).message}`)
      }
    })
  }

  /** A new key (192 bits) for the slot's next run; replaces the previous one. The caller puts it in the env and keeps no copy. */
  issue(slotId: string): string {
    const key = randomBytes(24).toString('base64url')
    this.bySlot.set(slotId, digest(key))
    this.persist()
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
    if (this.bySlot.delete(slotId)) this.persist()
  }
}
