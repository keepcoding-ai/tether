import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type StorageErrorCode = 'invalid-name' | 'quota-exceeded'

export class StorageError extends Error {
  code: StorageErrorCode
  constructor(code: StorageErrorCode, message: string) {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

export interface EntityStoreOptions {
  /** Largest serialized entity, in UTF-8 bytes; `set` beyond it throws `quota-exceeded` and writes nothing. */
  maxBytes?: number
}

export interface EntityStore {
  get<T>(collection: string, id: string): T | undefined
  set(collection: string, id: string, value: unknown): void
  delete(collection: string, id: string): boolean
  list(collection: string): string[]
  /** Size in bytes of the stored entity file, 0 when absent. */
  size(collection: string, id: string): number
}

// A name segment: lower-case start, then lower-case letters, digits and . _ @ : -  (`..` is refused separately).
const NAME_RE = /^[a-z0-9][a-z0-9._@:-]*$/

function checkSegment(kind: string, name: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    throw new StorageError('invalid-name', `Invalid ${kind} name: ${JSON.stringify(name)}`)
  }
}

// ':' is not allowed in Windows file names, so it is stored as '%3A' (no valid name contains '%', so this is unambiguous).
const encodeName = (name: string): string => name.replaceAll(':', '%3A')
const decodeName = (name: string): string => name.replaceAll('%3A', ':')

/** A collection is one or more '/'-separated segments, each validated like an id; returns the folder path. */
function collectionDir(root: string, collection: string): string {
  if (typeof collection !== 'string') throw new StorageError('invalid-name', `Invalid collection name: ${JSON.stringify(collection)}`)
  const segments = collection.split('/')
  for (const segment of segments) checkSegment('collection', segment)
  return join(root, ...segments.map(encodeName))
}

function filePath(root: string, collection: string, id: string): string {
  const dir = collectionDir(root, collection)
  checkSegment('id', id)
  return join(dir, `${encodeName(id)}.json`)
}

// Object keys are sorted at every level so the same data always yields the same bytes (clean git diffs); arrays keep their order.
function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = source[key]
  return sorted
}

/** The exact text stored for a value: 2-space JSON, sorted keys, trailing newline. */
export function serializeEntity(value: unknown): string {
  const text = JSON.stringify(value, sortKeys, 2)
  if (text === undefined) throw new TypeError('Cannot store a value that has no JSON form (undefined, function, symbol)')
  return `${text}\n`
}

/** One JSON file per entity at `<root>/<collection>/<id>.json`, written atomically (temp file + rename), synchronous. */
export function createEntityStore(root: string, opts: EntityStoreOptions = {}): EntityStore {
  const { maxBytes } = opts
  return {
    get<T>(collection: string, id: string): T | undefined {
      const file = filePath(root, collection, id)
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T
      } catch {
        return undefined // missing or corrupt
      }
    },

    set(collection: string, id: string, value: unknown): void {
      const file = filePath(root, collection, id)
      const text = serializeEntity(value)
      const bytes = Buffer.byteLength(text, 'utf8')
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new StorageError('quota-exceeded', `Entity ${collection}/${id} is ${bytes} bytes, over the limit of ${maxBytes} bytes`)
      }
      try {
        if (readFileSync(file, 'utf8') === text) return // identical: leave the file (and its mtime) alone
      } catch { /* absent: write it */ }
      mkdirSync(collectionDir(root, collection), { recursive: true })
      // Same folder as the target so the rename stays on one volume and replaces the file in one step.
      const tmp = `${file}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, text)
        renameSync(tmp, file)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
    },

    delete(collection: string, id: string): boolean {
      const file = filePath(root, collection, id)
      if (!existsSync(file)) return false
      rmSync(file, { force: true })
      return true
    },

    list(collection: string): string[] {
      const dir = collectionDir(root, collection)
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return []
      }
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => decodeName(e.name.slice(0, -'.json'.length)))
        .sort()
    },

    size(collection: string, id: string): number {
      try {
        return statSync(filePath(root, collection, id)).size
      } catch {
        return 0
      }
    },
  }
}
