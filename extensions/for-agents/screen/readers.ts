// The screen readers of the for-agents extension: one terminal without a screen per slot that is read, fed only with what is
// new (`since`), at the PTY's real size. If cols or rows changed, or the read came back with `reset`, the terminal is rebuilt
// from the whole ring. At most MAX_READERS terminals live (the least recently used leaves), and there is no timer of its own:
// the cleaning happens on access. The package is loaded by the first read (loader.ts), not before.
import type { ScreenRead } from '../../../src/daemon/protocol.ts'
import { loadXterm, type XtermLoader } from './loader.ts'
import { readText, type ScreenText, type XtermTerminal } from './text.ts'

/** The most terminals alive at once. */
export const MAX_READERS = 8
/** The history a terminal keeps, in rows (the daemon's ring is about 1M characters). */
export const SCROLLBACK_ROWS = 5000

/** Reads a slot's raw screen from `since` (the whole ring when undefined): `slots.readScreen(slotId, since)` of the door. */
export type FetchScreen = (since?: number) => ScreenRead | Promise<ScreenRead>

interface Reader {
  term: XtermTerminal
  cols: number
  rows: number
  /** The offset fed up to. */
  end: number
}

export interface ScreenReaders {
  /** The screen of the slot as text: asks `fetch` for what is new since the last read (or for the whole ring), feeds it, and reads the buffer. */
  read(slotId: string, fetch: FetchScreen): Promise<ScreenText>
  /** The offset the next read of this slot starts at (undefined: no terminal yet). */
  since(slotId: string): number | undefined
  /** Drops the terminal of a slot (it was forgotten or the extension lost interest). */
  drop(slotId: string): void
  /** Drops them all. */
  dispose(): void
  /** How many terminals are alive. */
  readonly size: number
}

export interface ScreenReadersOptions {
  load?: XtermLoader
  max?: number
  scrollback?: number
  /** Glue the wrapped rows (isWrapped) into one line. Default true (the contract); false gives one line per screen row. */
  joinWrapped?: boolean
}

export function createScreenReaders(options: ScreenReadersOptions = {}): ScreenReaders {
  const load = options.load ?? loadXterm
  const max = options.max ?? MAX_READERS
  const scrollback = options.scrollback ?? SCROLLBACK_ROWS
  const joinWrapped = options.joinWrapped ?? true
  const readers = new Map<string, Reader>() // insertion order = least recently used first
  /** The slots with work waiting or running: their reads run one after the other, and their terminals are not evicted. */
  const queues = new Map<string, { tail: Promise<unknown>; pending: number }>()

  const enqueue = <T>(slotId: string, job: () => Promise<T>): Promise<T> => {
    const q = queues.get(slotId) ?? { tail: Promise.resolve(), pending: 0 }
    queues.set(slotId, q)
    q.pending++
    const result = q.tail.then(job)
    q.tail = result.catch(() => undefined)
    return result.finally(() => { if (--q.pending === 0) queues.delete(slotId) })
  }
  const discard = (slotId: string): void => {
    const r = readers.get(slotId)
    if (!r) return
    readers.delete(slotId)
    r.term.dispose()
  }
  const evict = (): void => {
    for (const id of [...readers.keys()]) {
      if (readers.size <= max) return
      if (!queues.has(id)) discard(id)
    }
  }
  const feed = (term: XtermTerminal, data: string): Promise<void> => new Promise(res => { term.write(data, res) })

  async function run(slotId: string, fetch: FetchScreen): Promise<ScreenText> {
    const { Terminal } = await load()
    let r = readers.get(slotId)
    let read = await fetch(r?.end)
    if (r && !read.reset && (read.cols !== r.cols || read.rows !== r.rows)) read = await fetch(undefined) // size changed: the new part alone is not the screen
    if (!r || read.reset || read.cols !== r.cols || read.rows !== r.rows) {
      discard(slotId)
      r = { term: new Terminal({ cols: read.cols, rows: read.rows, scrollback, allowProposedApi: true }), cols: read.cols, rows: read.rows, end: read.end }
    }
    await feed(r.term, read.data)
    r.end = read.end
    readers.delete(slotId) // back in as the most recently used
    readers.set(slotId, r)
    evict()
    return readText(r.term, r.end, joinWrapped)
  }

  return {
    read: (slotId, fetch) => enqueue(slotId, () => run(slotId, fetch)),
    since: slotId => readers.get(slotId)?.end,
    drop(slotId) {
      if (queues.has(slotId)) void enqueue(slotId, async () => discard(slotId))
      else discard(slotId)
    },
    dispose() { for (const id of [...readers.keys(), ...queues.keys()]) this.drop(id) },
    get size() { return readers.size },
  }
}
