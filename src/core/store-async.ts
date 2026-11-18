// Slot state, asynchronous readers: what tetherd reads off the loop (the boot scan and the incremental events reads). Only
// node:fs/promises here; the synchronous half (CLI, tests) is store-sync.ts.
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import type { SlotMeta } from './event.ts'
import { mapLimit } from './limit.ts'
import { slotEventsPath, slotMetaPath, slotsDir } from './paths.ts'
import { assertSlotId, byAge, metaIds, parseSlotMeta, splitRead, type EventsRead, type SlotsScan } from './store-model.ts'

/** `scanSlots` off the event loop: the directory listing and the metas are read with a few reads in flight at once. */
export async function scanSlotsAsync(home: string, concurrency = 16): Promise<SlotsScan> {
  let names: string[]
  try { names = await readdir(slotsDir(home)) } catch { return { metas: [], names: [] } }
  const read = await mapLimit(metaIds(names), concurrency, async (id): Promise<SlotMeta | undefined> => {
    try { return parseSlotMeta(await readFile(slotMetaPath(home, id), 'utf8'), id) } catch { return undefined }
  })
  const metas = read.filter((m): m is SlotMeta => m !== undefined)
  metas.sort(byAge)
  return { metas, names }
}

/**
 * The events file from byte `from` on, asynchronously. A file shorter than `from` was truncated or rewritten: it is read
 * whole (`start` 0 tells the caller to forget what it kept). `from` must sit on a line start (a previous `resume`).
 */
export async function readEventsFrom(home: string, slotId: string, from: number): Promise<EventsRead> {
  assertSlotId(slotId)
  let fh: FileHandle
  try {
    fh = await open(slotEventsPath(home, slotId), 'r')
  } catch {
    return splitRead(Buffer.alloc(0), 0)
  }
  try {
    const size = (await fh.stat()).size
    const start = size < from ? 0 : from
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return splitRead(got === buf.length ? buf : buf.subarray(0, got), start)
  } finally {
    await fh.close()
  }
}
