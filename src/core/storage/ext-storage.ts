import type { StorageRoots } from './areas.ts'
import { createEntityStore, serializeEntity, StorageError } from './entity-store.ts'
import type { EntityStore } from './entity-store.ts'

/** Same limits as chrome.storage.sync: per key, and per extension in total. */
export const SYNC_KEY_MAX_BYTES = 8 * 1024
export const SYNC_EXT_MAX_BYTES = 100 * 1024

export interface KeyValueArea {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): boolean
  keys(): string[]
}

function area(store: EntityStore, collection: string, quota: boolean): KeyValueArea {
  const remove = (key: string): boolean => store.delete(collection, key)
  return {
    get: <T>(key: string) => store.get<T>(collection, key),
    set(key, value) {
      if (value === undefined) { remove(key); return }
      if (quota) {
        // Each key is one file: the limit is on the serialized bytes the file will hold.
        const text = serializeEntity(value)
        const bytes = Buffer.byteLength(text, 'utf8')
        if (bytes > SYNC_KEY_MAX_BYTES) {
          throw new StorageError('quota-exceeded', `Key ${collection}/${key} is ${bytes} bytes, over the limit of ${SYNC_KEY_MAX_BYTES} bytes per key`)
        }
        // Total counts the new value in place of the old one for this key.
        let total = bytes
        for (const other of store.list(collection)) if (other !== key) total += store.size(collection, other)
        if (total > SYNC_EXT_MAX_BYTES) {
          throw new StorageError('quota-exceeded', `Extension storage ${collection} would be ${total} bytes, over the limit of ${SYNC_EXT_MAX_BYTES} bytes (key ${key})`)
        }
      }
      store.set(collection, key, value)
    },
    delete: remove,
    keys: () => store.list(collection),
  }
}

/** What an extension receives: `sync` (quota'd, travels between machines) and `local` (no quota), keys stored under `ext/<extId>`. */
export function createExtStorage(roots: StorageRoots, extId: string): { sync: KeyValueArea; local: KeyValueArea } {
  const collection = `ext/${extId}`
  return {
    sync: area(createEntityStore(roots.sync), collection, true),
    local: area(createEntityStore(roots.local), collection, false),
  }
}
